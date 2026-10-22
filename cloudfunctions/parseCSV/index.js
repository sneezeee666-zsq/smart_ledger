// 云函数入口文件 - 解析微信账单（支持 xlsx / csv）
const cloud = require('wx-server-sdk')
const XLSX = require('xlsx')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const _ = db.command

/**
 * 主入口
 */
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID

  // 分支：清空当前用户的所有账单数据
  if (event.action === 'clear') {
    return await clearBills(openid)
  }

  // 分支：导入前去重（对比已有数据，只返回需要新增的部分）
  //
  // ⚠️ 只收「判重键」而不是整条账单，是有原因的：
  //    wx.cloud.callFunction 的 data 有传输大小限制（官方建议临界值 100KB），
  //    超过直接报 `data exceed max size`。一条解析结果有 15 个字段（≈330 字节），
  //    500 条就 ≈165KB —— 必然超限，表现为「去重检查失败」，然后确认页显示 0 条。
  //    而判重只需要 orderNo 等几个字段拼成的一把键（≈40 字节/条），
  //    500 条才 ≈20KB。返回值同样只给「哪些下标已存在」，不把整份账单传回来。
  if (event.action === 'dedup') {
    return await dedupBills(openid, event.keys || [])
  }

  // 分支：删除若干条账单（账单左滑 / 详情页删除共用）
  if (event.action === 'delete') {
    return await deleteBills(openid, event.ids || event.id)
  }

  // 分支：手动记账 —— 校验 + 智能分类 + 服务端写入
  if (event.action === 'add') {
    return await addManualBill(openid, event.bill || {}, !!event.force)
  }

  // 分支：读取单条账单（编辑页预填用；同样带 _openid 归属校验）
  if (event.action === 'detail') {
    return await getBillDetail(openid, event.id)
  }

  // 分支：修改一条已有账单（校验 + 重新分类 + 按 _openid 限定更新范围）
  if (event.action === 'update') {
    return await updateManualBill(openid, event.id, event.bill || {}, !!event.force)
  }

  // 分支：按最新规则重新识别历史账单的分类（只改分类字段，不动金额/时间/_openid）
  if (event.action === 'reclassify') {
    return await reclassifyBills(openid, event)
  }

  // 分支：仅预览分类结果（手动记账页输入时实时提示，不写库）
  if (event.action === 'classify') {
    const b = event.bill || {}
    const t = b.type === 'income' ? 'income' : 'expense'
    return {
      code: 0,
      category: smartClassify(b.title || '', b.product || '', '', t, b.tradeType)
    }
  }

  try {
    let buffer

    if (event.fileID) {
      const res = await cloud.downloadFile({ fileID: event.fileID })
      buffer = res.fileContent
    } else if (event.buffer) {
      buffer = Buffer.from(event.buffer, 'base64')
    } else {
      return { code: -1, message: '请提供文件', data: [], count: 0 }
    }

    const fileName = event.fileName || ''
    
    let result = { bills: [], skipped: 0 }
    
    // 根据扩展名或自动检测选择解析方式
    if (/\.xlsx?$/i.test(fileName)) {
      result = parseExcel(buffer)
    } else if (/\.csv$/i.test(fileName)) {
      result = parseCSV(buffer.toString('utf-8'))
    } else {
      // 自动检测：先试 Excel
      try {
        result = parseExcel(buffer)
        if (!result.bills || result.bills.length === 0) throw new Error('empty')
      } catch (e) {
        result = parseCSV(buffer.toString('utf-8'))
      }
    }

    const bills = result.bills || []
    const skipped = result.skipped || 0

    const billsWithMeta = bills.map(bill => ({
      ...bill,
      openid,
      updateTime: Date.now(),
      importTime: new Date().toISOString()
    }))

    let message = `解析成功，共 ${billsWithMeta.length} 条记录`
    if (skipped > 0) {
      message += `（${skipped} 条记录时间无法识别，已跳过）`
    }

    return {
      code: 0,
      message,
      data: billsWithMeta,
      // 判重键，与 data **逐下标对齐**。
      // ⚠️ 单独一个数组，而不是给每条记录加一个 key 字段：
      //    ① 前端拿它只用于去重，绝不该被写进账单文档（会多出一个无关字段）；
      //    ② 去重只需要这把键，把整条记录传给云函数会超出 callFunction 的大小限制。
      // ⚠️ 必须用**入库前**的字段算：写库后 orderNo/createTime/amount/title/type
      //    五个字段原样保留，所以这把键对「库里的文档」同样成立，两边才对得上。
      keys: bills.map(bill => makeBillKey(bill)),
      count: billsWithMeta.length,
      skipped
    }

  } catch (err) {
    console.error('parseBill error:', err)
    return { code: -1, message: err.message || '解析失败', data: [], count: 0 }
  }
}

// ==================== 重新识别分类 ====================

/**
 * 把**已入库**的账单按当前规则重新分类
 *
 * 为什么需要它：
 *   分类是在**导入那一刻**算好写进文档的（categoryId/icon/color 一起存）。
 *   后来改了关键词，新导入的账用新规则，库里的老记录却还是旧结论 ——
 *   统计页按 categoryId 聚合，于是「其他支出」的比例一动不动，
 *   用户会认为「规则白改了」。清空重导能解决，但代价是把数据全删一遍。
 *
 * 设计取舍：
 *  - **分批 + _id 游标**：云函数 3 秒超时，一次扫全量必然中断。按 `_id` 升序游标
 *    比 skip 分页稳（skip 在并发写时会漏记录），中途失败重跑也是幂等的。
 *  - **只写有变化的记录**：绝大多数记录分类不会变，白写一遍既慢，
 *    又会让 updateTime 失去「用户真的动过」的含义。
 *  - **不碰 amount / createTime / _openid**：分类迁移不该改账目本身。
 *
 * ⚠️ 更新必须用 where({_id, _openid})：云函数以管理员身份运行、绕过集合权限，
 *    只按 _id 更新等于「谁拿到别人的 id 都能改别人的分类」。
 *
 * @param {string} event.lastId 上一批最后一条的 _id（首次传空串）
 */
async function reclassifyBills(openid, event) {
  const BATCH = 20
  const lastId = String(event.lastId || '')

  try {
    const where = { _openid: openid }
    if (lastId) where._id = _.gt(lastId)

    const res = await db.collection('bills')
      .where(where)
      .field({
        title: true, product: true, tradeType: true, type: true,
        category: true, categoryId: true, icon: true, color: true
      })
      .orderBy('_id', 'asc')
      .limit(BATCH)
      .get()

    const docs = (res && res.data) || []
    if (!docs.length) {
      return { code: 0, data: { scanned: 0, updated: 0, done: true, lastId: lastId } }
    }

    const jobs = []
    let changed = 0
    for (const d of docs) {
      const c = smartClassify(d.title || '', d.product || '', '', d.type, d.tradeType)
      if (d.categoryId === c.id && d.category === c.name &&
        d.icon === c.icon && d.color === c.color) continue
      changed++
      jobs.push(
        db.collection('bills')
          .where({ _id: d._id, _openid: openid })
          .update({ data: { category: c.name, categoryId: c.id, icon: c.icon, color: c.color } })
      )
    }
    if (jobs.length) await Promise.all(jobs)

    return {
      code: 0,
      data: {
        scanned: docs.length,
        updated: changed,
        // 不满一批就说明扫到底了
        done: docs.length < BATCH,
        lastId: docs[docs.length - 1]._id
      }
    }
  } catch (err) {
    console.error('reclassify error:', err)
    return { code: -1, message: err.message || '重新识别失败', data: null }
  }
}

// ==================== 清空数据 ====================

/**
 * 清空当前用户的所有账单记录
 * 使用「条件批量删除」一次性删掉，避免逐条删除导致 3 秒超时
 */
async function clearBills(openid) {
  try {
    let deleted = 0

    // 云函数端 where().remove() 是批量删除（一次可删上千条）
    // 循环几轮兜底，防止单次删除有条数上限
    for (let round = 0; round < 20; round++) {
      const res = await db.collection('bills')
        .where({ _openid: openid })
        .remove()

      const removed = (res.stats && res.stats.removed) || 0
      deleted += removed

      if (removed === 0) break
    }

    return { code: 0, message: `已清空 ${deleted} 条账单记录`, deleted }
  } catch (err) {
    console.error('clearBills error:', err)
    return { code: -1, message: '清空失败: ' + err.message, deleted: 0 }
  }
}

// ==================== 删除账单 ====================

// 一次最多删多少条：目前所有入口都是单条删除，留出余量给以后的批量清理
const MAX_DELETE = 50

/**
 * 删除若干条账单（首页「减一笔」、账单列表左滑、详情页的删除按钮共用这一个动作）
 *
 * ⚠️ 为什么必须把 _openid 一起写进查询条件，而不是 db.collection('bills').doc(id).remove()？
 *    id 是**客户端传来的**，不可信。云函数以管理员身份执行、会绕过集合权限，
 *    只按 _id 删的话，谁构造出别人的 id 就能删掉别人的账单。
 *    这里把 _openid 作为条件的一部分：越权的 id 根本查不到 → removed 为 0，
 *    既不会误删，也能让前端拿到"没删掉"的真实反馈。
 *
 * @param {string}   openid
 * @param {string|string[]} ids 单个 id 或 id 数组
 * @returns {Object} { code, message, deleted, requested }
 */
async function deleteBills(openid, ids) {
  try {
    const raw = Array.isArray(ids) ? ids : [ids]

    // 去重 + 去空：前端可能把同一个 id 传两次（例如手指抖了两次）
    const list = []
    const seen = {}
    raw.forEach(v => {
      const id = trimStr(v)
      if (!id || seen[id]) return
      seen[id] = true
      list.push(id)
    })

    if (!list.length) {
      return { code: -1, message: '缺少要删除的记录 id', deleted: 0, requested: 0 }
    }
    if (list.length > MAX_DELETE) {
      return { code: -1, message: `一次最多删除 ${MAX_DELETE} 条记录`, deleted: 0, requested: list.length }
    }

    const res = await db.collection('bills')
      .where({ _id: _.in(list), _openid: openid })
      .remove()

    const deleted = (res.stats && res.stats.removed) || 0

    return {
      code: 0,
      // deleted 为 0 说明记录早被删了、或者不属于当前用户 —— 不算异常，如实返回
      message: deleted ? `已删除 ${deleted} 条记录` : '记录不存在或无权删除',
      deleted,
      requested: list.length
    }
  } catch (err) {
    console.error('deleteBills error:', err)
    return { code: -1, message: '删除失败: ' + err.message, deleted: 0, requested: 0 }
  }
}

// ==================== 导入去重 ====================

/**
 * 生成账单的唯一标识（用于判重）
 * 优先用「交易单号」（微信账单里每笔交易唯一）；
 * 没有单号时用「时间+金额+对方+收支」组合兜底。
 */
function makeBillKey(bill) {
  if (!bill) return ''

  const no = String(bill.orderNo || '').trim()
  if (no && no !== '/' && no !== 'undefined' && no !== 'null') {
    return 'no:' + no
  }

  return 'c:' + [
    bill.createTime || 0,
    bill.amount || 0,
    String(bill.title || '').trim(),
    bill.type || ''
  ].join('|')
}

/**
 * 导入前去重：查出「提交的这些键里，哪些已经在库里」
 *
 * ⚠️ 这里只做「与库里比」这一半；「本批次内部重复」由前端用同一把键本地判
 *    （utils/bill-dedup.js）。这样前端可以**分批**提交键 —— 任意大的文件
 *    都不会撑爆单次调用 —— 而批内去重依然完整（本地 Set 跨越所有批次）。
 *
 * @param {string} openid
 * @param {Array<string>} keys 本次解析出的判重键
 * @returns {Object} { code, data: { dupIdx, existing }, duplicates, existing }
 *   dupIdx = 在提交的 keys 数组中、已在库里的**下标**
 */
async function dedupBills(openid, keys) {
  try {
    if (!Array.isArray(keys) || keys.length === 0) {
      return { code: 0, data: { dupIdx: [], existing: 0 }, duplicates: 0, existing: 0 }
    }

    // 1) 拉取已有账单的判重字段（只取 5 个字段，不拉整条文档）
    const existingKeys = {}
    let existingCount = 0
    const LIMIT = 1000

    for (let round = 0; round < 20; round++) {
      const res = await db.collection('bills')
        .where({ _openid: openid })
        .field({ orderNo: true, createTime: true, amount: true, title: true, type: true })
        .skip(round * LIMIT)
        .limit(LIMIT)
        .get()

      if (!res.data || res.data.length === 0) break

      res.data.forEach(doc => {
        existingKeys[makeBillKey(doc)] = true
        existingCount++
      })

      if (res.data.length < LIMIT) break
    }

    // 2) 只回下标：数字数组比回传整份账单小两个数量级
    const dupIdx = []
    keys.forEach((k, i) => {
      if (existingKeys[k]) dupIdx.push(i)
    })

    return {
      code: 0,
      message: `检出重复 ${dupIdx.length} 条`,
      data: { dupIdx, existing: existingCount },
      duplicates: dupIdx.length,
      existing: existingCount
    }
  } catch (err) {
    console.error('dedupBills error:', err)
    return {
      code: -1,
      message: '去重失败: ' + err.message,
      data: { dupIdx: [], existing: 0 },
      duplicates: 0,
      existing: 0
    }
  }
}

// ==================== 手动记账 ====================

// 手动录入的长度/数值上限，防止误输入把统计搞乱
const MANUAL_LIMITS = {
  maxAmount: 100000000,   // 1 亿
  maxTitleLen: 60,
  maxProductLen: 120,
  maxShortLen: 30         // 交易类型 / 支付方式 / 当前状态
}

function trimStr(v, max) {
  const s = String(v === undefined || v === null ? '' : v).trim()
  if (max && s.length > max) return s.slice(0, max)
  return s
}

/**
 * 手动录入的字段校验（「记一笔」与「改一笔」共用）
 *
 * ⚠️ 为什么必须抽出来共用、而不是两边各写一份？
 *    规则一旦漂移就会出现「新增时拦住了负数金额，编辑时却能存进去」这类
 *    单向成立的口子 —— 不报任何错，只是数据悄悄脏了。
 *
 * @returns {Object} 不通过时 { error:'给用户看的原因' }；
 *                   通过时 { type, amount, timestamp, title, product }
 */
function normalizeManualInput(input) {
  const type = input.type === 'income' ? 'income' : 'expense'

  const rawAmount = String(input.amount === undefined ? '' : input.amount)

  // parseAmount 内部取绝对值，不拦的话 "-5" 会被悄悄当成 5
  if (rawAmount.indexOf('-') !== -1) {
    return { error: '金额不能为负数' }
  }

  const amount = parseAmount(rawAmount)
  if (!(amount > 0)) {
    return { error: '请输入大于 0 的金额' }
  }
  if (amount > MANUAL_LIMITS.maxAmount) {
    return { error: '金额过大，请检查是否输错' }
  }

  const dateStr = trimStr(input.date)
  const timeStr = trimStr(input.time)
  if (!dateStr) {
    return { error: '请选择交易日期' }
  }

  const timestamp = toTimestamp(timeStr ? dateStr + ' ' + timeStr : dateStr)
  if (timestamp === null) {
    return { error: '交易时间无法识别，请重新选择' }
  }

  return {
    type,
    amount: Math.round(amount * 100) / 100,
    timestamp,
    title: trimStr(input.title, MANUAL_LIMITS.maxTitleLen)
      || (type === 'income' ? '收入' : '支出'),
    product: trimStr(input.product, MANUAL_LIMITS.maxProductLen)
  }
}

/**
 * 是否存在「同一秒 + 同金额 + 同对方 + 同收支」的记录
 *
 * ⚠️ exceptId 是编辑场景的关键：什么都不改直接点保存时，命中的永远是**自己那条**，
 *    不排除掉就会弹「疑似重复」——用户明明一个字段都没动却被质问，
 *    只能一脸疑惑地点「仍要保存」。这种提示很快就没人看了，等于白做。
 *
 * @param {string} exceptId 要排除的 _id（新增时传空串）
 */
async function hasDuplicate(openid, v, exceptId) {
  const res = await db.collection('bills').where({
    _openid: openid,
    createTime: v.timestamp,
    amount: v.amount,
    title: v.title,
    type: v.type
  }).get()

  const rows = (res && res.data) || []
  return rows.some(r => r._id !== exceptId)
}

/**
 * 手动添加一条账单
 *
 * 设计要点：
 *  1. 与微信账单导入**共用同一份 smartClassify 规则**，字段结构也完全一致，
 *     因此首页/统计/账单页无需区分数据来源，直接混在一起统计即可。
 *  2. 交易时间由客户端传「日期 + 时间」两个字符串，云端用与导入路径相同的
 *     toTimestamp() 换算成 UTC+8 时间戳 —— 避免前后端各写一套时区逻辑。
 *  3. ⚠️ 云函数写入**不会**自动注入 _openid，必须显式带上，
 *     否则 getStatistics 里 `where({ _openid })` 查不到这条记录。
 *
 * @param {string}  openid
 * @param {Object}  input  { date, time, type, amount, title, product, tradeType, payMethod, status }
 * @param {boolean} force  跳过「疑似重复」提示，强制保存
 */
async function addManualBill(openid, input, force) {
  try {
    // ---------- 1) 校验（与「改一笔」共用同一套规则） ----------
    const v = normalizeManualInput(input)
    if (v.error) return { code: -1, message: v.error }

    const { type, amount: finalAmount, timestamp, title, product } = v

    // ---------- 2) 疑似重复检查（同一秒 + 同金额 + 同对方 + 同收支） ----------
    // 主要用于拦住「保存成功但网络超时后重试」造成的重复写入
    if (!force && await hasDuplicate(openid, v, '')) {
      return {
        code: 2,
        duplicate: true,
        message: '已存在完全相同的记录，可能重复提交'
      }
    }

    // ---------- 3) 智能分类（与导入共用规则） ----------
    const catInfo = smartClassify(title, product, '', type, input.tradeType)

    // ---------- 4) 组装文档，字段与 parseExcel/parseCSV 的产出保持一致 ----------
    const now = Date.now()
    const doc = {
      time: formatTime(timestamp),
      timeStr: formatFullTime(timestamp),
      title,
      product,
      type,
      amount: finalAmount,
      category: catInfo.name,
      categoryId: catInfo.id,
      icon: catInfo.icon,
      color: catInfo.color,
      tradeType: trimStr(input.tradeType, MANUAL_LIMITS.maxShortLen),
      payMethod: trimStr(input.payMethod, MANUAL_LIMITS.maxShortLen),
      status: trimStr(input.status, MANUAL_LIMITS.maxShortLen),
      orderNo: '',            // 手动记账没有微信交易单号
      merchantNo: '',
      source: 'manual',       // 标记来源，便于以后按来源筛选
      createTime: timestamp,
      updateTime: now,
      _openid: openid
    }

    const res = await db.collection('bills').add({ data: doc })

    return {
      code: 0,
      message: `已记录${type === 'income' ? '收入' : '支出'} ¥${finalAmount.toFixed(2)}`,
      data: { _id: res._id, ...doc }
    }
  } catch (err) {
    console.error('addManualBill error:', err)
    return { code: -1, message: '保存失败: ' + (err.message || '未知错误') }
  }
}

// ==================== 读取 / 修改单条账单 ====================

/**
 * 读取单条账单（编辑页预填用）
 *
 * ⚠️ 用 where 而不是 doc(id).get()：doc() 不带任何条件，而云函数以管理员身份执行、
 *    会绕过集合权限 —— 只要构造出别人的 _id 就能读到别人的账。条件里必须带 _openid。
 */
async function getBillDetail(openid, id) {
  try {
    const billId = trimStr(id)
    if (!billId) return { code: -1, message: '缺少记录 id' }

    const res = await db.collection('bills')
      .where({ _id: billId, _openid: openid })
      .limit(1)
      .get()

    const doc = (res && res.data && res.data[0]) || null
    if (!doc) return { code: -1, message: '记录不存在或无权查看' }

    return { code: 0, data: doc }
  } catch (err) {
    console.error('getBillDetail error:', err)
    return { code: -1, message: '读取失败: ' + (err.message || '未知错误') }
  }
}

/**
 * 修改一条已有账单
 *
 * 与删除同理，这是「能改坏别人数据」的动作：云函数绕过集合权限，
 * 所以 where 里必须同时带 _id 与 _openid。写成 doc(id).update() 等于
 * 谁构造出别人的 id 就能改别人的账。
 *
 * 字段取舍：
 *   - category / icon / color **按新内容重新识别** —— 用户改「交易对方」
 *     本来就是为了让它归到正确的类目；
 *   - source / orderNo / merchantNo / _openid **一律不动**：_openid 一改等于
 *     把这条记录送给别人，orderNo 是核对微信账单的唯一凭据，编辑一次不该抹掉。
 *
 * @returns {Object} 一条都没改到（不存在 / 不是自己的）时 code=-1，
 *   而不是像 delete 那样 code=0 + 0 条 —— 编辑没有「部分成功」的语义，没改到就是失败。
 */
async function updateManualBill(openid, id, input, force) {
  try {
    const billId = trimStr(id)
    if (!billId) return { code: -1, message: '缺少要修改的记录 id', updated: 0 }

    // ---------- 1) 校验（与「记一笔」完全同一套规则） ----------
    const v = normalizeManualInput(input)
    if (v.error) return { code: -1, message: v.error, updated: 0 }

    // ---------- 2) 疑似重复检查（排除自己这条） ----------
    if (!force && await hasDuplicate(openid, v, billId)) {
      return {
        code: 2,
        duplicate: true,
        message: '已存在另一条完全相同的记录',
        updated: 0
      }
    }

    // ---------- 3) 重新识别分类 ----------
    const catInfo = smartClassify(v.title, v.product, '', v.type, input.tradeType)

    // ---------- 4) 更新（条件里既有 _id 也有 _openid） ----------
    const patch = {
      time: formatTime(v.timestamp),
      timeStr: formatFullTime(v.timestamp),
      title: v.title,
      product: v.product,
      type: v.type,
      amount: v.amount,
      category: catInfo.name,
      categoryId: catInfo.id,
      icon: catInfo.icon,
      color: catInfo.color,
      tradeType: trimStr(input.tradeType, MANUAL_LIMITS.maxShortLen),
      payMethod: trimStr(input.payMethod, MANUAL_LIMITS.maxShortLen),
      status: trimStr(input.status, MANUAL_LIMITS.maxShortLen),
      createTime: v.timestamp,
      updateTime: Date.now()
    }

    const res = await db.collection('bills')
      .where({ _id: billId, _openid: openid })
      .update({ data: patch })

    const updated = (res.stats && res.stats.updated) || 0
    if (!updated) {
      return { code: -1, message: '记录不存在或无权修改', updated: 0 }
    }

    return {
      code: 0,
      message: `已修改${v.type === 'income' ? '收入' : '支出'} ¥${v.amount.toFixed(2)}`,
      updated,
      data: { _id: billId, ...patch }
    }
  } catch (err) {
    console.error('updateManualBill error:', err)
    return { code: -1, message: '保存失败: ' + (err.message || '未知错误'), updated: 0 }
  }
}

// ==================== Excel 解析 ====================

function parseExcel(buffer) {
  // 使用 SheetJS 解析
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  
  if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('无法解析 Excel 文件')
  }

  // 获取第一个工作表
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  
  // 转为二维数组
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  
  if (!rows || rows.length < 2) {
    throw new Error('Excel 数据为空')
  }

  // 查找表头行 - 微信账单表头包含"交易时间"
  let headerRowIndex = -1
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const row = rows[i]
    if (!row) continue
    const rowStr = row.join('').replace(/\s/g, '')
    // 精确匹配：必须同时有"交易时间"和"收/支"或"金额"
    if (rowStr.includes('交易时间') && (rowStr.includes('收/支') || rowStr.includes('金额'))) {
      headerRowIndex = i
      break
    }
  }

  if (headerRowIndex === -1) {
    throw new Error('未找到账单表头，请确认文件格式正确')
  }

  const headers = rows[headerRowIndex]
  const fieldMap = buildFieldMap(headers)

  console.log(`表头在第${headerRowIndex}行:`, headers.slice(0, 8))
  console.log('字段映射:', fieldMap)

  // 解析数据行
  const bills = []
  let skipped = 0
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i]
    
    // 跳过空行、分隔线、合计行
    if (!row || !row.length || isInvalidRow(row)) continue
    
    const bill = extractBill(row, fieldMap)
    if (bill && bill.amount > 0) {
      bills.push(bill)
    } else {
      skipped++
    }
  }

  return { bills, skipped }
}

// ==================== CSV 解析 ====================

function parseCSV(content) {
  const lines = content.split('\n').filter(line => line.trim())
  
  if (lines.length < 2) throw new Error('CSV 内容为空')

  let headerRowIndex = 0
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const line = lines[i]
    if (line.includes('交易时间') && (line.includes('收/支') || line.includes('金额'))) {
      headerRowIndex = i
      break
    }
  }

  const headers = parseCSVLine(lines[headerRowIndex])
  const fieldMap = buildFieldMap(headers)

  const bills = []
  let skipped = 0
  for (let i = headerRowIndex + 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i])
    if (values.length < 3) continue
    
    const bill = extractBill(values, fieldMap)
    if (bill && bill.amount > 0) {
      bills.push(bill)
    } else {
      skipped++
    }
  }

  return { bills, skipped }
}

function parseCSVLine(line) {
  const result = []
  let current = '', inQuotes = false
  
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

// ==================== 字段映射 ====================

/**
 * 构建字段索引映射 - 针对微信账单标准格式
 */
function buildFieldMap(headers) {
  const h = headers.map(v => String(v || '').trim())

  const map = {}
  
  // 微信账单标准字段名 → 内部字段名
  const mappings = [
    { names: ['交易时间', '时间', '日期'], target: 'time' },
    { names: ['交易类型', '类型'], target: 'tradeType' },
    { names: ['交易对方', '对方', '商户'], target: 'title' },
    { names: ['商品', '商品说明', '备注', '商品详情'], target: 'product' },
    { names: ['收/支', '收支类型', '收支'], target: 'type' },       // 关键！微信用"收/支"
    { names: ['金额(元)', '金额', '数额', '¥'], target: 'amount' },     // 关键！微信用"金额(元)"
    { names: ['支付方式', '方式', '收付款方式'], target: 'payMethod' },
    { names: ['当前状态', '状态', '交易状态', '资金状态'], target: 'status' },
    { names: ['交易单号', '单号', '订单号'], target: 'orderNo' },
    { names: ['商户单号'], target: 'merchantNo' },
    { names: ['备注', '备注信息'], target: 'remark' },
    { names: ['交易分类', '分类', '类别'], target: 'category' }
  ]

  mappings.forEach(m => {
    const idx = h.findIndex(name => m.names.some(n => name === n || name.includes(n)))
    if (idx !== -1) map[m.target] = idx
  })

  return map
}

// ==================== 数据提取 ====================

/**
 * 从一行数据提取账单记录
 */
function extractBill(values, map) {
  // 获取原始值
  const rawTimeValue = values[map.time]                          // ⚠️ 保留原始类型（可能是 Date / 数字序列号 / 字符串）
  const rawType = String(values[map.type] || '').trim()           // "收入"/"支出"/"/"
  const rawTitle = String(values[map.title] || '').trim()
  const rawProduct = String(values[map.product] || '').trim()
  const rawAmount = String(values[map.amount] || '').trim()
  const rawCategory = String(values[map.category] || '').trim()

  // 跳过无效的收支类型（中性交易 "/"）
  if (!rawType || rawType === '/' || rawType === '中性') return null

  // 解析金额
  const amount = parseAmount(rawAmount)
  if (amount <= 0) return null

  // 解析「真实交易时间」
  const timestamp = toTimestamp(rawTimeValue)
  if (timestamp === null) return null   // 时间无法识别 → 跳过（避免用导入时间冒充）

  // 判断收支类型
  const type = (rawType === '收入') ? 'income' : 'expense'

  // 组合标题：优先用交易对方，没有则用商品名
  const title = rawTitle || rawProduct || '未知'

  // 智能分类
  const catInfo = smartClassify(title, rawProduct, rawCategory, type, values[map.tradeType])

  return {
    time: formatTime(timestamp),
    timeStr: formatFullTime(timestamp),
    title: title,
    product: rawProduct,
    type: type,
    amount: Math.round(amount * 100) / 100,
    category: catInfo.name,
    categoryId: catInfo.id,
    icon: catInfo.icon,
    color: catInfo.color,
    payMethod: String(values[map.payMethod] || '').trim(),
    status: String(values[map.status] || '').trim(),
    tradeType: String(values[map.tradeType] || '').trim(),
    orderNo: String(values[map.orderNo] || '').trim(),
    createTime: timestamp
  }
}

// ==================== 工具函数 ====================

/**
 * 判断是否为无效行（空行/分隔线/合计）
 */
function isInvalidRow(row) {
  const firstVal = String(row[0] || '').trim()
  
  // 空行
  if (!firstVal) return true
  
  // 分隔线
  if (/^[-=—]+$/.test(firstVal)) return true
  
  // 合计/统计行
  if (/^(共|合计|总计|收入|支出|中性)/.test(firstVal)) return true
  
  // 注释行
  if (/^(注|说明|1\.|2\.|3\.|4\.)/.test(firstVal)) return true
  
  return false
}

/**
 * 解析金额字符串
 */
function parseAmount(str) {
  if (!str) return 0
  
  // 移除 ¥ ￥ € $ 符号和逗号
  const cleaned = str.replace(/[¥￥€$,\s]/g, '').trim()
  const num = parseFloat(cleaned)
  
  return isNaN(num) ? 0 : Math.abs(num)
}

/**
 * 统一把「交易时间」原始值转成正确的时间戳
 *
 * ⚠️ 关键：微信账单 xlsx 里的「交易时间」是**日期格式单元格**，
 *    SheetJS 会读成 **Excel 日期序列号（数字）**，不是字符串！
 *    另外还要兼容 Date 对象和文本三种情况。
 *
 * ⚠️ 微信账单时间均为 UTC+8，云函数环境为 UTC，必须按 UTC+8 换算。
 *
 * @returns {number|null} 时间戳（毫秒），无法识别时返回 null
 */
function toTimestamp(value) {
  if (value === null || value === undefined || value === '') return null

  // ① 数字 → Excel 日期序列号
  if (typeof value === 'number') {
    return serialToTimestamp(value)
  }

  // ② Date 对象
  if (Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) return null
    return Date.UTC(
      value.getFullYear(), value.getMonth(), value.getDate(),
      value.getHours(), value.getMinutes(), value.getSeconds()
    ) - 8 * 60 * 60 * 1000
  }

  // ③ 字符串
  const str = String(value).trim()

  // ③a 纯数字字符串也可能是序列号（例如 "46310.50909722"）
  if (/^\d+(\.\d+)?$/.test(str)) {
    const num = parseFloat(str)
    if (num > 20000 && num < 80000) {
      return serialToTimestamp(num)
    }
    return null
  }

  // ③b 常规日期字符串
  return parseTimestamp(str)
}

/**
 * Excel 日期序列号 → 时间戳
 * Excel 1900 日期系统：序列号 1 = 1900-01-01
 * 基准取 1899-12-30（补偿 Excel 的 1900 闰年 bug）
 */
function serialToTimestamp(serial) {
  if (typeof serial !== 'number' || isNaN(serial) || serial <= 0) return null

  // 合理范围保护：20000 ≈ 1954-09-17，80000 ≈ 2119-01-05
  // 超出范围的数字基本不是日期序列号（可能是金额、单号等），一律丢弃
  if (serial < 20000 || serial > 80000) return null

  const days = Math.floor(serial)
  const frac = serial - days

  const baseUtc = Date.UTC(1899, 11, 30)
  const dayDate = new Date(baseUtc + days * 86400000)

  const year = dayDate.getUTCFullYear()
  const month = dayDate.getUTCMonth()
  const day = dayDate.getUTCDate()

  // 小数部分 = 当天时间
  let secs = Math.round(frac * 86400)
  if (secs >= 86400) secs = 86399
  const hour = Math.floor(secs / 3600)
  const minute = Math.floor((secs % 3600) / 60)
  const second = secs % 60

  const ts = Date.UTC(year, month, day, hour, minute, second) - 8 * 60 * 60 * 1000
  return isNaN(ts) ? null : ts
}

/**
 * 解析日期字符串（不含数字序列号）
 * @returns {number|null}
 */
function parseTimestamp(str) {
  if (!str) return null

  // 微信格式: "2026-10-15 12:13:06"
  const formats = [
    /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/,
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/
  ]

  for (const fmt of formats) {
    const m = str.match(fmt)
    if (m) {
      const year = parseInt(m[1])
      const month = parseInt(m[2]) - 1
      const day = parseInt(m[3])
      const hour = parseInt(m[4] || 0)
      const minute = parseInt(m[5] || 0)
      const second = parseInt(m[6] || 0)

      // 先做范围校验，避免 Date.UTC 把 13 月 / 45 日 / 99 时静默进位
      if (month < 0 || month > 11) continue
      if (day < 1 || day > 31) continue
      if (hour > 23 || minute > 59 || second > 59) continue

      const utcMs = Date.UTC(year, month, day, hour, minute, second)
      const d = new Date(utcMs)

      // 回环校验：2 月 30 日这类会进位的非法日期一律丢弃
      if (
        d.getUTCFullYear() !== year ||
        d.getUTCMonth() !== month ||
        d.getUTCDate() !== day
      ) continue

      // 按 UTC 构造，再减去 8 小时，得到该「北京时间」对应的真实时间戳
      return utcMs - 8 * 60 * 60 * 1000
    }
  }

  return null
}

/**
 * 格式化时间为显示字符串（明确按 UTC+8 输出，不受服务器时区影响）
 */
function formatTime(ts) {
  const d = new Date(ts + 8 * 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/**
 * 完整时间：YYYY-MM-DD HH:mm（UTC+8）
 */
function formatFullTime(ts) {
  const d = new Date(ts + 8 * 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/**
 * 智能分类 - 基于关键词匹配
 *
 * 三条约定：
 *  1. 【收支必须隔离】规则用 kind 标出归属，只和当前 type 的规则比对。
 *     否则收入记录会被支出规则抢先命中：微信的退款单「商品」常常照抄原始商户名
 *     （例如「美团外卖订单退款」），'外卖' 先命中餐饮，一笔收入就被贴上支出分类。
 *  2. 【顺序即优先级】数组从上到下，命中即返回，所以宽词要放在窄词后面
 *     （例如 '退款' 若与 '外卖' 同属支出侧，就必须让更具体的规则先匹配）。
 *  3. 【资金往来不是消费】转账 / 红包是钱在挪位置，不是买到了什么，
 *     单独归「转账往来」。**这条必须用交易类型判，不能靠商户名猜** ——
 *     「妈」「媳妇儿」「312 (MavR1ck)」这类名字永远猜不出行业。
 *     2026-10 用一份真实微信账单实测：174 笔支出里 96 笔 / ¥2006.78（47.2%）
 *     落进「其他支出」，其中转账与红包是最大的一块。
 *
 * ⚠️ 关键词只写**品类词**与全国性连锁品牌，不要为某一份账单塞单店名：
 *    单店名既覆盖不了别的用户，也等于把这份文件变成某个人的账本。
 *    实测里「兰花飘香」「包琪正丨浦口店」这类小微摊贩仍留在「其他支出」——
 *    这是对的：看不出行业就老实说不知道，硬猜会把早饭记成宠物用品。
 *
 * 颜色取自与 getStatistics 的 CATEGORY_META 相同的色板（两处需保持一致）：
 * 旧色板里的 #FFEAA7 / #F7DC6F / #98D8C8 这类浅色在白底卡片上几乎看不清。
 */
function smartClassify(title, product, originalCat, type, tradeType) {
  const text = (title + ' ' + product + ' ' + originalCat).toLowerCase()
  const want = type === 'income' ? 'income' : 'expense'
  // 微信账单「交易类型」列：转账 / 微信红包（群红包）/ 扫二维码付款 / 商户消费 …
  const tt = String(tradeType || '').toLowerCase()

  // ===== 零阶：明确的资金往来，它不是消费 =====
  // ⚠️ 见上方约定 ③。用**交易类型**这条确定性信号，而不是靠商户名猜：
  //    「妈」「媳妇儿」「312 (MavR1ck)」这类名字永远猜不出是什么行业，
  //    猜错的代价是被记成某个消费类目，比留在「其他」更糟。
  // ⚠️ 必须排除退款：退款单的交易类型写作「转账-退款」，也含「转账」，
  //    但那是冲正，不是把钱转给谁。
  if (want === 'expense' && /转账|红包/.test(tt) && tt.indexOf('退款') === -1) {
    return { id: 'transfer', name: '转账往来', icon: '💸', color: '#64748B' }
  }

  const rules = [
    // ===== 支出分类 =====
    // 转账往来：交易类型缺失时（手动记账）靠关键词兜底
    { kind:'expense', kw: ['转账','红包','代付','信用卡还款','花呗还款','借款','还款'], id:'transfer', name:'转账往来', icon:'💸', color:'#64748B' },
    // 订阅/软件：App Store / iCloud / API / 云服务这类按月的数字服务单独成一类，
    // 目的是让「每月固定扣的那几笔」在统计里看得见（固定支出识别也依赖它）。
    // ⚠️ 这里**不放** Steam / 蒸汽平台：买断一款游戏属于娱乐，不是订阅。
    { kind:'expense', kw: ['apple.com','itunes','app store','icloud','google play','deepseek','api服务','openai','chatgpt','claude','github','notion','figma','adobe','阿里云','腾讯云','云服务','服务器','域名'], id:'subscription', name:'订阅/软件', icon:'🧩', color:'#7C3AED' },
    // ⚠️ 娱乐必须排在餐饮之前：美团/饿了么/抖音这些是**渠道**不是品类，
    //    商品名里常带「美团App」（如「泰谷里·影院足道·汤泉SPA-美团App-26…」），
    //    餐饮规则里有「美团」，排在前面就会把一次足道记成一顿饭。
    //    行业词（ktv/足道/汤泉/景区）比平台名更具体，所以让它先匹配。
    { kind:'expense', kw: ['游戏','视频','音乐','会员','电影','娱乐','直播','打赏','腾讯视频','爱奇艺','优酷','bilibili','B站','b站','快手','抖音','芒果TV','Spotify','QQ音乐','网易云音乐','酷狗','唱吧','斗鱼','虎牙','Steam','蒸汽平台','valve','游戏充值','皮肤','点券','ktv','汤泉','足道','温泉','景区','公园','登山','露营','户外','彩票','福彩','台球','桌游','密室','剧本杀','网咖','电竞','旅游','旅行','门票','演出','展览','博物馆'], id:'entertainment', name:'娱乐', icon:'🎮', color:'#EC4899' },
    { kind:'expense', kw: ['外卖','美团','饿了么','快餐店','小吃','食堂','餐饮','美食','饭','餐','咖啡','星巴克','奶茶','喜茶','肯德基','麦当劳','必胜客','瑞幸','奈雪','霸王茶姬','库迪','面包','蛋糕','甜点','零食','饮料','水果','超市买菜','生鲜','拉面','面馆','米线','米粉','麻辣烫','香锅','烧烤','火锅','排档','包子','鲜包','早点','早餐','炸鸡','鸡腿','卤味','熟食','砂锅','luckin','卡旺卡','蜜雪冰城','古茗','茶百道'], id:'food', name:'餐饮', icon:'🍜', color:'#F97316' },
    { kind:'expense', kw: ['地铁','公交','打车','滴滴','出行','加油','停车','高速','火车','飞机','携程','车费','神州','高德','哈啰','嘀嗒','顺风车','共享单车','哈啰单车','美团单车','公交车','出租车','网约车','客运','机票','火车票','动车','高铁','泊车','违章','驾照','加油卡','ETC','车票','单车','骑行','bus-ticket','班车','乘车码','交通卡','过路费','洗车'], id:'transport', name:'交通', icon:'🚗', color:'#0EA5E9' },
    { kind:'expense', kw: ['淘宝','京东','拼多多','购物','超市','便利店','商场','天猫','亚马逊','抖音小店','唯品会','苏宁','盒马','永辉','大润发','沃尔玛','7-11','全家','罗森','优衣库','ZARA','HM','服饰','服装','鞋帽','化妆品','护肤品','香水','箱包','眼镜','首饰','饰品','便利蜂','十足','芙蓉兴盛','小卖部','百货','日用品','美宜佳','名创优品'], id:'shopping', name:'购物', icon:'🛒', color:'#8B5CF6' },
    { kind:'expense', kw: ['房租','房贷','物业','水电','燃气','宽带','取暖','住房','租房','水费','电费','燃气费','物业费','暖气','维修','装修','家具','家电','家洁','保洁','国家电网','电力','供电','生活缴费','水务','自来水'], id:'housing', name:'住房', icon:'🏠', color:'#F59E0B' },
    { kind:'expense', kw: ['医院','药店','看病','体检','医疗','药品','牙科','眼科','体检中心','药房','挂号','疫苗','保健品','按摩','推拿','美容','理发','洗发','护肤'], id:'medical', name:'医疗健康', icon:'💊', color:'#14B8A6' },
    { kind:'expense', kw: ['教育','培训','课程','书籍','学费','辅导','考试','学习','网课','知识付费','得到','知乎','文具','书店','图书馆','英语','语言','考证','资格','学历','慕课','培训班','辅导班','幼儿园','托儿所'], id:'education', name:'教育', icon:'📚', color:'#6366F1' },
    { kind:'expense', kw: ['话费','流量','手机','联通','电信','移动','wifi','充话费','宽带费','5G','套餐','SIM卡'], id:'communication', name:'通讯', icon:'📱', color:'#06B6D4' },

    // ===== 收入分类 =====
    { kind:'income', kw: ['工资','薪资','发薪','劳务报酬','基本工资','绩效工资','岗位工资','补贴'], id:'salary', name:'工资', icon:'💰', color:'#E5484D' },
    { kind:'income', kw: ['奖金','绩效奖','年终奖','提成','项目奖金','季度奖','月度奖','全勤奖'], id:'bonus', name:'奖金', icon:'🎁', color:'#F97316' },
    { kind:'income', kw: ['理财','利息','收益','分红','基金','股票','投资回报','定投','理财通','余额宝','零钱通','债券','黄金','期货','期权','股息','租金'], id:'investment', name:'理财收益', icon:'📈', color:'#0EA5E9' },
    { kind:'income', kw: ['兼职','副业','外快','稿费','接单','私活','外包','日结'], id:'parttime', name:'兼职', icon:'💼', color:'#14B8A6' },
    // ⚠️ 退款必须排在「红包/转账」之前：退款单的商品常常写作「转账-退款」「退款-转账」，
    //    排在后面就会被别的规则抢先命中，一笔冲正被记成"收到一笔转账"
    { kind:'income', kw: ['退款','退货退款','取消订单退款','退款到账'], id:'refund', name:'退款', icon:'↩️', color:'#14B8A6' },
    { kind:'income', kw: ['红包','微信红包','转账','收款','群红包'], id:'red_packet', name:'红包/转账', icon:'🧧', color:'#EC4899' }
  ]

  for (const rule of rules) {
    if (rule.kind !== want) continue
    if (rule.kw.some(k => text.includes(k.toLowerCase()))) {
      return { id: rule.id, name: rule.name, icon: rule.icon, color: rule.color }
    }
  }

  // 默认分类
  return want === 'income'
    ? { id: 'other_income', name: '其他收入', icon:'💵', color:'#94A3B8' }
    : { id: 'other_expense', name: '其他支出', icon:'📝', color:'#CBD5E1' }
}
