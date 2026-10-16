/**
 * 记账 / 编辑表单的共用纯函数
 * ---------------------------------------------------------------------------
 * 为什么放在 utils 而不是留在页面里？
 *   这两个函数都对应着踩过的坑，而页面里的函数没法离线单测 ——
 *   要么在测试里抄一份（等于没测），要么把整个 Page/wx 环境搬进 node。
 *   抽成纯函数后，tests/update-test.js 可以直接 require 它们做断言。
 */

const BJ_OFFSET = 8 * 60 * 60 * 1000

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

/**
 * 时间戳 → 北京时间的「日期 + 时间」两个字符串
 *
 * ⚠️ 必须先加 8 小时再走 getUTC*，不能用 getHours()：
 *    设备时区不是 UTC+8（或系统时间被改过）时，取出来的是设备本地时间，
 *    编辑一条历史账单会整体偏移几个小时 —— 而这种错在开发机上永远复现不了。
 */
function bjParts(ts) {
  const n = typeof ts === 'number' && isFinite(ts) ? ts : Date.now()
  const d = new Date(n + BJ_OFFSET)
  return {
    date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    time: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  }
}

/** 当前北京时间的「日期 + 时间」 */
function bjNow() {
  return bjParts(Date.now())
}

/**
 * 把原值并进下拉选项，返回 { list, index }
 *
 * ⚠️ 为什么非做不可：
 *    导入的微信账单里「支付方式」常常是「招商银行(1234)」这种带卡号的值，
 *    而页面上的下拉列表只有「零钱 / 零钱通 / 储蓄卡 …」几个固定项。
 *    不补这一步的话，编辑这条账单时索引会落到 0 ——
 *    用户只是想改个金额，点一次保存却顺手把支付方式静默改成了列表第一项。
 *    这种「一处没动过的字段被改掉」最难被发现，也最难被相信。
 *
 * 追加到末尾（不插到最前）是为了不打乱已有选项的下标 ——
 * 页面的 picker 是索引驱动的，下标一动，用户选的项就跟着错位。
 */
function withValue(list, value) {
  const arr = (list || []).slice()
  const v = value === undefined || value === null ? '' : String(value).trim()
  if (!v) return { list: arr, index: 0 }

  const i = arr.indexOf(v)
  if (i !== -1) return { list: arr, index: i }

  arr.push(v)
  return { list: arr, index: arr.length - 1 }
}

module.exports = {
  bjParts: bjParts,
  bjNow: bjNow,
  withValue: withValue
}
