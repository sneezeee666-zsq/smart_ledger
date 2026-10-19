/**
 * 半屏快捷记账面板
 *
 * 设计目标：把"补记零星一笔"压缩到**输金额 → 保存**两步，且不离开首页。
 *
 * 三个刻意的取舍：
 *  1. **面板从上往下滑出**（不是从底部弹）：
 *     键盘本身就是从屏幕底部升起的，面板若在底部，键盘一来就得把面板往上顶，
 *     两层叠在一起"弹来弹去"。放上半屏 → 面板占上半屏、键盘占下半屏，
 *     天然不重叠，连"按键盘高度顶面板"的逻辑都不需要。
 *  2. **只放必要字段**：收支 + 金额 + 对方（可选）。交易类型/支付方式/状态/时间
 *     全部走默认值（云端 action='add' 会补），想改就点「更多选项」进完整页。
 *  3. **常记的一键复用**：chips 最多 10 个。用户在「我的 → 常记的」里自己配置
 *     （增删 + 拖动排序）；从没配置过时由云端按近 90 天账单自动推荐。
 *     点一下预填、长按直接存 —— 每天买同一杯咖啡只需长按一次。
 */

const theme = require('../../utils/theme.js')
const form = require('../../utils/bill-form.js')

// 面板下滑动画时长（ms）。聚焦要等动画走完，否则键盘会被动画打断
const SLIDE_MS = 260

Component({
  options: {
    // 用到 app.wxss 的 .num / .text-ellipsis / .btn-primary 等公共类，
    // 必须放开样式隔离（铁律：否则这些类不生效，金额会失去等宽数字）
    styleIsolation: 'apply-shared'
  },

  properties: {
    visible: {
      type: Boolean,
      value: false
    }
  },

  data: {
    theme: theme.currentId(),

    type: 'expense',
    amount: '',
    title: '',

    picks: [],
    picksLoaded: false,

    submitting: false,
    // 打开面板后自动聚焦金额输入
    focusAmount: false
  },

  observers: {
    visible(v) {
      if (v) {
        this.setData({
          type: 'expense',
          amount: '',
          title: '',
          submitting: false,
          // 先置 false 再置 true，保证同一个面板第二次打开也能触发聚焦
          focusAmount: false
        })
        // 等上滑动画结束再聚焦，否则键盘会被动画打断、面板停在半路
        this._focusTimer = setTimeout(() => {
          if (this.data.visible) this.setData({ focusAmount: true })
        }, SLIDE_MS)
        this.loadPicks()
      } else {
        if (this._focusTimer) { clearTimeout(this._focusTimer); this._focusTimer = null }
        this.setData({ focusAmount: false })
      }
    }
  },

  detached() {
    if (this._focusTimer) clearTimeout(this._focusTimer)
  },

  methods: {
    noop() {},

    onClose() {
      this.triggerEvent('close')
    },


    // ---------------- 输入 ----------------

    onTypeChange(e) {
      const type = e.currentTarget.dataset.type
      if (type === this.data.type) return
      this.setData({ type })
    },

    onAmountInput(e) {
      // 只收「最多两位小数」的数字，别让用户能输进 1.2.3 这种
      let v = String(e.detail.value || '').replace(/[^\d.]/g, '')
      const dot = v.indexOf('.')
      if (dot !== -1) {
        v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, 2)
      }
      if (v.length > 10) v = v.slice(0, 10)
      this.setData({ amount: v })
    },

    clearAmount() {
      this.setData({ amount: '' })
    },

    onTitleInput(e) {
      this.setData({ title: String(e.detail.value || '').slice(0, 60) })
    },

    // ---------------- 常记的 ----------------

    /**
     * 拉「常记的」。
     *
     * ⚠️ 每次打开面板都要重新拉：用户可能刚在「我的 → 常记的」里改过，
     *    用一次性缓存会让首页 chips 一直停在旧内容上（改完看不到效果，
     *    还以为配置没保存成功）。
     * ⚠️ 刷新时**不要先清空现有 chips**：先把旧的留在屏幕上，新数据回来再替换，
     *    否则每次打开面板都会先闪一下空白。
     * ⚠️ 序号防乱序：连续开关面板时只认最后一次请求的结果。
     */
    async loadPicks() {
      const seq = (this._pickSeq || 0) + 1
      this._pickSeq = seq

      try {
        const res = await wx.cloud.callFunction({
          name: 'getStatistics',
          data: { action: 'quickPicks' }
        })
        if (seq !== this._pickSeq) return

        const r = (res && res.result) || {}
        const picks = (r.code === 0 && r.data && r.data.picks) || []
        this.setData({ picks, picksLoaded: true })
      } catch (err) {
        if (seq !== this._pickSeq) return
        console.warn('常记的加载失败（面板照常可用）:', err)
        // 网络抖一下不该让快捷按钮全消失：只有"从没成功拉过"才清空
        if (!this.data.picksLoaded) this.setData({ picks: [], picksLoaded: true })
      }
    },

    /** 点 chip：预填（金额可再改） */
    onPick(e) {
      const item = this.data.picks[e.currentTarget.dataset.index]
      if (!item) return
      this.setData({
        type: item.type,
        amount: item.amount ? String(item.amount) : '',
        title: item.title || ''
      })
    },

    /** 长按 chip：直接记这一笔（最高频场景，一步完成） */
    onPickSave(e) {
      const item = this.data.picks[e.currentTarget.dataset.index]
      if (!item) return
      this.submit({
        type: item.type,
        amount: item.amount ? String(item.amount) : '',
        title: item.title || '',
        product: item.product || ''
      })
    },

    // ---------------- 保存 ----------------

    /** 点保存按钮 / 键盘「完成」 */
    onSave() {
      this.submit({
        type: this.data.type,
        amount: this.data.amount,
        title: this.data.title,
        product: ''
      })
    },

    /**
     * 真正落库。走 parseCSV 的 action='add' —— 与完整记账页**同一条链路**
     * （同一份校验 + 同一套智能分类），否则手动记的账会和导入的对不上口径。
     *
     * @param {Object} v { type, amount, title, product }
     */
    async submit(v) {
      if (this.data.submitting) return

      const amount = Number(v.amount)
      if (!(amount > 0)) {
        wx.showToast({ title: '请输入金额', icon: 'none' })
        return
      }

      const now = form.bjNow()
      this.setData({ submitting: true })

      try {
        const res = await wx.cloud.callFunction({
          name: 'parseCSV',
          data: {
            action: 'add',
            bill: {
              type: v.type === 'income' ? 'income' : 'expense',
              amount: v.amount,
              title: v.title || '',
              product: v.product || '',
              date: now.date,
              time: now.time
            }
          }
        })

        const r = (res && res.result) || {}
        if (r.code !== 0) throw new Error(r.message || '保存失败')

        wx.showToast({ title: '已记 ¥' + amount, icon: 'success' })
        this.triggerEvent('done', { amount, type: v.type })
        this.triggerEvent('close')
      } catch (err) {
        console.error('快捷记账失败:', err)
        const msg = (err && err.message) || ''
        // 「疑似重复」是云端明确给的提示，原样转给用户（他可以选择仍要保存 → 走完整页）
        wx.showToast({ title: msg || '保存失败，请重试', icon: 'none' })
      } finally {
        this.setData({ submitting: false })
      }
    },

    /** 更多选项：带着已填的内容进完整记账页 */
    goFullPage() {
      const q = []
      if (this.data.amount) q.push('amount=' + encodeURIComponent(this.data.amount))
      if (this.data.title) q.push('title=' + encodeURIComponent(this.data.title))
      if (this.data.type === 'income') q.push('type=income')
      wx.navigateTo({
        url: '/pages/add-bill/add-bill' + (q.length ? '?' + q.join('&') : '')
      })
      this.triggerEvent('close')
    }
  }
})
