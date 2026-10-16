/**
 * 智能分析（规则引擎）离线验证
 *
 * 这一版的风险点和别处不一样：它**不产生任何副作用**，纯读账单、只返回结论，
 * 所以不存在"删错数据"这类事故。它真正会出事的地方只有一个 ——
 *
 *   **结论里的数字和账单对不上。**
 *
 * 分析页是全项目唯一一处「用文字讲数字」的地方。文案是手写的，数字是算出来的，
 * 两者只要有一个不一致，用户就会照着一条错的结论调整消费 ——
 * 而且**不会有任何报错**，因为文案不是从数据里生成的。
 * 所以这里的核心手段是 audit()：把每条结论里出现的每一个金额，
 * 拿去和输入摘要里的真实数值逐个比对，对不上就报错。
 *
 * 另外守三件事：
 *   1. 规则**不满足条件就必须返回 null** —— 不能为了凑满几条而放宽阈值
 *   2. 没数据时返回空数组，**绝不返回套话**
 *   3. 跨月时「本月」与「30 天窗口」两个口径不能混
 *
 * 运行：node tests/insight-test.js
 */
const Module = require('module')
const path = require('path')
const fs = require('fs')

const STATS_FN = path.join(__dirname, '..', 'cloudfunctions/getStatistics/index.js')
const INSIGHT_LIB = path.join(__dirname, '..', 'cloudfunctions/getStatistics/lib/insight.js')

const BJ = 8 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

let fail = 0

/**
 * ⚠️ 下面所有"某条规则触发了"的断言都写成 `x != null` 而不是 `x !== null`：
 *    Array.find 找不到时返回的是 **undefined**，而 `undefined !== null` 为真 ——
 *    写成 `!== null` 时，"根本没触发"会被判成"触发了"，测试假通过，
 *    后面的 if (x) 分支一条都不执行，看着全绿其实什么都没验。
 *    （踩过：跨月预算那条断言一直是假通过。）
 */
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

function round2(v) {
  return Math.round((v || 0) * 100) / 100
}

// ==================== 时间控制 ====================

const REAL_NOW = Date.now

function freeze(y, m, d, hh, mm) {
  const ts = Date.UTC(y, m - 1, d, hh || 10, mm || 0) - BJ
  Date.now = () => ts
  return ts
}

function bjTs(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh || 12, mm || 0) - BJ
}

// ==================== 内存假库 ====================

const DB = { bills: [], users: [] }
let seq = 0
let billSeq = 0
const OPENID = 'me'

function cond(op, value) {
  const c = { __cond: true, op: op, value: value }
  c.and = function (other) { return { __cond: true, op: 'and', parts: [c, other] } }
  return c
}

function matchField(actual, c) {
  if (c === null || c === undefined) return true
  if (typeof c === 'object' && c.__cond) {
    if (c.op === 'gte') return actual >= c.value
    if (c.op === 'lte') return actual <= c.value
    if (c.op === 'in') return c.value.indexOf(actual) !== -1
    if (c.op === 'and') return matchField(actual, c.parts[0]) && matchField(actual, c.parts[1])
    return false
  }
  return actual === c
}

function matchDoc(doc, condition) {
  return Object.keys(condition).every(k => matchField(doc[k], condition[k]))
}

function makeCollection(name) {
  const state = { cond: {}, skip: 0, limit: 1000 }
  const rows = function () { return DB[name] = DB[name] || [] }

  const api = {
    where: function (c) { state.cond = c || {}; return api },
    field: function () { return api },
    orderBy: function () { return api },
    skip: function (n) { state.skip = n; return api },
    limit: function (n) { state.limit = n; return api },
    get: async function () {
      const hit = rows().filter(d => matchDoc(d, state.cond))
      return { data: hit.slice(state.skip, state.skip + state.limit) }
    },
    count: async function () {
      return { total: rows().filter(d => matchDoc(d, state.cond)).length }
    },
    add: async function (arg) {
      seq++
      const id = 'doc' + seq
      rows().push(Object.assign({ _id: id }, arg.data))
      return { _id: id }
    },
    update: async function (arg) {
      let updated = 0
      rows().forEach(d => {
        if (!matchDoc(d, state.cond)) return
        Object.keys(arg.data).forEach(k => {
          // _.remove() 在真实 SDK 里是"删掉这个字段"，假库要跟着模拟
          if (arg.data[k] && arg.data[k].__remove) delete d[k]
          else d[k] = arg.data[k]
        })
        updated++
      })
      return { stats: { updated: updated } }
    }
  }
  return api
}

const command = {
  gte: v => cond('gte', v),
  lte: v => cond('lte', v),
  in: v => cond('in', v),
  remove: () => ({ __remove: true })
}

const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'dyn',
  init: function () {},
  database: function () { return { collection: makeCollection, command: command } },
  getWXContext: function () { return { OPENID: OPENID } }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return cloudStub
  return origLoad.apply(this, arguments)
}

const statsFn = require(STATS_FN)
// 规则引擎是纯函数，直接 require 就能单独验证每条规则
const ins = require(INSIGHT_LIB)
const rules = ins._rules

function runInsight() {
  return statsFn.main({ action: 'insight' }, {})
}

// ==================== 造数 ====================

function addBill(ts, type, amount, categoryId, category, title) {
  billSeq++
  DB.bills.push({
    _id: 'b' + billSeq,
    _openid: 'me',
    createTime: ts,
    type: type,
    amount: amount,
    categoryId: categoryId,
    category: category,
    title: title || '某商户',
    orderNo: 'NO' + billSeq
  })
}

function reset() {
  DB.bills = []
  // v0.8.0 起 insight 有会员门控：测试里的 "me" 默认是会员，
  // 门控本身的行为由 tests/vip-test.js 验证，这里不重复
  DB.users = [{ _id: 'u0', _openid: 'me', uid: 'u0', vip: { since: 1 }, budget: null }]
  seq = 0
  billSeq = 0
}

/**
 * 造一份"最普通"的摘要：
 * 总额 1000、30 天、笔数 20、无上期差异、无预算 —— 大多数规则都不该触发。
 */
function baseSummary(overrides) {
  const base = {
    days: 30,
    compareDays: 30,
    total: 1000,
    count: 20,
    categories: [
      { id: 'food', name: '餐饮', amount: 400, count: 12 },
      { id: 'transport', name: '交通', amount: 300, count: 5 },
      { id: 'shopping', name: '购物', amount: 300, count: 3 }
    ],
    merchants: [
      { title: '美团外卖', amount: 300, count: 10 },
      { title: '某商户', amount: 200, count: 5 }
    ],
    smallFreq: { count: 2, amount: 30, limit: 20 },
    prev: { total: 1000, count: 20, days: 30 },
    weekend: { days: 8, total: 240 },
    weekday: { days: 22, total: 760 },
    night: { amount: 0, count: 0 },
    large: { count: 0, amount: 0, threshold: 500, topCategory: '—' },
    daysWithoutSpend: 1,
    lastExpenseDate: '10月15日',
    budget: null
  }
  return overrides ? Object.assign(base, overrides) : base
}

function mkBudget(spent, amount) {
  return {
    amount: amount,
    spent: spent,
    remaining: round2(amount - spent),
    over: spent > amount ? round2(spent - amount) : 0,
    usedPercent: Math.round(spent / amount * 100),
    barPercent: 100,
    level: 'safe',
    daysTotal: 31,
    daysPassed: 16,
    daysLeft: 16,
    dailyAvg: round2(spent / 16),
    dailyLeft: null,
    forecast: null,
    forecastOver: 0,
    updateTime: 0
  }
}

/**
 * 数字审计（本套件的核心）
 *
 * 把结论里出现的**每一个数字**拿去和摘要里的真实数值比对：金额、笔数、天数都算。
 * 差值超过 1 分就算金额不一致，笔数与天数则要求精确匹配。
 *
 * ⚠️ 曾经只审金额，结果「共 99 笔」这种写死的笔数溜过去了 ——
 *    注入验证时被当场抓到，而从界面上一眼看不出 60 笔变没变成 99 笔。
 */
function audit(list, s, tag) {
  // 合法金额。
  // ⚠️ 不只是原始值 —— **派生值同样是合法的**（日均、差额、每笔均值），
  //    它们都能从摘要里的数算出来。漏掉派生值会造成大量误报，
  //    而误报多了这条审计就会被忽略，那它就白写了。
  const legalMoney = []
  const put = function (v) { if (typeof v === 'number' && isFinite(v)) legalMoney.push(v) }

  put(s.total)
  if (s.prev) put(s.prev.total)
  if (s.total > 0 && s.prev && s.prev.total > 0) {
    put(s.total - s.prev.total)
    put(Math.abs(s.total - s.prev.total))
  }
  if (s.days > 0) put(round2(s.total / s.days))
  if (s.count > 0) put(round2(s.total / s.count))

  // 日均涨跌（detectTrend 用日均比，需要把本期/上期日均及差额加入合法集合）
  if (s.days > 0 && s.prev && s.prev.days > 0) {
    const curAvg = round2(s.total / s.days)
    const prevAvg = round2(s.prev.total / s.prev.days)
    put(curAvg)
    put(prevAvg)
    put(Math.abs(curAvg - prevAvg))
  }

  const cats = s.categories || []
  for (let i = 0; i < cats.length; i++) put(cats[i].amount)
  const ms = s.merchants || []
  for (let i = 0; i < ms.length; i++) put(ms[i].amount)

  if (s.smallFreq) { put(s.smallFreq.amount); put(s.smallFreq.limit) }

  // 深夜消费
  if (s.night) put(s.night.amount)

  // 单笔大额
  if (s.large) { put(s.large.amount); put(s.large.threshold) }

  let weAvg = null
  let wdAvg = null
  if (s.weekend && s.weekend.days) { weAvg = round2(s.weekend.total / s.weekend.days); put(weAvg) }
  if (s.weekday && s.weekday.days) { wdAvg = round2(s.weekday.total / s.weekday.days); put(wdAvg) }
  if (weAvg != null && wdAvg != null) put(round2(weAvg - wdAvg))

  if (s.budget) {
    put(s.budget.amount)
    put(s.budget.spent)
    put(Math.abs(s.budget.remaining || 0))
    put(Math.abs(s.budget.over || 0))
    put(s.budget.dailyAvg)
    if (s.budget.forecast != null) {
      put(s.budget.forecast)
      put(Math.abs(s.budget.forecast - s.budget.amount))
    }
  }

  // 合法笔数（必须是整数集合，精确匹配）
  const legalCount = new Set()
  const putC = function (v) { if (Number.isInteger(v)) legalCount.add(v) }
  putC(s.count)
  putC(s.smallFreq && s.smallFreq.count)
  if (s.night) putC(s.night.count)
  if (s.large) putC(s.large.count)
  for (let i = 0; i < cats.length; i++) putC(cats[i].count)
  for (let i = 0; i < ms.length; i++) putC(ms[i].count)

  // 合法天数
  const legalDays = new Set()
  const putD = function (v) { if (Number.isInteger(v)) legalDays.add(v) }
  putD(s.days)
  putD(s.compareDays)
  putD(s.daysWithoutSpend)
  if (s.weekend) putD(s.weekend.days)
  if (s.weekday) putD(s.weekday.days)
  if (s.budget) { putD(s.budget.daysLeft); putD(s.budget.daysTotal); putD(s.budget.daysPassed) }
  // 月光预警里的「本月 X 号」—— 号数是天数的一种，来自预算进度推算
  if (s.budget && s.budget.amount > 0 && s.budget.daysPassed > 0) {
    const spentOn = Math.ceil(s.budget.amount / (s.budget.spent / s.budget.daysPassed))
    if (Number.isInteger(spentOn)) legalDays.add(spentOn)
  }

  let checked = 0
  const bad = []

  list.forEach(function (item) {
    const texts = [item.title, item.detail]
    const ev = item.evidence || []
    ev.forEach(e => texts.push(e.value))

    texts.forEach(function (txt) {
      if (typeof txt !== 'string') return

      // 金额
      const reM = /¥([\d.]+)(万|亿)?/g
      let m
      while ((m = reM.exec(txt)) != null) {
        let v = parseFloat(m[1])
        if (m[2] === '万') v *= 10000
        if (m[2] === '亿') v *= 100000000
        checked++
        let found = false
        for (let i = 0; i < legalMoney.length; i++) {
          if (Math.abs(legalMoney[i] - v) <= 0.01) { found = true; break }
        }
        if (!found) bad.push(item.id + ' 的「' + txt + '」里的金额 ¥' + v + ' 在摘要里找不到')
      }

      // 笔数 / 天数
      const reC = /(\d+)\s*笔/g
      while ((m = reC.exec(txt)) != null) {
        checked++
        if (!legalCount.has(parseInt(m[1], 10))) {
          bad.push(item.id + ' 的「' + txt + '」里的笔数 ' + m[1] + ' 在摘要里找不到')
        }
      }

      const reD = /(\d+)\s*天/g
      while ((m = reD.exec(txt)) != null) {
        checked++
        if (!legalDays.has(parseInt(m[1], 10))) {
          bad.push(item.id + ' 的「' + txt + '」里的天数 ' + m[1] + ' 在摘要里找不到')
        }
      }
    })
  })

  t(bad.length === 0,
    tag + '：' + checked + ' 个数字（金额/笔数/天数）全部能在摘要里对上'
    + (bad.length ? ' —— ' + bad.join('；') : ''))
}

// ================================================================

async function main() {
  // ================================================================
  console.log('\n=== 1) 金额口径与 utils/format.wxs 逐值对账 ===')
  // ================================================================
  // ⚠️ 同一个 App 里两处金额写法不同，用户会以为其中一个算错了。
  //    缩写的分界（10 万）必须一模一样。

  const wxsSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'format.wxs'), 'utf8')
  const wxsModule = { exports: {} }
  const buildWxs = new Function('getDate', 'module', wxsSrc)
  buildWxs(function (ts) { return new Date(ts === undefined ? Date.now() : ts) }, wxsModule)
  const wxsAmount = wxsModule.exports.amount

  t(ins.money(8.8) === '¥8.80', '8.8 → ' + ins.money(8.8) + '（不能显示成 ¥9）')
  t(ins.money(0) === '¥0.00', '0 → ' + ins.money(0))
  t(ins.money(14436.5) === '¥14436.50', '14436.5 → ' + ins.money(14436.5) + '（未到 10 万，不缩写）')
  t(ins.money(100000) === '¥10.00万', '100000 → ' + ins.money(100000))

  const SAME = [0, 0.5, 8.8, 35.5, 144.3, 1234.56, 14436.5, 99999.99, 100000, 123456, 123456789, -8.8, 1234, 999]
  let sameCount = 0
  SAME.forEach(function (v) {
    const a = ins.money(v).slice(1)
    const b = wxsAmount(v)
    if (a === b) sameCount++
    else console.log('    不一致：' + v + ' → insight "' + a + '" / format.wxs "' + b + '"')
  })
  t(sameCount === SAME.length, sameCount + '/' + SAME.length + ' 个取值与 format.wxs 完全一致')

  t(ins.money(NaN) === '¥0.00', 'NaN → ' + ins.money(NaN))
  t(ins.money(undefined) === '¥0.00', 'undefined → ' + ins.money(undefined))
  t(ins.money(Infinity) === '¥0.00', 'Infinity → ' + ins.money(Infinity) + '（不能输出 Infinity亿）')

  // ================================================================
  console.log('\n=== 2) 没数据时返回空数组，不返回套话 ===')
  // ================================================================
  t(ins.buildInsights(null).length === 0, '摘要为 null → 空数组')
  t(ins.buildInsights(baseSummary({ total: 0 })).length === 0, '总额为 0 → 空数组（没有数据就没有结论）')

  // ================================================================
  console.log('\n=== 3) 基准结论：日均必须带分母且可反算 ===')
  // ================================================================
  const s3 = baseSummary({ total: 1234.56, count: 42, days: 30 })
  const b3 = rules.detectBaseline(s3)
  const avg3 = round2(1234.56 / 30)
  t(b3 != null, '有支出时给出基准结论')
  if (b3) {
    t(b3.evidence.some(e => e.value === ins.money(avg3)),
      '日均 ' + ins.money(avg3) + ' = ' + ins.money(1234.56) + ' ÷ 30')
    t(b3.evidence.some(e => e.value === '30 天'), '把分母（已过天数）一起给出来，用户能自己核对')
  }
  t(Math.abs(avg3 * 30 - 1234.56) <= 0.6,
    '反向核对：日均 × 天数 ≈ 总额（' + (avg3 * 30).toFixed(2) + ' ≈ 1234.56）')

  // ================================================================
  console.log('\n=== 4) 类目集中度：阈值边界与"只有一个类目" ===')
  // ================================================================
  t(rules.detectCategory(baseSummary({
    categories: [{ id: 'a', name: '餐饮', amount: 349, count: 10 }, { id: 'b', name: '交通', amount: 651, count: 10 }]
  })) == null, '最大类目占 34.9% → 不触发（阈值 35%）')

  const catHit = rules.detectCategory(baseSummary({
    categories: [{ id: 'a', name: '餐饮', amount: 350, count: 10 }, { id: 'b', name: '交通', amount: 650, count: 10 }]
  }))
  t(catHit != null, '最大类目占 35% → 触发')
  if (catHit) t(catHit.evidence.some(e => e.value === '35%'), '占比显示 35%（实际 ' + catHit.evidence[1].value + '）')

  t(rules.detectCategory(baseSummary({
    categories: [{ id: 'a', name: '餐饮', amount: 1000, count: 20 }]
  })) == null, '只有一个类目 → 不触发（"是第二名的几倍"没有意义）')

  // ================================================================
  console.log('\n=== 5) 日均涨跌：比例与绝对额都要够大 ===')
  // ================================================================
  // ⚠️ 用「日均」而不是「总额」比 —— 总额比较要求两个周期都是满的，
  //    短账龄时「前 30 天」有一半是空的，比总额没意义（见 detectTrend 注释）。
  t(rules.detectTrend(baseSummary({ total: 1290, prev: { total: 1000, count: 20, days: 30 } })) == null,
    '日均涨 29% → 不触发（阈值 30%）')
  t(rules.detectTrend(baseSummary({ total: 1300, prev: { total: 1000, count: 20, days: 30 } })) != null,
    '日均涨 30% 且差额 ¥10 → 触发')
  t(rules.detectTrend(baseSummary({ total: 1015, prev: { total: 1000, count: 20, days: 30 } })) == null,
    '日均涨 1.5% 但只多 ¥0.5/天 → 不触发（绝对差额太小，报出来是制造焦虑）')

  const down = rules.detectTrend(baseSummary({ total: 700, prev: { total: 1000, count: 20, days: 30 } }))
  t(down != null && down.level === 'tip', '日均跌 30% → 触发，但档位是 tip 不是 warn（少花钱不是问题）')
  t(rules.detectTrend(baseSummary({ prev: { total: 0, count: 0, days: 30 } })) == null,
    '上期没数据 → 不触发（没有比较对象）')
  t(rules.detectTrend(baseSummary({ prev: { total: 1000, count: 20, days: 0 } })) == null,
    '上期天数为 0（脏数据）→ 不触发')

  // ================================================================
  console.log('\n=== 5.5) 深夜消费：占比与笔数 ===')
  // ================================================================
  t(rules.detectNight(baseSummary({ night: { amount: 0, count: 0 } })) == null,
    '没有深夜支出 → 不触发')
  t(rules.detectNight(baseSummary({ night: { amount: 99, count: 2 } })) == null,
    '深夜占 9.9% → 不触发（阈值 10%）')
  const nightHit = rules.detectNight(baseSummary({ night: { amount: 100, count: 3 } }))
  t(nightHit != null, '深夜占 10% → 触发')
  if (nightHit) {
    t(nightHit.evidence.some(e => e.value === '10%'), '占比显示 10%')
    t(nightHit.evidence.some(e => e.value === '3 笔'), '笔数显示 3 笔')
  }

  // ================================================================
  console.log('\n=== 5.6) 单笔大额：月均 20% 或 ¥500 兜底 ===')
  // ================================================================
  t(rules.detectLarge(baseSummary({ large: { count: 0, amount: 0, threshold: 500, topCategory: '—' } })) == null,
    '没有大额支出 → 不触发')
  const largeHit = rules.detectLarge(baseSummary({
    total: 3000,
    large: { count: 2, amount: 1200, threshold: 500, topCategory: '购物' }
  }))
  t(largeHit != null, '有大额支出 → 触发')
  if (largeHit) {
    t(largeHit.evidence.some(e => e.value === '2 笔'), '大额笔数显示 2 笔')
    t(largeHit.evidence.some(e => e.value === '购物'), '主要类目显示"购物"')
  }

  // ================================================================
  console.log('\n=== 5.7) 月光预警：进度超前才报 ===')
  // ================================================================
  t(rules.detectMoonlight(baseSummary()) == null, '没设预算 → 不触发')

  // 本月已过 16 天（约 52%），已花 80% → 超前，触发
  const moonHit = rules.detectMoonlight(baseSummary({
    budget: Object.assign(mkBudget(2400, 3000), { level: 'safe' })
  }))
  t(moonHit != null, '时间进度 52%、支出 80% → 触发（进度超前）')
  if (moonHit) {
    t(moonHit.level === 'warn', '月光预警是 warn 级')
    // 预计花光日期：3000 / (2400/16) = 20 号
    t(moonHit.evidence.some(e => e.value === '本月 20 号'), '预计 20 号花光预算（实际 ' + JSON.stringify(moonHit.evidence) + '）')
  }

  // 已花 40%、时间 52% → 进度落后，不触发
  t(rules.detectMoonlight(baseSummary({
    budget: Object.assign(mkBudget(1200, 3000), { level: 'safe' })
  })) == null, '时间 52%、支出 40% → 不触发（进度没超前）')

  // ================================================================
  console.log('\n=== 6) 小额高频：笔数与占比都要够 ===')
  // ================================================================
  t(rules.detectSmallFreq(baseSummary({ smallFreq: { count: 7, amount: 100, limit: 20 } })) == null,
    '7 笔小额 → 不触发（阈值 8 笔）')
  t(rules.detectSmallFreq(baseSummary({ smallFreq: { count: 8, amount: 100, limit: 20 } })) != null,
    '8 笔且占 10% → 触发')
  t(rules.detectSmallFreq(baseSummary({ smallFreq: { count: 8, amount: 50, limit: 20 } })) == null,
    '8 笔但合计只占 5% → 不触发（占比不够，凑数）')

  // ================================================================
  console.log('\n=== 7) 商户集中度 ===')
  // ================================================================
  t(rules.detectMerchant(baseSummary({
    merchants: [{ title: 'A', amount: 249, count: 5 }, { title: 'B', amount: 751, count: 15 }]
  })) == null, '最大商户占 24.9% → 不触发')
  t(rules.detectMerchant(baseSummary({
    merchants: [{ title: 'A', amount: 250, count: 5 }, { title: 'B', amount: 750, count: 15 }]
  })) != null, '最大商户占 25% → 触发')

  // ================================================================
  console.log('\n=== 8) 周末效应：只看"周末明显更高" ===')
  // ================================================================
  // 判定要两个条件：日均高出 ≥50%，且差额 ≥¥20（两个都要，
  // 否则会出现"高了 500% 但只多花 3 元"这种没法行动的结论）
  t(rules.detectWeekend(baseSummary({ weekend: { days: 8, total: 480 }, weekday: { days: 22, total: 440 } })) != null,
    '周末日均 ¥60 vs 工作日 ¥20 → 触发')
  t(rules.detectWeekend(baseSummary({ weekend: { days: 8, total: 680 }, weekday: { days: 22, total: 1320 } })) == null,
    '周末日均高 41% → 不触发（比例不足 50%）')
  t(rules.detectWeekend(baseSummary({ weekend: { days: 8, total: 240 }, weekday: { days: 22, total: 440 } })) == null,
    '周末日均高 50% 但只差 ¥10 → 不触发（差额太小，报出来没意义）')
  t(rules.detectWeekend(baseSummary({ weekend: { days: 8, total: 100 }, weekday: { days: 22, total: 900 } })) == null,
    '周末比工作日低 → 不触发（没有行动含义，写出来只是凑数）')
  t(rules.detectWeekend(baseSummary({ weekend: { days: 0, total: 0 }, weekday: { days: 30, total: 1000 } })) == null,
    '窗口里没有周末（不可能，但脏数据要挡住）→ 不触发')

  // ================================================================
  console.log('\n=== 9) 连续无支出 ===')
  // ================================================================
  t(rules.detectNoSpend(baseSummary({ daysWithoutSpend: 3 })) == null, '连续 3 天 → 不触发')
  t(rules.detectNoSpend(baseSummary({ daysWithoutSpend: 4 })) != null, '连续 4 天 → 触发')

  // ================================================================
  console.log('\n=== 10) 预算结论：复用 composeBudget，且没设预算就不说 ===')
  // ================================================================
  t(rules.detectBudget(baseSummary()) == null, '没设预算 → 不出现预算结论（不啰嗦）')

  const bOver = rules.detectBudget(baseSummary({ budget: Object.assign(mkBudget(3500, 3000), { level: 'over' }) }))
  t(bOver != null && bOver.level === 'warn', '已超支 → warn')
  if (bOver) {
    t(bOver.evidence.some(e => e.value === ins.money(500)),
      '超出金额 ¥500.00 可核对（' + JSON.stringify(bOver.evidence) + '）')
  }

  const bNear = rules.detectBudget(baseSummary({ budget: Object.assign(mkBudget(2500, 3000), { level: 'near', usedPercent: 83 }) }))
  t(bNear != null && bNear.level === 'warn', '已用 83% → warn')

  const bForecast = rules.detectBudget(baseSummary({ budget: Object.assign(mkBudget(1600, 3000), { forecast: 3300 }) }))
  t(bForecast != null && bForecast.level === 'tip', '额度内但预测会超 → tip（与"已超"分开表达）')

  const bSafe = rules.detectBudget(baseSummary({ budget: Object.assign(mkBudget(1600, 3000), { forecast: 2000 }) }))
  t(bSafe == null, '额度内且预测不超 → 不出结论（这时候报"一切正常"是废话）')

  // ================================================================
  console.log('\n=== 11) 排序、上限与数字审计 ===')
  // ================================================================
  const rich = baseSummary({
    total: 2000,
    count: 60,
    categories: [
      { id: 'a', name: '餐饮', amount: 1000, count: 30 },
      { id: 'b', name: '交通', amount: 600, count: 15 },
      { id: 'c', name: '购物', amount: 400, count: 15 }
    ],
    merchants: [{ title: '美团外卖', amount: 900, count: 28 }, { title: '某商户', amount: 200, count: 5 }],
    smallFreq: { count: 12, amount: 180, limit: 20 },
    prev: { total: 1200, count: 40, days: 30 },
    weekend: { days: 8, total: 700 },
    weekday: { days: 22, total: 1300 },
    daysWithoutSpend: 5,
    lastExpenseDate: '10月11日',
    budget: Object.assign(mkBudget(2000, 2500), { level: 'near', usedPercent: 80 })
  })

  const all = ins.buildInsights(rich)
  t(all.length > 0, '数据丰富时给出 ' + all.length + ' 条结论')
  t(all.length <= ins.TH.MAX_ITEMS, '不超过上限 ' + ins.TH.MAX_ITEMS + ' 条（实际 ' + all.length + '）')
  t(all.some(x => x.level === 'warn'), '包含 warn 级结论')

  const firstNonWarn = all.findIndex(x => x.level !== 'warn')
  const lastWarn = all.map(x => x.level).lastIndexOf('warn')
  t(firstNonWarn === -1 || lastWarn < firstNonWarn, 'warn 全部排在非 warn 之前')

  t(JSON.stringify(ins.buildInsights(rich)) === JSON.stringify(all), '同输入两次调用结果完全一致（排序稳定）')

  audit(all, rich, '规则全部触发')

  const ruleNames = Object.keys(rules)
  ruleNames.forEach(function (k) {
    const item = rules[k](rich)
    if (item) audit([item], rich, '单规则 ' + k)
  })

  t(ins.buildInsights(baseSummary({ total: 0.001, count: 1 })).length === 0,
    '只有 1 笔记录 → 空数组（说明不了"习惯"，不该给结论）')
  t(ins.buildInsights(baseSummary({ total: 50, count: 2 })).length === 0, '只有 2 笔 → 空数组（阈值是 3 笔）')
  t(ins.buildInsights(baseSummary({ total: -100 })).length === 0, '总额为负（脏数据）→ 空数组，不生成荒谬结论')

  // ================================================================
  console.log('\n=== 12) 云函数端到端：action=insight ===')
  // ================================================================
  freeze(2026, 10, 16, 10, 0)
  reset()

  // ⚠️ 窗口是 9/17 ~ 10/16（今天往前 30 天含今天），
  //    所以「上期」的账单必须落在 9/16 或更早 —— 写成 9/20 会落进本期，
  //    断言会莫名其妙地全错（这种错比代码 bug 更难查）。
  addBill(bjTs(2026, 10, 15, 12, 0), 'expense', 120.5, 'food', '餐饮', '美团外卖')
  addBill(bjTs(2026, 10, 14, 19, 0), 'expense', 60, 'transport', '交通', '滴滴')
  addBill(bjTs(2026, 10, 10, 12, 0), 'expense', 300, 'shopping', '购物', '某商城')
  addBill(bjTs(2026, 10, 10, 12, 0), 'income', 8000, 'salary', '工资', '公司')
  addBill(bjTs(2026, 9, 10, 12, 0), 'expense', 200, 'food', '餐饮', '美团外卖')
  addBill(bjTs(2026, 9, 5, 12, 0), 'expense', 100, 'shopping', '购物', '某商城')

  const r1 = await runInsight()
  t(r1.code === 0, 'action=insight 返回 code 0')
  const s1 = r1.data.summary
  t(s1.total === 480.5, '本期支出合计 480.50（实际 ' + s1.total + '）—— 收入不计入')
  t(s1.count === 3, '本期支出 3 笔（实际 ' + s1.count + '）')
  t(s1.prev.total === 300, '上期支出 300（实际 ' + s1.prev.total + '）')
  t(s1.categories.length === 3, '聚出 3 个类目（实际 ' + s1.categories.length + '）')
  t(s1.categories[0].name === '购物', '类目按金额倒序，第一名是购物（实际 ' + s1.categories[0].name + '）')
  t(r1.data.meta.generatedBy === 'rule', '明确标注结论由规则生成（前端据此如实说明）')
  t(r1.data.scope.days === 30, '分析窗口 30 天')
  t(Array.isArray(r1.data.insights), 'insights 是数组')
  t(r1.data.insights.some(x => x.id === 'baseline'), '给出了基准结论')

  // 摘要与结论一并返回 —— 这让"可核对"变成能自动验证的事实
  audit(r1.data.insights, s1, '云函数返回的结论')

  reset()
  addBill(bjTs(2026, 9, 10, 12, 0), 'expense', 200, 'food', '餐饮', '美团')
  const r2 = await runInsight()
  t(r2.code === 0 && r2.data.insights.length === 0, '近 30 天没有支出 → 空数组（不返回任何结论）')

  // ================================================================
  console.log('\n=== 12.5) 近 7 天窗口：action=insight, days=7 ===')
  // ================================================================
  freeze(2026, 10, 16, 10, 0)
  reset()

  // 近 7 天（10/10 ~ 10/16）内 4 笔支出；10/8 落在上期（10/3~10/9），10/1 在上期之外取不到
  addBill(bjTs(2026, 10, 15, 12, 0), 'expense', 120, 'food', '餐饮', '美团外卖')
  addBill(bjTs(2026, 10, 14, 19, 0), 'expense', 60, 'transport', '交通', '滴滴')
  addBill(bjTs(2026, 10, 12, 23, 30), 'expense', 90, 'entertainment', '娱乐', '深夜烧烤')
  addBill(bjTs(2026, 10, 11, 12, 0), 'expense', 300, 'shopping', '购物', '某商城')
  addBill(bjTs(2026, 10, 8, 12, 0), 'expense', 100, 'food', '餐饮', '美团外卖')   // 上期
  addBill(bjTs(2026, 10, 1, 12, 0), 'expense', 200, 'food', '餐饮', '美团外卖')   // 上期之外，取不到

  const r7 = await statsFn.main({ action: 'insight', days: 7 }, {})
  t(r7.code === 0, 'days=7 返回 code 0')
  t(r7.data.scope.days === 7, '分析窗口 7 天（实际 ' + r7.data.scope.days + '）')
  const s7 = r7.data.summary
  t(s7.days === 7, 'summary.days = 7')
  t(s7.total === 570, '近 7 天支出合计 570（实际 ' + s7.total + '）—— 上期两笔不计入')
  t(s7.count === 4, '近 7 天 4 笔（实际 ' + s7.count + '）')
  t(s7.prev.total === 100, '上期（再往前 7 天）支出 100（实际 ' + s7.prev.total + '）')
  // 深夜消费：10/12 23:30 那笔 90 元落在深夜（23:00 ~ 05:00）
  t(s7.night.amount === 90, '深夜支出 90（实际 ' + s7.night.amount + '）—— 23:30 那笔')
  t(s7.night.count === 1, '深夜 1 笔（实际 ' + s7.night.count + '）')

  // 无效 days 值回落到默认 30 天
  const rBad = await statsFn.main({ action: 'insight', days: 999 }, {})
  t(rBad.data.scope.days === 30, '非法 days=999 → 回落到 30 天（实际 ' + rBad.data.scope.days + '）')

  // ================================================================
  console.log('\n=== 13) 预算必须按「本月」算，不能用 30 天窗口的合计 ===')
  // ================================================================
  // ⚠️ 最容易出错的地方：分析窗口是「近 30 天」，预算是「本月」，两者不重合。
  //    今天 10/31 时窗口从 10/2 起 —— 10/1 那笔支出不在窗口里，
  //    但它**属于本月**，必须算进预算，否则预算进度会平白少一笔且不报错。
  //
  //    窗口内要有 3 笔才够 MIN_COUNT 门槛（少于 3 笔说明不了"习惯"，
  //    规则引擎会返回空数组 —— 这是刻意的，不是 bug）。
  freeze(2026, 10, 31, 10, 0)
  reset()
  DB.users[0].budget = { amount: 1000, updateTime: 0 }   // reset() 已放入会员档案，这里只补预算
  addBill(bjTs(2026, 10, 1, 12, 0), 'expense', 888, 'shopping', '购物', '某商城')  // 窗口外、但属于本月
  addBill(bjTs(2026, 10, 20, 12, 0), 'expense', 200, 'food', '餐饮', '美团')
  addBill(bjTs(2026, 10, 21, 12, 0), 'expense', 150, 'food', '餐饮', '美团')
  addBill(bjTs(2026, 10, 22, 12, 0), 'expense', 100, 'transport', '交通', '滴滴')

  const r3 = await runInsight()
  t(r3.code === 0, '跨月场景正常返回')
  t(r3.data.summary.total === 450, '分析窗口只统计到 ¥450.00（实际 ' + r3.data.summary.total + '）')
  t(r3.data.summary.count === 3, '窗口内 3 笔（实际 ' + r3.data.summary.count + '）')

  const bIns = r3.data.insights.find(x => x.id === 'budget')
  t(!!bIns, '有预算时给出预算结论（实际触发了：' + (r3.data.insights.map(x => x.id).join(',') || '无') + '）')
  if (bIns) {
    t(bIns.evidence.some(e => e.value === ins.money(1338)),
      '预算里的「已花」是本月口径 ¥1338.00（含窗口外那笔 888，实际 ' + JSON.stringify(bIns.evidence) + '）')
    t(!bIns.evidence.some(e => e.value === ins.money(450)),
      '预算里不会出现窗口口径的 ¥450.00（两个口径不能混）')
  }

  const todayStart = bjTs(2026, 10, 31, 0, 0)
  const prevStart = todayStart - 59 * DAY
  const monthStart = bjTs(2026, 10, 1, 0, 0)
  t(prevStart <= monthStart, '取数起点早于本月 1 号（否则窗口外那笔根本读不到）')

  DB.users = [{ _id: 'u0', _openid: 'me', uid: 'u0', vip: { since: 1 } }]   // 会员但没有预算
  const r4 = await runInsight()
  t(!r4.data.insights.some(x => x.id === 'budget'), '没设预算 → 不出现预算结论')

  Date.now = REAL_NOW

  console.log(fail === 0 ? '\n全部通过 ✅' : '\n有 ' + fail + ' 项失败 ❌')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(function (err) {
  console.error(err)
  process.exit(1)
})