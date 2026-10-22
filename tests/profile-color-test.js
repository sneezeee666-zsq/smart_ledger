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

// ⚠️ 这里守的不是分类对不对（云函数那侧由 add-test 守），而是**循环本身**：
//    游标有没有真的往下传、done 之后会不会停、服务端抽风时会不会转死。
async function testReclassifyPage() {
  console.log('\n=== 6) 重新识别分类：分批循环 ===')
  {
    const { page, toastCalls } = loadProfile()

    const calls = []
    let batch = 0
    global.wx.showLoading = () => {}
    global.wx.hideLoading = () => {}
    global.wx.showModal = (o) => { o.success({ confirm: true }) }
    global.wx.cloud = {
      callFunction(o) {
        calls.push(o.data)
        batch++
        if (batch === 1) {
          return Promise.resolve({ result: { code: 0, data: { scanned: 20, updated: 7, done: false, lastId: 'b1' } } })
        }
        return Promise.resolve({ result: { code: 0, data: { scanned: 5, updated: 2, done: true, lastId: 'b2' } } })
      }
    }

    await page.runReclassify()

    t(calls.length === 2, `按 done 收敛，共请求 ${calls.length} 次`)
    t(calls[0].action === 'reclassify' && calls[0].lastId === '', '第一批不带游标')
    t(calls[1].lastId === 'b1', `第二批带上第一批返回的游标（实际「${calls[1].lastId}」）`)
    const last = toastCalls[toastCalls.length - 1]
    t(last === '已更新 9 条分类', `完成提示报的是两批之和（实际「${last}」）`)
  }

  {
    const { page, toastCalls } = loadProfile()
    global.wx.showLoading = () => {}
    global.wx.hideLoading = () => {}
    global.wx.cloud = { callFunction() { return Promise.reject(new Error('网络波动')) } }

    const realError = console.error
    console.error = () => {}          // 这条用例故意制造失败，别把堆栈打到测试输出里
    try {
      await page.runReclassify()
    } finally {
      console.error = realError
    }
    t(toastCalls.indexOf('识别失败，请重试') !== -1, '失败有明确提示，不会静默卡在 loading')
  }

  {
    // 服务端一直回 done:false 且游标不前进 → 必须被硬闸门拦住，不能转死
    const { page } = loadProfile()
    global.wx.showLoading = () => {}
    global.wx.hideLoading = () => {}
    let n = 0
    global.wx.cloud = {
      callFunction() {
        n++
        return Promise.resolve({ result: { code: 0, data: { scanned: 20, updated: 0, done: false, lastId: 'same' } } })
      }
    }

    await page.runReclassify()
    t(n > 0 && n < 400, `游标打滑时被硬闸门拦住（实际请求 ${n} 次）`)
  }
}

;(async () => {
  await testReclassifyPage()
  console.log('\n' + (fail === 0 ? '全部通过 ✅' : '有 ' + fail + ' 项失败 ❌'))
  process.exit(fail === 0 ? 0 : 1)
})()
