/**
 * 应用版本信息 —— 全局唯一来源
 *
 * 改版本号只改这里，不要在各个页面里硬编码。
 * 版本号约定（详见 README「版本号约定」）：
 *   - 首次对外发布前一律停留在 0.x
 *   - 首次正式发布为 1.0.0，此后按 MAJOR.MINOR.PATCH 递增
 */

// 语义化版本号
const VERSION = '1.0.3'

// 发布阶段：'dev' 开发中 | 'beta' 内测 | 'release' 已发布
const STAGE = 'release'

const STAGE_LABEL = {
  dev: '开发中',
  beta: '内测',
  release: ''
}

const SUFFIX = STAGE_LABEL[STAGE] ? '（' + STAGE_LABEL[STAGE] + '）' : ''

module.exports = {
  VERSION,
  STAGE,
  // 带 v 前缀，如 'v0.1.0（开发中）'
  VERSION_LABEL: 'v' + VERSION + SUFFIX,
  // 纯版本号，如 '0.1.0'
  VERSION_TEXT: VERSION
}
