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
  console.log('\n=== 4b) 来源切换（auto / manual）===')
  // ================================================================
  {
    reset()

    await userFn.main({ action: 'setQuickPicks', picks: [pick('地铁', 3), pick('瑞幸', 15)], mode: 'manual' })
    const s1 = await userFn.main({ action: 'getProfile' })
    t(s1.data.quickPicksMode === 'manual', '显式存 manual')

    // ⚠️ 只切来源、不传 picks → 手动列表必须原样保留
    const s2 = await userFn.main({ action: 'setQuickPicks', mode: 'auto' })
    t(s2.code === 0 && s2.data.quickPicksMode === 'auto', '只传 mode 也能保存')
    const s3 = await userFn.main({ action: 'getProfile' })
    t(s3.data.quickPicks.length === 2,
      `只切来源时手动列表没被清空（实际 ${s3.data.quickPicks.length} 条）—— 切回来要能恢复`)
    t(s3.data.quickPicksMode === 'auto', '来源已切到 auto')

    // 再切回 manual
    await userFn.main({ action: 'setQuickPicks', mode: 'manual' })
    const s4 = await userFn.main({ action: 'getProfile' })
    t(s4.data.quickPicksMode === 'manual' && s4.data.quickPicks.length === 2,
      '切回 manual 后列表还是原来那两条')

    // 非法来源
    const s5 = await userFn.main({ action: 'setQuickPicks', mode: 'xx', picks: [] })
    t(s5.code === -1, `非法 mode 被拒（${s5.message}）`)

    // 什么都没传
    const s6 = await userFn.main({ action: 'setQuickPicks' })
    t(s6.code === -1, '既没 picks 也没 mode → 报错（不静默成功）')

    // 老数据兼容：没有 quickPicksMode 字段、但有列表 → 视为 manual
    reset()
    DB.users.push({ _id: 'u1', _openid: 'me', uid: 'x', nickname: '', theme: '', quickPicks: [pick('老数据', 9)] })
    const s7 = await userFn.main({ action: 'getProfile' })
    t(s7.data.quickPicksMode === 'manual',
      '老数据（没有 mode 字段但有列表）→ 视为 manual（不加兼容会让老用户突然全变回推荐）')

    // 老数据：既没有 mode 也没有列表 → auto
    reset()
    DB.users.push({ _id: 'u2', _openid: 'me', uid: 'x', nickname: '', theme: '' })
    const s8 = await userFn.main({ action: 'getProfile' })
    t(s8.data.quickPicksMode === 'auto', '既没 mode 也没列表 → auto')
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

    // ⑥ 显式来源优先于"列表存不存在"
    await userFn.main({ action: 'setQuickPicks', picks: [pick('手动加的', 88)], mode: 'manual' })
    const b1 = await statsFn.main({ action: 'quickPicks' })
    t(b1.data.source === 'user' && b1.data.picks[0].title === '手动加的', 'manual 模式用用户列表')

    await userFn.main({ action: 'setQuickPicks', mode: 'auto' })
    const b2 = await statsFn.main({ action: 'quickPicks' })
    t(b2.data.source === 'auto', `auto 模式走推荐（即使手动列表还在）`)
    t(b2.data.picks.some(p => p.title === '地铁'), '推荐里有地铁')
    t(!b2.data.picks.some(p => p.title === '手动加的'), 'auto 模式下不混入手动列表')

    await userFn.main({ action: 'setQuickPicks', mode: 'manual' })
    const b3 = await statsFn.main({ action: 'quickPicks' })
    t(b3.data.source === 'user' && b3.data.picks[0].title === '手动加的',
      '切回 manual 立刻恢复之前的列表（不用重配）')

    // ⑤ 跨用户
    OPENID = 'other'
    const a5 = await statsFn.main({ action: 'quickPicks' })
    t(a5.data.source === 'auto' && !a5.data.picks.some(p => p.title === '地铁'),
      '别人的配置和账单都不影响我的结果')
  }

  // ================================================================
  console.log('\n=== 7) 配置页：推荐 / 手动 切换（回归） ===')
  // ================================================================
  // 这一节守一个"整页卡死"的 bug：
  //   applyManual() 只把列表换成 myList，却没把 mode 写进 data。
  //   于是切换条永远高亮「推荐」、列表却显示手动内容，而编辑入口的
  //   `wx:if="{{mode === 'manual'}}"` 全被隐藏 → 什么都不能改；
  //   再点「推荐」又被 `mode === this.data.mode` 判成"没变化"直接 return → 彻底卡死。
  //   ⚠️ 第一次切到手动时"看起来还行"（列表确实换了），所以只有
  //      auto → manual → auto 之后才暴露 —— 手动点两次就必现。
  {
    reset()
    // 造 3 次「地铁」，让自动推荐里有内容
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      seq++
      DB.bills.push({
        _id: 'b' + seq, _openid: 'me', createTime: now - i * 86400000,
        amount: 3, type: 'expense', title: '地铁', product: '', categoryId: 'transport'
      })
    }

    let failCloud = null            // 非 null 时下一次写云端直接 reject
    let toasts = []
    const store = {}
    global.wx = {
      getStorageSync: k => (store[k] === undefined ? '' : store[k]),
      setStorageSync: (k, v) => { store[k] = v },
      getWindowInfo: () => ({ windowWidth: 375 }),
      showToast: o => toasts.push(o.title),
      vibrateShort: () => {},
      cloud: {
        callFunction({ name, data }) {
          if (name === 'user' && failCloud) {
            const e = failCloud
            failCloud = null
            return Promise.reject(new Error(e))
          }
          const fn = name === 'user' ? userFn : statsFn
          return fn.main(data || {}).then(result => ({ result }))
        }
      }
    }

    // 页面只用到 theme.attach（换肤），单测里不需要
    const theme = require(path.join(__dirname, '..', 'utils', 'theme.js'))
    theme.attach = () => {}

    let cfg = null
    global.Page = c => { cfg = c }
    require(path.join(__dirname, '..', 'pages/quick-manage/quick-manage.js'))
    global.Page = undefined

    const makePage = () => Object.assign({}, cfg, {
      data: JSON.parse(JSON.stringify(cfg.data)),
      setData(patch) { Object.assign(this.data, patch) }
    })
    const page = makePage()
    const flush = () => new Promise(r => setTimeout(r, 0))
    const tapMode = m => page.onMode({ currentTarget: { dataset: { mode: m } } })
    const titles = () => page.data.list.map(x => x.title)

    await page.loadAll()
    t(page.data.mode === 'auto' && titles().length > 0, '初始：推荐模式，列表是推荐内容')

    // ① 切手动 → mode 必须真的变成 manual（bug 就出在这里）
    tapMode('manual'); await flush()
    t(page.data.mode === 'manual', `切到手动后 data.mode 必须是 manual（实际 ${page.data.mode}）`)
    t(page.data.list.length > 0, '手动列表以推荐内容为起点（不是空列表）')
    const cloudAfterManual = await statsFn.main({ action: 'quickPicks' })
    t(cloudAfterManual.data.source === 'user', '云端来源已存成手动')

    // ② 切回推荐
    tapMode('auto'); await flush()
    t(page.data.mode === 'auto', `切回推荐后 data.mode 必须是 auto（实际 ${page.data.mode}）`)
    const cloudAfterAuto = await statsFn.main({ action: 'quickPicks' })
    t(cloudAfterAuto.data.source === 'auto', '云端来源已切回自动')

    // ③ ⚠️ 本 bug 的核心回归点：再切回手动必须还有反应
    tapMode('manual'); await flush()
    t(page.data.mode === 'manual', '推荐 → 手动 → 推荐 → 手动：仍然能切（此前此处整页卡死）')
    t(page.data.myList.length > 0, '切回来时手动列表还在（没被推荐覆盖）')

    // ④ 编辑入口真的可用（mode 对了，wx:if 才会渲染出 ↑↓ / ✕）
    const before = page.data.myList.length
    page.onDelete({ currentTarget: { dataset: { index: 0 } } }); await flush()
    t(page.data.myList.length === before - 1, `手动模式下删除生效（${before} → ${page.data.myList.length}）`)
    const cloudAfterDel = await statsFn.main({ action: 'quickPicks' })
    t(cloudAfterDel.data.picks.length === before - 1, '删除已落库')

    // ⑤ 连点切换（保存还没回来就接着点）：最后一次必须赢
    tapMode('auto')
    tapMode('manual')
    tapMode('auto')
    await flush(); await flush(); await flush()
    t(page.data.mode === 'auto', `连点 3 次后停在最后一次点的模式（实际 ${page.data.mode}）`)
    const cloudAfterBurst = await statsFn.main({ action: 'quickPicks' })
    t(cloudAfterBurst.data.source === 'auto', '连点后云端与界面一致（串行写库，不是"先发的旧值覆盖后发的"）')
    t(page.data.saving === false, '连点结束后 saving 归位（不会卡在"保存中…"）')

    // ⑥ 写云端失败 → 提示 + 以云端为准重新同步（不拿过期快照覆盖界面）
    tapMode('manual'); await flush()
    const goodLen = page.data.myList.length
    toasts = []
    failCloud = '网络错误'
    page.onDelete({ currentTarget: { dataset: { index: 0 } } })
    await flush(); await flush()
    t(toasts.length === 1, `保存失败要提示用户（实际 ${toasts.length} 次）`)
    t(page.data.myList.length === goodLen, '失败后界面回到云端的真实状态（删掉的那条又回来了）')
    t(page.data.saving === false, '失败后 saving 不会卡在 true')

    // ⑦ 首帧不能"先跳到推荐、再跳到手动"
    //    根因：data.mode 默认 'auto'，真正的高亮要等 getStatistics 回来才 setData。
    //    现在 onLoad 里先 hydrate（读本机缓存），云端只补推荐内容。
    const p2 = makePage()
    p2.onLoad()                       // 同步调用，不等云端
    t(p2.data.mode === 'manual',
      `首帧就应该是缓存的 manual（实际 ${p2.data.mode}）—— 否则进页面会先闪一下推荐`)
    t(p2.data.list.length === goodLen, '首帧列表直接用本机缓存的手动项，不用等网络')
    t(p2.data.loaded === false, '首帧 loaded 仍是 false：推荐没到，空状态不该先冒出来')
    await flush(); await flush()
    t(p2.data.mode === 'manual' && p2.data.loaded === true, '云端回来后仍是 manual，没有被推荐刷掉')

    // 反过来也要对：首帧在推荐模式时，不能拿缓存的手动列表顶上
    tapMode('auto'); await flush()
    const p3 = makePage()
    p3.onLoad()
    t(p3.data.mode === 'auto', '缓存已是推荐模式时，首帧就是推荐')
    t(p3.data.list.length === 0, '推荐模式首帧不拿手动列表冒充（等云端推荐回来再填）')
    await flush(); await flush()
    t(p3.data.list.length > 0 && p3.data.list[0].title === '地铁', '云端回来后填的是推荐内容')

    delete global.wx
  }

  console.log('\n' + (fail ? '❌ ' + fail + ' 项未通过' : '✅ 全部通过'))
  process.exit(fail ? 1 : 0)
})()
