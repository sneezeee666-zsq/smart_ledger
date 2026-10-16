/**
 * 会员中心（VIP）
 * ===========================================================================
 * 一次性买断、**永久有效** —— 没有到期时间，也就没有续费/过期提醒这一类状态。
 * 界面上只需要两种身份：普通用户 / 会员。
 *
 * 支付状态（⚠️ 重要）：
 *   商户号还没接入，云函数 `user` 的 VIP_PAY_MODE='sandbox'，
 *   「开通会员」按钮走的是**模拟支付**：本地弹一次确认 → 云函数直接激活。
 *   接入真实微信支付后只需改两处：
 *     ① 云函数 createVipOrder 改为统一下单、返回 prepay_id
 *     ② 这里把 sandbox 分支换成 wx.requestPayment；激活由**支付回调**完成
 *   前端的按钮文案与校验逻辑不用动。
 *
 * 会员判定永远是 utils/user.js 的 isVip()（云端权威，本机缓存只是首帧镜像）。
 */

const theme = require('../../utils/theme.js')
const share = require('../../utils/share.js')
const user = require('../../utils/user.js')

// 功能对比表（参照常见会员定价页的信息结构：行 = 功能，列 = 身份）。
// ⚠️ "免费功能"也要列出来 —— 只列付费功能会让人以为记账本身也要钱。
//    会员唯一的区别就是智能分析；别为了表格好看虚增权益。
const COMPARE = [
  { name: '记账 / 导入账单', free: '√', vip: '√' },
  { name: '统计与图表', free: '√', vip: '√' },
  { name: '每月预算管理', free: '√', vip: '√' },
  { name: '导出 CSV', free: '√', vip: '√' },
  { name: '智能分析（一键分析）', free: '模糊预览', vip: '完整结论', highlight: true },
  { name: '后续新功能', free: '—', vip: '优先体验', highlight: true }
]

Page({
  data: {
    theme: theme.currentId(),

    compare: COMPARE,

    // 身份与状态
    isVip: false,
    sinceText: '',
    priceText: '¥18',
    loading: false,      // 激活请求进行中
    paying: false        // 模拟支付确认弹窗进行中（防连点）
  },


  // ---------------- 分享 ----------------
  // ⚠️ 必须定义 onShareAppMessage，否则右上角菜单不出现"转发"按钮，
  //    表现为用户点右上角三个点后提示"当前页面无法转发"。
  // 本页可能是隐私页（账单/我的）或过程页，只用通用分享：固定封面、不带任何
  // 用户数据 —— 默认分享是当前页面截图，会把明细/统计数字一起截走。
  onShareAppMessage() {
    return share.appShare('/pages/vip/vip')
  },

  // 朋友圈分享：微信要求必须给图片，用固定封面（同样不带用户数据）
  onShareTimeline() {
    return share.timelineShare()
  },
  onLoad() {
    this.refresh()
    this.loadPrice()
  },

  onShow() {
    // 非 tabBar 页 → 只同步导航栏与页面主题，不碰 tabBar
    theme.attach(this)
    this.refresh()
  },

  refresh() {
    // 首帧用本机缓存，云端档案在 app 启动时已经拉过；回来时再同步一次
    this.setData({
      isVip: user.isVip(),
      sinceText: user.isVip() ? this.formatDay(user.vipSince()) : ''
    })
  },

  loadPrice() {
    // 价格来自云函数（价格在服务端，别在前端写死一份 —— 改价会两处漂移）
    user.createVipOrder().then(d => {
      if (d.alreadyVip) {
        this.setData({ isVip: true, sinceText: this.formatDay(user.vipSince()) })
        return
      }
      if (d.order && d.order.priceFen) {
        this.setData({ priceText: '¥' + (d.order.priceFen / 100).toFixed(0) })
      }
    }).catch(() => {
      // 拉不到价格就保持默认文案，不弹错误 —— 页面主体照常可用
    })
  },

  formatDay(ts) {
    const d = new Date(ts + 8 * 3600 * 1000)   // 显式 UTC+8（项目口径）
    return d.getUTCFullYear() + '-' +
      ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' +
      ('0' + d.getUTCDate()).slice(-2)
  },

  /** 普通用户 → 开通；会员 → 只展示权益（按钮隐藏，此函数兜底） */
  async onBuy() {
    if (this.data.isVip || this.data.paying || this.data.loading) return

    // ⚠️ 先确认、后 loading（wx.showLoading 会盖住 modal，项目踩过的坑）
    const that = this
    this.setData({ paying: true })
    wx.showModal({
      title: '开通永久会员',
      content: '￥18 一次性买断，永久有效。确认开通吗？',
      confirmText: '确认开通',
      cancelText: '再想想',
      success(res) {
        that.setData({ paying: false })
        if (res.confirm) that.doActivate()
      },
      fail() {
        that.setData({ paying: false })
      }
    })
  },

  async doActivate() {
    const seq = (this._seq || 0) + 1
    this._seq = seq
    this.setData({ loading: true })

    // 沙箱阶段：直接调激活（云函数里校验过模式）。
    // 真实支付阶段：这里换成 wx.requestPayment(payParams)，激活在服务端回调完成。
    try {
      await user.activateVip()
      if (seq !== this._seq) return

      this.setData({
        loading: false,
        isVip: true,
        sinceText: this.formatDay(user.vipSince())
      })
      wx.showToast({ title: '已开通永久会员', icon: 'success' })
    } catch (err) {
      if (seq !== this._seq) return
      console.error('开通会员失败:', err)
      this.setData({ loading: false })
      wx.showToast({ title: err.message || '开通失败，请重试', icon: 'none' })
    }
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/profile/profile' }) })
  }
})
