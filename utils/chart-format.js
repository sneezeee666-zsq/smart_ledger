/**
 * 图表数值格式化（纯函数）
 * ---------------------------------------------------------------------------
 * 为什么单独抽一个模块？
 *   Canvas 里用不了 WXS（utils/format.wxs 只在 WXML 里生效），页面必须再有一份
 *   JS 版格式化。但它同时也是**口径** —— 金额什么时候缩写、刻度留几位、
 *   量级很小的时候怎么显示，写错不会有任何报错，只是图上的数字看着别扭，
 *   而「看着别扭」正是最容易一路留到上线的那类问题。
 *   抽到 utils 后 tests/chart-format-test.js 可以直接 require 做断言，
 *   不用把 Page / wx 环境搬进 node。
 *
 * ⚠️ 口径必须与 utils/format.wxs 的 amount 完全一致：
 *    只有大到一定程度才缩写，日常金额保留两位小数。
 *    把 8.8 显示成「9」会让人以为金额记错了 —— 而这正是之前的写法。
 *    两边由 tests/chart-format-test.js 逐值对账。
 */

const YI = 100000000
const WAN = 10000

// 与 utils/format.wxs 一致：10 万才缩写成「万」，不是 1 万。
// 日常金额（14436.50）被缩成「1.44万」会让人怀疑数字不对。
const WAN_AT = 100000

/** 把任意输入收敛成一个有限数字，异常一律当 0（图表不能因为一个 NaN 整张画不出来） */
function toNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (n !== n || n === Infinity || n === -Infinity) return 0
  return n
}

/**
 * 图表里的金额文案（环形图中心、汇总大数字）。
 * 口径与 utils/format.wxs 的 amount 一致。
 */
function formatAmount(value, decimals) {
  const n = toNumber(value)
  const abs = Math.abs(n)
  const d = decimals === undefined || decimals === null ? 2 : decimals

  if (abs >= YI) return (n / YI).toFixed(2) + '亿'
  if (abs >= WAN_AT) return (n / WAN).toFixed(2) + '万'
  return n.toFixed(d)
}

/**
 * Y 轴的一个刻度标签。
 *
 * ⚠️ 单位必须**整条轴统一**，所以判断依据是 maxValue（整轴最大值）而不是当前值：
 *    各自判断会画出「2.0万 / 1.5万 / 1.0万 / 5000 / 0」这种半路换单位的刻度。
 *
 * ⚠️ 量级很小时（niceMax 会取到 2.5 这类值）必须保留一位小数：
 *    五档刻度是 max、3/4、1/2、1/4、0，四舍五入成整数会变成
 *    「3 2 1 1 0」—— 出现两个 1，看起来像图坏了。
 *
 * @param {number} value    该刻度的值
 * @param {number} maxValue niceMax() 的结果（整轴最大值）
 */
function formatAxisTick(value, maxValue) {
  const max = toNumber(maxValue)
  const n = toNumber(value)

  const unit = max >= YI ? { div: YI, suffix: '亿' }
    : max >= WAN_AT ? { div: WAN, suffix: '万' }
      : null

  if (unit) {
    if (n === 0) return '0'
    // 缩放后还有两位数（20万 以上）就不再留小数，否则「20.0万」太长
    const decimal = (max / unit.div) >= 10 ? 0 : 1
    return (n / unit.div).toFixed(decimal) + unit.suffix
  }

  if (max < 10) return String(Math.round(n * 10) / 10)
  return String(Math.round(n))
}

/**
 * 把最大值向上取整到 1 / 2 / 2.5 / 5 / 10 × 10^n，
 * 让 Y 轴的刻度落在「好看」的整数上。
 */
function niceMax(value) {
  const v = toNumber(value)
  if (v <= 0) return 100

  const exp = Math.floor(Math.log(v) / Math.LN10)
  const mag = Math.pow(10, exp)
  const norm = v / mag

  let nice
  if (norm <= 1) nice = 1
  else if (norm <= 2) nice = 2
  else if (norm <= 2.5) nice = 2.5
  else if (norm <= 5) nice = 5
  else nice = 10

  return nice * mag
}

/** #RRGGBB → rgba(r, g, b, a)，用于折线下的面积渐变 */
function hexToRgba(hex, alpha) {
  const h = String(hex === null || hex === undefined ? '' : hex).replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const num = parseInt(full || '999999', 16)

  // parseInt 失败时是 NaN，位运算会把它变成 0 → 最终是透明黑，不会画出诡异的颜色
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255

  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')'
}

module.exports = {
  YI: YI,
  WAN: WAN,
  WAN_AT: WAN_AT,
  toNumber: toNumber,
  formatAmount: formatAmount,
  formatAxisTick: formatAxisTick,
  niceMax: niceMax,
  hexToRgba: hexToRgba
}
