/**
 * VIP 会员（cloudfunctions/user + utils/user.js）离线验证
 *
 * 风险点集中在三处：
 *   1. **激活不能信客户端** —— 真实支付上线后激活只能来自支付回调。
 *      sandbox 阶段允许前端直调，但只要 VIP_PAY_MODE 不是 sandbox，
 *      activateVip 必须拒绝（否则谁都能白嫖会员）。
 *   2. **幂等** —— 重复激活不能把 since 冲掉（会员"开通时间"会变来变去）。
 *   3. **档案合并不能丢字段** —— 改昵称/主题时 vip 必须如实回传，
 *      否则「开完会员改个昵称，本机的会员标识被抹掉」，表现为"会员突然失效"。
 *
 * 运行：node tests/vip-test.js
 */
const Module = require('module')
const path = require('path')

const USER_FN = path.join(__dirname, '..', 'cloudfunctions/user/index.js')

let fail = 0
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

const realError = console.error
const muteErrors = () => { console.error = () => {} }
const unmuteErrors = () => { console.error = realError }

// ==================== 内存假库 ====================

const DB = { users: [] }
let seq = 0
let OPENID = 'me'

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
      command: { remove: { __remove: true } }
    }
  },
  getWXContext() { return { OPENID: OPENID } }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return cloudStub
  return origLoad.apply(this, arguments)
}

const userFn = require(USER_FN)
Module._load = origLoad

// ==================== utils/user.js 的 wx 桩 ====================

// 用独立命名空间，别污染云函数那套假库
function makeWxStub() {
  const mem = {}
  const calls = []
  return {
    mem: mem,
    calls: calls,
    getStorageSync(k) { return mem[k] },
    setStorageSync(k, v) { mem[k] = v },
    cloud: {
      callFunction(opts) {
        calls.push(opts)
        // 把请求转给云函数桩（同一份假库 → 链路贯通）
        return userFn.main(opts.data).then(r => ({ result: r }))
      }
    }
  }
}

function freshUserUtil() {
  const stub = makeWxStub()
  global.wx = stub
  delete require.cache[path.join(__dirname, '..', 'utils/user.js')]
  delete require.cache[path.join(__dirname, '..', 'utils/theme.js')]
  const u = require(path.join(__dirname, '..', 'utils/user.js'))
  return { u: u, stub: stub }
}

function resetDb() {
  DB.users.length = 0
  seq = 0
}

;(async () => {
  console.log('\n=== 1) 普通用户档案：vip 必须是 null（不是 undefined / 0）===')
  resetDb()
  {
    const r = await userFn.main({ action: 'getProfile' })
    t(r.code === 0, '建档成功')
    t(r.data.vip === null, 'vip = null（前端据此显示"未开通"，undefined 会让界面闪）')
    t(r.data.budget === null, 'budget = null（同一条约定）')
  }

  console.log('\n=== 2) createVipOrder（沙箱模式）===')
  resetDb()
  {
    const r = await userFn.main({ action: 'createVipOrder' })
    t(r.code === 0, '下单信息返回成功')
    t(r.data.mode === 'sandbox', '当前是沙箱模式（商户号未接入）')
    t(r.data.order && r.data.order.priceFen === 1800, '价格 1800 分 = ¥18（服务端说了算，不是前端写死）')
    t(r.data.alreadyVip === false, '普通用户 alreadyVip = false')

    // 已是会员时不再下单
    await userFn.main({ action: 'activateVip' })
    const r2 = await userFn.main({ action: 'createVipOrder' })
    t(r2.data.alreadyVip === true, '会员再来下单 → alreadyVip = true（永久会员没有续费）')
    t(!r2.data.order, '已开通时不返回订单（防止误显示价格按钮）')
  }

  console.log('\n=== 3) activateVip：激活 / 幂等 / 归属 ===')
  resetDb()
  {
    const r = await userFn.main({ action: 'activateVip' })
    t(r.code === 0, '激活成功')
    t(r.data.vip && r.data.vip.since > 0, '返回 vip.since 时间戳')

    const since1 = r.data.vip.since
    const r2 = await userFn.main({ action: 'activateVip' })
    t(r2.code === 0, '重复激活不报错（幂等）')
    t(r2.data.vip.since === since1, '重复激活不冲掉第一次的 since（开通时间稳定）')

    // 越权：换一个人激活，不能动到 me 的档案
    const before = DB.users.find(d => d._openid === 'me').vip.since
    OPENID = 'someone-else'
    await userFn.main({ action: 'activateVip' })
    OPENID = 'me'
    t(DB.users.find(d => d._openid === 'me').vip.since === before,
      '他人激活只写他人档案（where 带 _openid，云函数绕过权限必须自己拦）')
  }

  console.log('\n=== 4) 非 sandbox 模式必须拒绝客户端直接激活 ===')
  {
    // 临时把模式改成 wxpay，验证 activateVip 拒绝 —— 这是防白嫖的关键闸门
    const fs = require('fs')
    const src = fs.readFileSync(USER_FN, 'utf8')
    const patched = src.replace("const VIP_PAY_MODE = 'sandbox'", "const VIP_PAY_MODE = 'wxpay'")
    t(patched !== src, '能定位到 VIP_PAY_MODE 常量')

    // 写临时副本加载。⚠️ 必须在 wx-server-sdk 拦截**仍生效**时 require ——
    // 临时副本也要 require wx-server-sdk，还原后 require 会直接炸
    const tmp = USER_FN.replace('index.js', 'index.__viptest.js')
    fs.writeFileSync(tmp, patched)
    Module._load = function (request) {
      if (request === 'wx-server-sdk') return cloudStub
      return origLoad.apply(this, arguments)
    }
    delete require.cache[tmp]
    muteErrors()
    let patchedFn
    try {
      patchedFn = require(tmp)
    } finally {
      Module._load = origLoad
      unmuteErrors()
    }
    const r = await patchedFn.main({ action: 'activateVip' })
    t(r.code !== 0, 'wxpay 模式下客户端直调激活被拒绝（激活只能来自支付回调）')

    fs.unlinkSync(tmp)
    delete require.cache[tmp]
  }

  console.log('\n=== 5) updateProfile / setBudget 回传 vip（防抹掉）===')
  resetDb()
  {
    await userFn.main({ action: 'activateVip' })
    const r = await userFn.main({ action: 'updateProfile', nickname: '小明' })
    t(r.code === 0 && r.data.vip && r.data.vip.since > 0,
      '改昵称后 vip 仍如实回传（少一个字段 = 开完会员改个资料会员就"失效"）')

    const r2 = await userFn.main({ action: 'setBudget', amount: '3000' })
    t(r2.code === 0 && r2.data.vip && r2.data.vip.since > 0,
      '设预算后 vip 仍如实回传')
  }

  console.log('\n=== 6) 前端 utils/user.js：isVip / merge 不丢字段 ===')
  resetDb()
  {
    const { u } = freshUserUtil()

    t(u.isVip() === false, '默认不是会员')
    t(u.vipSince() === 0, 'vipSince = 0')

    // 走真实链路：激活 → 本机缓存应有会员标识
    await u.activateVip()
    t(u.isVip() === true, 'activateVip 后 isVip = true')
    t(u.vipSince() > 0, 'vipSince = 激活时间')

    // 改昵称后会员标识必须还在（merge 部分字段）
    await u.setNickname('阿明')
    t(u.isVip() === true, '改昵称后会员标识还在（merge 不抹掉没动的字段）')

    // 设预算后同样还在
    await u.setBudget('2000')
    t(u.isVip() === true && u.budget() === 2000, '设预算后 vip 与 budget 并存')

    // 会员时间戳持久化到 storage
    const saved = global.wx.getStorageSync(u.STORAGE_KEY)
    t(saved && saved.vipSince > 0, 'vipSince 写进了本机缓存（首帧同步可用）')
  }

  console.log('\n=== 7) getStatistics 的云端门控（静态对账）===')
  {
    const fs = require('fs')
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'cloudfunctions/getStatistics/index.js'), 'utf8')

    t(/action === 'insight'[\s\S]{0,400}fetchVipFlag/.test(src),
      'insight action 里调用了 fetchVipFlag（权限必须在云端判）')
    t(src.indexOf("code: -2") !== -1 && src.indexOf('needVip: true') !== -1,
      '拒绝时返回 code:-2 + needVip（前端据此引导开通，不当网络失败处理）')
    t(src.indexOf("doc.vip && Number(doc.vip.since) > 0") !== -1,
      '会员判定口径与 user 云函数一致（vip.since > 0）')
  }

  console.log('\n=== 8) 脏输入 ===')
  resetDb()
  {
    // 档案里 vip 字段被人手动改坏（控制台改库是会发生的）
    DB.users.push({
      _id: 'bad1', _openid: 'me', uid: 'u1', nickname: '', theme: '',
      budget: null, vip: { since: 'abc' }        // 非数字
    })
    const r = await userFn.main({ action: 'getProfile' })
    t(r.code === 0 && r.data.vip === null, 'vip.since 是脏字符串 → 归一化成 null（不当会员）')

    resetDb()
    DB.users.push({
      _id: 'bad2', _openid: 'me', uid: 'u1', nickname: '', theme: '',
      budget: null, vip: true                      // 布尔（没有 since）
    })
    const r2 = await userFn.main({ action: 'getProfile' })
    t(r2.code === 0 && r2.data.vip === null, 'vip = true（没有 since）→ null')
  }

  console.log('')
  if (fail) {
    console.log('❌ ' + fail + ' 项失败')
    process.exit(1)
  } else {
    console.log('✅ 全部通过')
  }
})().catch(err => {
  console.error(err)
  process.exit(1)
})
