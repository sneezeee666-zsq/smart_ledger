/**
 * 首页
 *
 * 统计口径：本月 = 本月 1 号 00:00:00 ~ 今天 23:59:59.999（北京时间），
 * 全部由 getStatistics 云函数聚合 —— 客户端 db.get() 单次最多 20 条，
 * 在前端求和会漏记录。
 */

const theme = require('../../utils/theme.js')
const share = require('../../utils/share.js')
const user = require('../../utils/user.js')
const greet = require('../../utils/greeting.js')
const db = wx.cloud.database()

const BJ_OFFSET = 8 * 60 * 60 * 1000
const WEEK_DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 取当前北京时间（不依赖设备时区）
function bjNow() {
  return new Date(Date.now() + BJ_OFFSET)
}

Page({
  data: {
    // 当前主题（根节点 class 用；初始化即读本地值，避免首帧闪一下默认色）
    theme: theme.currentId(),

    greeting: greet.build(bjNow().getUTCHours(), user.nickname()),
    dateText: '',

    // 昵称：首帧同步读本机缓存（见 utils/user.js），所以不会「先空一下再出现」
    nickname: user.nickname(),

    monthData: {
      income: 0,
      expense: 0,
      balance: 0
    },

    weekTrend: [],
    trendIndex: -1,   // 当前选中的柱子（默认最后一天 = 今天）
    trendTip: null,

    recentBills: [],

    // 半屏快捷记账面板是否展开（点「记一笔」弹它，不跳整页）
    quickAddVisible: false,

    // 本月预算进度（getStatistics 算好的整块，页面一个算式都不写）。
    // null = 还没设过预算 → 进度条整块不渲染，不摆一条 0/0 的假进度
    budget: null,

    loading: false,
    firstLoaded: false
  },


  // ---------------- 分享 ----------------
  // ⚠️ 必须定义 onShareAppMessage，否则右上角菜单不出现"转发"按钮，
  //    表现为用户点右上角三个点后提示"当前页面无法转发"。
  // 本页可能是隐私页（账单/我的）或过程页，只用通用分享：固定封面、不带任何
  // 用户数据 —— 默认分享是当前页面截图，会把明细/统计数字一起截走。
  onShareAppMessage() {
    return share.appShare('/pages/index/index')
  },

  // 朋友圈分享：微信要求必须给图片，用固定封面（同样不带用户数据）
  onShareTimeline() {
    return share.timelineShare()
  },
  onLoad() {
    // 原生导航栏与 hero 同色：index.json 里写的是默认主题（绿）的值，
    // 用户换了主题就得在首帧之前纠回来，否则会先闪一下绿再跳成目标色。
    theme.syncNavBar(false)

    // 请求序号：下拉刷新 / 切回本页可能连着触发，上一次请求可能还在路上。
    // 只有最新一次的结果才允许写进 data（否则旧响应会把新数字覆盖回去）。
    this._seq = 0

    this.setGreeting()
    this.setDateText()
    this.loadIndexData()
    this.loadRecentBills()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    // 主题：本页是 tabBar 页 → 同步原生 tabBar；
    // 本页 hero 顶到导航栏 → 同时同步导航栏配色（第三个参数）
    theme.attach(this, true, true)
    // 昵称可能刚在「我的」里改过，或者云端这次才拉回来
    this.refreshNickname()
    // 回到首页时要一起刷新「最近交易」：
    // 手动记一笔或导入账单后返回，只刷统计会让列表停留在旧数据。
    this.loadIndexData()
    this.loadRecentBills()
  },

  onPullDownRefresh() {
    Promise.all([this.loadIndexData(), this.loadRecentBills()])
      .then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh())
  },

  // ---------------- 文案 ----------------

  /**
   * 昵称：先用本机缓存同步渲染（不闪），再让云端结果回来时纠一次。
   * 缓存里有名字说明之前同步过，多数情况下两者一致，不会有可见跳变。
   */
  refreshNickname() {
    const apply = (p) => {
      const nick = (p && p.nickname) || ''
      if (nick === this.data.nickname) return
      this.setData({ nickname: nick })
      this.setGreeting()
    }

    apply(user.current())

    // 序号防乱序：连点几次 tab 时只认最后一次的结果
    const seq = (this._userSeq || 0) + 1
    this._userSeq = seq
    user.load().then(p => {
      if (seq !== this._userSeq) return
      apply(p)
    })
  },

  /**
   * 问候语 = 时段 + 昵称。
   * 拼接规则收在 utils/greeting.js（那里有测试守着「昵称空时不拼逗号」，
   * 见 tests/user-test.js）—— 页面里不要再拼一次。
   */
  setGreeting() {
    this.setData({ greeting: greet.build(bjNow().getUTCHours(), this.data.nickname) })
  },

  setDateText() {
    const d = bjNow()
    this.setData({
      dateText: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK_DAYS[d.getUTCDay()]}`
    })
  },

  // ---------------- 数据 ----------------

  async loadIndexData() {
    const seq = ++this._seq
    this.setData({ loading: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'getStatistics',
        data: { action: 'indexData' }
      })

      // 已有更新的请求发出去了：本次结果作废（否则会把新数据覆盖回旧数字）
      if (seq !== this._seq) return

      const result = res.result || {}
      if (result.code !== 0 || !result.data) {
        throw new Error(result.message || '统计失败')
      }

      const { monthSummary, weekTrend, budget } = result.data
      const trend = weekTrend || []
      const last = trend.length - 1

      this.setData({
        monthData: {
          income: monthSummary.income || 0,
          expense: monthSummary.expense || 0,
          balance: monthSummary.balance || 0
        },
        weekTrend: trend,
        trendIndex: last,
        trendTip: this.buildTip(trend, last),
        budget: budget || null,
        loading: false,
        firstLoaded: true
      })
    } catch (err) {
      if (seq !== this._seq) return
      console.error('加载首页统计失败:', err)
      // 失败时归零而不是塞假数据，避免误导
      this.setData({
        monthData: { income: 0, expense: 0, balance: 0 },
        weekTrend: [],
        trendIndex: -1,
        trendTip: null,
        budget: null,
        loading: false,
        firstLoaded: true
      })
    }
  },

  // 客户端取 10 条（未超过 20 条上限，可前端直查）
  async loadRecentBills() {
    try {
      const res = await db.collection('bills')
        .orderBy('createTime', 'desc')
        .limit(10)
        .get()

      this.setData({ recentBills: res.data || [] })
    } catch (err) {
      console.error('加载最近账单失败:', err)
      this.setData({ recentBills: [] })
    }
  },

  // ---------------- 趋势图 ----------------

  buildTip(trend, index) {
    const t = trend[index]
    if (!t) return null

    const n = trend.length
    let label = `${t.day}日`
    if (index === n - 1) label = '今天'
    else if (index === n - 2) label = '昨天'

    return { label, income: t.income || 0, expense: t.expense || 0 }
  },

  onTrendTap(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (index === this.data.trendIndex) return

    this.setData({
      trendIndex: index,
      trendTip: this.buildTip(this.data.weekTrend, index)
    })
  },

  // ---------------- 导航 ----------------

  goToImport() {
    wx.navigateTo({ url: '/pages/import/import' })
  },

  // 记一笔：改为弹半屏面板，不再跳整页 —— "补记零星一笔"不该打断首页上下文。
  // 想在面板里填支付方式/时间时，面板底部有「更多选项」进完整页。
  goToAddBill() {
    this.setData({ quickAddVisible: true })
  },

  closeQuickAdd() {
    this.setData({ quickAddVisible: false })
  },

  // 快捷记账成功：面板自己会关，这里只负责把首页的数字刷新掉
  onQuickAddDone() {
    this.setData({ quickAddVisible: false })
    this.loadIndexData()
    this.loadRecentBills()
  },

  goToStats() {
    wx.switchTab({ url: '/pages/stats/stats' })
  },

  goToBills() {
    wx.switchTab({ url: '/pages/bills/bills' })
  },

  // 预算管理不是 tabBar 页，用 navigateTo（能返回首页）
  goToBudget() {
    wx.navigateTo({ url: '/pages/budget/budget' })
  },

  onBillTap() {
    wx.switchTab({ url: '/pages/bills/bills' })
  }
})
