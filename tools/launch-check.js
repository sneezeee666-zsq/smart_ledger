// 上线前静态体检：页面文件 / 图标资源 / CSS 令牌悬空 / 图片引用
const fs = require('fs')
const path = require('path')
const ROOT = 'D:/workbuddy_workspace/smart-ledger'

const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
let fail = 0
const log = (ok, msg) => { console.log((ok ? '  ✅ ' : '  ❌ ') + msg); if (!ok) fail++ }

// 1. 页面四件套
console.log('\n=== 1) 页面文件完整性 ===')
for (const p of app.pages) {
  const exts = ['js', 'json', 'wxml', 'wxss'].map(e => [e, fs.existsSync(path.join(ROOT, p + '.' + e))])
  const missing = exts.filter(([, ok]) => !ok).map(([e]) => e)
  if (missing.length) log(false, p + ' 缺：' + missing.join(','))
}
log(true, app.pages.length + ' 个页面四件套齐全')

// 2. tabBar 图标
console.log('\n=== 2) tabBar 图标 ===')
const icons = []
for (const it of app.tabBar.list) {
  icons.push(it.iconPath, it.selectedIconPath)
}
icons.forEach(i => { if (!fs.existsSync(path.join(ROOT, i))) log(false, 'tabBar 图标缺失：' + i) })
log(true, icons.length + ' 个 tabBar 图标全部存在')

// 3. WXML/WXSS 引用的本地图片
console.log('\n=== 3) 本地图片引用 ===')
const walk = (d, out = []) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name === 'miniprogram_npm') continue
    const fp = path.join(d, f.name)
    if (f.isDirectory()) walk(fp, out)
    else if (/\.(wxml|wxss)$/.test(f.name)) out.push(fp)
  }
  return out
}
const files = walk(ROOT)
const refs = new Set()
for (const fp of files) {
  const src = fs.readFileSync(fp, 'utf8')
  // WXML: src="/assets/..."   WXSS: url('/assets/...') 或 url(/assets/...)
  for (const m of src.matchAll(/src\s*=\s*"([^"]+)"/g)) if (m[1].startsWith('/assets/')) refs.add(m[1])
  for (const m of src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) if (m[1].startsWith('/assets/')) refs.add(m[1])
}
;[...refs].forEach(r => { if (!fs.existsSync(path.join(ROOT, r))) log(false, '图片缺失：' + r) })
log(true, refs.size + ' 个本地图片引用全部存在')

// 4. CSS 令牌：定义 vs 使用
console.log('\n=== 4) CSS 令牌悬空引用 ===')
const defined = new Set()
const used = new Set()
for (const fp of files) {
  const src = fs.readFileSync(fp, 'utf8')
  for (const m of src.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1])
  for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) used.add(m[1])
}
const dangling = [...used].filter(v => !defined.has(v))
if (dangling.length) log(false, '用了但没定义的令牌：' + dangling.join(', '))
log(true, used.size + ' 个令牌全部有定义')

// 5. WXML 引用的方法/字段在对应 js 里是否存在（粗查 bindtap/bindinput 等处理器）
console.log('\n=== 5) WXML 事件处理器与 js 方法对账 ===')
let handlerMiss = 0
for (const fp of files.filter(f => f.endsWith('.wxml'))) {
  const jsPath = fp.replace(/\.wxml$/, '.js')
  if (!fs.existsSync(jsPath)) continue
  const js = fs.readFileSync(jsPath, 'utf8')
  const wxml = fs.readFileSync(fp, 'utf8')
  for (const m of wxml.matchAll(/(?:bind[a-z]+|catch[a-z]+|on[a-z]+)\s*=\s*"([^"{}]+)"/g)) {
    const expr = m[1].trim()
    if (/[{}?:]/.test(expr)) continue // 含表达式/三元的交给运行时
    if (!new RegExp('\\b' + expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(js)) {
      log(false, path.basename(fp) + ' 绑定了 ' + expr + '，但 js 里找不到该方法')
      handlerMiss++
    }
  }
}
if (!handlerMiss) log(true, '所有静态绑定的事件处理器都能在对应 js 里找到')

console.log('\n' + (fail ? '❌ 有 ' + fail + ' 项未通过' : '✅ 静态体检全部通过'))
process.exit(fail ? 1 : 0)
