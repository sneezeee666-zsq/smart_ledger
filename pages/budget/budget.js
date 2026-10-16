/**
 * 预算管理
 * ===========================================================================
 * 三件事：看进度、设额度、把口径讲清楚。
 *
 * ⚠️ 页面里**不写任何算式**。所有数字（已花 / 剩余 / 剩余天数 / 每天还能花 /
 *    月末预测 / 超支分档）都来自 getStatistics 的 action:'budget'。
 *    尤其是「剩余 ÷ 剩余天数」这类派生指标：客户端按设备时间算天数，
 *    在时区被改过或系统时间不准的机器上会错得很隐蔽，而且用户无法自查
 *    （他看到的分子分母都是对的，只有商是错的）。
 *
 * 额度本身存在 users 文档的 budget 字段里（与昵称/主题同一份档案）。
 * 为什么不是"每个月存一条"？见 cloudfunctions/user/index.js 的 setBudget 说明。
 */

const theme = require('../../utils/theme.js')
const share = require('../../utils/share.js')
const user = require('../../utils/user.js')

// 档位文案。分档（safe/near/over）由**云端**判定，这里只负责翻译成人话 ——
// 阈值只定义在 cloudfunctions/getStatistics 一处，前端不复制一份，
// 否则迟早出现「首页说安全、预算页说接近」这种自相矛盾的画面。
const LEVEL_TEXT = {
  safe: '额度内',
  near: '接近额度',
  over: '已超支'
}

// 常见额度，给第一次设置的用户一个参照（不知道填多少是常态）
const PRESETS = [1000, 2000, 3000, 5000]

const RULES = [
  {
    k: 'spent',
    t: '本月已花',
    d: '本月 1 号 00:00 到今天的全部支出。只算支出，收入不计入额度消耗。'
  },
  {
    k: 'days',
    t: '已过 / 还剩天数',
    d: '按北京时间算，还剩天数**包含今天** —— 今天还没过完，今天的花销仍然算在额度里。'
  },
  {
    k: 'daily',
    t: '每天还能花',
    d: '剩余额度 ÷ 还剩天数。它是个上限参考，不是"必须花掉"。已超支时不再显示，因为负数没有意义。'
  },
  {
    k: 'forecast',
    t: '月末预测',
    d: '按本月已花的日均外推到整月，是**按当前速度的推测**，不是已经发生的事。当月不足 5 天时样本太少，不给预测。'
  }
]

Page({
  data: {
    // 当前主题（根节点 class 用；初始化即读本地值，避免首帧闪一下默认色）
    theme: theme.currentId(),

    // 云端算好的整块进度。null = 还没设过预算
    budget: null,
    levelText: '',

    // ⚠️ loaded 是必要的：没有它就没法区分「还没加载完」和「加载完了但没有预算」，
    //    两种情况都会渲染成"空状态"，用户会看到一闪而过的"还没有设置预算"。
    loaded: false,
    loadFailed: false,

    // 输入框的值（字符串）与库里的数字分开存：用户输到一半的 "30." 也得留着
    input: '',
    saving: false,

    presets: PRESETS,
    rules: RULES
  },


  // ---------------- 分享 ----------------
  // ⚠️ 必须定义 onShareAppMessage，否则右上角菜单不出现"转发"按钮，
  //    表现为用户点右上角三个点后提示"当前页面无法转发"。
  // 本页可能是隐私页（账单/我的）或过程页，只用通用分享：固定封面、不带任何
  // 用户数据 —— 默认分享是当前页面截图，会把明细/统计数字一起截走。
  onShareAppMessage() {
    return share.appShare('/pages/budget/budget')
  },

  // 朋友圈分享：微信要求必须给图片，用固定封面（同样不带用户数据）
  onShareTimeline() {
    return share.timelineShare()
  },
  onLoad() {
    // 本页不是 tabBar 页：只取主题（tabBar 配色由 tabBar 页负责同步）。
    // 第三个参数不传 —— 本页导航栏是白底黑字，与 hero 色无关。
    theme.attach(this)
    this.loadBudget()
  },

  onShow() {
    theme.attach(this)
  },

  onPullDownRefresh() {
    this.loadBudget().then(() => wx.stopPullDownRefresh())
  },

  // ---------------- 读取 ----------------

  loadBudget() {
    return wx.cloud.callFunction({
      name: 'getStatistics',
      data: { action: 'budget' }
    }).then(res => {
      const r = (res && res.result) || {}
      if (r.code !== 0 || !r.data) throw new Error(r.message || '读取预算失败')

      const b = r.data.budget || null

      this.setData({
        budget: b,
        levelText: b ? (LEVEL_TEXT[b.level] || '') : '',
        loaded: true,
        loadFailed: false,
        // 已设过就回填当前额度（方便微调）；没设过留空 ——
        // 预填一个 0 会让用户以为"先把 0 改掉"才能用
        input: b ? String(b.amount) : ''
      })
    }).catch(err => {
      console.error('读取预算失败:', err)
      // 失败时如实说读不到，不塞一个 0 元进度条冒充成功
      this.setData({ budget: null, levelText: '', loaded: true, loadFailed: true })
    })
  },

  // ---------------- 输入 ----------------

  onInput(e) {
    this.setData({ input: e.detail.value })
  },

  onPresetTap(e) {
    this.setData({ input: String(e.currentTarget.dataset.amount) })
  },

  // ---------------- 保存 ----------------

  save() {
    return this.saveAmount(this.data.input)
  },

  /**
   * 取消预算：清掉一个用户设过的值，先问一句。
   * ⚠️ 顺序必须是「先确认、后 loading」—— showLoading 带 mask 会盖在
   *    showModal 之上，用户点不到按钮，看起来像卡死（本项目踩过）。
   */
  async clearBudget() {
    const ok = await this.confirm('取消每月预算？', '取消后首页的预算进度条会一起消失，随时可以重新设置。')
    if (!ok) return

    await this.saveAmount('')
  },

  async saveAmount(raw) {
    // 闸门：防止连点两下写出两次请求
    if (this.data.saving) return

    // 前端校验只为了输入时就能拦住明显写错的；真正说了算的是云函数
    const v = user.validateBudget(raw)
    if (!v.ok) {
      wx.showToast({ title: v.message, icon: 'none' })
      return
    }

    this.setData({ saving: true })

    try {
      await user.setBudget(v.value)
      // 存完必须**重新拉一次**进度，不能只把本地那个数字改掉：
      // 额度一变，「每天还能花」「已用百分比」「超支分档」全都要跟着变，
      // 只改额度会留下"额度已是 5000、进度条还按 3000 算"的画面。
      await this.loadBudget()

      wx.showToast({
        title: v.value > 0 ? '已保存' : '已取消预算',
        icon: 'success'
      })
    } catch (err) {
      console.error('保存预算失败:', err)
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  confirm(title, content) {
    return new Promise(resolve => {
      wx.showModal({
        title: title,
        content: content,
        confirmText: '确定',
        cancelText: '再想想',
        success: res => resolve(!!res.confirm),
        fail: () => resolve(false)
      })
    })
  }
})
