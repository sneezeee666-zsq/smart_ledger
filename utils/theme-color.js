/**
 * 自定义主题色的色值计算（纯函数，不碰 wx）
 * ===========================================================================
 * 为什么单独一个文件？
 *   ① 品牌色不是一个 hex 就能用的 —— app.wxss 里每套主题有 **13 个令牌**
 *      （brand / brand-dark / brand-soft / brand-soft-2 / brand-grad / nav-grad /
 *        brand-line / sh-brand / sh-brand-soft / hero-top / hero-grad / hero-glow / sh-hero），
 *      自定义色必须把它们**全部**算出来，否则换色的那一刻会有一半颜色停在默认主题上。
 *   ② 颜色数学要能被离线测试钉住（tests/theme-color-test.js）：
 *      白字对比度、渐变亮度比这些"看起来对"的标准，靠眼睛是验不出来的。
 *
 * 派生规则不是随手调出来的，而是**从 5 套内置主题反推**的（见 app.wxss）：
 *   brand-dark   = 同色相，L 减 0.10        （#07C160 → #058F48）
 *   brand-soft   = 品牌色混 10% 白          （#07C160 → #E6F8EF）
 *   brand-soft-2 = 混 21% 白
 *   brand-grad   = 品牌色 → 混 16% 白（135deg）
 *   nav-grad     = brand-dark → brand
 *   hero-top     = 同色相、压暗到「白字对比 ≥ 6.6:1」的最浅一档
 *   hero-grad    = hero → 混 4% 白 → 混 8% 白（165deg）
 *   hero-glow    = 亮一档的品牌色做光斑
 *
 * ⚠️ 为什么 hero 不直接用「品牌色调暗 30%」这种固定公式？
 *    同样 L 的黄色和蓝色，白字读起来的差距极大（蓝色显得亮得多）。
 *    用「迭代找到满足对比度的最浅一档」才能对**任意色相**都保证可读，
 *    也正好复现了内置主题那种"中深饱和"的观感。
 */

// 品牌色的可读性下限：白字压在品牌色上的对比度。
//
// ⚠️ 为什么用「对比度」而不是「明度区间」？
//    明度区间拦不住亮黄（#FFD700 的 L 只有 0.50，但白字对比只有 1.6），
//    却会误伤合法的浅粉、浅紫。真正决定"能不能当品牌色"的是白字读不读得清，
//    而这件事由对比度直接表达。调色板里最浅的色块也正好是 2.4，两者同一把尺子。
const BRAND_MIN_CONTRAST = 2.35

// hero 与白字的对比度下限。内置 5 套实测在 7.7 ~ 9.2 之间，
// 取 7.0 让推出来的 hero 与它们同一档深浅，并留余量给 --on-hero-dim（0.78）的灰白小字。
const HERO_CONTRAST = 7.0

// 色相档数：调色板按 30° 一格排 12 个色相，tabBar 选中图标也按这 12 档预生成
// （原生 tabBar 只能吃图片文件，没法运行时染色）
const HUE_STEPS = 12
const HUE_STEP = 360 / HUE_STEPS

// 调色板的饱和度，以及三档的**目标对比度**（与白字）。
//
// ⚠️ 三档为什么不是固定的 HSL 明度？
//    同样是 L=0.50，蓝色配白字对比 3.6、黄色只有 1.4 —— 固定明度的话，
//    黄色那一列选出来就是"白字看不见"。按对比度取色，每一列都同样可用，
//    冷暖色的视觉分量也才对得齐。
const PALETTE_S = 0.78
const LEVEL_TARGETS = [4.0, 3.1, 2.4]
const LEVEL_NAMES = ['深', '中', '浅']

// 三档的明度区间：低于这个值颜色会焦黑，高于则白字必然看不清
const LEVEL_L_MIN = 0.14
const LEVEL_L_MAX = 0.82

function clamp(v, min, max) {
  if (v < min) return min
  if (v > max) return max
  return v
}

function round(v) {
  return Math.round(v)
}

// ==================== 基础颜色换算 ====================

/** '#07C160' / '07c160' / '#7c1' → { r, g, b }；非法返回 null */
function parseHex(v) {
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16)
    }
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16)
    }
  }
  return null
}

function pad2(v) {
  const h = clamp(round(v), 0, 255).toString(16)
  return h.length === 1 ? '0' + h : h
}

/** { r, g, b } → '#RRGGBB'（大写，与 theme.js 里的写法保持一致） */
function toHex(c) {
  return ('#' + pad2(c.r) + pad2(c.g) + pad2(c.b)).toUpperCase()
}

/** 统一成 '#RRGGBB'，非法输入返回 '' */
function normalizeHex(v) {
  const c = parseHex(v)
  return c ? toHex(c) : ''
}

/** #RRGGBB → { h: 0~360, s: 0~1, l: 0~1 } */
function rgbToHsl(c) {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  if (max === min) return { h: 0, s: 0, l: l }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6

  return { h: h * 360, s: s, l: l }
}

/** { h, s, l } → { r, g, b } */
function hslToRgb(hsl) {
  const h = ((hsl.h % 360) + 360) % 360 / 360
  const s = clamp(hsl.s, 0, 1)
  const l = clamp(hsl.l, 0, 1)

  if (s === 0) {
    const v = round(l * 255)
    return { r: v, g: v, b: v }
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q

  function hue2rgb(t) {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }

  return {
    r: round(hue2rgb(h + 1 / 3) * 255),
    g: round(hue2rgb(h) * 255),
    b: round(hue2rgb(h - 1 / 3) * 255)
  }
}

function hexToHsl(hex) {
  const c = parseHex(hex)
  return c ? rgbToHsl(c) : null
}

function fromHsl(h, s, l) {
  return toHex(hslToRgb({ h: h, s: s, l: l }))
}

/** 往白色里混 a（0~1）—— brand-soft / 渐变的浅色一档都用它 */
function mixWhite(hex, a) {
  const c = parseHex(hex)
  if (!c) return ''
  const t = clamp(a, 0, 1)
  return toHex({
    r: c.r + (255 - c.r) * t,
    g: c.g + (255 - c.g) * t,
    b: c.b + (255 - c.b) * t
  })
}

/** 亮度（WCAG 相对亮度） */
function luminance(hex) {
  const c = parseHex(hex)
  if (!c) return 0

  function ch(v) {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }

  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

/** 两色对比度（1 ~ 21），用于验证"白字压在这个底色上能不能看清" */
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

function rgba(hex, alpha) {
  const c = parseHex(hex)
  if (!c) return 'rgba(0,0,0,' + alpha + ')'
  return 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + alpha + ')'
}

// ==================== 品牌色与 hero ====================

/**
/**
 * 把任意输入收敛成可用的品牌色。
 *
 * 只有一种情况会动手：**白字压在它上面读不清**（对比 < BRAND_MIN_CONTRAST）。
 * 那时逐步压暗，直到刚好达标；色相与饱和度一律不动 ——
 * 用户选的"是什么颜色"必须保留，改了色相就不是他选的那个颜色了。
 *
 * ⚠️ 不要再"按明度区间夹取"：那会把亮黄放过去（L 正常但白字看不见），
 *    又把浅粉、浅紫误伤成深色。判断标准是白字能不能读，不是 L 落在哪。
 */
function brandOf(hex) {
  const hsl = hexToHsl(hex)
  if (!hsl) return ''

  const raw = toHex(parseHex(hex))
  if (contrast('#FFFFFF', raw) >= BRAND_MIN_CONTRAST) return raw

  for (let l = hsl.l - 0.01; l >= 0.10; l -= 0.01) {
    const next = fromHsl(hsl.h, hsl.s, l)
    if (contrast('#FFFFFF', next) >= BRAND_MIN_CONTRAST) return next
  }

  return fromHsl(hsl.h, hsl.s, 0.10)
}

/**
 * 由品牌色推出深色 hero 首色。
 *
 * 做法：同色相 + 饱和度收敛到 0.45~0.85（脏色不会变成灰泥），
 * 然后从最浅往最暗找「白字对比度 ≥ HERO_CONTRAST」的第一个 L。
 * ⚠️ 不能用固定公式（如 L×0.55）：黄色和蓝色同样的 L，白字可读性差一倍。
 */
function heroOf(brandHex) {
  const hsl = hexToHsl(brandHex)
  if (!hsl) return ''

  // ⚠️ 灰阶（S≈0，用户选的"黑白主题"）必须**保持灰**：
  //    无条件把 S 拉到 0.45 会让 #FFFFFF 变成 #9B3B3B（灰变红），
  //    因为 h=0 在灰阶里是无意义的默认值，拉高 S 就落到了红色上。
  // 饱和度收到品牌色的 0.82 左右：内置主题的 hero 都不是品牌色的原饱和度
  // （亮绿/亮橙整块铺开会刺眼），实测 5 套的比值在 0.63~0.92 之间，取 0.82 居中。
  const s = hsl.s < 0.10 ? hsl.s : clamp(hsl.s * 0.82, 0.35, 0.85)

  for (let l = 0.42; l >= 0.14; l -= 0.01) {
    const hex = fromHsl(hsl.h, s, l)
    if (contrast('#FFFFFF', hex) >= HERO_CONTRAST) return hex
  }

  return fromHsl(hsl.h, s, 0.14)
}

/**
 * 同色相、抬高一点明度（hero 渐变的后两档）。
 * ⚠️ 这里必须走「L 步进」而不是「混白」：
 *    混 4% / 8% 的白，在 hero 这种很深的色上等于把相对亮度抬了 40%，
 *    三档亮度比会到 1.41 —— 内置主题实测是 1.23~1.29，超了就成了廉价的塑料渐变。
 */
function lightenL(hex, delta) {
  const hsl = hexToHsl(hex)
  if (!hsl) return hex
  return fromHsl(hsl.h, hsl.s, hsl.l + delta)
}

// ==================== 13 个令牌 ====================

/**
 * 生成与 app.wxss 里 `.theme-<id>` 完全对应的 13 个 CSS 变量。
 * ⚠️ 少算一个令牌的表现是"换色时某一个地方还是绿色"（比如阴影、光斑），
 *    而它不会报错，也不在截图里显眼 —— tests/static-check.js 会核对令牌清单。
 *
 * @returns {object} 键不带 `--` 前缀，值是可以直接写进 CSS 的字符串
 */
function tokensOf(brandHex) {
  const brand = brandOf(brandHex)
  if (!brand) return null

  const hero = heroOf(brand)
  const hsl = hexToHsl(brand)
  const darkL = clamp(hsl.l - 0.10, 0.10, 0.90)
  const dark = fromHsl(hsl.h, hsl.s, darkL)
  const light = mixWhite(brand, 0.16)

  return {
    brand: brand,
    'brand-dark': dark,
    // ⚠️ 这两个是**接近白**的底色（卡片/标签的浅色填充），混白比例是 0.90 / 0.80。
    //    把它们当成 0.10 / 0.20 会得到一条饱和的绿带（#20C770），
    //    与内置主题的 #E6F8EF 完全不是一回事 —— 而这种错在页面上很显眼。
    'brand-soft': mixWhite(brand, 0.90),
    'brand-soft-2': mixWhite(brand, 0.80),
    'brand-grad': 'linear-gradient(135deg, ' + brand + ' 0%, ' + light + ' 100%)',
    'nav-grad': 'linear-gradient(135deg, ' + dark + ' 0%, ' + brand + ' 100%)',
    'brand-line': rgba(brand, 0.12),
    'sh-brand': '0 8rpx 20rpx ' + rgba(brand, 0.28),
    'sh-brand-soft': '0 6rpx 18rpx ' + rgba(brand, 0.16),

    'hero-top': hero,
    'hero-grad': 'linear-gradient(165deg, ' + hero + ' 0%, ' + lightenL(hero, 0.014) + ' 52%, ' + lightenL(hero, 0.028) + ' 100%)',
    'hero-glow': 'radial-gradient(circle, ' + rgba(light, 0.28) + ' 0%, ' + rgba(light, 0) + ' 70%)',
    'sh-hero': '0 10rpx 26rpx ' + rgba(hero, 0.2)
  }
}

// 令牌顺序固定：inline style 是字符串，顺序变了会白白触发一次 diff
const TOKEN_KEYS = [
  'brand', 'brand-dark', 'brand-soft', 'brand-soft-2', 'brand-grad', 'nav-grad',
  'brand-line', 'sh-brand', 'sh-brand-soft',
  'hero-top', 'hero-grad', 'hero-glow', 'sh-hero'
]

/**
 * 生成挂在页面根节点上的内联样式：`--brand:#xxx;--hero-top:#yyy;...`
 *
 * ⚠️ 为什么内联注入变量是对的，而"再加一层别名"是错的？
 *    CSS 自定义属性在**声明它的那个元素**上完成 var() 替换，然后向下继承。
 *    把变量直接内联在根节点 = 就是"声明在根节点"，子树全部继承，
 *    包括 position:fixed 的弹层与气泡。这也是 app.wxss 里 .theme-<id> 的做法，
 *    两者等价，只是值来自 JS 而不是样式表。
 */
function styleOf(brandHex) {
  const t = tokensOf(brandHex)
  if (!t) return ''

  const parts = []
  for (let i = 0; i < TOKEN_KEYS.length; i++) {
    const k = TOKEN_KEYS[i]
    parts.push('--' + k + ':' + t[k])
  }
  return parts.join(';')
}

// ==================== tabBar 图标分档 ====================

/**
 * 色相档号（0~HUE_STEPS-1）。
 * 原生 tabBar 的选中图标是预生成的 PNG，没法运行时染色，
 * 所以按 30° 一档预生成 12 套，取色相最近的一档 —— 同色相、同饱和度，
 * 只有明度差一档（≤0.08），81px 的图标上看不出接缝。
 */
function hueBucket(hex) {
  const hsl = hexToHsl(hex)
  if (!hsl) return 0
  const idx = Math.round(hsl.h / HUE_STEP) % HUE_STEPS
  return idx < 0 ? idx + HUE_STEPS : idx
}

/**
 * 某色相、某档（0 深 / 1 中 / 2 浅）的规范色。
 *
 * 从浅往深扫，取「第一个满足目标对比度」的那一档 ——
 * 也就是"同样的可读性下尽量亮"，颜色才不会一水儿发焦。
 */
function levelColor(hue, level) {
  const target = LEVEL_TARGETS[clamp(level, 0, LEVEL_TARGETS.length - 1)]

  for (let l = LEVEL_L_MAX; l >= LEVEL_L_MIN; l -= 0.005) {
    const hex = fromHsl(hue, PALETTE_S, l)
    if (contrast('#FFFFFF', hex) >= target) return hex
  }

  return fromHsl(hue, PALETTE_S, LEVEL_L_MIN)
}

/**
 * 档号 → tabBar 图标色。
 * ⚠️ 取「中」档而不是另定一个明度：图标与文字挨在一起，
 *    差一档明度看不出来，差两档就会像两套配色。
 */
function bucketColor(index) {
  return levelColor(index * HUE_STEP, 1)
}

/** 档号 → 文件名后缀，如 'h0' / 'h330' */
function bucketId(index) {
  const deg = Math.round(index * HUE_STEP) % 360
  return 'h' + deg
}

/**
 * 12 个档位的完整清单（生成图标脚本从 node 这里取，不自己重写颜色数学）。
 * @returns {Array<{hue:number, id:string, hex:string}>}
 */
function bucketPalette() {
  const list = []
  for (let i = 0; i < HUE_STEPS; i++) {
    list.push({
      hue: Math.round(i * HUE_STEP) % 360,
      id: bucketId(i),
      hex: bucketColor(i)
    })
  }
  return list
}

// ==================== 调色板 ====================

/**
 * 调色板的色块：12 个色相 × 3 档 = 36 个。
 *
 * ⚠️ 只提供"能当品牌色用"的颜色，而不是给一条连续色谱：
 *    连续色谱必然出现用户选得到、但当品牌色不可读的颜色（亮黄、纯白），
 *    到那时只有两种结局 —— 要么偷偷改掉他的选择，要么让白字按钮看不清。
 */
function palette() {
  const list = []
  for (let i = 0; i < HUE_STEPS; i++) {
    for (let j = 0; j < LEVEL_TARGETS.length; j++) {
      list.push({
        hex: levelColor(i * HUE_STEP, j),
        hue: Math.round(i * HUE_STEP) % 360,
        level: j,
        levelName: LEVEL_NAMES[j]
      })
    }
  }
  return list
}

module.exports = {
  BRAND_MIN_CONTRAST: BRAND_MIN_CONTRAST,
  HERO_CONTRAST: HERO_CONTRAST,
  HUE_STEPS: HUE_STEPS,
  HUE_STEP: HUE_STEP,
  PALETTE_S: PALETTE_S,
  LEVEL_TARGETS: LEVEL_TARGETS,
  LEVEL_NAMES: LEVEL_NAMES,
  TOKEN_KEYS: TOKEN_KEYS,

  parseHex: parseHex,
  toHex: toHex,
  normalizeHex: normalizeHex,
  rgbToHsl: rgbToHsl,
  hslToRgb: hslToRgb,
  hexToHsl: hexToHsl,
  fromHsl: fromHsl,
  mixWhite: mixWhite,
  lightenL: lightenL,
  luminance: luminance,
  contrast: contrast,
  rgba: rgba,

  brandOf: brandOf,
  heroOf: heroOf,
  tokensOf: tokensOf,
  styleOf: styleOf,

  levelColor: levelColor,
  hueBucket: hueBucket,
  bucketColor: bucketColor,
  bucketId: bucketId,
  bucketPalette: bucketPalette,
  palette: palette
}
