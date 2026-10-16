/**
 * utils/chart-format.js 离线验证
 *
 * 这个模块是「图表上的数字长什么样」的唯一口径，对应两个真实踩过的坑：
 *   1. 环形图中心用 Math.round 收尾 → ¥8.80 显示成「¥9」，用户以为金额记错了
 *   2. Y 轴刻度四舍五入成整数 → niceMax=2.5 时五档变成「3 2 1 1 0」，两个重复的 1
 * 两条都不会报错，只是图上数字看着别扭，所以必须用测试钉住。
 *
 * 另外逐值对账 utils/format.wxs 的 amount：Canvas 用不了 WXS，
 * 但两边显示的是同一批金额，口径漂移就是「同一个数是两种写法」。
 *
 * 运行：node tests/chart-format-test.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const cf = require(path.join(ROOT, 'utils', 'chart-format.js'))

let fail = 0
const t = (ok, msg) => { console.log((ok ? '  ✅ ' : '  ❌ ') + msg); if (!ok) fail++ }

// ---------------------------------------------------------------- 金额口径
console.log('=== 金额：日常金额保留两位小数 ===')
t(cf.formatAmount(8.8) === '8.80', `8.8 → ${cf.formatAmount(8.8)}（曾经是 "9"，把 8.8 说成 9 块）`)
t(cf.formatAmount(0.5) === '0.50', `0.5 → ${cf.formatAmount(0.5)}`)
t(cf.formatAmount(0) === '0.00', `0 → ${cf.formatAmount(0)}`)
t(cf.formatAmount(35.5) === '35.50', `35.5 → ${cf.formatAmount(35.5)}`)
t(cf.formatAmount(1234.56) === '1234.56', `1234.56 → ${cf.formatAmount(1234.56)}`)

console.log('\n=== 金额：只有大到一定程度才缩写（10 万 / 1 亿） ===')
t(cf.formatAmount(14436.5) === '14436.50', `14436.5 → ${cf.formatAmount(14436.5)}（不缩写成 1.44万）`)
t(cf.formatAmount(99999.99) === '99999.99', `99999.99 → ${cf.formatAmount(99999.99)}（刚好不到 10 万，仍写全）`)
t(cf.formatAmount(100000) === '10.00万', `100000 → ${cf.formatAmount(100000)}`)
t(cf.formatAmount(123456) === '12.35万', `123456 → ${cf.formatAmount(123456)}`)
t(cf.formatAmount(123456789) === '1.23亿', `123456789 → ${cf.formatAmount(123456789)}`)

console.log('\n=== 金额：异常输入不能画出 NaN / Infinity ===')
t(cf.formatAmount(undefined) === '0.00', `undefined → ${cf.formatAmount(undefined)}`)
t(cf.formatAmount(null) === '0.00', `null → ${cf.formatAmount(null)}`)
t(cf.formatAmount('') === '0.00', `'' → ${cf.formatAmount('')}`)
t(cf.formatAmount('abc') === '0.00', `'abc' → ${cf.formatAmount('abc')}`)
t(cf.formatAmount(NaN) === '0.00', `NaN → ${cf.formatAmount(NaN)}`)
t(cf.formatAmount(Infinity) === '0.00', `Infinity → ${cf.formatAmount(Infinity)}（不能输出 Infinity亿）`)
t(cf.formatAmount(-8.8) === '-8.80', `-8.8 → ${cf.formatAmount(-8.8)}`)
t(cf.formatAmount(100, 0) === '100', `formatAmount(100, 0) → ${cf.formatAmount(100, 0)}`)
t(cf.formatAmount('35.5') === '35.50', `字符串 '35.5' → ${cf.formatAmount('35.5')}`)

// -------------------------------------------------- 与 WXS 口径逐值对账
console.log('\n=== 与 utils/format.wxs 的 amount 逐值对账（同一批金额不能两种写法） ===')

const wxsSrc = fs.readFileSync(path.join(ROOT, 'utils', 'format.wxs'), 'utf8')
const wxsModule = { exports: {} }
// eslint-disable-next-line no-new-func
new Function('getDate', 'module', wxsSrc)(ts => new Date(ts === undefined ? Date.now() : ts), wxsModule)
const wxsAmount = wxsModule.exports.amount

const SAME_CASES = [
  0, 0.5, 8.8, 35.5, 144.3, 1234.56, 14436.5, 99999.99, 100000, 123456, 123456789, -8.8
]
let sameCount = 0
SAME_CASES.forEach(v => {
  const a = cf.formatAmount(v)
  const b = wxsAmount(v)
  const ok = a === b
  if (ok) sameCount++
  else console.log(`    不一致：${v} → chart-format "${a}" / format.wxs "${b}"`)
})
t(sameCount === SAME_CASES.length, `${sameCount}/${SAME_CASES.length} 个取值两处显示一致`)

// ---------------------------------------------------------------- Y 轴刻度
console.log('\n=== Y 轴刻度：五档不允许出现重复标签 ===')
// 刻度就是 niceMax 结果按 max、3/4、1/2、1/4、0 取五档，
// 与 pages/stats/stats.js 里的循环完全一致。
function ticksOf(rawMax) {
  const max = cf.niceMax(rawMax)
  return [0, 1, 2, 3, 4].map(i => cf.formatAxisTick(max - (max / 4) * i, max))
}

const AXIS_CASES = [
  { raw: 8.8, why: '一笔 8.8 元支出' },
  { raw: 4, why: 'niceMax 会取到 2.5 档' },
  { raw: 2.4, why: 'niceMax 取 2.5 档，四舍五入曾变成 3/2/1/1/0' },
  { raw: 1, why: '极小额' },
  { raw: 18, why: '两档 2 与 2.5 的分界附近' },
  { raw: 100, why: '常规百元' },
  { raw: 1000, why: '常规千元' },
  { raw: 14436.5, why: '万元级' },
  { raw: 200000, why: '十万级（整轴切到「万」）' },
  { raw: 1234567890, why: '亿级' }
]

let axisOk = 0
AXIS_CASES.forEach(c => {
  const ticks = ticksOf(c.raw)
  const unique = new Set(ticks).size === ticks.length
  if (unique) axisOk++
  console.log(`    max=${String(c.raw).padStart(11)} → ${ticks.join(' / ')}${unique ? '' : '   ← 有重复！'}   (${c.why})`)
})
t(axisOk === AXIS_CASES.length, `${axisOk}/${AXIS_CASES.length} 组刻度没有重复标签`)

console.log('\n=== Y 轴刻度：整条轴单位统一 ===')
// 半路换单位（2.0万 / 1.5万 / 1.0万 / 5000 / 0）比数字不准更难看，
// 所以单位由 maxValue 决定一次，而不是每个刻度各自判断。
// 注意分界是 10 万（与金额口径一致）：2 万这一档还写全数字，只是稍长，不会串单位。
const wanTicks = ticksOf(100000)
t(
  wanTicks.every(x => x === '0' || x.endsWith('万')),
  `max=10万 → ${wanTicks.join(' / ')}（除 0 外全部带「万」）`
)

const wanTicks2 = ticksOf(200000)
t(
  wanTicks2.every(x => x === '0' || x.endsWith('万')),
  `max=20万 → ${wanTicks2.join(' / ')}`
)
t(wanTicks2[4] === '0', `零点固定显示为 "0"，不写成 "0.0万"（实际 ${wanTicks2[4]}）`)

const plainTicks = ticksOf(20000)
t(
  plainTicks.every(x => /^\d+$/.test(x)),
  `max=2万（未到 10 万）→ ${plainTicks.join(' / ')}，仍然写全数字不缩写`
)

const yiTicks = ticksOf(2000000000)
t(
  yiTicks.every(x => x === '0' || x.endsWith('亿')),
  `max=20亿 → ${yiTicks.join(' / ')}`
)

// ---------------------------------------------------------------- niceMax
console.log('\n=== niceMax：向上取整到 1 / 2 / 2.5 / 5 / 10 × 10^n ===')
t(cf.niceMax(0) === 100, `0 → ${cf.niceMax(0)}（无数据时给一个可用刻度，避免除零）`)
t(cf.niceMax(-5) === 100, `-5 → ${cf.niceMax(-5)}`)
t(cf.niceMax(0.8) === 1, `0.8 → ${cf.niceMax(0.8)}`)
t(cf.niceMax(1) === 1, `1 → ${cf.niceMax(1)}`)
t(cf.niceMax(1.5) === 2, `1.5 → ${cf.niceMax(1.5)}`)
t(cf.niceMax(2.4) === 2.5, `2.4 → ${cf.niceMax(2.4)}`)
t(cf.niceMax(4) === 5, `4 → ${cf.niceMax(4)}`)
t(cf.niceMax(8.8) === 10, `8.8 → ${cf.niceMax(8.8)}`)
t(cf.niceMax(18) === 20, `18 → ${cf.niceMax(18)}`)
t(cf.niceMax(14436.5) === 20000, `14436.5 → ${cf.niceMax(14436.5)}`)
t(cf.niceMax(999999) === 1000000, `999999 → ${cf.niceMax(999999)}`)
t(cf.niceMax(1) >= 1, '向上取整：结果永远不小于输入')

// 不变式：结果必须 ≥ 输入（否则折线会画出图表外）
let niceOk = 0
const NICE_SAMPLES = [0.3, 1, 2.5, 3.7, 9.9, 17, 55, 101, 250, 999, 12345, 123456789]
NICE_SAMPLES.forEach(v => { if (cf.niceMax(v) >= v) niceOk++ })
t(niceOk === NICE_SAMPLES.length, `${niceOk}/${NICE_SAMPLES.length} 个样本都满足 niceMax(v) >= v`)

// ---------------------------------------------------------------- hexToRgba
console.log('\n=== hexToRgba：颜色转 rgba（折线面积渐变用） ===')
t(cf.hexToRgba('#E5484D', 0.22) === 'rgba(229, 72, 77, 0.22)',
  `#E5484D, 0.22 → ${cf.hexToRgba('#E5484D', 0.22)}`)
t(cf.hexToRgba('#FFF', 1) === 'rgba(255, 255, 255, 1)', `三位简写 #FFF → ${cf.hexToRgba('#FFF', 1)}`)
t(cf.hexToRgba('E5484D', 0) === 'rgba(229, 72, 77, 0)', `不带 # → ${cf.hexToRgba('E5484D', 0)}`)
t(cf.hexToRgba('', 1) === 'rgba(153, 153, 153, 1)', `空串有兜底色 → ${cf.hexToRgba('', 1)}（不抛异常）`)
t(cf.hexToRgba(undefined, 1) === 'rgba(153, 153, 153, 1)', `undefined → ${cf.hexToRgba(undefined, 1)}`)
t(/^rgba\(/.test(cf.hexToRgba('zzz', 1)), `非法色值不抛异常 → ${cf.hexToRgba('zzz', 1)}`)

console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`)
process.exit(fail === 0 ? 0 : 1)
