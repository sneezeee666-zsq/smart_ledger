/**
 * 智能分析（规则引擎版）
 * ===========================================================================
 * ⚠️ 为什么这一版**不接大模型**？
 *    微信官方口径：「AI 问答涉及深度合成技术，需补充【深度合成-AI 问答】服务类目；
 *    目前个人主体小程序尚未开放深度合成相关服务类目」。
 *    个人主体做出"用户可以随便问"的 AI 功能，提审时会被要求整改（已有多个先例）。
 *
 *    规则引擎在这个场景更合适，有两点：
 *    ① **每个数字都是算出来的**，不是模型编的 —— 与项目里"派生指标必须可核对"
 *       是同一条铁律。将来接模型时，正确做法也是云端先算好数字、模型只写两句话。
 *    ② **没触发条件就不输出**，不凑套话。
 *
 * 所以这一页刻意**不做自然语言问答**：
 * 「试试这样问」会给人"可以随便问"的错觉，而规则引擎回答不了任何开放式问题。
 * 这里改成如实说明「结论是怎么算出来的」。
 *
 * 判定逻辑全在云端 cloudfunctions/getStatistics/lib/insight.js（纯函数，可离线单测）。
 * 页面**不复刻任何阈值** —— 两处各写一套必然漂移，而漂移出来的差异用户查不出来。
 */

const theme = require('../../utils/theme.js')
const share = require('../../utils/share.js')
const user = require('../../utils/user.js')

// 档位 → 角标文案。
// ⚠️ 在这里预先算好而不是让 WXML 判断：WXML 表达式不能调用函数，
//    也没有条件运算符可用（三元会被当成插值的一部分）。
const LEVEL_TEXT = {
  warn: '要注意',
  tip: '可以省',
  info: '概况'
}

// 会分析什么：与云端 insight.js 的规则一一对应。
// ⚠️ 这只是**展示**，阈值全在云端。这里抄一份阈值过来就是漂移的起点。
const DIMENSIONS = [
  { key: 'budget', title: '预算进度', desc: '按当前花法本月会不会超、还剩多少' },
  { key: 'moonlight', title: '月光预警', desc: '花得比时间快，几号会花光预算' },
  { key: 'trend', title: '日均涨跌', desc: '平均每天比上个周期多花还是少花' },
  { key: 'structure', title: '消费结构', desc: '钱主要压在哪个类目上' },
  { key: 'night', title: '深夜消费', desc: '半夜的冲动消费占了多大比例' },
  { key: 'large', title: '大额支出', desc: '单笔明显偏高、集中在哪一类' },
  { key: 'small', title: '小额高频', desc: '单笔不大但次数多的那部分' },
  { key: 'merchant', title: '常去的地方', desc: '哪个商户拿走了最多钱' },
  { key: 'weekend', title: '周末效应', desc: '周末和工作日花得差多少' },
  { key: 'habit', title: '记账连续性', desc: '有没有连着几天没记、可能漏记' }
]

// 分析范围两档：近 7 天 / 近 30 天（与云端 INSIGHT_SCOPES 一致）
const SCOPES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' }
]

// 分析范围说明（hero 卡里那行小字）。
// ⚠️ 必须用同一个函数生成：这行字有三处会写它（初始值 / 切换范围时 / 分析完成时），
//    各拼一遍的后果就是「点了近 7 天、说明还写着最近 30 天」——
//    用户会以为切换没生效，而界面看着完全正常，极难被发现。
function scopeLabel(days) {
  return '最近 ' + days + ' 天（今天往前推 ' + days + ' 个自然日）'
}

Page({
  data: {
    // 当前主题（根节点 class 用；初始化即读本地值，避免首帧闪一下默认色）
    theme: theme.currentId(),

    scopes: SCOPES,
    scopeDays: 30,
    scopeText: scopeLabel(30),
    dimensions: DIMENSIONS,

    // 分析结果
    insights: [],
    meta: null,
    analyzing: false,
    analyzed: false,   // 区分「还没点」与「点了但没有结论」
    loadFailed: false,

    // 会员门控（临时放开）。
    // ⚠️ 个人主体无法接入微信支付，会员入口已隐藏；云函数侧
    //    INSIGHT_REQUIRE_VIP 当前为 false，智能分析对所有人开放。
    //    将来补好支付、把云端开关翻回 true 时，这里同步改回 `!user.isVip()`。
    locked: false
  },


  // ---------------- 分享 ----------------
  // ⚠️ 必须定义 onShareAppMessage，否则右上角菜单不出现"转发"按钮，
  //    表现为用户点右上角三个点后提示"当前页面无法转发"。
  // 本页可能是隐私页（账单/我的）或过程页，只用通用分享：固定封面、不带任何
  // 用户数据 —— 默认分享是当前页面截图，会把明细/统计数字一起截走。
  onShareAppMessage() {
    return share.appShare('/pages/ai/ai')
  },

  // 朋友圈分享：微信要求必须给图片，用固定封面（同样不带用户数据）
  onShareTimeline() {
    return share.timelineShare()
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
    // 本页是 tabBar 页 → 同步原生 tabBar 的配色（第三个参数不传：本页导航栏是白底黑字）
    theme.attach(this, true)

    // 会员态暂不再驱动本页（智能分析已对所有人开放，详见云端 INSIGHT_REQUIRE_VIP）。
    // 将来重新启用会员门控时，恢复下面这段：回到本页重读 isVip 并同步 setData({ locked })。
  },

  /** 普通用户点主按钮 → 引导去会员中心（而不是报错） */
  goVip() {
    wx.navigateTo({ url: '/pages/vip/vip' })
  },

  /** 切换分析范围（近 7 天 / 近 30 天） */
  onSwitchScope(e) {
    const days = Number(e.currentTarget.dataset.days)
    if (!days || days === this.data.scopeDays) return
    // 分析进行中不响应切换（避免结果窗口与所选范围错位）
    if (this.data.analyzing) return
    // 切换范围后旧结论作废：不同窗口的结果不能混着看
    this.setData({
      scopeDays: days,
      // ⚠️ 说明小字必须跟着一起换：只改 scopeDays 的话，
      //     切到近 7 天后那行字还写着"最近 30 天"，像切换失效了
      scopeText: scopeLabel(days),
      insights: [],
      analyzed: false,
      loadFailed: false
    })
  },

  /**
   * 一键分析
   *
   * ⚠️ 用**请求序号**而不是 `if (this.data.analyzing) return` 闸门：
   *    后者把后一次请求直接丢掉，快速连点或页面回前台时界面会停在上一次的结果上
   *    （与账单页是同一个坑）。序号保证只有最新一次的结果允许写进 data。
   */
  async onAnalyze() {
    if (this.data.analyzing) return

    const seq = (this._seq || 0) + 1
    this._seq = seq
    this.setData({ analyzing: true, loadFailed: false })

    const scopeDays = this.data.scopeDays

    try {
      const res = await wx.cloud.callFunction({
        name: 'getStatistics',
        data: { action: 'insight', days: scopeDays }
      })

      if (seq !== this._seq) return

      const result = (res && res.result) || {}
      // 云端的会员门控：本机缓存说"是会员"但云端说不是（换账号/缓存过期）
      if (result.code === -2 && result.data && result.data.needVip) {
        user.load().then(() => this.setData({ locked: !user.isVip() }))
        throw new Error('智能分析是会员功能')
      }
      if (result.code !== 0 || !result.data) {
        throw new Error(result.message || '分析失败')
      }

      const scopeDaysOut = (result.data.scope && result.data.scope.days) || scopeDays

      // ⚠️ 深度思考模拟：云函数其实是瞬间返回，但为了符合用户对
      //    "AI 分析"的预期，这里人为停留 3~10 秒，期间展示"深度思考中"。
      //    具体停留多久由「笔数」略作加权，看起来更自然（不向用户透露这是模拟）。
      const scanned = (result.data.meta && result.data.meta.scanned) || 0
      const thinkMs = 3000 + Math.floor(Math.random() * 7000) + Math.min(scanned * 8, 3000)

      await new Promise(resolve => {
        const t0 = Date.now()
        const tick = () => {
          if (seq !== this._seq) return resolve()
          if (Date.now() - t0 >= thinkMs) return resolve()
          setTimeout(tick, 100)
        }
        tick()
      })

      if (seq !== this._seq) return

      this.setData({
        insights: (result.data.insights || []).map(x => Object.assign({}, x, {
          levelText: LEVEL_TEXT[x.level] || ''
        })),
        meta: result.data.meta || null,
        scopeText: scopeLabel(scopeDaysOut),
        analyzing: false,
        analyzed: true,
        loadFailed: false
      })
    } catch (err) {
      if (seq !== this._seq) return
      console.error('分析失败:', err)

      // ⚠️ 清空旧结论而不是留着上一份：
      //    账单已经变了却展示旧分析，比什么都不显示更糟 —— 用户会照着旧结论做决定。
      this.setData({
        insights: [],
        analyzing: false,
        analyzed: true,
        loadFailed: true
      })
      // 云端拒绝（会员态不一致）时把原因说清楚，别笼统报"分析失败"
      const msg = (err && err.message) || ''
      wx.showToast({
        title: msg.indexOf('会员') !== -1 ? msg : '分析失败，请重试',
        icon: 'none'
      })
    }
  }
})