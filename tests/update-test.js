/**
 * 编辑账单（parseCSV action='update' / 'detail'）离线验证
 *
 * 为什么这个套件必须存在？
 *   「改一笔」和「删一笔」一样，是**能改坏别人数据**的动作：
 *   云函数以管理员身份执行、会绕过集合权限，所以 where 里少写一个
 *   _openid 就等于「谁构造出别人的 id 就能改别人的账」——
 *   而这件事在开发者自己身上永远不会发生（自己的 id 当然是自己的）。
 *
 * 重点覆盖：
 *   1. 归属校验：别人的记录读不到（detail）、改不动（update）
 *   2. 校验规则与「记一笔」完全一致（抽成 normalizeManualInput 共用的原因）
 *   3. 重复检查**排除自己**：什么都不改直接保存，不该弹「疑似重复」
 *   4. 字段取舍：category 重算，_openid / source / orderNo 一律不动
 *   5. 改完能被统计立刻反映（首页/账单页的数字不能对不上）
 *   6. 前端 utils/bill-form.js：原值不在下拉选项里也不能被静默改掉
 *
 * 用 Module._load 拦截 wx-server-sdk / xlsx，注入内存假数据库。
 *
 * 运行：node tests/update-test.js
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

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
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
    // 云数据库的 where().update() 是「批量更新」，返回 stats.updated
    async update({ data }) {
      let updated = 0
      DOCS.forEach(d => {
        if (matchDoc(d, state.cond)) {
          Object.assign(d, data)
          updated++
        }
      })
      return { stats: { updated } }
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
const form = require(path.join(__dirname, '..', 'utils/bill-form.js'))

const upd = (id, bill, force) => parseFn.main({ action: 'update', id, bill, force }, {})
const detail = (id) => parseFn.main({ action: 'detail', id }, {})
const stats = (event) => statsFn.main(event, {})

// ==================== 造数据 ====================

// 本月 1 号 12:00（北京时间）—— 一定落在「本月」区间内，首页/账单页都算得到。
// 用 1 号而不是 10 号：10 号在月初跑测试时会跑到"未来"，区间就套不住了。
function monthDay1() {
  const d = new Date(Date.now() + BJ)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  return {
    date: `${y}-${pad2(m + 1)}-01`,
    time: '12:00',
    ts: Date.UTC(y, m, 1, 12, 0, 0) - BJ
  }
}

let MD = monthDay1()

function seed() {
  MD = monthDay1()
  DOCS = []
  seq = 0

  // 一条「手动记的账」，支付方式故意放一个不在下拉选项里的值
  DOCS.push({
    _id: 'a1', _openid: 'me', type: 'expense', amount: 100, createTime: MD.ts,
    time: '12:00', timeStr: MD.date + ' 12:00',
    title: '餐饮', product: '午饭', category: '餐饮', categoryId: 'food',
    icon: '🍜', color: '#F97316',
    tradeType: '商户消费', payMethod: '招商银行(1234)', status: '支付成功',
    orderNo: '', merchantNo: '', source: 'manual', updateTime: 1
  })
  DOCS.push({
    _id: 'a2', _openid: 'me', type: 'income', amount: 500, createTime: MD.ts,
    time: '12:00', title: '工资', product: '', category: '工资', categoryId: 'salary'
  })
  // 一条「导入的账」：有交易单号，编辑一次不该把它抹掉
  DOCS.push({
    _id: 'a3', _openid: 'me', type: 'expense', amount: 20, createTime: MD.ts,
    time: '12:00', title: '交通', product: '', category: '交通', categoryId: 'transport',
    orderNo: '4200001234567890', merchantNo: 'M001', source: 'wechat'
  })
  // 别人的记录：任何情况下都不该被读到或改到
  DOCS.push({
    _id: 'b1', _openid: 'other', type: 'expense', amount: 9999, createTime: MD.ts,
    title: '别人的账', categoryId: 'other'
  })
}

/** 一个合法的编辑表单（默认把 a1 改成「滴滴出行 55.5」） */
function form1(patch) {
  return Object.assign({
    date: MD.date,
    time: MD.time,
    type: 'expense',
    amount: '55.5',
    title: '滴滴出行',
    product: '打车',
    tradeType: '商户消费',
    payMethod: '零钱',
    status: '支付成功'
  }, patch || {})
}

// ==================== 1) 正常修改 + 字段取舍 ====================

async function testUpdate() {
  console.log('\n=== 1) 修改自己的记录 ===')
  seed()

  const r = await upd('a1', form1())
  t(r.code === 0 && r.updated === 1, `改一笔 → code=0, updated=${r.updated}（期望 1）`)

  const doc = DOCS.find(d => d._id === 'a1')
  t(doc.amount === 55.5, `金额已改成 55.5（实际 ${doc.amount}）`)
  t(doc.title === '滴滴出行', '交易对方已改')
  t(doc.timeStr.indexOf(MD.date) === 0, `timeStr 跟着时间一起重算（${doc.timeStr}）`)
  t(doc.updateTime > 1, 'updateTime 已刷新')

  // 分类必须按新内容重算 —— 用户改「交易对方」本来就是为了让它归对类
  t(doc.categoryId === 'transport',
    `分类按新内容重新识别：餐饮 → ${doc.categoryId}（期望 transport）`)
  t(doc.icon === '🚗' && !!doc.color, '图标与配色一起换成新分类的')

  // 这几个字段一个字都不能动
  t(doc._openid === 'me', '⚠️ _openid 没有被改动（改错等于把这条记录送给别人）')
  t(doc.source === 'manual', 'source 保留原值，不因编辑而变成别的来源')

  // 导入的账单：编辑后交易单号必须还在
  const r2 = await upd('a3', form1({ amount: '30', title: '打车费' }))
  const doc3 = DOCS.find(d => d._id === 'a3')
  t(r2.code === 0 && doc3.orderNo === '4200001234567890',
    '⚠️ 编辑导入的账单后，交易单号仍在（它是核对微信账单的唯一凭据）')
  t(doc3.source === 'wechat', '导入来源标记也保留')
}

// ==================== 2) 归属校验（最关键） ====================

async function testOwnership() {
  console.log('\n=== 2) 越权修改必须失败 ===')
  seed()

  const before = JSON.stringify(DOCS.find(d => d._id === 'b1'))

  const r = await upd('b1', form1({ amount: '1' }))
  t(r.code === -1 && r.updated === 0, `改别人的 id → 拒绝（code=${r.code}）`)
  t(r.message.indexOf('不存在或无权') !== -1, `文案如实告知：「${r.message}」`)
  t(JSON.stringify(DOCS.find(d => d._id === 'b1')) === before, '别人的记录一个字节都没变')

  // 不存在 / 空 id
  let r2 = await upd('not-exist-id', form1())
  t(r2.code === -1 && r2.updated === 0, '不存在的 id → code=-1，不假装成功')

  r2 = await upd('', form1())
  t(r2.code === -1, '空 id → code=-1')

  r2 = await upd(undefined, form1())
  t(r2.code === -1, '不传 id → code=-1')
}

// ==================== 3) detail 的归属校验 ====================

async function testDetail() {
  console.log('\n=== 3) detail 读单条也要带 _openid ===')
  seed()

  let r = await detail('a1')
  t(r.code === 0 && r.data && r.data._id === 'a1', '能读到自己的记录')
  t(r.data.amount === 100 && r.data.payMethod === '招商银行(1234)', '返回的是完整字段（编辑页要预填）')

  r = await detail('b1')
  t(r.code === -1 && !r.data, '⚠️ 读别人的 id → 拒绝（用 doc().get() 就会漏出去）')

  r = await detail('')
  t(r.code === -1, '空 id → code=-1')
  r = await detail(undefined)
  t(r.code === -1, '不传 id → code=-1')
  r = await detail('not-exist-id')
  t(r.code === -1, '不存在的 id → code=-1')
}

// ==================== 4) 校验规则与「记一笔」一致 ====================

async function testValidation() {
  console.log('\n=== 4) 脏输入不能进库（与新增同一套规则）===')
  seed()

  const cases = [
    [{ amount: '-5' }, '金额不能为负数'],
    [{ amount: '0' }, '请输入大于 0 的金额'],
    [{ amount: 'abc' }, '请输入大于 0 的金额'],
    [{ amount: '100000001' }, '金额过大'],
    [{ date: '' }, '请选择交易日期'],
    [{ date: '不是日期' }, '交易时间无法识别']
  ]

  for (const [patch, expect] of cases) {
    const r = await upd('a1', form1(patch))
    t(r.code === -1 && r.message.indexOf(expect) !== -1,
      `${JSON.stringify(patch)} → 拦住：「${r.message}」`)
  }

  const doc = DOCS.find(d => d._id === 'a1')
  t(doc.amount === 100 && doc.title === '餐饮', '校验失败时库里的记录原样不动')
}

// ==================== 5) 重复检查必须排除自己（最容易写错的一条） ====================

async function testDuplicateSelf() {
  console.log('\n=== 5) 什么都没改就保存，不该报「疑似重复」 ===')
  seed()

  // 原样提交 a1（同秒 + 同金额 + 同对方 + 同收支）
  const r = await upd('a1', {
    date: MD.date, time: MD.time, type: 'expense', amount: '100',
    title: '餐饮', product: '午饭'
  })
  t(r.code === 0,
    `⚠️ 不改任何字段直接保存 → code=${r.code}（期望 0；命中自己那条不算重复）`)
  t(DOCS.find(d => d._id === 'a1').amount === 100, '记录照常保存')

  // 改成与「另一条」完全一致 → 才是真的可疑
  const dup = await upd('a1', {
    date: MD.date, time: MD.time, type: 'expense', amount: '20', title: '交通'
  })
  t(dup.code === 2, `改成与 a3 一模一样 → code=${dup.code}（期望 2，提示确认）`)
  t(DOCS.find(d => d._id === 'a1').amount === 100, '未确认时不写库')

  const forced = await upd('a1', {
    date: MD.date, time: MD.time, type: 'expense', amount: '20', title: '交通'
  }, true)
  t(forced.code === 0, 'force=true 时照常写入')
  t(DOCS.find(d => d._id === 'a1').amount === 20, '已按用户确认写入')
}

// ==================== 6) 改完能被统计立刻反映 ====================

async function testStatsAfterUpdate() {
  console.log('\n=== 6) 改完能被统计立刻反映 ===')
  seed()

  let index = await stats({ action: 'indexData' })
  t(index.data.monthSummary.expense === 120,
    `改前本月支出 = ${index.data.monthSummary.expense}（期望 120 = 100 + 20）`)

  // 把那笔 100 元的支出改成 30 元
  const r = await upd('a1', form1({ amount: '30', title: '餐饮' }))
  t(r.code === 0, '把 100 元那笔改成 30 元')

  index = await stats({ action: 'indexData' })
  t(index.data.monthSummary.expense === 50,
    `改后本月支出 = ${index.data.monthSummary.expense}（期望 50，不能还留着 120）`)

  // 收支类型也能改：支出 → 收入
  await upd('a1', form1({ type: 'income', amount: '30', title: '退款' }))
  index = await stats({ action: 'indexData' })
  t(index.data.monthSummary.expense === 20,
    `改成收入后本月支出回到 ${index.data.monthSummary.expense}（期望 20）`)
  t(index.data.monthSummary.income === 530,
    `本月收入 = ${index.data.monthSummary.income}（期望 530 = 500 + 30）`)

  // 笔数不变（编辑不是删除 + 新增）
  const profile = await stats({ action: 'profile' })
  t(profile.data.totalBills === 3, `总笔数仍是 ${profile.data.totalBills}（编辑不产生新记录）`)

  // 账单列表里那条的金额也应该是新的
  const bills = await stats({ action: 'bills', period: 'month', page: 0, pageSize: 20 })
  const row = bills.data.bills.find(b => b._id === 'a1')
  t(row && row.amount === 30, `账单列表里 a1 的金额 = ${row && row.amount}（期望 30）`)
}

// ==================== 7) 前端纯函数：原值不在选项里也不能被改掉 ====================

async function testBillForm() {
  console.log('\n=== 7) utils/bill-form.js ===')

  const PAY = ['零钱', '零钱通', '储蓄卡', '信用卡', '支付宝', '现金', '其他']

  // 导入的账单里「支付方式」常常是「招商银行(1234)」这种，不在下拉选项里
  let x = form.withValue(PAY, '招商银行(1234)')
  t(x.list.length === PAY.length + 1, `原值被补进选项（${PAY.length} → ${x.list.length}）`)
  t(x.list[x.index] === '招商银行(1234)',
    '⚠️ 索引指回原值 —— 否则用户只改金额、保存一次却把支付方式静默改成第一项')
  t(x.index === x.list.length - 1, '追加在末尾，不打乱已有选项的下标')

  x = form.withValue(PAY, '零钱')
  t(x.index === 0 && x.list.length === PAY.length, '本来就在选项里的值不会重复追加')

  x = form.withValue(PAY, '  零钱  ')
  t(x.index === 0, '首尾空格先去干净再匹配')

  x = form.withValue(PAY, '')
  t(x.index === 0 && x.list.length === PAY.length, '空值 → 落到第 0 项，不污染列表')

  x = form.withValue(PAY, null)
  t(x.index === 0 && x.list.length === PAY.length, 'null 也不污染列表')

  const src = ['a', 'b']
  form.withValue(src, 'c')
  t(src.length === 2, '不修改传入的数组（页面 data 与模块常量不能互相污染）')

  // 时间反推：用 UTC 时间戳做输入、按「北京 = UTC+8」独立换算成期望值，
  // 不把 bjParts 的公式抄回断言里（抄公式等于没测）
  const p = form.bjParts(Date.UTC(2026, 9, 15, 16, 30, 0))   // UTC 10-15 16:30 = 北京 10-16 00:30
  t(p.date === '2026-10-16' && p.time === '00:30',
    `UTC+8 跨零点：得到 ${p.date} ${p.time}（期望 2026-10-16 00:30）`)

  const q = form.bjParts(Date.UTC(2025, 11, 31, 16, 0, 0))   // UTC 2025-12-31 16:00 = 北京 2026-01-01 00:00
  t(q.date === '2026-01-01' && q.time === '00:00',
    `跨年零点：得到 ${q.date} ${q.time}（期望 2026-01-01 00:00）`)

  const bad = form.bjParts(undefined)
  t(/^\d{4}-\d{2}-\d{2}$/.test(bad.date), '时间戳非法时退回"现在"，不抛异常也不产生 NaN')
}

// ==================== 跑 ====================

;(async () => {
  await testUpdate()
  await testOwnership()
  await testDetail()
  await testValidation()
  await testDuplicateSelf()
  await testStatsAfterUpdate()
  await testBillForm()

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`)
  process.exit(fail === 0 ? 0 : 1)
})()
