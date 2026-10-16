/**
 * 账单卡片
 *
 * 两种形态：
 *   · 普通（首页「最近交易」、详情列表）—— 只负责展示 + 点击
 *   · 可左滑（账单列表 swipeable=true）—— 左滑露出右侧红色「删除」键
 *
 * ⚠️ 左滑为什么自己做而不用第三方？
 *    小程序没有内置的 swipe 组件（mp-slideview 要引 weui 扩展库，为一行删除
 *    引一整个组件库不划算）。这里只用 transform + 触摸事件，零依赖。
 *
 * ⚠️ 两个必须守住的细节（否则体验会很差）：
 *    1. 拖动过程中要**关掉 transition**：不关的话手指与补间动画互相追赶，
 *       卡片会像橡皮筋一样黏在手指后面。
 *    2. 滑动结束后紧接着的那次 tap 必须**吞掉**：否则一滑松手就把详情弹层打开了
 *       （在"删除"按钮旁边误开详情，很容易接着误删）。
 *    3. 纵向滑动要直接放弃（把手势还给页面滚动），不能在竖向滚动时横向乱动。
 */

// 左滑露出的删除键宽度（rpx）。
// ⚠️ 必须与 bill-card.wxss 里 .swipe-del 的 width 一致：JS 用它算位移上限，
//    样式用它定宽度 —— 不一致会出现"露一半"或"右边留白"。
//    两处由 tests/static-check.js 对账。
const REVEAL_RPX = 150

Component({
  options: {
    // 组件内用到 app.wxss 的 .num / .amount-income / .text-ellipsis 等公共类，
    // 必须放开样式隔离，否则这些类不会生效（金额会失去等宽数字、颜色会丢）。
    styleIsolation: 'apply-shared'
  },

  properties: {
    bill: {
      type: Object,
      value: {}
    },
    // 是否显示时间行
    showDate: {
      type: Boolean,
      value: true
    },
    // 时间显示模式：'auto'（今天/昨天/周几 + HH:mm）| 'datetime' | 'time'
    timeMode: {
      type: String,
      value: 'auto'
    },
    // 紧凑模式（首页「最近交易」用）
    compact: {
      type: Boolean,
      value: false
    },
    // 是否显示底部分割线
    showBorder: {
      type: Boolean,
      value: true
    },
    // 点击是否需要按压反馈（不可点击时传 false，避免出现假的可点击感）
    clickable: {
      type: Boolean,
      value: true
    },
    // 是否允许左滑删除（只有账单列表传 true）
    swipeable: {
      type: Boolean,
      value: false
    },
    // 父级要求本行收起：同一时刻只允许一行展开，别的行滑开时本行会收到 true
    forceClose: {
      type: Boolean,
      value: false
    }
  },

  data: {
    // 左滑位移（px，负值）：0 = 收起，-reveal = 全开
    offset: 0,
    // 是否正在拖动：决定要不要挂 transition
    dragging: false
  },

  observers: {
    forceClose(v) {
      if (v && this.data.offset !== 0) this.setData({ offset: 0, dragging: false })
    }
  },

  lifetimes: {
    attached() {
      // 触摸事件给的是 px，位移只能按 px 算，所以要把 rpx 换算一次
      // （wx.getSystemInfoSync 已废弃，优先用 wx.getWindowInfo，低版本兜底）
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      const width = (info && info.windowWidth) || 375
      this._reveal = Math.max(40, Math.round(REVEAL_RPX * width / 750))
    }
  },

  methods: {
    // ---------------- 左滑手势 ----------------

    onTouchStart(e) {
      if (!this.data.swipeable) return

      const t = e.touches && e.touches[0]
      if (!t) return

      this._x0 = t.clientX
      this._y0 = t.clientY
      this._base = this.data.offset      // 从当前位移接着算（可能本来就是展开的）
      this._axis = ''                    // '' 未判定 | 'h' 横向 | 'v' 纵向
      this._moved = false                // 本次触摸是否发生过有效滑动
    },

    onTouchMove(e) {
      if (!this.data.swipeable || this._x0 === undefined) return

      const t = e.touches && e.touches[0]
      if (!t) return

      const dx = t.clientX - this._x0
      const dy = t.clientY - this._y0

      if (!this._axis) {
        // 4px 内不判定方向：手抖一点点就把行锁成"横向"，会把列表滚不动
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
        this._axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'v'
      }
      if (this._axis !== 'h') return

      if (!this._moved) {
        this._moved = true
        this.setData({ dragging: true })
      }

      let next = this._base + dx
      const limit = this._reveal

      if (next > 0) next *= 0.25                                   // 向右拖：阻尼回弹
      if (next < -limit) next = -limit + (next + limit) * 0.25      // 拖过删除键：阻尼

      // 只有整数位真的变了才 setData —— 一次拖动会触发几十次 touchmove，
      // 每帧都跨线程通信会明显掉帧
      const rounded = Math.round(next)
      if (rounded !== this.data.offset) this.setData({ offset: rounded })
    },

    onTouchEnd() {
      if (!this.data.swipeable) {
        this._x0 = undefined
        return
      }

      if (this._axis === 'h') {
        // 滑过一半就展开，否则弹回
        const open = this.data.offset < -this._reveal / 2
        this.setData({ offset: open ? -this._reveal : 0, dragging: false })

        if (open) {
          this.triggerEvent('swipeopen', { bill: this.data.bill })
        } else if (this._base !== 0) {
          this.triggerEvent('swipeclose', { bill: this.data.bill })
        }
      }

      this._x0 = undefined
      this._axis = ''
    },

    // ---------------- 点击 ----------------

    onDeleteTap() {
      this.triggerEvent('delete', { bill: this.data.bill })
    },

    onTap() {
      // 刚才是滑动，不是点击 → 吞掉这次 tap，避免误开详情
      if (this._moved) {
        this._moved = false
        return
      }

      // 已经滑开时，点一下只收起（符合直觉：先看账单，再决定删不删）
      if (this.data.offset !== 0) {
        this.setData({ offset: 0 })
        this.triggerEvent('swipeclose', { bill: this.data.bill })
        return
      }

      if (!this.data.clickable) return
      this.triggerEvent('tap', { bill: this.data.bill })
    }
  }
})
