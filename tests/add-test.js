/**
 * 手动记账（parseCSV action='add' / 'classify'）离线验证
 *
 * 用 Module._load 拦截 wx-server-sdk / xlsx，注入内存假数据库。
 * 最后再串一遍 getStatistics，确认手动记的账能被正常聚合。
 *
 * 运行：node add-test.js
 */
const Module = require('module')

const PARSE_FN = require('path').join(__dirname, '..', 'cloudfunctions/parseCSV/index.js')
const STATS_FN = require('path').join(__dirname, '..', 'cloudfunctions/getStatistics/index.js')

const BJ = 8 * 60 * 60 * 1000

let fail = 0
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

// ==================== 内存假库 ====================

let DOCS = []
let seq = 0

// ---------- 查询命令（gte / lte / and） ----------
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
        lte: v => cond('lte', v)
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

const call = (event) => parseFn.main(event, {})

// ==================== 1) classify 分类预览 ====================

async function testClassify() {
  console.log('\n=== 1) classify 分类预览 ===')

  let r = await call({ action: 'classify', bill: { title: '肯德基', product: '早餐', type: 'expense' } })
  t(r.code === 0 && r.category.id === 'food', `「肯德基」→ ${r.category && r.category.name}（期望 餐饮）`)

  r = await call({ action: 'classify', bill: { title: '滴滴出行', product: '', type: 'expense' } })
  t(r.category.id === 'transport', `「滴滴出行」→ ${r.category.name}（期望 交通）`)

  r = await call({ action: 'classify', bill: { title: '某某公司', product: '工资', type: 'income' } })
  t(r.category.id === 'salary', `「工资」→ ${r.category.name}（期望 工资）`)

  r = await call({ action: 'classify', bill: { title: '赵六', product: '', type: 'income' } })
  t(r.category.id === 'other_income', `无关键词收入 → ${r.category.name}（期望 其他收入）`)

  r = await call({ action: 'classify', bill: { title: '赵六', product: '', type: 'expense' } })
  t(r.category.id === 'other_expense', `无关键词支出 → ${r.category.name}（期望 其他支出）`)

  r = await call({ action: 'classify', bill: { title: '某工作室', product: '稿费', type: 'income' } })
  t(r.category.id === 'parttime', `「稿费」→ ${r.category.name}（期望 兼职）`)

  // ---- 收支不能串味：收入记录绝不能落进支出分类 ----
  // 微信账单里退款的「商品」常常是原始商户/商品名（如「美团外卖订单退款」），
  // 如果规则表不分收支，'外卖' 会先命中餐饮，把一笔收入记成支出分类。
  r = await call({ action: 'classify', bill: { title: '美团', product: '外卖订单退款', type: 'income' } })
  t(r.category.id === 'refund',
    `收入「美团 外卖订单退款」→ ${r.category.name}（期望 退款，不能变成餐饮）`)

  r = await call({ action: 'classify', bill: { title: '淘宝', product: '购物退款', type: 'income' } })
  t(r.category.id === 'refund',
    `收入「淘宝 购物退款」→ ${r.category.name}（期望 退款，不能变成购物）`)

  r = await call({ action: 'classify', bill: { title: '滴滴出行', product: '行程退款', type: 'income' } })
  t(r.category.id === 'refund',
    `收入「滴滴出行 行程退款」→ ${r.category.name}（期望 退款，不能变成交通）`)

  r = await call({ action: 'classify', bill: { title: '某某公司', product: '工资', type: 'expense' } })
  t(r.category.id === 'other_expense',
    `支出「工资」→ ${r.category.name}（期望 其他支出，不能变成工资收入）`)

  // 所有收入分类 id 都不能出现在支出结果里，反之亦然
  const INCOME_IDS = ['salary', 'bonus', 'investment', 'parttime', 'red_packet', 'refund', 'other_income']
  const EXPENSE_IDS = ['food', 'transport', 'shopping', 'entertainment', 'housing', 'medical', 'education',
    'communication', 'transfer', 'subscription', 'other_expense']
  const probeTitles = ['美团 外卖', '滴滴出行', '淘宝 购物', '腾讯视频 会员', '房租 水电', '医院 药品',
    '书店 教材', '话费充值', '工资', '年终奖', '余额宝 收益', '微信红包', '退款', '张三',
    '微信转账', 'Apple 订阅', 'Steam 游戏']
  let cross = []
  for (const tt of probeTitles) {
    const inc = await call({ action: 'classify', bill: { title: tt, product: '', type: 'income' } })
    if (INCOME_IDS.indexOf(inc.category.id) < 0) cross.push(`收入「${tt}」→ ${inc.category.id}`)
    const exp = await call({ action: 'classify', bill: { title: tt, product: '', type: 'expense' } })
    if (EXPENSE_IDS.indexOf(exp.category.id) < 0) cross.push(`支出「${tt}」→ ${exp.category.id}`)
  }
  t(cross.length === 0, `收支分类互不串味（${cross.length ? cross.join('；') : '全部正确'}）`)
}

// ==================== 2) add 参数校验 ====================

async function testValidate() {
  console.log('\n=== 2) add 参数校验（都不应写库） ===')

  const base = {
    action: 'add',
    bill: { date: '2026-10-15', time: '14:20', type: 'expense', amount: '35.5', title: '肯德基' }
  }

  const cases = [
    ['金额为空', { amount: '' }, '金额'],
    ['金额为 0', { amount: '0' }, '金额'],
    ['金额为负', { amount: '-5' }, '负数'],
    ['金额非数字', { amount: 'abc' }, '金额'],
    ['金额超上限', { amount: '999999999999' }, '过大'],
    ['日期为空', { date: '' }, '日期'],
    ['日期非法 13 月', { date: '2026-13-45' }, '时间'],
    ['日期非法 2-30', { date: '2026-02-30' }, '时间']
  ]

  for (const [name, patch, kw] of cases) {
    const bill = Object.assign({}, base.bill, patch)
    const r = await call({ action: 'add', bill })
    t(r.code !== 0 && String(r.message).includes(kw), `${name} → code=${r.code} "${r.message}"`)
  }

  t(DOCS.length === 0, `校验失败时未写库（库中 ${DOCS.length} 条）`)
}

// ==================== 3) add 正常写入 ====================

async function testAdd() {
  console.log('\n=== 3) add 正常写入 ===')

  const r = await call({
    action: 'add',
    bill: {
      date: '2026-10-15',
      time: '14:20',
      type: 'expense',
      amount: '35.5',
      title: '肯德基',
      product: '早餐',
      tradeType: '商户消费',
      payMethod: '零钱',
      status: '支付成功'
    }
  })

  t(r.code === 0, `返回 code=${r.code} "${r.message}"`)

  const d = r.data || {}
  const expectTs = Date.UTC(2026, 9, 15, 14, 20, 0) - BJ

  t(d.createTime === expectTs, `createTime = ${d.createTime}（期望 ${expectTs}，即北京时间 2026-10-15 14:20）`)
  t(d.time === '10-15 14:20', `time = "${d.time}"`)
  t(d.timeStr === '2026-10-15 14:20', `timeStr = "${d.timeStr}"`)
  t(d.amount === 35.5 && typeof d.amount === 'number', `amount = ${d.amount}（数字类型）`)
  t(d.type === 'expense', `type = ${d.type}`)
  t(d.categoryId === 'food' && d.category === '餐饮', `分类 = ${d.category}/${d.categoryId}`)
  t(!!d.icon && !!d.color, `icon=${d.icon} color=${d.color}`)
  t(d.tradeType === '商户消费' && d.payMethod === '零钱' && d.status === '支付成功', '三个下拉字段已写入')
  t(d.orderNo === '' && d.merchantNo === '', '无微信单号字段（手动记账）')
  t(d.source === 'manual', `source = ${d.source}`)
  t(d._openid === 'me', `⚠️ _openid = ${d._openid}（云函数写入必须显式带上）`)

  // 关键：字段必须覆盖 getStatistics 聚合用到的全部字段
  const need = ['amount', 'type', 'createTime', 'category', 'categoryId', 'icon', 'color']
  const missing = need.filter(k => d[k] === undefined)
  t(missing.length === 0, `getStatistics 所需字段齐全${missing.length ? '，缺 ' + missing.join(',') : ''}`)

  t(DOCS.length === 1, `库中 1 条（实际 ${DOCS.length}）`)
}

// ==================== 4) 金额与文本边界 ====================

async function testEdge() {
  console.log('\n=== 4) 边界处理 ===')

  // 标题为空 → 用「支出」兜底
  let r = await call({ action: 'add', bill: { date: '2026-10-14', time: '08:00', type: 'expense', amount: '9.9', title: '  ' } })
  t(r.code === 0 && r.data.title === '支出', `标题为空 → "${r.data.title}"`)
  t(r.data.categoryId === 'other_expense', `无标题 → ${r.data.category}`)

  // 收入 + 标题空 → 「收入」
  r = await call({ action: 'add', bill: { date: '2026-10-14', time: '08:00', type: 'income', amount: '100', title: '' } })
  t(r.code === 0 && r.data.title === '收入' && r.data.type === 'income', `收入标题兜底 → "${r.data.title}"`)

  // 超长标题截断到 60
  r = await call({ action: 'add', bill: { date: '2026-10-13', time: '08:00', type: 'expense', amount: '1', title: 'x'.repeat(100) } })
  t(r.data.title.length === 60, `超长标题截断到 ${r.data.title.length} 字`)

  // 只给日期不给时间 → 按 00:00 处理
  r = await call({ action: 'add', bill: { date: '2026-10-12', type: 'expense', amount: '2', title: '地铁' } })
  t(r.code === 0 && r.data.createTime === Date.UTC(2026, 9, 12, 0, 0, 0) - BJ, `只给日期 → ${r.data.timeStr}`)

  // 金额四舍五入到两位
  r = await call({ action: 'add', bill: { date: '2026-10-11', time: '10:00', type: 'expense', amount: '12.3456', title: '水果' } })
  t(r.data.amount === 12.35, `12.3456 → ${r.data.amount}`)

  // 带 ¥ 和千分位也能识别
  r = await call({ action: 'add', bill: { date: '2026-10-10', time: '10:00', type: 'expense', amount: '¥1,234.50', title: '超市' } })
  t(r.data.amount === 1234.5, `"¥1,234.50" → ${r.data.amount}`)
}

// ==================== 5) 疑似重复 ====================

async function testDuplicate() {
  console.log('\n=== 5) 疑似重复检测 ===')

  const bill = { date: '2026-10-09', time: '12:00', type: 'expense', amount: '20', title: '星巴克' }

  const first = await call({ action: 'add', bill })
  t(first.code === 0, '第一次保存成功')

  const again = await call({ action: 'add', bill })
  t(again.code === 2 && again.duplicate === true, `重复提交 → code=${again.code} "${again.message}"`)

  const before = DOCS.length
  const forced = await call({ action: 'add', bill, force: true })
  t(forced.code === 0 && DOCS.length === before + 1, `force=true 可强制写入（库中 ${DOCS.length} 条）`)

  // 金额不同不算重复
  const other = await call({ action: 'add', bill: Object.assign({}, bill, { amount: '21' }) })
  t(other.code === 0, '金额不同 → 视为新记录')
}

// ==================== 6) 与 getStatistics 串通 ====================

async function testIntegration() {
  console.log('\n=== 6) 手动记录能否被统计到 ===')

  // 造一条「今天 09:30」的支出，看首页本月汇总是否包含
  const nowP = new Date(Date.now() + BJ)
  const y = nowP.getUTCFullYear()
  const m = nowP.getUTCMonth() + 1
  const d = nowP.getUTCDate()
  const pad = n => String(n).padStart(2, '0')

  const r = await call({
    action: 'add',
    bill: {
      date: `${y}-${pad(m)}-${pad(d)}`,
      time: '09:30',
      type: 'expense',
      amount: '66.66',
      title: '美团外卖',
      product: '午餐'
    }
  })
  t(r.code === 0, `手动记账成功：${r.message}`)

  const idx = await statsFn.main({ action: 'indexData' }, {})
  t(idx.code === 0, `getStatistics 返回 code=${idx.code}`)
  t(idx.data.monthSummary.expense >= 66.66, `本月支出含手动记录：${idx.data.monthSummary.expense}`)

  const todayRow = idx.data.weekTrend[idx.data.weekTrend.length - 1]
  t(todayRow.expense >= 66.66, `今日趋势含手动记录：${todayRow.dayLabel} 支出 ${todayRow.expense}`)
  t(todayRow.expenseHeight > 0, `柱高已归一化：${todayRow.expenseHeight}`)

  const st = await statsFn.main({ action: 'stats', period: 'month' }, {})
  const food = (st.data.categories || []).find(c => c.id === 'food')
  t(!!food && food.amount >= 66.66, `分类统计归到「餐饮」：${food ? food.amount : '未找到'}`)

  const bp = await statsFn.main({ action: 'bills', period: 'month', page: 0, pageSize: 20 }, {})
  t(bp.code === 0 && bp.data.total > 0, `账单页读到 ${bp.data.total} 条，合计支出 ${bp.data.totalExpense}`)
  t(bp.data.bills.some(b => b.source === 'manual'), '账单页列表里能看到手动记录')
  t(bp.data.bills.some(b => b.title === '美团外卖' && b.category === '餐饮'), '手动记录的分类正确落在列表里')
}

// ==================== 5) 真实账单语料 ====================
//
// ⚠️ 用例来自一份真实的微信支付账单（2026-09-15 ~ 10-15，174 笔支出），
//    只抽了原先落进「其他支出」的那些行，**商户名原样保留**。
//    这批名字是分类器最该扛住的东西：长单号、门店后缀、别名、平台名混在商品列里。
//    加关键词时先跑这一组 —— 改宽一点点就可能把「足道」记成医疗、「面包」记成交通。
async function testRealCorpus() {
  console.log('\n=== 5) 真实账单语料（原「其他支出」的行） ===')

  // [交易对方, 商品, 交易类型, 收支, 期望分类]
  const CASES = [
    // —— 转账/红包：靠交易类型判，不靠商户名 ——
    ['媳妇儿（おかあさん版） (Seventeen)', '转账备注:微信转账', '转账', 'expense', 'transfer'],
    ['mch (TG27)', '转账备注:微信转账', '转账', 'expense', 'transfer'],
    ['发出群红包', '', '微信红包（群红包）', 'expense', 'transfer'],
    ['312 (MavR1ck)', '转账备注:微信转账', '转账', 'expense', 'transfer'],
    // ⚠️ 退款单的交易类型写作「转账-退款」，不能被当成转出去一笔
    ['游侠客', '游侠客-退款', '游侠客-退款', 'income', 'refund'],

    // —— 订阅/软件 ——
    ['Apple', 'apple.com/bill/MT9014419Ka0', '商户消费', 'expense', 'subscription'],
    ['杭州深度求索', 'DeepSeek-API服务(195******35)', '商户消费', 'expense', 'subscription'],

    // —— 娱乐：KTV/足道/景区/福彩 ——
    ['MEIKTV', 'MeiKTV#410_0', '商户消费', 'expense', 'entertainment'],
    ['mch (TG27)', '泰谷里·影院足道·汤泉SPA·美食（高新店）-美团App-26092511100300001307624477725889', '商户消费', 'expense', 'entertainment'],
    ['游侠客', '第九届太湖登山节｜10.17穹窿山主会场', '商户消费', 'expense', 'entertainment'],
    ['天街福彩', '', '扫二维码付款', 'expense', 'entertainment'],
    // Steam 买断游戏算娱乐，不算订阅
    ['蒸汽平台', '蒸汽平台交易 254046330636743996', '商户消费', 'expense', 'entertainment'],
    ['VALVE', 'Steam Purchase 1710000186960415', '商户消费', 'expense', 'entertainment'],

    // —— 餐饮：门店名不带「餐/饭」的那些 ——
    ['哈麦德兰州牛肉拉面', '哈麦德兰州牛肉拉面', '商户消费', 'expense', 'food'],
    ['阿均拉面', '收款方备注:二维码收款', '扫二维码付款', 'expense', 'food'],
    ['麻辣香锅', '麻辣香锅家常菜', '商户消费', 'expense', 'food'],
    ['卡旺卡', '南京龙湖江北天街店到店付', '商户消费', 'expense', 'food'],
    ['luckin coffee', '订单付款', '商户消费', 'expense', 'food'],
    ['蒸味坊鲜包', '蒸味坊鲜包【买单】消费4.00元', '商户消费', 'expense', 'food'],
    ['浦口区开花鸡腿店', '浦口区开花鸡腿店', '商户消费', 'expense', 'food'],
    ['南京慢面包林场店', '4818FU_南京慢面包林场店', '商户消费', 'expense', 'food'],

    // —— 交通：通勤班车 ——
    ['南京力合创展科技服务有限公司', '研创园-虚拟车票购买-20261015074516-JO0DC-bus-ticket', '商户消费', 'expense', 'transport'],
    // 「小红车」是南京本地的共享单车品牌，只有城市名 + 品牌名，没有「单车/骑行」这类品类词。
    // 故意**不为它单独加关键词**：为单个城市品牌建规则，等于把这份账单变成某个人的账本。
    // 留在「其他」是诚实的 —— 宁愿少认，也不要为凑比例硬猜。
    ['小红车', '收款方备注:二维码收款', '扫二维码付款', 'expense', 'other_expense'],

    // —— 购物：便利店/小超，名字里不带「便利店」三个字 ——
    ['便利蜂', '便利蜂购物', '商户消费', 'expense', 'shopping'],
    ['旅途易购', 'FH1F十足', '商户消费', 'expense', 'shopping'],
    ['江北新区芙蓉兴盛', '', '商户消费', 'expense', 'shopping'],

    // —— 住房：生活缴费没有「电费」两个字 ——
    ['国网江苏电力生活缴费', '生活缴费', '商户消费', 'expense', 'housing'],

    // —— 诚实地留在「其他」：看不出是什么行业就不猜 ——
    ['兰花飘香', '收款方备注:二维码收款', '扫二维码付款', 'expense', 'other_expense'],
    ['孙道翔', '收款方备注:二维码收款', '扫二维码付款', 'expense', 'other_expense'],
    ['状元铺子', '', '扫二维码付款', 'expense', 'other_expense']
  ]

  const wrong = []
  for (const [title, product, tradeType, type, expect] of CASES) {
    const r = await call({ action: 'classify', bill: { title, product, tradeType, type } })
    const got = r.category && r.category.id
    if (got !== expect) wrong.push(`「${title}」→ ${got}（期望 ${expect}）`)
  }
  t(wrong.length === 0, wrong.length ? wrong.join('；') : `全部 ${CASES.length} 条命中正确分类`)

  // 交易类型缺失时（手动记账）不能靠它兜底猜错：没关键词就该留在「其他」
  const r = await call({ action: 'classify', bill: { title: '张三', product: '', type: 'expense' } })
  t(r.category.id === 'other_expense', '手动记账没有交易类型时，光一个人名不会被硬判成转账')
}

;(async () => {
  await testClassify()
  await testValidate()
  await testAdd()
  await testEdge()
  await testDuplicate()
  await testIntegration()
  await testRealCorpus()

  console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`)
  process.exit(fail === 0 ? 0 : 1)
})()
