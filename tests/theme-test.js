/**
 * 主题系统（utils/theme.js）离线验证
 *
 * 主题这件事最容易出的不是「逻辑错」而是「三处脱节」：
 *   utils/theme.js 的主题清单 / app.wxss 的 .theme-* 类 / 预生成的 tabBar 图标文件
 * 静态检查负责前两者的对账，这里负责第三处 + 运行时行为：
 *   - 拼接出来的图标路径是否真的落在磁盘上（漏生成就会在真机上显示空白图标）
 *   - 非法 id、存储脏数据能不能安全回落到默认主题
 *   - 「主题没变就不 setData」「tabBar 同步失败要能重试」这两个性能/健壮性约定
 *
 * 运行：node tests/theme-test.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

// ---------------------------------------------------------------- wx 桩
const store = {}
const styleCalls = []
const itemCalls = []
const navCalls = []
const bgCalls = []
let apiShouldFail = false
let navShouldFail = false

global.wx = {
  getStorageSync(k) { return store[k] === undefined ? '' : store[k] },
  setStorageSync(k, v) { store[k] = v },
  setTabBarStyle(o) {
    styleCalls.push(o)
    if (apiShouldFail) { if (o.fail) o.fail({ errMsg: 'setTabBarStyle:fail not tabbar page' }) }
    else if (o.success) o.success({})
  },
  setTabBarItem(o) {
    itemCalls.push(o)
    if (apiShouldFail && o.fail) o.fail({ errMsg: 'setTabBarItem:fail not tabbar page' })
  },
  setNavigationBarColor(o) {
    navCalls.push(o)
    if (navShouldFail) { if (o.fail) o.fail({ errMsg: 'setNavigationBarColor:fail' }) }
    else if (o.success) o.success({})
  },
  setBackgroundColor(o) {
    bgCalls.push(o)
    if (navShouldFail && o.fail) o.fail({ errMsg: 'setBackgroundColor:fail' })
  }
}

const theme = require(path.join(ROOT, 'utils', 'theme.js'))

let fail = 0
const t = (ok, msg) => { console.log((ok ? '  ✅ ' : '  ❌ ') + msg); if (!ok) fail++ }
const exists = p => fs.existsSync(path.join(ROOT, p))

// ---------------------------------------------------------------- 清单
console.log('=== 主题清单 ===')
const list = theme.list()
t(list.length >= 2, `共 ${list.length} 套主题`)
t(list.every(x => /^[a-z][a-z0-9_]*$/.test(x.id)), 'id 都是小写字母/数字/下划线（能安全拼进 CSS 类名与文件名）')
t(list.every(x => /^#[0-9A-Fa-f]{6}$/.test(x.brand)), 'brand 都是 #RRGGBB')
t(new Set(list.map(x => x.id)).size === list.length, 'id 无重复')
t(theme.currentId() === theme.DEFAULT_ID, `空存储 → 默认主题 ${theme.currentId()}`)
t(theme.DEFAULT_ID === 'green', `默认主题是绿色（需求：主题默认设为绿色）`)
t(list.every(x => /^#[0-9A-Fa-f]{6}$/.test(x.hero)), '每套主题都给了 hero 色（深色卡片 + 原生导航栏要用）')
t(new Set(list.map(x => x.hero)).size === list.length, '各主题 hero 互不相同（否则换主题看不出变化）')
t(theme.PAGE_BG === '#F2F5FA', `PAGE_BG = ${theme.PAGE_BG}（与 app.wxss 的 --surface-2 同值，交给 static-check 对账）`)

// ---------------------------------------------------------------- 归一化
console.log('\n=== 非法输入必须安全回落（不能白屏/报错） ===')
const DEFAULT = theme.DEFAULT_ID
t(theme.normalize('not-a-theme') === DEFAULT, `normalize('not-a-theme') → ${DEFAULT}`)
t(theme.normalize('') === DEFAULT, "normalize('') → 默认")
t(theme.normalize(null) === DEFAULT, 'normalize(null) → 默认')
t(theme.normalize(undefined) === DEFAULT, 'normalize(undefined) → 默认')
t(theme.normalize({}) === DEFAULT, 'normalize({}) → 默认')
t(theme.byId('not-a-theme').id === DEFAULT, 'byId(非法) 也返回默认主题对象')

store[theme.STORAGE_KEY] = 'blue'
t(theme.currentId() === 'blue', '读到存储里的 blue → blue')
store[theme.STORAGE_KEY] = '被改坏的值'
t(theme.currentId() === DEFAULT, '存储被写脏（手改/旧版本残留）→ 安全回落默认，不崩')
delete store[theme.STORAGE_KEY]

// ---------------------------------------------------------------- 图标路径
console.log('\n=== tabBar 图标：JS 拼出来的路径必须真的存在 ===')
// ⚠️ 形状清单**从 app.json 反推**，不在这里另存一份：写死的话，
//    加一个 tabBar 栏位时这里的断言会「因为少写一个名字而继续通过」，
//    漏生成的主题图标就查不出来了。
const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
const SHAPES = ((appJson.tabBar && appJson.tabBar.list) || [])
  .map(i => String(i.iconPath || '').replace(/^.*\//, '').replace(/\.png$/, ''))
  .filter(Boolean)

let missing = []
for (const item of list) {
  for (const shape of SHAPES) {
    if (!exists(`assets/icons/${shape}.png`)) missing.push(`${shape}.png（未选中态）`)
    if (!exists(`assets/icons/${shape}-active-${item.id}.png`)) missing.push(`${shape}-active-${item.id}.png`)
  }
}
t(missing.length === 0, missing.length ? `缺失图标：${missing.join(', ')}` : `${SHAPES.length} 个 tab × ${list.length} 套主题 = ${SHAPES.length * list.length} 个图标齐全`)

// 真正让 theme.js 拼一遍，断言拼出来的路径落在同一批文件上
apiShouldFail = false
theme.setCurrent('violet')
const violetPaths = itemCalls.map(c => c.selectedIconPath)
t(violetPaths.length === SHAPES.length, `setCurrent 会为 ${SHAPES.length} 个 tab 各设一次选中图标（实际 ${violetPaths.length}）`)
t(violetPaths.every(p => exists(p)), '拼出来的图标路径全部真实存在：' + violetPaths.join(', '))
t(violetPaths.every(p => p.includes('-active-violet')), '主题切换后指向的是对应主题的图标')

const violetStyle = styleCalls[styleCalls.length - 1]
t(violetStyle.selectedColor === theme.byId('violet').brand, `tabBar.selectedColor = ${violetStyle.selectedColor}（与主题色一致）`)
t(violetStyle.color === '#8A94A6', `未选中文字色固定 ${violetStyle.color}`)

// ---------------------------------------------------------------- 持久化
console.log('\n=== 持久化 ===')
t(store[theme.STORAGE_KEY] === 'violet', '切换后写入本地存储（下次启动还是这套主题）')
t(theme.currentId() === 'violet', 'currentId() 反映最新选择')
t(theme.setCurrent('不存在').id === DEFAULT, 'setCurrent(非法) 落到默认主题而不是写坏存储')
t(store[theme.STORAGE_KEY] === DEFAULT, `存储里被写成 ${DEFAULT}（不是非法值）`)
theme.setCurrent('violet')

// ---------------------------------------------------------------- attach
console.log('\n=== attach(page)：不重复 setData，主题变了才刷新 ===')
function fakePage(dataTheme) {
  return {
    data: dataTheme === undefined ? {} : { theme: dataTheme },
    setDataCalls: [],
    setData(patch) { this.setDataCalls.push(patch) }
  }
}

const p1 = fakePage()                       // data 里还没有 theme
theme.attach(p1)
t(p1.setDataCalls.length === 1 && p1.setDataCalls[0].theme === 'violet', 'data 里没有 theme → 写一次（当前主题 violet）')
const p2 = fakePage('violet')               // 已经是对的
theme.attach(p2)
t(p2.setDataCalls.length === 0, 'data 里已经是对的 → 零 setData（省跨线程通信）')
const p3 = fakePage('blue')                 // 过期了
theme.attach(p3)
t(p3.setDataCalls.length === 1 && p3.setDataCalls[0].theme === 'violet', 'data 里的主题过期 → 纠正为 violet')

const weird = { data: {}, setData() {} }
let threw = false
try { theme.attach(null); theme.attach(undefined); theme.attach(weird) } catch (e) { threw = true }
t(!threw, 'attach(null / undefined / 无 data 的对象) 不抛异常')

// ---------------------------------------------------------------- tabBar 重试
console.log('\n=== tabBar 同步：同一主题不重复调，失败要能重试 ===')
const before = styleCalls.length
theme.syncTabBar(false)
t(styleCalls.length === before, '主题没变 → 不再重复调 setTabBarStyle')
theme.syncTabBar(true)
t(styleCalls.length === before + 1, 'force=true → 强制重设（用户手动切换时用）')

// 模拟「在非 tabBar 页调用」：接口 fail，此时不能把「已同步」标记打上，
// 否则回到 tabBar 页就再也不会重试，图标会一直是旧主题色。
const itemsBefore = itemCalls.length
apiShouldFail = true
theme.setCurrent('orange')
t(styleCalls[styleCalls.length - 1].fail !== undefined, '调用时传了 fail 回调（失败不抛异常）')
apiShouldFail = false
theme.syncTabBar(false)
t(itemCalls.length > itemsBefore + SHAPES.length, '上一次失败后，下次进 tabBar 页会自动重试')

// ---------------------------------------------------------------- 原生导航栏
console.log('\n=== 导航栏 / 下拉底色：必须等于当前主题的 hero 首色 ===')
theme.setCurrent('green')
navCalls.length = 0
bgCalls.length = 0

theme.syncNavBar(true)
t(navCalls.length === 1, 'syncNavBar 调了一次 setNavigationBarColor')
t(navCalls[0].backgroundColor === theme.byId('green').hero,
  `导航栏底色 = ${navCalls[0].backgroundColor}（= 该主题 hero 首色，卡片与导航栏之间才不会露接缝）`)
t(navCalls[0].frontColor === '#ffffff', '导航栏文字固定白色（5 套 hero 都是深色底）')
t(bgCalls.length === 1 && bgCalls[0].backgroundColorTop === theme.byId('green').hero,
  '下拉露出的**顶部**底色同步成 hero 色（否则下拉时闪出一条浅色带）')
t(bgCalls[0].backgroundColor === theme.PAGE_BG && bgCalls[0].backgroundColorBottom === theme.PAGE_BG,
  `下拉的其余部分仍是页面底色 ${theme.PAGE_BG}（底部过度滚动不该变深）`)

const navBefore = navCalls.length
theme.syncNavBar(false)
t(navCalls.length === navBefore, '主题没变 → 不再重复调（省一次跨线程通信）')

theme.setCurrent('orange')
theme.syncNavBar(false)
t(navCalls[navCalls.length - 1].backgroundColor === theme.byId('orange').hero,
  `切到橙色主题后导航栏跟着变成 ${theme.byId('orange').hero}`)

// 白底黑字导航栏的页面（账单/统计/我的）绝不能调这个，否则导航栏会被莫名染深
navCalls.length = 0
theme.attach(fakePage(), false, false)
theme.attach(fakePage(), false)
t(navCalls.length === 0, 'attach(page, false) / attach(page, false, false) 不碰导航栏（非深色导航页）')

theme.setCurrent('violet')
navCalls.length = 0
theme.attach(fakePage(), false, true)
t(navCalls.length === 1 && navCalls[0].backgroundColor === theme.byId('violet').hero,
  'attach(page, false, true) → 首页这种深色导航页会同步导航栏')

// 接口失败不能把「已同步」标记打上，否则回首页就再也不会重试
theme.setCurrent('rose')
navCalls.length = 0
navShouldFail = true
theme.syncNavBar(false)
navShouldFail = false
theme.syncNavBar(false)
t(navCalls.length === 2, '上一次同步失败后，下次进页面会自动重试（失败不打「已同步」标记）')
t(navCalls[1].backgroundColor === theme.byId('rose').hero, '重试时用的仍是当前主题的 hero 色')

console.log('\n=== 主题清单与 app.wxss / 图标的一致性交给 static-check.js ===')

console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`)
process.exit(fail === 0 ? 0 : 1)
