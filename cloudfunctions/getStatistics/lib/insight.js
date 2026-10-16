/**
 * 规则引擎式账单分析（纯函数）
 * ===========================================================================
 * 为什么这一版不接大模型？
 *   微信官方口径：「AI 问答涉及深度合成技术，需补充【深度合成-AI 问答】服务类目；
 *   目前个人主体小程序尚未开放深度合成相关服务类目」。
 *   换句话说，个人主体做出「用户可以随便问」的 AI 功能，提审时会被要求整改（已有多个先例）。
 *
 *   规则引擎在这个场景里其实比模型更合适，有两点：
 *   ① **每个数字都是算出来的，不是模型编的** —— 与本项目「派生指标必须可核对」的铁律一致。
 *      将来真接模型时，正确做法也是云端先把数字算好（evidence），
 *      模型只写两句话，而不是让模型算完再去校验它有没有算错。
 *   ② **没触发条件就不输出**，而不是凑几条万能套话。
 *      一条真正有用的结论（「餐饮占 42%」）比五条正确但没信息量的话有价值得多。
 *
 * ⚠️ 这个文件必须保持**纯函数**：不查库、不碰 wx，只吃传进来的摘要。
 *    查库与摘要组装在 index.js 的 buildInsightData()，
 *    这样 tests/insight-test.js 能离线把每条规则都跑一遍。
 */

// ==================== 阈值（只定义这一处） ====================
//
// ⚠️ 和 BUDGET_NEAR 同一个道理：阈值散落在多个地方必然漂移，
//    而「为什么这条结论出现了」只有在这一处写得清。
//    改这里就等于改判定口径，测试会立刻反映出来。

const TH = {
  TOP_CATEGORY_RATIO: 0.35,   // 单个类目占比超过这个数才算「过度集中」
  SMALL_AMOUNT: 20,           // 「小额」的门槛（元）
  SMALL_FREQ_COUNT: 8,        // 小额笔数达到多少笔才值得单独说一句
  SMALL_FREQ_SHARE: 0.08,     // 且合计要占到总支出的这个比例
  TOP_MERCHANT_RATIO: 0.25,   // 单一商户占支出的比例
  TREND_RATIO: 0.3,           // 平均每日支出与上一个同长周期相比的涨跌幅度
  TREND_MIN_ABS: 5,           // 且日均绝对差额要超过这个数（否则报「涨了 0.3 元」没意义）
  WEEKEND_RATIO: 0.5,         // 周末日均比工作日高出的比例
  WEEKEND_MIN_ABS: 20,        // 且差额要够明显
  NO_SPEND_DAYS: 4,           // 末尾连续多少天没有支出值得提醒
  NIGHT_START: 23,            // 深夜消费：起点小时（23:00）
  NIGHT_END: 5,               // 深夜消费：终点小时（凌晨 05:00，不含 05:00）
  NIGHT_SHARE: 0.1,           // 深夜支出占比达到这个数才报
  LARGE_MIN_ABS: 500,         // 单笔大额：绝对门槛（元）
  LARGE_MONTH_AVG_MULTI: 0.2, // 单笔大额：超过月均支出的这个比例也算
  LARGE_MIN_COUNT: 1,         // 至少这么多笔才报
  MOONLIGHT_RATIO: 0.8,       // 月光：支出进度 ÷ 时间进度 达到这个数才预警
  MOONLIGHT_MIN_DAYS: 5,      // 月光：本月已过天数少于这个数时预测无意义
  MIN_COUNT: 3,               // 少于这么多笔不给结论 —— 说明不了「习惯」
  MAX_ITEMS: 6                // 最多给几条 —— 结论一多就变成噪音
}

// 展示优先级：数字小的排前面（同 level 时用）
const PRIORITY = {
  budget: 1,
  moonlight: 2,
  trend: 3,
  category: 4,
  night: 5,
  large: 6,
  smallFreq: 7,
  merchant: 8,
  weekend: 9,
  noSpend: 10,
  baseline: 11
}

const LEVEL_WEIGHT = { warn: 2, tip: 1, info: 0 }

// ==================== 基础工具 ====================

function toNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (n !== n || n === Infinity || n === -Infinity) return 0
  return n
}

function round2(v) {
  return Math.round(toNumber(v) * 100) / 100
}

/**
 * 金额 → 字符串。
 *
 * ⚠️ 缩写口径必须与 utils/format.wxs 的 amount **完全一致**：
 *    10 万才缩写成「万」、1000 万…亿同理、其余保留两位小数、不加千分位。
 *    同一个 App 里两处金额写法不同，用户会以为其中一个算错了。
 *    tests/insight-test.js 会把 wxs 源码加载进来逐值对账。
 */
function money(v) {
  const n = toNumber(v)
  const abs = Math.abs(n)

  if (abs >= 100000000) return '¥' + (n / 100000000).toFixed(2) + '亿'
  if (abs >= 100000) return '¥' + (n / 10000).toFixed(2) + '万'

  return '¥' + n.toFixed(2)
}

/** 真实比值判定用的百分数（不四舍五入） */
function ratio(part, whole) {
  const w = toNumber(whole)
  if (w <= 0) return 0
  return toNumber(part) / w
}

/** 只用于展示的整数百分比 */
function percent(part, whole) {
  return Math.round(ratio(part, whole) * 100)
}

function ratioText(part, whole) {
  return percent(part, whole) + '%'
}

function ev(label, value) {
  return { label: label, value: String(value) }
}

function make(id, level, title, detail, evidence) {
  return { id: id, level: level, title: title, detail: detail, evidence: evidence || [] }
}

// ==================== 各条规则 ====================
//
// 每条规则都是「不满足条件就返回 null」——
// 没有信息量的时候不说，比编一句「合理规划你的开支」有用得多。

/**
 * 基准：近 30 天花了多少、日均多少
 * ⚠️ 日均必须把分母（已过天数）一起给出来，用户才能自己用「总额 ÷ 天数」核对。
 *    这是本项目的老规矩，派生数字不给分母就等于只能「相信我们」。
 */
function detectBaseline(s) {
  if (!(s.total > 0)) return null

  const dailyAvg = s.days > 0 ? round2(s.total / s.days) : 0
  const perBill = s.count > 0 ? round2(s.total / s.count) : 0

  return make(
    'baseline', 'info',
    '近 ' + s.days + ' 天支出 ' + money(s.total),
    s.count > 0
      ? '平均每天 ' + money(dailyAvg) + '，共 ' + s.count + ' 笔，平均每笔 ' + money(perBill) + '。'
      : '平均每天 ' + money(dailyAvg) + '。',
    [
      ev('支出合计', money(s.total)),
      ev('日均支出', money(dailyAvg)),
      ev('已过天数', s.days + ' 天'),
      ev('记账笔数', s.count + ' 笔')
    ]
  )
}

/**
 * 预算：按当前速度，本月会不会超
 * ⚠️ 复用 getStatistics 的 composeBudget() 结果，这里**不重算**。
 *    两处各算一次预算预测，首页和 AI 页迟早给出两个数。
 */
function detectBudget(s) {
  const b = s.budget
  if (!b) return null

  if (b.level === 'over') {
    return make(
      'budget', 'warn',
      '本月已超预算 ' + money(Math.abs(b.remaining || 0)),
      '额度 ' + money(b.amount) + '，已经花掉 ' + money(b.spent) + '，还剩 ' + b.daysLeft + ' 天。',
      [
        ev('本月预算', money(b.amount)),
        ev('已花', money(b.spent)),
        ev('超出金额', money(Math.abs(b.remaining || 0))),
        ev('还剩天数', b.daysLeft + ' 天')
      ]
    )
  }

  if (b.level === 'near') {
    return make(
      'budget', 'warn',
      '预算已用掉 ' + b.usedPercent + '%',
      '额度 ' + money(b.amount) + '，已花 ' + money(b.spent) + '，还剩 ' + b.daysLeft + ' 天。',
      [
        ev('本月预算', money(b.amount)),
        ev('已花', money(b.spent)),
        ev('已用比例', b.usedPercent + '%'),
        ev('还剩天数', b.daysLeft + ' 天')
      ]
    )
  }

  // 额度内：只有在「按这个速度会超」时才值得说，否则是废话
  if (b.forecast !== null && b.forecast !== undefined && b.forecast > b.amount) {
    return make(
      'budget', 'tip',
      '按现在的花法，本月会超 ' + money(b.forecast - b.amount),
      '目前日均 ' + money(b.dailyAvg) + '，乘以本月 ' + b.daysTotal + ' 天约 ' + money(b.forecast) + '，'
        + '高于额度 ' + money(b.amount) + '。',
      [
        ev('本月预算', money(b.amount)),
        ev('预计支出', money(b.forecast)),
        ev('日均支出', money(b.dailyAvg)),
        ev('本月天数', b.daysTotal + ' 天')
      ]
    )
  }

  return null
}

/**
 * 平均每日支出涨跌：与上一个同长周期比，日均多了还是少了
 * ⚠️ 为什么用「日均」而不是「总额」比？
 *    总额比较有一个前提：两个周期都得是**满的**（比如都满 30 天）。
 *    但「近 30 天」只是记账历史长的时候才是满的 —— 用户一共只记了 40 天，
 *    「前 30 天」里有一半是空的，拿它和「近 30 天」比总额没有意义。
 *    日均（总额 ÷ 已过天数）天然把天数差异摊平了，短账龄也能比。
 * ⚠️ 两个口径都要够大才报：日均差 0.3 元、涨了 50% 也没意义，
 *    绝对差额太小报出来是制造焦虑。
 */
function detectTrend(s) {
  const prev = s.prev
  if (!prev || !(prev.total > 0)) return null
  if (!(prev.days > 0)) return null

  const cur = toNumber(s.total)
  if (!(cur > 0)) return null

  const curDays = s.days || s.compareDays || 0
  if (!(curDays > 0)) return null

  const curAvg = cur / curDays
  const prevAvg = prev.total / prev.days

  const diff = curAvg - prevAvg
  const rate = Math.abs(diff) / prevAvg

  if (rate < TH.TREND_RATIO || Math.abs(diff) < TH.TREND_MIN_ABS) return null

  const up = diff > 0
  const cmp = s.compareDays || s.days

  return make(
    'trend', up ? 'warn' : 'tip',
    '平均每天比上 ' + cmp + ' 天' + (up ? '多花 ' : '少花 ') + money(Math.abs(diff)),
    '这 ' + cmp + ' 天日均 ' + money(round2(curAvg)) + '，前 ' + cmp + ' 天日均 '
      + money(round2(prevAvg)) + '。'
      + (up ? '可以看看是哪个类目涨上来的。' : ''),
    [
      ev('本期日均', money(round2(curAvg))),
      ev('上期日均', money(round2(prevAvg))),
      ev('日均差额', (up ? '+' : '-') + money(Math.abs(diff))),
      ev('变化幅度', (up ? '+' : '-') + percent(Math.abs(diff), prevAvg) + '%')
    ]
  )
}

/**
 * 支出集中在单个类目
 * ⚠️ 需要至少两个类目才能说「是第二名的几倍」。只有一个类目时这句话没有意义。
 */
function detectCategory(s) {
  const cats = s.categories || []
  if (cats.length < 2) return null

  const top = cats[0]
  const share = ratio(top.amount, s.total)
  if (share < TH.TOP_CATEGORY_RATIO) return null

  const second = cats[1]
  const times = second.amount > 0 ? top.amount / second.amount : 0

  return make(
    'category', 'warn',
    top.name + '占了支出的 ' + Math.round(share * 100) + '%',
    '近 ' + s.days + ' 天在' + top.name + '上花了 ' + money(top.amount)
      + '，是第二名' + second.name + '（' + money(second.amount) + '）的 '
      + times.toFixed(1) + ' 倍。',
    [
      ev(top.name + '支出', money(top.amount)),
      ev('占支出比例', ratioText(top.amount, s.total)),
      ev('第二名 · ' + second.name, money(second.amount)),
      ev('记账笔数', top.count + ' 笔')
    ]
  )
}

/**
 * 小额高频：单笔都不大，但次数多
 * 这是记账人群最常见、也最容易改的一类支出 ——
 * 省它靠的是减少次数，不是砍单价。
 */
function detectSmallFreq(s) {
  const sf = s.smallFreq
  if (!sf || sf.count < TH.SMALL_FREQ_COUNT) return null

  const share = ratio(sf.amount, s.total)
  if (share < TH.SMALL_FREQ_SHARE) return null

  return make(
    'smallFreq', 'tip',
    sf.count + ' 笔小额支出，加起来 ' + money(sf.amount),
    '这些单笔都不超过 ' + money(sf.limit) + '，合计却占了支出的 '
      + Math.round(share * 100) + '%。'
      + '这一类要靠减少次数来省，不是砍单价。',
    [
      ev('小额笔数', sf.count + ' 笔'),
      ev('合计金额', money(sf.amount)),
      ev('占总支出', ratioText(sf.amount, s.total)),
      ev('单笔上限', '≤ ' + money(sf.limit))
    ]
  )
}

/**
 * 钱主要花在哪个商户
 */
function detectMerchant(s) {
  const ms = s.merchants || []
  if (!ms.length) return null

  const top = ms[0]
  const share = ratio(top.amount, s.total)
  if (share < TH.TOP_MERCHANT_RATIO) return null

  return make(
    'merchant', 'tip',
    '在「' + top.title + '」花得最多',
    '近 ' + s.days + ' 天在这里共 ' + money(top.amount) + '，'
      + '占支出的 ' + Math.round(share * 100) + '%，共 ' + top.count + ' 笔。',
    [
      ev('商户', top.title),
      ev('支出金额', money(top.amount)),
      ev('占支出比例', ratioText(top.amount, s.total)),
      ev('记账笔数', top.count + ' 笔')
    ]
  )
}

/**
 * 周末效应
 * ⚠️ 只在「周末明显更高」时说。反过来（周末花得少）没有行动含义，
 *    写出来只是凑数 —— 而且会让人以为周末消费是好事。
 */
function detectWeekend(s) {
  const we = s.weekend
  const wd = s.weekday
  if (!we || !wd || !(we.days > 0) || !(wd.days > 0)) return null

  const weAvg = we.total / we.days
  const wdAvg = wd.total / wd.days
  const diff = weAvg - wdAvg

  if (diff <= 0) return null

  const rate = diff / wdAvg
  if (rate < TH.WEEKEND_RATIO || diff < TH.WEEKEND_MIN_ABS) return null

  return make(
    'weekend', 'tip',
    '周末日均比工作日高 ' + Math.round(rate * 100) + '%',
    '周末每天平均 ' + money(round2(weAvg)) + '，工作日 ' + money(round2(wdAvg))
      + '，差 ' + money(round2(diff)) + '。',
    [
      ev('周末日均', money(round2(weAvg))),
      ev('工作日日均', money(round2(wdAvg))),
      ev('日均差额', money(round2(diff))),
      ev('周末天数', we.days + ' 天 / 工作日 ' + wd.days + ' 天')
    ]
  )
}

/**
 * 末尾连续没有支出
 * 有两种可能：真的没花钱，或者忘了记。提醒的是后者。
 */
function detectNoSpend(s) {
  const n = toNumber(s.daysWithoutSpend)
  if (n < TH.NO_SPEND_DAYS) return null

  return make(
    'noSpend', 'tip',
    '已连续 ' + n + ' 天没有支出记录',
    '如果这几天确实没花钱就没事；如果是忘了记，账单会比实际支出少。',
    [
      ev('连续无支出', n + ' 天'),
      ev('最近一次支出', s.lastExpenseDate || '—')
    ]
  )
}

/**
 * 深夜 / 冲动消费（夜间效应）
 * 统计 23:00 ~ 凌晨 05:00 的支出金额与占比。
 * ⚠️ 深夜是情绪化消费的高发期（宵夜、游戏充值、直播打赏），
 *    占比够高才值得提醒 —— 偶尔一次半夜买杯水不该被点名。
 */
function detectNight(s) {
  const night = s.night
  if (!night || !(night.count > 0)) return null

  const share = ratio(night.amount, s.total)
  if (share < TH.NIGHT_SHARE) return null

  return make(
    'night', 'tip',
    '有 ' + percent(night.amount, s.total) + '% 的支出发生在深夜',
    '深夜（23:00 ~ 05:00）往往是情绪化消费的高发期，共 ' + night.count + ' 笔消费，'
      + '共花费 ' + money(night.amount) + '。',
    [
      ev('深夜支出', money(night.amount)),
      ev('占支出比例', ratioText(night.amount, s.total)),
      ev('深夜笔数', night.count + ' 笔')
    ]
  )
}

/**
 * 单笔大额支出预警
 * 单笔金额超过「月均支出 20%」或「¥500」两者之一就算大额。
 * ⚠️ 两条标准是**或**关系（取较高者）：月均很低时 20% 可能只有几十块，
 *    需要 ¥500 这个绝对下限兜底，否则任何一笔都成了"大额"。
 *    「月均支出」由 index.js 按「日均 × 30」折算后传进来（见 summary.large）。
 */
function detectLarge(s) {
  const large = s.large
  if (!large || !(large.count > 0)) return null

  const total = toNumber(s.total)
  const share = ratio(large.amount, total)

  return make(
    'large', 'warn',
    large.count + ' 笔大额支出，占总支出的 ' + percent(large.amount, total) + '%',
    '单笔超过 ¥' + TH.LARGE_MIN_ABS + ' 或月均支出 20% 的共 ' + large.count + ' 笔，'
      + '合计 ' + money(large.amount) + '，主要集中在' + large.topCategory + '。',
    [
      ev('大额笔数', large.count + ' 笔'),
      ev('大额合计', money(large.amount)),
      ev('占支出比例', ratioText(large.amount, total)),
      ev('主要类目', large.topCategory)
    ]
  )
}

/**
 * 「月光」预警
 * 当前支出进度远超时间进度（如本月才过一半，已花掉预算 80%），
 * 按当前速度外推出"会在几号花光预算"。
 * ⚠️ 只在设了预算、且确实"进度超前"时说；月初头几天样本太少不预测。
 */
function detectMoonlight(s) {
  const b = s.budget
  if (!b) return null

  const amount = toNumber(b.amount)
  const spent = toNumber(b.spent)
  const daysTotal = b.daysTotal || 0
  const daysPassed = b.daysPassed || 0

  if (!(amount > 0) || !(spent > 0)) return null
  if (!(daysTotal > 0) || !(daysPassed > 0)) return null
  if (daysPassed < TH.MOONLIGHT_MIN_DAYS) return null

  // 支出进度 ÷ 时间进度
  const timeRatio = daysPassed / daysTotal
  const spendRatio = spent / amount
  if (timeRatio <= 0 || spendRatio <= timeRatio) return null
  if (spendRatio / timeRatio < TH.MOONLIGHT_RATIO) return null

  // 按当前速度外推：花光预算还需要多少天（从月初算起，到今天为止已过 daysPassed 天）
  const dailyAvg = spent / daysPassed
  if (!(dailyAvg > 0)) return null

  const spentOn = Math.ceil(amount / dailyAvg)
  const spentDate = spentOn > daysTotal ? daysTotal : spentOn

  return make(
    'moonlight', 'warn',
    '按当前速度，本月 ' + spentDate + ' 号就会花光预算',
    '本月已过 ' + daysPassed + ' 天（' + Math.round(timeRatio * 100) + '%），'
      + '已花掉预算的 ' + Math.round(spendRatio * 100) + '%，建议开启「节流模式」。',
    [
      ev('本月预算', money(amount)),
      ev('已花', money(spent)),
      ev('已用比例', Math.round(spendRatio * 100) + '%'),
      ev('时间进度', Math.round(timeRatio * 100) + '%'),
      ev('预计花光日期', '本月 ' + spentDate + ' 号')
    ]
  )
}

// ==================== 汇总 ====================

/**
 * 生成分析结论
 *
 * @param {object} s 摘要（由 index.js 组装，见 buildInsightData）
 * @returns {Array} 结论数组；无数据时为空数组（前端据此显示空状态）
 */
function buildInsights(s) {
  if (!s || !(s.total > 0)) return []

  // ⚠️ 笔数太少就不给结论。
  //    一两笔记录说明不了"消费习惯"，硬要从中推出「餐饮是最大开支」是过度解读 ——
  //    用户看到的是一条煞有介事的分析，而它其实只来自两笔支出。
  //    空着反而诚实：等数据攒够自然就有结论了。
  if ((s.count || 0) < TH.MIN_COUNT) return []

  const list = [
    detectBudget(s),
    detectMoonlight(s),
    detectTrend(s),
    detectCategory(s),
    detectNight(s),
    detectLarge(s),
    detectSmallFreq(s),
    detectMerchant(s),
    detectWeekend(s),
    detectNoSpend(s),
    detectBaseline(s)
  ].filter(Boolean)

  // 严重的排前面；同级按固定 priority —— 不依赖数组顺序，以后加规则也不会乱序
  list.sort((a, b) => {
    const w = (LEVEL_WEIGHT[b.level] || 0) - (LEVEL_WEIGHT[a.level] || 0)
    if (w !== 0) return w
    return (PRIORITY[a.id] || 99) - (PRIORITY[b.id] || 99)
  })

  return list.slice(0, TH.MAX_ITEMS)
}

module.exports = {
  buildInsights: buildInsights,
  money: money,
  percent: percent,
  ratio: ratio,
  toNumber: toNumber,
  round2: round2,
  TH: TH,
  PRIORITY: PRIORITY,
  LEVEL_WEIGHT: LEVEL_WEIGHT,
  // 导出单条规则，测试要能单独验证「不触发时返回 null」
  _rules: {
    detectBudget: detectBudget,
    detectMoonlight: detectMoonlight,
    detectTrend: detectTrend,
    detectCategory: detectCategory,
    detectNight: detectNight,
    detectLarge: detectLarge,
    detectSmallFreq: detectSmallFreq,
    detectMerchant: detectMerchant,
    detectWeekend: detectWeekend,
    detectNoSpend: detectNoSpend,
    detectBaseline: detectBaseline
  }
}