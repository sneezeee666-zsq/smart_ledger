const theme = require('../../utils/theme.js')
const share = require('../../utils/share.js')
const dedup = require('../../utils/bill-dedup.js')
const db = wx.cloud.database()

/**
 * 账单导入页
 *
 * 解析统一走 parseCSV 云函数：
 *   - xlsx / csv 都在云端解析，避免前后端两套解析器行为不一致
 *     （客户端那套没有表头扫描，遇到微信账单前面 16 行说明会直接解析失败）
 *   - 时间解析也统一在云端完成（Excel 序列号 / 字符串 / Date 三种形态），
 *     解析不出来就跳过，绝不用「导入时间」冒充交易时间
 *
 * ⚠️ 全量数据为什么放在实例属性（this._allBills）而不是 data 里：
 *    setData 有 1MB 上限，而以前 parsedData 与 newBills 各存一份全量
 *    （同一个数组会被序列化两遍），几百条就往上限撞。
 *    页面渲染只用得到「条数」，所以 data 里只放计数。
 */

// 写入并发度（小程序客户端写库有频率限制，5 是一个稳妥值）
const WRITE_CONCURRENCY = 5

// 去重提交分批大小：判重键每条约 40 字节，1500 条 ≈60KB，
// 稳稳落在 wx.cloud.callFunction 的 data 建议临界值（100KB）之内。
// ⚠️ 曾经是**整条账单**提交的：一条解析结果有 15 个字段（≈330 字节），
//    500 条就 ≈165KB，超过临界值直接报 data exceed max size ——
//    表现就是「大文件去重检查失败」，然后确认页显示 0 条。
const DEDUP_CHUNK = 1500

Page({
  data: {
    // 当前主题（根节点 class 用；初始化即读本地值，避免首帧闪一下默认色）
    theme: theme.currentId(),

    statusBarHeight: 20,
    currentStep: 1,

    // 文件信息
    fileName: '',
    fileSize: '',
    filePath: '',
    fileType: '',  // 'csv' | 'xlsx'
    fileExt: '',   // 展示用扩展名徽标：XLSX / XLS / CSV
    uploading: false,

    // 解析数据（全量在 this._allBills，这里只放页面要渲染的计数）
    parsedCount: 0,
    previewList: [],
    incomeCount: 0,
    expenseCount: 0,
    totalIncome: 0,
    totalExpense: 0,
    dateRange: '',
    skippedCount: 0,

    // 去重结果（全量在 this._newBills）
    newCount: 0,           // 需要新增的条数
    duplicateCount: 0,     // 与已有数据重复的条数
    existingCount: 0,      // 原有记录总数
    // ⚠️ 去重是异步的，并且它才是决定「哪些记录会被写进去」的那一步。
    //    没有这个闸门时：解析完先展示，去重结果稍后才到，
    //    用户在这几百毫秒里点「下一步 → 确认导入」，写进去的就是**未去重**的全量 ——
    //    重复导入。这里把它当成一个必须等的状态。
    deduping: false,

    // 导入状态
    importing: false,
    importedCount: 0,
    failedCount: 0
  },


  // ---------------- 分享 ----------------
  // ⚠️ 必须定义 onShareAppMessage，否则右上角菜单不出现"转发"按钮，
  //    表现为用户点右上角三个点后提示"当前页面无法转发"。
  // 本页可能是隐私页（账单/我的）或过程页，只用通用分享：固定封面、不带任何
  // 用户数据 —— 默认分享是当前页面截图，会把明细/统计数字一起截走。
  onShareAppMessage() {
    return share.appShare('/pages/import/import')
  },

  // 朋友圈分享：微信要求必须给图片，用固定封面（同样不带用户数据）
  onShareTimeline() {
    return share.timelineShare()
  },
  onLoad() {
    // 本页不是 tabBar 页，只取主题（tabBar 由 tabBar 页负责同步）
    theme.attach(this)

    // wx.getSystemInfoSync 已废弃，优先用 wx.getWindowInfo
    let statusBarHeight = 20
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      statusBarHeight = info.statusBarHeight || statusBarHeight
    } catch (e) {
      // 保持默认值
    }
    this.setData({ statusBarHeight })
  },

  onShow() {
    // 在「我的」里换过主题后返回本页要跟着变
    theme.attach(this)
  },

  // 返回上一页
  goBack() {
    if (this.data.currentStep > 1) {
      this.goBackStep()
    } else {
      wx.navigateBack()
    }
  },

  // 选择文件（支持 xlsx / csv）
  chooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx', 'xls', 'csv'],
      success: (res) => {
        const file = res.tempFiles[0]
        const name = String(file.name || '').toLowerCase()

        if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
          wx.showToast({ title: '请选择 Excel 或 CSV 文件', icon: 'none' })
          return
        }

        this.setData({
          fileName: file.name,
          fileSize: this.formatFileSize(file.size),
          filePath: file.path,
          fileType: name.endsWith('.csv') ? 'csv' : 'xlsx',
          fileExt: name.endsWith('.csv') ? 'CSV' : (name.endsWith('.xls') ? 'XLS' : 'XLSX')
        })
      },
      fail: (err) => {
        console.error('选择文件失败:', err)
      }
    })
  },

  // 移除文件
  removeFile() {
    this.setData({
      fileName: '',
      fileSize: '',
      filePath: '',
      fileType: '',
      fileExt: ''
    })
  },

  // 格式化文件大小
  formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  },

  /**
   * 解析文件：上传到云存储 → 交给 parseCSV 云函数解析
   */
  async parseFile() {
    if (!this.data.filePath) {
      wx.showToast({ title: '请先选择文件', icon: 'none' })
      return
    }

    this.setData({ uploading: true })
    wx.showLoading({ title: '正在上传并解析...' })

    try {
      const isXls = /\.xls$/i.test(this.data.fileName)
      const ext = isXls ? '.xls' : (this.data.fileType === 'csv' ? '.csv' : '.xlsx')

      const uploadRes = await wx.cloud.uploadFile({
        cloudPath: `bills/${Date.now()}${ext}`,
        filePath: this.data.filePath
      })

      const parseRes = await wx.cloud.callFunction({
        name: 'parseCSV',
        data: {
          fileID: uploadRes.fileID,
          fileName: this.data.fileName
        }
      })

      wx.hideLoading()

      const result = (parseRes && parseRes.result) || {}
      if (result.code !== 0 || !Array.isArray(result.data)) {
        throw new Error(result.message || '云函数解析失败')
      }

      await this.handleParsedData(result.data, result.keys, result.skipped || 0)

      // 云存储里的临时文件用完即删，避免占用空间
      this.removeCloudFile(uploadRes.fileID)
    } catch (err) {
      wx.hideLoading()
      console.error('解析文件失败:', err)
      wx.showToast({ title: '解析失败: ' + (err.message || '文件格式错误'), icon: 'none' })
    } finally {
      this.setData({ uploading: false })
    }
  },

  // 删除云端临时文件（失败无妨）
  removeCloudFile(fileID) {
    if (!fileID) return
    wx.cloud.deleteFile({ fileList: [fileID] }).catch(err => {
      console.warn('清理临时文件失败:', err)
    })
  },

  /**
   * 处理解析结果：统计 → 展示 → 云端去重
   * @param {Array} data 云端解析出的账单
   * @param {Array<string>} keys 与 data **逐下标对齐**的判重键
   * @param {number} skipped 云端跳过的条数（时间无法识别）
   */
  async handleParsedData(data, keys, skipped = 0) {
    if (!data || data.length === 0) {
      wx.showToast({ title: '未找到有效记录', icon: 'none' })
      return
    }

    // ⚠️ 键与记录必须逐下标对齐，否则去重会错配到别的记录上：
    //    表现是「该留下的被去掉、该去掉的留下来」，而且没有任何报错。
    //    对不上通常是云函数没更新（旧版 parse 不返回 keys）。
    if (!Array.isArray(keys) || keys.length !== data.length) {
      wx.showToast({ title: '解析结果异常，请重新上传', icon: 'none' })
      return
    }

    // 计算统计
    const incomeBills = data.filter(b => b.type === 'income')
    const expenseBills = data.filter(b => b.type === 'expense')

    const totalIncome = incomeBills.reduce((sum, b) => sum + (b.amount || 0), 0)
    const totalExpense = expenseBills.reduce((sum, b) => sum + (b.amount || 0), 0)

    // 时间范围
    const times = data.map(b => b.createTime).filter(t => t)
    const minTime = times.length > 0 ? Math.min.apply(null, times) : 0
    const maxTime = times.length > 0 ? Math.max.apply(null, times) : 0

    // 取前20条作为预览（补一个只用于渲染的稳定 key）
    const previewList = data.slice(0, 20).map((b, i) => ({ ...b, _idx: i }))

    // 全量数据放实例属性，不放 data（setData 有 1MB 上限，见文件顶部说明）
    this._allBills = data
    this._keys = keys

    // 先展示解析结果（去重结果稍后异步补上）
    this.setData({
      parsedCount: data.length,
      previewList,
      incomeCount: incomeBills.length,
      expenseCount: expenseBills.length,
      totalIncome,
      totalExpense,
      dateRange: minTime && maxTime ? `${this.formatDate(minTime)} ~ ${this.formatDate(maxTime)}` : '—',
      skippedCount: skipped,
      newCount: 0,
      duplicateCount: 0,
      existingCount: 0,
      deduping: true,
      currentStep: 2
    })

    await this.checkDuplicates()
  },

  /**
   * 云端去重：**分批**提交判重键，查出哪些已在库里
   *
   * ⚠️ 只传键、不传账单：wx.cloud.callFunction 的 data 有传输大小限制
   *    （官方建议临界值 100KB），整份账单 500 条就超限 —— 这正是
   *    「大文件去重检查失败」的根因。分批则让任意大小的文件都能过。
   */
  async checkDuplicates() {
    const keys = this._keys || []

    // 序号防乱序：重试/重新上传时只认最后一次的结果
    const seq = (this._dedupSeq || 0) + 1
    this._dedupSeq = seq

    try {
      const dbDup = new Set()
      let existing = 0

      for (let i = 0; i < keys.length; i += DEDUP_CHUNK) {
        const res = await wx.cloud.callFunction({
          name: 'parseCSV',
          data: { action: 'dedup', keys: keys.slice(i, i + DEDUP_CHUNK) }
        })

        if (seq !== this._dedupSeq) return

        const result = (res && res.result) || {}
        if (result.code !== 0) {
          throw new Error(result.message || '去重失败')
        }

        // 下标要加上本批的偏移，才是全量里的位置
        const idx = (result.data && result.data.dupIdx) || []
        idx.forEach(k => dbDup.add(i + k))
        if (result.data) existing = result.data.existing
      }

      if (seq !== this._dedupSeq) return

      // 批内重复在本地判：这个 Set 跨越所有分批，
      // 所以第二批里出现与第一批相同的键照样会被挑掉
      const { newBills, duplicateCount } = dedup.filterNewBills(this._allBills, keys, dbDup)

      this._newBills = newBills

      this.setData({
        newCount: newBills.length,
        duplicateCount,
        existingCount: existing,
        deduping: false
      })
    } catch (err) {
      if (seq !== this._dedupSeq) return
      console.warn('去重检查失败:', err)
      wx.showToast({ title: '去重检查失败，请稍后重试', icon: 'none' })
      // 去重失败时不允许继续，避免把重复数据写进去
      this._newBills = []
      this.setData({ newCount: 0, deduping: false })
    }
  },

  // 按北京时间格式化日期 YYYY-MM-DD
  formatDate(ts) {
    const d = new Date(ts + 8 * 60 * 60 * 1000)
    const pad = n => String(n).padStart(2, '0')
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  },

  // 上一步
  goBackStep() {
    if (this.data.currentStep > 1) {
      this.setData({ currentStep: this.data.currentStep - 1 })
    }
  },

  // 前往确认页
  goToConfirm() {
    // ⚠️ 去重还没回来就进确认页，页面上「本次新增」会显示未去重的条数，
    //    用户按这个数字确认，写进去的就是重复数据。必须拦住。
    if (this.data.deduping) {
      wx.showToast({ title: '正在检查重复，稍候一下', icon: 'none' })
      return
    }
    this.setData({ currentStep: 3 })
  },

  /**
   * 确认导入：只写入去重后的新记录
   * 并发写入（每批 5 条），失败的单条不阻塞其余记录
   */
  async confirmImport() {
    // 兜底：即使从别处绕到了第 3 步，去重没完成也绝不下写
    if (this.data.deduping) {
      wx.showToast({ title: '正在检查重复，稍候一下', icon: 'none' })
      return
    }

    const toImport = this._newBills || []

    if (toImport.length === 0) {
      wx.showToast({ title: '没有新记录需要导入', icon: 'none' })
      this.setData({ currentStep: 4, importedCount: 0, failedCount: 0 })
      return
    }

    this.setData({ importing: true })

    const total = toImport.length
    let importedCount = 0
    let failedCount = 0

    wx.showLoading({ title: `导入中 0/${total}`, mask: true })

    try {
      for (let i = 0; i < total; i += WRITE_CONCURRENCY) {
        const slice = toImport.slice(i, i + WRITE_CONCURRENCY)

        // 客户端写入会自动带上 _openid，无需手动指定
        // （result 里云函数回传的 openid 字段是冗余的，写库前去掉）
        const results = await Promise.all(
          slice.map(item => {
            const doc = { ...item, createTime: item.createTime || Date.now(), updateTime: Date.now() }
            delete doc.openid
            delete doc._id
            return db.collection('bills').add({ data: doc })
              .then(() => true)
              .catch(err => {
                console.error('单条写入失败:', err)
                return false
              })
          })
        )

        results.forEach(ok => {
          if (ok) importedCount++
          else failedCount++
        })

        wx.showLoading({ title: `导入中 ${importedCount + failedCount}/${total}`, mask: true })
      }

      wx.hideLoading()

      this.setData({
        importing: false,
        importedCount,
        failedCount,
        currentStep: 4
      })

      if (failedCount > 0) {
        wx.showToast({ title: `成功 ${importedCount} 条，失败 ${failedCount} 条`, icon: 'none' })
      } else {
        wx.showToast({ title: '导入成功！', icon: 'success' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('导入失败:', err)
      this.setData({ importing: false, importedCount, failedCount })
      wx.showToast({ title: `导入中断，已写入 ${importedCount} 条`, icon: 'none' })
    }
  },

  // 导航方法
  goToBills() {
    wx.switchTab({ url: '/pages/bills/bills' })
  },

  goToStats() {
    wx.switchTab({ url: '/pages/stats/stats' })
  },

  reImport() {
    // 实例属性也要清：留着上一次的全量，下次导入会把旧记录混进来
    this._allBills = []
    this._keys = []
    this._newBills = []
    this.setData({
      currentStep: 1,
      fileName: '',
      fileSize: '',
      filePath: '',
      fileType: '',
      fileExt: '',
      parsedCount: 0,
      previewList: [],
      newCount: 0,
      duplicateCount: 0,
      existingCount: 0,
      deduping: false,
      importedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      dateRange: ''
    })
  }
})
