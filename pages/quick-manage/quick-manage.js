/**
 * 常记的（配置页）
 *
 * 首页「记一笔」面板上那排 chips 就是这里配的。两种来源，由用户显式选择：
 *   - **使用推荐配置**（auto）：云端按近 90 天账单自动聚合，只读
 *     （每天跟着消费习惯变，用户不用管）
 *   - **使用手动配置**（manual）：自己配的列表，可增删、可拖动排序
 *
 * ⚠️ 为什么用显式字段存「来源」，而不是靠"列表存不存在"推断：
 *    后者表达不了「用户选了推荐模式，但以前配过的列表还要留着」——
 *    切回手动时应该能恢复之前的列表，而不是从零再配一遍。
 *
 * ⚠️ 为什么手动列表和展示列表分开两份（myList / list）：
 *    auto 模式下展示的是推荐内容，但那**不能覆盖**用户手配的列表。
 *    混成一份的话，用户看一眼推荐模式，手配的列表就被冲掉了。
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

    // 'auto' 用推荐 | 'manual' 用手配
    mode: 'auto',

    myList: [],       // 用户手动配的（切到推荐时不覆盖它）
    autoPicks: [],    // 云端推荐（只读）
    list: [],         // 当前展示 = auto ? autoPicks : myList
    recs: [],         // 手动模式下"推荐里还没加进列表"的候选

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
    const mine = user.quickPicks()          // null = 从没配过
    const mode = user.quickPicksMode()      // 'auto' | 'manual'

    // 推荐内容：forceAuto 强制走自动聚合（即使当前是手动模式也要拿它当候选）
    let recsRaw = []
    try {
      const res = await wx.cloud.callFunction({
        name: 'getStatistics',
        data: { action: 'quickPicks', forceAuto: true }
      })
      const r = (res && res.result) || {}
      recsRaw = (r.code === 0 && r.data && r.data.picks) || []
    } catch (err) {
      console.warn('推荐加载失败（不影响手动配置）:', err)
    }

    const autoPicks = qp.normalizeList(recsRaw)
    const myList = qp.normalizeList(mine || [])
    const shown = mode === 'auto' ? autoPicks : myList

    this.setData({
      mode,
      autoPicks: withKey(autoPicks),
      myList: withKey(myList),
      list: withKey(shown),
      recs: withKey(recsOf(autoPicks, myList)),
      offsets: shown.map(() => 0),
      // ⚠️ 重新同步时要把拖拽态一起复位：拖拽中 `dragging` 是 true，
      //    而它是 `scroll-y="{{!dragging}}"` 的开关 —— 忘了复位就等于
      //    页面永远不能滚动（看起来又是一次"卡死"）。
      dragIndex: -1,
      dragY: 0,
      dragging: false,
      loaded: true
    })
  },

  // ==================== 来源切换 ====================

  /**
   * 切换「推荐 / 手动」。
   *
   * - 切到推荐：**只存来源，不动手动列表** —— 切回来能恢复之前的配置
   * - 切到手动：如果手配列表还是空的，就把当前展示的推荐当作起点
   *   （否则用户切过来看到空列表，还得一条条加回来）
   *
   * ⚠️ 界面先切、再异步落库（乐观更新）：等云端回来才切的话，
   *    一次切换要空一下才响应，用户会以为没点上、接着连点。
   * ⚠️ **不能因为 saving 就把点击丢掉**（见 persist 里的串行队列）：
   *    上一版这里是 `if (mode === this.data.mode || this.data.saving) return`，
   *    保存稍慢时用户点的那一下被静默吞掉，界面停在他不要的那个模式上 ——
   *    表现就是"切不过去、卡死了"。
   */
  onMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.mode) return

    if (mode === 'auto') {
      const shown = this.data.autoPicks
      this.setData({
        mode: 'auto',
        list: shown,
        offsets: shown.map(() => 0),
        dragIndex: -1,
        dragY: 0,
        dragging: false
      })
      this.persist(null, 'auto')
      return
    }

    let next = this.data.myList
    if (next.length === 0 && this.data.autoPicks.length > 0) {
      next = this.data.autoPicks.slice(0, qp.LIMIT)
    }
    this.applyManual(next, 'manual')
  },

  // ==================== 保存（失败后以云端为准回滚） ====================

  /**
   * 写云端。
   *
   * **串行队列**而不是直接并发：连点切换时多个 setQuickPicks 同时在飞，
   * 到达顺序无法保证 —— 可能出现"最后点的那个先落地、又被先发的旧值覆盖"，
   * 于是界面显示推荐、云端存着手动，下次进来又变了。
   * 串行之后顺序 = 点击顺序，最后落地的一定是用户最后选的那个。
   *
   * @param {Array|null} list 传 null = 只切来源、不动列表
   * @param {string} mode 'auto' | 'manual'
   */
  persist(list, mode) {
    const task = () => user.setQuickPicks(
      list === null ? null : qp.normalizeList(list),
      mode
    )

    this._pending = (this._pending || 0) + 1
    this.setData({ saving: true })

    // 上一笔失败也要继续执行下一笔（then(task, task) 而不是 then(task)）
    this._chain = (this._chain || Promise.resolve())
      .then(task, task)
      .then(
        () => this.settleSave(null),
        err => this.settleSave(err)
      )
  },

  /**
   * 一笔写完了。**队列全部排空才收尾**，否则第一笔回来就把 saving 关掉，
   * 后面还在飞的那几笔就失去了「保存中」的提示。
   */
  settleSave(err) {
    if (err) this._saveErr = err

    this._pending = Math.max(0, (this._pending || 1) - 1)
    if (this._pending > 0) return

    this.setData({ saving: false })

    const e = this._saveErr
    if (!e) return
    this._saveErr = null

    wx.showToast({ title: (e && e.message) || '保存失败，请重试', icon: 'none' })
    // ⚠️ 回滚 = **重新从云端读真值**，不是恢复本地快照：
    //    快照是"这一次点击之前"的样子，连点几次后它可能已经过期，
    //    拿它覆盖界面会把用户后来的操作也一起抹掉。
    //    另外"报错了但云端其实写成功了"（超时重传）也只能靠读回来纠正。
    user.load(true).then(() => this.loadAll())
  },

  /**
   * 改手动列表并保存。
   *
   * ⚠️ **必须把 mode 一起写进 data**：上一版这里只换了 list 没换 mode，
   *    于是「切换条」还高亮在推荐、列表却已经是手动的内容，
   *    而编辑入口的 `wx:if="{{mode === 'manual'}}"` 全被隐藏 ——
   *    用户看到的是"列表是手动的、但什么都不能改、切也切不动"。
   *    这个 bug 只在 auto → manual → auto 之后暴露，因为第一次切到手动时
   *    界面恰好还能看（list 换了），再点推荐又被 mode === this.data.mode 挡住。
   *
   * @param {Array} next 新的手动列表
   * @param {string} [mode] 不传则用 'manual'
   */
  applyManual(next, mode) {
    const list = qp.normalizeList(next)
    const myList = withKey(list)
    this.setData({
      mode: mode || 'manual',
      myList,
      list: myList,
      recs: withKey(recsOf(this.data.autoPicks, list)),
      offsets: myList.map(() => 0),
      dragIndex: -1,
      dragY: 0,
      dragging: false
    })
    this.persist(list, mode || 'manual')
  },

  // ==================== 拖动排序（仅手动模式） ====================

  /** 只读（推荐）模式下所有编辑入口都该失效 —— 即使事件被绑上了 */
  isManual() {
    return this.data.mode === 'manual'
  },

  onLongPress(e) {
    if (!this.isManual()) return
    if (this.data.myList.length < 2) return

    const index = Number(e.currentTarget.dataset.index)
    if (isNaN(index)) return

    this._startY = (e.touches && e.touches[0] ? e.touches[0].clientY : 0)
    // 轻微振动：让用户知道"已经进入拖拽态"（否则长按没反馈会以为卡住）
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })

    this.setData({
      dragIndex: index,
      dragY: 0,
      dragging: true,
      offsets: this.data.myList.map(() => 0)
    })
  },

  onTouchMove(e) {
    const from = this.data.dragIndex
    if (from < 0) return

    const y = e.touches && e.touches[0] ? e.touches[0].clientY : this._startY
    const dy = y - this._startY
    const len = this.data.myList.length
    const to = clamp(from + Math.round(dy / this._step), 0, len - 1)

    // 其他项给一个反向位移，视觉上"让出空位"
    const offsets = this.data.myList.map((_, i) => {
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

    const len = this.data.myList.length
    const to = clamp(from + Math.round(this.data.dragY / this._step), 0, len - 1)

    // 先收起拖拽态（位移归零），再按需保存
    this.setData({ dragIndex: -1, dragY: 0, dragging: false, offsets: this.data.myList.map(() => 0) })

    if (to !== from) this.applyManual(qp.move(this.data.myList, from, to))
  },

  /** ↑↓ 兜底排序（长按拖动被系统手势打断时用） */
  onMove(e) {
    if (!this.isManual()) return
    const index = Number(e.currentTarget.dataset.index)
    const dir = Number(e.currentTarget.dataset.dir)
    if (isNaN(index) || isNaN(dir)) return

    const to = index + dir
    if (to < 0 || to >= this.data.myList.length) return
    this.applyManual(qp.move(this.data.myList, index, to))
  },

  // ==================== 删除 / 添加（仅手动模式） ====================

  onDelete(e) {
    if (!this.isManual()) return
    const index = Number(e.currentTarget.dataset.index)
    if (isNaN(index)) return
    this.applyManual(qp.removeAt(this.data.myList, index))
  },

  /** 从推荐里加一条 */
  onAddRec(e) {
    if (!this.isManual()) return
    const index = Number(e.currentTarget.dataset.index)
    const item = this.data.recs[index]
    if (!item) return

    const r = qp.add(this.data.myList, item)
    if (!r.ok) return this.toastFail(r.reason)
    this.applyManual(r.list)
  },

  /** 手动添加 */
  onAddDraft() {
    if (!this.isManual()) return
    const r = qp.add(this.data.myList, {
      title: this.data.draftTitle,
      amount: this.data.draftAmount,
      type: this.data.draftType
    })
    if (!r.ok) return this.toastFail(r.reason)

    this.setData({ draftTitle: '', draftAmount: '' })
    this.applyManual(r.list)
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

/** 推荐里还没被加进手动列表的那些（作为候选展示） */
function recsOf(autoPicks, myList) {
  return (Array.isArray(autoPicks) ? autoPicks : []).filter(r => !qp.has(myList, r))
}
