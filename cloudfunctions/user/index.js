// 云函数入口文件 - 用户资料（昵称 / 主题偏好）
//
// 为什么这里「没有登录」？
//   云开发的 openid 由微信在云函数侧隐式提供（cloud.getWXContext().OPENID），
//   它由微信签名、客户端伪造不了，本身就是一套无感登录。
//   所以这个云函数不做账号密码，只做「把 user 档案和 openid 对上」这一件事。
//
// ⚠️ 集合 users 需要先在云开发控制台手动创建（云函数不会自动建集合）。
//    没建的话第一次调用会返回一条明确提示，而不是一个看不懂的 -502005。
const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command
const USERS = 'users'

// 昵称长度上下限（按 Unicode 字符数）。前端 utils/user.js 有一份同样的常量，
// tests/static-check.js 会比对两处是否同值 —— 改一处忘另一处会直接报错。
const NICK_MIN = 2
const NICK_MAX = 12

// 预算额度上限（元）。与「手动记账」的单笔金额上限同口径 —— 都是"防手滑多打几个 0"，
// 不是真的要拦住某种合法输入。前端 utils/user.js 有同样的常量，静态检查对账。
const BUDGET_MAX = 100000000
// 预算最多保留的小数位：分。多出来的位数直接拒绝而不是四舍五入 ——
// 用户输入 100.005 时看到的应该是「请检查」，不是悄悄变成 100.01。
const BUDGET_DECIMALS = 2

// 常记的（首页快捷记账面板的 chips）条数上限。
// 前端 utils/quick-picks.js 有一份同样的 LIMIT，tests/static-check.js 对账。
const QUICK_PICK_LIMIT = 10
// 单条的字段上限，与「手动记账」同一口径（防手滑，不是拦合法输入）
const QUICK_PICK_TITLE_MAX = 60
const QUICK_PICK_PRODUCT_MAX = 120
const QUICK_PICK_AMOUNT_MAX = 100000000

// 常记的来源：
//   'auto'   —— 按账单自动推荐（用户不用管，跟着消费习惯变）
//   'manual' —— 用户自己配的列表
// 用**显式字段**而不是列表存不存在来推断：后者无法表达
// 「用户主动选了推荐模式，但以前配过的列表还要留着」这种情况。
const QUICK_PICK_MODES = ['auto', 'manual']

// 换行 / 制表 / 其它控制字符：会把布局撑破，看起来还像「空白昵称」
const NICK_BAD = /[\u0000-\u001F\u007F-\u009F]/

/**
 * 主题 id 只做**格式**校验，不在这里维护白名单。
 *
 * 为什么不维护白名单？那等于在云函数里再造一份「主题清单」，以后加主题时忘了同步，
 * 新主题就永远存不进去 —— 这种「两处必须一致」的脱节正是本项目反复踩的坑。
 * 前端 utils/theme.js 的 normalize() 会把不认识的 id 安全回落到默认主题，
 * 所以服务端放宽到「小写字母开头的短字符串」即可。
 */
const THEME_RE = /^[a-z][a-z0-9]{2,15}$/

exports.main = async (event, context) => {
  try {
    const openid = cloud.getWXContext().OPENID
    if (!openid) {
      return bad('拿不到微信身份（openid），请从微信里重新打开小程序')
    }

    const action = event && event.action

    if (action === 'updateProfile') {
      return await updateProfile(openid, event)
    }

    if (action === 'setBudget') {
      return await setBudget(openid, event)
    }

    if (action === 'setQuickPicks') {
      return await setQuickPicks(openid, event)
    }

    // 不传 action 时按 getProfile 处理：启动时最常用的就是它
    return await getProfile(openid)
  } catch (err) {
    // 兜底：云函数抛异常在客户端看到的是「invoke fail」这种没有信息量的报错，
    // 统一包成结构化返回，前端才能把原因显示给用户。
    console.error('user 云函数异常:', err)
    return bad(describeError(err))
  }
}

function bad(message) {
  return { code: -1, message: message }
}

// ==================== 读取 / 创建 ====================

/**
 * 读取当前用户的档案；没有就**自动创建**一条空档案。
 *
 * 为什么自动创建：这个应用没有「注册」这一步 —— openid 就是身份。
 * 首次进入就落一条空档案，后面设昵称 / 换主题都是 UPDATE 而不是 INSERT，
 * 省掉「先判断存不存在」的分支，也避免了并发下的重复插入。
 */
async function getProfile(openid) {
  const found = await fetchOne(openid)
  if (found) return { code: 0, data: publicProfile(found) }

  const now = Date.now()
  const doc = {
    // ⚠️ 云函数写入**不会**自动注入 _openid，必须显式带上，
    //    否则这里的 where({ _openid }) 永远查不到自己刚建的档案。
    _openid: openid,
    uid: newUid(),
    nickname: '',
    theme: '',
    // 预算额度（每月支出上限）。null = 没设过 —— 界面据此显示"还没有预算"的引导，
    // 而不是显示一条 0 元的进度条（配置缺失和额度用尽是两件事）。
    budget: null,
    createdAt: now,
    updatedAt: now
  }

  try {
    await db.collection(USERS).add({ data: doc })
  } catch (err) {
    // 并发下（两个页面同时冷启动）可能已经有一条了 → 再查一次，查到就算成功
    const retry = await fetchOne(openid)
    if (retry) return { code: 0, data: publicProfile(retry) }
    throw err
  }

  return { code: 0, data: publicProfile(doc) }
}

async function fetchOne(openid) {
  const res = await db.collection(USERS).where({ _openid: openid }).limit(1).get()
  return res && res.data && res.data.length ? res.data[0] : null
}

/**
 * 只把前端用得上的字段发出去。
 * ⚠️ 不返回 _openid：它是这个账号的身份证，客户端并不需要，也没有任何理由外泄。
 *
 * budget 存成一个**内嵌对象**（而不是 users 文档下的两个散字段），
 * 这样"未设置预算"只有一种表示（budget 为 null），不用去判断 amount 缺没缺、
 * 是不是 0、updateTime 有没有——分散字段一定会有人只更新一半。
 */
function publicProfile(doc) {
  return {
    uid: doc.uid || '',
    nickname: typeof doc.nickname === 'string' ? doc.nickname : '',
    theme: typeof doc.theme === 'string' ? doc.theme : '',
    budget: readBudget(doc),
    quickPicks: readQuickPicks(doc),
    quickPicksMode: readQuickPicksMode(doc)
  }
}

/**
 * 归一化库里的「常记的」。
 *
 * ⚠️ 三态必须分清，否则"删不掉"或"删了就回不来"：
 *    - 字段**不存在**（undefined）→ 返回 null，表示「没配置过」→ 面板显示按账单自动推荐的
 *    - `[]`（空数组）→ 返回 []，表示「用户主动清空了」→ 面板就该是空的，**不能再回退到推荐**
 *      （用户费劲删完又冒出来，会以为删不掉）
 *    - 有内容 → 返回清洗后的数组
 *
 * @returns {Array|null}
 */
/**
 * 读「常记的来源」。
 *
 * ⚠️ 兼容加这个开关之前的数据：那时没有 quickPicksMode 字段，
 *    只能按列表存不存在推断 —— 有列表说明用户配过（manual），
 *    没有就还在用推荐（auto）。不加这个兼容，老用户会突然全变回推荐。
 *
 * @returns {string} 'auto' | 'manual'
 */
function readQuickPicksMode(doc) {
  const m = doc && doc.quickPicksMode
  if (m === 'auto' || m === 'manual') return m
  return Array.isArray(doc && doc.quickPicks) ? 'manual' : 'auto'
}

function readQuickPicks(doc) {
  const raw = doc && doc.quickPicks
  if (!Array.isArray(raw)) return null

  const r = normalizeQuickPicks(raw)
  return r.ok ? r.value : []
}

/**
 * 归一化库里的预算字段。
 * ⚠️ 前端拿到的 budget 要么是 { amount, updateTime }，要么是 null，不会是 undefined ——
 *    前端要靠它决定"显示进度条"还是"显示空状态"，值不稳定就会闪。
 */
function readBudget(doc) {
  const b = doc && doc.budget
  if (!b) return null

  const amount = Number(b.amount)
  if (!(amount > 0)) return null

  return {
    amount: Math.round(amount * 100) / 100,
    updateTime: Number(b.updateTime) || 0
  }
}

/**
 * 生成用户主键。
 *
 * ⚠️ 为什么不直接拿 openid 当主键？
 *    现在数据按 openid 隔离，够用。但「同一个人的第二个微信 / 另一台设备看同一份账本」
 *    这件事一旦要做，openid 就会把一个人劈成两个账号。uid 与 openid 分开存，
 *    users 表将来只需多挂一个 openids 数组即可平滑扩展，不用迁移这张表。
 *    （注意：账单表要跟着迁移 —— 那条路线见 README「登录与用户体系」。）
 */
function newUid() {
  return 'u' + crypto.randomBytes(9).toString('hex')
}

// ==================== 更新 ====================

async function updateProfile(openid, event) {
  const patch = {}

  if (event.nickname !== undefined) {
    const r = normalizeNickname(event.nickname)
    if (!r.ok) return bad(r.message)
    patch.nickname = r.value
  }

  if (event.theme !== undefined) {
    const t = String(event.theme === null || event.theme === undefined ? '' : event.theme).trim()
    // 空串是合法值：表示「清掉云端偏好」，读回来时前端会保留本机选择
    if (t && !THEME_RE.test(t)) return bad('主题参数不合法')
    patch.theme = t
  }

  if (!Object.keys(patch).length) return bad('没有要更新的内容')

  patch.updatedAt = Date.now()

  // 先确保档案存在：首次进来可能还没建过（用户直接改了主题）
  const got = await getProfile(openid)
  if (got.code !== 0) return got

  // ⚠️ 归属条件必须在。云函数以管理员身份执行、会绕过集合权限，
  //    只按 _id 更新等于把别人的账号开放了（与删除账单是同一类问题）。
  const res = await db.collection(USERS)
    .where({ _openid: openid })
    .update({ data: patch })

  if (!res || !res.stats || !res.stats.updated) {
    return bad('保存失败，请重试')
  }

  return {
    code: 0,
    data: {
      uid: got.data.uid,
      nickname: patch.nickname !== undefined ? patch.nickname : got.data.nickname,
      theme: patch.theme !== undefined ? patch.theme : got.data.theme,
      // 改昵称/主题时预算没动，但要**如实回传**：
      // 前端拿到返回体就整份写进本机缓存，少给一个字段等于顺手把预算抹掉。
      budget: got.data.budget
    }
  }
}

// ==================== 预算额度 ====================

/**
 * 设置「每月支出预算」。
 *
 * 为什么是**每月一个固定额度**、而不是每个月存一条？
 *   个人记账的使用习惯是「我每月预算 3000」，而不是「10 月 3200、11 月 2800」。
 *   按月存一条会逼用户每月 1 号重设一次，忘了就退回"没有预算"状态 ——
 *   一个需要用户每月维护的预算，本质上等于没有预算。
 *   所以这里存的是一个长期有效的额度，跨月自动延续；想改随时改。
 *
 * 送 amount = 0 / 空串 = 取消预算（把字段整个删掉，而不是留一个 0）。
 */
async function setBudget(openid, event) {
  const r = normalizeBudget(event.amount)
  if (!r.ok) return bad(r.message)

  // 先确保档案存在：用户完全可能第一次进来就直接设预算
  const got = await getProfile(openid)
  if (got.code !== 0) return got

  const now = Date.now()
  const patch = {
    // ⚠️ 取消预算要用 remove() 把字段删掉，而不是写 0/null：
    //    写 null 会让"没有这个字段"和"字段是 null"两种状态并存，
    //    以后任何一处读它的人都要多写一个判断，迟早有人漏。
    budget: r.value > 0 ? { amount: r.value, updateTime: now } : _.remove(),
    updatedAt: now
  }

  // ⚠️ 归属条件必须在。云函数以管理员身份执行、会绕过集合权限，
  //    只按 _id 更新等于把所有人的档案对外开放（与删除账单是同一类问题）。
  const res = await db.collection(USERS)
    .where({ _openid: openid })
    .update({ data: patch })

  if (!res || !res.stats || !res.stats.updated) {
    return bad('保存失败，请重试')
  }

  return {
    code: 0,
    data: {
      uid: got.data.uid,
      nickname: got.data.nickname,
      theme: got.data.theme,
      budget: r.value > 0 ? { amount: r.value, updateTime: now } : null
    }
  }
}

// ==================== 常记的（首页快捷记账 chips） ====================

/**
 * 校验并归一化「常记的」列表。
 *
 * ⚠️ 这里选择**拒绝**而不是静默丢弃非法项：
 *    静默丢弃会让"我明明配了 10 个，怎么只剩 8 个"变成无法解释的现象。
 *    前端 utils/quick-picks.js 有同一份校验，正常永远走不到这里报错。
 *
 * @returns {{ ok: boolean, value?: Array, message?: string }}
 */
function normalizeQuickPicks(raw) {
  if (!Array.isArray(raw)) return { ok: false, message: '常记的必须是数组' }
  if (raw.length > QUICK_PICK_LIMIT) {
    return { ok: false, message: '最多只能有 ' + QUICK_PICK_LIMIT + ' 个常记项' }
  }

  const out = []
  const seen = {}

  for (let i = 0; i < raw.length; i++) {
    const r = normalizeQuickPickItem(raw[i])
    if (!r.ok) return { ok: false, message: '第 ' + (i + 1) + ' 个常记项不可用：' + r.message }

    // 判重键：同名同收支算同一条（与前端 keyOf 一致）
    const k = r.value.type + '|' + r.value.title
    if (seen[k]) return { ok: false, message: '「' + r.value.title + '」重复了' }
    seen[k] = true
    out.push(r.value)
  }

  return { ok: true, value: out }
}

function normalizeQuickPickItem(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, message: '格式不正确' }

  const title = String(raw.title || '').trim()
  if (!title) return { ok: false, message: '对方名不能为空' }
  // 按 Unicode 字符数算（与昵称同一条约定：emoji 在 UTF-16 里占两个码元）
  if (Array.from(title).length > QUICK_PICK_TITLE_MAX) {
    return { ok: false, message: '对方名太长（最多 ' + QUICK_PICK_TITLE_MAX + ' 字）' }
  }

  const amount = Math.round(Number(raw.amount) * 100) / 100
  if (!(amount > 0) || amount > QUICK_PICK_AMOUNT_MAX) {
    return { ok: false, message: '金额需大于 0 且不超过 1 亿' }
  }

  return {
    ok: true,
    value: {
      title: title,
      type: raw.type === 'income' ? 'income' : 'expense',
      amount: amount,
      product: String(raw.product || '').trim().slice(0, QUICK_PICK_PRODUCT_MAX),
      categoryId: String(raw.categoryId || '').trim().slice(0, 40)
    }
  }
}

/**
 * 保存「常记的」—— **全量覆盖**语义。
 *
 * ⚠️ 为什么不是"增删单条"：这个列表要支持**拖动排序**，而排序本质上是
 *    "整个顺序都变了"，逐条增删既表达不了顺序，还会产生一堆中间态
 *    （删到一半失败 → 少了几个但顺序还是旧的）。整套替换只有一个写操作，
 *    要么全成要么全不成。
 */
async function setQuickPicks(openid, event) {
  const mode = event && event.mode
  if (mode !== undefined && QUICK_PICK_MODES.indexOf(mode) === -1) {
    return bad('常记的来源只能是 auto 或 manual')
  }

  // ⚠️ picks 是**可选**的：用户只切「用推荐 / 用手动」时不该被迫把列表也传上来。
  //    不传就保持原样 —— 这样切到推荐模式后，之前手配的列表还在，
  //    以后切回来能直接恢复，不用重新配一遍。
  const hasPicks = !!(event && event.picks !== undefined)
  let list = null
  if (hasPicks) {
    const r = normalizeQuickPicks(event.picks)
    if (!r.ok) return bad(r.message)
    list = r.value
  }

  if (mode === undefined && !hasPicks) return bad('没有要保存的内容')

  // 先确保档案存在：用户可能第一次进来就直接配常记的
  const got = await getProfile(openid)
  if (got.code !== 0) return got

  const now = Date.now()

  // ⚠️ 空数组要**真的存成 []**（而不是 remove 字段）：
  //    "用户清空了"和"从没配置过"是两种状态 —— 前者不该再回退到自动推荐，
  //    否则用户费劲删完，回首页又冒出来，只会以为删不掉。
  // ⚠️ 归属条件 _openid 必须在（云函数是管理员身份，只按 _id 更新等于开放所有人档案）
  const patch = { updatedAt: now }
  if (hasPicks) patch.quickPicks = list
  if (mode !== undefined) patch.quickPicksMode = mode

  const res = await db.collection(USERS)
    .where({ _openid: openid })
    .update({ data: patch })

  if (!res || !res.stats || !res.stats.updated) {
    return bad('保存失败，请重试')
  }

  return {
    code: 0,
    data: {
      uid: got.data.uid,
      nickname: got.data.nickname,
      theme: got.data.theme,
      budget: got.data.budget,
      // 没动的那个字段回传原值，前端 merge 才不会把它覆盖掉
      quickPicks: hasPicks ? list : got.data.quickPicks,
      quickPicksMode: mode !== undefined ? mode : got.data.quickPicksMode
    }
  }
}

/**
 * 预算金额归一化。
 *
 * 接受的写法：'3000'、'3000.5'、'3000.50'、'.5'（前端 type="digit" 的键盘
 * 允许先打小数点）、以及空串/0（= 取消预算）。
 * 拒绝：负数、0 与空串以外的非数字、超过 2 位小数、超过上限、NaN/Infinity。
 *
 * return { ok, value } —— value 为 0 表示"取消预算"
 */
function normalizeBudget(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: 0 }

  let s = String(raw).trim()
  if (s === '') return { ok: true, value: 0 }

  // 允许 ".5" 这种写法，补一个前导 0 再走下面的正则
  if (s.charAt(0) === '.') s = '0' + s

  // 负数：显式拦一次。否则 '-5' 会被下面的正则拒掉，
  // 但用户看到的提示是"格式不对"，而不是更贴切的"预算不能为负数"
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
 * 昵称归一化：去首尾空白（从别处粘贴过来常带空格）、拒控制字符、卡长度。
 *
 * ⚠️ 长度按 **Unicode 字符数**（Array.from）算，不能用 .length ——
 *    '小明'.length 是 2 没问题，但 emoji 与部分生僻字在 UTF-16 里占两个码元，
 *    用 .length 会把一个字符算成两个，明明没超长却报「最多 12 个字符」。
 */
function normalizeNickname(raw) {
  if (typeof raw !== 'string') return { ok: false, message: '昵称格式不正确' }

  const value = raw.trim()

  // 允许清空：用户在输入框里删干净再保存，语义就是「不设置昵称」
  if (value === '') return { ok: true, value: '' }

  if (NICK_BAD.test(value)) return { ok: false, message: '昵称里不能有换行或特殊字符' }

  const len = Array.from(value).length
  if (len < NICK_MIN) return { ok: false, message: '昵称至少 ' + NICK_MIN + ' 个字符' }
  if (len > NICK_MAX) return { ok: false, message: '昵称最多 ' + NICK_MAX + ' 个字符' }

  return { ok: true, value: value }
}

/**
 * 把底层报错翻译成用户能看懂的一句话。
 * 最值得提前拦的是「集合没建」：这是部署后第一次调用最常见的失败，
 * 原始报错是 -502005 database collection not exists，对用户毫无指示性。
 */
function describeError(err) {
  const code = err && (err.errCode || err.code)
  const msg = String((err && (err.errMsg || err.message)) || '')

  if (code === -502005 || msg.indexOf('collection not exists') !== -1 || msg.indexOf('集合不存在') !== -1) {
    return '数据库里还没有 users 集合，请先在云开发控制台「数据库」里新建它'
  }
  if (msg.indexOf('timeout') !== -1 || code === -504003) {
    return '请求超时，请重试'
  }
  return '操作失败：' + (msg || '未知错误')
}
