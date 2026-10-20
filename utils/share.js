/**
 * 分享（转发）配置 —— 单一数据源
 *
 * ⚠️ 为什么需要这个文件：微信规定**只有定义了 onShareAppMessage 的页面，
 *    右上角菜单才会出现"转发"按钮**。之前全项目一个页面都没定义，
 *    表现就是用户点了右上角三个点后"当前页面无法转发"。
 *    分享文案散在各页面里写必然漂移，所以集中到这里，页面只负责调用。
 *
 * ⚠️ 隐私分两类，别混：
 *    - **通用分享**（appShare）：只介绍小程序，imageUrl 用一张**固定封面**。
 *      账单页 / 我的页 / 表单页一律用这个 —— 默认分享是当前页面截图，
 *      会把交易明细、统计数字一起截走，用户随手一转就泄了。
 *    - **内容分享**（statsShare）：带真实数字，转发才有传播力。
 *      这是**用户主动点的转发**，暴露什么由他自己决定（类似晒年度账单）。
 */

// 金额格式化：与界面、图表同一套口径（10 万以下显示完整两位小数）
const cf = require('./chart-format.js')

// 固定封面：不带任何用户数据。文件由 tools/gen-icons.py 生成（存在即跳过）
const SHARE_COVER = '/assets/icons/share-cover.png'

const APP_NAME = '66账本'

// 统计周期 key → 中文，与 pages/stats 的 periods 对齐
const PERIOD_LABEL = {
  week: '本周',
  month: '本月',
  year: '本年'
}

/**
 * 通用分享：只介绍小程序，不带任何用户数据。
 *
 * @param {string} path 分享后打开的页面，默认首页
 */
function appShare(path) {
  return {
    title: '我在用66账本记账，数据只存在自己的云环境，推荐给你',
    path: path || '/pages/index/index',
    imageUrl: SHARE_COVER
  }
}

/**
 * 统计页分享：标题带真实支出数字（用户主动转发，数字可见才有传播力）。
 *
 * ⚠️ 金额走 utils/chart-format.js 的 formatAmount —— 与界面、图表同一套口径
 *    （10 万以下显示完整两位小数，所以日常金额不会被缩写成"万"）。
 *    WXS 只能在 WXML 里跑，JS 侧拿不到，所以这里复用 chart-format 这份。
 * ⚠️ 不设 imageUrl：让微信用当前页面截图（带图表），比固定封面更有传播力。
 *
 * @param {Object} d 页面 data（取 currentPeriod / summary）
 */
function statsShare(d) {
  const period = (d && d.currentPeriod) || 'month'
  const label = PERIOD_LABEL[period] || '本月'
  const expense = (d && d.summary && Number(d.summary.expense)) || 0

  const title = expense > 0
    ? label + '支出 ¥' + cf.formatAmount(expense) + '，看看钱花在哪'
    : label + '账本，看看钱花在哪'

  return {
    title,
    // 带上周期：被分享者打开时看到的是同一个周期，而不是默认月
    path: '/pages/stats/stats?period=' + period
  }
}

/**
 * 朋友圈分享（onShareTimeline）。
 * ⚠️ 朋友圈分享必须给图片，用固定封面；也不带 query（朋友圈入口只进首页）。
 */
function timelineShare() {
  return {
    title: APP_NAME + ' · 数据只存自己的云环境',
    imageUrl: SHARE_COVER
  }
}

module.exports = {
  APP_NAME,
  SHARE_COVER,
  appShare,
  statsShare,
  timelineShare
}
