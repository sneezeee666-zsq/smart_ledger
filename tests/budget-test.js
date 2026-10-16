/**
 * 预算管理离线验证
 *
 * 这个模块的风险点和别处不一样 —— 它**不写入账单**、也不删任何东西，
 * 但它是全项目里"派生指标"最密集的地方，所以重点守三件事：
 *
 *   1. **天数分母**：日均收支踩过的坑，预算又踩一遍。
 *      「还剩几天」必须含今天，必须按北京时间的"日"相减，
 *      而且要在月初/月末/2 月/闰年这些边界上验算 ——
 *      分母错一天，界面上那个"每天还能花"就悄悄错一天的量，谁也发现不了。
 *
 *   2. **分档阈值**：判定必须用真实比值（spent/amount），不能用四舍五入后的百分比。
 *      花了 79.99% 时显示的是 80%，若拿显示值去判档，"安全"会被错判成"接近"。
 *
 *   3. **两个入口同源**：首页的进度条和预算页的进度必须出自同一个 composeBudget，
 *      否则会出现"首页说还剩 300、预算页说还剩 280"这种没法解释的差异。
 *
 * 时间是用覆盖 Date.now 固定的 —— 不固定的话这些断言只在某些日子才成立。
 *
 * 运行：node tests/budget-test.js
 */
const Module = require('module')
const path = require('path')

const USER_FN = path.join(__dirname, '..', 'cloudfunctions/user/index.js')
const STATS_FN = path.join(__dirname, '..', 'cloudfunctions/getStatistics/index.js')

const BJ = 8 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

let fail = 0
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

const realError = console.error
const muteErrors = () => { console.error = () => {} }
const unmuteErrors = () => { console.error = realError }

// ==================== 时间控制 ====================

const REAL_NOW = Date.now
/** 把"现在"固定成北京时间的某个时刻 */
function freeze(y, m, d, hh, mm) {
  const ts = Date.UTC(y, m - 1, d, hh || 10, mm || 0) - BJ
  Date.now = () => ts
  return ts
}
/** 北京时间 → 真实时间戳（造账单用） */
function bjTs(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh || 12, mm || 0) - BJ
}

// ==================== 内存假库 ====================

const DB = { bills: [], users: [] }
let seq = 0
let OPENID = 'me'

function cond(op, value) {
  const c = { __cond: true, op, value }
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
  const rows = () => (DB[name] = DB[name] || [])

  const api = {
    where(c) { state.cond = c || {}; return api },
    field() { return api },
    orderBy() { return api },
    skip(n) { state.skip = n; return api },
    limit(n) { state.limit = n; return api },
    async get() {
      const hit = rows().filter(d => matchDoc(d, state.cond))
      return { data: hit.slice(state.skip, state.skip + state.limit) }
    },
    async count() {
      return { total: rows().filter(d => matchDoc(d, state.cond)).length }
    },
    async add({ data }) {
      seq++
      const _id = 'doc' + seq
      rows().push(Object.assign({ _id }, data))
      return { _id }
    },
    async update({ data }) {
      let updated = 0
      rows().forEach(d => {
        if (!matchDoc(d, state.cond)) return
        Object.keys(data).forEach(k => {
          // _.remove() 在真实 SDK 里是"删掉这个字段"，假库要跟着模拟 ——
          // 否则"取消预算"看起来只是把值写成 undefined，测不出字段到底删没删
          if (data[k] && data[k].__remove) delete d[k]
          else d[k] = data[k]
        })
        updated++
      })
      return { stats: { updated } }
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
  init() {},
  database() { return { collection: makeCollection, command: command } },
  getWXContext() { return { OPENID } }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return cloudStub
  return origLoad.apply(this, arguments)
}

const userFn = require(USER_FN)
const statsFn = require(STATS_FN)

const getProfile = () => userFn.main({ action: 'getProfile' }, {})
const setBudgetCloud = amount => userFn.main({ action: 'setBudget', amount }, {})
const budgetOf = () => statsFn.main({ action: 'budget' }, {})
const indexData = () => statsFn.main({ action: 'indexData' }, {})

function reset() {
  DB.bills = []
  DB.users = []
  seq = 0
  OPENID = 'me'
}

/** 造一条账单 */
function bill(openid, ts, type, amount, categoryId) {
  seq++
  DB.bills.push({
    _id: 'b' + seq,
    _openid: openid,
    createTime: ts,
    type: type,
    amount: amount,
    categoryId: categoryId || 'food'
  })
}

/** 给某人建好档案并设好预算 */
async function withBudget(openid, amount) {
  OPENID = openid
  await getProfile()
  if (amount > 0) {
    const r = await setBudgetCloud(amount)
    if (r.code !== 0) throw new Error('造数据失败: ' + r.message)
  }
}

// ==================== 1) 写入：校验与越权 ====================

async function testWrite() {
  console.log('\n=== 1) 设置预算：校验在前，越权拦住 ===')
  reset()
  await getProfile()

  let r = await setBudgetCloud('3000')
  t(r.code === 0 && r.data.budget.amount === 3000, `字符串 '3000' → 存成数字 3000`)
  t(DB.users[0].budget && DB.users[0].budget.amount === 3000, '库里落下 budget 字段')
  t(DB.users[0].budget.updateTime > 0, '带了 updateTime（将来要追溯"这条额度什么时候改的"）')

  r = await setBudgetCloud('3000.50')
  t(r.code === 0 && DB.users[0].budget.amount === 3000.5, `'3000.50' → 3000.5（去掉尾随 0）`)

  r = await setBudgetCloud('.5')
  t(r.code === 0 && DB.users[0].budget.amount === 0.5, `'.5' → 0.5（输入法允许先打小数点）`)

  r = await setBudgetCloud('100000000')
  t(r.code === 0, '刚好等于上限 → 接受（边界内侧）')

  r = await setBudgetCloud('100000001')
  t(r.code === -1, `超上限 → 拒绝：「${r.message}」`)

  const bad = [
    ['-5', '负数'],
    ['-0.01', '负的小数'],
    ['100.005', '3 位小数'],
    ['abc', '非数字'],
    ['3,000', '带千分位逗号（正则不认，宁可让用户删掉）'],
    ['1e3', '科学计数法'],
    ['   ', '纯空白 → 这个应该被当成取消预算，下面单独测'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity']
  ]
  let rejected = 0
  for (const [input, why] of bad) {
    if (why.indexOf('取消预算') !== -1) continue
    const rr = await setBudgetCloud(input)
    if (rr.code === -1) rejected++
    else t(false, `${why}（${JSON.stringify(input)}）应该被拒绝，却返回 code=${rr.code}`)
  }
  t(rejected === 8, `${rejected} 类脏输入全部被拒绝（负数/3位小数/非数字/科学计数法/NaN/Infinity…）`)

  // 空串与 0 = 取消预算，且要**真的把字段删掉**，不是留一个 0
  r = await setBudgetCloud('')
  t(r.code === 0 && r.data.budget === null, `空串 → 取消预算（返回体 budget 是 null）`)
  t(!('budget' in DB.users[0]), '取消后库里连字段都没有了（不是留一个 0 —— 那会让"没设过"和"设成 0"两种状态并存）')

  await setBudgetCloud('2000')
  t(DB.users[0].budget.amount === 2000, '取消后还能重新设置')

  // 越权：别人改不动我的
  OPENID = 'other'
  await getProfile()
  await setBudgetCloud('999')
  t(DB.users.find(d => d._openid === 'me').budget.amount === 2000, '另一个人设预算，我的额度一个字没被改到')

  OPENID = 'me'
  r = await getProfile()
  t(r.data.budget.amount === 2000, '我读到的仍是自己的 2000，不是别人的 999')

  // 只改昵称/主题时预算不能丢（返回体必须带上 budget）
  r = await userFn.main({ action: 'updateProfile', nickname: '小明' }, {})
  t(r.code === 0 && r.data.budget && r.data.budget.amount === 2000,
    '改昵称时返回体仍带 budget（少给一个字段，前端整份写缓存时就会把预算抹掉）')

  r = await userFn.main({ action: 'updateProfile', theme: 'blue' }, {})
  t(r.data.budget && r.data.budget.amount === 2000, '改主题时同理')
  t(DB.users.find(d => d._openid === 'me').budget.amount === 2000, '库里也没被动过')

  // 没设过的用户读出来是 null，不是 0 也不是 undefined
  OPENID = 'fresh'
  r = await getProfile()
  t(r.data.budget === null, `从没设过预算 → budget 是 null（实际 ${JSON.stringify(r.data.budget)}）`)
}

// ==================== 2) 天数分母 ====================

async function testDays() {
  console.log('\n=== 2) 天数分母：含今天、按北京时间的"日"算 ===')

  // 2026-10-16，31 天的月份
  reset()
  freeze(2026, 10, 16, 10, 0)
  await withBudget('me', 3000)
  bill('me', bjTs(2026, 10, 16, 9, 0), 'expense', 1200)

  let b = (await budgetOf()).data.budget

  t(b.daysTotal === 31, `2026 年 10 月有 31 天（得到 ${b.daysTotal}）`)
  t(b.daysPassed === 16, `今天是 16 号 → 已过 16 天（得到 ${b.daysPassed}）`)
  // ⚠️ 独立算法验算：剩余 = 当月天数 - 今天 + 1（今天还没过完，今天仍然可以花钱）
  t(b.daysLeft === 31 - 16 + 1, `还剩 ${b.daysLeft} 天（独立算法 31-16+1=${31 - 16 + 1}）`)
  t(b.daysPassed + b.daysLeft === b.daysTotal + 1,
    '已过 + 还剩 = 当月天数 + 1（今天被两边都算了一次，这是"含今天"的定义）')

  // 月初 / 月末：两个最容易差一天的地方
  freeze(2026, 10, 1, 0, 30)
  b = (await budgetOf()).data.budget
  t(b.daysPassed === 1 && b.daysLeft === 31, `月初 1 号：已过 1 天、还剩 31 天（得到 ${b.daysPassed}/${b.daysLeft}）`)

  freeze(2026, 10, 31, 23, 50)
  b = (await budgetOf()).data.budget
  t(b.daysPassed === 31 && b.daysLeft === 1,
    `月末 31 号：已过 31 天、还剩 1 天 —— 不是 0（得到 ${b.daysPassed}/${b.daysLeft}）`)

  freeze(2026, 11, 30, 12, 0)
  b = (await budgetOf()).data.budget
  t(b.daysTotal === 30 && b.daysLeft === 1, `30 天的月份：总 30 天、月末还剩 1 天（得到 ${b.daysTotal}/${b.daysLeft}）`)

  // 闰年 2 月：daysInMonth 必须靠 Date.UTC(y, m+1, 0) 自动处理，不能写死 28
  freeze(2028, 2, 15, 12, 0)
  b = (await budgetOf()).data.budget
  t(b.daysTotal === 29, `2028 年 2 月（闰年）有 29 天（得到 ${b.daysTotal}）`)
  t(b.daysLeft === 29 - 15 + 1, `闰年 2 月 15 号 → 还剩 ${b.daysLeft} 天`)

  freeze(2026, 2, 15, 12, 0)
  b = (await budgetOf()).data.budget
  t(b.daysTotal === 28, `2026 年 2 月（平年）有 28 天（得到 ${b.daysTotal}）`)

  // 跨零点：23:59 与次日 00:01 必须分属两天
  freeze(2026, 10, 16, 23, 59)
  const d1 = (await budgetOf()).data.budget
  freeze(2026, 10, 17, 0, 1)
  const d2 = (await budgetOf()).data.budget
  t(d1.daysPassed === 16 && d2.daysPassed === 17, '北京时间的跨零点正确换日（23:59 是 16 号，00:01 是 17 号）')
  t(d2.daysLeft === d1.daysLeft - 1, '跨过一天，还剩天数正好少 1')
}

// ==================== 3) 分档与进度 ====================

async function testLevels() {
  console.log('\n=== 3) 超支分档：判定用真实比值，不用显示用的百分比 ===')

  const cases = [
    // [预算, 已花, 期望档位, 说明]
    [10000, 0, 'safe', '一分没花'],
    [10000, 7999, 'safe', '79.99%'],
    [10000, 8000, 'near', '刚好 80%（边界内侧 → 接近）'],
    [10000, 9999, 'near', '99.99%'],
    [10000, 10000, 'near', '刚好花完（100% 还没超，属于"接近"而不是"已超"）'],
    [10000, 10001, 'over', '超 1 元就算超出'],
    [10000, 15000, 'over', '超 50%']
  ]

  for (const [amount, spent, expect, why] of cases) {
    reset()
    freeze(2026, 10, 16, 10, 0)
    await withBudget('me', amount)
    if (spent > 0) bill('me', bjTs(2026, 10, 16, 9, 0), 'expense', spent)

    const b = (await budgetOf()).data.budget
    t(b.level === expect, `${why}：预算 ${amount} / 已花 ${spent} → ${b.level}（期望 ${expect}）`)
  }

  // 关键：79.99% 显示成 80%，但档位必须还是 safe
  reset()
  freeze(2026, 10, 16, 10, 0)
  await withBudget('me', 10000)
  bill('me', bjTs(2026, 10, 16, 9, 0), 'expense', 7999)
  let b = (await budgetOf()).data.budget
  t(b.usedPercent === 80 && b.level === 'safe',
    `已花 79.99% → 显示 80% 但档位仍是 safe（拿显示值判档就会错判成"接近"）`)

  // 进度条宽度必须封顶
  reset()
  freeze(2026, 10, 16, 10, 0)
  await withBudget('me', 1000)
  bill('me', bjTs(2026, 10, 16, 9, 0), 'expense', 3000)
  b = (await budgetOf()).data.budget
  t(b.usedPercent === 300, `已用百分比如实是 300%（得到 ${b.usedPercent}）`)
  t(b.barPercent === 100, `进度条宽度封顶在 100（得到 ${b.barPercent}）—— WXML 没有 Math.min，不封顶会捅出卡片外`)
  t(b.over === 2000 && b.remaining === -2000, '超出金额与剩余都如实为负/正')
  t(b.dailyLeft === null, '"每天还能花"返回 null（负数没有意义，界面改说"已超出"）')

  // 刚好花完：dailyLeft 也是 null（剩余 0 分不出每天能花多少）
  reset()
  freeze(2026, 10, 16, 10, 0)
  await withBudget('me', 1000)
  bill('me', bjTs(2026, 10, 16, 9, 0), 'expense', 1000)
  b = (await budgetOf()).data.budget
  t(b.remaining === 0 && b.dailyLeft === null && b.level === 'near', '刚好花完：剩余 0、dailyLeft 为 null、档位 near')
}

// ==================== 4) 派生数字可核对 ====================

async function testDerived() {
  console.log('\n=== 4) 派生数字必须能被用户自己核对 ===')

  reset()
  freeze(2026, 10, 16, 10, 0)
  await withBudget('me', 3000)
  bill('me', bjTs(2026, 10, 16, 9, 0), 'expense', 1200)

  const b = (await budgetOf()).data.budget

  t(b.spent === 1200 && b.remaining === 1800, '已花 1200 / 剩余 1800（3000 - 1200）')

  // 反向核对：每天还能花 × 还剩天数 ≈ 剩余（容差来自 round2，不是随便放宽）
  const tol = b.daysLeft * 0.005 + 0.01
  t(Math.abs(b.dailyLeft * b.daysLeft - b.remaining) <= tol,
    `「每天还能花」× 还剩天数 ≈ 剩余（${b.dailyLeft} × ${b.daysLeft} = ${Math.round(b.dailyLeft * b.daysLeft * 100) / 100}，剩余 ${b.remaining}）`)

  // 日均：分母是"已过天数"
  t(b.dailyAvg === Math.round(1200 / 16 * 100) / 100, `日均 = 已花 ÷ 已过天数 = 1200 ÷ 16 = ${b.dailyAvg}`)

  // 月末预测：日均 × 当月天数
  t(b.forecast === Math.round(b.dailyAvg * b.daysTotal * 100) / 100,
    `月末预测 = 日均 × 当月天数 = ${b.forecast}`)
  t(b.forecast < b.amount && b.forecastOver === 0,
    `预计 ${b.forecast} 元 < 预算 ${b.amount}，此时不产生"预计超出"（forecastOver 归 0 而不是负数）`)

  // 预测真的会超时，才给出超出金额
  reset()
  freeze(2026, 10, 16, 10, 0)
  await withBudget('me', 2000)
  bill('me', bjTs(2026, 10, 16, 9, 0), 'expense', 1200)
  const bo = (await budgetOf()).data.budget
  t(bo.forecast === 2325 && bo.forecastOver === 325,
    `预算 2000 时：按目前速度预计 2325，预计超出 325（得到 ${bo.forecast} / ${bo.forecastOver}）`)
  t(bo.level === 'safe' && bo.forecastOver > 0,
    '当下还没超（safe），但预测会超 —— 所以"预计超出"必须与"已超出"分开表达，不能合并成一个红色数字')

  // 月初样本太少 → 不给预测（1 号买台冰箱就能推出"本月要花十万"，只会吓人）
  reset()
  freeze(2026, 10, 1, 9, 0)
  await withBudget('me', 3000)
  bill('me', bjTs(2026, 10, 1, 8, 0), 'expense', 5000)
  let b2 = (await budgetOf()).data.budget
  t(b2.forecast === null && b2.forecastOver === 0,
    `月初第 1 天不给月末预测（已花 5000 也不推"本月要花 15 万"）`)
  t(b2.dailyAvg > 0, '但日均照常给（它是已发生的事实的平均数，不是预测）')

  freeze(2026, 10, 5, 9, 0)
  bill('me', bjTs(2026, 10, 5, 8, 0), 'expense', 100)
  b2 = (await budgetOf()).data.budget
  t(b2.forecast !== null, '第 5 天开始给预测（样本够了）')

  // 只算支出：收入不进"已花"
  reset()
  freeze(2026, 10, 16, 10, 0)
  await withBudget('me', 3000)
  bill('me', bjTs(2026, 10, 16, 9, 0), 'expense', 500)
  bill('me', bjTs(2026, 10, 16, 9, 30), 'income', 8000)
  const bd = (await indexData()).data
  t(bd.budget.spent === 500, `收入 8000 不计入额度消耗（已花 ${bd.budget.spent}）`)
  t(bd.monthSummary.income === 8000, '收入仍在月汇总里如实显示')

  // 跨月：上个月的账单不算本月已花
  reset()
  freeze(2026, 10, 16, 10, 0)
  await withBudget('me', 3000)
  bill('me', bjTs(2026, 9, 30, 23, 0), 'expense', 9999)   // 上月
  bill('me', bjTs(2026, 10, 1, 0, 30), 'expense', 100)    // 本月第一笔
  const bm = (await budgetOf()).data.budget
  t(bm.spent === 100, `上月 9999 元不计入本月（本月已花 ${bm.spent}）`)
}

// ==================== 5) 未设预算 & 两个入口同源 ====================

async function testEmptyAndConsistency() {
  console.log('\n=== 5) 未设预算 ≠ 预算为 0；两个入口必须同源 ===')

  reset()
  freeze(2026, 10, 16, 10, 0)
  await getProfile()
  bill('me', bjTs(2026, 10, 16, 9, 0), 'expense', 500)

  let r = await budgetOf()
  t(r.code === 0 && r.data.budget === null,
    `没设过预算 → budget 是 null（不是 amount:0 的对象）—— 界面据此显示设置引导，而不是一条 0/0 的进度条`)

  const idx = (await indexData()).data
  t(idx.budget === null, '首页同样拿到 null，进度条整块不渲染')

  // 设完之后两个入口必须给出**完全一样**的进度
  await withBudget('me', 2000)
  const a = (await budgetOf()).data.budget
  const c = (await indexData()).data.budget

  t(JSON.stringify(a) === JSON.stringify(c),
    'action:"budget" 与 indexData 的进度块逐字段一致（同一 composeBudget，不各算一遍）')
  t(c.spent === (await indexData()).data.monthSummary.expense,
    `首页进度条的"已花"与概览卡的"本月支出"是同一个数（${c.spent}）`)

  // 越权：读不到别人的预算
  OPENID = 'other'
  await getProfile()
  const other = (await budgetOf()).data.budget
  t(other === null, '换个 openid 读 → 读不到别人的预算（fetchBudget 按 _openid 收窄）')

  OPENID = 'me'
  const mine = (await budgetOf()).data.budget
  t(mine && mine.amount === 2000, '切回来仍是自己的额度')
}

// ==================== 6) 前端 utils/user.js ====================

const USER_UTIL = path.join(__dirname, '..', 'utils', 'user.js')

let STORE = {}
let CLOUD_REPLY = null
let LAST_CALL = null

global.wx = {
  getStorageSync(k) { return STORE[k] === undefined ? '' : STORE[k] },
  setStorageSync(k, v) { STORE[k] = v },
  setTabBarStyle() {},
  setTabBarItem() {},
  setNavigationBarColor() {},
  setBackgroundColor() {},
  cloud: {
    callFunction(opts) {
      LAST_CALL = opts
      if (CLOUD_REPLY === 'fail') return Promise.reject(new Error('stub: 云函数不可用'))
      return Promise.resolve({ result: CLOUD_REPLY || { code: -1, message: 'stub' } })
    }
  }
}

function freshUserUtil() {
  delete require.cache[require.resolve(USER_UTIL)]
  return require(USER_UTIL)
}

async function testFrontend() {
  console.log('\n=== 6) 前端：校验规则一致 + 预算不会被别的字段挤掉 ===')

  let u = freshUserUtil()

  // 校验规则必须与云函数一致（常量由 static-check 对账，这里守行为）
  const cases = [
    ['3000', true], ['3000.50', true], ['.5', true], ['100000000', true],
    ['-5', false], ['100.005', false], ['abc', false], ['3,000', false],
    ['1e3', false], ['100000001', false],
    ['', true], ['   ', true], [null, true], [0, true]
  ]
  let bad = 0
  cases.forEach(([input, expect]) => {
    const got = u.validateBudget(input).ok
    if (got !== expect) {
      bad++
      t(false, `validateBudget(${JSON.stringify(input)}) 期望 ${expect}，得到 ${got}`)
    }
  })
  if (!bad) t(true, `${cases.length} 个预算用例与云函数规则一致（含 .5 / 3 位小数 / 千分位 / 取消预算）`)

  t(u.validateBudget('').value === 0 && u.validateBudget('0').value === 0,
    '空串与 0 都归一成 0（= 取消预算）')
  t(u.validateBudget('3000.50').value === 3000.5, '归一化后的值是数字而不是字符串')

  // --- 冷启动：云端有预算 ---
  STORE = {}
  CLOUD_REPLY = { code: 0, data: { uid: 'u1', nickname: '小明', theme: 'green', budget: { amount: 2500, updateTime: 999 } } }
  u = freshUserUtil()
  await u.load(true)
  t(u.budget() === 2500, `load() 后 budget() 拿到云端额度（${u.budget()}）`)
  t(u.budgetTime() === 999, 'budgetTime 也一并落到本机')

  // --- 只有 theme 变了（returnPath 里没有 budget 字段）时不能把预算抹掉 ---
  STORE = {}
  STORE[u.STORAGE_KEY] = { uid: 'u1', nickname: '小明', theme: 'green', budget: 3000, budgetTime: 111 }
  u = freshUserUtil()
  u.current()
  CLOUD_REPLY = { code: 0, data: { uid: 'u1', nickname: '小明', theme: 'blue' } }
  await u.syncTheme('blue')
  t(u.budget() === 3000,
    `只改主题时预算保留（${u.budget()}）—— 早期各调用点自己拼完整对象，加字段漏一处就会这样丢数据`)
  t(u.current().theme === 'blue', '主题本身照常更新')

  // --- 云端说取消了预算，本机必须跟着清掉（不能 merge 成"没提到就保留"） ---
  CLOUD_REPLY = { code: 0, data: { uid: 'u1', nickname: '小明', theme: 'blue', budget: null } }
  await u.load(true)
  t(u.budget() === 0 && u.budgetTime() === 0, '云端 budget 为 null → 本机清零（否则界面上进度条会赖着不走）')

  // --- setBudget 走的是 setBudget 动作，且 amount 传数字 ---
  CLOUD_REPLY = { code: 0, data: { uid: 'u1', nickname: '小明', theme: 'blue', budget: { amount: 5000, updateTime: 123 } } }
  await u.setBudget('5000')
  t(LAST_CALL && LAST_CALL.name === 'user' && LAST_CALL.data.action === 'setBudget',
    `走的是 user 云函数的 setBudget 动作（实际 ${LAST_CALL && LAST_CALL.data && LAST_CALL.data.action}）`)
  t(typeof LAST_CALL.data.amount === 'number' && LAST_CALL.data.amount === 5000,
    `amount 传的是数字 5000，不是字符串（云端要按数字比大小）`)
  t(u.budget() === 5000, 'setBudget 成功后本机立刻生效')

  // --- 校验失败要 reject，不能静默什么都不做 ---
  let threw = false
  try { await u.setBudget('-1') } catch (e) { threw = true }
  t(threw, '非法额度 setBudget 会 reject（用户主动点的保存，失败必须让他知道）')
  let msg = ''
  try { await u.setBudget('100.005') } catch (e) { msg = e.message }
  t(msg.indexOf('2 位小数') !== -1, `错误提示说清了原因：「${msg}」`)

  // --- 云函数不可用时 budget() 不抛错 ---
  CLOUD_REPLY = 'fail'
  muteErrors()
  let ok = true
  try { await u.load(true) } catch (e) { ok = false }
  unmuteErrors()
  t(ok, '云函数不可用时 load() 不抛错（抛了会把页面卡在加载态）')
  t(u.budget() === 5000, '降级时沿用本机缓存里的预算')
}

// ==================== 跑 ====================

;(async () => {
  try {
    await testWrite()
    await testDays()
    await testLevels()
    await testDerived()
    await testEmptyAndConsistency()
    await testFrontend()
  } finally {
    Date.now = REAL_NOW
  }

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`)
  process.exit(fail === 0 ? 0 : 1)
})()
