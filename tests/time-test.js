/**
 * parseCSV 时间解析函数离线验证
 * 从源码中抽出 toTimestamp / serialToTimestamp / parseTimestamp / formatTime / formatFullTime 单独跑。
 */
const fs = require('fs')

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'cloudfunctions/parseCSV/index.js'), 'utf8')

const start = SRC.indexOf('function toTimestamp(value) {')
const end = SRC.indexOf('function smartClassify(')
if (start < 0 || end < 0 || end <= start) {
  console.error('未能定位时间函数区块')
  process.exit(1)
}

const block = SRC.slice(start, end)
const factory = new Function(
  block + '\nreturn { toTimestamp, serialToTimestamp, parseTimestamp, formatTime, formatFullTime, isValidDate };'
)

let mod
try {
  mod = factory()
} catch (e) {
  // isValidDate 不存在也没关系，去掉再试
  const factory2 = new Function(
    block + '\nreturn { toTimestamp, serialToTimestamp, parseTimestamp, formatTime, formatFullTime };'
  )
  mod = factory2()
}

const { toTimestamp, serialToTimestamp, parseTimestamp, formatTime, formatFullTime } = mod

let failed = 0
function assert(ok, msg) {
  if (ok) console.log('  ✅ ' + msg)
  else { console.log('  ❌ ' + msg); failed++ }
}

const BJ = 8 * 60 * 60 * 1000
const bjEpoch = (y, m, d, hh, mm, ss) => Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0) - BJ

// 独立的 Excel 序列号构造（不依赖被测代码）
function makeSerial(y, m, d, hh, mm, ss) {
  const days = (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000
  const frac = (hh * 3600 + mm * 60 + ss) / 86400
  return days + frac
}

const TARGET = '2026-09-15 12:13:06'
const TARGET_TS = bjEpoch(2026, 9, 15, 12, 13, 6)
const TARGET_SERIAL = makeSerial(2026, 9, 15, 12, 13, 6)

console.log('目标北京时间:', TARGET)
console.log('期望时间戳  :', TARGET_TS, '=', new Date(TARGET_TS).toISOString())
console.log('Excel 序列号:', TARGET_SERIAL, '\n')

console.log('=== 1) 字符串日期 ===')
assert(toTimestamp(TARGET) === TARGET_TS, `"${TARGET}" → 期望时间戳`)
assert(toTimestamp('2026-09-15T12:13:06') === TARGET_TS, 'ISO 的 T 分隔符也支持')
assert(toTimestamp('2026/09/15 12:13:06') === TARGET_TS, '斜杠日期也支持')
assert(toTimestamp('2026-10-05 08:00') === bjEpoch(2026, 10, 5, 8, 0, 0), '无秒的 HH:mm 也能解析')
assert(toTimestamp('2026-10-05') === bjEpoch(2026, 10, 5, 0, 0, 0), '只有日期默认 00:00:00')

console.log('\n=== 2) Excel 日期序列号（数字） ===')
const tsA = toTimestamp(TARGET_SERIAL)
assert(tsA === TARGET_TS, `序列号 ${TARGET_SERIAL.toFixed(8)} → 期望时间戳（实际 ${tsA}）`)
assert(formatFullTime(tsA) === '2026-09-15 12:13', `格式化回来是 2026-09-15 12:13（实际 ${formatFullTime(tsA)}）`)
assert(toTimestamp(46310.509097222224) !== null, '用户实际文件里的序列号 46310.509097222224 能解析')
console.log('      46310.509097222224 →', formatFullTime(toTimestamp(46310.509097222224)))

console.log('\n=== 3) 序列号字符串 ===')
assert(toTimestamp(String(TARGET_SERIAL)) === TARGET_TS, '字符串形式的序列号同样支持')
assert(toTimestamp('46310.50909722') === toTimestamp(46310.50909722), '截断的字符串序列号与数字一致')

console.log('\n=== 4) Date 对象 ===')
const dObj = new Date(Date.UTC(2026, 8, 15, 4, 13, 6)) // UTC 04:13 = 北京 12:13
assert(toTimestamp(dObj) !== null, 'Date 对象能解析')
console.log('      Date(UTC 04:13:06) →', formatFullTime(toTimestamp(dObj)))

console.log('\n=== 5) 格式化（必须按 UTC+8 输出） ===')
assert(formatFullTime(TARGET_TS) === '2026-09-15 12:13', `formatFullTime（实际 ${formatFullTime(TARGET_TS)}）`)
assert(formatTime(TARGET_TS) === '09-15 12:13', `formatTime（实际 ${formatTime(TARGET_TS)}）`)
// 跨日验证：北京时间 00:30 不能被格式化到前一天
const earlyTs = bjEpoch(2026, 10, 15, 0, 30, 0)
assert(formatFullTime(earlyTs) === '2026-10-15 00:30', `跨日 00:30 保持当天（实际 ${formatFullTime(earlyTs)}）`)
// 北京时间 23:59 不能跑到次日
const lateTs = bjEpoch(2026, 10, 15, 23, 59, 59)
assert(formatFullTime(lateTs) === '2026-10-15 23:59', `跨日 23:59 保持当天（实际 ${formatFullTime(lateTs)}）`)

console.log('\n=== 6) 非法输入必须返回 null（不能用导入时间冒充） ===')
const bad = ['', '   ', '/', '中性', 'abc', null, undefined, '0', '2026-13-45 99:99:99', '2026-02-30 10:00:00']
bad.forEach(v => {
  const r = toTimestamp(v)
  assert(r === null, `toTimestamp(${JSON.stringify(v)}) === null（实际 ${r}）`)
})

console.log('\n=== 7) 序列号边界 ===')
assert(serialToTimestamp(0) === null, '序列号 0 → null')
assert(serialToTimestamp(-5) === null, '负数序列号 → null')
assert(serialToTimestamp(12345) === null, '过小序列号（像金额/编号）→ null')
assert(serialToTimestamp(999999) === null, '过大序列号 → null')
assert(serialToTimestamp(46310.999999999) !== null, '当天最晚时刻不越界到次日')
const s = makeSerial(2026, 10, 15, 23, 59, 59)
assert(formatFullTime(serialToTimestamp(s)) === '2026-10-15 23:59', `23:59:59 不越日（实际 ${formatFullTime(serialToTimestamp(s))}）`)

console.log(failed === 0 ? '\n全部通过 ✅' : `\n有 ${failed} 项失败 ❌`)
process.exit(failed === 0 ? 0 : 1)
