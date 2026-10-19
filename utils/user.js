/**
 * 用户档案（昵称 / 主题偏好）
 * ---------------------------------------------------------------------------
 * 和 theme.js 一样是「模块 + 本机缓存」的形态，理由也一样：
 *   页面的**第一帧**必须同步拿到值，而云函数是异步的。
 *   如果只在云端存、页面 onShow 时 await 一次，用户会看到昵称「先空一下再出现」。
 *
 * 两层结构：
 *   本机缓存（wx.storage）—— 同步读，负责首帧；也负责云函数不可用时的降级
 *   云端 users 集合      —— 权威值，登录后以它为准
 *
 * ⚠️ 任何云端失败都不向外抛：拉不到昵称、同步不上主题，都不该把页面卡住或者
 *    弹一个用户看不懂的错误。只有「用户主动点保存」才把错误抛给调用方去提示。
 *
 * 关于「没有登录」：身份来自云开发隐式提供的 openid，见 cloudfunctions/user/index.js
 * 顶部说明。前端不需要、也不应该存储任何密码或 token。
 */
const theme = require('./theme.js')

// 本机缓存键（改键名会让老用户的本机昵称丢失，非必要不要动）
const STORAGE_KEY = 'app_user_profile'

// 昵称长度上下限 —— 必须与 cloudfunctions/user/index.js 保持一致，
// tests/static-check.js 会比对两处是否同值（前端这份只是为了即时反馈，
// 真正说了算的永远是服务端）。
const NICK_MIN = 2
const NICK_MAX = 12

// 每月支出预算的上限与小数位 —— 同样与云函数保持一致，静态检查对账。
// 前端这份只负责"输入时就拦住明显写错的"，服务端那才是最终裁判。
const BUDGET_MAX = 100000000
const BUDGET_DECIMALS = 2

// 本机缓存结构是**扁平**的，不嵌套：
// budget 就是一个数字，0 表示「没设过」。
// ⚠️ 嵌套对象（{budget:{amount}}）看着更整齐，但"只改一个子字段"时
//    必须区分「这次没传」和「这次传了 null」，稍有不慎就会把没动过的字段清零。
//    扁平结构下 undefined 天然表示"没传"，判断只有一处。
const EMPTY = { uid: '', nickname: '', theme: '', budget: 0, budgetTime: 0, vipSince: 0, quickPicks: null }

// 本机缓存（进程内），避免每次读 storage
let cached = null

// 正在进行中的 load()，用于去重：
// app.js 的 onLaunch 和首页的 onShow 会几乎同时触发，不该发两次请求。
let inflight = null

function str(v, fallback) {
  return typeof v === 'string' ? v : fallback
}

function readStorage() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY)
    if (raw && typeof raw === 'object') {
      const budget = Number(raw.budget)
      const hasBudget = isFinite(budget) && budget > 0
      return {
        uid: str(raw.uid, ''),
        nickname: str(raw.nickname, ''),
        theme: str(raw.theme, ''),
        budget: hasBudget ? Math.round(budget * 100) / 100 : 0,
        budgetTime: hasBudget ? (Number(raw.budgetTime) || 0) : 0,
        vipSince: Number(raw.vipSince) > 0 ? Number(raw.vipSince) : 0,
        // null = 没配置过「常记的」；数组（含空数组）= 配置过
        quickPicks: Array.isArray(raw.quickPicks) ? raw.quickPicks : null
      }
    }
  } catch (e) {
    // 存储不可用（极少见）→ 当作空档案，页面照常渲染
  }
  return Object.assign({}, EMPTY)
}

function writeStorage(p) {
  cached = p
  try {
    wx.setStorageSync(STORAGE_KEY, cached)
  } catch (e) {
    // 存储失败不阻塞：本次会话照常可用，只是下次启动要重新拉一次
  }
  return cached
}

/**
 * 把一份**部分字段**的档案合进本机缓存。云函数那几种返回体都走这里。
 *
 * ⚠️ 为什么必须做合并，而不是让每个调用点自己拼一个完整对象？
 *    早期写法就是后者：setNickname / syncTheme 各自 new 一个字面量对象。
 *    结果是每加一个字段都得去每个调用点补一遍，漏一处就变成
 *    「改个主题顺手把昵称/预算弄丢了」—— 这种 bug 用户根本不会来描述，
 *    只会觉得"我的设置老是自己变"。
 *    现在缺字段一律按"这次没动"处理，加字段只需改这一个函数。
 *
 * @param {object} partial 云端返回的档案片段
 */
function merge(partial) {
  const cur = current()
  const p = partial || {}

  let budget = cur.budget
  let budgetTime = cur.budgetTime

  // 云端对预算的约定（三态，缺一不可）：
  //   undefined       —— 这次没动预算，保留本机值
  //   null            —— 用户取消了预算，本机也要跟着清掉
  //   {amount,update} —— 已设置
  if (p.budget !== undefined) {
    if (p.budget === null) {
      budget = 0
      budgetTime = 0
    } else {
      const amt = Number(p.budget.amount)
      budget = isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : 0
      budgetTime = budget > 0 ? (Number(p.budget.updateTime) || 0) : 0
    }
  }

  // vip 的三态与 budget 一致：
  //   undefined —— 这次没动，保留本机值
  //   null      —— 不是会员（清掉本机标识）
  //   {since}   —— 已开通（永久会员，只记激活时间）
  let vipSince = cur.vipSince
  if (p.vip !== undefined) {
    const since = p.vip && Number(p.vip.since)
    vipSince = since > 0 ? since : 0
  }

  // 「常记的」三态：
  //   undefined —— 这次没动，保留本机值
  //   null      —— 服务端说"从没配置过" → 本机也存 null（回首页会按账单推荐）
  //   []/数组   —— 配置过。⚠️ 空数组要**原样保留**：它表示"用户主动清空了"，
  //                不能塌缩成 null，否则用户删完 chips 又会看到推荐项冒出来
  let quickPicks = cur.quickPicks
  if (p.quickPicks !== undefined) {
    quickPicks = Array.isArray(p.quickPicks) ? p.quickPicks : null
  }

  return writeStorage({
    uid: str(p.uid, cur.uid),
    nickname: str(p.nickname, cur.nickname),
    theme: str(p.theme, cur.theme),
    budget: budget,
    budgetTime: budgetTime,
    vipSince: vipSince,
    quickPicks: quickPicks
  })
}

/** 当前档案（同步，读本机缓存）。首帧就该用这个。 */
function current() {
  if (!cached) cached = readStorage()
  return cached
}

/** 当前昵称（没设置时是空串 —— 调用方必须处理这个情况，别拼出「早上好，」） */
function nickname() {
  return current().nickname
}

/**
 * 从云端拉一次档案并回写本机缓存。
 * 永远 resolve（失败时返回本机缓存），所以调用方不需要 try/catch。
 * @param {boolean} force 忽略进行中的请求，强制重发
 */
function load(force) {
  if (inflight && !force) return inflight

  inflight = wx.cloud.callFunction({
    name: 'user',
    data: { action: 'getProfile' }
  }).then(res => {
    const r = (res && res.result) || {}
    if (r.code !== 0 || !r.data) throw new Error(r.message || '读取用户资料失败')
    return merge(r.data)
  }).catch(err => {
    // 降级：云函数没部署 / 没网 / users 集合没建，都不该拦住页面
    console.error('读取用户资料失败，使用本机缓存:', err)
    return current()
  }).then(p => {
    inflight = null
    return p
  })

  return inflight
}

/** 校验昵称。规则与云函数一致；返回 { ok, value } 或 { ok:false, message } */
function validateNickname(raw) {
  if (typeof raw !== 'string') return { ok: false, message: '昵称格式不正确' }

  const value = raw.trim()
  if (value === '') return { ok: true, value: '' }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) {
    return { ok: false, message: '昵称里不能有换行或特殊字符' }
  }

  // 与云函数一致：按 Unicode 字符数算，emoji 算 1 个（见云函数里的说明）
  const len = Array.from(value).length
  if (len < NICK_MIN) return { ok: false, message: '昵称至少 ' + NICK_MIN + ' 个字符' }
  if (len > NICK_MAX) return { ok: false, message: '昵称最多 ' + NICK_MAX + ' 个字符' }

  return { ok: true, value: value }
}

/** 昵称的真实长度（用于「3/12」这种计数显示） */
function nickLength(raw) {
  return Array.from(String(raw === null || raw === undefined ? '' : raw).trim()).length
}

/**
 * 保存昵称。**会抛**错误 —— 这是用户主动点的保存，失败了必须让他知道。
 * @returns {Promise<object>} 更新后的档案
 */
function setNickname(raw) {
  const v = validateNickname(raw)
  if (!v.ok) return Promise.reject(new Error(v.message))

  return wx.cloud.callFunction({
    name: 'user',
    data: { action: 'updateProfile', nickname: v.value }
  }).then(res => {
    const r = (res && res.result) || {}
    if (r.code !== 0 || !r.data) throw new Error(r.message || '保存失败，请重试')
    return merge(r.data)
  })
}

// ==================== 每月预算 ====================

/** 每月支出预算（元）。**0 = 没设过** —— 页面据此显示"还没设置预算"的引导 */
function budget() {
  return current().budget
}

/** 预算额度最后一次修改的时间戳（0 = 没设过） */
function budgetTime() {
  return current().budgetTime
}

/**
 * 预算金额校验。规则与 cloudfunctions/user/index.js 的 normalizeBudget 一致
 * （常量由 tests/static-check.js 对账）。**这里只是即时反馈，说了算的永远是云函数。**
 * @returns {{ok:boolean, value?:number, message?:string}} value=0 表示取消预算
 */
function validateBudget(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: 0 }

  let s = String(raw).trim()
  if (s === '') return { ok: true, value: 0 }

  if (s.charAt(0) === '.') s = '0' + s
  if (s.charAt(0) === '-') return { ok: false, message: '预算不能为负数' }

  const re = new RegExp('^\\d+(\\.\\d{1,' + BUDGET_DECIMALS + '})?$')
  if (!re.test(s)) {
    return { ok: false, message: '预算最多保留 ' + BUDGET_DECIMALS + ' 位小数' }
  }

  const n = Number(s)
  if (!isFinite(n)) return { ok: false, message: '预算金额无法识别' }
  if (n === 0) return { ok: true, value: 0 }
  if (n > BUDGET_MAX) return { ok: false, message: '预算金额过大，请检查是否输错' }

  return { ok: true, value: Math.round(n * 100) / 100 }
}

/**
 * 保存每月预算。**会抛**错误 —— 用户主动点的保存，失败了必须让他知道。
 * 传 0 / 空串 = 取消预算。
 * @returns {Promise<object>} 更新后的档案
 */
function setBudget(raw) {
  const v = validateBudget(raw)
  if (!v.ok) return Promise.reject(new Error(v.message))

  return wx.cloud.callFunction({
    name: 'user',
    data: { action: 'setBudget', amount: v.value }
  }).then(res => {
    const r = (res && res.result) || {}
    if (r.code !== 0 || !r.data) throw new Error(r.message || '保存失败，请重试')
    return merge(r.data)
  })
}

// ==================== VIP 会员 ====================

/** 是否会员。**0 = 不是会员**，>0 = 激活时间戳（永久有效，永不过期） */
function isVip() {
  return current().vipSince > 0
}

/** 会员激活时间戳（0 = 不是会员） */
function vipSince() {
  return current().vipSince
}

/**
 * 开通会员（走云函数的 sandbox 模拟支付）。
 * ⚠️ **会抛**错误 —— 用户主动点的开通，失败了必须让他知道。
 * 真实支付接入后，这里改为「统一下单 → wx.requestPayment → 回调激活」，
 * activateVip 将只被支付回调调用、不再由前端直接调。
 * @returns {Promise<object>} 更新后的档案
 */
function activateVip() {
  return wx.cloud.callFunction({
    name: 'user',
    data: { action: 'activateVip' }
  }).then(res => {
    const r = (res && res.result) || {}
    if (r.code !== 0 || !r.data) throw new Error(r.message || '开通失败，请重试')
    return merge(r.data)
  })
}

/**
 * 询问下单信息（会员中心页展示价格用）。
 * 已是会员时返回 { alreadyVip: true }。失败**会抛**。
 */
function createVipOrder() {
  return wx.cloud.callFunction({
    name: 'user',
    data: { action: 'createVipOrder' }
  }).then(res => {
    const r = (res && res.result) || {}
    if (r.code !== 0 || !r.data) throw new Error(r.message || '获取订单信息失败')
    return r.data
  })
}

/**
 * 把主题偏好推到云端，让它跟着账号走（换手机、换设备也是同一套配色）。
 *
 * 失败**不抛**：主题在本机已经生效了，同步不上只是「下次换设备看不到这个偏好」，
 * 不值得弹错误打断用户。
 * @returns {Promise<boolean>} 是否同步成功
 */
function syncTheme(id) {
  return wx.cloud.callFunction({
    name: 'user',
    data: { action: 'updateProfile', theme: String(id === null || id === undefined ? '' : id) }
  }).then(res => {
    const r = (res && res.result) || {}
    if (r.code !== 0) return false
    // 只更新 theme 字段 —— merge() 会把没提到的字段（昵称/预算）原样保留
    merge({ theme: r.data.theme })
    return true
  }).catch(err => {
    console.error('主题偏好同步失败（不影响本机使用）:', err)
    return false
  })
}

/**
 * 登录后把**云端**的主题偏好落到本机并立即生效。
 *
 * 只处理「云端有值 + 与本机不同 + 本机认识这个 id」三种情况同时成立：
 *   · 云端为空 —— 用户没设过，尊重本机选择
 *   · id 本机不认识 —— 可能是本机版本旧了，采纳会把用户降级成默认色，
 *     宁可保留本机选择，也不要「越登录越退步」
 *
 * @returns {boolean} 是否发生了变更
 */
function adoptRemoteTheme() {
  const remote = current().theme
  if (!remote) return false
  if (remote === theme.currentId()) return false
  if (theme.normalize(remote) !== remote) return false

  theme.setCurrent(remote)
  return true
}

// ==================== 常记的（首页快捷记账 chips） ====================

/**
 * 用户手动配置的「常记的」。
 *
 * @returns {Array|null} null = **从没配置过**（首页会按账单自动推荐）；
 *                       数组（含空数组）= 配置过（空数组表示用户主动清空了）
 */
function quickPicks() {
  const v = current().quickPicks
  return Array.isArray(v) ? v : null
}

/**
 * 保存「常记的」（整套覆盖 —— 排序/增删都走这里）。
 *
 * ⚠️ 与 setNickname 一样：**说了算的是云函数**，本机只是镜像。
 *    传空数组是合法操作（表示清空），不会被当成"没配置"。
 *
 * @param {Array} list
 * @returns {Promise<Array>} 云端归一化后的列表
 */
function setQuickPicks(list) {
  const arr = Array.isArray(list) ? list : []

  return wx.cloud.callFunction({
    name: 'user',
    data: { action: 'setQuickPicks', picks: arr }
  }).then(res => {
    const r = (res && res.result) || {}
    if (r.code !== 0 || !r.data) throw new Error(r.message || '保存失败，请重试')
    // merge 会处理三态：这里传的是数组（含空数组），所以本机会原样记下
    merge({ quickPicks: r.data.quickPicks })
    return r.data.quickPicks || []
  })
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  NICK_MIN: NICK_MIN,
  NICK_MAX: NICK_MAX,
  current: current,
  nickname: nickname,
  load: load,
  validateNickname: validateNickname,
  nickLength: nickLength,
  setNickname: setNickname,
  syncTheme: syncTheme,
  adoptRemoteTheme: adoptRemoteTheme,
  budget: budget,
  budgetTime: budgetTime,
  quickPicks: quickPicks,
  setQuickPicks: setQuickPicks,
  validateBudget: validateBudget,
  setBudget: setBudget,
  isVip: isVip,
  vipSince: vipSince,
  activateVip: activateVip,
  createVipOrder: createVipOrder
}
