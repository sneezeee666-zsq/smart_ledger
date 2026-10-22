/**
 * 小程序静态检查（离线、无需开发者工具）
 *
 * 覆盖小程序最常见的「只在运行时才炸」的坑：
 *   1. JS / WXS 语法、JSON 可解析
 *   2. app.json 里注册的页面四件套是否齐全
 *   3. tabBar 图标、usingComponents 组件、<wxs src>、本地图片是否真实存在
 *   4. WXML 里绑定的事件处理函数在同名 .js 里是否真的存在
 *   5. WXML 标签是否配对闭合、wx:for 是否给了 wx:key
 *   6. WXML 误用过滤器语法 {{ x | fn }}（会被解析成按位或，静默出错）
 *   7. wx:if 被写进 class 属性值里（小程序不支持，静默失效）
 *   8. 跳转目标是否在 app.json 注册过
 *   9. require 路径 / 云函数名是否真实存在
 *  10. 已废弃 API（getSystemInfoSync / getUserProfile / createCanvasContext ...）
 *  11. WXML 变量是否在 data / properties / setData 里
 *  12. dataset.X 与 WXML 的 data-* 是否对齐
 *  13. 选择器 id 与 canvas 节点
 *  14. **主题一致性**：utils/theme.js ↔ app.wxss 的 .theme-* ↔ 预生成的 tabBar 图标
 *      ↔ 页面接线（根节点类 / require / attach）；顺带查出旧变量别名的漏网之鱼
 *  15. 资源冗余（没人引用的 PNG）与打包配置（tests/ tools/ 不进包）
 *
 * 运行：node tests/static-check.js
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const errors = []
const warnings = []
const err = (f, m) => errors.push(`[${f}] ${m}`)
const warn = (f, m) => warnings.push(`[${f}] ${m}`)

const rel = p => path.relative(ROOT, p).split(path.sep).join('/')
const exists = p => fs.existsSync(p)
const read = p => fs.readFileSync(p, 'utf8')

// ---------------------------------------------------------------- 收集文件
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const ALL = walk(ROOT)
const JS_FILES = ALL.filter(f => f.endsWith('.js'))
const JSON_FILES = ALL.filter(f => f.endsWith('.json') && !f.endsWith('package-lock.json'))
const WXML_FILES = ALL.filter(f => f.endsWith('.wxml'))
const WXS_FILES = ALL.filter(f => f.endsWith('.wxs'))
const WXSS_FILES = ALL.filter(f => f.endsWith('.wxss'))

const absOf = (fromFile, spec) => {
  if (spec.startsWith('/')) return path.join(ROOT, spec)
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec)
  return null // npm 包
}

// ------------------------------------------------ 1. 语法 / JSON
console.log('【1】语法与 JSON 解析')
let syntaxCount = 0

// .js 走 node --check
for (const f of JS_FILES) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
    syntaxCount++
  } catch (e) {
    err(rel(f), '语法错误：' + String(e.stderr || e.message).split('\n').slice(0, 4).join(' '))
  }
}

// .wxs 不是 Node 认识的扩展名，--check 会直接报 ERR_UNKNOWN_FILE_EXTENSION。
// 用 new Function 编译一次，等价于 WXS 编译期检查。
for (const f of WXS_FILES) {
  try {
    // eslint-disable-next-line no-new-func
    new Function('getDate', read(f))
    syntaxCount++
  } catch (e) {
    err(rel(f), 'WXS 编译失败：' + e.message)
  }
}

const parsedJson = {}
for (const f of JSON_FILES) {
  try {
    parsedJson[f] = JSON.parse(read(f))
  } catch (e) {
    err(rel(f), 'JSON 解析失败：' + e.message)
  }
}
console.log(`   语法通过 ${syntaxCount}/${JS_FILES.length + WXS_FILES.length}，JSON 解析 ${Object.keys(parsedJson).length}/${JSON_FILES.length}`)

const appJsonPath = path.join(ROOT, 'app.json')
const appJson = parsedJson[appJsonPath] || { pages: [] }

// ------------------------------------------------ 2. 页面四件套
console.log('【2】页面四件套与 tabBar 图标')
const PAGES = appJson.pages || []
for (const p of PAGES) {
  const base = path.join(ROOT, p)
  for (const ext of ['.js', '.json', '.wxml', '.wxss']) {
    if (!exists(base + ext)) err('app.json', `页面 ${p} 缺少 ${ext}`)
  }
}

const tabIcons = []
for (const item of (appJson.tabBar && appJson.tabBar.list) || []) {
  if (PAGES.indexOf(item.pagePath) < 0) err('app.json', `tabBar 页 ${item.pagePath} 未在 pages 中注册`)
  for (const k of ['iconPath', 'selectedIconPath']) {
    if (item[k]) {
      tabIcons.push(item[k])
      if (!exists(path.join(ROOT, item[k]))) err('app.json', `tabBar 图标不存在：${item[k]}`)
    }
  }
}

/**
 * tabBar 的图标形状名（home / bill / chart / ai / user …），**以 app.json 为单一来源**。
 *
 * ⚠️ 以前这里写死过一份 ['home','bill','chart','user']，结果同一份清单在
 *    utils/theme.js、tools/gen-icons.py、本文件里各存一份：加一个 tabBar 栏位时
 *    漏改任何一处都**不会报错**，只会「某个主题的选中图标静默缺失」或
 *    「点统计却亮成别的图标」。现在改为从 app.json 反推，再对账另外两处。
 */
const TAB_SHAPES = ((appJson.tabBar && appJson.tabBar.list) || [])
  .map(item => String(item.iconPath || '').replace(/^.*\//, '').replace(/\.png$/, ''))
  .filter(Boolean)

// 原生 tabBar 官方上限 5 项、下限 2 项，超了直接编译失败
const tabCount = ((appJson.tabBar && appJson.tabBar.list) || []).length
if (tabCount > 5) err('app.json', `tabBar 有 ${tabCount} 项，原生 tabBar 最多 5 项`)
if (tabCount > 0 && tabCount < 2) err('app.json', `tabBar 只有 ${tabCount} 项，原生 tabBar 至少 2 项`)

// 同一份「形状清单」还写在另外两个文件里，三处必须同序 —— 顺序错了不会报错，
// 只会「点某一栏却亮成另一栏的图标」，靠肉眼很难发现。
{
  const themeSrc = exists(path.join(ROOT, 'utils', 'theme.js')) ? read(path.join(ROOT, 'utils', 'theme.js')) : ''
  const m = themeSrc.match(/TAB_SHAPES\s*=\s*\[([^\]]*)\]/)
  if (!m) {
    err('utils/theme.js', '找不到 TAB_SHAPES（tabBar 选中图标按它拼接路径）')
  } else {
    const jsShapes = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
    if (jsShapes.join(',') !== TAB_SHAPES.join(',')) {
      err('utils/theme.js',
        `TAB_SHAPES = [${jsShapes.join(',')}]，与 app.json tabBar 的顺序 [${TAB_SHAPES.join(',')}] 不一致`)
    }
  }

  const pySrc = exists(path.join(ROOT, 'tools', 'gen-icons.py')) ? read(path.join(ROOT, 'tools', 'gen-icons.py')) : ''
  const pyBlock = pySrc.match(/TAB_SHAPES\s*=\s*\[([\s\S]*?)\]/)
  if (!pyBlock) {
    err('tools/gen-icons.py', '找不到 TAB_SHAPES（图标生成器不知道要画哪几个形状）')
  } else {
    const pyShapes = [...pyBlock[1].matchAll(/\(\s*'([^']+)'/g)].map(x => x[1])
    if (pyShapes.join(',') !== TAB_SHAPES.join(',')) {
      err('tools/gen-icons.py',
        `TAB_SHAPES = [${pyShapes.join(',')}]，与 app.json tabBar 的顺序 [${TAB_SHAPES.join(',')}] 不一致`)
    }
  }
}
// tabBar 图标体积（小程序包体积敏感；单个图标建议 < 40KB）
for (const icon of tabIcons) {
  const full = path.join(ROOT, icon)
  if (exists(full)) {
    const kb = fs.statSync(full).size / 1024
    if (kb > 40) warn(icon, `图标 ${kb.toFixed(1)}KB 偏大，建议压缩`)
  }
}
// PNG 头校验：扩展名是 .png 但内容不是 PNG（会导致图标显示空白）
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const iconFiles = ALL.filter(f => /\.(png|jpg|jpeg)$/i.test(f))
for (const f of iconFiles) {
  const head = fs.readFileSync(f).subarray(0, 4)
  if (f.toLowerCase().endsWith('.png') && !head.equals(PNG_MAGIC)) {
    err(rel(f), '后缀是 .png 但文件头不是 PNG（图标会空白）')
  }
  if (fs.statSync(f).size === 0) err(rel(f), '文件为空')
}
console.log(`   页面 ${PAGES.length} 个，图标 ${iconFiles.length} 个，均存在且为合法 PNG`)

// ------------------------------------------------ 3. 组件 / wxs / 图片 引用
console.log('【3】组件、wxs、本地图片引用')
for (const f of WXML_FILES) {
  const src = read(f)
  // <wxs src="...">
  for (const m of src.matchAll(/<wxs[^>]*\bsrc\s*=\s*"([^"]+)"/g)) {
    const target = absOf(f, m[1])
    if (!target) { err(rel(f), `<wxs src="${m[1]}"> 必须用相对路径`); continue }
    if (!exists(target)) err(rel(f), `<wxs src="${m[1]}"> 文件不存在`)
  }
  // 本地图片：src="/assets/..." 或 "../../assets/..."
  for (const m of src.matchAll(/\bsrc\s*=\s*"([^"{}]+\.(?:png|jpg|jpeg|gif|svg|webp))"/gi)) {
    const target = absOf(f, m[1])
    if (target && !exists(target)) err(rel(f), `图片不存在：${m[1]}`)
  }
}
for (const f of JSON_FILES) {
  const j = parsedJson[f]
  if (!j || !j.usingComponents) continue
  for (const [name, spec] of Object.entries(j.usingComponents)) {
    const target = absOf(f, spec)
    if (!target) { err(rel(f), `usingComponents["${name}"] 必须用绝对(/...)或相对路径`); continue }
    for (const ext of ['.js', '.json', '.wxml']) {
      if (!exists(target + ext)) err(rel(f), `组件 ${name} → ${spec}${ext} 不存在`)
    }
    const cj = parsedJson[target + '.json']
    if (cj && cj.component !== true) {
      warn(rel(f), `组件 ${name} 的 json 里没有 "component": true`)
    }
  }
}
console.log('   引用检查完成')

// ------------------------------------------------ 4. WXML 标签配对 / wx:key / 过滤器 / wx:if in class
console.log('【4】WXML 标签配对、wx:key、过滤器误用')
const VOID_TAGS = new Set(['image', 'input', 'import', 'include', 'wxs', 'icon', 'progress', 'slot', 'br', 'hr'])

for (const f of WXML_FILES) {
  const src = read(f)

  // ---- 标签配对（跳过注释）----
  const noComment = src.replace(/<!--[\s\S]*?-->/g, '')
  const stack = []
  let bad = false
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let m
  while ((m = tagRe.exec(noComment))) {
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const selfClose = m[4] === '/'
    if (selfClose || VOID_TAGS.has(tag)) continue
    if (!closing) {
      stack.push({ tag, idx: m.index })
    } else {
      const top = stack.pop()
      if (!top) { err(rel(f), `多余的闭合标签 </${tag}>`); bad = true; break }
      if (top.tag !== tag) {
        err(rel(f), `标签不匹配：<${top.tag}> 被 </${tag}> 闭合`)
        bad = true
        break
      }
    }
  }
  if (!bad && stack.length) {
    err(rel(f), `标签未闭合：<${stack.map(s => s.tag).join('>, <')}>`)
  }

  // ---- wx:for 必须带 wx:key（提升 diff 性能，且避免状态错位）----
  const forRe = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g
  while ((m = forRe.exec(noComment))) {
    const attrs = m[2]
    const hasFor = /\bwx:for\s*=/.test(attrs)
    if (!hasFor) continue
    const hasKey = /\bwx:key\s*=/.test(attrs)
    if (!hasKey) warn(rel(f), `<${m[1]}> 用了 wx:for 但没有 wx:key`)
  }

  // ---- 过滤器语法误用：{{ a | b }} ----
  for (const mm of src.matchAll(/\{\{([^}]*)\}\}/g)) {
    const inner = mm[1]
    // 排除逻辑或 ||
    const stripped = inner.replace(/\|\|/g, '')
    if (stripped.includes('|')) {
      err(rel(f), `WXML 不支持过滤器语法：{{${inner.trim()}}}（会被当成按位或，数值会被截断）`)
    }
  }

  // ---- wx:if / wx:for 被写进属性值里 ----
  for (const mm of src.matchAll(/\bclass\s*=\s*"([^"]*)"/g)) {
    if (/\bwx:(if|else|elif|for)\b/.test(mm[1])) {
      err(rel(f), `wx: 指令被写进了 class 属性值：class="${mm[1]}"（不会生效，要写成独立属性）`)
    }
  }
}
console.log('   WXML 结构检查完成')

// ------------------------------------------------ 5. 事件处理函数是否存在
console.log('【5】事件处理函数绑定')
const HANDLER_ATTR = /\b(?:bind|catch|capture-bind|capture-catch|mut-bind):?([a-zA-Z][\w-]*)\s*=\s*"([^"]+)"/g

function methodsOf(jsFile) {
  if (!exists(jsFile)) return null
  const src = read(jsFile)
  const names = new Set()
  // 对象字面量里的方法/属性，兼容：
  //   name() {}   async name() {}   name: function   name: () => {}   name: async () => {}
  for (const m of src.matchAll(/^\s{0,8}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1])
  for (const m of src.matchAll(/^\s{0,8}([A-Za-z_$][\w$]*)\s*:/gm)) names.add(m[1])
  return names
}

let handlerCount = 0
for (const f of WXML_FILES) {
  const jsFile = f.replace(/\.wxml$/, '.js')
  const src = read(f)
  const names = methodsOf(jsFile)
  if (!names) { err(rel(f), '没有同名 .js 文件'); continue }

  const noComment = src.replace(/<!--[\s\S]*?-->/g, '')
  for (const m of noComment.matchAll(HANDLER_ATTR)) {
    const fn = m[2].trim()
    if (fn.includes('{{') || fn.includes('(')) continue
    handlerCount++
    if (!names.has(fn)) {
      err(rel(f), `绑定了 ${fn}，但 ${path.basename(jsFile)} 里找不到这个方法`)
    }
  }
  // usingComponents 里的自定义事件 bind:tap 已在上面覆盖
}
console.log(`   检查了 ${handlerCount} 个绑定`)

// ------------------------------------------------ 6. 跳转目标已注册 + require 路径 + 云函数名
console.log('【6】跳转目标、require 路径、云函数名')
const NAV_RE = /wx\.(navigateTo|redirectTo|switchTab|reLaunch|navigateBack)\s*\(\s*\{[^}]*url\s*:\s*['"]([^'"]+)['"]/g
let navCount = 0
for (const f of JS_FILES) {
  const src = read(f)
  for (const m of src.matchAll(NAV_RE)) {
    const api = m[1]
    if (api === 'navigateBack') continue
    const url = m[2].split('?')[0]
    navCount++
    if (url.startsWith('/') && !PAGES.some(p => url === '/' + p)) {
      err(rel(f), `wx.${api} 跳转到未注册页面：${url}`)
    }
    if (api === 'switchTab') {
      const isTab = ((appJson.tabBar && appJson.tabBar.list) || []).some(t => '/' + t.pagePath === url)
      if (!isTab) err(rel(f), `wx.switchTab 只能跳 tabBar 页，但 ${url} 不是`)
    }
  }
  // 云函数名
  for (const m of src.matchAll(/wx\.cloud\.callFunction\s*\(\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/g)) {
    const dir = path.join(ROOT, 'cloudfunctions', m[1])
    if (!exists(dir)) err(rel(f), `调用了不存在的云函数：${m[1]}`)
  }
}
// require 路径
for (const f of JS_FILES) {
  const src = read(f)
  for (const m of src.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1]
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue
    const target = absOf(f, spec)
    if (!exists(target) && !exists(target + '.js') && !exists(path.join(target, 'index.js'))) {
      err(rel(f), `require 的文件不存在：${spec}`)
    }
  }
}
// 云函数包名必须与目录同名（否则开发者工具上传会失败）
for (const dir of fs.readdirSync(path.join(ROOT, 'cloudfunctions'))) {
  const pj = path.join(ROOT, 'cloudfunctions', dir, 'package.json')
  if (!exists(pj)) { err('cloudfunctions/' + dir, '缺少 package.json'); continue }
  const j = JSON.parse(read(pj))
  if (j.name !== dir) err('cloudfunctions/' + dir, `package.json 的 name 是 "${j.name}"，必须与目录名 "${dir}" 一致`)
  if (!j.dependencies || !j.dependencies['wx-server-sdk']) {
    warn('cloudfunctions/' + dir, 'package.json 未声明 wx-server-sdk')
  }
}
console.log(`   检查了 ${navCount} 处跳转`)

// ------------------------------------------------ 7. 已废弃 / 有坑 API
console.log('【7】废弃 API 扫描')
// level 'error'：已回收或语义已变，用了就是 bug
// level 'warn' ：已废弃但仍可用，请确认是有意为之（例如低版本兜底）
const DEPRECATED = [
  { re: /wx\.getUserProfile\s*\(/, level: 'error', msg: 'wx.getUserProfile 已回收（2021 起不再返回昵称头像）' },
  { re: /wx\.getUserInfo\s*\(/, level: 'error', msg: 'wx.getUserInfo 已废弃 → 用 button open-type="chooseAvatar" / nickname input' },
  { re: /wx\.createCanvasContext\s*\(/, level: 'error', msg: 'wx.createCanvasContext 已废弃 → 用 canvas type="2d"（旧接口在高分屏上会糊）' },
  { re: /wx\.createAnimation\s*\(/, level: 'warn', msg: 'wx.createAnimation 已不推荐 → 优先用 CSS 动画' },
  {
    re: /wx\.getSystemInfoSync\s*\(/,
    level: 'warn',
    msg: 'wx.getSystemInfoSync 已废弃',
    guardedBy: /wx\.getWindowInfo\s*\?/   // 「wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()」这种兜底是合理的
  },
  { re: /wx\.getSystemInfo\s*\(/, level: 'warn', msg: 'wx.getSystemInfo 已废弃 → 用 wx.getWindowInfo', guardedBy: /wx\.getWindowInfo\s*\?/ }
]
for (const f of JS_FILES.concat(WXML_FILES)) {
  const lines = read(f).split('\n')
  lines.forEach((line, i) => {
    for (const d of DEPRECATED) {
      if (!d.re.test(line)) continue
      if (d.guardedBy && d.guardedBy.test(line)) continue
      const where = `${rel(f)}:${i + 1}`
      if (d.level === 'error') err(where, d.msg)
      else warn(where, d.msg)
    }
  })
}

// ------------------------------------------------ 8. 组件样式隔离 / 全局类
console.log('【8】组件 styleIsolation')
for (const f of JSON_FILES) {
  const j = parsedJson[f]
  if (!j || j.component !== true) continue
  const jsFile = f.replace(/\.json$/, '.js')
  if (!exists(jsFile)) continue
  const src = read(jsFile)
  if (!/styleIsolation/.test(src)) {
    warn(rel(f), '组件未设置 styleIsolation，可能无法使用 app.wxss 里的全局类（如 .num / .amount-income）')
  } else if (!/apply-shared/.test(src)) {
    warn(rel(f), '组件 styleIsolation 不是 apply-shared，全局类可能不生效')
  }
}

// ------------------------------------------------ 9. 全局类引用是否在 app.wxss 里定义
console.log('【9】app.wxss 全局类可达性')
const appWxss = read(path.join(ROOT, 'app.wxss'))
const definedInApp = new Set()
for (const m of appWxss.matchAll(/\.([a-zA-Z][\w-]*)/g)) definedInApp.add(m[1])

// class="hb-fill-{{level}}" 这类**动态后缀**：插值被剔掉后只剩下 "hb-fill-" 这种半截名字，
// 不能当成"未定义的类"直接报掉（这是很常见的写法）。
// 但也不能直接放过 —— 万一前缀拼错成 hb-fil-，表现同样是「样式静默不生效」，
// 正是本项目最难查的那一类问题。所以按**前缀**再查一遍：
// 必须有某个真实定义的类以它为开头。
const DYN_MARK = '\u0001'

for (const f of WXML_FILES) {
  const isComponent = f.includes(path.sep + 'components' + path.sep)
  const ownWxss = exists(f.replace(/\.wxml$/, '.wxss')) ? read(f.replace(/\.wxml$/, '.wxss')) : ''
  const ownDefined = new Set()
  for (const m of ownWxss.matchAll(/\.([a-zA-Z][\w-]*)/g)) ownDefined.add(m[1])
  const pageWxss = appWxss

  const src = read(f).replace(/<!--[\s\S]*?-->/g, '')
  const used = new Set()
  const dynPrefixes = new Set()
  for (const m of src.matchAll(/\bclass\s*=\s*"([^"]*)"/g)) {
    // 去掉插值表达式，只取静态类名
    const stat = m[1].replace(/\{\{[\s\S]*?\}\}/g, ' ')
    for (const c of stat.split(/\s+/)) if (c && !c.includes('{')) used.add(c)

    // 再扫一遍带标记的版本，收集「前缀-{{插值}}」里的前缀
    const marked = m[1].replace(/\{\{[\s\S]*?\}\}/g, DYN_MARK)
    for (const token of marked.split(/\s+/)) {
      if (!token || token.indexOf(DYN_MARK) === -1) continue
      const prefix = token.split(DYN_MARK)[0]
      if (prefix) dynPrefixes.add(prefix)
    }
  }

  for (const c of used) {
    if (ownDefined.has(c)) continue
    if (pageWxss.includes('.' + c)) continue
    // 允许第三方/内置类名
    if (['container', 'page', 'safe-area-bottom'].includes(c)) continue

    if (dynPrefixes.has(c)) {
      const hit = Array.from(ownDefined).some(x => x.startsWith(c))
      if (hit) continue
      warn(rel(f), `class="...-{{...}}" 拼出来的类，前缀 .${c} 在样式里找不到任何匹配（样式会静默不生效）`)
      continue
    }

    warn(rel(f), `类 .${c} 在本页 wxss 与 app.wxss 里都没有定义${isComponent ? '（组件需 styleIsolation: apply-shared）' : ''}`)
  }
}

// ------------------------------------------------ 10. wx:if / wx:elif / wx:else 链
console.log('【10】wx:if / wx:elif / wx:else 链')
for (const f of WXML_FILES) {
  const src = read(f).replace(/<!--[\s\S]*?-->/g, '')
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  const stack = [{ last: null }]
  let m
  while ((m = re.exec(src))) {
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const attrs = m[3]
    const self = m[4] === '/'
    if (closing) { stack.pop(); continue }
    const cur = stack[stack.length - 1]
    const dir = /\bwx:if\b/.test(attrs) ? 'if'
      : /\bwx:elif\b/.test(attrs) ? 'elif'
        : /\bwx:else\b/.test(attrs) ? 'else' : null
    if (dir === 'elif' || dir === 'else') {
      if (cur.last !== 'if' && cur.last !== 'elif') {
        err(rel(f), `wx:${dir} 前面没有紧邻的 wx:if / wx:elif（链会断裂，该分支永远不生效）`)
      }
    }
    cur.last = dir
    if (!self && !VOID_TAGS.has(tag)) stack.push({ last: null })
  }
}

// ------------------------------------------------ 11. WXML 变量是否在 data / properties 里
console.log('【11】WXML 数据绑定变量')
// 从 `data: {`、`setData({`、`properties: {` 里收集顶层 key
function collectObjectKeys(src, openIdx) {
  const keys = new Set()
  let i = openIdx
  let depth = 0
  const start = openIdx + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) break }
    else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
    }
    i++
  }
  const body = src.slice(start, i)
  for (const k of body.matchAll(/(?:^|[\s,{])(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)) {
    const name = k[1] || k[2] || k[3]
    if (name) keys.add(name.split('.')[0])
  }
  return keys
}

function dataKeysOf(jsFile) {
  const keys = new Set()
  if (!exists(jsFile)) return keys
  const src = read(jsFile)
  for (const m of src.matchAll(/\b(data|properties)\s*:\s*\{/g)) {
    const open = m.index + m[0].length - 1
    collectObjectKeys(src, open).forEach(k => keys.add(k))
  }
  for (const m of src.matchAll(/\bsetData\s*\(\s*\{/g)) {
    const open = m.index + m[0].length - 1
    collectObjectKeys(src, open).forEach(k => keys.add(k))
  }
  return keys
}

const BUILTIN_ROOTS = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'index', 'item', 'idx', 'key', 'value', 'length',
  'Math', 'Date', 'JSON', 'String', 'Number', 'Boolean', 'Object', 'Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite'
])

let bindVarCount = 0
for (const f of WXML_FILES) {
  const src = read(f)
  const jsFile = f.replace(/\.wxml$/, '.js')
  const known = dataKeysOf(jsFile)

  // wx:for-item / wx:for-index 自定义别名
  for (const m of src.matchAll(/\bwx:for-item\s*=\s*"([^"]+)"/g)) known.add(m[1].trim())
  for (const m of src.matchAll(/\bwx:for-index\s*=\s*"([^"]+)"/g)) known.add(m[1].trim())

  // <wxs module="xxx"> 与 <wxs src= module="xxx">
  for (const m of src.matchAll(/<wxs[^>]*\bmodule\s*=\s*"([^"]+)"/g)) known.add(m[1])
  // <template name/data>、<import>/<include> 里的变量名无法静态判定，整体跳过含 template 的表达式
  const hasTemplate = /<template\b/.test(src)

  const roots = new Set()
  for (const mm of src.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    // 去掉字符串字面量，避免把 'abc' 当成变量
    const expr = mm[1].replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
    for (const idm of expr.matchAll(/([A-Za-z_$][\w$]*)/g)) {
      // 前面是 . 说明是属性访问，不是根变量
      const before = expr.slice(0, idm.index).trimEnd()
      if (before.endsWith('.')) continue
      // 后面跟 : 且不在 ? : 三元里 → 多半是对象字面量 key，宽松跳过
      roots.add(idm[1])
    }
  }

  for (const r of roots) {
    if (BUILTIN_ROOTS.has(r)) continue
    bindVarCount++
    if (known.has(r)) continue
    if (hasTemplate) { warn(rel(f), `模板里出现未识别的变量 {{${r}}}（该文件含 <template>，可能由 data 传入）`); continue }
    err(rel(f), `WXML 用了 {{${r}}}，但 ${path.basename(jsFile)} 的 data/properties/setData 里都没有这个字段`)
  }
}
console.log(`   校验了 ${bindVarCount} 个变量引用`)

// ------------------------------------------------ 12. data-* 与 dataset 是否对齐
console.log('【12】data-* 属性与 dataset 读取')
function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}
for (const f of WXML_FILES) {
  const src = read(f).replace(/<!--[\s\S]*?-->/g, '')
  const declared = new Set()
  for (const m of src.matchAll(/\bdata-([a-zA-Z][\w-]*)\s*=/g)) declared.add(camel(m[1]))

  const jsFile = f.replace(/\.wxml$/, '.js')
  if (!exists(jsFile)) continue
  const js = read(jsFile)
  for (const m of js.matchAll(/\bdataset\.([A-Za-z_$][\w$]*)/g)) {
    if (!declared.has(m[1])) {
      err(rel(jsFile), `读了 dataset.${m[1]}，但 ${path.basename(f)} 里没有 data-${m[1].replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`)
    }
  }
}

// ------------------------------------------------ 13. canvas / 选择器 id 存在
console.log('【13】选择器 id 与 canvas 节点')
for (const f of JS_FILES) {
  const src = read(f)
  const jsDir = path.dirname(f)
  // 找同目录的 wxml
  const wxmlCandidates = ['js', 'wxml'].map(() => f.replace(/\.js$/, '.wxml'))
  const wxml = wxmlCandidates.find(exists)
  if (!wxml) continue
  const wxmlSrc = read(wxml)
  for (const m of src.matchAll(/select(?:All)?\(\s*['"]#([\w-]+)['"]/g)) {
    const id = m[1]
    if (!new RegExp(`\\bid\\s*=\\s*"${id}"`).test(wxmlSrc)) {
      err(rel(f) + ' → ' + rel(wxml), `选择器 #${id} 在 WXML 里找不到对应节点（图表会画不出来）`)
    }
  }
  // canvas type="2d" 必须带 id 才能拿到 node
  for (const m of wxmlSrc.matchAll(/<canvas\b((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g)) {
    const attrs = m[1]
    if (!/\bid\s*=/.test(attrs)) {
      err(rel(wxml), 'canvas 没有 id，无法通过 SelectorQuery 拿到 2d 节点')
    }
    if (!/type\s*=\s*"2d"/.test(attrs)) {
      warn(rel(wxml), 'canvas 未声明 type="2d"，旧接口在高分屏上会模糊')
    }
  }
}

// ------------------------------------------------ 14. 主题一致性
console.log('【14】主题一致性（utils/theme.js ↔ app.wxss ↔ 图标 ↔ 页面接线）')
const themeJsPath = path.join(ROOT, 'utils', 'theme.js')
if (!exists(themeJsPath)) {
  err('utils/theme.js', '缺失：主题系统依赖它，各页面的 theme-{{theme}} 类需要它提供 id')
} else {
  const themeSrc = read(themeJsPath)

  // THEMES 必须「一行一个主题」，格式固定，生成脚本与这里都靠它解析
  const themes = []
  for (const line of themeSrc.split('\n')) {
    const idM = line.match(/id:\s*'([A-Za-z0-9_]+)'/)
    if (!idM) continue
    const brandM = line.match(/brand:\s*'(#[0-9A-Fa-f]{6})'/)
    if (!brandM) continue
    const heroM = line.match(/hero:\s*'(#[0-9A-Fa-f]{6})'/)
    themes.push({
      id: idM[1],
      brand: brandM[1].toUpperCase(),
      hero: heroM ? heroM[1].toUpperCase() : null
    })
  }
  if (!themes.length) {
    err('utils/theme.js', "解析不出任何主题 —— THEMES 必须一行一个：{ id: 'green', name: '微信绿', brand: '#07C160', hero: '#083A22' },")
  }
  for (const t of themes) {
    if (!t.hero) {
      err('utils/theme.js', `主题 ${t.id} 缺少 hero 色（首页/我的的深色卡片与原生导航栏要用它）`)
    }
  }

  const defaultMatch = themeSrc.match(/DEFAULT_ID\s*=\s*'([A-Za-z0-9_]+)'/)
  const defaultId = defaultMatch ? defaultMatch[1] : null
  if (!defaultId || !themes.some(t => t.id === defaultId)) {
    err('utils/theme.js', `DEFAULT_ID（${defaultId}）不在 THEMES 里`)
  }

  // 每套主题在 app.wxss 里都必须有一组完整令牌
  const REQUIRED_TOKENS = [
    '--brand', '--brand-dark', '--brand-soft', '--brand-soft-2', '--brand-grad',
    '--nav-grad', '--brand-line', '--sh-brand', '--sh-brand-soft',
    // hero 组：首页与「我的」的顶部深色卡片 —— 漏一项就会出现「卡片变色了但阴影还是藏青」
    '--hero-top', '--hero-grad', '--hero-glow', '--sh-hero'
  ]
  const SHAPES = TAB_SHAPES   // 来自 app.json（见第 2 组），不再本地写死

  for (const t of themes) {
    const blockRe = new RegExp('\\.theme-' + t.id + '\\s*\\{([\\s\\S]*?)\\n\\}')
    const block = appWxss.match(blockRe)
    if (!block) {
      err('app.wxss', `缺少 .theme-${t.id} 类（utils/theme.js 里有这套主题，样式里却没有）`)
      continue
    }
    const body = block[1]
    const brandMatch = body.match(/--brand\s*:\s*(#[0-9A-Fa-f]{6})\s*;/)
    if (!brandMatch) {
      err('app.wxss', `.theme-${t.id} 没有声明 --brand`)
    } else if (brandMatch[1].toUpperCase() !== t.brand) {
      err('app.wxss', `.theme-${t.id} 的 --brand = ${brandMatch[1]}，但 utils/theme.js 里写的是 ${t.brand}`)
    }
    // hero 首色两边必须一致：HTML 侧用它铺卡片，JS 侧用它染原生导航栏，
    // 一旦漂移，导航栏和卡片之间就会露出一条色差带（很难看出是「哪里写错了」）
    const heroMatch = body.match(/--hero-top\s*:\s*(#[0-9A-Fa-f]{6})\s*;/)
    if (!heroMatch) {
      err('app.wxss', `.theme-${t.id} 没有声明 --hero-top（深色卡片会停在默认主题的颜色）`)
    } else if (t.hero && heroMatch[1].toUpperCase() !== t.hero) {
      err('app.wxss', `.theme-${t.id} 的 --hero-top = ${heroMatch[1]}，但 utils/theme.js 的 hero = ${t.hero}（导航栏与卡片会出现色差）`)
    }
    for (const token of REQUIRED_TOKENS) {
      if (!new RegExp(token.replace(/-/g, '\\-') + '\\s*:').test(body)) {
        err('app.wxss', `.theme-${t.id} 缺少令牌 ${token}（换主题时这一项会停在默认色）`)
      }
    }
    // tabBar 选中图标是预生成的 PNG，四套图标一个都不能少
    for (const shape of SHAPES) {
      const icon = `assets/icons/${shape}-active-${t.id}.png`
      if (!exists(path.join(ROOT, icon))) {
        err('assets/icons', `缺少主题图标 ${icon}（跑 python tools/gen-icons.py 生成）`)
      }
    }
  }

  // page 上的默认值必须等于 DEFAULT_ID 那套主题，否则首帧会闪一下别的颜色
  const pageBlock = appWxss.match(/(?:^|\n)page\s*\{([\s\S]*?)\n\}/)
  const pageBrand = pageBlock && pageBlock[1].match(/--brand\s*:\s*(#[0-9A-Fa-f]{6})\s*;/)
  const def = themes.find(t => t.id === defaultId)
  if (!pageBrand) {
    err('app.wxss', 'page 上没有声明 --brand（首帧没有兜底色）')
  } else if (def && pageBrand[1].toUpperCase() !== def.brand) {
    err('app.wxss', `page 的 --brand = ${pageBrand[1]}，但默认主题 ${defaultId} 是 ${def.brand}，首帧会闪色`)
  }

  // app.json 的 tabBar 静态配置也要对齐默认主题（冷启动那一刻用的是它）
  const tabSelected = appJson.tabBar && appJson.tabBar.selectedColor
  if (def && tabSelected && tabSelected.toUpperCase() !== def.brand) {
    err('app.json', `tabBar.selectedColor = ${tabSelected}，与默认主题 ${defaultId}（${def.brand}）不一致`)
  }

  // page 上的 --hero-top 同理：首帧还没跑 JS，靠它兜底
  const pageHero = pageBlock && pageBlock[1].match(/--hero-top\s*:\s*(#[0-9A-Fa-f]{6})\s*;/)
  if (!pageHero) {
    err('app.wxss', 'page 上没有声明 --hero-top（首帧深色卡片没有兜底色）')
  } else if (def && def.hero && pageHero[1].toUpperCase() !== def.hero) {
    err('app.wxss', `page 的 --hero-top = ${pageHero[1]}，但默认主题 ${defaultId} 的 hero 是 ${def.hero}`)
  }

  // 首页的导航栏与下拉露出的顶部底色是写死在 index.json 里的
  // （原生导航栏无法用 CSS 变量染色，只能用 JS 在运行时改）。冷启动第一帧读的是
  // 这两个静态值，所以必须等于默认主题的 hero —— 否则换过主题的用户会先看到
  // 一条绿色的带子再跳成自己的主题色。
  const idxJson = parsedJson[path.join(ROOT, 'pages', 'index', 'index.json')]
  if (def && def.hero && idxJson) {
    for (const key of ['navigationBarBackgroundColor', 'backgroundColorTop']) {
      const v = idxJson[key]
      if (v && v.toUpperCase() !== def.hero) {
        err('pages/index/index.json', `${key} = ${v}，与默认主题 ${defaultId} 的 hero（${def.hero}）不一致 → 冷启动会闪一下`)
      }
    }
  }

  // theme.js 的 PAGE_BG 是 wx.setBackgroundColor 用的页面底色，
  // 必须与 app.wxss 的 --surface-2 同值（下拉时底部露出的就是它）
  const surface2 = pageBlock && pageBlock[1].match(/--surface-2\s*:\s*(#[0-9A-Fa-f]{6})\s*;/)
  const pageBg = themeSrc.match(/PAGE_BG\s*=\s*'(#[0-9A-Fa-f]{6})'/)
  if (!pageBg) {
    err('utils/theme.js', '缺少 PAGE_BG（wx.setBackgroundColor 要用它把页面底色对齐）')
  } else if (surface2 && pageBg[1].toUpperCase() !== surface2[1].toUpperCase()) {
    err('utils/theme.js', `PAGE_BG = ${pageBg[1]}，但 app.wxss 的 --surface-2 = ${surface2[1]}`)
  }

  // 每个页面都要真的接上主题：根节点挂类 + js 里 require + attach
  for (const p of PAGES) {
    const wxml = path.join(ROOT, p + '.wxml')
    const js = path.join(ROOT, p + '.js')
    if (exists(wxml) && !/class="[^"]*\btheme-\{\{/.test(read(wxml).replace(/<!--[\s\S]*?-->/g, ''))) {
      err(rel(wxml), '根节点没有挂 theme-{{theme}} 类（本页不会跟随主题变色）')
    }

    // 自定义主题的 13 个令牌是**内联注入**的，根节点少了 style 就只剩一个空的
    // .theme-custom 类 —— 页面不会有任何品牌色（按钮变白底黑字），而且不报错。
    if (exists(wxml) && !/style="\{\{themeStyle\}\}"/.test(read(wxml))) {
      err(rel(wxml), '根节点没有 style="{{themeStyle}}"（自定义主题下本页会没有品牌色）')
    }

    if (exists(js)) {
      const src = read(js)
      if (!/require\(['"][^'"]*utils\/theme\.js['"]\)/.test(src)) {
        err(rel(js), "没有 require utils/theme.js")
      }
      if (!/theme\.attach\(/.test(src)) {
        err(rel(js), '没有调用 theme.attach(this)（主题切换后本页不会刷新）')
      }
      // 首帧就要有令牌：只靠 attach（onShow）会先闪一下无色
      if (!/themeStyle:\s*theme\.rootStyle\(\)/.test(src)) {
        err(rel(js), 'data 里缺少 themeStyle: theme.rootStyle()（自定义主题下首帧会无色再变回来）')
      }
    }
  }

  // 自定义主题的 tabBar 选中图标：12 个色相档 × 每个 tab 形状，缺一个就会显示空白图标
  const colorSrc = exists(path.join(ROOT, 'utils/theme-color.js'))
    ? read(path.join(ROOT, 'utils/theme-color.js'))
    : ''
  if (!colorSrc) {
    err('utils/theme-color.js', '缺失：自定义主题的色值计算依赖它')
  } else {
    const stepsMatch = colorSrc.match(/const HUE_STEPS = (\d+)/)
    const steps = stepsMatch ? parseInt(stepsMatch[1], 10) : 0
    if (!steps) {
      err('utils/theme-color.js', '缺少 HUE_STEPS（tabBar 分档图标按它决定档数）')
    } else {
      const missing = []
      for (let i = 0; i < steps; i++) {
        const deg = Math.round(i * 360 / steps) % 360
        for (const shape of TAB_SHAPES) {
          const f = `assets/icons/${shape}-active-h${deg}.png`
          if (!exists(f)) missing.push(f)
        }
      }
      if (missing.length) {
        err('assets/icons', `${missing.length} 个色相分档图标缺失（跑一次 python tools/gen-icons.py）：${missing.slice(0, 6).join(', ')}…`)
      }
      // theme.js 拼路径的规则必须与生成脚本的命名一致
      if (!/h'\s*\+\s*\(color\.hueBucket/.test(read(path.join(ROOT, 'utils/theme.js')))) {
        err('utils/theme.js', "syncTabBar 里没有按 hueBucket 拼 -active-h<度数>.png（自定义主题会显示空白图标）")
      }
    }
  }

  // 旧变量别名已整块删除 —— 名字留着不报错，但样式会静默落空，必须揪出来
  const LEGACY = ['--primary-color', '--primary-light', '--success-color', '--danger-color',
    '--warning-color', '--bg-color', '--card-bg', '--border-color',
    '--text-primary', '--text-secondary', '--text-hint']
  for (const f of WXSS_FILES.concat(WXML_FILES)) {
    const lines = read(f).split('\n')
    lines.forEach((line, i) => {
      for (const name of LEGACY) {
        if (line.includes(name)) {
          err(`${rel(f)}:${i + 1}`, `${name} 已不存在（旧别名层已删除）→ 改用新令牌，否则样式静默失效`)
        }
      }
    })
  }

  console.log(`   主题 ${themes.length} 套（默认 ${defaultId}），令牌 ${REQUIRED_TOKENS.length} 项/套，图标 ${themes.length * SHAPES.length} 个`)
}

// ------------------------------------------------ 15. 资源与打包
console.log('【15】资源冗余与打包配置')
// 图标必须被引用，避免换了配色/改名后留下一堆没人用的 PNG
const referenced = new Set()
for (const icon of tabIcons) referenced.add(icon)
for (const f of WXML_FILES) {
  for (const m of read(f).matchAll(/\bsrc\s*=\s*"(\/assets\/[^"{}]+)"/g)) referenced.add(m[1].replace(/^\//, ''))
  for (const m of read(f).matchAll(/\bsrc\s*=\s*"(\.\.\/\.\.\/assets\/[^"{}]+)"/g)) {
    referenced.add(m[1].replace(/^\.\.\/\.\.\//, ''))
  }
}
{
  const themeSrc = exists(path.join(ROOT, 'utils', 'theme.js')) ? read(path.join(ROOT, 'utils', 'theme.js')) : ''
  for (const m of themeSrc.matchAll(/id:\s*'([A-Za-z0-9_]+)'/g)) {
    for (const shape of TAB_SHAPES) {
      referenced.add(`assets/icons/${shape}-active-${m[1]}.png`)
      referenced.add(`assets/icons/${shape}.png`)
    }
  }

  // 自定义主题的分档图标是**运行时拼路径**的（-active-h<度数>.png），
  // WXML 里不可能出现文件名，所以按 theme-color.js 的档数把这批也标记为"已引用"。
  const colorSrc = exists(path.join(ROOT, 'utils', 'theme-color.js'))
    ? read(path.join(ROOT, 'utils', 'theme-color.js'))
    : ''
  const stepsMatch = colorSrc.match(/const HUE_STEPS = (\d+)/)
  const steps = stepsMatch ? parseInt(stepsMatch[1], 10) : 0
  for (let i = 0; i < steps; i++) {
    const deg = Math.round(i * 360 / steps) % 360
    for (const shape of TAB_SHAPES) referenced.add(`assets/icons/${shape}-active-h${deg}.png`)
  }
}
for (const f of ALL.filter(x => /assets[\\/].*\.(png|jpg|jpeg)$/i.test(x))) {
  const r = rel(f)
  if (!referenced.has(r)) warn(r, '没有被任何 WXML / app.json 引用（可以删掉，减小包体积）')
}

// 开发用的 tests/ tools/ 不该进小程序包
const projectConfig = parsedJson[path.join(ROOT, 'project.config.json')]
const ignoreList = (projectConfig && projectConfig.packOptions && projectConfig.packOptions.ignore) || []
for (const dir of ['tests', 'tools']) {
  if (exists(path.join(ROOT, dir)) && !ignoreList.some(x => x.type === 'folder' && x.value === dir)) {
    warn('project.config.json', `packOptions.ignore 里没有 ${dir}/ —— 开发脚本会被打进小程序包`)
  }
}

// 组件目录必须真的被 usingComponents 引用，也不该有空目录残留
const componentsDir = path.join(ROOT, 'components')
if (exists(componentsDir)) {
  const referencedComponents = new Set()
  for (const f of JSON_FILES) {
    const j = parsedJson[f]
    if (!j || !j.usingComponents) continue
    for (const spec of Object.values(j.usingComponents)) referencedComponents.add(spec.replace(/^\//, ''))
  }
  for (const name of fs.readdirSync(componentsDir)) {
    const full = path.join(componentsDir, name)
    if (!fs.statSync(full).isDirectory()) continue
    const files = fs.readdirSync(full)
    if (!files.length) { warn(`components/${name}`, '空目录（可以删掉）'); continue }
    const spec = `components/${name}/${name}`
    if (!referencedComponents.has(spec)) {
      warn(`components/${name}`, `没有任何页面用 usingComponents 引用 ${spec}（死代码，会随包上传）`)
    }
  }
}
console.log('   资源引用与打包配置检查完成')

// ------------------------------------------------ 16. WXSS 结构与 CSS 变量可达性
// WXSS 写错了不会报错，只会「样式没生效」—— 这是最难查的一类问题，所以单独守一遍。
console.log('【16】WXSS 花括号配对与 CSS 变量可达性')
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '')

for (const f of WXSS_FILES) {
  const noComment = stripComments(read(f))
  const lines = noComment.split('\n')
  let depth = 0
  let brokeAt = 0
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth < 0 && !brokeAt) brokeAt = i + 1 }
    }
  }
  if (brokeAt) err(`${rel(f)}:${brokeAt}`, '出现了多余的 }（花括号不配对，后面的所有样式都会失效）')
  else if (depth !== 0) err(rel(f), `花括号不配对：还有 ${depth} 个 { 没有闭合`)
}

// 收集全项目声明过的 CSS 自定义属性（含页面内联 style 里写的）
const declaredVars = new Set()
for (const f of WXSS_FILES.concat(WXML_FILES).concat(JS_FILES)) {
  const src = stripComments(read(f))
  for (const m of src.matchAll(/(^|[\s;{'"`])(--[A-Za-z0-9_-]+)\s*:/g)) declaredVars.add(m[2])
}

let varUseCount = 0
for (const f of WXSS_FILES) {
  const lines = stripComments(read(f)).split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g)) {
      varUseCount++
      const name = m[1]
      if (declaredVars.has(name)) continue
      const hasFallback = m[2] === ','
      const where = `${rel(f)}:${i + 1}`
      if (hasFallback) warn(where, `var(${name}, …) 未在任何地方声明，只会用到兜底值`)
      else err(where, `var(${name}) 未在任何地方声明 → 这条样式会整条失效（不会报错，只会没效果）`)
    }
  })
}

// 主题类必须能被页面的 theme-{{theme}} 命中：id 只允许小写字母/数字/下划线
console.log(`   WXSS ${WXSS_FILES.length} 个文件括号配对，校验了 ${varUseCount} 处 var() 引用（已声明 ${declaredVars.size} 个变量）`)

// ------------------------------------------------ 17. 交互细节的跨文件对账
// 「同一个数字写在两个文件里」是这类交互最常见的隐性 bug：
// 代码不报错、样式也在，但两个值不一致 → 表现为「删除键露出一半」这种诡异现象。
console.log('【17】左滑删除宽度与组件事件对账')

{
  const cardJs = path.join(ROOT, 'components', 'bill-card', 'bill-card.js')
  const cardWxss = path.join(ROOT, 'components', 'bill-card', 'bill-card.wxss')

  if (exists(cardJs) && exists(cardWxss)) {
    const jsReveal = read(cardJs).match(/const\s+REVEAL_RPX\s*=\s*(\d+)/)
    const cssReveal = read(cardWxss).match(/\.swipe-del\s*\{[\s\S]*?width:\s*(\d+)\s*rpx/)

    if (!jsReveal) {
      warn('components/bill-card/bill-card.js', '找不到 REVEAL_RPX —— 左滑位移没有单一来源，宽度对不上时很难查')
    } else if (!cssReveal) {
      err('components/bill-card/bill-card.wxss', '没找到 .swipe-del 的 width（rpx）—— 删除键宽度必须与 JS 的 REVEAL_RPX 同值')
    } else if (jsReveal[1] !== cssReveal[1]) {
      err('components/bill-card', `JS 的 REVEAL_RPX = ${jsReveal[1]}，但 .swipe-del 的 width = ${cssReveal[1]}rpx —— 删除键会露出一截或留白`)
    } else {
      console.log(`   左滑露出的删除键宽度 ${jsReveal[1]}rpx（JS 与 WXSS 一致）`)
    }
  }
}

// 组件自定义事件：页面 bind:x 了，组件却从没 triggerEvent('x') → 多半是拼错，
// 表现为「点了没反应」，而且不报任何错。
// 原生事件（tap / touchstart 等）不在检查范围内 —— 它们由基础库自己抛。
const NATIVE_EVENTS = new Set([
  'tap', 'longpress', 'longtap', 'touchstart', 'touchmove', 'touchend', 'touchcancel',
  'transitionend', 'animationstart', 'animationiteration', 'animationend',
  'load', 'error', 'scroll', 'scrolltoupper', 'scrolltolower', 'input', 'focus', 'blur',
  'confirm', 'change', 'submit', 'reset', 'columnchange', 'linechange', 'getuserinfo'
])

let customEventCount = 0
for (const f of WXML_FILES) {
  const pageJson = parsedJson[f.replace(/\.wxml$/, '.json')]
  const comps = (pageJson && pageJson.usingComponents) || {}
  if (!Object.keys(comps).length) continue

  const src = read(f).replace(/<!--[\s\S]*?-->/g, '')

  for (const m of src.matchAll(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g)) {
    const tag = m[1]
    const spec = comps[tag] || comps[tag.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
    if (!spec) continue

    const target = absOf(f, spec)
    const compJs = target && exists(target + '.js') ? read(target + '.js') : ''

    for (const b of m[2].matchAll(/\bbind:?([a-zA-Z][\w-]*)\s*=/g)) {
      const evt = b[1]
      if (NATIVE_EVENTS.has(evt.toLowerCase())) continue
      customEventCount++
      if (!new RegExp(`triggerEvent\\(\\s*['"]${evt}['"]`).test(compJs)) {
        err(rel(f), `组件 <${tag}> 上绑了 bind:${evt}，但 ${path.basename(target)}.js 里没有 triggerEvent('${evt}')（拼错就永远不触发，且不报错）`)
      }
    }
  }
}
console.log(`   校验了 ${customEventCount} 个组件自定义事件绑定`)

// ------------------------------------------------ 18. 账号体系两侧对账
// 「同一条规则写在前后端两个文件里」和「同一个数字写在两处」是同一类坑：
// 代码不报错，但前端放行、后端拒绝 —— 用户看到「明明填对了却说格式不对」。
// 版本号则是另一种：漏改一个云函数的 package.json，上传时不会报错，
// 但云端跑的是旧版本号，排查线上问题时会被它误导。
console.log('【18】昵称常量 / 版本号 / 存储键 对账')

{
  const userUtil = path.join(ROOT, 'utils', 'user.js')
  const userFn = path.join(ROOT, 'cloudfunctions', 'user', 'index.js')
  const readConst = (src, name) => {
    const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\d+)'))
    return m ? m[1] : null
  }

  if (!exists(userUtil)) {
    err('utils/user.js', '缺少用户档案模块（昵称等展示信息没有单一出口）')
  } else if (!exists(userFn)) {
    err('cloudfunctions/user/index.js', '缺少 user 云函数')
  } else {
    const uSrc = read(userUtil)
    const fSrc = read(userFn)
    let ok = true

    // 昵称长度与预算上下限都是「前后端各写一份」的规则：
    // 前端那份只负责输入时的即时反馈，说了算的永远是云函数。
    // 两边不一致时会表现成「明明填对了却存不上」，开发者自己还往往复现不出来
    // （他填的值通常刚好合法）。
    const SHARED = ['NICK_MIN', 'NICK_MAX', 'BUDGET_MAX', 'BUDGET_DECIMALS']

    for (const name of SHARED) {
      const a = readConst(uSrc, name)
      const b = readConst(fSrc, name)

      if (a === null) { err('utils/user.js', `找不到 ${name}`); ok = false }
      else if (b === null) { err('cloudfunctions/user/index.js', `找不到 ${name}`); ok = false }
      else if (a !== b) {
        err('前后端共用常量', `${name} 前后端不一致：utils/user.js = ${a}，云函数 = ${b} —— 会出现「前端放行、后端拒绝」的怪状`)
        ok = false
      }
    }

    if (ok) {
      console.log(`   昵称长度（${readConst(uSrc, 'NICK_MIN')}-${readConst(uSrc, 'NICK_MAX')} 个字符）`
        + `与预算常量（上限 ${readConst(uSrc, 'BUDGET_MAX')}，${readConst(uSrc, 'BUDGET_DECIMALS')} 位小数）前后端一致`)
    }

    // ---- 常记的：上限写在三处 ----
    // 前端 utils/quick-picks.js 的 LIMIT、user 云函数的 QUICK_PICK_LIMIT、
    // getStatistics 的 QUICK_PICK_LIMIT。
    // 任一处改了、另两处没跟上就会静默出错：
    //   前端 10 / 后端 6 → 面板能加到第 10 个，一保存就被拒（"保存失败"却看不出原因）
    //   推荐 10 / 列表 6 → 推荐里点第 7 个永远加不进去
    {
      const pickUtil = path.join(ROOT, 'utils', 'quick-picks.js')
      const statsFn = path.join(ROOT, 'cloudfunctions', 'getStatistics', 'index.js')
      const grab = (p, name) => {
        if (!exists(p)) return null
        const m = read(p).match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\d+)'))
        return m ? m[1] : null
      }
      const a = grab(pickUtil, 'LIMIT')
      const b = grab(userFn, 'QUICK_PICK_LIMIT')
      const c = grab(statsFn, 'QUICK_PICK_LIMIT')

      if (a === null) err('utils/quick-picks.js', '找不到常记的条数上限 LIMIT')
      else if (b === null) err('cloudfunctions/user/index.js', '找不到 QUICK_PICK_LIMIT')
      else if (c === null) err('cloudfunctions/getStatistics/index.js', '找不到 QUICK_PICK_LIMIT')
      else if (a !== b || b !== c) {
        err('常记的上限', `三处不一致：前端 ${a} / user 云函数 ${b} / getStatistics ${c}` +
          ' —— 会出现「面板能加到第 N 个，保存却被拒」且看不出原因')
      } else {
        console.log(`   常记的上限三处一致（${a} 个）`)
      }
    }
  }
}

{
  const verSrc = read(path.join(ROOT, 'utils', 'version.js'))
  const m = verSrc.match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/)

  if (!m) {
    err('utils/version.js', '找不到 VERSION 常量')
  } else {
    let checked = 0
    for (const dir of fs.readdirSync(path.join(ROOT, 'cloudfunctions'))) {
      const pj = path.join(ROOT, 'cloudfunctions', dir, 'package.json')
      if (!exists(pj)) continue
      checked++
      const j = JSON.parse(read(pj))
      if (j.version !== m[1]) {
        err('cloudfunctions/' + dir + '/package.json',
          `version 是 "${j.version}"，与 utils/version.js 的 "${m[1]}" 不一致（改版本号要一起改）`)
      }
    }
    console.log(`   版本号 ${m[1]}，${checked} 个云函数已同步`)
  }
}

// 本机存储键：两个模块用同一个键会互相覆盖（改主题把昵称冲掉，且极难查）
{
  const seen = {}
  let dup = false

  for (const f of JS_FILES) {
    for (const s of read(f).matchAll(/const\s+STORAGE_KEY\s*=\s*['"]([^'"]+)['"]/g)) {
      if (seen[s[1]] && seen[s[1]] !== rel(f)) {
        err(rel(f), `存储键 "${s[1]}" 已被 ${seen[s[1]]} 占用 —— 两个模块会互相覆盖`)
        dup = true
      } else {
        seen[s[1]] = rel(f)
      }
    }
  }

  const keys = Object.keys(seen)
  if (!dup) console.log(`   本机存储键 ${keys.length} 个，无冲突（${keys.join(', ')}）`)
}

// ------------------------------------------------ 19. 关于信息（作者 / 版权 / 联系方式）
// 「关于」里的邮箱和 GitHub 既要显示、又要在点击时被复制走。
// 如果显示值与复制值来自两个地方，就会出现「屏幕上一个、复制出来另一个」——
// 而这种错用户几乎不可能发现，只会遇到"发出去的邮件被退回"。
// 这里做三件事：常量格式合法、WXML 真的绑定了这几项、版权文案引用作者常量而不是又写死一遍。
console.log('【19】关于信息与版权声明')

{
  const profileJs = path.join(ROOT, 'pages', 'profile', 'profile.js')
  const profileWxml = path.join(ROOT, 'pages', 'profile', 'profile.wxml')

  const readConstStr = (src, name) => {
    const m = src.match(new RegExp("const\\s+" + name + "\\s*=\\s*'([^']*)'"))
    return m ? m[1] : null
  }

  if (!exists(profileJs)) {
    err('pages/profile/profile.js', '缺少个人中心页面（关于信息在这里）')
  } else {
    const src = read(profileJs)

    const author = readConstStr(src, 'AUTHOR')
    const email = readConstStr(src, 'EMAIL')
    const github = readConstStr(src, 'GITHUB')

    if (!author) err('pages/profile/profile.js', '找不到作者常量 AUTHOR')

    if (!email) {
      err('pages/profile/profile.js', '找不到邮箱常量 EMAIL')
    } else if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(email)) {
      err('pages/profile/profile.js', `EMAIL = "${email}" 不是合法的邮箱地址`)
    }

    if (!github) {
      err('pages/profile/profile.js', '找不到 GitHub 常量 GITHUB')
    } else if (github.indexOf('https://github.com/') !== 0) {
      err('pages/profile/profile.js',
        `GITHUB = "${github}" 必须是 https://github.com/ 开头的完整地址（少了协议头用户点不开）`)
    }

    // 版权起始年份 + 文案形态
    const yearMatch = src.match(/const\s+COPYRIGHT_FROM\s*=\s*(\d{4})/)
    if (!yearMatch) {
      err('pages/profile/profile.js', '找不到版权起始年份 COPYRIGHT_FROM')
    } else if (Number(yearMatch[1]) < 2000 || Number(yearMatch[1]) > 2100) {
      err('pages/profile/profile.js', `COPYRIGHT_FROM = ${yearMatch[1]} 不像一个真实年份`)
    }
    if (!/Copyright/.test(src) || !/All rights reserved/.test(src)) {
      err('pages/profile/profile.js', '版权声明必须同时含 "Copyright" 与 "All rights reserved."')
    }
    // 作者名必须由 AUTHOR 拼出来：版权行里再写死一遍，改名时必然漏一处
    if (!/Copyright[\s\S]{0,120}\+\s*AUTHOR/.test(src)) {
      err('pages/profile/profile.js', '版权文案没有引用 AUTHOR 常量（名字会出现两份，改名时必漏一处）')
    }

    if (exists(profileWxml)) {
      const wxml = read(profileWxml)
      const BOUND = [['author', 'AUTHOR'], ['email', 'EMAIL'], ['github', 'GITHUB'], ['copyright', '版权']]
      for (const [field, what] of BOUND) {
        if (wxml.indexOf('{{' + field + '}}') === -1) {
          err('pages/profile/profile.wxml', `关于弹层没有绑定 {{${field}}}（${what} 不会显示出来）`)
        }
      }
      if (!/bindtap="copyAbout"/.test(wxml)) {
        warn('pages/profile/profile.wxml', '关于弹层里没有「点击复制」—— 邮箱和链接只能手抄，手抄基本会抄错')
      }
      for (const f of ['email', 'github']) {
        if (!new RegExp('data-field="' + f + '"').test(wxml)) {
          err('pages/profile/profile.wxml', `copyAbout 那一行缺少 data-field="${f}"（点了复制不出内容）`)
        }
      }
    }

    if (author && email && github) {
      console.log(`   作者 ${author}｜${email}｜${github}`)
    }
  }
}

// ------------------------------------------------ 20. 按钮文字必须居中
// 踩过的坑：记一笔页的保存按钮写成**独立类**（没搭全局 .btn-primary），
// 于是拿不到 text-align: center 和 padding: 0，只能吃微信 button 的默认样式
// （默认带 padding: 0 14px、对齐取决于基础库默认值），
// 表现是「按钮文字不居中」—— 而代码看着完全正常。
// 约定：按钮一律复用 app.wxss 的全局按钮类（单一数据源）；
// 确实要自定义的（如 AI 页 hero-cta）必须自己显式写 text-align: center。
console.log('【20】按钮文字居中（复用全局按钮类或显式 text-align）')

{
  const GLOBAL_BTN = ['btn-primary', 'btn-outline', 'btn-ghost', 'btn-danger']
  // 取某个类名的规则体。复合选择器（.a.is-saving / .a[disabled] / .a::after）
  // 也一起算进来 —— 只要其中一条写了 text-align: center 就算数。
  const ruleBodies = (wxss, cls) => {
    if (!wxss) return []
    const re = new RegExp('\\.' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b[^{]*\\{([^}]*)\\}', 'g')
    const out = []
    for (const m of wxss.matchAll(re)) out.push(m[1])
    return out
  }

  const appSrc = exists(path.join(ROOT, 'app.wxss')) ? read(path.join(ROOT, 'app.wxss')) : ''

  let btnCount = 0
  for (const f of WXML_FILES) {
    const src = read(f).replace(/<!--[\s\S]*?-->/g, '')
    const wxssPath = f.replace(/\.wxml$/, '.wxss')
    const pageSrc = exists(wxssPath) ? read(wxssPath) : ''

    for (const m of src.matchAll(/<button\b((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g)) {
      const attrs = m[1]
      const clsMatch = attrs.match(/\bclass\s*=\s*"([^"]*)"/)
      if (!clsMatch) {
        err(rel(f), '<button> 没有 class —— 会用微信默认样式（文字不居中、还带默认内边距）')
        continue
      }
      btnCount++

      // 去掉 {{}} 表达式，只留静态类名
      const classes = clsMatch[1]
        .replace(/\{\{[^}]*\}\}/g, ' ')
        .split(/\s+/)
        .filter(Boolean)

      if (classes.some(c => GLOBAL_BTN.indexOf(c) !== -1)) continue

      const hasCenter = classes.some(c =>
        ruleBodies(pageSrc, c).concat(ruleBodies(appSrc, c))
          .some(b => /text-align\s*:\s*center/.test(b))
      )
      if (!hasCenter) {
        const cls = clsMatch[1]
        const detail = '既没复用全局按钮类（' + GLOBAL_BTN.join(' / ') + '），自己的类里也没写 text-align: center —— 文字不会居中'
        err(rel(f), '<button class="' + cls + '"> ' + detail)
      }
    }
  }
  console.log(`   校验了 ${btnCount} 个 button`)
}

// ------------------------------------------------ 21. 页面可转发
// 微信规则：**只有定义了 onShareAppMessage 的页面，右上角菜单才会出现"转发"按钮**。
// 漏定义不会报任何错，表现是用户点右上角三个点后提示"当前页面无法转发" ——
// 纯产品能力缺失，而每个页面都手动确认一遍太容易漏，所以用检查钉住。
console.log('【21】页面可转发（必须定义 onShareAppMessage）')

{
  let okCount = 0
  const noTimeline = []
  for (const p of PAGES) {
    const js = path.join(ROOT, p + '.js')
    if (!exists(js)) continue
    const src = read(js)
    if (!/\bonShareAppMessage\s*\(/.test(src)) {
      err(rel(js), '没有定义 onShareAppMessage —— 右上角菜单不会出现"转发"按钮（表现为"当前页面无法转发"）')
      continue
    }
    okCount++
    // onShareTimeline 是可选能力（朋友圈），漏了只提示不拦
    if (!/\bonShareTimeline\s*\(/.test(src)) noTimeline.push(rel(js))
  }
  if (noTimeline.length) {
    noTimeline.forEach(f => warn(f, '没定义 onShareTimeline —— 少一个朋友圈分享入口（可选，不拦）'))
  }
  if (okCount === PAGES.length) console.log(`   ${okCount} 个页面全部可转发`)
}

// ------------------------------------------------ 汇总
console.log('\n' + '='.repeat(60))
if (errors.length) {
  console.log(`❌ 错误 ${errors.length} 项：`)
  errors.forEach(e => console.log('   ' + e))
}
if (warnings.length) {
  console.log(`\n⚠️  警告 ${warnings.length} 项：`)
  warnings.forEach(w => console.log('   ' + w))
}
if (!errors.length && !warnings.length) console.log('全部检查通过 ✅')
console.log('='.repeat(60))

process.exit(errors.length ? 1 : 0)
