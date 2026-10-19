/**
 * 常记的（配置页）
 *
 * 首页「记一笔」面板上那排 chips 就是这里的列表。三件事：
 *   1. **拖动排序**：长按进入拖拽态，松手落位；另有 ↑↓ 作为兜底
 *      （个别机型长按后系统手势会抢走触摸，纯拖动会失效）
 *   2. **增删**：从"根据账单推荐"里一键加，或手动填对方名 + 金额
 *   3. **自动保存**：每次改完立刻写云端，不用点"确认"
 *
 * 几个关键取舍：
 *   - 保存是**整套覆盖**（不是增删单条）：排序本质上是"整个顺序都变了"，
 *     逐条增删表达不了顺序。详见 cloudfunctions/user 的 setQuickPicks。
 *   - 保存失败要**回滚界面**：否则用户看到"已经改了"，下次进来又变回去。
 *   - 从没配置过时，列表初始为"按账单推荐的前 10 个" —— 一进页面就有东西可拖，
 *     而不是面对一个空列表。用户任何一次修改都会把它变成"已配置"。
 */

const theme = require('../../utils/theme.js')
const share = require('../../utils/share.js')
const user = require('../../utils/user.js')
const qp = require('../../utils/quick-picks.js')

Page({
  data: {
    theme: theme.currentId(),

    limit: qp.LIMIT,
    titleMax: qp.TITLE_MAX,

    list: [],
    recs: [],
    // 每项的竖向位移（px）。WXML 里不能调函数算，只能预先算好放数组里
    offsets: [],

    dragIndex: -1,
    dragY: 0,
    dragging: false,     // 拖拽中要关掉 scroll-view 的滚动

    draftTitle: '',
    draftAmount: '',
    draftType: 'expense',

    saving: false,
    loaded: false
  },

  onLoad() {
    theme.attach(this)

    // 单项步进（96rpx 高 + 上下各 6rpx 外边距 = 108rpx）
    const w = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).windowWidth || 375
    this._rpx = w / 750
    this._step = 108 * this._rpx

    this.loadAll()
  },

  onShow() {
    theme.attach(this)
  },

  // ==================== 加载 ====================

  async loadAll() {
    // 1) 本机/云端的用户配置。null = 从没配置过
    const mine = user.quickPicks()

    // 2) 按账单的推荐（forceAuto 强制走自动聚合，即使已经配置过也要拿推荐当候选）
    let recs = []
    try {
      const res = await wx.cloud.callFunction({
        name: 'getStatistics',
        data: { action: 'quickPicks', forceAuto: true }
      })
      const r = (res && res.result) || {}
      recs = (r.code === 0 && r.data && r.data.picks) || []
    } catch (err) {
      console.warn('推荐加载失败（不影响手动配置）:', err)
    }

    // 从没配过 → 用推荐的前 N 个作为初始列表，一进页面就有东西可拖
    const list = qp.normalizeList(mine !== null ? mine : recs.slice(0, qp.LIMIT))

    // 推荐里已经在列表中的不再展示
    const rest = recs.filter(r => !qp.has(list, r))

    this.setData({
      list: withKey(list),
      offsets: list.map(() => 0),
      recs: withKey(rest),
      loaded: true
    })
  },

  // ==================== 保存（带回滚） ====================

  /**
   * 写云端。失败时把界面回滚到修改前 —— 否则用户看到"已经改了"，
   * 下次进来又变回去，会以为这个功能坏了。
   *
   * @param {Array} next 修改后的列表
   */
  async persist(next) {
    const prev = this.data.list

    this.setData({
      list: withKey(next),
      offsets: next.map(() => 0),
      dragIndex: -1,
      dragY: 0,
      dragging: false,
      saving: true
    })

    try {
      // 存之前去掉只用于渲染的 key 字段
      await user.setQuickPicks(qp.normalizeList(next))
      this.setData({ saving: false })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none' })
      this.setData({ list: prev, saving: false })
    }
  },

  // ==================== 拖动排序 ====================

  onLongPress(e) {
    if (this.data.list.length < 2) return
    const index = Number(e.currentTarget.dataset.index)
    if (isNaN(index)) return

    this._startY = (e.touches && e.touches[0] ? e.touches[0].clientY : 0)
    // 轻微振动：让用户知道"已经进入拖拽态"（否则只是长按没反应会以为卡住）
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })

    this.setData({
      dragIndex: index,
      dragY: 0,
      dragging: true,
      offsets: this.data.list.map(() => 0)
    })
  },

  onTouchMove(e) {
    const from = this.data.dragIndex
    if (from < 0) return

    const y = e.touches && e.touches[0] ? e.touches[0].clientY : this._startY
    const dy = y - this._startY
    const len = this.data.list.length
    const to = clamp(from + Math.round(dy / this._step), 0, len - 1)

    // 其他项给一个反向位移，视觉上"让出空位"
    const offsets = this.data.list.map((_, i) => {
      if (i === from) return 0
      if (from < to && i > from && i <= to) return -this._step
      if (from > to && i >= to && i < from) return this._step
      return 0
    })

    this.setData({ dragY: dy, offsets })
  },

  onTouchEnd() {
    const from = this.data.dragIndex
    if (from < 0) return

    const len = this.data.list.length
    const to = clamp(from + Math.round(this.data.dragY / this._step), 0, len - 1)

    // 先收起拖拽态（位移归零），再按需保存
    this.setData({ dragIndex: -1, dragY: 0, dragging: false, offsets: this.data.list.map(() => 0) })

    if (to !== from) this.persist(qp.move(this.data.list, from, to))
  },

  /** ↑↓ 兜底排序（长按拖动被系统手势打断时用） */
  onMove(e) {
    const index = Number(e.currentTarget.dataset.index)
    const dir = Number(e.currentTarget.dataset.dir)
    if (isNaN(index) || isNaN(dir)) return

    const to = index + dir
    if (to < 0 || to >= this.data.list.length) return
    this.persist(qp.move(this.data.list, index, to))
  },

  // ==================== 删除 / 添加 ====================

  onDelete(e) {
    const index = Number(e.currentTarget.dataset.index)
    if (isNaN(index)) return
    this.persist(qp.removeAt(this.data.list, index))
  },

  /** 从推荐里加一条 */
  onAddRec(e) {
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.recs[index]
    if (!item) return

    const r = qp.add(this.data.list, item)
    if (!r.ok) return this.toastFail(r.reason)

    // 加进列表后，从推荐里移除（不能重复添加）
    const recs = this.data.recs.slice()
    recs.splice(index, 1)
    this.setData({ recs })
    this.persist(r.list)
  },

  /** 手动添加 */
  onAddDraft() {
    const r = qp.add(this.data.list, {
      title: this.data.draftTitle,
      amount: this.data.draftAmount,
      type: this.data.draftType
    })
    if (!r.ok) return this.toastFail(r.reason)

    this.setData({ draftTitle: '', draftAmount: '' })
    this.persist(r.list)
  },

  toastFail(reason) {
    const MSG = {
      invalid: '请填写对方名和有效金额',
      duplicate: '这个已经加过了',
      full: '最多 ' + qp.LIMIT + ' 个'
    }
    wx.showToast({ title: MSG[reason] || '添加失败', icon: 'none' })
  },

  // ==================== 表单输入 ====================

  onDraftTitle(e) {
    this.setData({ draftTitle: String(e.detail.value || '') })
  },

  onDraftAmount(e) {
    // 与快捷记账面板同一套清洗：最多两位小数
    let v = String(e.detail.value || '').replace(/[^\d.]/g, '')
    const dot = v.indexOf('.')
    if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, 2)
    this.setData({ draftAmount: v })
  },

  onDraftType(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.draftType) return
    this.setData({ draftType: type })
  },

  // ==================== 分享（每页都要有，见静态检查第 21 组） ====================

  onShareAppMessage() {
    return share.appShare('/pages/index/index')
  },

  onShareTimeline() {
    return share.timelineShare()
  }
})

// ==================== 工具 ====================

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v)
}

/**
 * 给每项补一个渲染用的 key。
 * ⚠️ wx:key 必须稳定且唯一：用「收支|对方」而不是下标 ——
 *    拖动排序后下标全变了，用下标当 key 会让小程序复用错节点，
 *    表现是"拖完之后文字和金额串行了"。
 */
function withKey(list) {
  return (Array.isArray(list) ? list : []).map(x => Object.assign({}, x, { key: qp.keyOf(x) }))
}
