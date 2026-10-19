/**
 * 用户档案（cloudfunctions/user）离线验证
 *
 * 这个模块没有密码、没有 token，风险点集中在两处：
 *   1. **越权** —— 云函数以管理员身份执行、会绕过集合权限，
 *      update 的 where 条件如果不带 _openid，就等于把所有人的档案对外开放
 *      （和删除账单是同一类问题，见 tests/delete-test.js）
 *   2. **前后端规则脱节** —— 昵称长度前端放行、后端拒绝，
 *      用户看到的是「明明填对了却保存失败」这种没法自解释的交互
 *
 * 用 Module._load 拦截 wx-server-sdk，注入内存假数据库。
 *
 * 运行：node tests/user-test.js
 */
const Module = require('module')
const path = require('path')

const USER_FN = path.join(__dirname, '..', 'cloudfunctions/user/index.js')

let fail = 0
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

// 有几段是**故意**让云函数失败的，云函数自己会打 console.error。
// 不静音的话真正的失败会淹没在一堆堆栈里。
const realError = console.error
const muteErrors = () => { console.error = () => {} }
const unmuteErrors = () => { console.error = realError }

// ==================== 内存假库 ====================

const DB = { users: [] }
let seq = 0
let OPENID = 'me'
// 模拟「集合还没建」：这是部署后第一次调用最常见的失败
let MISSING_COLLECTION = false

function matchDoc(doc, cond) {
  return Object.keys(cond).every(k => doc[k] === cond[k])
}

function makeCollection(name) {
  const state = { cond: {}, limit: 1000 }
  const rows = () => (DB[name] = DB[name] || [])

  const api = {
    where(c) { state.cond = c || {}; return api },
    limit(n) { state.limit = n; return api },
    field() { return api },
    async get() {
      if (MISSING_COLLECTION) {
        const e = new Error('database collection not exists')
        e.errCode = -502005
        throw e
      }
      return { data: rows().filter(d => matchDoc(d, state.cond)).slice(0, state.limit) }
    },
    async add({ data }) {
      seq++
      const _id = 'doc' + seq
      rows().push(Object.assign({ _id }, data))
      return { _id }
    },
    async update({ data }) {
      let updated = 0
      rows().forEach(d => {
        if (!matchDoc(d, state.cond)) return
        Object.keys(data).forEach(k => {
          // db.command.remove() 在真实 SDK 里是"删掉这个字段"（取消预算会用到）
          if (data[k] && data[k].__remove) delete d[k]
          else d[k] = data[k]
        })
        updated++
      })
      return { stats: { updated } }
    },
    async count() {
      return { total: rows().filter(d => matchDoc(d, state.cond)).length }
    }
  }
  return api
}

const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'dyn',
  init() {},
  database() {
    return {
      collection: makeCollection,
      // user 云函数在模块顶层就取了 db.command（取消预算要用 remove()）
      command: { remove: () => ({ __remove: true }) }
    }
  },
  getWXContext() {
    return { OPENID }
  }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return cloudStub
  return origLoad.apply(this, arguments)
}

const userFn = require(USER_FN)

const getProfile = () => userFn.main({ action: 'getProfile' }, {})
const update = (patch) => userFn.main(Object.assign({ action: 'updateProfile' }, patch), {})

function reset() {
  DB.users = []
  seq = 0
  OPENID = 'me'
  MISSING_COLLECTION = false
}

// ==================== 1) 首次进入自动建档 ====================

async function testAutoCreate() {
  console.log('\n=== 1) 没有「注册」这一步：首次进入自动建档 ===')
  reset()

  let r = await getProfile()
  t(r.code === 0, `首次 getProfile → code=${r.code}`)
  t(DB.users.length === 1, `库里落下 1 条档案（实际 ${DB.users.length}）`)
  t(/^u[0-9a-f]{18}$/.test(r.data.uid), `uid 格式正确：${r.data.uid}`)
  t(r.data.nickname === '' && r.data.theme === '', '新档案的昵称与主题都是空（不是 null/undefined）')

  // 再调一次不能又建一条 —— 否则每次冷启动都往库里塞垃圾
  await getProfile()
  await getProfile()
  t(DB.users.length === 1, `再调两次仍是 1 条，没有重复建档（实际 ${DB.users.length}）`)

  // 两个不同的人各自有一份，互不可见
  OPENID = 'other'
  const r2 = await getProfile()
  t(DB.users.length === 2, '换一个 openid → 另建一份档案')
  t(r2.data.uid !== r.data.uid, '两人的 uid 不同（uid 与 openid 是分开的，为将来多端绑定留了路）')
  t(r2.data.nickname === '', '新用户看不到别人的昵称')
}

// ==================== 2) 昵称校验 ====================

async function testNickname() {
  console.log('\n=== 2) 昵称规则：2-12 个 Unicode 字符 ===')
  reset()
  await getProfile()

  // 边界：刚好 2 个 / 刚好 12 个 通过，1 个 / 13 个 拒绝
  let r = await update({ nickname: '小明' })
  t(r.code === 0 && r.data.nickname === '小明', '2 个汉字 → 通过')

  r = await update({ nickname: '一二三四五六七八九十一二' })   // 12 个
  t(r.code === 0 && Array.from(r.data.nickname).length === 12, '12 个汉字 → 通过（上限）')

  r = await update({ nickname: '甲' })
  t(r.code === -1, `1 个汉字 → 拒绝：「${r.message}」`)

  r = await update({ nickname: '一二三四五六七八九十一二三' }) // 13 个
  t(r.code === -1, `13 个汉字 → 拒绝：「${r.message}」`)
  t(DB.users[0].nickname === '一二三四五六七八九十一二', '被拒绝时库里的值没有被改动')

  // ⚠️ 长度必须按 Unicode 字符数算，不能用 .length：
  //    一个 emoji 在 UTF-16 里占两个码元，用 .length 会把 6 个 emoji 当成 12 个
  r = await update({ nickname: '👍👍' })
  t(r.code === 0, `2 个 emoji → 通过（.length 是 4，按码元算会被误判）`)

  r = await update({ nickname: '👍' })
  t(r.code === -1, '1 个 emoji → 拒绝（按码元算会被误判成 2 个而放行）')

  // 空白与首尾空格
  r = await update({ nickname: '  小明  ' })
  t(r.code === 0 && r.data.nickname === '小明', `首尾空格被吃掉 → 「${r.data.nickname}」`)

  r = await update({ nickname: '   ' })
  t(r.code === 0 && r.data.nickname === '', '纯空白 → 等于清除昵称（不当成 0 字符报错）')

  r = await update({ nickname: '小\n明' })
  t(r.code === -1, '含换行 → 拒绝（换行会把卡片布局撑破）')

  r = await update({ nickname: '小\t明' })
  t(r.code === -1, '含制表符 → 拒绝')

  r = await update({ nickname: 12345 })
  t(r.code === -1, '传非字符串 → 拒绝，不抛异常')

  // 允许主动清空
  r = await update({ nickname: '' })
  t(r.code === 0 && r.data.nickname === '', '保存空串 = 清除昵称')
}

// ==================== 3) 越权与返回体 ====================

async function testIsolation() {
  console.log('\n=== 3) 档案互不可见 + 返回体不外泄内部字段 ===')
  reset()

  OPENID = 'other'
  const otherP = await getProfile()
  await update({ nickname: '别人' })
  const otherBefore = JSON.parse(JSON.stringify(DB.users[0]))

  OPENID = 'me'
  const mine = await getProfile()

  // 直接打中「查询漏了 _openid」这种越权：
  // 如果 fetchOne 只写 .limit(1).get()，这里捞到的会是别人那条（先建的自然排在前面）
  t(mine.code === 0 && mine.data.nickname === '',
    `新用户读到的是自己的空档案，不是别人的「${mine.data.nickname}」`)
  t(mine.data.uid !== otherP.data.uid,
    '两人的 uid 不同 —— 查询确实按 _openid 收窄了，不是随便捞一条')

  let r = await update({ nickname: '本人' })
  t(r.code === 0, `当前用户可以改自己的昵称（${r.message || 'ok'}）`)

  const otherAfter = DB.users.find(d => d._openid === 'other')
  t(JSON.stringify(otherBefore) === JSON.stringify(otherAfter),
    '别人的档案一个字都没被改到（update 的 where 条件带了 _openid）')

  t(DB.users.filter(d => d._openid === 'me').length === 1, '当前用户只有一条档案')

  // 返回体只给前端要用的字段
  t(!('_openid' in r.data), '返回体里没有 _openid（它是账号身份证，客户端不需要）')
  t(!('_id' in r.data) && !('createdAt' in r.data) && !('updatedAt' in r.data),
    '返回体里没有 _id / 时间戳这些内部字段')
  t(Object.keys(r.data).sort().join(',') === 'budget,nickname,theme,uid',
    `返回体字段恰好是 uid/nickname/theme/budget（实际 ${Object.keys(r.data).sort().join(',')}）`)

  // 拿不到 openid 时必须明确失败，不能默默建一条没主的档案
  OPENID = ''
  r = await getProfile()
  t(r.code === -1 && DB.users.length === 2, `拿不到 openid → code=-1 且不写库（${r.message}）`)
  OPENID = 'me'
}

// ==================== 4) 主题偏好 ====================

async function testTheme() {
  console.log('\n=== 4) 主题偏好：只校验格式，不在这里维护白名单 ===')
  reset()
  await getProfile()

  for (const id of ['green', 'blue', 'violet', 'orange', 'rose']) {
    const r = await update({ theme: id })
    if (r.code !== 0) t(false, `主题 ${id} 应该被接受，却被拒：${r.message}`)
  }
  t(DB.users[0].theme, '五套现有主题 id 全部被接受')

  let r = await update({ theme: 'GREEN' })
  t(r.code === -1, '大写主题名 → 拒绝')
  r = await update({ theme: 'gr' })
  t(r.code === -1, '过短的 id → 拒绝（防止往库里塞垃圾）')
  r = await update({ theme: '../../etc/passwd' })
  t(r.code === -1, '带路径分隔符的字符串 → 拒绝')
  r = await update({ theme: 'x'.repeat(17) })
  t(r.code === -1, '超长 id（17 位）→ 拒绝')

  r = await update({ theme: 'green' })
  t(r.code === 0 && r.data.theme === 'green', '合法主题写入成功')

  r = await update({ theme: '' })
  t(r.code === 0 && r.data.theme === '', '空串 = 清除云端偏好（前端会保留本机选择）')

  // 只改主题不能把昵称冲掉
  await update({ nickname: '小明' })
  r = await update({ theme: 'blue' })
  t(r.code === 0 && r.data.nickname === '小明', '只改主题时昵称保持不变（不会被覆盖成空）')

  r = await update({})
  t(r.code === -1, `什么都不传 → 拒绝：「${r.message}」`)
}

// ==================== 5) 失败路径要说人话 ====================

async function testErrors() {
  console.log('\n=== 5) 失败要给出可操作的提示 ===')
  reset()
  MISSING_COLLECTION = true

  muteErrors()
  const r = await getProfile()
  unmuteErrors()

  t(r.code === -1, 'users 集合没建 → 结构化返回而不是抛异常')
  t(r.message.indexOf('users') !== -1 && r.message.indexOf('新建') !== -1,
    `提示指向具体动作：「${r.message}」`)

  MISSING_COLLECTION = false
  const r2 = await getProfile()
  t(r2.code === 0, '建好集合后立刻恢复正常')
}

// ==================== 6) 前端 utils/user.js ====================

const USER_UTIL = path.join(__dirname, '..', 'utils', 'user.js')

let STORE = {}
let CLOUD_REPLY = null

global.wx = {
  getStorageSync(k) { return STORE[k] === undefined ? '' : STORE[k] },
  setStorageSync(k, v) { STORE[k] = v },
  setTabBarStyle() {},
  setTabBarItem() {},
  setNavigationBarColor() {},
  setBackgroundColor() {},
  cloud: {
    callFunction() {
      if (CLOUD_REPLY === 'fail') return Promise.reject(new Error('stub: 云函数不可用'))
      return Promise.resolve({ result: CLOUD_REPLY || { code: -1, message: 'stub' } })
    }
  }
}

/** utils/user.js 在模块里缓存了当前档案，测不同场景要重新加载一次才干净 */
function freshUserUtil() {
  delete require.cache[require.resolve(USER_UTIL)]
  return require(USER_UTIL)
}

async function testFrontendModule() {
  console.log('\n=== 6) 前端 utils/user.js：校验与云端偏好回落 ===')

  // --- 昵称校验：常量由 static-check 守，这里守**行为** ---
  let u = freshUserUtil()
  const cases = [
    ['小明', true],
    ['一二三四五六七八九十一二', true],
    ['甲', false],
    ['一二三四五六七八九十一二三', false],
    ['👍👍', true],
    ['👍', false],
    ['  小明  ', true],
    ['', true],
    ['   ', true],
    ['小\n明', false]
  ]
  let bad = 0
  cases.forEach(([input, expect]) => {
    if (u.validateNickname(input).ok !== expect) {
      bad++
      t(false, `validateNickname(${JSON.stringify(input)}) 期望 ${expect}`)
    }
  })
  if (!bad) t(true, `${cases.length} 个昵称用例与云函数规则一致（含 emoji 与首尾空白）`)

  t(u.nickLength('👍👍') === 2, `nickLength 把 emoji 算 1 个字符（得到 ${u.nickLength('👍👍')}）`)
  t(u.nickLength('  小明  ') === 2, 'nickLength 先 trim 再数，不会把空格算进去')

  // --- 云端主题偏好回落 ---
  const themeUtil = require(path.join(__dirname, '..', 'utils', 'theme.js'))
  const T_KEY = themeUtil.STORAGE_KEY

  const setup = (cloudTheme, localTheme) => {
    STORE = {}
    STORE[u.STORAGE_KEY] = { uid: 'u1', nickname: '小明', theme: cloudTheme }
    STORE[T_KEY] = localTheme
    return freshUserUtil()
  }

  let m = setup('blue', 'green')
  m.current()                                     // 先把本机缓存读进来
  t(m.adoptRemoteTheme() === true, '云端是 blue、本机是 green → 采纳云端')
  t(STORE[T_KEY] === 'blue', `本机主题被改写成 blue（实际 ${STORE[T_KEY]}）`)

  m = setup('green', 'green')
  m.current()
  t(m.adoptRemoteTheme() === false, '云端与本机相同 → 不做无谓的写入')

  m = setup('', 'violet')
  m.current()
  t(m.adoptRemoteTheme() === false && STORE[T_KEY] === 'violet',
    '云端为空（用户没设过）→ 尊重本机选择，不把用户改成默认绿')

  m = setup('neon', 'violet')
  m.current()
  t(m.adoptRemoteTheme() === false && STORE[T_KEY] === 'violet',
    '云端是一个本机不认识的主题 id → 保留本机选择（否则用户会被"越登录越退步"）')

  // --- 云函数不可用时的降级 ---
  m = setup('blue', 'green')
  m.current()
  CLOUD_REPLY = 'fail'
  muteErrors()
  let threw = false
  let got = null
  try { got = await m.load(true) } catch (e) { threw = true }
  unmuteErrors()

  t(!threw, '云函数不可用时 load() 不抛错（抛了会把页面卡在加载态）')
  t(got && got.nickname === '小明', '降级到本机缓存，昵称照常显示')

  // --- 正常路径要回写缓存 ---
  CLOUD_REPLY = { code: 0, data: { uid: 'u9', nickname: '小红', theme: 'rose' } }
  const p = await m.load(true)
  t(p.nickname === '小红' && p.uid === 'u9', '云函数成功时用云端值覆盖本机缓存')
  t(STORE[u.STORAGE_KEY].nickname === '小红', '新值确实落到了本机存储')

  // --- 只有真的要写的时候才写 ---
  STORE = {}
  CLOUD_REPLY = { code: 0, data: { uid: 'u1', nickname: '小明', theme: 'green' } }
  m = freshUserUtil()
  await m.load(true)
  t(m.nickname() === '小明', '从空存储冷启动也能拿到昵称')

  // --- 问候语：时段边界 + 昵称空时不留悬挂逗号 ---
  const greet = require(path.join(__dirname, '..', 'utils', 'greeting.js'))

  const bands = [
    [5, '早上好'], [10, '早上好'],
    [11, '中午好'], [12, '中午好'],
    [13, '下午好'], [17, '下午好'],
    [18, '晚上好'], [22, '晚上好'],
    [23, '夜深了'], [0, '夜深了'], [4, '夜深了']
  ]
  let wrong = []
  bands.forEach(([h, expect]) => {
    const got = greet.wordOf(h)
    if (got !== expect) wrong.push(`${h} 点 → ${got}（期望 ${expect}）`)
  })
  t(wrong.length === 0, wrong.length ? `时段分档有误：${wrong.join('；')}` : `${bands.length} 个整点的时段分档全部正确（23~5 点是「夜深了」）`)

  t(greet.build(9, '小明') === '早上好，小明', `有昵称：${greet.build(9, '小明')}`)
  t(greet.build(9, '') === '早上好', `昵称为空时不留悬挂逗号：${greet.build(9, '')}`)
  t(greet.build(9, null) === '早上好' && greet.build(9, undefined) === '早上好',
    '昵称是 null / undefined 也不会拼出逗号或 "undefined"')
  t(greet.build(9, '   ') === '早上好', '昵称是纯空格 → 等同于没设置')
  t(greet.build(9, 12345) === '早上好，12345', '昵称不是字符串时不会抛异常（钉死字符串拼接行为）')
  t(greet.build(3, '小明') === '夜深了，小明', '凌晨 3 点也照常带昵称')
}

// ==================== 跑 ====================

;(async () => {
  await testAutoCreate()
  await testNickname()
  await testIsolation()
  await testTheme()
  await testErrors()
  await testFrontendModule()

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`)
  process.exit(fail === 0 ? 0 : 1)
})()
