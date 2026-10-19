// 云函数入口文件 - 统计分析
//
// ⚠️ 为什么统计必须放云函数？
//    小程序**客户端** db.collection().get() 单次最多只能取 20 条记录，
//    直接在前端 reduce 求和会把超过 20 条的记录全部漏掉，导致金额错误。
//    云函数端单次可取 1000 条，并可分页取全量，因此聚合统一放在这里。
//
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

// 规则引擎（纯函数，放在同目录 lib/ 下才能被打包上传）
// ⚠️ 必须留在本云函数里：微信云函数不能 require 云函数目录外的文件，
//    规则引擎需要复用下面的 periodRange / fetchAll / composeBudget。
const insight = require('./lib/insight.js')

const PAGE_SIZE = 1000   // 云端单次上限
const MAX_PAGES = 20     // 最多取 2 万条，足够个人账本

// 智能分析是否要求会员（云端门控的总开关）。
// ⚠️ 当前 false：个人主体小程序无法接入微信支付（没有商户号），会员入口已临时隐藏，
//    若仍强制会员门控，AI 分析会变成"锁死且永远无法解锁"的死功能。
//    所以暂时对所有人开放。将来主体换成企业/个体户、接好支付后，把这里翻回 true 即可
//    重新启用会员门控（前端 ai 页的 locked 同步翻回 !user.isVip()；两处一起翻）。
const INSIGHT_REQUIRE_VIP = false

/**
 * 分类展示元数据（id → 名称/图标/颜色）
 *
 * ⚠️ 色板必须与 cloudfunctions/parseCSV 的 smartClassify 保持一致，
 *    云函数之间无法共享模块，只能人工同步。
 *
 * 为什么展示时用它而不是直接用账单里存的 color？
 *    账单入库时会把当时的颜色一起写进文档，改了色板之后老数据的颜色是旧的
 *    （旧色板含 #FFEAA7 / #F7DC6F 这类浅色，在白底卡片上几乎看不清）。
 *    这里以服务端色板为准，老数据不必清库重导也能拿到一致的新配色。
 */
const CATEGORY_META = {
  food: { name: '餐饮', icon: '🍜', color: '#F97316' },
  transport: { name: '交通', icon: '🚗', color: '#0EA5E9' },
  shopping: { name: '购物', icon: '🛒', color: '#8B5CF6' },
  entertainment: { name: '娱乐', icon: '🎮', color: '#EC4899' },
  housing: { name: '住房', icon: '🏠', color: '#F59E0B' },
  medical: { name: '医疗健康', icon: '💊', color: '#14B8A6' },
  education: { name: '教育', icon: '📚', color: '#6366F1' },
  communication: { name: '通讯', icon: '📱', color: '#06B6D4' },
  salary: { name: '工资', icon: '💰', color: '#E5484D' },
  bonus: { name: '奖金', icon: '🎁', color: '#F97316' },
  investment: { name: '理财收益', icon: '📈', color: '#0EA5E9' },
  parttime: { name: '兼职', icon: '💼', color: '#14B8A6' },
  red_packet: { name: '红包/转账', icon: '🧧', color: '#EC4899' },
  refund: { name: '退款', icon: '↩️', color: '#14B8A6' },
  other_income: { name: '其他收入', icon: '💵', color: '#94A3B8' },
  other_expense: { name: '其他支出', icon: '📝', color: '#CBD5E1' }
}

/**
 * 统计入口
 *
 * event.action:
 *   'indexData' — 首页：本月汇总 + 近7天趋势 + 预算进度
 *   'stats'     — 统计页：区间汇总 + 日均收支（含分母天数）+ 分类占比 + 近6个月趋势
 *   'bills'     — 账单页：按筛选条件分页取账单 + 精确的笔数/收支合计
 *   'profile'   — 个人页：总笔数 + 首末记录时间
 *   'budget'    — 预算页：本月预算进度（与 indexData 共用 composeBudget）
 *   'insight'   — 智能分析：近 30 天的规则引擎结论（每条结论带可核对的 evidence）
 *
 * @param {string} event.period 周期：'day' | 'week' | 'month' | 'year' | 'all'（stats / bills 用）
 */
exports.main = async (event) => {
  const openid = cloud.getWXContext().OPENID || ''
  const action = event.action || 'indexData'

  try {
    if (action === 'stats') {
      return await buildStatsData(openid, event.period || 'month')
    }
    if (action === 'bills') {
      return await buildBillsPage(openid, event)
    }
    if (action === 'profile') {
      return await buildProfileStats(openid)
    }
    if (action === 'budget') {
      return await buildBudgetData(openid)
    }
    if (action === 'insight') {
      // ⚠️ 会员门控在云端判（遮罩只是体验，这里才是权限）。
      //    code 用 -2 + needVip，前端据此引导去开通页，而不是当失败处理。
      //    INSIGHT_REQUIRE_VIP=false 时放开给所有人（详见该常量注释）。
      if (INSIGHT_REQUIRE_VIP) {
        const vip = await fetchVipFlag(openid)
        if (!vip) {
          return { code: -2, message: '智能分析是会员功能，开通会员后可用', data: { needVip: true } }
        }
      }
      return await buildInsightData(openid, event.days)
    }
    if (action === 'quickPicks') {
      // forceAuto：配置页需要「按账单推荐」作为候选，即使已经配置过也要拿到它
      return await buildQuickPicks(openid, !!event.forceAuto)
    }
    return await buildIndexData(openid)
  } catch (err) {
    console.error('getStatistics error:', err)
    return { code: -1, message: err.message || '统计失败', data: null }
  }
}

// ==================== 通用工具 ====================

function round2(v) {
  return Math.round((v || 0) * 100) / 100
}

// ---------- 时区处理 ----------
// 微信账单的时间是北京时间（UTC+8），而云函数运行时时区不保证是 UTC+8。
// 这里所有「天/月/年」的边界都按 UTC+8 显式计算，避免月初/日初错 8 小时。

const BJ_OFFSET = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 取某时间戳在 UTC+8 下的 年/月/日/星期
 */
function bjParts(ts) {
  const d = new Date(ts + BJ_OFFSET)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    date: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours()
  }
}

/**
 * 由 UTC+8 的 年/月/日/时/分/秒/毫秒 反推出真实时间戳
 */
function bjTime(year, month, date, hour, minute, second, ms) {
  return Date.UTC(
    year,
    month,
    date,
    hour || 0,
    minute || 0,
    second || 0,
    ms || 0
  ) - BJ_OFFSET
}

/**
 * 某时间戳所在「北京日」的 00:00:00.000
 */
function startOfDay(ts) {
  const p = bjParts(ts)
  return bjTime(p.year, p.month, p.date)
}

/**
 * 某时间戳所在「北京日」的 23:59:59.999
 */
function endOfDay(ts) {
  const p = bjParts(ts)
  return bjTime(p.year, p.month, p.date, 23, 59, 59, 999)
}

/**
 * 区间起点到「今天」共经过多少个自然日（含首尾两天）。
 * 例：本月 1 号算到 16 号 → 16 天。
 *
 * ⚠️ 日均的分母必须是「已经过去的天数」，不是整段区间的长度。
 *    月末看「本月」时若按 31 天算，分母里混进了还没到来的日子，
 *    日均会被稀释成"看起来花得很少" —— 这是智能账本类产品最常见的口径坑。
 *
 * ⚠️ 必须用 UTC+8 的「日」来相减，不能直接 (now - start) / 86400000：
 *    区间起点是 00:00:00、终点是今天 23:59:59.999，直接相除会多出一天。
 */
function countDays(startTs, nowTs) {
  // period='all' 的起点是 0（1970 年），算出来是个无意义的巨数，直接判为不可用
  if (!startTs || startTs <= 0) return 0

  const diff = Math.floor((startOfDay(nowTs) - startOfDay(startTs)) / DAY_MS) + 1
  return diff > 0 ? diff : 0
}

/**
 * 分页取全量记录（绕开单次条数限制）
 */
async function fetchAll(condition, fields) {
  const out = []

  for (let page = 0; page < MAX_PAGES; page++) {
    let query = db.collection('bills').where(condition)
    if (fields) query = query.field(fields)

    const res = await query
      .orderBy('createTime', 'asc')
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .get()

    if (!res.data || res.data.length === 0) break

    for (const doc of res.data) out.push(doc)

    if (res.data.length < PAGE_SIZE) break
  }

  return out
}

/**
 * 各周期的时间范围（按 UTC+8 计算，endTime 为今天 23:59:59.999）
 */
function periodRange(period, nowTs) {
  const p = bjParts(nowTs)

  switch (period) {
    case 'all': {
      // 全部历史（导出、个人页统计用）
      return { startTime: 0, endTime: endOfDay(nowTs) }
    }
    case 'week': {
      // 周一为一周之首
      const dow = p.weekday || 7
      const mondayTs = startOfDay(nowTs) - (dow - 1) * DAY_MS
      return { startTime: startOfDay(mondayTs), endTime: endOfDay(nowTs) }
    }
    case 'year': {
      return {
        startTime: bjTime(p.year, 0, 1),
        endTime: endOfDay(nowTs)
      }
    }
    case 'day': {
      return { startTime: startOfDay(nowTs), endTime: endOfDay(nowTs) }
    }
    case 'month':
    default: {
      return {
        startTime: bjTime(p.year, p.month, 1),
        endTime: endOfDay(nowTs)
      }
    }
  }
}

// ==================== 预算进度 ====================
//
// 这一块和「日均收支」是同一类东西：都是**派生指标**，都遵守三条铁律
//   ① 云端算（客户端按设备时间算会在时区被改过的机器上悄悄错）
//   ② 分母要显示出来（界面上写「还剩 16 天」），用户能自己核对
//   ③ 阈值只定义一处 —— 前端不复制一份超支分档规则

// 花到额度的 80% 起算「接近」。超过 100% 才是「已超」。
// ⚠️ 前端**不复制**这个阈值：两处各写一套，迟早出现「首页说安全、预算页说接近」
//    这种自相矛盾的画面，而且改了一处忘另一处不报任何错（同昵称长度那个坑）。
const BUDGET_NEAR = 0.8

// 当月头几天样本太少，此时给"月末预测"纯属噪声 ——
// 1 号买台冰箱就能推出"本月要花十万"，只会吓到用户，不如不给。
const FORECAST_MIN_DAYS = 5

/**
 * 某年某月有多少天。
 * Date.UTC(y, m+1, 0) = 下个月的第 0 天 = 这个月的最后一天，闰年自动正确。
 */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/**
 * 读用户的预算额度。
 * 返回 null = **没设过**，这与「额度花完了」是两件事：
 * 前者界面要给设置引导，后者要显示超支。混成 0 会让界面显示一条 0/0 的进度条，
 * 用户以为自己额度用尽了。
 */
async function fetchBudget(openid) {
  const res = await db.collection('users')
    .where({ _openid: openid })
    .limit(1)
    .get()

  const doc = res && res.data && res.data.length ? res.data[0] : null
  const b = doc && doc.budget
  const amount = b ? Number(b.amount) : 0

  if (!(amount > 0)) return null

  return {
    amount: Math.round(amount * 100) / 100,
    updateTime: Number(b.updateTime) || 0
  }
}

/**
 * 当前用户是否会员。
 * 与 cloudfunctions/user 的 isVipDoc 同一口径：vip.since > 0。
 * ⚠️ insight 的会员门控必须在**云端**判 —— 只做前端遮罩的话，
 *    谁用开发者工具直接调云函数就能白嫖。遮罩只是体验，这里是权限。
 */
async function fetchVipFlag(openid) {
  const res = await db.collection('users')
    .where({ _openid: openid })
    .limit(1)
    .get()

  const doc = res && res.data && res.data.length ? res.data[0] : null
  return !!(doc && doc.vip && Number(doc.vip.since) > 0)
}

/**
 * 组装预算进度。**纯函数**（不碰数据库），所以能被离线测试直接调用，
 * 也能被 indexData 复用 —— 首页已经在内存里算好了本月支出，
 * 没必要为了预算再查一遍账单。
 *
 * @param {object} budget  fetchBudget() 的结果
 * @param {number} spent   本月支出（与 monthSummary.expense **同源**，不能各算各的）
 */
function composeBudget(budget, spent, nowTs) {
  const p = bjParts(nowTs)
  const amount = budget.amount

  const daysTotal = daysInMonth(p.year, p.month)
  const daysPassed = p.date                     // 今天是本月的第几天 = 已过天数（含今天）
  // ⚠️ 剩余天数要**含今天**：今天还没过完，用户今天仍然可以花钱。
  //    8/16 于 31 天的月份 → 15 天（不含今天）会让"每天还能花"虚高一点，
  //    这个偏高会直接劝退本该正常消费的人。
  const daysLeft = daysTotal - daysPassed + 1

  const used = round2(spent)
  const remaining = round2(amount - used)
  const over = used > amount ? round2(used - amount) : 0

  // ⚠️ 分档用**真实比值**判定，不能用四舍五入后的百分比：
  //    花了 79.6% 时 usedPercent 会显示成 80，拿它去判档就会把"安全"错判成"接近"。
  const ratio = amount > 0 ? used / amount : 0
  const level = used > amount ? 'over' : (ratio >= BUDGET_NEAR ? 'near' : 'safe')

  const usedPercent = Math.round(ratio * 100)
  // 进度条宽度必须封顶：100% 以上再宽就溢出卡片了。
  // ⚠️ 这里算好再送过去，因为 **WXML 表达式不能调用函数**（没有 Math.min），
  //    页面拿到 usedPercent 只能直接塞进 style，超支时进度条就会捅出卡片外。
  const barPercent = usedPercent > 100 ? 100 : (usedPercent < 0 ? 0 : usedPercent)

  const dailyAvg = daysPassed > 0 ? round2(used / daysPassed) : 0
  // 超支时「每天还能花」是负数，没有意义 → null（界面改说"已超出，先补回来"）
  const dailyLeft = remaining > 0 ? round2(remaining / daysLeft) : null

  // 月末预测：按当前速度线性外推。它**是预测不是事实**，
  // 所以只送原始数值，界面必须写清「按目前速度」——
  // 把预测写得像已发生的事，用户会真的据此调整消费。
  const forecast = daysPassed >= FORECAST_MIN_DAYS ? round2(dailyAvg * daysTotal) : null
  const forecastOver = forecast !== null && forecast > amount ? round2(forecast - amount) : 0

  return {
    amount: amount,
    spent: used,
    remaining: remaining,
    over: over,
    usedPercent: usedPercent,
    barPercent: barPercent,
    level: level,            // 'safe' | 'near' | 'over'
    daysTotal: daysTotal,
    daysPassed: daysPassed,  // 分母（已过天数）
    daysLeft: daysLeft,      // 分母（剩余天数，含今天）
    dailyAvg: dailyAvg,
    dailyLeft: dailyLeft,
    forecast: forecast,
    forecastOver: forecastOver,
    updateTime: budget.updateTime || 0
  }
}

// ==================== 首页数据 ====================

/**
 * 首页：本月汇总（1号 ~ 今天）+ 近7天趋势
 */
async function buildIndexData(openid) {
  const nowTs = Date.now()
  const now = bjParts(nowTs)

  const monthStart = bjTime(now.year, now.month, 1)
  const monthEnd = endOfDay(nowTs)

  const weekStart = startOfDay(nowTs - 6 * DAY_MS)
  const weekEnd = endOfDay(nowTs)

  // 一次取回「本月 ∪ 近7天」范围的数据，减少往返
  const from = Math.min(monthStart, weekStart)
  const to = Math.max(monthEnd, weekEnd)

  // 预算额度与账单**并行**取，不额外增加一次往返延迟。
  // 注意下面的预算进度复用已算好的 expense，不另查一遍账单 ——
  // 两处各查各的，迟早出现「概览说花了 1200、预算卡说花了 1180」。
  const [records, budget] = await Promise.all([
    fetchAll(
      { _openid: openid, createTime: _.gte(from).and(_.lte(to)) },
      { amount: true, type: true, createTime: true }
    ),
    fetchBudget(openid)
  ])

  // ---- 本月汇总 ----
  let income = 0
  let expense = 0

  records.forEach(r => {
    if (r.createTime < monthStart || r.createTime > monthEnd) return
    if (r.type === 'income') income += r.amount || 0
    else if (r.type === 'expense') expense += r.amount || 0
  })

  // ---- 近7天趋势 ----
  const trend = []

  for (let i = 6; i >= 0; i--) {
    const dayTs = nowTs - i * DAY_MS
    const dp = bjParts(dayTs)
    const s = startOfDay(dayTs)
    const e = endOfDay(dayTs)

    let di = 0
    let de = 0

    records.forEach(r => {
      if (r.createTime < s || r.createTime > e) return
      if (r.type === 'income') di += r.amount || 0
      else if (r.type === 'expense') de += r.amount || 0
    })

    trend.push({
      day: dp.date,
      dayLabel: `${dp.month + 1}/${dp.date}`,
      date: `${dp.year}-${dp.month + 1}-${dp.date}`,
      income: round2(di),
      expense: round2(de)
    })
  }

  // ---- 归一化柱高（最大值为 0 时全部为 0，避免除零）----
  const CHART_HEIGHT = 160   // rpx
  const MIN_HEIGHT = 8       // 有数据时的最小可见高度

  let maxVal = 0
  trend.forEach(t => {
    maxVal = Math.max(maxVal, t.income, t.expense)
  })

  trend.forEach(t => {
    if (maxVal > 0) {
      t.incomeHeight = t.income > 0 ? Math.max(Math.round(t.income / maxVal * CHART_HEIGHT), MIN_HEIGHT) : 0
      t.expenseHeight = t.expense > 0 ? Math.max(Math.round(t.expense / maxVal * CHART_HEIGHT), MIN_HEIGHT) : 0
    } else {
      t.incomeHeight = 0
      t.expenseHeight = 0
    }
  })

  return {
    code: 0,
    data: {
      monthSummary: {
        income: round2(income),
        expense: round2(expense),
        balance: round2(income - expense),
        range: { start: monthStart, end: monthEnd }
      },
      // 未设过预算是 null（不是 0）—— 界面据此显示设置引导而不是空进度条。
      // 这里的 spent 与上面的 monthSummary.expense 是**同一个数**，不会两个卡对不上。
      budget: budget ? composeBudget(budget, expense, nowTs) : null,
      weekTrend: trend,
      scanned: records.length
    }
  }
}

// ==================== 预算页数据 ====================

/**
 * 预算页：本月预算进度。
 *
 * 与首页的 indexData 走**同一个 composeBudget** —— 两个页面显示的进度必须一模一样，
 * 各算一遍必然出现"首页说还剩 300、预算页说还剩 280"这种没法解释的差异。
 */
async function buildBudgetData(openid) {
  const nowTs = Date.now()
  const budget = await fetchBudget(openid)

  // 没设过预算：如实返回 null，让界面走空状态。
  // ⚠️ 不要在这里"贴心地"返回一个 amount=0 的进度对象：
  //    那会渲染出一条 0/0 的进度条，看起来像"额度已经用完"，用户会以为坏了。
  if (!budget) {
    return { code: 0, data: { budget: null } }
  }

  const p = bjParts(nowTs)
  const records = await fetchAll(
    {
      _openid: openid,
      createTime: _.gte(bjTime(p.year, p.month, 1)).and(_.lte(endOfDay(nowTs)))
    },
    { amount: true, type: true }
  )

  let spent = 0
  records.forEach(r => {
    if (r.type === 'expense') spent += r.amount || 0
  })

  return { code: 0, data: { budget: composeBudget(budget, spent, nowTs) } }
}

// ==================== 智能分析（规则引擎） ===================
//
// ⚠️ 为什么放在 getStatistics 而不是新建 aiAnalyze 云函数？
//    微信云函数**不能 require 云函数目录外的文件**，所以规则引擎没法和 getStatistics
//    共享 periodRange / fetchAll / composeBudget。复制一份等于埋一个必炸的雷：
//    两处的"天数""预算口径"迟早漂移，界面就会出现两个互相矛盾的数字。
//    放在同一个云函数里共用这些纯函数，是唯一能保证「同源」的做法。
//    （将来接大模型时再加 aiAnalyze，让它只负责"写文案"，
//      数字仍然由本 action 的摘要提供 —— 这样也不需要跨目录复用代码。）

// 分析窗口支持 7 天 / 30 天两档，默认 30 天：够看出习惯，又不会跨月导致「上期」被截断
const INSIGHT_DAYS = 30
const INSIGHT_SCOPES = [7, 30]

// ==================== 首页快捷记账：高频组合 ====================

// 扫最近 90 天：够覆盖"常买的东西"，又不会把一年前的旧习惯翻出来
const QUICK_PICK_DAYS = 90
// 面板里最多放 10 个 chip（用户可在「我的 → 常记的」里自己配）
const QUICK_PICK_LIMIT = 10

/**
 * 读用户手动配置的「常记的」。
 *
 * 三态（与 user 云函数 publicProfile 的约定一致）：
 *   - 字段不存在 → null，表示「没配置过」→ 回退到按账单自动推荐
 *   - []         → 用户主动清空了 → 就返回空，**不再推荐**
 *     （用户费劲删完又被推荐回来，只会以为删不掉）
 *   - 有内容     → 原样用（顺序就是用户在配置页拖出来的顺序）
 *
 * @returns {Array|null}
 */
async function fetchUserPicks(openid) {
  const res = await db.collection('users')
    .where({ _openid: openid })
    .limit(1)
    .get()

  const doc = res && res.data && res.data.length ? res.data[0] : null
  const raw = doc && doc.quickPicks
  if (!Array.isArray(raw)) return null

  // 只保留画 chip 需要的字段，不把 users 文档里的其它东西带出去
  return raw.slice(0, QUICK_PICK_LIMIT).map(x => ({
    title: String((x && x.title) || ''),
    type: (x && x.type) === 'income' ? 'income' : 'expense',
    amount: Number((x && x.amount)) || 0,
    product: String((x && x.product) || ''),
    categoryId: String((x && x.categoryId) || ''),
    count: 0          // 手动配置的没有"出现次数"这个概念，置 0 由前端决定怎么展示
  }))
}

/**
 * 挑出「常记的那几笔」，供首页快捷记账面板一键复用。
 *
 * ⚠️ 优先用**用户手动配置**的列表；没配置过才按账单自动推荐。
 *    两者都不该返回敏感字段（只有对方/金额/分类），面板是要展示给用户点选的。
 *
 * 自动推荐的口径：按「交易对方 + 收/支」分组，只留出现 ≥2 次的；
 * 每组的金额取**最近一次**的值 —— 点 chip 就是"照上次那样再记一笔"，
 * 金额取最近一次比取平均值更符合直觉（咖啡涨价了，就该记涨后的价）。
 *
 * ⚠️ 必须在云端聚合：客户端 db.collection().get() 单次最多 20 条，
 *    根本统计不出"高频"。
 *
 * @returns {Object} { code, data: { picks, source } }
 *   source: 'user'（用户配置）| 'auto'（按账单推荐）
 */
async function buildQuickPicks(openid, forceAuto) {
  const userPicks = forceAuto ? null : await fetchUserPicks(openid)
  if (userPicks !== null) {
    return { code: 0, data: { picks: userPicks, source: 'user' } }
  }

  const nowTs = Date.now()
  const from = startOfDay(nowTs) - (QUICK_PICK_DAYS - 1) * DAY_MS

  const records = await fetchAll(
    { _openid: openid, createTime: _.gte(from).and(_.lte(endOfDay(nowTs))) },
    { amount: true, type: true, createTime: true, title: true, product: true, categoryId: true }
  )

  const groups = {}
  for (const r of records) {
    const title = String(r.title || '').trim()
    if (!title) continue          // 没有对方名的（部分手动记账没填）无法归组
    const key = (r.type === 'income' ? 'income' : 'expense') + '|' + title
    if (!groups[key]) {
      groups[key] = { title, type: r.type === 'income' ? 'income' : 'expense', count: 0, last: r }
    }
    groups[key].count++
    // fetchAll 按 createTime 升序（旧→新），越靠后越新
    if ((r.createTime || 0) >= (groups[key].last.createTime || 0)) groups[key].last = r
  }

  const picks = Object.keys(groups)
    .map(k => groups[k])
    .filter(g => g.count >= 2)                    // 只出现一次的不算"高频"
    .sort((a, b) => (b.count - a.count) || ((b.last.createTime || 0) - (a.last.createTime || 0)))
    .slice(0, QUICK_PICK_LIMIT)
    .map(g => ({
      title: g.title,
      type: g.type,
      amount: Number(g.last.amount) || 0,
      product: g.last.product || '',
      categoryId: g.last.categoryId || '',
      count: g.count
    }))

  return { code: 0, data: { picks, source: 'auto' }, scanned: records.length }
}

async function buildInsightData(openid, requestedDays) {
  const days = INSIGHT_SCOPES.indexOf(Number(requestedDays)) !== -1 ? Number(requestedDays) : INSIGHT_DAYS
  const nowTs = Date.now()
  const now = bjParts(nowTs)
  const todayStart = startOfDay(nowTs)

  const monthStart = bjTime(now.year, now.month, 1)

  // 本期：今天往前 days 天（含今天）
  const curStart = todayStart - (days - 1) * DAY_MS
  const curEnd = endOfDay(nowTs)
  // 上期：紧邻的再前 days 天（与本期等长，这样日均可以直接比）
  const prevStart = curStart - days * DAY_MS
  const prevEnd = curStart - 1

  // ⚠️ 取数起点用 prevStart 就够，它**一定**早于「本月 1 号」：
  //    今天 10/31 时本期从 10/2 起、上期从 9/2 起，prevStart ≤ monthStart 恒成立
  //    （今天越靠近月初，prevStart 落得越早）。
  //    所以「本月 1 号那笔账单」必然在取数范围内 —— 而预算是按**本月**算的，
  //    少取这一段会让预算进度平白少算一笔，且没有任何报错。
  const from = prevStart

  const [records, budget] = await Promise.all([
    fetchAll(
      { _openid: openid, createTime: _.gte(from).and(_.lte(curEnd)) },
      { amount: true, type: true, createTime: true, title: true, category: true, categoryId: true }
    ),
    fetchBudget(openid)
  ])

  // ---- 先按日历把周末 / 工作日的天数点出来（与有没有账单无关）----
  let weekendDays = 0
  let weekdayDays = 0
  for (let i = 0; i < days; i++) {
    const dow = bjParts(todayStart - i * DAY_MS).weekday
    if (dow === 0 || dow === 6) weekendDays++
    else weekdayDays++
  }

  // ---- 逐笔归类 ----
  let curTotal = 0
  let curCount = 0
  let prevTotal = 0
  let prevCount = 0
  let monthExpense = 0
  let weekendTotal = 0
  let weekdayTotal = 0
  let smallCount = 0
  let smallAmount = 0
  let lastExpenseTs = 0

  // 深夜消费（23:00 ~ 凌晨 05:00）
  let nightAmount = 0
  let nightCount = 0
  // 单笔大额：按「月均支出」判，逐笔算月均支出，再筛大额
  const catMap = {}
  const merchantMap = {}
  const largeCatMap = {}   // 大额支出按类目聚合，用于「主要集中在[类别]」

  records.forEach(r => {
    if (r.type !== 'expense') return

    const amt = Number(r.amount) || 0
    const t = r.createTime || 0

    if (t >= monthStart && t <= curEnd) monthExpense += amt

    const inCur = t >= curStart && t <= curEnd
    if (!inCur) {
      prevTotal += amt
      prevCount++
      return
    }

    curTotal += amt
    curCount++

    // 周末 / 工作日：getUTCDay() 的 0 是周日、6 是周六
    const dow = bjParts(t).weekday
    if (dow === 0 || dow === 6) weekendTotal += amt
    else weekdayTotal += amt

    if (!lastExpenseTs || t > lastExpenseTs) lastExpenseTs = t

    // 深夜消费：UTC+8 的小时在 23 点之后，或凌晨 5 点之前
    const hour = bjParts(t).hour
    if (hour >= insight.TH.NIGHT_START || hour < insight.TH.NIGHT_END) {
      nightAmount += amt
      nightCount++
    }

    if (amt > 0 && amt <= insight.TH.SMALL_AMOUNT) {
      smallCount++
      smallAmount += amt
    }

    // 类目
    const cid = r.categoryId || 'other_expense'
    if (!catMap[cid]) {
      const meta = CATEGORY_META[cid] || {}
      catMap[cid] = {
        id: cid,
        name: meta.name || r.category || '其他支出',
        amount: 0,
        count: 0
      }
    }
    catMap[cid].amount += amt
    catMap[cid].count++

    // 商户（账单里的 title 就是交易对方）
    const title = (r.title || '').trim() || '未标注商户'
    if (!merchantMap[title]) merchantMap[title] = { title: title, amount: 0, count: 0 }
    merchantMap[title].amount += amt
    merchantMap[title].count++
  })

  const byAmount = (a, b) => b.amount - a.amount

  const categories = Object.values(catMap)
    .map(c => ({ ...c, amount: round2(c.amount) }))
    .sort(byAmount)

  const merchants = Object.values(merchantMap)
    .map(m => ({ ...m, amount: round2(m.amount) }))
    .sort(byAmount)

  // ---- 单笔大额：月均支出 = 日均 × 30，阈值 = max(月均 × 20%, ¥500) ----
  // ⚠️ 必须在本期记录全部归集完（curTotal 定型）之后才能判，所以单独再扫一遍。
  //    两条标准取较高者：月均很低时 20% 可能只有几十块，需要 ¥500 绝对下限兜底，
  //    否则任何一笔都成了"大额"。
  const monthlyAvg = days > 0 ? (curTotal / days) * 30 : 0
  const largeThreshold = Math.max(monthlyAvg * insight.TH.LARGE_MONTH_AVG_MULTI, insight.TH.LARGE_MIN_ABS)
  let largeCount = 0
  let largeAmount = 0

  records.forEach(r => {
    if (r.type !== 'expense') return
    const amt = Number(r.amount) || 0
    const t = r.createTime || 0
    if (t < curStart || t > curEnd) return
    if (amt < largeThreshold) return

    largeCount++
    largeAmount += amt
    const cid = r.categoryId || 'other_expense'
    const meta = CATEGORY_META[cid] || {}
    const name = meta.name || r.category || '其他支出'
    largeCatMap[name] = (largeCatMap[name] || 0) + amt
  })

  const largeTopCategory = Object.keys(largeCatMap).length
    ? Object.keys(largeCatMap).sort((a, b) => largeCatMap[b] - largeCatMap[a])[0]
    : '—'

  // 末尾连续无支出的天数：今天往前数到「最后一次支出那天」的距离
  let daysWithoutSpend = days
  if (lastExpenseTs) {
    daysWithoutSpend = Math.floor((todayStart - startOfDay(lastExpenseTs)) / DAY_MS)
  }

  let lastExpenseDate = ''
  if (lastExpenseTs) {
    const lp = bjParts(lastExpenseTs)
    lastExpenseDate = `${lp.month + 1}月${lp.date}日`
  }

  const summary = {
    days: days,
    compareDays: days,
    total: round2(curTotal),
    count: curCount,
    categories: categories,
    merchants: merchants,
    smallFreq: { count: smallCount, amount: round2(smallAmount), limit: insight.TH.SMALL_AMOUNT },
    prev: { total: round2(prevTotal), count: prevCount, days: days },
    weekend: { days: weekendDays, total: round2(weekendTotal) },
    weekday: { days: weekdayDays, total: round2(weekdayTotal) },
    night: { amount: round2(nightAmount), count: nightCount },
    large: {
      count: largeCount,
      amount: round2(largeAmount),
      threshold: round2(largeThreshold),
      topCategory: largeTopCategory
    },
    daysWithoutSpend: daysWithoutSpend,
    lastExpenseDate: lastExpenseDate,
    // ⚠️ 复用 composeBudget，不重算 —— 与首页/预算页同一套口径与阈值。
    //    这里重写一遍的话，就会出现「首页说没超、AI 页说超了」。
    budget: budget ? composeBudget(budget, monthExpense, nowTs) : null
  }

  return {
    code: 0,
    data: {
      scope: { days: days, startTime: curStart, endTime: curEnd },
      insights: insight.buildInsights(summary),
      // 摘要一并返回，有两个用处：
      //   ① 让"每条结论都能核对"成为**可验证的事实**而不是一句承诺 ——
      //      测试拿它逐值比对结论里出现的每个金额（tests/insight-test.js 的 audit）
      //   ② 将来接大模型时，它就是送进 prompt 的那份输入，不用另拼
      summary: summary,
      meta: {
        scanned: records.length,
        hasBudget: !!budget,
        // 明确告诉前端这些结论是规则算出来的 —— 界面上要如实标注，
        // 不能让用户以为是大模型"分析"出来的。
        generatedBy: 'rule'
      }
    }
  }
}

// ==================== 账单页数据 ====================

/**
 * 账单页：按「周期 + 收支类型 + 分类」筛选，分页返回账单，
 * 并给出该筛选条件下的**精确**笔数与收支合计（前端只加载了部分页，无法自己算准）
 *
 * ⚠️ 汇总只在 page === 0 时返回，后页是 null：
 *    合计要分页取回该条件下的全部记录，是最贵的一步，而它并不会随翻页变化。
 *    前端翻页时保留第 0 页的结果即可（pages/bills/bills.js 的 loadBills）。
 */
async function buildBillsPage(openid, event) {
  const nowTs = Date.now()
  const period = event.period || 'month'
  const range = periodRange(period, nowTs)

  const type = event.type || 'all'
  const categoryId = event.categoryId || ''

  let pageSize = parseInt(event.pageSize, 10)
  if (!pageSize || pageSize < 1) pageSize = 20
  if (pageSize > 100) pageSize = 100

  let page = parseInt(event.page, 10)
  if (!page || page < 0) page = 0

  const condition = {
    _openid: openid,
    createTime: _.gte(range.startTime).and(_.lte(range.endTime))
  }
  if (type === 'income' || type === 'expense') condition.type = type
  if (categoryId) condition.categoryId = categoryId

  const coll = db.collection('bills')

  // 当前页
  const listRes = await coll
    .where(condition)
    .orderBy('createTime', 'desc')
    .skip(page * pageSize)
    .limit(pageSize)
    .get()

  const bills = listRes.data || []

  // 精确总笔数是 count()，不返回文档、代价很小，所以每一页都给 ——
  // 它同时是 hasMore 的依据。改成「这一页有没有装满」来推会不准：
  // 总数刚好是 pageSize 的整数倍时会多请求一次空页。
  const countRes = await coll.where(condition).count()
  const total = countRes.total || 0

  // ⚠️ 但「收支合计」要分页取回该筛选条件下的**全部**金额字段，是这个函数里最贵的一步。
  //    放在每次请求里做，等于「翻到第 10 页 = 全表扫 10 遍」；导出账单循环取 20 页就是 20 遍。
  //    而合计本身并不会因为翻页而改变，所以只在第 0 页算。
  //    前端在第 0 页拿到后自行保留，翻页时不再覆盖（见 pages/bills/bills.js）。
  let totalIncome = null
  let totalExpense = null

  if (page === 0) {
    const amountDocs = await fetchAll(condition, { amount: true, type: true })

    let income = 0
    let expense = 0
    amountDocs.forEach(d => {
      if (d.type === 'income') income += d.amount || 0
      else if (d.type === 'expense') expense += d.amount || 0
    })

    totalIncome = round2(income)
    totalExpense = round2(expense)
  }

  return {
    code: 0,
    data: {
      bills,
      total,
      // 后页是 null —— 前端靠它区分「这次没有汇总」，
      // 否则翻页会把第 0 页算好的收支合计覆盖成 0。
      totalIncome,
      totalExpense,
      page,
      pageSize,
      hasMore: (page + 1) * pageSize < total,
      period,
      timeRange: { startTime: range.startTime, endTime: range.endTime }
    }
  }
}


// ==================== 个人页数据 ====================

/**
 * 个人页：总笔数 + 记账天数 + 实际使用到的分类数
 *
 * 客户端 count() 在数据量大时不可靠，统一放云端。
 * 分类数必须真算 —— 之前前端写死 12，是个假数字。
 */
async function buildProfileStats(openid) {
  const coll = db.collection('bills')
  const where = { _openid: openid }

  const countRes = await coll.where(where).count()
  const totalBills = countRes.total || 0

  if (totalBills === 0) {
    return {
      code: 0,
      data: { totalBills: 0, totalDays: 0, categoryCount: 0, firstTime: 0, lastTime: 0 }
    }
  }

  // 一次分页取回全量的 createTime + categoryId，同时算出首末时间与分类集合
  const docs = await fetchAll(where, { createTime: true, categoryId: true })

  let firstTime = 0
  let lastTime = 0
  const catSet = {}

  docs.forEach(d => {
    const t = d.createTime || 0
    if (t) {
      if (!firstTime || t < firstTime) firstTime = t
      if (!lastTime || t > lastTime) lastTime = t
    }
    if (d.categoryId) catSet[d.categoryId] = 1
  })

  // 记账天数：按北京日计算，首末同一天算 1 天
  let totalDays = 0
  if (firstTime && lastTime) {
    totalDays = Math.round((startOfDay(lastTime) - startOfDay(firstTime)) / DAY_MS) + 1
  }

  return {
    code: 0,
    data: {
      totalBills,
      totalDays,
      categoryCount: Object.keys(catSet).length,
      firstTime,
      lastTime
    }
  }
}

// ==================== 统计页数据 ====================

/**
 * 统计页：区间汇总 + 日均收支 + 支出分类占比 + 近6个月趋势
 */
async function buildStatsData(openid, period) {
  const nowTs = Date.now()
  const now = bjParts(nowTs)
  const range = periodRange(period, nowTs)

  // 近 6 个月区间（含本月）
  const months = []
  for (let i = 5; i >= 0; i--) {
    const total = now.year * 12 + now.month - i
    const y = Math.floor(total / 12)
    const m = total % 12

    months.push({
      label: `${m + 1}月`,
      start: bjTime(y, m, 1),
      end: bjTime(y, m + 1, 1) - 1
    })
  }

  const trendFrom = months[0].start
  const trendTo = months[months.length - 1].end

  const from = Math.min(range.startTime, trendFrom)
  const to = Math.max(range.endTime, trendTo)

  const records = await fetchAll(
    { _openid: openid, createTime: _.gte(from).and(_.lte(to)) },
    { amount: true, type: true, createTime: true, category: true, categoryId: true, icon: true, color: true }
  )

  // ---- 当前区间汇总 + 分类聚合 ----
  let income = 0
  let expense = 0
  const catMap = {}

  records.forEach(r => {
    if (r.createTime < range.startTime || r.createTime > range.endTime) return

    if (r.type === 'income') {
      income += r.amount || 0
      return
    }
    if (r.type !== 'expense') return

    expense += r.amount || 0

    const id = r.categoryId || 'other_expense'
    if (!catMap[id]) {
      const meta = CATEGORY_META[id] || {}
      catMap[id] = {
        id,
        name: meta.name || r.category || '其他',
        icon: meta.icon || r.icon || '📝',
        color: meta.color || r.color || '#CBD5E1',
        amount: 0,
        count: 0
      }
    }
    catMap[id].amount += r.amount || 0
    catMap[id].count++
  })

  const totalExpense = expense

  const categories = Object.values(catMap)
    .map(c => ({
      ...c,
      amount: round2(c.amount),
      percent: totalExpense > 0 ? Math.round(c.amount / totalExpense * 100) : 0
    }))
    .sort((a, b) => b.amount - a.amount)

  const topCategories = categories.slice(0, 5).map(c => ({
    ...c,
    ratio: categories.length > 0 && categories[0].amount > 0
      ? Math.round(c.amount / categories[0].amount * 100)
      : 0
  }))

  // ---- 近6个月趋势 ----
  const monthlyTrend = months.map(m => {
    let mi = 0
    let me = 0

    records.forEach(r => {
      if (r.createTime < m.start || r.createTime > m.end) return
      if (r.type === 'income') mi += r.amount || 0
      else if (r.type === 'expense') me += r.amount || 0
    })

    return { month: m.label, income: round2(mi), expense: round2(me) }
  })

  // ---- 日均收支 ----
  // 分母（天数）由服务端计算，与上面的区间起止时间是同一套口径。
  // 客户端**不要**自己按设备时间算天数：设备时区/系统时间被改过时，
  // 分母会和分子的区间对不上，用户会算出「总额 ÷ 天数 ≠ 显示的日均」。
  const days = countDays(range.startTime, nowTs)
  const dailyAvg = days > 0
    ? { income: round2(income / days), expense: round2(expense / days) }
    : null

  return {
    code: 0,
    data: {
      summary: {
        income: round2(income),
        expense: round2(expense),
        balance: round2(income - expense)
      },
      // days / dailyAvg 是配套的：前端要把 days 也显示出来，
      // 用户能自己用「总支出 ÷ days」核对日均，而不是只能相信这个数字。
      days,
      dailyAvg,
      categories,
      topCategories,
      monthlyTrend,
      period,
      timeRange: { startTime: range.startTime, endTime: range.endTime },
      scanned: records.length
    }
  }
}
