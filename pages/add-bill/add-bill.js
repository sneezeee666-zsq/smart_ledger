/**
 * 记账 / 编辑账单页
 *
 * 同一个页面承担两件事：
 *   记一笔（无参数进入）→ 云端 action='add'
 *   改一笔（带 ?id=xxx 进入）→ 先 action='detail' 拉原记录预填，保存时 action='update'
 *
 * 复用而不是另开一页，是因为两边的字段、下拉选项、分类预览、校验规则完全一样；
 * 分成两个页面必然漂移，最后变成「新增时能填的字段编辑时填不了」这种怪事。
 *
 * 与「导入微信账单」共用云端同一套智能分类（parseCSV 云函数的 classify / add / update），
 * 字段结构完全一致，因此手动记的账可以和导入的账混在一起统计。
 *
 * 交易时间默认取「当前北京时间」；日期/时间的解析与换算统一由云函数负责，
 * 前端只把用户选的「日期 + 时间」两个字符串传上去。
 *
 * 注意：WXML 表达式不支持函数调用（没有 array.indexOf），
 * 所以下拉框统一用「索引」驱动，展示时才回查数组。
 */

const theme = require('../../utils/theme.js')
const share = require('../../utils/share.js')
const form = require('../../utils/bill-form.js')

// ===== 下拉选项：取自真实微信账单的高频取值，按需增删即可 =====
const TRADE_TYPES = [
  '商户消费', '扫二维码付款', '转账', '微信红包', '群收款',
  '零钱提现', '退款', '生活缴费', '信用卡还款', '其他'
]

const PAY_METHODS = [
  '零钱', '零钱通', '储蓄卡', '信用卡', '支付宝', '现金', '其他'
]

// 当前状态同时覆盖支出/收入两种语境
const STATUS_LIST = [
  '支付成功', '已存入零钱', '对方已收钱', '已转账',
  '已全额退款', '提现已到账', '交易关闭'
]

// 切换收/支时自动带出的默认值（用户手动改过就不再覆盖）
const SUGGEST = {
  expense: { tradeType: '商户消费', status: '支付成功' },
  income: { tradeType: '转账', status: '已存入零钱' }
}

function idxOf(list, name) {
  const i = list.indexOf(name)
  return i === -1 ? 0 : i
}

Page({
  data: {
    // 当前主题（根节点 class 用；初始化即读本地值，避免首帧闪一下默认色）
    theme: theme.currentId(),

    // 收/支
    type: 'expense',

    // 金额
    amount: '',

    // 交易时间
    date: '',
    time: '',
    maxDate: '',

    // 文本字段
    title: '',
    product: '',

    // 下拉字段（列表 + 当前索引）
    tradeTypes: TRADE_TYPES,
    payMethods: PAY_METHODS,
    statusList: STATUS_LIST,
    tradeTypeIndex: idxOf(TRADE_TYPES, SUGGEST.expense.tradeType),
    payMethodIndex: 0,
    statusIndex: idxOf(STATUS_LIST, SUGGEST.expense.status),

    // 分类预览
    categoryPreview: null,
    classifying: false,

    // 当前聚焦的输入行（用于高亮）
    focusField: '',

    submitting: false,

    // ===== 编辑模式（带 ?id= 进来时才有值）=====
    isEdit: false,
    editId: '',
    loading: false
  },


  // ---------------- 分享 ----------------
  // ⚠️ 必须定义 onShareAppMessage，否则右上角菜单不出现"转发"按钮，
  //    表现为用户点右上角三个点后提示"当前页面无法转发"。
  // 本页可能是隐私页（账单/我的）或过程页，只用通用分享：固定封面、不带任何
  // 用户数据 —— 默认分享是当前页面截图，会把明细/统计数字一起截走。
  onShareAppMessage() {
    return share.appShare('/pages/add-bill/add-bill')
  },

  // 朋友圈分享：微信要求必须给图片，用固定封面（同样不带用户数据）
  onShareTimeline() {
    return share.timelineShare()
  },
  onLoad(options) {
    // 本页不是 tabBar 页，只取主题（tabBar 由 tabBar 页负责同步）
    theme.attach(this)

    const now = form.bjNow()
    this.setData({
      date: now.date,
      time: now.time,
      maxDate: now.date
    })

    // 记录用户是否手动改过下拉项，改过就不再被收/支切换覆盖
    this._touched = { tradeType: false, status: false }
    this._catSeq = 0
    // 表单是否已被改动（决定返回时要不要弹「还没保存」）
    this._dirty = false

    // 带 id 进来 = 改一笔已有的记录
    const id = (options && options.id) ? String(options.id).trim() : ''
    if (id) this.enterEditMode(id)
    else this.applyPrefill(options || {})
  },

  /**
   * 从首页半屏面板「更多选项」跳过来时，把已填的内容带进来（不用重输）。
   *
   * ⚠️ 只认三个参数，且必须校验：
   *    amount 走与输入框相同的「最多两位小数」清洗（否则脏值会一路传到云端报错）；
   *    type 只认 income，其余一律按支出。
   *    title 截到 60 字（与云端 maxTitleLen 一致，超了云端也会拒）。
   */
  applyPrefill(options) {
    const patch = {}
    const amount = String(options.amount || '').replace(/[^\d.]/g, '')
    if (amount) {
      const dot = amount.indexOf('.')
      patch.amount = dot === -1 ? amount : amount.slice(0, dot + 1) + amount.slice(dot + 1).replace(/\./g, '').slice(0, 2)
    }
    if (options.title) patch.title = String(decodeURIComponent(options.title)).slice(0, 60)
    if (String(options.type || '') === 'income') patch.type = 'income'

    if (!Object.keys(patch).length) return
    this.setData(patch)
    // 有预填内容说明用户已经开始填了，返回时该提醒「还没保存」
    this._dirty = true
    // 填了对方就顺手识别一下分类
    if (patch.title) this.refreshCategory()
  },

  onShow() {
    // 在「我的」里换过主题后返回本页要跟着变
    theme.attach(this)
  },

  onUnload() {
    if (this._catTimer) clearTimeout(this._catTimer)
  },

  // ==================== 编辑模式 ====================

  /**
   * 进入编辑模式：先用 id 把原记录拉回来预填，再让用户改。
   *
   * ⚠️ 为什么不从上一页直接把 bill 对象传过来？
   *    编辑页可能被刷新、也可能从分享进入；而且列表里的数据是几分钟前加载的。
   *    以服务端当前的值为准，才不会出现「基于旧数据改出新旧混搭的字段」。
   */
  async enterEditMode(id) {
    wx.setNavigationBarTitle({ title: '编辑账单' })
    this.setData({ isEdit: true, editId: id, loading: true })
    wx.showLoading({ title: '加载中...', mask: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'parseCSV',
        data: { action: 'detail', id }
      })
      const r = (res && res.result) || {}
      if (r.code !== 0 || !r.data) throw new Error(r.message || '读取失败')

      this.fillForm(r.data)
      wx.hideLoading()
      this.setData({ loading: false })
    } catch (err) {
      wx.hideLoading()
      this.setData({ loading: false })
      console.error('读取待编辑的账单失败:', err)

      // 拉不到原记录时绝不能留一个空表单：那等于让用户在看不到原值的情况下
      // 把这条数据整体覆盖掉。说清楚原因，然后退出。
      wx.showModal({
        title: '无法编辑',
        content: (err && err.message) || '读取失败，请稍后重试',
        showCancel: false,
        confirmText: '返回',
        success: () => wx.navigateBack(),
        fail: () => wx.navigateBack()
      })
    }
  },

  /** 把服务端返回的一条账单铺进表单 */
  fillForm(bill) {
    const t = form.bjParts(bill.createTime)

    // ⚠️ 原值可能不在下拉选项里（例如导入账单的支付方式「招商银行(1234)」）——
    //    withValue 把它补进列表，否则索引会落到 0，保存一次就被静默改成第一项
    const tt = form.withValue(TRADE_TYPES, bill.tradeType)
    const pm = form.withValue(PAY_METHODS, bill.payMethod)
    const st = form.withValue(STATUS_LIST, bill.status)

    this.setData({
      type: bill.type === 'income' ? 'income' : 'expense',
      amount: bill.amount === undefined || bill.amount === null ? '' : String(bill.amount),
      date: t.date,
      time: t.time,
      title: bill.title || '',
      product: bill.product || '',
      tradeTypes: tt.list,
      tradeTypeIndex: tt.index,
      payMethods: pm.list,
      payMethodIndex: pm.index,
      statusList: st.list,
      statusIndex: st.index
    })

    // 预填不算「改动」—— 进来看看又原样退出，不该被问「还没保存」
    this._dirty = false
    this.refreshCategory()
  },

  /**
   * 标记表单已被改动：有内容却直接返回时给一次确认，避免白填。
   * 低版本基础库没有这个 API，静默跳过即可。
   */
  markDirty() {
    if (this._dirty) return
    this._dirty = true
    if (typeof wx.enableAlertBeforeUnload === 'function') {
      const message = this.data.isEdit ? '改动还没保存，确定离开吗？' : '这一笔还没保存，确定离开吗？'
      wx.enableAlertBeforeUnload({ message })
    }
  },

  /** 已保存 / 已放弃修改 → 撤掉返回询问 */
  releaseDirty() {
    this._dirty = false
    if (typeof wx.disableAlertBeforeUnload === 'function') {
      wx.disableAlertBeforeUnload()
    }
  },

  // ==================== 收/支 ====================

  onTypeChange(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.type) return

    const patch = { type }
    const sg = SUGGEST[type] || SUGGEST.expense

    // 没手动改过的下拉项，跟着收/支切换自动换成更合理的默认值
    if (!this._touched.tradeType) {
      patch.tradeTypeIndex = idxOf(TRADE_TYPES, sg.tradeType)
    }
    if (!this._touched.status) {
      patch.statusIndex = idxOf(STATUS_LIST, sg.status)
    }

    this.setData(patch)
    this.refreshCategory()
  },

  // ==================== 金额 ====================

  onAmountInput(e) {
    let v = String(e.detail.value || '')
    // 只保留数字和一个小数点
    v = v.replace(/[^\d.]/g, '')
    if (v.charAt(0) === '.') v = '0' + v

    const parts = v.split('.')
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('')
    if (parts[1] && parts[1].length > 2) {
      v = parts[0] + '.' + parts[1].slice(0, 2)
    }

    this.markDirty()
    this.setData({ amount: v })
    return v
  },

  clearAmount() {
    this.markDirty()
    this.setData({ amount: '' })
  },

  // ==================== 交易时间 ====================

  onDateChange(e) {
    this.markDirty()
    this.setData({ date: e.detail.value })
  },

  onTimeChange(e) {
    this.markDirty()
    this.setData({ time: e.detail.value })
  },

  setNow() {
    const now = form.bjNow()
    this.markDirty()
    this.setData({ date: now.date, time: now.time })
    wx.showToast({ title: '已设为当前时间', icon: 'none' })
  },

  // ==================== 文本输入 ====================

  onInput(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.markDirty()
    this.setData({ [field]: e.detail.value })
  },

  onFieldFocus(e) {
    this.setData({ focusField: e.currentTarget.dataset.field || '' })
  },

  // 输入框失焦时刷新分类预览
  onFieldBlur() {
    this.setData({ focusField: '' })
    this.refreshCategory()
  },

  // ==================== 下拉选择 ====================

  onTradeTypeChange(e) {
    this._touched.tradeType = true
    this.markDirty()
    this.setData({ tradeTypeIndex: Number(e.detail.value) })
  },

  onPayMethodChange(e) {
    this.markDirty()
    this.setData({ payMethodIndex: Number(e.detail.value) })
  },

  onStatusChange(e) {
    this._touched.status = true
    this.markDirty()
    this.setData({ statusIndex: Number(e.detail.value) })
  },

  // ==================== 分类预览 ====================

  refreshCategory() {
    if (this._catTimer) clearTimeout(this._catTimer)

    const { title, product } = this.data
    if (!title && !product) {
      this.setData({ categoryPreview: null, classifying: false })
      return
    }

    this._catTimer = setTimeout(() => this.doRefreshCategory(), 300)
  },

  async doRefreshCategory() {
    const seq = ++this._catSeq
    this.setData({ classifying: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'parseCSV',
        data: {
          action: 'classify',
          bill: {
            title: this.data.title,
            product: this.data.product,
            type: this.data.type
          }
        }
      })

      // 丢弃过期响应（用户还在打字时的旧请求）
      if (seq !== this._catSeq) return

      const r = (res && res.result) || {}
      this.setData({
        categoryPreview: (r.code === 0 && r.category) ? r.category : null,
        classifying: false
      })
    } catch (err) {
      if (seq !== this._catSeq) return
      // 预览失败不打扰用户：保存时云端仍会重新分类，只是少了提前提示
      console.warn('分类预览失败:', err)
      this.setData({ classifying: false })
    }
  },

  // ==================== 保存 ====================

  async save() {
    // 闸门：防止连点两下写出两条
    if (this.data.submitting) return
    // 编辑模式还在拉原记录：此时表单是空的，不能让它被保存出去
    if (this.data.loading) {
      wx.showToast({ title: '正在读取原记录', icon: 'none' })
      return
    }

    const amount = String(this.data.amount || '').trim()
    if (!amount || !(parseFloat(amount) > 0)) {
      wx.showToast({ title: '请输入金额', icon: 'none' })
      return
    }
    if (!this.data.date) {
      wx.showToast({ title: '请选择交易日期', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '保存中...', mask: true })

    try {
      await this.doSave(false)
    } catch (err) {
      console.error('保存失败:', err)
      wx.hideLoading()
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ submitting: false })
    }
  },

  /**
   * 真正落库：新增走 add、编辑走 update。
   *
   * ⚠️ 两个 action 的「重复」语义不一样：
   *    add 命中 = 可能重复提交；update 命中 = 改成了和**另一条**一模一样。
   *    文案必须跟着区分，否则用户会以为是自己重复提交了。
   */
  async doSave(force) {
    const d = this.data

    const bill = {
      date: d.date,
      time: d.time,
      type: d.type,
      amount: d.amount,
      title: d.title,
      product: d.product,
      // ⚠️ 取 data 里的列表而不是模块常量：编辑模式下 withValue 可能把原值
      //    追加进了 data.tradeTypes / payMethods / statusList
      tradeType: d.tradeTypes[d.tradeTypeIndex],
      payMethod: d.payMethods[d.payMethodIndex],
      status: d.statusList[d.statusIndex]
    }

    const req = { action: d.isEdit ? 'update' : 'add', force, bill }
    if (d.isEdit) req.id = d.editId

    const res = await wx.cloud.callFunction({ name: 'parseCSV', data: req })
    const r = (res && res.result) || {}

    // 已有完全相同的记录 → 问一句再决定
    if (r.code === 2) {
      // ⚠️ 必须先关掉 loading：showLoading 带 mask，会盖在 showModal 之上，
      //    用户根本点不到弹窗按钮（表现为「卡住」）。
      wx.hideLoading()

      const goOn = await this.confirmDuplicate(r.message)
      if (!goOn) return

      wx.showLoading({ title: '保存中...', mask: true })
      await this.doSave(true)
      return
    }

    if (r.code !== 0) {
      throw new Error(r.message || '保存失败')
    }

    // 已落库：先撤掉「还没保存」询问，再离开，否则返回时还会弹一次
    this.releaseDirty()
    wx.hideLoading()
    wx.showToast({ title: d.isEdit ? '已保存修改' : '已保存', icon: 'success' })

    setTimeout(() => {
      // 直接从分享/二维码进来时没有上一页，navigateBack 会失败
      const pages = getCurrentPages()
      if (pages.length > 1) wx.navigateBack()
      else wx.switchTab({ url: '/pages/index/index' })
    }, 800)
  },

  confirmDuplicate(message) {
    return new Promise(resolve => {
      wx.showModal({
        title: '疑似重复记录',
        content: (message || '已存在完全相同的记录') + '，仍要保存吗？',
        confirmText: '仍要保存',
        cancelText: '取消',
        success: res => resolve(!!res.confirm),
        fail: () => resolve(false)
      })
    })
  }
})
