/**
 * 一键跑完全部离线校验
 *
 * 运行：node tests/run-all.js
 *
 * 说明：这些脚本都不需要开发者工具、不需要真机、不联网，
 *      直接把云函数源码用假数据库「跑」起来做断言。
 */
const path = require('path')
const { spawnSync } = require('child_process')

const SUITES = [
  ['静态检查（语法/引用/绑定/主题一致性/废弃API）', 'static-check.js'],
  ['云函数统计聚合（getStatistics）', 'test.js'],
  ['时间解析与 Excel 序列号（parseCSV）', 'time-test.js'],
  ['WXS 金额与时间格式化', 'wxs-test.js'],
  ['图表格式化（金额口径/Y轴刻度/与 WXS 对账）', 'chart-format-test.js'],
  ['手动记账（分类/去重/统计贯通）', 'add-test.js'],
  ['删除账单（归属校验/脏输入/统计联动）', 'delete-test.js'],
  ['编辑账单（归属校验/校验一致/重复检查/统计联动）', 'update-test.js'],
  ['预算管理（天数分母/分档阈值/派生数字可核对）', 'budget-test.js'],
  ['智能分析（规则阈值边界/结论数字逐值审计/跨月取数）', 'insight-test.js'],
  ['AI 分析页（范围切换同步说明小字/深度思考/失败态）', 'ai-page-test.js'],
  ['导入去重（只传判重键/大批量不截断/跨用户隔离/分批偏移）', 'import-dedup-test.js'],
  ['主题系统（回落/tabBar 图标/持久化）', 'theme-test.js'],
  ['用户档案（自动建档/昵称规则/越权/主题偏好）', 'user-test.js'],
  ['VIP 会员（激活幂等/防白嫖/档案不丢字段）', 'vip-test.js']
]

let failed = 0

for (const [title, file] of SUITES) {
  console.log('\n' + '━'.repeat(64))
  console.log(`▶ ${title}  (${file})`)
  console.log('━'.repeat(64))

  const res = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  })

  if (res.status !== 0) {
    failed++
    console.log(`\n✗ ${title} 未通过（退出码 ${res.status}）`)
  }
}

console.log('\n' + '━'.repeat(64))
if (failed) {
  console.log(`❌ ${failed}/${SUITES.length} 个套件未通过`)
  process.exit(1)
}
console.log(`✅ 全部 ${SUITES.length} 个套件通过`)
console.log('━'.repeat(64))
