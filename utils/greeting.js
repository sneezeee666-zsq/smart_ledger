/**
 * 首页问候语
 * ---------------------------------------------------------------------------
 * 单独一个模块的理由：这段逻辑有两个**很容易写错、而且改错了不报错**的点，
 * 放在页面里就只能靠肉眼检查（页面的 Page({}) 结构在离线测试里跑不起来）：
 *
 *   1. 昵称没设置时不能拼逗号 —— 否则卡片上会出现「早上好，」这种半截话。
 *      这个坑只有在「新用户第一眼看到首页」时才暴露，开发时自己永远是有昵称的。
 *   2. 时段边界：23:00~05:00 是「夜深了」而不是「晚上好」，
 *      18:00 与 23:00 这两个端点归哪边，靠读代码很难确认。
 *
 * 时间一律用**北京时间**：调用方传进来的是已换算好的 hour（0-23），
 * 本模块不碰时区 —— 时区处理集中在页面里的 bjNow()，只有一处。
 */

// [起始小时, 结束小时) → 文案
const BANDS = [
  [5, 11, '早上好'],
  [11, 13, '中午好'],
  [13, 18, '下午好'],
  [18, 23, '晚上好']
]

// 23:00 ~ 次日 05:00
const NIGHT = '夜深了'

/** 按小时取问候语（不含昵称） */
function wordOf(hour) {
  const h = Number(hour)
  if (!isFinite(h)) return NIGHT

  for (let i = 0; i < BANDS.length; i++) {
    if (h >= BANDS[i][0] && h < BANDS[i][1]) return BANDS[i][2]
  }
  return NIGHT
}

/**
 * 拼成最终显示的一句话。
 * @param {number} hour 北京时间的小时（0-23）
 * @param {string} nickname 昵称，可为空
 */
function build(hour, nickname) {
  const word = wordOf(hour)
  const nick = String(nickname === null || nickname === undefined ? '' : nickname).trim()
  return nick ? word + '，' + nick : word
}

module.exports = {
  NIGHT: NIGHT,
  wordOf: wordOf,
  build: build
}
