/**
 * 「常记的」离线验证（utils/quick-picks.js + user/setQuickPicks + getStatistics/quickPicks）
 *
 * 这个功能有三个"静默出错"的坑，全靠这个套件守着：
 *
 *  1. **三处上限必须同值**（前端 LIMIT / user 云函数 / getStatistics）。
 *     不一致时表现为「面板能加到第 N 个，一保存就失败」，且报错看不出原因。
 *     静态检查对账常量，这里验行为。
 *  2. **「没配置过」和「用户清空了」是两种状态**：
 *     - 字段不存在 → 按账单自动推荐
 *     - []        → 就是空的，**绝不能再回退到推荐**
 *     否则用户费劲删完，回首页又冒出推荐项，只会以为"删不掉"。
 *  3. **保存是整套覆盖**（支持拖动排序），空数组要真的存成 []，
 *     不能写成"删掉字段"（那样就退化成第 2 条的"没配置过"了）。
 *
 * 运行：node tests/quick-picks-test.js
 */
const Module = require('module')
const path = require('path')

const QP = require(path.join(__dirname, '..', 'utils', 'quick-picks.js'))
const USER_FN = path.join(__dirname, '..', 'cloudfunctions/user/index.js')
const STATS_FN = path.join(__dirname, '..', 'cloudfunctions/getStatistics/index.js')

let fail = 0
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

// ==================== 内存假库（支持 users + bills） ====================

const DB = { users: [], bills: [] }
let seq = 0
let OPENID = 'me'

function cond(op, value) {
  const c = { __cond: true, op, value }
  c.and = function (other) { return { __cond: true, op: 'and', parts: [c, other] } }
  return c
}

function matchField(actual, c) {
  if (c === null || c === undefined) return true
  if (typeof c === 'object' && c.__cond) {
    if (c.op === 'gte') return actual >= c.value
    if (c.op === 'lte') return actual <= c.value
    if (c.op === 'and') return matchField(actual, c.parts[0]) && matchField(actual, c.parts[1])
    return false
  }
  return actual === c
}

function matchDoc(doc, condition) {
  return Object.keys(condition).every(k => matchField(doc[k], condition[k]))
}

function makeCollection(name) {
  const rows = () => DB[name] || []
  const state = { cond: {}, skip: 0, limit: 1000 }

  const api = {
    where(c) { state.cond = c || {}; return api },
    field() { return api },
    orderBy() { return api },
    skip(n) { state.skip = n; return api },
    limit(n) { state.limit = n; return api },
    async get() {
      const hit = rows().filter(d => matchDoc(d, state.cond))
      return { data: hit.slice(state.skip, state.skip + state.limit) }
    },
    async count() { return { total: rows().filter(d => matchDoc(d, state.cond)).length } },
    async add({ data }) {
      seq++
      const doc = Object.assign({ _id: name + seq }, data)
      DB[name].push(doc)
      return { _id: doc._id }
    },
    async update({ data }) {
      const hit = rows().filter(d => matchDoc(d, state.cond))
      hit.forEach(d => Object.assign(d, data))
      return { stats: { updated: hit.length } }
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
        // user 云函数取消预算时会用 remove() 把字段删掉
        remove: () => ({ __remove: true })
      }
    }
  },
  getWXContext() { return { OPENID: OPENID } }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return cloudStub
  if (request === 'xlsx') return {}
  return origLoad.apply(this, arguments)
}
const userFn = require(USER_FN)
const statsFn = require(STATS_FN)
Module._load = origLoad

const reset = () => { DB.users.length = 0; DB.bills.length = 0; seq = 0; OPENID = 'me' }

const pick = (title, amount, type) => ({ title, amount, type: type || 'expense' })

;(async () => {
  // ================================================================
  console.log('\n=== 1) 纯函数：单条校验 ===')
  // ================================================================
  {
    t(QP.normalizeItem({ title: '地铁', amount: 3 }) !== null, '正常条目通过')
    t(QP.normalizeItem({ title: '', amount: 3 }) === null, '空对方名 → null')
    t(QP.normalizeItem({ title: '  ', amount: 3 }) === null, '全空格对方名 → null')
    t(QP.normalizeItem({ title: '地铁', amount: 0 }) === null, '金额 0 → null')
    t(QP.normalizeItem({ title: '地铁', amount: -5 }) === null, '负数金额 → null')
    t(QP.normalizeItem({ title: '地铁', amount: 2e8 }) === null, '超 1 亿 → null')
    t(QP.normalizeItem(null) === null, 'null → null（不炸）')

    const r = QP.normalizeItem({ title: ' 地铁 ', amount: '3.789', type: 'x' })
    t(r.title === '地铁', '对方名去首尾空格')
    t(r.amount === 3.79, '金额四舍五入到分（3.789 → 3.79）')
    t(r.type === 'expense', '不认识的 type 归一化成 expense')
    t(QP.normalizeItem({ title: '工资', amount: 1, type: 'income' }).type === 'income', 'income 保留')
  }

  // ================================================================
  console.log('\n=== 2) 纯函数：列表归一化 / 去重 / 上限 ===')
  // ================================================================
  {
    t(QP.LIMIT === 10, `上限是 10（实际 ${QP.LIMIT}）`)

    // 去重：同名同收支只留一条（留先出现的那个）
    const dedup = QP.normalizeList([pick('地铁', 3), pick('地铁', 9), pick('工资', 100, 'income')])
    t(dedup.length === 2, `同名同收支去重（实际 ${dedup.length} 条）`)
    t(dedup[0].amount === 3, '保留先出现的那条')

    // 同名但收支不同 → 两条都要
    const both = QP.normalizeList([pick('红包', 10, 'expense'), pick('红包', 10, 'income')])
    t(both.length === 2, '同名但收支不同 → 视为两条')

    // 截断
    const many = []
    for (let i = 0; i < 20; i++) many.push(pick('项目' + i, 1))
    t(QP.normalizeList(many).length === 10, '超过 10 条自动截断')

    // 脏数据混进来
    const dirty = QP.normalizeList([pick('地铁', 3), null, pick('', 5), pick('公交', 0), pick('ok', 2)])
    t(dirty.length === 2, `非法项直接丢弃（实际 ${dirty.length} 条）`)
  }

  // ================================================================
  console.log('\n=== 3) 纯函数：排序 / 删除 / 添加 ===')
  // ================================================================
  {
    const src = [pick('A', 1), pick('B', 2), pick('C', 3)]

    const moved = QP.move(src, 0, 2)
    t(moved.map(x => x.title).join('') === 'BCA', `往后拖（实际 ${moved.map(x => x.title).join('')}）`)
    t(QP.move(src, 2, 0).map(x => x.title).join('') === 'CAB', '往前拖')
    t(QP.move(src, 1, 1).map(x => x.title).join('') === 'ABC', '原地不动')
    t(QP.move(src, 0, 99).map(x => x.title).join('') === 'BCA', '越界夹回末尾（拖出列表是常态）')
    t(QP.move(src, -5, 0).map(x => x.title).join('') === 'ABC', '负数下标夹回开头')
    t(QP.move([pick('A', 1)], 0, 0).length === 1, '只有一条时不炸')
    t(src.map(x => x.title).join('') === 'ABC', '不改原数组（纯函数）')

    t(QP.removeAt(src, 1).map(x => x.title).join('') === 'AC', '删除中间项')
    t(QP.removeAt(src, 99).length === 3, '越界删除不动')

    const addOk = QP.add(src, pick('D', 4))
    t(addOk.ok && addOk.list.length === 4, '添加成功')
    t(QP.add(src, pick('A', 1)).reason === 'duplicate', '重复 → duplicate')
    t(QP.add(src, pick('', 1)).reason === 'invalid', '非法 → invalid')

    const full = []
    for (let i = 0; i < 10; i++) full.push(pick('X' + i, 1))
    t(QP.add(full, pick('Y', 1)).reason === 'full', '满 10 个 → full')
  }

  // ================================================================
  console.log('\n=== 4) 云端 user/setQuickPicks ===')
  // ================================================================
  {
    reset()

    // 正常保存
    const r1 = await userFn.main({ action: 'setQuickPicks', picks: [pick('地铁', 3), pick('瑞幸', 15)] })
    t(r1.code === 0, '保存成功')
    t(r1.data.quickPicks.length === 2, '返回 2 条')
    t(r1.data.quickPicks[0].title === '地铁', '顺序按提交的顺序（拖动排序靠它）')

    // 读回来
    const g1 = await userFn.main({ action: 'getProfile' })
    t(g1.data.quickPicks.length === 2, 'getProfile 能读回配置')

    // 顺序调整后保存 → 顺序真的变了
    await userFn.main({ action: 'setQuickPicks', picks: [pick('瑞幸', 15), pick('地铁', 3)] })
    const g2 = await userFn.main({ action: 'getProfile' })
    t(g2.data.quickPicks[0].title === '瑞幸', '重新保存后顺序更新（拖动排序生效）')

    // 超上限
    const eleven = []
    for (let i = 0; i < 11; i++) eleven.push(pick('N' + i, 1))
    const r2 = await userFn.main({ action: 'setQuickPicks', picks: eleven })
    t(r2.code === -1 && r2.message.indexOf('10') !== -1, `超 10 个被拒（${r2.message}）`)

    // 重复
    const r3 = await userFn.main({ action: 'setQuickPicks', picks: [pick('地铁', 3), pick('地铁', 9)] })
    t(r3.code === -1 && r3.message.indexOf('重复') !== -1, `同名同收支被拒（${r3.message}）`)

    // 非法金额
    const r4 = await userFn.main({ action: 'setQuickPicks', picks: [pick('地铁', 0)] })
    t(r4.code === -1, '金额 0 被拒')

    // ⚠️ 关键：清空要真的存成 []（而不是删字段）
    const r5 = await userFn.main({ action: 'setQuickPicks', picks: [] })
    t(r5.code === 0 && Array.isArray(r5.data.quickPicks) && r5.data.quickPicks.length === 0,
      '清空后返回 []（不是 null）')
    const g3 = await userFn.main({ action: 'getProfile' })
    t(Array.isArray(g3.data.quickPicks) && g3.data.quickPicks.length === 0,
      '清空后 getProfile 读到 []（不是 null）—— 这是"用户清空了"而不是"没配置过"')

    // 跨用户隔离
    OPENID = 'other'
    const gOther = await userFn.main({ action: 'getProfile' })
    t(gOther.data.quickPicks === null, '另一个用户读到 null（没配置过），看不到别人的')
  }

  // ================================================================
  console.log('\n=== 5) 云端 getStatistics/quickPicks 的优先级 ===')
  // ================================================================
  {
    reset()

    // 造 3 次"地铁"，让自动推荐里出现它
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      seq++
      DB.bills.push({
        _id: 'b' + seq, _openid: 'me', createTime: now - i * 86400000,
        amount: 3, type: 'expense', title: '地铁', product: '', categoryId: 'transport'
      })
    }

    // ① 没配置过 → 自动推荐
    const a1 = await statsFn.main({ action: 'quickPicks' })
    t(a1.code === 0 && a1.data.source === 'auto', `没配置过 → source=auto（实际 ${a1.data.source}）`)
    t(a1.data.picks.some(p => p.title === '地铁'), '推荐里有地铁')

    // ② 配置过 → 用用户的，且顺序就是配置的顺序
    await userFn.main({ action: 'setQuickPicks', picks: [pick('手动加的', 88), pick('另一个', 9)] })
    const a2 = await statsFn.main({ action: 'quickPicks' })
    t(a2.data.source === 'user', `配置过 → source=user（实际 ${a2.data.source}）`)
    t(a2.data.picks.length === 2 && a2.data.picks[0].title === '手动加的', '返回用户配置且顺序一致')
    t(!a2.data.picks.some(p => p.title === '地铁'), '不再混入自动推荐的内容')

    // ③ ⚠️ 清空 → 必须是空，不能回退到推荐
    await userFn.main({ action: 'setQuickPicks', picks: [] })
    const a3 = await statsFn.main({ action: 'quickPicks' })
    t(a3.data.source === 'user', '清空后 source 仍是 user')
    t(a3.data.picks.length === 0, `清空后必须是空（实际 ${a3.data.picks.length} 条）—— 不能又把推荐冒出来`)

    // ④ forceAuto：配置页拿推荐当候选
    const a4 = await statsFn.main({ action: 'quickPicks', forceAuto: true })
    t(a4.data.source === 'auto' && a4.data.picks.some(p => p.title === '地铁'),
      'forceAuto=true 时即使配置过也给推荐（配置页的候选来源）')

    // ⑤ 跨用户
    OPENID = 'other'
    const a5 = await statsFn.main({ action: 'quickPicks' })
    t(a5.data.source === 'auto' && !a5.data.picks.some(p => p.title === '地铁'),
      '别人的配置和账单都不影响我的结果')
  }

  console.log('\n' + (fail ? '❌ ' + fail + ' 项未通过' : '✅ 全部通过'))
  process.exit(fail ? 1 : 0)
})()
