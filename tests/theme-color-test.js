/**
 * 自定义主题色（utils/theme-color.js）离线验证
 *
 * 这里守的不是"逻辑分支"，而是**颜色本身能不能用**：
 *   1. 白字压在 hero 上够不够清楚（对比度）—— 屏幕上看不出 6.9 还是 5.4，但用户的眼会累
 *   2. 渐变三档的亮度比是不是还在 1.3 以内 —— 超了就变成廉价的塑料渐变
 *   3. 13 个令牌有没有算全 —— 漏一个的表现是"换色后某个阴影还是绿的"，不报错
 *   4. 色相分档与调色板是不是同一套色（否则调色板挑了紫、底部图标却是蓝）
 *
 * 这些都能离线算，所以不靠"看起来还行"。
 *
 * 运行：node tests/theme-color-test.js
 */
const path = require('path')

const ROOT = path.join(__dirname, '..')
const tc = require(path.join(ROOT, 'utils', 'theme-color.js'))

let fail = 0
const t = (ok, msg) => { console.log((ok ? '  ✅ ' : '  ❌ ') + msg); if (!ok) fail++ }

// 内置主题（与 utils/theme.js 的 THEMES 一致）—— 派生规则对不对，拿它们做标尺
const PRESETS = [
  { brand: '#07C160', hero: '#0B5F3A' },
  { brand: '#2B5CE6', hero: '#1B4C8F' },
  { brand: '#6D4AE0', hero: '#4B3894' },
  { brand: '#F97316', hero: '#7F3E0B' },
  { brand: '#EC4899', hero: '#94224F' }
]

// ---------------------------------------------------------------- 1. 基础换算
console.log('\n=== 1) 十六进制解析与换算 ===')

t(tc.normalizeHex('#07c160') === '#07C160', '#07c160 → #07C160（统一大写，便于与云端字符串比对）')
t(tc.normalizeHex('07C160') === '#07C160', '省略 # 也认（云端的值可能被 trim 过）')
t(tc.normalizeHex('#7c1') === '#77CC11', '#7c1 三位简写展开为 #77CC11（每位复制一遍）')
t(tc.normalizeHex('  #07C160  ') === '#07C160', '前后空白被 trim')
t(tc.normalizeHex('zzz') === '' && tc.normalizeHex('') === '' && tc.normalizeHex(null) === '',
  '非法输入一律返回空串（调用方据此回落到默认色，不会写进存储）')
t(tc.normalizeHex('#07C1600') === '', '七位不是合法十六进制色')
t(tc.normalizeHex('#GGGGGG') === '', '非十六进制字符被拒绝')

let roundTripOk = true
;['#000000', '#FFFFFF', '#07C160', '#2B5CE6', '#7F3E0B', '#E6F8EF'].forEach(function (hex) {
  const hsl = tc.hexToHsl(hex)
  if (tc.fromHsl(hsl.h, hsl.s, hsl.l) !== hex) roundTripOk = false
})
t(roundTripOk, 'hex → hsl → hex 无损往返（取整不丢色）')

// ---------------------------------------------------------------- 2. 品牌色收敛
console.log('\n=== 2) 品牌色：只调明度，绝不改色相 ===')

const goldBrand = tc.brandOf('#FFD700')
const goldHsl = tc.hexToHsl(goldBrand)
const goldContrast = tc.contrast('#FFFFFF', goldBrand)
t(goldContrast >= tc.BRAND_MIN_CONTRAST - 1e-9,
  `亮金色 #FFD700 被压暗到白字可读（对比 ${goldContrast.toFixed(2)} ≥ ${tc.BRAND_MIN_CONTRAST}）`)
t(Math.abs(goldHsl.h - tc.hexToHsl('#FFD700').h) < 1.5,
  `色相仍是金色本身（${goldHsl.h.toFixed(0)}° vs 原始 ${tc.hexToHsl('#FFD700').h.toFixed(0)}°）`)

PRESETS.forEach(function (p) {
  t(tc.brandOf(p.brand) === p.brand, `${p.brand} 本来就在可用区间内 → 原样保留（用户看到的就是他选的）`)
})

// 灰阶：不能因为 h=0 就被"上色"
const greyHero = tc.heroOf(tc.brandOf('#808080'))
const greyHsl = tc.hexToHsl(greyHero)
t(greyHsl.s < 0.02, `灰阶品牌推出的 hero 仍是灰的（S=${greyHsl.s.toFixed(3)}，早期实现会变成红色）`)

// ---------------------------------------------------------------- 3. hero 可读性
console.log('\n=== 3) hero 与白字的对比度（这是硬指标） ===')

PRESETS.concat([{ brand: goldBrand }, { brand: tc.brandOf('#00CED1') }, { brand: tc.brandOf('#8B0000') }])
  .forEach(function (p) {
    const hero = tc.heroOf(p.brand)
    const c = tc.contrast('#FFFFFF', hero)
    t(c >= tc.HERO_CONTRAST - 1e-9,
      `${p.brand} → hero ${hero}，白字对比 ${c.toFixed(2)} ≥ ${tc.HERO_CONTRAST}`)
  })

// 与内置主题同一档深浅（不是"够用就行"，而是要看起来是一套设计）
PRESETS.forEach(function (p) {
  const c = tc.contrast('#FFFFFF', tc.heroOf(p.brand))
  t(c >= 6.8 && c <= 10.5, `${p.brand} 推出的 hero 白字对比 ${c.toFixed(2)}，落在内置主题的 6.8~10.5 档内`)
})

// ---------------------------------------------------------------- 4. 13 个令牌
console.log('\n=== 4) 13 个令牌必须算全、且各司其职 ===')

const TOKENS = tc.TOKEN_KEYS
t(TOKENS.length === 13, `令牌清单是 13 项（实际 ${TOKENS.length}）`)

PRESETS.forEach(function (p) {
  const tok = tc.tokensOf(p.brand)
  const missing = TOKENS.filter(function (k) { return !tok[k] })
  t(missing.length === 0, `${p.brand} 的 13 个令牌齐全${missing.length ? '（缺 ' + missing.join(',') + '）' : ''}`)
})

const tok = tc.tokensOf('#6D4AE0')

// brand-soft 是"接近白"的浅底色，不是饱和色 —— 早期把混白比例写反得到的是 #20C770
t(tc.contrast(tok['brand-soft'], '#FFFFFF') < 1.35,
  `brand-soft 接近白底（与白的对比 ${tc.contrast(tok['brand-soft'], '#FFFFFF').toFixed(2)} < 1.35）`)
t(tc.contrast(tok['brand-soft-2'], '#FFFFFF') < 1.7 &&
  tc.contrast(tok['brand-soft-2'], '#FFFFFF') > tc.contrast(tok['brand-soft'], '#FFFFFF'),
  'brand-soft-2 比 soft 深一档（按下态）')

// brand-dark 必须比 brand 暗，且能被白字压住
t(tc.luminance(tok['brand-dark']) < tc.luminance(tok.brand), 'brand-dark 比 brand 暗')

// hero-grad 三档的亮度比 ≤ 1.3：只有"几乎看不出来"的渐变才像样
const stops = tok['hero-grad'].match(/#[0-9A-F]{6}/g) || []
t(stops.length === 3, `hero-grad 有三个色档（实际 ${stops.length}）`)
const lums = stops.map(tc.luminance)
const gradRatio = Math.max.apply(null, lums) / Math.min.apply(null, lums)
t(gradRatio <= 1.3, `hero-grad 三档亮度比 ${gradRatio.toFixed(2)} ≤ 1.3（超过就成了塑料渐变）`)

// 阴影用的是品牌色的半透明，不是写死的黑
t(tok['sh-brand'].indexOf('rgba(') > 0 && tok['sh-brand'].indexOf('0.28') !== -1, 'sh-brand 用品牌色 28% 透明')
t(tok['brand-line'].indexOf('rgba(') === 0 && tok['brand-line'].indexOf('0.12') !== -1, 'brand-line 本身就是 rgba（直接当颜色用）')

// ---------------------------------------------------------------- 5. 内联样式串
console.log('\n=== 5) 内联样式串（页面根节点就靠它） ===')

const style = tc.styleOf('#2E8B57')
t(style.indexOf('--brand:#2E8B57') === 0, '样式串以 --brand 开头（首帧最先用到它）')
t(TOKENS.every(function (k) { return style.indexOf('--' + k + ':') !== -1 }),
  '13 个变量全部出现在串里')
t((style.match(/--/g) || []).length === 13, `变量数正好 13（实际 ${(style.match(/--/g) || []).length}）`)
t(style.indexOf(';--hero-top:') !== -1, '变量之间用 ; 分隔')
t(tc.styleOf('zzz') === '', '非法色返回空串（不会给页面挂一半的令牌）')

// ---------------------------------------------------------------- 6. 色相分档
console.log('\n=== 6) tabBar 图标分档：12 个色相、命名与文件对得上 ===')

t(tc.HUE_STEPS === 12, `分 12 档（实际 ${tc.HUE_STEPS}）`)

const bucketIds = []
const bucketColors = []
for (let i = 0; i < tc.HUE_STEPS; i++) {
  bucketIds.push(tc.bucketId(i))
  bucketColors.push(tc.bucketColor(i))
}
t(bucketIds.join(',') === 'h0,h30,h60,h90,h120,h150,h180,h210,h240,h270,h300,h330',
  '档位命名 h0~h330，步长 30°（生成脚本与 theme.js 拼路径都依赖它）：' + bucketIds.join(','))
t(new Set(bucketColors).size === tc.HUE_STEPS, '12 个档位色互不相同')

// 调色板每个色块都应该落回"它自己那一档"，否则挑紫色会显示蓝色图标
let bucketMismatch = []
tc.palette().forEach(function (chip) {
  const expected = tc.hueBucket(tc.levelColor(chip.hue, chip.level))
  if (tc.hueBucket(chip.hex) !== expected) bucketMismatch.push(chip.hex)
})
t(bucketMismatch.length === 0,
  `调色板色块的色相分档全部自洽${bucketMismatch.length ? '（不一致：' + bucketMismatch.join(',') + '）' : ''}`)

t(tc.bucketId(tc.hueBucket('#6D4AE0')) === 'h270' || tc.bucketId(tc.hueBucket('#6D4AE0')) === 'h240',
  `紫色 #6D4AE0（254°）落在最近的档上：${tc.bucketId(tc.hueBucket('#6D4AE0'))}`)

// ---------------------------------------------------------------- 7. 调色板
console.log('\n=== 7) 调色板：给了什么色、有没有越界 ===')

const chips = tc.palette()
t(chips.length === 36, `12 色相 × 3 档 = 36 个色块（实际 ${chips.length}）`)
t(new Set(chips.map(function (c) { return c.hex })).size === 36, '36 个色块互不重复')

const tooLight = chips.filter(function (c) { return tc.contrast('#FFFFFF', c.hex) < tc.BRAND_MIN_CONTRAST - 1e-9 })
t(tooLight.length === 0,
  `所有色块的 white 文字对比都在 ${tc.BRAND_MIN_CONTRAST} 以上${tooLight.length ? '（不达标：' + tooLight.map(c => c.hex).join(',') + '）' : ''}`)

t(chips.every(function (c) { return tc.brandOf(c.hex) === c.hex }),
  '色块颜色即最终生效色（不需要再被"修正"，预览与结果一致）')
t(chips.every(function (c) { return tc.contrast('#FFFFFF', tc.heroOf(c.hex)) >= tc.HERO_CONTRAST - 1e-9 }),
  '每个色块推出的 hero 都满足白字对比度（不会出现"挑了浅色就看不清数字"）')

console.log('\n' + (fail === 0 ? '全部通过 ✅' : '有 ' + fail + ' 项失败 ❌'))
process.exit(fail === 0 ? 0 : 1)
