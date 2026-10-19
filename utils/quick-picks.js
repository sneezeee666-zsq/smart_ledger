/**
 * 「常记的」配置 —— 纯函数层（可离线单测）
 *
 * 这一份是**唯一**的规则来源：
 *   - 上限 10 条
 *   - 同「收支 + 对方」只能有一条（否则面板上会出现两个一模一样的 chip）
 *   - 金额必须 > 0 且不超过 1 亿（与云端手动记账的上限同一条线）
 *   - 对方名必须非空，最长 60 字（与云端 maxTitleLen 一致）
 *
 * ⚠️ 云函数 user/setQuickPicks 里有一份同样的校验 —— 那里是说了算的一方。
 *    前端这份只负责即时反馈（拖动后立刻能看出"到上限了"），
 *    两边不一致会表现成"看着加成功了，刷新后没了"，所以两边必须同值。
 *    静态检查第 18 组会把 LIMIT 与云函数对账。
 */

// 面板与配置页共同的硬上限
const LIMIT = 10

// 与云端 MANUAL_LIMITS 对齐
const TITLE_MAX = 60
const PRODUCT_MAX = 120
const AMOUNT_MAX = 100000000   // 1 亿

/**
 * 归一化单条。返回 null 表示这条不合法，调用方直接丢掉。
 *
 * @param {Object} raw
 * @returns {Object|null} { title, type, amount, product, categoryId }
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null

  const title = String(raw.title || '').trim().slice(0, TITLE_MAX)
  if (!title) return null

  const amount = Math.round(Number(raw.amount) * 100) / 100
  if (!(amount > 0) || amount > AMOUNT_MAX) return null

  return {
    title,
    type: raw.type === 'income' ? 'income' : 'expense',
    amount,
    product: String(raw.product || '').trim().slice(0, PRODUCT_MAX),
    categoryId: String(raw.categoryId || '').trim().slice(0, 40)
  }
}

/** 判重键：同名同收支算同一条 */
function keyOf(item) {
  if (!item) return ''
  return (item.type === 'income' ? 'income' : 'expense') + '|' + String(item.title || '').trim()
}

/**
 * 归一化整个列表：丢非法项、去重、截到上限。
 *
 * @param {Array} list
 * @returns {Array}
 */
function normalizeList(list) {
  const out = []
  const seen = {}

  const src = Array.isArray(list) ? list : []
  for (let i = 0; i < src.length; i++) {
    const item = normalizeItem(src[i])
    if (!item) continue
    const k = keyOf(item)
    if (seen[k]) continue
    seen[k] = true
    out.push(item)
    if (out.length >= LIMIT) break
  }
  return out
}

/**
 * 移动一项（拖动排序的唯一实现）。
 *
 * ⚠️ 越界一律夹回合法范围而不是抛错：拖动时手指划出列表外是常态，
 *    夹回来比"松手后列表没反应"更符合预期。
 *
 * @returns {Array} 新数组（不改原数组）
 */
function move(list, from, to) {
  const arr = Array.isArray(list) ? list.slice() : []
  if (arr.length < 2) return arr

  const f = Math.max(0, Math.min(arr.length - 1, Number(from)))
  const t = Math.max(0, Math.min(arr.length - 1, Number(to)))
  if (f === t || isNaN(f) || isNaN(t)) return arr

  const [item] = arr.splice(f, 1)
  arr.splice(t, 0, item)
  return arr
}

/** 删除第 index 项 */
function removeAt(list, index) {
  const arr = Array.isArray(list) ? list.slice() : []
  const i = Number(index)
  if (isNaN(i) || i < 0 || i >= arr.length) return arr
  arr.splice(i, 1)
  return arr
}

/** 是否已存在（同名同收支） */
function has(list, item) {
  const k = keyOf(item)
  if (!k) return false
  return (Array.isArray(list) ? list : []).some(x => keyOf(x) === k)
}

/**
 * 添加一条。带明确的失败原因 —— 配置页要把原因说给用户听
 * （"已经加过了"和"最多 10 个"是两句不同的话）。
 *
 * @returns {{ list: Array, ok: boolean, reason: string }}
 *   reason: '' | 'invalid' | 'duplicate' | 'full'
 */
function add(list, item) {
  const arr = Array.isArray(list) ? list : []
  const it = normalizeItem(item)
  if (!it) return { list: arr, ok: false, reason: 'invalid' }
  if (has(arr, it)) return { list: arr, ok: false, reason: 'duplicate' }
  if (arr.length >= LIMIT) return { list: arr, ok: false, reason: 'full' }
  return { list: arr.concat([it]), ok: true, reason: '' }
}

module.exports = {
  LIMIT: LIMIT,
  TITLE_MAX: TITLE_MAX,
  AMOUNT_MAX: AMOUNT_MAX,
  normalizeItem: normalizeItem,
  normalizeList: normalizeList,
  keyOf: keyOf,
  move: move,
  removeAt: removeAt,
  has: has,
  add: add
}
