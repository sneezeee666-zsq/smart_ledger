const app = getApp()
const theme = require('../../utils/theme.js')
const share = require('../../utils/share.js')
const remover = require('../../utils/remove-bill.js')

/**
 * 账单查询页
 *
 * ⚠️ 为什么走云函数？
 *    客户端 db.get() 单次最多 20 条，也拿不到精确 count；
 *    在前端对已加载的几页求和当「合计」，翻页后会越翻越不对。
 *    筛选条件交给 getStatistics 的 'bills' 动作，由云端返回精确
 *    总笔数、收支合计与当前页数据。
 *
 * ⚠️ 为什么用「请求序号」而不是 loading 闸门？
 *    快速连点筛选按钮时，旧写法 `if (loading) return` 会把后一次请求直接丢弃，
 *    于是界面上的筛选条件变了、数据还是上一次的 —— 看起来就是「数据错位」。
 *    这里每次请求拿一个自增序号，回来后只有最新的那次才允许写数据。
 */

const BJ_OFFSET = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function bjDate(ts) {
  return new Date(ts + BJ_OFFSET)
}

// 该时间戳所在「北京日」的 0 点（用 UTC 构造，只作排序/比较用）
function dayKey(ts) {
  const d = bjDate(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

// 与云端一致的两位小数（删掉一条后要在本地把合计改对，避免出现 12.340000000001）
function round2(v) {
  return Math.round((v || 0) * 100) / 100
}

Page({
  data: {
    // 当前主题（根节点 class 用；初始化即读本地值，避免首帧闪一下默认色）
    theme: theme.currentId(),
    // 自定义主题的 13 个令牌（内置主题为 ''，令牌都在 app.wxss 的 .theme-<id> 里）
    themeStyle: theme.rootStyle(),

    // 时间筛选
    currentTab: 'month',
    timeTabs: [
      { key: 'day', label: '今日' },
      { key: 'week', label: '本周' },
      { key: 'month', label: '本月' },
      { key: 'year', label: '本年' }
    ],

    // 类型筛选
    typeFilter: 'all',

    // 分类筛选
    showPicker: false,
    currentCategory: '',
    currentCategoryName: '',
    expenseCategories: [],
    incomeCategories: [],

    // 账单数据
    bills: [],
    groupedBills: [],
    loading: false,
    firstLoaded: false,
    // 加载失败：决定显示"加载失败 + 重试"还是"这个条件下没有记录"。
    // 两者不能混：把失败说成"没有数据"，用户会以为自己真的查过一遍。
    loadFailed: false,
    hasMore: true,

    // 汇总（该筛选条件下的精确值，来自云端）
    totalCount: 0,
    totalIncome: 0,
    totalExpense: 0,

    // 分页
    pageSize: 20,
    page: 0,

    // 吸顶偏移（筛选栏实测高度，px）
    stickyTop: 0,

    // 账单详情弹层
    showDetail: false,
    detailBill: null,
    detailRows: [],

    // 当前左滑展开的行（同时只允许一行展开，值是该行的 _id，空串表示都收起）
    swipeOpenId: ''
  },


  // ---------------- 分享 ----------------
  // ⚠️ 必须定义 onShareAppMessage，否则右上角菜单不出现"转发"按钮，
  //    表现为用户点右上角三个点后提示"当前页面无法转发"。
  // 本页可能是隐私页（账单/我的）或过程页，只用通用分享：固定封面、不带任何
  // 用户数据 —— 默认分享是当前页面截图，会把明细/统计数字一起截走。
  onShareAppMessage() {
    return share.appShare('/pages/bills/bills')
  },

  // 朋友圈分享：微信要求必须给图片，用固定封面（同样不带用户数据）
  onShareTimeline() {
    return share.timelineShare()
  },
  onLoad() {
    this._seq = 0
    this.initCategories()
    this.loadBills()
  },

  onReady() {
    this.measureFilter()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    // 主题：本页是 tabBar 页，顺便把原生 tabBar 的配色同步过去
    theme.attach(this, true)
    // 导入/记账/清空后回到本页需要刷新
    if (this.loadedOnce) {
      this.setData({ page: 0, hasMore: true })
      this.loadBills()
    }
    this.loadedOnce = true
  },

  onPullDownRefresh() {
    this.setData({ page: 0, hasMore: true })
    this.loadBills().then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadBills(true)
    }
  },

  /**
   * 量出筛选栏的真实高度，供日期分组吸顶使用。
   * 之前这里是写死 top:120rpx，机型一换就会盖在筛选栏下面。
   */
  measureFilter() {
    wx.createSelectorQuery()
      .select('.filter-wrap')
      .boundingClientRect(rect => {
        if (rect && rect.height) {
          this.setData({ stickyTop: Math.round(rect.height) })
        }
      })
      .exec()
  },

  initCategories() {
    const cats = app.globalData.categories || { expense: [], income: [] }
    this.setData({
      expenseCategories: cats.expense || [],
      incomeCategories: cats.income || []
    })
  },

  // ---------------- 筛选 ----------------

  /**
   * 切换筛选条件时的列表复位。
   *
   * ⚠️ 必须把 groupedBills 一起清掉，不能只清 bills：
   *    列表渲染的是 groupedBills（按日分组后的结果），只清 bills 的话，
   *    新筛选条件下方还挂着**上一次的**列表 —— 用户看到「条件变了、数据没变」。
   *
   * ⚠️ 也不能在这里把 totalCount 清零：
   *    汇总条的显示条件是 totalCount > 0，清零会让它在每次切换时闪一下消失。
   *    新数据回来后会被覆盖，短暂保留旧汇总比"闪一下"更稳。
   */
  resetList() {
    return { page: 0, hasMore: true, bills: [], groupedBills: [] }
  },

  switchTimeTab(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.currentTab) return

    this.setData(Object.assign({ currentTab: key }, this.resetList()))
    this.loadBills()
  },

  switchType(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.typeFilter) return

    this.setData(Object.assign({ typeFilter: type }, this.resetList()))
    this.loadBills()
  },

  showCategoryPicker() {
    this.setData({ showPicker: true })
  },

  hideCategoryPicker() {
    this.setData({ showPicker: false })
  },

  selectCategory(e) {
    const id = e.currentTarget.dataset.id || ''
    const name = e.currentTarget.dataset.name || ''
    if (id === this.data.currentCategory) {
      this.setData({ showPicker: false })
      return
    }

    this.setData(Object.assign({
      currentCategory: id,
      currentCategoryName: name,
      showPicker: false
    }, this.resetList()))
    this.loadBills()
  },

  // ---------------- 数据 ----------------

  async loadBills(loadMore = false) {
    const seq = ++this._seq
    const page = loadMore ? this.data.page + 1 : 0

    this.setData({ loading: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'getStatistics',
        data: {
          action: 'bills',
          period: this.data.currentTab,
          type: this.data.typeFilter,
          categoryId: this.data.currentCategory,
          page,
          pageSize: this.data.pageSize
        }
      })

      // 已经有更新的请求发出去了，本次结果作废（否则会把新数据覆盖回旧筛选条件）
      if (seq !== this._seq) return

      const result = res.result || {}
      if (result.code !== 0 || !result.data) {
        throw new Error(result.message || '查询失败')
      }

      const d = result.data
      const pageBills = d.bills || []
      const allBills = loadMore ? this.data.bills.concat(pageBills) : pageBills

      const patch = {
        bills: allBills,
        groupedBills: this.groupByDate(allBills),
        // 精确总笔数每一页云端都会给（count 很便宜），可以照抄
        totalCount: d.total || 0,
        hasMore: !!d.hasMore,
        page,
        loading: false,
        firstLoaded: true,
        loadFailed: false
      }

      // ⚠️ 收支合计只有第 0 页有值，后页是 null。
      //    这里必须判断一下再写：翻页时若照抄 null，会把第 0 页算好的
      //    「收入 12000 / 支出 3400」覆盖成 0，汇总条上的两个数字会归零。
      if (!loadMore) {
        patch.totalIncome = d.totalIncome || 0
        patch.totalExpense = d.totalExpense || 0
      }

      this.setData(patch)
    } catch (err) {
      if (seq !== this._seq) return
      console.error('加载账单失败:', err)

      // 不使用假数据，避免误导
      const patch = { loading: false, firstLoaded: true, hasMore: false }
      if (!loadMore) {
        patch.bills = []
        patch.groupedBills = []
        patch.totalCount = 0
        patch.totalIncome = 0
        patch.totalExpense = 0
        // 说清是"加载失败"而不是"这个条件没有记录"
        patch.loadFailed = true
      }
      this.setData(patch)
      wx.showToast({ title: '账单加载失败', icon: 'none' })
    }
  },

  /** 加载失败后的重试：回到第 0 页重新取（汇总也会随之重算） */
  reloadBills() {
    this.setData(Object.assign({ loadFailed: false }, this.resetList()))
    return this.loadBills()
  },

  // 按「北京日」分组（不再用设备本地时区，避免跨时区时日期错位）
  groupByDate(bills) {
    const groups = {}

    bills.forEach(bill => {
      const key = dayKey(bill.createTime || 0)

      if (!groups[key]) {
        groups[key] = {
          dayKey: key,
          date: this.formatDate(bill.createTime),
          weekday: this.formatWeekday(bill.createTime),
          bills: [],
          income: 0,
          expense: 0
        }
      }

      groups[key].bills.push(bill)
      if (bill.type === 'income') groups[key].income += bill.amount || 0
      else groups[key].expense += bill.amount || 0
    })

    return Object.keys(groups)
      .map(k => groups[k])
      .sort((a, b) => b.dayKey - a.dayKey)
      .map(g => {
        g.bills.sort((a, b) => (b.createTime || 0) - (a.createTime || 0))
        g.income = Math.round(g.income * 100) / 100
        g.expense = Math.round(g.expense * 100) / 100
        return g
      })
  },

  formatDate(ts) {
    if (!ts) return ''

    const key = dayKey(ts)
    const todayKey = dayKey(Date.now())
    const diff = Math.round((todayKey - key) / DAY_MS)
    const d = bjDate(ts)

    if (diff === 0) return '今天'
    if (diff === 1) return '昨天'
    if (diff === 2) return '前天'
    if (d.getUTCFullYear() !== bjDate(Date.now()).getUTCFullYear()) {
      return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
    }
    return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
  },

  formatWeekday(ts) {
    if (!ts) return ''
    return WEEK_DAYS[bjDate(ts).getUTCDay()]
  },

  // 完整时间（北京时间）YYYY-MM-DD HH:mm
  formatFullBJ(ts) {
    if (!ts) return '—'
    const d = bjDate(ts)
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
      `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  },

  // ---------------- 账单详情 ----------------

  onBillTap(e) {
    const bill = e.detail && e.detail.bill
    if (!bill) return

    this.setData({
      showDetail: true,
      detailBill: bill,
      detailRows: this.buildDetailRows(bill)
    })
  },

  hideDetail() {
    this.setData({ showDetail: false })
  },

  buildDetailRows(bill) {
    const rows = [
      { k: '交易时间', v: this.formatFullBJ(bill.createTime) },
      { k: '收支', v: bill.type === 'income' ? '收入' : '支出' },
      { k: '交易类型', v: bill.tradeType || '—' },
      { k: '交易对方', v: bill.title || '—' },
      { k: '商品', v: bill.product || '—' },
      {
        k: '金额',
        v: (bill.type === 'income' ? '+' : '-') + '¥' + Number(bill.amount || 0).toFixed(2),
        cls: bill.type === 'income' ? 'v-income' : 'v-expense'
      },
      { k: '分类', v: bill.category || '其他' },
      { k: '支付方式', v: bill.payMethod || '—' },
      { k: '当前状态', v: bill.status || '—' }
    ]

    if (bill.orderNo) {
      rows.push({ k: '交易单号', v: String(bill.orderNo), mono: true })
    }

    return rows
  },

  // 详情弹层里复制单号，便于核对
  copyOrderNo() {
    const bill = this.data.detailBill
    if (!bill || !bill.orderNo) return

    wx.setClipboardData({
      data: String(bill.orderNo),
      success: () => wx.showToast({ title: '单号已复制', icon: 'none' })
    })
  },

  // ---------------- 删除 ----------------

  /**
   * 左滑露出的「删除」按钮
   * 组件里只负责把手势换算成位移，确认/调云函数/提示统一走 utils/remove-bill.js
   */
  async onBillDelete(e) {
    const bill = (e.detail && e.detail.bill) || null
    if (!bill || !bill._id) return

    // 先收起这一行：即使后面取消了，也不该留着一个敞开的红色按钮
    this.setData({ swipeOpenId: '' })

    const ok = await remover.confirmAndRemove(bill)
    if (ok) this.removeLocalBill(bill._id)
  },

  // 某一行滑开 → 记下它，其它行收到 force-close 自动收起
  onBillSwipeOpen(e) {
    const bill = (e.detail && e.detail.bill) || null
    const id = bill ? bill._id : ''
    if (id && id !== this.data.swipeOpenId) this.setData({ swipeOpenId: id })
  },

  // 某一行收起了（点一下卡片、或滑回原位）→ 清掉记录，别留着一个过期的"展开中"
  onBillSwipeClose(e) {
    const bill = (e.detail && e.detail.bill) || null
    if (bill && bill._id === this.data.swipeOpenId) this.setData({ swipeOpenId: '' })
  },

  // 详情弹层底部的「编辑」→ 跳到记账页的编辑模式（带 id）
  editDetailBill() {
    const bill = this.data.detailBill
    if (!bill || !bill._id) return

    // ⚠️ 先收起弹层再跳转：本页是 tabBar 页，编辑保存返回后 onShow 会重载列表，
    //    弹层要是一直开着就会盖在刚刷新的数据上，看起来像「改了没生效」。
    this.setData({ showDetail: false, detailBill: null, detailRows: [], swipeOpenId: '' })
    wx.navigateTo({ url: '/pages/add-bill/add-bill?id=' + bill._id })
  },

  // 详情弹层底部的「删除记录」
  async deleteDetailBill() {
    const bill = this.data.detailBill
    if (!bill || !bill._id) return

    const ok = await remover.confirmAndRemove(bill)
    if (!ok) return

    this.setData({ showDetail: false, detailBill: null, detailRows: [], swipeOpenId: '' })
    this.removeLocalBill(bill._id)
  },

  /**
   * 本地摘掉一条记录，并把该筛选条件下的笔数/收支合计同步改对。
   *
   * ⚠️ 为什么不干脆重新 loadBills()？
   *    重载会把分页 reset 到第 0 页 —— 用户在第 3 页删一条就被弹回顶部；
   *    而且重载期间列表会闪一下骨架屏。删掉的这条金额与收支类型都是已知的，
   *    在本地按云端同一口径做减法即可（云端那套聚合本来就只是 sum）。
   */
  removeLocalBill(id) {
    const bill = this.data.bills.find(b => b._id === id)
    if (!bill) return

    const bills = this.data.bills.filter(b => b._id !== id)
    const amount = bill.amount || 0

    const patch = {
      bills,
      groupedBills: this.groupByDate(bills),
      totalCount: Math.max(0, this.data.totalCount - 1),
      totalIncome: this.data.totalIncome,
      totalExpense: this.data.totalExpense
    }

    if (bill.type === 'income') patch.totalIncome = round2(patch.totalIncome - amount)
    else patch.totalExpense = round2(patch.totalExpense - amount)

    this.setData(patch)

    // 万一正好把这几页里最后一条删掉了，而云端还有更多数据：
    // 重新拉一次，既补上后面的记录，也让汇总回到云端真值
    if (!bills.length && this.data.hasMore) {
      this.setData({ page: 0 })
      this.loadBills()
    }
  },

  // ---------------- 导航 ----------------

  goToImport() {
    wx.navigateTo({ url: '/pages/import/import' })
  },

  goToAddBill() {
    wx.navigateTo({ url: '/pages/add-bill/add-bill' })
  }
})
