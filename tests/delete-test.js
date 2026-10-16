/**
 * 删除账单（parseCSV action='delete'）离线验证
 *
 * 删除是**唯一一个能让用户数据永久消失**的动作，所以这里重点不是"能删掉"，
 * 而是"不能误删"：
 *   - 别人的记录 id 递进来必须删不掉（云函数以管理员身份执行，会绕过集合权限，
 *     只按 _id 删就等于把别人的账本开放了）
 *   - 重复 id / 空 id / 不存在的 id 都要稳定收场，不能抛异常、不能多删
 *   - 删完要能被 getStatistics 立刻反映出来（首页/账单页的数字不能对不上）
 *
 * 用 Module._load 拦截 wx-server-sdk / xlsx，注入内存假数据库。
 *
 * 运行：node tests/delete-test.js
 */
const Module = require('module')
const path = require('path')

const PARSE_FN = path.join(__dirname, '..', 'cloudfunctions/parseCSV/index.js')
const STATS_FN = path.join(__dirname, '..', 'cloudfunctions/getStatistics/index.js')

const BJ = 8 * 60 * 60 * 1000

let fail = 0
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

// ==================== 内存假库 ====================

let DOCS = []
let seq = 0

function cond(op, value) {
  const c = { __cond: true, op, value }
  c.and = function (other) {
    return { __cond: true, op: 'and', parts: [c, other] }
  }
  return c
}

function matchField(actual, c) {
  if (c === null || c === undefined) return true
  if (typeof c === 'object' && c.__cond) {
    if (c.op === 'gte') return actual >= c.value
    if (c.op === 'lte') return actual <= c.value
    if (c.op === 'in') return c.value.indexOf(actual) !== -1
    if (c.op === 'and') return matchField(actual, c.parts[0]) && matchField(actual, c.parts[1])
    return false
  }
  return actual === c
}

function matchDoc(doc, condition) {
  return Object.keys(condition).every(k => matchField(doc[k], condition[k]))
}

function makeCollection() {
  const state = { cond: {}, skip: 0, limit: 1000 }

  const api = {
    where(c) { state.cond = c || {}; return api },
    field() { return api },
    orderBy() { return api },
    skip(n) { state.skip = n; return api },
    limit(n) { state.limit = n; return api },
    async get() {
      const rows = DOCS.filter(d => matchDoc(d, state.cond))
      return { data: rows.slice(state.skip, state.skip + state.limit) }
    },
    async count() {
      return { total: DOCS.filter(d => matchDoc(d, state.cond)).length }
    },
    async remove() {
      const before = DOCS.length
      DOCS = DOCS.filter(d => !matchDoc(d, state.cond))
      return { stats: { removed: before - DOCS.length } }
    },
    async add({ data }) {
      seq++
      const _id = 'id' + seq
      DOCS.push(Object.assign({ _id }, data))
      return { _id }
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
      command: {
        gte: v => cond('gte', v),
        lte: v => cond('lte', v),
        in: v => cond('in', v)
      }
    }
  },
  getWXContext() {
    return { OPENID: 'me' }
  },
  async downloadFile() {
    return { fileContent: Buffer.from('') }
  }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return cloudStub
  if (request === 'xlsx') return {}
  return origLoad.apply(this, arguments)
}

const parseFn = require(PARSE_FN)
const statsFn = require(STATS_FN)

const del = (ids) => parseFn.main({ action: 'delete', ids }, {})
const stats = (event) => statsFn.main(event, {})

// ==================== 造数据 ====================

// 北京时间「本月 10 号 12:00」——落在本月区间内，首页/账单页都算得到
function thisMonthTs() {
  const d = new Date(Date.now() + BJ)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 10, 12, 0, 0) - BJ
}

function seed() {
  DOCS = []
  seq = 0
  const ts = thisMonthTs()

  DOCS.push({ _id: 'a1', _openid: 'me', type: 'expense', amount: 100, createTime: ts, title: '餐饮', categoryId: 'food' })
  DOCS.push({ _id: 'a2', _openid: 'me', type: 'income', amount: 500, createTime: ts, title: '工资', categoryId: 'salary' })
  DOCS.push({ _id: 'a3', _openid: 'me', type: 'expense', amount: 20, createTime: ts, title: '交通', categoryId: 'transport' })
  // 别人的记录：任何情况下都不该被删
  DOCS.push({ _id: 'b1', _openid: 'other', type: 'expense', amount: 9999, createTime: ts, title: '别人的账' })
}

// ==================== 1) 正常删除 ====================

async function testDelete() {
  console.log('\n=== 1) 删除自己的记录 ===')
  seed()

  let r = await del(['a2'])
  t(r.code === 0 && r.deleted === 1, `删除一条 → deleted=${r.deleted}（期望 1）`)
  t(DOCS.filter(d => d._id === 'a2').length === 0, '该记录确实从库里消失')
  t(DOCS.length === 3, `剩余 ${DOCS.length} 条（期望 3）`)

  // 再删一次同一条：不能报错、也不能把别的删了
  r = await del(['a2'])
  t(r.code === 0 && r.deleted === 0, '重复删除已删除的 id → deleted=0，不抛异常')
  t(DOCS.length === 3, '重复删除没有误删其它记录')
  t(r.message.indexOf('不存在') !== -1, `文案如实告知：「${r.message}」`)

  // 单条（非数组）也要支持 —— 前端有的地方传的是字符串
  r = await del('a3')
  t(r.code === 0 && r.deleted === 1, '传单个字符串 id 也能删（兼容非数组写法）')
}

// ==================== 2) 归属校验（最关键） ====================

async function testOwnership() {
  console.log('\n=== 2) 越权删除必须失败 ===')
  seed()

  let r = await del(['b1'])
  t(r.code === 0 && r.deleted === 0, '删别人的 id → deleted=0（不能删掉）')
  t(DOCS.filter(d => d._id === 'b1').length === 1, '别人的记录原封不动')

  r = await del(['b1', 'a1'])
  t(r.code === 0 && r.deleted === 1, `自己的 + 别人的混着传 → 只删掉自己的那 1 条（deleted=${r.deleted}）`)
  t(DOCS.filter(d => d._id === 'b1').length === 1, '别人的记录依然在')
  t(DOCS.filter(d => d._id === 'a1').length === 0, '自己的记录被删掉')
}

// ==================== 3) 边界与脏输入 ====================

async function testEdge() {
  console.log('\n=== 3) 脏输入不能把库搞乱 ===')
  seed()

  let r = await del([])
  t(r.code === -1 && r.deleted === 0, '空数组 → code=-1，不执行删除')
  r = await del(undefined)
  t(r.code === -1, '不传 id → code=-1')
  r = await del(['', '  ', null])
  t(r.code === -1 && DOCS.length === 4, '全是空值 → code=-1，库没有变化')

  r = await del(['a1', 'a1', ' a1 '])
  t(r.code === 0 && r.requested === 1 && r.deleted === 1,
    `同一 id 传三次（含首尾空格）→ 去重成 1 条（requested=${r.requested}, deleted=${r.deleted}）`)

  const tooMany = []
  for (let i = 0; i < 60; i++) tooMany.push('x' + i)
  r = await del(tooMany)
  t(r.code === -1, `一次 60 条 → 被上限拦住（${r.message}）`)

  // 不存在的 id：不能报错（前端可能对着一份过期列表点删除）
  r = await del(['not-exist-id'])
  t(r.code === 0 && r.deleted === 0, '不存在的 id → code=0 / deleted=0，前端能据此提示"已不存在"')
}

// ==================== 4) 删完之后统计要跟着变 ====================

async function testStatsAfterDelete() {
  console.log('\n=== 4) 删完能被统计立刻反映 ===')
  seed()

  let profile = await stats({ action: 'profile' })
  t(profile.data.totalBills === 3, `删除前个人页总笔数 = ${profile.data.totalBills}（期望 3）`)

  let index = await stats({ action: 'indexData' })
  t(index.data.monthSummary.expense === 120,
    `删除前本月支出 = ${index.data.monthSummary.expense}（期望 120 = 100 + 20）`)

  // 删掉那笔 100 元的支出
  const r = await del(['a1'])
  t(r.deleted === 1, '删除 100 元那笔')

  index = await stats({ action: 'indexData' })
  t(index.data.monthSummary.expense === 20,
    `删除后本月支出 = ${index.data.monthSummary.expense}（期望 20，不能还留着 120）`)

  profile = await stats({ action: 'profile' })
  t(profile.data.totalBills === 2, `删除后个人页总笔数 = ${profile.data.totalBills}（期望 2）`)

  const bills = await stats({ action: 'bills', period: 'month', page: 0, pageSize: 20 })
  t(bills.data.total === 2 && bills.data.bills.every(b => b._id !== 'a1'),
    `账单列表也少了一条（total=${bills.data.total}）`)
}

// ==================== 5) 清空（delete 的极端形态）仍然可用 ====================

async function testClearStillWorks() {
  console.log('\n=== 5) 原有 clear 动作不受影响 ===')
  seed()

  const r = await parseFn.main({ action: 'clear' }, {})
  t(r.code === 0 && r.deleted === 3, `clear 只清掉自己的 ${r.deleted} 条（别人的记录不在范围内）`)
  t(DOCS.length === 1 && DOCS[0]._openid === 'other', '库里只剩别人的那条 —— 清空也不会跨账号误伤')

  const profile = await stats({ action: 'profile' })
  t(profile.data.totalBills === 0, '清空后总笔数为 0（无残留）')
}

// ==================== 跑 ====================

;(async () => {
  await testDelete()
  await testOwnership()
  await testEdge()
  await testStatsAfterDelete()
  await testClearStillWorks()

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`)
  process.exit(fail === 0 ? 0 : 1)
})()
