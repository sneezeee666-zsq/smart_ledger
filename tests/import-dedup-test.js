/**
 * 导入去重离线验证（parseCSV action='dedup' + utils/bill-dedup.js + 导入页分批）
 *
 * 背景：体验版发现「一次性导入 500+ 条时，解析页跑去重失败、确认页显示 0 条」。
 * 根因是 wx.cloud.callFunction 的 data 有传输大小限制（官方建议临界值 100KB），
 * 而旧实现把**整条账单**（15 个字段 ≈330 字节/条，500 条 ≈165KB）传给云函数，
 * 直接报 data exceed max size。
 *
 * 修法：只传「判重键」（≈40 字节/条）并分批；云端只回「哪些下标已存在」；
 *       批内重复改在前端用同一把键本地判（utils/bill-dedup.js）。
 *
 * 这个套件守四件事：
 *   1. parse 必须返回与 data 逐下标对齐的 keys（对不上就会错配，且不报错）
 *   2. dedup 只收键、返回的下标必须准确 —— 包括**大批量不截断**
 *   3. **跨用户隔离**：别人的账单不能让我的键变成「已存在」（这是数据隔离的红线）
 *   4. 前端分批时下标偏移必须加对，批内去重跨批次仍然完整
 *
 * 运行：node tests/import-dedup-test.js
 */
const Module = require('module')
const path = require('path')

const PARSE_FN = path.join(__dirname, '..', 'cloudfunctions/parseCSV/index.js')
const IMPORT_PAGE = path.join(__dirname, '..', 'pages/import/import.js')

let fail = 0
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

// ==================== 内存假库 ====================

let DOCS = []
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
    async count() { return { total: DOCS.filter(d => matchDoc(d, state.cond)).length } },
    async remove() {
      const before = DOCS.length
      DOCS = DOCS.filter(d => !matchDoc(d, state.cond))
      return { stats: { removed: before - DOCS.length } }
    },
    async add({ data }) {
      seq++
      DOCS.push(Object.assign({ _id: 'id' + seq }, data))
      return { _id: 'id' + seq }
    }
  }
  return api
}

const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'dyn',
  init() {},
  database() {
    return { collection: makeCollection, command: { gte: v => cond('gte', v), lte: v => cond('lte', v) } }
  },
  getWXContext() { return { OPENID: OPENID } },
  downloadFile() { return Promise.resolve({ fileContent: Buffer.from('') }) }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return cloudStub
  if (request === 'xlsx') return {}
  return origLoad.apply(this, arguments)
}

const parseFn = require(PARSE_FN)
Module._load = origLoad

// ==================== 测试数据 ====================

/** 造一条微信账单 CSV 行 */
function csvRow(no, type, amount, title, time) {
  return [
    time || '2026-10-01 12:00:00',
    '商户消费',
    title || '美团外卖',
    '商品说明',
    type,
    '¥' + amount,
    '零钱',
    '支付成功',
    no,
    ''
  ].join(',')
}

const CSV_HEADER = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号'

/** 拼一份微信账单 CSV（前面带几行说明，模拟真实导出） */
function buildCsv(rows) {
  return [
    '微信支付账单明细',
    ',,,,,,,,,',
    '导出时间：2026-10-16,,,,,,,,,',
    CSV_HEADER,
    ...rows
  ].join('\n')
}

const realError = console.error
const mute = () => { console.error = () => {} }
const unmute = () => { console.error = realError }

/**
 * 直接造一条**已导入**的账单（带交易单号）。
 * ⚠️ 不能用 action='add' 造：手动记账的 orderNo 固定存空串
 *    （源码里写明「手动记账没有微信交易单号」），键会走兜底分支。
 *    而去重真正要对的正是「导入进来的、带单号的账单」。
 */
function seed(orderNo, openid) {
  seq++
  DOCS.push({
    _id: 'b' + seq,
    _openid: openid || 'me',
    orderNo: orderNo,
    createTime: 1790000000000,
    amount: 1,
    title: 't' + seq,
    type: 'expense'
  })
}

;(async () => {
  // ================================================================
  console.log('\n=== 1) parse 必须返回与 data 逐下标对齐的 keys ===')
  // ================================================================
  {
    DOCS = []; seq = 0; OPENID = 'me'
    const csv = buildCsv([
      csvRow('4200000001', '支出', '38.50', '美团外卖'),
      csvRow('4200000002', '收入', '100.00', '张三转账'),
      csvRow('4200000003', '支出', '12.00', '便利店')
    ])
    const r = await parseFn.main({ buffer: Buffer.from(csv, 'utf-8').toString('base64'), fileName: 'a.csv' }, {})

    t(r.code === 0, 'CSV 解析成功')
    t(r.data.length === 3, '解析出 3 条（实际 ' + r.data.length + '）')
    t(Array.isArray(r.keys), '返回了 keys 数组')
    t(r.keys.length === r.data.length, 'keys 与 data 等长（' + r.keys.length + ' vs ' + r.data.length + '）')
    t(r.keys[0] === 'no:4200000001', '键用交易单号（实际 ' + r.keys[0] + '）')
    t(r.keys[1] === 'no:4200000002', '第二条键也对得上')

    // 对齐错位的后果是「该留的被删、该删的留下」，且不报错 —— 必须逐个对上
    let aligned = true
    for (let i = 0; i < r.data.length; i++) {
      if (r.keys[i] !== 'no:' + r.data[i].orderNo) aligned = false
    }
    t(aligned, '每条键都对应同一条记录的 orderNo（逐下标对齐）')

    // 键里不能出现页面渲染字段（前端只拿它去重，不该写进账单文档）
    t(Object.keys(r.data[0]).indexOf('key') === -1, '记录本身没有多余的 key 字段')
  }

  // ================================================================
  console.log('\n=== 2) dedup：只收键，返回的下标必须准确 ===')
  // ================================================================
  {
    DOCS = []; seq = 0; OPENID = 'me'
    // 库里已有两笔导入账单
    seed('4200000001')
    seed('4200000003')

    const keys = ['no:4200000001', 'no:4200000002', 'no:4200000003', 'no:4200000004']
    const r = await parseFn.main({ action: 'dedup', keys }, {})

    t(r.code === 0, 'dedup 成功')
    const idx = (r.data && r.data.dupIdx) || []
    t(idx.length === 2, '检出 2 个重复（实际 ' + idx.length + '）')
    t(idx[0] === 0 && idx[1] === 2, '下标是 0 和 2（实际 ' + JSON.stringify(idx) + '）')
    t(r.data.existing === 2, '已有记录 2 条（实际 ' + r.data.existing + '）')
  }

  // ================================================================
  console.log('\n=== 3) dedup：空输入与超大批量 ===')
  // ================================================================
  {
    DOCS = []; seq = 0; OPENID = 'me'
    const r0 = await parseFn.main({ action: 'dedup', keys: [] }, {})
    t(r0.code === 0 && (r0.data.dupIdx || []).length === 0, '空键数组 → 空结果，不报错')

    const r1 = await parseFn.main({ action: 'dedup' }, {})
    t(r1.code === 0, '不传 keys 也不炸（容错）')

    // 大批量：这正是出 bug 的场景。旧实现传整条账单，500 条就超大小限制；
    // 现在只传键，3000 条也必须一条不漏地处理完。
    DOCS = []; seq = 0; OPENID = 'me'
    seed('EXIST_1')
    const many = []
    for (let i = 0; i < 3000; i++) many.push('no:BULK_' + i)
    many[1500] = 'no:EXIST_1'   // 中间埋一个已存在的
    many[2999] = 'no:EXIST_1'   // 末尾埋一个已存在的

    const r2 = await parseFn.main({ action: 'dedup', keys: many }, {})
    const idx2 = (r2.data && r2.data.dupIdx) || []
    t(r2.code === 0, '3000 个键也能正常处理')
    t(idx2.length === 2, '3000 个键里检出 2 个重复（实际 ' + idx2.length + '）—— 没有被截断')
    t(idx2[0] === 1500 && idx2[1] === 2999, '下标准确（实际 ' + JSON.stringify(idx2) + '）')
  }

  // ================================================================
  console.log('\n=== 4) 跨用户隔离：别人的账不能让我的键变「已存在」===')
  // ================================================================
  {
    DOCS = []; seq = 0
    // 另一个用户导入了一模一样的账单
    seed('SAME_NO_1', 'other')
    seed('SAME_NO_2', 'other')

    // 我提交同样的键
    OPENID = 'me'
    const r = await parseFn.main({ action: 'dedup', keys: ['no:SAME_NO_1', 'no:SAME_NO_2'] }, {})
    const idx = (r.data && r.data.dupIdx) || []
    t(idx.length === 0, '别人的账单不构成我的重复（实际 ' + idx.length + ' 个）')
    t(r.data.existing === 0, '已有记录数也不该算别人的（实际 ' + r.data.existing + '）')
  }

  // ================================================================
  console.log('\n=== 5) 没有交易单号时用兜底键（时间+金额+对方+收支）===')
  // ================================================================
  {
    DOCS = []; seq = 0; OPENID = 'me'
    const csv = buildCsv([
      '2026-10-01 12:00:00,商户消费,美团外卖,商品说明,支出,¥38.50,零钱,支付成功,,',
      '2026-10-02 09:00:00,商户消费,滴滴出行,商品说明,支出,¥22.00,零钱,支付成功,,'
    ])
    const r = await parseFn.main({ buffer: Buffer.from(csv, 'utf-8').toString('base64'), fileName: 'b.csv' }, {})
    t(r.code === 0 && r.data.length === 2, '无单号也能解析出 2 条')
    t(r.keys.every(k => k.indexOf('c:') === 0), '无单号 → 用兜底键（实际 ' + r.keys[0] + '）')

    // 同样的两笔再导入一次，必须被认出来
    const r2 = await parseFn.main({ action: 'dedup', keys: r.keys }, {})
    t((r2.data.dupIdx || []).length === 0, '第一次导入前没有重复')

    // 写进库后再查：兜底键要能和库里的文档对上
    // ⚠️ 用与 CSV 里完全相同的时间手动记两笔 —— 兜底键含 createTime，
    //    两边时间差一秒键就不同，正是要验的「字段原样保留」这件事
    await parseFn.main({ action: 'add', bill: { type: 'expense', amount: 38.5, title: '美团外卖', date: '2026-10-01', time: '12:00:00' } }, {})
    await parseFn.main({ action: 'add', bill: { type: 'expense', amount: 22, title: '滴滴出行', date: '2026-10-02', time: '09:00:00' } }, {})
    const r3 = await parseFn.main({ action: 'dedup', keys: r.keys }, {})
    t((r3.data.dupIdx || []).length === 2, '入库后同一批键全部判为重复（兜底键与库文档对得上）')
  }

  // ================================================================
  console.log('\n=== 6) utils/bill-dedup.filterNewBills ===')
  // ================================================================
  {
    const { filterNewBills } = require(path.join(__dirname, '..', 'utils/bill-dedup.js'))

    const bills = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]
    const keys = ['a', 'b', 'c', 'b', 'd']   // 第 4 条与第 2 条同键（批内重复）

    const r = filterNewBills(bills, keys, new Set([2]))   // 第 3 条在库里
    t(r.newBills.length === 3, '库重复 1 + 批内重复 1 → 剩 3 条（实际 ' + r.newBills.length + '）')
    t(r.duplicateCount === 2, '重复计数 2（实际 ' + r.duplicateCount + '）')
    t(r.newBills[0].id === 1 && r.newBills[1].id === 2 && r.newBills[2].id === 5,
      '保留的是 1、2、5，且顺序不变')
    t(r.newBills.length + r.duplicateCount === bills.length,
      '新增 + 重复 = 解析总数（界面上这三个数字必须对得上）')

    // 数组形式的下标也要认
    const r2 = filterNewBills(bills, keys, [0, 4])
    t(r2.newBills.length === 2 && r2.duplicateCount === 3, '传数组也行（下标 0、4 重复）')

    // 没有重复
    const r3 = filterNewBills(bills, keys, [])
    t(r3.newBills.length === 4 && r3.duplicateCount === 1, '只有批内重复时：留 4 条、重复 1 条')

    // 空输入
    const r4 = filterNewBills([], [], [])
    t(r4.newBills.length === 0 && r4.duplicateCount === 0, '空输入 → 空输出')

    // 脏输入不炸
    const r5 = filterNewBills(null, null, null)
    t(r5.newBills.length === 0, '传 null 不炸')
  }

  // ================================================================
  console.log('\n=== 7) 导入页：分批提交与下标偏移（Page 桩）===')
  // ================================================================
  {
    // 这一步用假 callFunction（记录每次提交的键），验证分批与偏移加对了
    const calls = []
    global.wx = {
      getStorageSync() { return '' },
      setStorageSync() {},
      setTabBarStyle() {}, setTabBarItem() {}, setNavigationBarColor() {}, setBackgroundColor() {},
      showToast() {}, showLoading() {}, hideLoading() {},
      getWindowInfo() { return { statusBarHeight: 20 } },
      env: { USER_DATA_PATH: '' },
      cloud: {
        database() { return { collection: () => ({ add: () => Promise.resolve({ _id: 'x' }) }) } },
        callFunction(opts) {
          const d = opts.data || {}
          if (d.action === 'dedup') {
            calls.push(d.keys.slice())
            const dupIdx = []
            d.keys.forEach((k, i) => { if (k.indexOf('dup:') === 0) dupIdx.push(i) })
            return Promise.resolve({ result: { code: 0, data: { dupIdx, existing: 9 }, duplicates: dupIdx.length, existing: 9 } })
          }
          return Promise.resolve({ result: { code: 0, data: [], skipped: 0 } })
        }
      }
    }

    let captured = null
    global.Page = (cfg) => { captured = cfg }
    delete require.cache[IMPORT_PAGE]
    delete require.cache[path.join(__dirname, '..', 'utils/theme.js')]
    delete require.cache[path.join(__dirname, '..', 'utils/bill-dedup.js')]
    require(IMPORT_PAGE)

    const page = Object.assign({}, captured, {
      data: JSON.parse(JSON.stringify(captured.data)),
      setData(patch) { Object.assign(this.data, patch) }
    })

    // 3200 条 → 应该分 3 批（1500 + 1500 + 200）
    const N = 3200
    const bills = []
    const keys = []
    for (let i = 0; i < N; i++) {
      bills.push({ id: i, type: 'expense', amount: 1, title: 't' + i, orderNo: 'N' + i, createTime: 1 })
      keys.push(i === 0 || i === 1500 || i === 2999 ? 'dup:X' : 'no:N' + i)
    }

    await page.handleParsedData(bills, keys, 0)

    t(calls.length === 3, '3200 条分 3 批提交（实际 ' + calls.length + ' 批）')
    t(calls[0].length === 1500 && calls[1].length === 1500 && calls[2].length === 200,
      '每批 1500/1500/200（实际 ' + calls.map(c => c.length).join('/') + '）')
    t(page.data.newCount === N - 3, '扣掉 3 个重复后剩 ' + (N - 3) + ' 条（实际 ' + page.data.newCount + '）')
    t(page.data.duplicateCount === 3, '重复 3 条（实际 ' + page.data.duplicateCount + '）')
    t(page.data.existingCount === 9, '已有记录数透传（实际 ' + page.data.existingCount + '）')
    t(page.data.deduping === false, '去重结束后 deduping 复位')
    t(page._newBills && page._newBills.length === N - 3, '全量新记录放在实例属性里，没进 data')
    t(page._newBills[0].id === 1 && page._newBills[N - 4].id === N - 1,
      '跨批次的下标偏移加对了（第 1500 条被正确剔除）')

    // 键与记录对不上时必须拦住，不能闷头去重
    let lastToast = ''
    global.wx.showToast = (o) => { lastToast = o && o.title }
    const callsBefore = calls.length
    await page.handleParsedData(bills, keys.slice(0, 10), 0)
    t(calls.length === callsBefore, '键与记录长度不一致 → 根本不去调去重（不会按错配的键闷头判）')
    t(String(lastToast).indexOf('异常') !== -1, '给出明确提示（实际："' + lastToast + '"）')
    t(page.data.newCount === N - 3, '上一次的正确结果没被冲掉')
  }

  // ================================================================
  console.log('\n=== 8) 去重失败时不许继续（防重复导入）===')
  // ================================================================
  {
    global.wx.cloud = {
      database() { return { collection: () => ({ add: () => Promise.resolve({ _id: 'x' }) }) } },
      callFunction() { return Promise.resolve({ result: { code: -1, message: '去重失败: boom' } }) }
    }
    let captured2 = null
    global.Page = (cfg) => { captured2 = cfg }
    delete require.cache[IMPORT_PAGE]
    delete require.cache[path.join(__dirname, '..', 'utils/theme.js')]
    delete require.cache[path.join(__dirname, '..', 'utils/bill-dedup.js')]
    mute()
    require(IMPORT_PAGE)
    unmute()

    const page = Object.assign({}, captured2, {
      data: JSON.parse(JSON.stringify(captured2.data)),
      setData(patch) { Object.assign(this.data, patch) }
    })
    await page.handleParsedData([{ id: 1 }], ['no:1'], 0)

    t(page.data.newCount === 0, '失败后新增数为 0')
    t(page._newBills.length === 0, '失败后实例属性也是空（写不进去）')
    t(page.data.deduping === false, 'deduping 复位，按钮恢复可点')
  }

  console.log('\n' + (fail ? '❌ ' + fail + ' 项未通过' : '✅ 全部通过'))
  process.exit(fail ? 1 : 0)
})()
