/**
 * utils/format.wxs 离线验证
 *
 * WXS 不能直接 require，这里用 new Function 注入 getDate 后 eval 源码。
 *
 * 运行：node tests/wxs-test.js
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const WXS_PATH = path.join(__dirname, '..', 'utils', 'format.wxs')
const src = fs.readFileSync(WXS_PATH, 'utf8')

function load() {
  const factory = new Function(
    'getDate',
    'var module = { exports: {} };' + src + '\nreturn module.exports;'
  )
  return factory(ts => new Date(ts === undefined ? Date.now() : ts))
}

const fmt = load()

let fail = 0
const t = (ok, msg) => { console.log((ok ? '  ✅ ' : '  ❌ ') + msg); if (!ok) fail++ }

// ---------------------------------------------------------------- 金额
console.log('=== 金额 ===')
t(fmt.amount(35.5) === '35.50', `35.5 → ${fmt.amount(35.5)}`)
t(fmt.amount(14436.5) === '14436.50', `14436.5 → ${fmt.amount(14436.5)}（不缩写成 1.44万）`)
t(fmt.amount(99999.99) === '99999.99', `99999.99 → ${fmt.amount(99999.99)}`)
t(fmt.amount(123456) === '12.35万', `123456 → ${fmt.amount(123456)}`)
t(fmt.amount(123456789) === '1.23亿', `123456789 → ${fmt.amount(123456789)}`)
t(fmt.amount(-14436.5) === '-14436.50', `-14436.5 → ${fmt.amount(-14436.5)}`)
t(fmt.amount(0) === '0.00', `0 → ${fmt.amount(0)}`)
t(fmt.amount(undefined) === '0.00', `undefined → ${fmt.amount(undefined)}`)
t(fmt.amount(null) === '0.00', `null → ${fmt.amount(null)}`)
t(fmt.amount('') === '0.00', `'' → ${fmt.amount('')}`)
t(fmt.amount('abc') === '0.00', `'abc' → ${fmt.amount('abc')}`)
t(fmt.amount('35.5') === '35.50', `字符串 '35.5' → ${fmt.amount('35.5')}`)
t(fmt.amount(12.345) === '12.35', `12.345 → ${fmt.amount(12.345)}`)
t(fmt.amount(100, 0) === '100', `100(0位小数) → ${fmt.amount(100, 0)}`)
t(fmt.amount(Infinity) === '0.00', `Infinity → ${fmt.amount(Infinity)}（不能输出 Infinity）`)
t(fmt.amount(NaN) === '0.00', `NaN → ${fmt.amount(NaN)}`)

// ------------------------------------------------- 时间：UTC+8 固定口径
// 账单时间统一按北京时间（UTC+8）显示，与设备/宿主时区无关。
// 取北京 2026-10-15 12:13:06 对应的真实时间戳：
const ts = Date.UTC(2026, 9, 15, 4, 13, 6)

console.log('\n=== 时间：北京口径（UTC+8） ===')
t(fmt.full(ts) === '2026-10-15 12:13', `full → ${fmt.full(ts)}`)
t(fmt.fullSec(ts) === '2026-10-15 12:13:06', `fullSec → ${fmt.fullSec(ts)}`)
t(fmt.dateTime(ts) === '10-15 12:13', `dateTime → ${fmt.dateTime(ts)}`)
t(fmt.timeOnly(ts) === '12:13', `timeOnly → ${fmt.timeOnly(ts)}`)
t(fmt.byMode(ts, 'datetime') === '2026-10-15 12:13', `byMode datetime → ${fmt.byMode(ts, 'datetime')}`)
t(fmt.byMode(ts, 'time') === '12:13', `byMode time → ${fmt.byMode(ts, 'time')}`)

console.log('\n=== 空值必须返回空串（不能出现 Invalid Date / NaN） ===')
t(fmt.full(0) === '', `full(0) → '${fmt.full(0)}'`)
t(fmt.full(null) === '', `full(null) → '${fmt.full(null)}'`)
t(fmt.full(undefined) === '', `full(undefined) → '${fmt.full(undefined)}'`)
t(fmt.fullSec(0) === '', `fullSec(0) → '${fmt.fullSec(0)}'`)
t(fmt.dateTime(0) === '', `dateTime(0) → '${fmt.dateTime(0)}'`)
t(fmt.timeOnly(0) === '', `timeOnly(0) → '${fmt.timeOnly(0)}'`)
t(fmt.time(0) === '', `time(0) → '${fmt.time(0)}'`)
t(fmt.byMode(0, 'datetime') === '', `byMode(0) → '${fmt.byMode(0)}'`)

// --------------------------- 跨日边界：北京时间 00:30 / 23:59 不能串日
console.log('\n=== 跨日边界 ===')
const bj = (y, m, d, hh, mm, ss) => Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0) - 8 * 3600 * 1000
t(fmt.full(bj(2026, 10, 15, 0, 30)) === '2026-10-15 00:30', `北京 00:30 → ${fmt.full(bj(2026, 10, 15, 0, 30))}`)
t(fmt.full(bj(2026, 10, 15, 23, 59)) === '2026-10-15 23:59', `北京 23:59 → ${fmt.full(bj(2026, 10, 15, 23, 59))}`)
t(fmt.full(bj(2026, 1, 1, 0, 0)) === '2026-01-01 00:00', `跨年 1/1 00:00 → ${fmt.full(bj(2026, 1, 1, 0, 0))}`)
t(fmt.full(bj(2026, 12, 31, 23, 59)) === '2026-12-31 23:59', `跨年 12/31 23:59 → ${fmt.full(bj(2026, 12, 31, 23, 59))}`)

// --------------- 关键回归：显示结果不得随宿主/设备时区变化 ---------------
// 起子进程，用不同 TZ 跑同一段格式化代码，输出必须逐字节一致。
// 这正是旧实现（getDate(ts) + getHours()）会挂掉的场景。
console.log('\n=== 时区无关性（子进程改 TZ 对比，旧实现的坑） ===')

const probe = `
const fs = require('fs')
const src = fs.readFileSync(${JSON.stringify(WXS_PATH)}, 'utf8')
const factory = new Function('getDate', 'var module = { exports: {} };' + src + '\\nreturn module.exports;')
const fmt = factory(ts => new Date(ts === undefined ? Date.now() : ts))
const ts = Date.UTC(2026, 9, 15, 4, 13, 6)
process.stdout.write([fmt.full(ts), fmt.fullSec(ts), fmt.dateTime(ts), fmt.timeOnly(ts)].join('|'))
`

const zones = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London']
const EXPECTED = '2026-10-15 12:13|2026-10-15 12:13:06|10-15 12:13|12:13'
let baseline = null
let allSame = true

zones.forEach(tz => {
  let out = ''
  try {
    out = execFileSync(process.execPath, ['-e', probe], {
      env: Object.assign({}, process.env, { TZ: tz }),
      encoding: 'utf8'
    }).trim()
  } catch (e) {
    out = 'ERR:' + e.message
  }
  if (baseline === null) baseline = out
  else if (out !== baseline) allSame = false
  console.log(`    TZ=${tz.padEnd(18)} → ${out}`)
})

t(baseline === EXPECTED, `基准时区输出正确（${baseline}）`)
t(allSame, '四个时区（UTC / 上海 / 纽约 / 伦敦）输出完全一致')

console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`)
process.exit(fail === 0 ? 0 : 1)
