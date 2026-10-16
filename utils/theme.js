/**
 * 主题色系统
 * ---------------------------------------------------------------------------
 * 单一数据源就是下面的 THEMES：
 *   1. app.wxss 里每个 id 对应一个 `.theme-<id>` 类（tests/static-check.js 会校验
 *      两边不脱节：类存在、--brand 与 --hero-top 的值与这里一致）
 *   2. assets/icons/<shape>-active-<id>.png 是各主题的 tabBar 选中图标
 *      （原生 tabBar 只能用图片文件，没法用 CSS 变量染色 → 只能预生成，
 *        生成脚本 tools/gen-icons.py 直接读本文件取色，不另存一份色表）
 *   3. 每套主题的 hero 首色（hero 字段）要喂给 wx.setNavigationBarColor ——
 *      原生导航栏同样没法用 CSS 染色。首页的 hero 卡片顶到导航栏下面，
 *      两者不同色就会露出一条明显的色差接缝，所以这个值必须在 JS 侧也有一份。
 *
 * 为什么用「类 + CSS 变量」而不是直接改样式？
 *   小程序没有全局样式注入能力，`page` 也不能挂类。给每个页面的**根节点**挂
 *   `.theme-<id>` 是最稳的做法：变量在那个节点上被重新声明，整棵子树（含
 *   position: fixed 的弹层、气泡）自动继承。
 *
 * ⚠️ 为什么不能再写「旧变量名 → 新值」的别名层？
 *   CSS 自定义属性是在**声明它的那个元素上**完成 var() 替换的，替换结果再向下继承。
 *   把 `--primary-color: var(--brand)` 声明在 page 上，子元素重新声明 --brand 时
 *   --primary-color **不会**跟着变 —— 主题切换会出现「一部分变了、一部分没变」。
 */

// 本地存储键（改键名会导致老用户主题回到默认，非必要不要动）
const STORAGE_KEY = 'app_theme_id'

// 默认主题：微信绿
const DEFAULT_ID = 'green'

// 页面底色（app.wxss 的 --surface-2 / app.json 的 window.backgroundColor 同值）。
// 下拉刷新时只有「顶部露出区」是 hero 色，其余仍是这个浅灰 —— 否则底部过度滚动
// 会跟着变成深色，看起来像页面漏了一块。
const PAGE_BG = '#F2F5FA'

/**
 * 主题清单。
 * id 同时被用于：CSS 类名 .theme-<id>、tabBar 图标文件名 -active-<id>.png
 * brand = 品牌色（按钮/选中态）；hero = 顶部深色 hero 卡片的渐变首色
 * 一行一个主题，方便 tools/gen-icons.py 与静态检查用正则读取。
 *
 * ⚠️ hero 的取值标准（不是随手调暗品牌色）：
 *   1. 白字对比度 ≥ 6.5:1 —— 卡片上有 68rpx 的结余大数字，太亮就糊；
 *      同时末档色上的灰白小字（--on-hero-dim）要 ≥ 4.5:1，所以这套色**不能更浅**了，
 *      再浅就得把 --on-hero-dim 的透明度继续往上调。
 *   2. 同色系里选「中深饱和」而不是「接近黑的墨色」：早先用的是 L≈6% 的墨绿/墨蓝，
 *      在白底页面里像一块黑补丁，用户反馈「太深了、渐变还很明显」。
 *   3. 渐变三档的亮度比 ≤ 1.3 —— 只有"几乎看不出来"的渐变才是高级感，
 *      跨度一大就变成廉价的塑料渐变。
 */
const THEMES = [
  { id: 'green', name: '微信绿', brand: '#07C160', hero: '#0B5F3A' },
  { id: 'blue', name: '晴空蓝', brand: '#2B5CE6', hero: '#1B4C8F' },
  { id: 'violet', name: '暮光紫', brand: '#6D4AE0', hero: '#4B3894' },
  { id: 'orange', name: '暖阳橙', brand: '#F97316', hero: '#7F3E0B' },
  { id: 'rose', name: '樱花粉', brand: '#EC4899', hero: '#94224F' }
]

// tabBar 图标的基础名，顺序必须与 app.json 的 tabBar.list 一致
// ⚠️ 顺序错了不会报错，只会「点统计却亮成 AI 的图标」—— tests/static-check.js
//    会把这里、app.json、tools/gen-icons.py 三处一起对账。
const TAB_SHAPES = ['home', 'bill', 'chart', 'ai', 'user']

// 未选中态：所有主题共用一套灰色图标
const TAB_INACTIVE = '#8A94A6'

// 记录「已经同步到原生 tabBar / 导航栏的主题」，避免每次 onShow 都重复调用
let appliedTabTheme = ''
let appliedNavTheme = ''

function list() {
  return THEMES
}

/** 把任意输入收敛成合法 id，非法值一律回落到默认主题 */
function normalize(id) {
  for (let i = 0; i < THEMES.length; i++) {
    if (THEMES[i].id === id) return id
  }
  return DEFAULT_ID
}

function byId(id) {
  const safe = normalize(id)
  for (let i = 0; i < THEMES.length; i++) {
    if (THEMES[i].id === safe) return THEMES[i]
  }
  return THEMES[0]
}

/** 当前主题 id（读本地存储；读取失败也不抛，直接回默认） */
function currentId() {
  try {
    return normalize(wx.getStorageSync(STORAGE_KEY))
  } catch (e) {
    return DEFAULT_ID
  }
}

/** 当前主题对象 */
function current() {
  return byId(currentId())
}

/**
 * 把主题色同步到原生 tabBar。
 * ⚠️ 只有 tabBar 页面能调这两个接口，在非 tabBar 页调用会 fail（已静默忽略）。
 * @param {boolean} force 同一主题也强制重设（用户手动切换后用）
 */
function syncTabBar(force) {
  const id = currentId()
  if (!force && appliedTabTheme === id) return

  const theme = byId(id)

  wx.setTabBarStyle({
    color: TAB_INACTIVE,
    selectedColor: theme.brand,
    backgroundColor: '#ffffff',
    borderStyle: 'white',
    success: () => { appliedTabTheme = id },
    fail: () => { /* 不在 tabBar 页，下次进入 tabBar 页会重试 */ }
  })

  TAB_SHAPES.forEach((shape, index) => {
    // 相对路径形式与 app.json 保持一致，避免两种写法在小程序里解析不一致
    wx.setTabBarItem({
      index,
      iconPath: 'assets/icons/' + shape + '.png',
      selectedIconPath: 'assets/icons/' + shape + '-active-' + id + '.png',
      fail: () => { /* 同上，忽略 */ }
    })
  })
}

/**
 * 把 hero 色同步到**原生导航栏**与下拉刷新露出的顶部底色。
 *
 * ⚠️ 只有「深色导航栏」的页面才该调这个（目前只有首页：hero 卡片顶到导航栏
 *    下面，导航栏必须同色，否则中间会有一条色差带）。账单/统计/我的都是白底
 *    黑字导航栏，跟主题无关 —— 在那里调用会把导航栏莫名其妙染成深色。
 *
 * @param {boolean} force 同一主题也强制重设
 */
function syncNavBar(force) {
  const id = currentId()
  if (!force && appliedNavTheme === id) return

  const theme = byId(id)

  wx.setNavigationBarColor({
    frontColor: '#ffffff',
    backgroundColor: theme.hero,
    success: () => { appliedNavTheme = id },
    // 不在当前页面栈顶或基础库太低时失败：不打标记，下次进页面会自动重试
    fail: () => { /* 忽略 */ }
  })

  // 只染「顶部露出区」：底部过度滚动要还是浅色页面底，否则看起来像页面漏了一块
  wx.setBackgroundColor({
    backgroundColor: PAGE_BG,
    backgroundColorTop: theme.hero,
    backgroundColorBottom: PAGE_BG,
    fail: () => { /* 忽略 */ }
  })
}

/**
 * 页面接入：把当前主题写进页面 data（根节点 class 用它），并同步 tabBar / 导航栏。
 * 放在 onShow 里调用即可，切主题后返回本页会自动跟着变。
 * @param {object} page  页面实例（传 this）
 * @param {boolean} withTabBar  本页是否是 tabBar 页
 * @param {boolean} withNavBar  本页是否用深色导航栏（hero 顶到导航栏的那种，目前只有首页）
 */
function attach(page, withTabBar, withNavBar) {
  if (!page || typeof page.setData !== 'function') return
  const id = currentId()
  // 相同就不 setData，省掉一次跨线程通信
  if (!page.data || page.data.theme !== id) {
    page.setData({ theme: id })
  }
  if (withTabBar) syncTabBar(false)
  if (withNavBar) syncNavBar(false)
}

/**
 * 保存并立即应用主题（个人中心切换时调用）。
 *
 * 注意这里**只**同步 tabBar，不同步导航栏：本页（我的）导航栏是白底黑字，
 * 跟主题无关。首页的导航栏会在它自己的 onShow（attach 的第三个参数）里刷新。
 *
 * @returns {object} 主题对象
 */
function setCurrent(id) {
  const theme = byId(id)
  try {
    wx.setStorageSync(STORAGE_KEY, theme.id)
  } catch (e) {
    // 存储失败不阻塞切换：本次会话仍然生效，只是下次启动回默认
  }
  syncTabBar(true)
  return theme
}

module.exports = {
  DEFAULT_ID: DEFAULT_ID,
  STORAGE_KEY: STORAGE_KEY,
  PAGE_BG: PAGE_BG,
  list: list,
  normalize: normalize,
  byId: byId,
  currentId: currentId,
  current: current,
  syncTabBar: syncTabBar,
  syncNavBar: syncNavBar,
  attach: attach,
  setCurrent: setCurrent
}
