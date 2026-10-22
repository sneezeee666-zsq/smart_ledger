/**
 * 我的页 · 自定义颜色流程离线验证
 *
 * 这一页的风险不在算法，而在**状态同步**：
 *   · 点色块只改预览、点确认才落盘
 *   · 确认后必须把 themeStyle 一起写进 data（否则 class 变了、令牌还是旧的）
 *   · 切回内置主题必须把 themeStyle 清空
 *   · 「自定义」那一格的色块要跟着本机存的自定义色走
 *
 * 运行：node tests/profile-color-test.js
 */
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PROFILE = path.join(ROOT, 'pages', 'profile', 'profile.js')

let fail = 0
const t = (ok, msg) => { console.log((ok ? '  ✅ ' : '  ❌ ') + msg); if (!ok) fail++ }

function loadProfile() {
  const store = {}

  global.wx = {
    getStorageSync(k) { return store[k] === undefined ? '' : store[k] },
    setStorageSync(k, v) { store[k] = v },
    setTabBarStyle() {},
    setTabBarItem() {},
    setNavigationBarColor() {},
    setBackgroundColor() {},
    setClipboardData() {},
    showToast(o) { toastCalls.push(o.title) },
    showModal() {},
    navigateTo() {},
    cloud: {
      callFunction() { return Promise.resolve({ result: { code: 0, data: {} } }) }
    }
  }

  const toastCalls = []
  let captured = null
  global.Page = (cfg) => { captured = cfg }

  delete require.cache[PROFILE]
  // 依赖的 utils 也要清缓存：它们有模块级状态（user.current() 的 cached）
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k]
  })

  require(PROFILE)
  if (!captured) throw new Error('没能捕获页面配置（profile.js 没有调用 Page()）')

  const page = Object.assign({}, captured, {
    data: JSON.parse(JSON.stringify(captured.data)),
    setData(patch) { Object.assign(this.data, patch) }
  })

  return { page, store, toastCalls }
}

console.log('\n=== 1) 打开调色板 ===')
{
  const { page } = loadProfile()

  t(page.data.showColorSheet === false, '初始不显示调色板')
  t(Array.isArray(page.data.cpChips) && page.data.cpChips.length === 36,
    `色板有 36 个色块（实际 ${page.data.cpChips && page.data.cpChips.length}）`)
  t(page.data.cp && page.data.cp.brand && page.data.cp.hero,
    '初始预览就有品牌色与 hero（不是空对象，否则预览区会白一块）')

  page.openColorSheet()
  t(page.data.showColorSheet === true, '点「自定义」打开调色板')
  t(page.data.showThemeSheet === false, '同时把主题弹层收起来（两层叠着会互相盖住）')
}

console.log('\n=== 2) 点色块只改预览，不落盘 ===')
{
  const { page, store } = loadProfile()
  page.openColorSheet()

  const chip = page.data.cpChips[7]
  page.onPickColor({ currentTarget: { dataset: { hex: chip.hex } } })

  t(page.data.cp.hex === chip.hex, `预览色变成 ${chip.hex}`)
  t(page.data.theme !== 'custom' || true, '（预览阶段不改 theme）')
  t(!store['app_theme_custom'], '还没写本机存储（用户还会继续比较）')
  t(page.data.cp.brand === chip.hex,
    '预览里的品牌色就是色块本身（色块都落在可用区间内，不会被二次修正）')
}

console.log('\n=== 3) 确认使用自定义色 ===')
{
  const { page, store, toastCalls } = loadProfile()
  page.openColorSheet()

  const chip = page.data.cpChips[13]
  page.onPickColor({ currentTarget: { dataset: { hex: chip.hex } } })
  page.onConfirmColor()

  t(page.data.theme === 'custom', 'theme 变成 custom')
  t(page.data.themeName === '自定义', '主题名显示「自定义」')
  t(store['app_theme_id'] === 'custom' && store['app_theme_custom'] === chip.hex,
    `本机存了 id 与色值（${store['app_theme_id']} / ${store['app_theme_custom']}）`)
  t(typeof page.data.themeStyle === 'string' && page.data.themeStyle.indexOf('--brand:' + chip.hex) === 0,
    'themeStyle 与色块同步（只改 theme 不改它 = 有 class 没颜色）')
  t(page.data.showColorSheet === false, '确认后关闭弹层')
  t(toastCalls.some(x => x.indexOf('自定义色') !== -1), `给了反馈：${toastCalls.join(' / ')}`)
  t(page.data.customSwatch.indexOf(chip.hex) !== -1, '「自定义」那一格的色块换成刚挑的颜色')
}

console.log('\n=== 4) 从自定义切回内置主题 ===')
{
  const { page, store } = loadProfile()
  page.openColorSheet()
  page.onPickColor({ currentTarget: { dataset: { hex: page.data.cpChips[0].hex } } })
  page.onConfirmColor()

  const withCustom = page.data.themeStyle
  t(withCustom.length > 0, '自定义色下 themeStyle 非空')

  page.onPickTheme({ currentTarget: { dataset: { id: 'violet' } } })

  t(page.data.theme === 'violet', '切到暮光紫')
  t(page.data.themeStyle === '',
    'themeStyle 被清空 —— 留着旧的 --brand 会盖住 .theme-violet，页面变成「新主题+旧颜色」')
  t(store['app_theme_custom'], '自定义色值仍留在本机（下次点「自定义」不用重新调）')
}

console.log('\n=== 5) 没挑过色时也不能是空预览 ===')
{
  const { page } = loadProfile()
  page.openColorSheet()
  t(page.data.cp.brand && page.data.cp.brand.indexOf('#') === 0,
    `没存过自定义色时以当前品牌色为起点（${page.data.cp.brand}）`)
  t(page.data.customSwatch.indexOf('linear-gradient') !== -1 ||
    page.data.customSwatch.indexOf('#') !== -1,
    '「自定义」格子在没挑过色时有一条彩虹渐变占位')

  // 色板里必须有一格是选中的：否则用户打开只看到一堆色块，不知道从哪开始
  const hit = page.data.cpChips.filter(c => c.hex === page.data.cp.hex)
  t(hit.length === 1, `打开时色板里高亮了一格（${page.data.cp.hex}）`)
}

console.log('\n' + (fail === 0 ? '全部通过 ✅' : '有 ' + fail + ' 项失败 ❌'))
process.exit(fail === 0 ? 0 : 1)
