const version = require('../../utils/version.js')
const theme = require('../../utils/theme.js')
const color = require('../../utils/theme-color.js')
const share = require('../../utils/share.js')
const user = require('../../utils/user.js')

/**
 * 个人中心
 *
 * ⚠️ 为什么这里没有「登录」按钮？
 *    小程序里没有「不点登录就没身份」这回事：openid 由微信在云函数侧隐式提供
 *    （cloud.getWXContext().OPENID），它由微信签名、客户端伪造不了。
 *    所以身份是**无感**的，所有账单一直按它隔离；前端也从不存密码或 token。
 *    这里能设置的只有「昵称」这种展示用信息，见 utils/user.js。
 *    （历史教训：以前那个「登录」按钮调的是已废弃的 wx.getUserProfile，
 *      还依赖一个并不存在的 getOpenId 云函数，必然失败 —— 已删除。）
 */

// 分类关键词规则摘要（与 cloudfunctions/parseCSV 的 smartClassify 对应）
const RULE_SUMMARY = [
  '餐饮 —— 餐饮、美食、food、餐厅、外卖、美团、饿了么、肯德基、麦当劳、星巴克、茶…',
  '交通 —— 交通、出行、打车、滴滴、地铁、公交、高铁、加油、停车、机票…',
  '购物 —— 购物、超市、商场、淘宝、天猫、京东、拼多多、服饰…',
  '娱乐 —— 娱乐、电影、游戏、KTV、视频、音乐、旅游、健身…',
  '住房 —— 房租、租金、物业、水费、电费、燃气、宽带…',
  '医疗健康 —— 医院、药、医疗、诊所、体检…',
  '教育 —— 教育、培训、学费、书店、课程…',
  '通讯 —— 话费、流量、中国移动、中国联通、中国电信…',
  '工资 / 奖金 / 理财收益 / 红包转账 / 退款 —— 按交易对方与商品里的关键词识别',
  '兜底 —— 没命中任何关键词时，按收支分别归入「其他收入 / 其他支出」'
].join('\n')

// ==================== 关于本应用 ====================
//
// ⚠️ 这几项都写成常量、而不是直接写进 WXML：
//    它们既要显示，又要在「点击复制」时被复制走。抄两份的后果是
//    「屏幕上显示的邮箱」和「复制出来的邮箱」不一致 —— 而用户基本不可能发现，
//    只会遇到"发出去的邮件被退回"。所以显示与复制必须是同一个字符串。
//    tests/static-check.js 第 19 组会校验格式并与 WXML 的绑定对账。
const AUTHOR = 'sneezeee666'
const EMAIL = 'sneezeee@foxmail.com'
const GITHUB = 'https://github.com/sneezeee666-zsq'

// 版权起始年份。
// ⚠️ 区间写成「起始 - 当前」，不写死单一年份：写死 2026 的话，明年这份声明就过期了。
const COPYRIGHT_FROM = 2026

function buildCopyright(nowYear) {
  const y = Number(nowYear) || COPYRIGHT_FROM
  const range = y > COPYRIGHT_FROM ? COPYRIGHT_FROM + '-' + y : String(COPYRIGHT_FROM)
  return 'Copyright © ' + range + ' ' + AUTHOR + '. All rights reserved.'
}

// 首帧就要用到的主题信息：在模块加载时读一次本地存储，
// 这样页面第一次渲染就是用户选的主题，不会先闪一下默认色。
const INITIAL_THEME = theme.current()

// 同理：昵称也从本机缓存同步读，首帧就带着名字
const INITIAL_PROFILE = user.current()

/**
 * 自定义色的预览数据。
 * ⚠️ 预览里显示的是**最终会生效**的颜色（brandOf 会做明度收敛），
 *    而不是用户点下去的那个原始值 —— 否则"预览一个色、出去是另一个色"，
 *    这种不一致用户一定会发现，而且会认为功能坏了。
 */
function previewOf(hex) {
  const brand = color.brandOf(hex) || hex
  return { hex: hex, brand: brand, hero: color.heroOf(brand) }
}

/** 主题列表里"自定义"那一格的色块：挑过色就用那个色，没挑过给一条彩虹渐变 */
function customSwatch() {
  const hex = theme.customHex()
  if (hex) return 'background:' + hex
  return 'background:linear-gradient(135deg,#F97316 0%,#EC4899 34%,#6D4AE0 66%,#2B5CE6 100%)'
}

// 调色板：12 个色相 × 3 档明度（顺序按色相分组，一次挑完色相与深浅）
const PALETTE = color.palette()

/** 两个色相之间的最短距离（0~180）。0° 与 330° 只差 30°，不能按绝对差算 */
function hueDist(a, b) {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/**
 * 找与给定颜色最接近的色块。
 *
 * ⚠️ 为什么需要它：预设主题的品牌色（如 #07C160）并不在色板里。
 *    打开调色板时如果直接用预设色，色板里**一格都不会高亮**，
 *    用户会以为"什么都没选中、也不知道从哪开始"。
 *    高亮最近的一格，等于给了他一个可感知的起点。
 */
function nearestChip(hex) {
  const hsl = color.hexToHsl(hex)
  if (!hsl) return PALETTE[0].hex

  // 第一步：按色相选出最近的一族（红/橙/黄…）
  let family = PALETTE[0]
  let bestD = Infinity
  for (let i = 0; i < PALETTE.length; i++) {
    const d = hueDist(PALETTE[i].hue, hsl.h)
    if (d < bestD) {
      bestD = d
      family = PALETTE[i]
    }
  }

  // 第二步：在同一色相的三档里挑**亮度**最接近的。
  // ⚠️ 只按色相选会永远落到"深"档（数组里第一格），
  //    于是微信绿用户打开色板看到的是一格偏暗的墨绿，和他现在的颜色不像。
  const target = color.luminance(color.brandOf(hex))
  let best = family
  let bestL = Infinity
  for (let i = 0; i < PALETTE.length; i++) {
    const c = PALETTE[i]
    if (c.hue !== family.hue) continue
    const dl = Math.abs(color.luminance(c.hex) - target)
    if (dl < bestL) {
      bestL = dl
      best = c
    }
  }
  return best.hex
}

Page({
  data: {
    versionLabel: version.VERSION_LABEL,

    // 主题
    theme: INITIAL_THEME.id,
    // 自定义主题的 13 个令牌（内置主题为 ''，令牌都在 app.wxss 的 .theme-<id> 里）
    themeStyle: theme.rootStyle(),
    themeName: INITIAL_THEME.name,
    themeBrand: INITIAL_THEME.brand,
    themeList: theme.list(),
    showThemeSheet: false,

    // 自定义颜色
    showColorSheet: false,
    cpChips: PALETTE,
    // 未挑过色时以当前品牌色为起点，用户进来看到的就是"现在的颜色"，不是随机色
    cp: previewOf(theme.customHex() || INITIAL_THEME.brand),
    customSwatch: customSwatch(),

    // 昵称
    nickname: INITIAL_PROFILE.nickname,
    showNickSheet: false,
    nickDraft: '',
    nickLen: 0,
    nickError: '',
    nickSaving: false,

    // 统计数据（全部来自云端真实聚合，不使用占位数字）
    totalBills: 0,
    totalDays: 0,
    categoryCount: 0,

    // 关于（作者 / 联系方式 / 版权）
    showAboutSheet: false,
    author: AUTHOR,
    email: EMAIL,
    github: GITHUB,
    copyright: buildCopyright(new Date().getFullYear()),

    loading: false,
    firstLoaded: false
  },


  // ---------------- 分享 ----------------
  // ⚠️ 必须定义 onShareAppMessage，否则右上角菜单不出现"转发"按钮，
  //    表现为用户点右上角三个点后提示"当前页面无法转发"。
  // 本页可能是隐私页（账单/我的）或过程页，只用通用分享：固定封面、不带任何
  // 用户数据 —— 默认分享是当前页面截图，会把明细/统计数字一起截走。
  onShareAppMessage() {
    return share.appShare('/pages/profile/profile')
  },

  // 朋友圈分享：微信要求必须给图片，用固定封面（同样不带用户数据）
  onShareTimeline() {
    return share.timelineShare()
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 4 })
    }
    this.applyTheme()
    this.applyNickname()
    this.loadUserStats()
  },

  /**
   * 主题接入：把当前主题写进 data（根节点 class、设置项色点都用它），
   * 本页是 tabBar 页，顺便把原生 tabBar 的配色同步过去。
   */
  applyTheme() {
    theme.attach(this, true)
    const t = theme.current()

    // 只在真的变了才 setData，省掉一次跨线程通信
    const patch = {}
    if (this.data.themeName !== t.name) patch.themeName = t.name
    if (this.data.themeBrand !== t.brand) patch.themeBrand = t.brand

    // 「自定义」那一格的色块跟着本机存的自定义色走
    const sw = customSwatch()
    if (this.data.customSwatch !== sw) patch.customSwatch = sw

    if (Object.keys(patch).length) this.setData(patch)
  },

  // ---------------- 设置：昵称 ----------------

  /**
   * 昵称：先用本机缓存同步渲染（不闪），云端结果回来后再纠一次。
   * 与首页同一套做法，理由见 utils/user.js 顶部。
   */
  applyNickname() {
    const apply = (p) => {
      const nick = (p && p.nickname) || ''
      if (nick === this.data.nickname) return
      this.setData({ nickname: nick })
    }

    apply(user.current())

    // 序号防乱序：连着切几次 tab 时只认最后一次的结果
    const seq = (this._userSeq || 0) + 1
    this._userSeq = seq
    user.load().then(p => {
      if (seq !== this._userSeq) return
      apply(p)
    })
  },

  openNickSheet() {
    const nick = this.data.nickname
    this.setData({
      showNickSheet: true,
      nickDraft: nick,
      nickLen: user.nickLength(nick),
      nickError: ''
    })
  },

  closeNickSheet() {
    // 保存中不让关：关掉就看不清到底存没存上了
    if (this.data.nickSaving) return
    this.setData({ showNickSheet: false })
  },

  onNickInput(e) {
    const v = e.detail.value
    // ⚠️ 计数用 user.nickLength（按 Unicode 字符数，emoji 算 1 个），
    //    不能用 v.length —— 一个 emoji 在 UTF-16 里占两个码元，会多算一个
    this.setData({ nickDraft: v, nickLen: user.nickLength(v), nickError: '' })
  },

  async saveNickname() {
    if (this.data.nickSaving) return
    this.setData({ nickSaving: true, nickError: '' })

    try {
      const p = await user.setNickname(this.data.nickDraft)
      this.setData({
        nickname: p.nickname,
        showNickSheet: false,
        nickSaving: false
      })
      wx.showToast({ title: p.nickname ? '昵称已保存' : '已清除昵称', icon: 'none' })
    } catch (err) {
      // 就地提示而不是 toast：用户要一边看着输入框一边改
      this.setData({
        nickSaving: false,
        nickError: (err && err.message) || '保存失败，请重试'
      })
    }
  },

  // ---------------- 设置：主题 ----------------

  openThemeSheet() {
    this.setData({ showThemeSheet: true })
  },

  closeThemeSheet() {
    this.setData({ showThemeSheet: false })
  },

  onPickTheme(e) {
    const id = e.currentTarget.dataset.id
    if (!id || id === this.data.theme) {
      this.closeThemeSheet()
      return
    }

    // 立即生效并持久化；tabBar 由 setCurrent 内部同步
    const t = theme.setCurrent(id)
    this.setData({
      theme: t.id,
      themeName: t.name,
      themeBrand: t.brand,
      // 内置主题没有内联令牌，必须把它清掉 ——
      // 否则从自定义色切回内置主题时，旧的 --brand 会一直压在根节点上盖住 .theme-<id>
      themeStyle: theme.rootStyle(),
      showThemeSheet: false
    })
    // 再异步推到云端，让配色跟着账号走。失败了不提示也不回滚 ——
    // 本机已经生效了，只是"换设备看不到这个偏好"，不值得打断用户。
    user.syncTheme(t.id)
    wx.showToast({ title: '已切换为' + t.name, icon: 'none' })
  },

  // ---------------- 设置：自定义颜色 ----------------

  /** 打开调色板（从主题弹层里点「自定义」进来） */
  openColorSheet() {
    // 挑过自定义色就从它开始；没挑过则从"最接近当前品牌色"的那一格开始
    const saved = theme.customHex()
    this.setData({
      showThemeSheet: false,
      showColorSheet: true,
      cp: previewOf(saved || nearestChip(this.data.themeBrand))
    })
  },

  closeColorSheet() {
    this.setData({ showColorSheet: false })
  },

  /** 点色块：只更新预览，不立刻落盘 —— 用户还会继续比较 */
  onPickColor(e) {
    const hex = e.currentTarget.dataset.hex
    if (!hex) return
    this.setData({ cp: previewOf(hex) })
  },

  /**
   * 确认使用自定义色
   *
   * ⚠️ 落盘之后必须把 themeStyle 一起写进 data：
   *    本页根节点的内联令牌是 data 驱动的，只改 theme id 会让 class 变成
   *    .theme-custom 而令牌还是上一套 —— 页面会变成"新主题 + 旧颜色"的混合体。
   */
  onConfirmColor() {
    const hex = color.normalizeHex(this.data.cp.hex)
    if (!hex) {
      wx.showToast({ title: '这个颜色不可用，换一个试试', icon: 'none' })
      return
    }

    const t = theme.setCurrent(theme.CUSTOM_ID, hex)

    this.setData({
      theme: t.id,
      themeName: t.name,
      themeBrand: t.brand,
      themeStyle: theme.rootStyle(),
      customSwatch: customSwatch(),
      showColorSheet: false
    })

    user.syncTheme(t.id, hex)
    wx.showToast({ title: '已用上自定义色', icon: 'none' })
  },

  onPullDownRefresh() {
    this.loadUserStats().then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh())
  },

  /**
   * 加载总览统计（云端聚合）
   *
   * ⚠️ 用「请求序号」而不是 `if (this.data.loading) return` 闸门：
   *    后者把后一次请求直接丢掉，于是下拉刷新看起来"没反应"，
   *    或者界面停在上一次的数据上（与账单页是同一个坑）。
   *    序号写法保证「只有最新一次的结果允许写进 data」。
   */
  async loadUserStats() {
    const seq = (this._statsSeq || 0) + 1
    this._statsSeq = seq

    this.setData({ loading: true })

    try {
      const res = await wx.cloud.callFunction({
        name: 'getStatistics',
        data: { action: 'profile' }
      })

      if (seq !== this._statsSeq) return

      const result = (res && res.result) || {}
      if (result.code !== 0 || !result.data) {
        throw new Error(result.message || '统计失败')
      }

      this.setData({
        totalBills: result.data.totalBills || 0,
        totalDays: result.data.totalDays || 0,
        categoryCount: result.data.categoryCount || 0,
        loading: false,
        firstLoaded: true
      })
    } catch (err) {
      if (seq !== this._statsSeq) return
      console.error('加载统计失败:', err)
      // 不使用假数据，避免误导
      this.setData({ totalBills: 0, totalDays: 0, categoryCount: 0, loading: false, firstLoaded: true })
    }
  },

  // ---------------- 数据管理 ----------------

  goToImport() {
    wx.navigateTo({ url: '/pages/import/import' })
  },

  exportData() {
    wx.showActionSheet({
      itemList: ['导出为 CSV'],
      success: (res) => {
        if (res.tapIndex === 0) this.exportAsCSV()
      }
    })
  },

  async exportAsCSV() {
    if (this.data.totalBills === 0) {
      wx.showToast({ title: '暂无数据可导出', icon: 'none' })
      return
    }

    wx.showLoading({ title: '导出中...', mask: true })

    try {
      // ⚠️ 客户端单次只能取 20 条，必须走云函数分页取全量
      const all = []
      const pageSize = 100
      let page = 0
      let hasMore = true

      while (hasMore && page < 200) {
        const res = await wx.cloud.callFunction({
          name: 'getStatistics',
          data: { action: 'bills', period: 'all', page, pageSize }
        })

        const result = (res && res.result) || {}
        if (result.code !== 0 || !result.data) {
          throw new Error(result.message || '读取账单失败')
        }

        all.push.apply(all, result.data.bills || [])
        hasMore = !!result.data.hasMore
        page++
      }

      if (all.length === 0) {
        wx.hideLoading()
        wx.showToast({ title: '暂无数据可导出', icon: 'none' })
        return
      }

      // 生成 CSV（字段值统一转义，避免逗号/引号破坏结构）
      const esc = v => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`
      const lines = ['交易时间,收支,交易对方,商品,金额,分类,支付方式,当前状态,交易单号']

      all.forEach(bill => {
        lines.push([
          esc(this.formatFullTime(bill.createTime)),
          esc(bill.type === 'income' ? '收入' : '支出'),
          esc(bill.title),
          esc(bill.product),
          bill.amount,
          esc(bill.category),
          esc(bill.payMethod),
          esc(bill.status),
          esc(bill.orderNo)
        ].join(','))
      })

      // \ufeff 让 Excel 正确识别 UTF-8
      const csv = '\ufeff' + lines.join('\r\n')

      const fs = wx.getFileSystemManager()
      const tempPath = `${wx.env.USER_DATA_PATH}/账单导出_${Date.now()}.csv`
      fs.writeFileSync(tempPath, csv, 'utf-8')

      wx.hideLoading()

      wx.shareFileMessage({
        filePath: tempPath,
        fileName: `智能账单_${this.formatFullTime(Date.now()).slice(0, 10)}.csv`,
        success: () => {
          wx.showToast({ title: `已导出 ${all.length} 条`, icon: 'success' })
        },
        fail: (err) => {
          console.error('分享失败:', err)
          wx.saveFileToDisk({
            filePath: tempPath,
            success: () => {
              wx.showToast({ title: '已保存到文件管理器', icon: 'success' })
            },
            fail: () => {
              wx.showToast({ title: '导出失败', icon: 'none' })
            }
          })
        }
      })
    } catch (err) {
      wx.hideLoading()
      console.error('导出失败:', err)
      wx.showToast({ title: '导出失败，请重试', icon: 'none' })
    }
  },

  // 按北京时间格式化 YYYY-MM-DD HH:mm
  formatFullTime(ts) {
    if (!ts) return ''
    const d = new Date(ts + 8 * 60 * 60 * 1000)
    const pad = n => String(n).padStart(2, '0')
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  },

  // 清空账单数据（二次确认）
  clearAllData() {
    if (this.data.totalBills === 0) {
      wx.showToast({ title: '当前没有账单数据', icon: 'none' })
      return
    }

    wx.showModal({
      title: '确认清空',
      content: `将删除当前账号下的全部 ${this.data.totalBills} 条账单记录，此操作不可恢复。`,
      confirmText: '清空',
      confirmColor: '#E5484D',
      success: (res) => {
        if (res.confirm) this.doClearAllData()
      }
    })
  },

  async doClearAllData() {
    wx.showLoading({ title: '清空中...', mask: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'parseCSV',
        data: { action: 'clear' }
      })
      wx.hideLoading()

      if (res.result && res.result.code === 0) {
        wx.showToast({ title: `已清空 ${res.result.deleted} 条`, icon: 'success' })
        this.loadUserStats()
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '清空失败', icon: 'none' })
      }
    } catch (err) {
      wx.hideLoading()
      console.error('清空失败:', err)
      wx.showToast({ title: '清空失败，请重试', icon: 'none' })
    }
  },

  // ---------------- 说明类 ----------------

  showCategoryRules() {
    wx.showModal({
      title: '分类是怎么识别的',
      content: '按「交易对方 + 商品」里的关键词做匹配，命中即归类；\n' +
        '手动记账和导入账单用的是同一套规则。\n\n' + RULE_SUMMARY,
      showCancel: false,
      confirmText: '知道了'
    })
  },

  showPrivacy() {
    wx.showModal({
      title: '数据与隐私',
      content: '所有账单都存放在你自己的微信云开发环境中，按微信账号（openid）隔离，' +
        '其他用户与开发者都无法读取。\n\n这里不需要登录：身份由微信隐式提供，' +
        '应用不收集、也不保存你的任何密码。昵称只用于界面展示，不是账号、不能用来登录。\n\n' +
        '卸载小程序不会删除云端数据；如需彻底清除，请使用「清空账单数据」。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  /**
   * 关于。
   *
   * ⚠️ 为什么从 wx.showModal 改成底部弹层？
   *    modal 的正文是纯文本：放不下作者/邮箱/GitHub/版权四行，
   *    文字长了还会被折成一大段；而且里面的链接**点不了也复制不了**，
   *    用户只能手抄 —— 手抄的地址基本都会错。
   *    弹层里每一行都能点一下复制，复制的是常量原文。
   */
  showAbout() {
    this.setData({ showAboutSheet: true })
  },

  closeAboutSheet() {
    this.setData({ showAboutSheet: false })
  },

  /** 常记的配置页 */
  goQuickPicks() {
    wx.navigateTo({ url: '/pages/quick-manage/quick-manage' })
  },

  /**
   * 复制一项联系方式。
   * 取值一律用上面的常量，不用 data 里的展示值 ——
   * 展示值将来可能被省略号截断，复制出去就成了半个地址。
   */
  copyAbout(e) {
    const field = e.currentTarget.dataset.field
    const map = { email: EMAIL, github: GITHUB }
    const text = map[field]
    if (!text) return

    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({
        title: field === 'email' ? '邮箱已复制' : 'GitHub 地址已复制',
        icon: 'none'
      })
    })
  }
})
