/**
 * 消费分析（规则引擎版）
 * ===========================================================================
 * ⚠️ **这一页刻意不做成「AI 分析」**（2026-10 审核整改后定稿）：
 *    微信官方口径：「AI 问答涉及深度合成技术，需补充【深度合成-AI 问答】服务类目；
 *    个人主体尚未开放该类目」。审核按**界面实际内容**判定，不看代码注释 ——
 *    只要页面上有「AI / 智能 / 深度思考」这类表征，或长得像「提问 → 出结论」，
 *    就会被判为深度合成。所以这里：
 *      · 全页不出现「AI / 智能」字样；「分析」是记账类的常规功能名可以保留
 *      · **不做「模拟思考」的等待**（曾经故意停 3~10 秒装成在思考，那是最像 AI 的地方）
 *
 *    ⚠️ **结论措辞不走"最保守"路线**：提醒口径（「要注意 / 可以省」）与建议句
 *    （「建议开启节流模式」等）是产品价值所在，保留 —— 它们不含 AI 表征，
 *    也不构成"生成式内容"，只是把算出来的数字用人话说一遍。
 *
 *    数字全部由云端 insight.js 的规则算出（纯函数、可离线单测），不接任何模型：
 *    每个数字都能在 evidence 里逐项核对，与项目「派生指标必须可核对」是同一条铁律。
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
// ⚠️ 描述里写清"和谁比"：rolling（滚动 N 天）与 natural month（自然月）是两套窗口，
//    不写清的话用户会把「本月比上月多花」当成「近 30 天比前 30 天多花」。
const DIMENSIONS = [
  { key: 'budget', title: '预算进度', desc: '按当前花法本月会不会超、还剩多少' },
  { key: 'moonlight', title: '月光预警', desc: '花得比时间快，几号会花光预算' },
  { key: 'mom', title: '跨月对比', desc: '本月与上月同期比，日均多了还是少了' },
  { key: 'trend', title: '日均涨跌', desc: '最近这段与紧邻的前一段比（等长窗口）' },
  { key: 'structure', title: '消费结构', desc: '钱主要压在哪个类目上' },
  { key: 'catMom', title: '类目变化', desc: '哪个类目把本月的差距拉开的' },
  { key: 'fixed', title: '固定支出', desc: '每月都会扣的那几笔，加起来多少' },
  { key: 'night', title: '深夜消费', desc: '半夜的冲动消费占了多大比例' },
  { key: 'large', title: '大额支出', desc: '单笔明显偏高、集中在哪一类' },
  { key: 'small', title: '小额高频', desc: '单笔不大但次数多的那部分' },
  { key: 'merchant', title: '常去的地方', desc: '哪个商户拿走了最多钱' },
  { key: 'weekend', title: '周末效应', desc: '周末和工作日花得差多少' },
  { key: 'habit', title: '记账连续性', desc: '有没有连着几天没记、可能漏记' }
]

// 统计范围两档：近 7 天 / 近 30 天（与云端 INSIGHT_SCOPES 一致）
const SCOPES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' }
]

// 统计范围说明（hero 卡里那行小字）。
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
    // 自定义主题的 13 个令牌（内置主题为 ''，令牌都在 app.wxss 的 .theme-<id> 里）
    themeStyle: theme.rootStyle(),

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
  },

  /** 切换统计范围（近 7 天 / 近 30 天） */
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
   * 开始分析
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
      if (result.code !== 0 || !result.data) {
        throw new Error(result.message || '生成失败')
      }

      const scopeDaysOut = (result.data.scope && result.data.scope.days) || scopeDays

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
      wx.showToast({ title: '分析失败，请重试', icon: 'none' })
    }
  }
})