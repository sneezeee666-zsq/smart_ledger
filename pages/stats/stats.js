/**
 * 统计分析页
 *
 * ⚠️ 为什么统计要走云函数？
 *    小程序**客户端** db.collection().get() 单次最多只能取 20 条记录，
 *    在前端 reduce 求和会把超出 20 条的记录全部漏掉 → 金额、占比、趋势全部偏小。
 *    因此区间汇总 / 分类占比 / 月度趋势统一由 getStatistics 云函数聚合后返回。
 *
 * 图表用 Canvas 2D（type="2d"）+ devicePixelRatio 缩放绘制。
 * 旧的 wx.createCanvasContext 按 CSS 像素绘制，在 2x/3x 屏上是明显的糊图。
 */

const theme = require('../../utils/theme.js')
const share = require('../../utils/share.js')
// 图表口径（金额缩写、Y 轴刻度、niceMax、颜色转 rgba）统一收在 utils/chart-format.js：
// 这些函数放在页面里就没法离线单测，而它们恰恰对应着踩过的坑
// （把 ¥8.80 显示成 ¥9、Y 轴出现两个 1）。见 tests/chart-format-test.js。
const cf = require('../../utils/chart-format.js')

// 兜底颜色表
// 正常情况下颜色由云端按 getStatistics 的 CATEGORY_META 返回，这里只是
// 云函数尚未返回 color 时的兜底，色板需与云端保持一致。
const CATEGORY_COLORS = {
  food: '#F97316',
  transport: '#0EA5E9',
  shopping: '#8B5CF6',
  entertainment: '#EC4899',
  housing: '#F59E0B',
  medical: '#14B8A6',
  education: '#6366F1',
  communication: '#06B6D4',
  salary: '#E5484D',
  bonus: '#F97316',
  investment: '#0EA5E9',
  parttime: '#14B8A6',
  red_packet: '#EC4899',
  refund: '#14B8A6',
  other_income: '#94A3B8',
  other_expense: '#CBD5E1'
}

const INCOME_LINE = '#E5484D'
const EXPENSE_LINE = '#0E9F6E'

const AXIS_TEXT = '#8A94A6'
const GRID_LINE = '#EDF1F8'

Page({
  data: {
    // 当前主题（根节点 class 用；初始化即读本地值，避免首帧闪一下默认色）
    theme: theme.currentId(),

    // 时间周期
    currentPeriod: 'month',
    periods: [
      { key: 'week', label: '本周' },
      { key: 'month', label: '本月' },
      { key: 'year', label: '本年' }
    ],

    // 图表类型：pie | bar
    chartType: 'pie',

    summary: { income: 0, expense: 0, balance: 0 },

    // 日均收支：分母 days 由云端给出（与云端区间口径同源）。
    // ⚠️ 别在客户端按设备时间算天数 —— 设备时区/系统时间被改过时，
    //    分母会和分子的区间对不上，用户自己一除就会发现数字错了。
    days: 0,
    dailyAvg: { income: 0, expense: 0 },

    categoryStats: [],
    topCategories: [],
    monthlyTrend: [],

    // 饼图中心当前聚焦的分类索引；-1 表示显示总计
    activeCat: -1,
    activeCatInfo: null,

    scanned: 0,
    loading: false,
    firstLoaded: false
  },


  // ---------------- 分享 ----------------
  // ⚠️ 必须定义 onShareAppMessage，否则右上角菜单不出现"转发"按钮，
  //    表现为用户点右上角三个点后提示"当前页面无法转发"。
  // 统计页用内容分享：标题带真实支出数字，转发才有传播力。这是用户主动点的
  // 转发，暴露什么由他自己决定（类似晒年度账单）；不设 imageUrl，微信会用
  // 当前页面截图（带图表），比固定封面更有传播力。
  onShareAppMessage() {
    return share.statsShare(this.data)
  },

  // 朋友圈分享：微信要求必须给图片，用固定封面（同样不带用户数据）
  onShareTimeline() {
    return share.timelineShare()
  },
  onLoad() {
    this._seq = 0
    this.loadStatistics()
  },

  onReady() {
    this._ready = true
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    // 主题：本页是 tabBar 页，顺便把原生 tabBar 的配色同步过去
    theme.attach(this, true)
    // 导入/记账后回到本页需要刷新
    if (this.loadedOnce) this.loadStatistics()
    this.loadedOnce = true
  },

  onPullDownRefresh() {
    this.loadStatistics().then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh())
  },

  // ---------------- 交互 ----------------

  switchPeriod(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.currentPeriod) return

    this.setData({ currentPeriod: key, activeCat: -1, activeCatInfo: null })
    this.loadStatistics()
  },

  toggleChartType() {
    const chartType = this.data.chartType === 'pie' ? 'bar' : 'pie'
    this.setData({ chartType })

    if (chartType === 'pie') {
      wx.nextTick(() => this.prepareCharts())
    }
  },

  // 点击图例：把某个分类的明细显示到环形图中心，再点一次取消
  onLegendTap(e) {
    const index = Number(e.currentTarget.dataset.index)
    const next = index === this.data.activeCat ? -1 : index
    const cat = this.data.categoryStats[next] || null

    this.setData({
      activeCat: next,
      activeCatInfo: cat ? { name: cat.name, amount: cat.amount, percent: cat.percent } : null
    })

    if (this.data.chartType === 'pie') this.prepareCharts()
  },

  // ---------------- 数据 ----------------

  async loadStatistics() {
    const seq = ++this._seq
    this.setData({ loading: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'getStatistics',
        data: { action: 'stats', period: this.data.currentPeriod }
      })

      // 已有更新的请求，丢弃本次结果（否则快速切换周期会显示上一次的数据）
      if (seq !== this._seq) return

      const result = res.result || {}
      if (result.code !== 0 || !result.data) {
        throw new Error(result.message || '统计失败')
      }

      const d = result.data

      const categoryStats = (d.categories || []).map(c => ({
        ...c,
        color: c.color || this.getCategoryColor(c.id)
      }))

      const topCategories = (d.topCategories || []).map(c => ({
        ...c,
        color: c.color || this.getCategoryColor(c.id)
      }))

      this.setData({
        summary: d.summary || { income: 0, expense: 0, balance: 0 },
        days: d.days || 0,
        dailyAvg: d.dailyAvg || { income: 0, expense: 0 },
        categoryStats,
        topCategories,
        monthlyTrend: d.monthlyTrend || [],
        scanned: d.scanned || 0,
        activeCat: -1,
        activeCatInfo: null,
        loading: false,
        firstLoaded: true
      })

      wx.nextTick(() => this.prepareCharts())
    } catch (err) {
      if (seq !== this._seq) return
      console.error('加载统计失败:', err)

      // 不使用假数据，避免误导
      this.setData({
        summary: { income: 0, expense: 0, balance: 0 },
        days: 0,
        dailyAvg: { income: 0, expense: 0 },
        categoryStats: [],
        topCategories: [],
        monthlyTrend: [],
        activeCat: -1,
        activeCatInfo: null,
        scanned: 0,
        loading: false,
        firstLoaded: true
      })
      wx.showToast({ title: '统计加载失败', icon: 'none' })
    }
  },

  getCategoryColor(categoryId) {
    return CATEGORY_COLORS[categoryId] || '#BDBDBD'
  },

  // ---------------- Canvas ----------------

  /**
   * 取到 canvas 节点并按 dpr 缩放，保证高清屏不模糊
   */
  acquireCanvas(selector) {
    return new Promise(resolve => {
      wx.createSelectorQuery()
        .in(this)
        .select(selector)
        .fields({ node: true, size: true })
        .exec(res => {
          const item = res && res[0]
          if (!item || !item.node || !item.width || !item.height) {
            resolve(null)
            return
          }

          let dpr = 2
          try {
            const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
            dpr = info.pixelRatio || 2
          } catch (e) {
            // 保持默认
          }

          const canvas = item.node
          canvas.width = Math.floor(item.width * dpr)
          canvas.height = Math.floor(item.height * dpr)

          const ctx = canvas.getContext('2d')
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

          resolve({ canvas, ctx, w: item.width, h: item.height })
        })
    })
  },

  async prepareCharts() {
    if (this.data.chartType === 'pie' && this.data.categoryStats.length > 0) {
      const cv = await this.acquireCanvas('#pieCanvas')
      if (cv) this.drawPieChart(cv)
    }

    if (this.data.monthlyTrend.length > 0) {
      const cv = await this.acquireCanvas('#lineCanvas')
      if (cv) this.drawLineChart(cv)
    }
  },

  /**
   * 环形图：每个扇形独立成环带，切片间留缝；中心显示总计或选中分类
   */
  drawPieChart({ ctx, w, h }) {
    ctx.clearRect(0, 0, w, h)

    const stats = this.data.categoryStats
    const total = stats.reduce((s, i) => s + (i.amount || 0), 0)

    const cx = w / 2
    const cy = h / 2
    const outerR = Math.min(w, h) / 2 - 2
    const innerR = outerR * 0.63

    if (total <= 0) {
      ctx.beginPath()
      ctx.arc(cx, cy, (outerR + innerR) / 2, 0, Math.PI * 2)
      ctx.strokeStyle = GRID_LINE
      ctx.lineWidth = outerR - innerR
      ctx.stroke()
      this.drawPieCenter(ctx, cx, cy, outerR, '暂无支出', '¥0.00')
      return
    }

    const single = stats.length === 1
    const gap = single ? 0 : 0.022
    const activeCat = this.data.activeCat

    let start = -Math.PI / 2

    stats.forEach((item, i) => {
      const angle = ((item.amount || 0) / total) * Math.PI * 2
      const a0 = start + gap
      const a1 = start + angle - gap
      start += angle

      if (a1 <= a0) return

      // 未选中的切片在聚焦时降低不透明度
      ctx.globalAlpha = activeCat >= 0 && activeCat !== i ? 0.28 : 1

      ctx.beginPath()
      ctx.arc(cx, cy, outerR, a0, a1)
      ctx.arc(cx, cy, innerR, a1, a0, true)
      ctx.closePath()
      ctx.fillStyle = item.color || '#BDBDBD'
      ctx.fill()
    })

    ctx.globalAlpha = 1

    const info = this.data.activeCatInfo
    if (info) {
      this.drawPieCenter(ctx, cx, cy, outerR, info.name, '¥' + cf.formatAmount(info.amount), info.percent + '%')
    } else {
      this.drawPieCenter(ctx, cx, cy, outerR, '总支出', '¥' + cf.formatAmount(total))
    }
  },

  drawPieCenter(ctx, cx, cy, outerR, label, value, sub) {
    const labelSize = Math.max(10, Math.round(outerR * 0.135))
    const valueSize = Math.max(13, Math.round(outerR * 0.2))

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const gap = labelSize * 0.9

    ctx.fillStyle = AXIS_TEXT
    ctx.font = `${labelSize}px -apple-system, sans-serif`
    ctx.fillText(label, cx, cy - gap * 0.75)

    ctx.fillStyle = '#101A2E'
    ctx.font = `600 ${valueSize}px -apple-system, sans-serif`
    ctx.fillText(value, cx, cy + gap * 0.5)

    if (sub) {
      ctx.fillStyle = AXIS_TEXT
      ctx.font = `${labelSize}px -apple-system, sans-serif`
      ctx.fillText(sub, cx, cy + gap * 1.75)
    }
  },

  /**
   * 近 6 个月趋势：双折线 + 面积渐变
   */
  drawLineChart({ ctx, w, h }) {
    ctx.clearRect(0, 0, w, h)

    const trend = this.data.monthlyTrend
    if (!trend || trend.length === 0) return

    const padTop = Math.max(16, h * 0.13)
    const padRight = Math.max(8, w * 0.035)
    const padBottom = Math.max(22, h * 0.18)
    const padLeft = Math.max(34, w * 0.14)

    const chartW = w - padLeft - padRight
    const chartH = h - padTop - padBottom
    const fontSize = Math.max(9, Math.round(w * 0.033))

    let maxValue = 0
    trend.forEach(t => {
      if (t.income > maxValue) maxValue = t.income
      if (t.expense > maxValue) maxValue = t.expense
    })
    maxValue = cf.niceMax(maxValue)

    // ---- 网格 + Y 轴刻度 ----
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    ctx.font = `${fontSize}px -apple-system, sans-serif`

    for (let i = 0; i <= 4; i++) {
      const y = padTop + (chartH / 4) * i

      ctx.beginPath()
      ctx.setLineDash(i === 4 ? [] : [3, 4])
      ctx.strokeStyle = GRID_LINE
      ctx.lineWidth = 1
      ctx.moveTo(padLeft, y)
      ctx.lineTo(w - padRight, y)
      ctx.stroke()

      ctx.fillStyle = AXIS_TEXT
      // ⚠️ 刻度文案由整轴的 maxValue 决定单位（整条轴统一），
      //    并且量级小时保留一位小数 —— 否则 niceMax=2.5 的五档会显示成
      //    「3 2 1 1 0」，出现两个一样的刻度，看起来像图坏了。
      ctx.fillText(
        cf.formatAxisTick(maxValue - (maxValue / 4) * i, maxValue),
        padLeft - 8,
        y
      )
    }

    ctx.setLineDash([])

    const n = trend.length
    const stepX = n > 1 ? chartW / (n - 1) : 0
    const px = i => padLeft + i * stepX
    const py = v => padTop + chartH - ((v || 0) / maxValue) * chartH

    // ---- 面积 + 折线 ----
    const drawSeries = (key, color) => {
      // 面积
      const grad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH)
      grad.addColorStop(0, cf.hexToRgba(color, 0.22))
      grad.addColorStop(1, cf.hexToRgba(color, 0))

      ctx.beginPath()
      ctx.moveTo(px(0), py(trend[0][key]))
      for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(trend[i][key]))
      ctx.lineTo(px(n - 1), padTop + chartH)
      ctx.lineTo(px(0), padTop + chartH)
      ctx.closePath()
      ctx.fillStyle = grad
      ctx.fill()

      // 折线
      ctx.beginPath()
      ctx.moveTo(px(0), py(trend[0][key]))
      for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(trend[i][key]))
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    drawSeries('income', INCOME_LINE)
    drawSeries('expense', EXPENSE_LINE)

    // ---- 数据点 ----
    trend.forEach((t, i) => {
      ;[t.income, t.expense].forEach((v, k) => {
        ctx.beginPath()
        ctx.arc(px(i), py(v), 3, 0, Math.PI * 2)
        ctx.fillStyle = '#FFFFFF'
        ctx.fill()
        ctx.strokeStyle = k === 0 ? INCOME_LINE : EXPENSE_LINE
        ctx.lineWidth = 2
        ctx.stroke()
      })
    })

    // ---- X 轴标签 ----
    ctx.fillStyle = AXIS_TEXT
    ctx.font = `${fontSize}px -apple-system, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    trend.forEach((t, i) => {
      ctx.fillText(t.month, px(i), padTop + chartH + 10)
    })
  }
})
