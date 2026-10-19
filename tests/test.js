/**
 * getStatistics 云函数离线验证
 * 用 Module._load 拦截 wx-server-sdk，注入内存假数据库。
 *
 * 运行：node test.js
 */
const Module = require('module')

const CLOUD_FN = require('path').join(__dirname, '..', 'cloudfunctions/getStatistics/index.js')

const BJ = 8 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

// ---------- 命令对象（gte / lte / and） ----------
function cond(op, value) {
  const c = { __cond: true, op, value }
  c.and = function (other) {
    return { __cond: true, op: 'and', parts: [c, other] }
  }
  return c
}

function matchField(actual, c) {
  if (c === null || c === undefined) return true
  if (typeof c === 'object' && c.__cond) {
    if (c.op === 'gte') return actual >= c.value
    if (c.op === 'lte') return actual <= c.value
    if (c.op === 'and') return matchField(actual, c.parts[0]) && matchField(actual, c.parts[1])
    return false
  }
  return actual === c
}

function matchDoc(doc, condition) {
  return Object.keys(condition).every(k => matchField(doc[k], condition[k]))
}

// ---------- 假数据集 ----------
const DOCS = []
let seq = 0

function addBill(ts, type, amount, categoryId, category, icon, color) {
  seq++
  DOCS.push({
    _id: 'id' + seq,
    _openid: 'me',
    createTime: ts,
    type,
    amount,
    categoryId,
    category,
    icon,
    color,
    orderNo: 'NO' + seq
  })
}

const bjTs = (y, m, d, hh, mm, ss) => Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0) - BJ

const nowP = new Date(Date.now() + BJ)
const TODAY_Y = nowP.getUTCFullYear()
const TODAY_M = nowP.getUTCMonth() + 1
const TODAY_D = nowP.getUTCDate()
const todayStart = bjTs(TODAY_Y, TODAY_M, TODAY_D)

console.log(`今天（北京时间）：${TODAY_Y}-${TODAY_M}-${TODAY_D}`)

// —— 数据 ——
addBill(todayStart - DAY + 12 * 3600 * 1000, 'expense', 100, 'food', '餐饮', '🍜', '#FF6B6B')      // 昨天 12:00
addBill(todayStart + 9 * 3600 * 1000 + 30 * 60 * 1000, 'expense', 35.5, 'food', '餐饮', '🍜', '#FF6B6B') // 今天 09:30
addBill(todayStart + 30 * 60 * 1000, 'expense', 8.8, 'transport', '交通', '🚗', '#4ECDC4')       // 今天 00:30
addBill(bjTs(TODAY_Y, TODAY_M, 1, 0, 10, 0), 'income', 12000, 'salary', '工资', '💰', '#2ECC71') // 本月 1 号 00:10

const prevIdx = TODAY_Y * 12 + (TODAY_M - 1) - 1
addBill(bjTs(Math.floor(prevIdx / 12), (prevIdx % 12) + 1, 20, 18, 0, 0), 'expense', 300, 'shopping', '购物', '🛒', '#45B7D1')

const m3 = TODAY_Y * 12 + (TODAY_M - 1) - 3
addBill(bjTs(Math.floor(m3 / 12), (m3 % 12) + 1, 10, 10, 0, 0), 'expense', 500, 'housing', '住房', '🏠', '#FFEAA7')

// —— 期望值 ——
const monthStart = bjTs(TODAY_Y, TODAY_M, 1)
const monthEnd = todayStart + DAY - 1
const inThisMonth = ts => ts >= monthStart && ts <= monthEnd
const monthBills = DOCS.filter(d => inThisMonth(d.createTime))
const expectMonthIncome = monthBills.filter(d => d.type === 'income').reduce((s, d) => s + d.amount, 0)
const expectMonthExpense = monthBills.filter(d => d.type === 'expense').reduce((s, d) => s + d.amount, 0)

console.log('本月区间内记录数:', monthBills.length, '| 期望收入:', expectMonthIncome, '期望支出:', expectMonthExpense)
console.log('总记录数:', DOCS.length)

// ---------- 云函数桩 ----------
function freshQuery() {
  return {
    _field: null,
    _order: null,
    _skip: 0,
    _limit: 1000,
    _where: null,
    where(c) { this._where = c; return this },
    field(f) { this._field = f; return this },
    orderBy(k, dir) { this._order = { k, dir }; return this },
    skip(n) { this._skip = n; return this },
    limit(n) { this._limit = n; return this },
    async get() {
      let rows = DOCS.filter(d => matchDoc(d, this._where || {}))
      if (this._order) {
        const { k, dir } = this._order
        rows = rows.slice().sort((a, b) => (dir === 'desc' ? b[k] - a[k] : a[k] - b[k]))
      }
      const sliced = rows.slice(this._skip, this._skip + this._limit)
      const out = sliced.map(d => {
        if (!this._field) return { ...d }
        const o = {}
        Object.keys(d).forEach(key => { if (this._field[key]) o[key] = d[key] })
        return o
      })
      return { data: out }
    },
    async count() {
      return { total: DOCS.filter(d => matchDoc(d, this._where || {})).length }
    }
  }
}

const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  init() {},
  getWXContext() { return { OPENID: 'me' } },
  database() {
    return {
      command: { gte: v => cond('gte', v), lte: v => cond('lte', v) },
      collection() { return freshQuery() }
    }
  }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeSdk
  return origLoad.apply(this, arguments)
}

const fn = require(CLOUD_FN)

let failed = 0
function assert(ok, msg) {
  if (ok) console.log('  ✅ ' + msg)
  else { console.log('  ❌ ' + msg); failed++ }
}

// 与云函数 round2 同义（四舍五入到分），但这里独立写一份：
// 用被测对象的实现来验算被测对象，等于没验。
const round2 = v => Math.round(v * 100) / 100

;(async () => {
  console.log('\n=== 1) action: indexData ===')
  const idx = await fn.main({ action: 'indexData' })
  assert(idx.code === 0, 'code === 0')
  const ms = idx.data.monthSummary
  assert(ms.income === expectMonthIncome, `本月收入 == ${expectMonthIncome}（实际 ${ms.income}）`)
  assert(ms.expense === expectMonthExpense, `本月支出 == ${expectMonthExpense}（实际 ${ms.expense}）`)
  assert(Math.abs(ms.balance - (expectMonthIncome - expectMonthExpense)) < 1e-6, '本月结余一致')

  const t = idx.data.weekTrend
  assert(t.length === 7, '7 天趋势有 7 项')
  assert(t[6].expense === 44.3, `今天支出 44.3（35.5 + 8.8）（实际 ${t[6].expense}）`)
  assert(t[5].expense === 100, `昨天支出 100（实际 ${t[5].expense}）`)
  assert(t[6].dayLabel === `${TODAY_M}/${TODAY_D}`, `最后一天标签为 ${TODAY_M}/${TODAY_D}（实际 ${t[6].dayLabel}）`)
  const maxH = Math.max(...t.map(x => Math.max(x.incomeHeight, x.expenseHeight)))
  assert(maxH === 160, `最高柱高归一化为 160（实际 ${maxH}）`)

  console.log('\n=== 2) action: stats (month) ===')
  const st = await fn.main({ action: 'stats', period: 'month' })
  assert(st.code === 0, 'code === 0')
  assert(st.data.summary.income === expectMonthIncome, `汇总收入一致（${st.data.summary.income}）`)
  assert(st.data.summary.expense === expectMonthExpense, `汇总支出一致（${st.data.summary.expense}）`)
  const catSum = st.data.categories.reduce((s, c) => s + c.amount, 0)
  assert(Math.abs(catSum - expectMonthExpense) < 1e-6, `分类金额之和 == 总支出（${catSum}）`)
  const pctSum = st.data.categories.reduce((s, c) => s + c.percent, 0)
  assert(Math.abs(pctSum - 100) <= 1, `分类占比之和 ≈ 100（${pctSum}）`)
  assert(st.data.categories[0].id === 'food', `支出最大分类是餐饮（实际 ${st.data.categories[0].id}）`)
  // 展示色板以服务端 CATEGORY_META 为准：种子数据里 food 存的是旧色 #FF6B6B，
  // 返回值必须是新色板颜色，这样改色板后老数据不用清库重导也能显示正确。
  assert(st.data.categories[0].color === '#F97316',
    `旧数据自动套用新色板（存 #FF6B6B → 返回 ${st.data.categories[0].color}）`)
  assert(st.data.categories[0].name === '餐饮' && st.data.categories[0].icon === '🍜',
    `分类名称/图标由服务端元数据提供（${st.data.categories[0].name} ${st.data.categories[0].icon}）`)
  const housing = st.data.categories.find(c => c.id === 'housing')
  if (housing) {
    assert(housing.color === '#F59E0B', `housing 旧浅色 #FFEAA7 → ${housing.color}（白底可见）`)
  }
  // 兜底防线：返回的颜色里不能出现任何旧色板的浅色（白底卡片上几乎看不见）
  const BAD_COLORS = ['#FFEAA7', '#F7DC6F', '#98D8C8', '#FF6B6B', '#4ECDC4', '#45B7D1']
  const leaked = st.data.categories.filter(c => BAD_COLORS.indexOf(c.color) >= 0)
  assert(leaked.length === 0, `没有任何分类泄漏旧浅色（${leaked.map(c => c.id + ':' + c.color).join(',') || '干净'}）`)
  const missingColor = st.data.categories.filter(c => !c.color)
  assert(missingColor.length === 0, '每个分类都有颜色（图表不会画出空白扇区）')
  assert(st.data.monthlyTrend.length === 6, '趋势有 6 个月')
  assert(st.data.monthlyTrend[5].expense === expectMonthExpense, '趋势最后一个月 == 本月支出')
  assert(st.data.monthlyTrend[5].month === `${TODAY_M}月`, `趋势最后一格是 ${TODAY_M}月`)
  console.log('  分类明细:', st.data.categories.map(c => `${c.name} ¥${c.amount} (${c.percent}%)`).join(' | '))

  // ---------- 日均收支 ----------
  // 分母用「独立算法」验算，而不是把云函数的公式抄一遍（抄一遍等于没测）：
  //   本月 1 号 → 今天的天数，就是今天的「日期数」本身。
  const monthDays = new Date(Date.UTC(TODAY_Y, TODAY_M - 1, TODAY_D)).getUTCDate()
  assert(st.data.days === monthDays, `本月已过天数 == 今天的日期数 ${monthDays}（实际 ${st.data.days}）`)
  assert(st.data.dailyAvg && typeof st.data.dailyAvg.income === 'number',
    '返回了 dailyAvg.income')
  assert(st.data.dailyAvg.expense === round2(st.data.summary.expense / monthDays),
    `日均支出 == 总支出 ÷ ${monthDays}（${st.data.dailyAvg.expense}）`)
  // 反向核对：用户拿界面上的两个数字自己相乘，必须能还原总额
  const backExpense = Math.abs(st.data.dailyAvg.expense * monthDays - st.data.summary.expense)
  assert(backExpense <= 0.01 * monthDays + 1e-6,
    `日均支出 × 天数 能还原总支出（误差 ${backExpense.toFixed(4)}，只允许四舍五入的累积误差）`)
  const backIncome = Math.abs(st.data.dailyAvg.income * monthDays - st.data.summary.income)
  assert(backIncome <= 0.01 * monthDays + 1e-6, '日均收入 × 天数 能还原总收入')
  // 无记录时不能出现 NaN / Infinity（0 ÷ 16 必须还是 0）
  assert(Number.isFinite(st.data.dailyAvg.income) && Number.isFinite(st.data.dailyAvg.expense),
    '日均不出现 NaN / Infinity')

  console.log('\n=== 3) action: stats (year) ===')
  const stY = await fn.main({ action: 'stats', period: 'year' })
  const yearBills = DOCS.filter(d => d.createTime >= bjTs(TODAY_Y, 1, 1))
  const expY = yearBills.filter(d => d.type === 'expense').reduce((s, d) => s + d.amount, 0)
  assert(stY.data.summary.expense === expY, `本年支出 == ${expY}（实际 ${stY.data.summary.expense}）`)
  // 独立算法：直接用 UTC 日历算「今年第几天」，不复用云函数的 bjTime/startOfDay
  const yearDays = Math.floor(
    (Date.UTC(TODAY_Y, TODAY_M - 1, TODAY_D) - Date.UTC(TODAY_Y, 0, 1)) / DAY
  ) + 1
  assert(stY.data.days === yearDays, `本年已过天数 == 今年第 ${yearDays} 天（实际 ${stY.data.days}）`)
  assert(stY.data.dailyAvg.expense === round2(expY / yearDays), '本年日均支出 == 本年支出 ÷ 已过天数')

  console.log('\n=== 4) action: stats (week) ===')
  const stW = await fn.main({ action: 'stats', period: 'week' })
  assert(stW.code === 0 && Array.isArray(stW.data.monthlyTrend), '本周查询可用')
  // 周一是本周第 1 天：周日的 getUTCDay() 是 0，但它在本周里排第 7 天
  const weekDays = ((nowP.getUTCDay() + 6) % 7) + 1
  assert(stW.data.days === weekDays, `本周已过天数 == 周一起算的第 ${weekDays} 天（实际 ${stW.data.days}）`)
  assert(stW.data.days >= 1 && stW.data.days <= 7, '本周天数落在 1~7 之间（周内不可能超过 7 天）')

  console.log('\n=== 5) action: bills 分页 ===')
  const b1 = await fn.main({ action: 'bills', period: 'month', page: 0, pageSize: 2 })
  assert(b1.code === 0, 'code === 0')
  assert(b1.data.total === monthBills.length, `总笔数精确 == ${monthBills.length}（实际 ${b1.data.total}）`)
  assert(b1.data.bills.length === 2, '第 1 页返回 2 条')
  assert(b1.data.hasMore === true, 'hasMore = true')
  assert(b1.data.totalIncome === expectMonthIncome, '整月收入合计精确（不只看已加载页）')
  assert(b1.data.totalExpense === expectMonthExpense, '整月支出合计精确（不只看已加载页）')
  const lastPage = Math.max(0, Math.ceil(monthBills.length / 2) - 1)
  const b2 = await fn.main({ action: 'bills', period: 'month', page: lastPage, pageSize: 2 })
  assert(b2.data.hasMore === false, '末页 hasMore = false')
  assert(b2.data.bills.length === monthBills.length - lastPage * 2, '末页条数正确')

  // ⚠️ 收支合计只在第 0 页算 —— 它要分页取回该筛选条件下的**全部**金额字段，
  //    是这个函数里最贵的一步（翻到第 10 页就等于全表扫 10 遍，导出 20 页就是 20 遍）。
  //    后页必须返回 null 而不是 0：前端靠「null 就保留第 0 页的值」决定要不要覆盖，
  //    若后页给 0，翻一次页就会把「共 4 笔 / 收入 12000 / 支出 144.3」冲成 0，汇总条整块消失。
  assert(b2.data.totalIncome === null && b2.data.totalExpense === null,
    `后页的收支合计为 null（实际 income=${b2.data.totalIncome} / expense=${b2.data.totalExpense}）`)
  // 但 total（笔数）每一页都给：count() 不返回文档、代价很小，而且它是 hasMore 的**精确**依据。
  // 换成「这一页有没有装满」去推会不准 —— 总数刚好整除时会多请求一次空页。
  assert(b2.data.total === monthBills.length,
    `后页仍返回精确总笔数 == ${monthBills.length}（实际 ${b2.data.total}）`)

  // 倒序校验
  assert(b1.data.bills[0].createTime >= b1.data.bills[1].createTime, '按时间倒序返回')

  console.log('\n=== 6) action: bills 类型筛选 ===')
  const bIn = await fn.main({ action: 'bills', period: 'month', type: 'income' })
  const expIncomeCount = monthBills.filter(d => d.type === 'income').length
  assert(bIn.data.total === expIncomeCount, `只看收入时总笔数 == ${expIncomeCount}`)
  assert(bIn.data.totalExpense === 0, '只看收入时支出合计为 0')
  assert(bIn.data.bills.every(d => d.type === 'income'), '返回记录都是收入')

  console.log('\n=== 7) action: bills 分类筛选 ===')
  const bCat = await fn.main({ action: 'bills', period: 'month', categoryId: 'food' })
  const expFood = monthBills.filter(d => d.categoryId === 'food')
  assert(bCat.data.total === expFood.length, `只看餐饮时总笔数 == ${expFood.length}`)
  assert(bCat.data.bills.every(d => d.categoryId === 'food'), '返回记录都是餐饮')

  console.log('\n=== 8) 时区边界 ===')
  assert(ms.income >= 12000, '月初 00:10 的收入计入本月（未被 8 小时时差挤出）')
  assert(t[6].expense === 44.3, '当日 00:30 的支出计入今天')

  console.log('\n=== 9) action: bills (period = all) ===')
  const bAll = await fn.main({ action: 'bills', period: 'all', pageSize: 100 })
  assert(bAll.code === 0, 'code === 0')
  assert(bAll.data.total === DOCS.length, `全量总笔数 == ${DOCS.length}（实际 ${bAll.data.total}）`)
  assert(bAll.data.bills.length === DOCS.length, '一次取回全部记录')
  assert(bAll.data.hasMore === false, 'hasMore = false')
  const allInc = DOCS.filter(d => d.type === 'income').reduce((s, d) => s + d.amount, 0)
  assert(bAll.data.totalIncome === allInc, `全量收入合计 == ${allInc}`)

  console.log('\n=== 10) action: profile ===')
  const pf = await fn.main({ action: 'profile' })
  assert(pf.code === 0, 'code === 0')
  assert(pf.data.totalBills === DOCS.length, `总笔数 == ${DOCS.length}（实际 ${pf.data.totalBills}）`)
  const sortedTs = DOCS.map(d => d.createTime).sort((a, b) => a - b)
  assert(pf.data.firstTime === sortedTs[0], 'firstTime 正确')
  assert(pf.data.lastTime === sortedTs[sortedTs.length - 1], 'lastTime 正确')
  assert(pf.data.totalDays >= 1, `记账天数 >= 1（实际 ${pf.data.totalDays}）`)

  console.log('\n=== 11) 空数据边界 ===')
  DOCS.length = 0
  const emptyIdx = await fn.main({ action: 'indexData' })
  assert(emptyIdx.code === 0 && emptyIdx.data.monthSummary.income === 0, '无数据时首页汇总为 0')
  assert(emptyIdx.data.weekTrend.every(x => x.incomeHeight === 0 && x.expenseHeight === 0), '无数据时柱高全为 0（不出现除零 NaN）')
  const emptyStats = await fn.main({ action: 'stats', period: 'month' })
  assert(emptyStats.code === 0 && emptyStats.data.categories.length === 0, '无数据时分类为空数组')
  assert(emptyStats.data.monthlyTrend.length === 6, '无数据时趋势仍有 6 个月格子')
  // 空库也要有天数与日均（值为 0），否则前端整块不显示、用户会以为功能没做
  assert(emptyStats.data.days === TODAY_D, `无数据时天数照常给出（${emptyStats.data.days}）`)
  assert(emptyStats.data.dailyAvg.expense === 0 && emptyStats.data.dailyAvg.income === 0,
    '无数据时日均收支为 0（不是 null / NaN）')

  // period='all' 的区间起点是 1970，按自然天数算毫无意义 → 明确返回 days=0 / dailyAvg=null，
  // 前端据此隐藏整块，而不是显示「已过 20000 天」
  const allStats = await fn.main({ action: 'stats', period: 'all' })
  assert(allStats.code === 0 && allStats.data.days === 0 && allStats.data.dailyAvg === null,
    'period=all 时不硬凑天数（days=0 / dailyAvg=null）')
  const emptyPf = await fn.main({ action: 'profile' })
  assert(emptyPf.data.totalBills === 0 && emptyPf.data.totalDays === 0, '无数据时个人页统计为 0')
  const emptyBills = await fn.main({ action: 'bills', period: 'month' })
  assert(emptyBills.data.total === 0 && emptyBills.data.hasMore === false, '无数据时账单页 total=0 / hasMore=false')

  // ==================== 快捷记账：高频组合 ====================
  // 首页半屏面板的 chips 由这里聚合而来。守三件事：
  //   ① 只挑「出现≥2次」的（只出现一次的不是"常记的"）
  //   ② 金额取**最近一次**而不是平均（咖啡涨价后就该记涨后的价）
  //   ③ 跨用户隔离（别人的高频不能出现在我的面板里）
  console.log('\n=== 快捷记账：高频组合（quickPicks）===')
  {
    DOCS.length = 0
    const q = (title, amount, type, dayOffset, product) => {
      seq++
      DOCS.push({
        _id: 'q' + seq, _openid: 'me',
        createTime: todayStart - dayOffset * DAY,
        amount, type, title, product: product || '', categoryId: 'food'
      })
    }

    // 瑞幸 4 次，金额从 12 涨到 15（最近一次 15）
    q('瑞幸咖啡', 12, 'expense', 30)
    q('瑞幸咖啡', 13, 'expense', 20)
    q('瑞幸咖啡', 15, 'expense', 5)
    q('瑞幸咖啡', 15, 'expense', 1)
    // 地铁 3 次
    q('地铁', 3, 'expense', 10)
    q('地铁', 3, 'expense', 8)
    q('地铁', 3, 'expense', 2)
    // 只出现 1 次 → 不该进 chips
    q('一次性消费', 999, 'expense', 3)
    // 收入单独成组
    q('工资', 10000, 'income', 25)
    q('工资', 10000, 'income', 5)
    // 没有对方名 → 无法归组，不该进 chips
    q('', 50, 'expense', 2)

    const r = await fn.main({ action: 'quickPicks' })
    const picks = (r.data && r.data.picks) || []
    const titles = picks.map(p => p.title)

    assert(r.code === 0, 'quickPicks 返回成功')
    assert(titles.length === 3, `只保留出现 ≥2 次的（实际 ${titles.length} 个：${titles.join('/')}）`)
    assert(picks[0] && picks[0].title === '瑞幸咖啡' && picks[0].count === 4,
      `次数最多的排第一（${picks[0] && picks[0].title} × ${picks[0] && picks[0].count}）`)
    assert(picks[0] && picks[0].amount === 15, `金额取最近一次而非平均（实际 ${picks[0] && picks[0].amount}）`)
    assert(titles.indexOf('一次性消费') === -1, '只出现一次的不进 chips')
    assert(titles.indexOf('') === -1, '没有对方名的不进 chips（无法归组）')
    assert(picks.some(p => p.title === '工资' && p.type === 'income'), '收入单独成组（不与支出同名合并）')
    assert(picks.length <= 6, '最多 6 个')

    // 跨用户隔离
    DOCS.push({ _id: 'qx1', _openid: 'other', createTime: todayStart, amount: 9, type: 'expense', title: '别人的高频', product: '' })
    DOCS.push({ _id: 'qx2', _openid: 'other', createTime: todayStart, amount: 9, type: 'expense', title: '别人的高频', product: '' })
    const r2 = await fn.main({ action: 'quickPicks' })
    assert(((r2.data && r2.data.picks) || []).map(p => p.title).indexOf('别人的高频') === -1,
      '别人的账单不参与我的高频组合')

    // 空账本
    DOCS.length = 0
    const r3 = await fn.main({ action: 'quickPicks' })
    assert(r3.code === 0 && ((r3.data && r3.data.picks) || []).length === 0,
      '没有账单时返回空数组（不报错、不给假数据）')
  }

  console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(e => { console.error(e); process.exit(1) })
