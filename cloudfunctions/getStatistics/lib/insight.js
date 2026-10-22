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
  OTHER_NOTICE_RATIO: 0.3,    // 「其他支出」占到这个比例时，在类目结论里额外说明一句
  MOM_MIN_DAYS: 5,            // 跨月对比：本月已过天数少于这个数时样本太薄，不给结论
  MOM_CAT_MIN_SHARE: 0.05,    // 类目月度变化：本期或上期该类目要占到当期支出的这个比例
  MOM_CAT_MIN_ABS: 50,        // 且月度差额要超过这个数（元）—— 20 → 60 不值得单列
  FIXED_MONTHS: 3,            // 固定支出：要连续出现几个月（与 index.js 的取数窗口一致）
  FIXED_TOLERANCE: 0.2,       // 固定支出：每月金额相对中位数的浮动上限
  FIXED_MIN_ABS: 30,          // 固定支出：每月金额低于这个数不值得单列
  MIN_COUNT: 3,               // 少于这么多笔不给结论 —— 说明不了「习惯」
  MAX_ITEMS: 7                // 最多给几条 —— 结论一多就变成噪音
}

// ==================== 「其他支出 / 其他收入」是兜底桶 ====================
//
// 账单里认不出类目的支出全部归到「其他支出」（import 时 categoryId 为空 → other_expense）。
// 它经常是第一大类，而且不是用户真实的消费结构 ——
// 拿它当"最大支出类目"讲结论会误导人：
//   ✗ 「其他支出占了支出的 42%，是第二名餐饮的 2.1 倍」
//     这句话既不可核对（"其他"里装了什么没人知道），也没有任何可行动的含义。
//
// 所以凡是**类目占比**相关的判断都先把它剔出去；
// 但账本整体金额的分母仍然是 total —— 不能为了让比例好看而缩小分母，
// 那等于虚增"餐饮占 40%"。
//
// ⚠️ 判定口径只写在这里：index.js 算「单笔大额的主要类目」时也用这个函数，
//    两处各写一套必然漂移（改了 id 忘了名字，就会出现"某天其他支出又冒出来"）。
const OTHER_CAT_IDS = { other_expense: true, other_income: true }
const OTHER_CAT_NAMES = { '其他支出': true, '其他收入': true, '其他': true }

/** 这个类目是不是「其他」兜底桶（按 id 或展示名判断） */
function isOtherCatName(name) {
  return !!OTHER_CAT_NAMES[String(name || '').trim()]
}

function isOtherCat(c) {
  if (!c) return true
  if (OTHER_CAT_IDS[c.id]) return true
  return isOtherCatName(c.name)
}

/**
 * 把类目拆成「认得出的」和「其他」两堆。
 * @returns {{ real: Array, other: Array }}
 */
function splitCats(cats) {
  const list = Array.isArray(cats) ? cats : []
  return {
    real: list.filter(c => !isOtherCat(c)),
    other: list.filter(c => isOtherCat(c))
  }
}

// 展示优先级：数字小的排前面（同 level 时用）
//
// ⚠️ 月度视角的三条（mom / catMom / fixed）刻意排在同族的前面：
//    它们和 trend / category 讲的是**同一件事的另一个窗口**，
//    一旦被 MAX_ITEMS 截断，先被砍掉的应该是滚动窗口那条 ——
//    自然月的口径用户自己能在日历上核对，滚动 30 天反而要靠相信我们。
const PRIORITY = {
  budget: 1,
  moonlight: 2,
  mom: 3,
  trend: 4,
  category: 5,
  catMom: 6,
  fixed: 7,
  night: 8,
  large: 9,
  smallFreq: 10,
  merchant: 11,
  weekend: 12,
  noSpend: 13,
  baseline: 14
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
 * ⚠️ 需要至少两个**认得出的**类目才能说「是第二名的几倍」。
 *    只有一类时这句话没有意义；而「其他支出」不算认得出的类目（见文件开头的说明）。
 */
function detectCategory(s) {
  const split = splitCats(s.categories)
  const cats = split.real
  if (cats.length < 2) return null

  const top = cats[0]
  const share = ratio(top.amount, s.total)
  if (share < TH.TOP_CATEGORY_RATIO) return null

  const second = cats[1]
  const times = second.amount > 0 ? top.amount / second.amount : 0

  // 「其他支出」占得多时补一句：否则用户会疑惑"我明明花了更多，
  // 怎么分析里只讲到这部分" —— 说明哪个桶没被归类，比藏着更有用。
  const other = split.other.reduce((sum, c) => sum + toNumber(c.amount), 0)
  const otherNote = ratio(other, s.total) >= TH.OTHER_NOTICE_RATIO
    ? '另有 ' + money(other) + '（' + ratioText(other, s.total) + '）归在「其他支出」，'
      + '这些没能从账单里认出类别。'
    : ''

  return make(
    'category', 'warn',
    top.name + '占了支出的 ' + Math.round(share * 100) + '%',
    '近 ' + s.days + ' 天在' + top.name + '上花了 ' + money(top.amount)
      + '，是第二名' + second.name + '（' + money(second.amount) + '）的 '
      + times.toFixed(1) + ' 倍。' + otherNote,
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

  // 主要类目可能没有（大额全是「其他支出」时，index.js 不给名字）——
  // 那就别硬说一句"主要集中在—"，只讲金额。
  const topCat = large.topCategory && !isOtherCatName(large.topCategory)
    && large.topCategory !== '—'
    ? large.topCategory
    : ''

  const evidence = [
    ev('大额笔数', large.count + ' 笔'),
    ev('大额合计', money(large.amount)),
    ev('占支出比例', ratioText(large.amount, total))
  ]
  if (topCat) evidence.push(ev('主要类目', topCat))

  return make(
    'large', 'warn',
    large.count + ' 笔大额支出，占总支出的 ' + percent(large.amount, total) + '%',
    // ⚠️ 这里报的是**有效阈值**（月均 20% 与 ¥500 取高后的那个数），
    //    不能写死「¥500 或月均 20%」：月均支出高的时候门槛是 ¥960，
    //    而 ¥600 那笔根本不会被算进来 —— 文案说着 ¥500、列表里却没有，用户会以为漏算了。
    '单笔超过 ' + money(large.threshold) + ' 的共 ' + large.count + ' 笔，'
      + '合计 ' + money(large.amount)
      + (topCat ? '，主要集中在' + topCat + '。' : '。'),
    evidence
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

// ==================== 月度视角（跨月对比 / 类目变化 / 固定支出） ====================
//
// 这三条与上面那些「近 N 天滚动窗口」的规则是**两套口径**，刻意都保留：
//   · 滚动窗口回答「我最近花得比之前多吗」
//   · 自然月回答「这个月比上个月呢」—— 用户在日历上能自己核对，可验证性更好
//
// ⚠️ 但两者绝不能互相冒充：滚动 30 天的 total 与「本月至今」的 total 不是一个数，
//    文案里必须写清是哪一个窗口。写混了用户会拿两个数字互相对账，
//    然后得出「这个 App 算错了」的结论（而且他没法判断到底哪个对）。

/**
 * 跨月同期对比：本月 1 号至今 vs 上月 1 号到「同一天」
 *
 * ⚠️ 为什么必须比**同期**，不能比整月？
 *    今天 10/22，"本月"只有 22 天，而上个月是完整 31 天。
 *    22 天比 31 天必然"省了一大截" —— 这个假象在每个月 5 号之后都成立，
 *    用户会以为消费习惯变好了，直到月底才发现完全不是。
 *    所以上月的截止点取与今天相同的日号（3/31 对上 2 月时退到 2/28）。
 *
 * ⚠️ 比的是**日均**不是总额：两段天数在 3/31 那种情况下并不相等，
 *    总额比会把"少了 3 天"算成"省了钱"。天数相等时总额差 = 日均差 × 天数，
 *    两种说法等价，所以统一按日均说，另在 detail 里把总额也写出来供核对。
 */
function detectMom(s) {
  const m = s.months
  if (!m || !m.current || !m.prevSame) return null

  const cur = m.current
  const prev = m.prevSame

  const curDays = toNumber(cur.days)
  const prevDays = toNumber(prev.days)

  // 月初头几天样本太薄：1~4 号里可能只有一两笔，日均毫无意义
  if (curDays < TH.MOM_MIN_DAYS || prevDays < TH.MOM_MIN_DAYS) return null
  if (!(cur.total > 0) || !(prev.total > 0)) return null

  const curAvg = round2(cur.total / curDays)
  const prevAvg = round2(prev.total / prevDays)

  const diff = round2(curAvg - prevAvg)
  if (!(prevAvg > 0)) return null

  const rate = Math.abs(diff) / prevAvg

  // 与滚动窗口的涨跌用同一组强度阈值：都是"日均差多少才算值得说"，
  // 另立一套只会出现"同一个变化在两条规则里一个报一个不报"
  if (rate < TH.TREND_RATIO || Math.abs(diff) < TH.TREND_MIN_ABS) return null

  const up = diff > 0
  const sameLen = curDays === prevDays

  return make(
    'mom', up ? 'warn' : 'tip',
    '本月日均比上月' + (up ? '多花 ' : '少花 ') + money(Math.abs(diff)),
    '本月 1 号至今 ' + curDays + ' 天，日均 ' + money(curAvg) + '；'
      + '上月（' + prev.label + '）同期 ' + prevDays + ' 天，日均 ' + money(prevAvg) + '。'
      + (sameLen
        ? '两段天数一致，总额可以直接比：本月 ' + money(cur.total)
          + '，上月同期 ' + money(prev.total) + '。'
        : '两段天数不一致（' + prev.label + '没有这一天，按整月天数算），所以只比日均，不比总额。'),
    [
      ev('本月日均', money(curAvg)),
      ev(prev.label + '同期日均', money(prevAvg)),
      ev('日均差额', (up ? '+' : '-') + money(Math.abs(diff))),
      ev('本月已过', curDays + ' 天'),
      ev(prev.label + '同期', prevDays + ' 天')
    ]
  )
}

/**
 * 类目月度变化：哪个类目把本月和上月的差距拉开的
 *
 * 与 detectMom 互补 —— mom 回答"多了多少"，这条回答"多在哪"，
 * 用户拿到金额之后最想知道的正是后者。
 *
 * ⚠️ 「其他支出 / 其他收入」不参与：里面装了什么没人知道，
 *    "其他支出比上月多花 ¥800"对用户没有任何可行动的含义
 *    （与 detectCategory 用的是同一份判定，见文件开头）。
 * ⚠️ 上期没有这个类目也算一种变化（新出现的支出），但不报百分比 —— 除以 0 没有意义。
 */
function detectCatMom(s) {
  const m = s.months
  if (!m || !m.current || !m.prevSame) return null

  const cur = m.current
  const prev = m.prevSame

  if (!(cur.total > 0) || !(prev.total > 0)) return null
  if (toNumber(cur.days) < TH.MOM_MIN_DAYS) return null

  const prevMap = {}
  ;(prev.cats || []).forEach(function (c) {
    if (isOtherCat(c)) return
    prevMap[c.id] = c
  })

  const curCats = (cur.cats || []).filter(function (c) { return !isOtherCat(c) })
  if (!curCats.length) return null

  // 两个方向上都要看：本期少了、但上期有的类目，也可能就是差距的来源
  const ids = {}
  curCats.forEach(function (c) { ids[c.id] = true })
  Object.keys(prevMap).forEach(function (id) { ids[id] = true })

  let best = null

  Object.keys(ids).forEach(function (id) {
    const c = curCats.filter(function (x) { return x.id === id })[0] || null
    const p = prevMap[id] || null

    const curAmt = c ? toNumber(c.amount) : 0
    const prevAmt = p ? toNumber(p.amount) : 0
    const name = (c && c.name) || (p && p.name) || ''

    const gap = round2(curAmt - prevAmt)
    if (Math.abs(gap) < TH.MOM_CAT_MIN_ABS) return

    // 占比门槛：小额类目翻倍（¥20 → ¥60）不值得单列。
    // 两种占比取较大者 —— 一个类目从 0 涨到占比 8% 同样值得说
    const shareCur = ratio(curAmt, cur.total)
    const sharePrev = ratio(prevAmt, prev.total)
    if (Math.max(shareCur, sharePrev) < TH.MOM_CAT_MIN_SHARE) return

    // 变化幅度：上期没有这个类目时按 100% 记（新出现），避免除以 0
    const base = prevAmt > 0 ? prevAmt : curAmt
    const rate = base > 0 ? Math.abs(gap) / base : 0
    if (prevAmt > 0 && rate < TH.TREND_RATIO) return

    if (!best || Math.abs(gap) > Math.abs(best.gap)) {
      best = {
        name: name,
        curAmt: curAmt,
        prevAmt: prevAmt,
        gap: gap,
        shareCur: shareCur,
        isNew: !(prevAmt > 0),
        isGone: !(curAmt > 0)
      }
    }
  })

  if (!best) return null

  const up = best.gap > 0
  const verb = up ? '多花 ' : '少花 '

  let detail = ''
  if (best.isNew) {
    detail = '上月（' + prev.label + '）同期没有「' + best.name + '」这一类支出，本月花了 '
      + money(best.curAmt) + '，占本月支出的 ' + Math.round(best.shareCur * 100) + '%。'
  } else if (best.isGone) {
    detail = '上月（' + prev.label + '）同期在「' + best.name + '」花了 ' + money(best.prevAmt)
      + '，本月还没有这一类支出。'
  } else {
    detail = '本月在「' + best.name + '」花了 ' + money(best.curAmt)
      + '，上月（' + prev.label + '）同期 ' + money(best.prevAmt)
      + '，占本月支出的 ' + Math.round(best.shareCur * 100) + '%。'
  }

  return make(
    'catMom', up ? 'warn' : 'tip',
    '「' + best.name + '」比上月' + verb + money(Math.abs(best.gap)),
    detail,
    [
      ev('本月 ' + best.name, money(best.curAmt)),
      ev(prev.label + '同期 ' + best.name, money(best.prevAmt)),
      ev('差额', (up ? '+' : '-') + money(Math.abs(best.gap))),
      ev('占本月支出', Math.round(best.shareCur * 100) + '%')
    ]
  )
}

/**
 * 固定支出：每个月都在同一家店花差不多的钱（房租、会员、宽带、话费）
 *
 * 这是"长期习惯画像"里最有实际价值的一条：用户往往**不知道自己每月到底被扣了多少**，
 * 而这类支出恰好是唯一能在不降低生活质量的前提下砍掉的。
 *
 * ⚠️ 条件必须三个同时成立，缺一不可：
 *    ① 连续 3 个月都有记录 —— 只出现两个月只能说明"最近买了两次"
 *    ② 每月金额在中位数的 ±20% 以内 —— 房租可能每年涨一次，但不会一个月 100 一个月 3000
 *    ③ 月均不低于 ¥30 —— 每月被扣 3 块钱的订阅不值得占一条结论
 * ⚠️ 三个月的金额顺序由 index.js 保证是「上上月 → 上月 → 本月」，
 *    与 months.recent 一一对应；错位的话文案里的月份标签就会张冠李戴。
 */
function detectFixed(s) {
  const cands = s.fixedCandidates || []
  const recent = (s.months && s.months.recent) || []

  if (!cands.length) return null
  if (recent.length < TH.FIXED_MONTHS) return null

  let best = null

  cands.forEach(function (c) {
    const amts = c.amounts || []
    if (amts.length < TH.FIXED_MONTHS) return

    const positive = amts.every(function (a) { return toNumber(a) > 0 })
    if (!positive) return

    const sorted = amts.map(toNumber).slice().sort(function (x, y) { return x - y })
    const median = sorted[Math.floor(sorted.length / 2)]

    if (median < TH.FIXED_MIN_ABS) return

    const tol = median * TH.FIXED_TOLERANCE
    const stable = amts.every(function (a) { return Math.abs(toNumber(a) - median) <= tol })
    if (!stable) return

    if (!best || median > best.median) {
      best = { title: c.title, amts: amts.map(round2), median: round2(median) }
    }
  })

  if (!best) return null

  const cur = s.months.current || {}
  const share = cur.total > 0 ? ratio(best.median, cur.total) : 0

  const parts = recent.map(function (mm, i) {
    return mm.label + ' ' + money(best.amts[i])
  }).join('、')

  const shareText = share > 0
    ? '，相当于本月支出的 ' + Math.round(share * 100) + '%。'
    : '。'

  return make(
    'fixed', 'tip',
    '每月固定支出约 ' + money(best.median) + '（' + best.title + '）',
    '最近 ' + recent.length + ' 个月在「' + best.title + '」都有支出，金额接近：'
      + parts + shareText
      + '这类支出每月都会发生，能省的空间不大，但值得确认一遍是不是都还在用。',
    [
      ev('每月金额', money(best.median)),
      ev('最近一次', money(best.amts[best.amts.length - 1])),
      ev('占本月支出', share > 0 ? Math.round(share * 100) + '%' : '—'),
      ev('连续月数', recent.length + ' 个月')
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
    detectMom(s),
    detectTrend(s),
    detectCategory(s),
    detectCatMom(s),
    detectFixed(s),
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
  // 交给你判断类目是不是「其他」兜底桶（index.js 算大额主要类目时也用同一份口径）
  isOtherCatName: isOtherCatName,
  PRIORITY: PRIORITY,
  LEVEL_WEIGHT: LEVEL_WEIGHT,
  // 导出单条规则，测试要能单独验证「不触发时返回 null」
  _rules: {
    detectBudget: detectBudget,
    detectMoonlight: detectMoonlight,
    detectMom: detectMom,
    detectTrend: detectTrend,
    detectCategory: detectCategory,
    detectCatMom: detectCatMom,
    detectFixed: detectFixed,
    detectNight: detectNight,
    detectLarge: detectLarge,
    detectSmallFreq: detectSmallFreq,
    detectMerchant: detectMerchant,
    detectWeekend: detectWeekend,
    detectNoSpend: detectNoSpend,
    detectBaseline: detectBaseline
  }
}