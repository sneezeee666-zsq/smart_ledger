/**
 * 半屏快捷记账面板（components/quick-add）离线验证
 *
 * 这个组件是"补记一笔"的主入口，出错的代价很直接：金额记错、记成收入、
 * 或者点一下 chip 就把钱记重了。所以守四件事：
 *
 *   1. **金额清洗**：输入框只认「最多两位小数」，1.2.3 / 12.345 都要被削干净 ——
 *      否则脏值一路传到云函数，用户看到的是"保存失败"却说不出哪里错
 *   2. **chip 预填 vs 长按直存**：点=只预填（还能改），长按=直接落库（一步完成）。
 *      这两件事必须区分清楚，误触发会让用户莫名其妙多记一笔
 *   3. **提交参数形态**：type 只能是 expense/income、日期时间走 bjNow（UTC+8）、
 *      走 parseCSV 的 action='add'（与完整记账页同一条链路，口径才不会分叉）
 *   4. **非正数金额一律不提交**（0 / 空 / 负数）
 *
 * 做法：用 global.Component 桩捕获配置，造一个带 setData / triggerEvent 的实例直接调方法。
 *
 * 运行：node tests/quick-add-test.js
 */
const path = require('path')

const COMP = path.join(__dirname, '..', 'components/quick-add/quick-add.js')

let fail = 0
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

/** 造一个组件实例；calls 记录所有云函数调用 */
function loadComp(cloudResult) {
  const calls = []
  const toasts = []

  global.wx = {
    getStorageSync() { return '' },
    setStorageSync() {},
    showToast(o) { toasts.push(o && o.title) },
    navigateTo(o) { calls.push({ kind: 'navigate', url: o.url }) },
    cloud: {
      callFunction(opts) {
        calls.push({ kind: 'call', name: opts.name, data: opts.data })
        return Promise.resolve({ result: cloudResult || { code: 0, data: {} } })
      }
    },
    env: { USER_DATA_PATH: '' }
  }

  let cfg = null
  global.Component = (c) => { cfg = c }
  delete require.cache[COMP]
  require(COMP)
  if (!cfg) throw new Error('没能捕获 Component 配置')

  const events = []
  const inst = Object.assign({}, cfg.methods, {
    data: JSON.parse(JSON.stringify(cfg.data)),
    properties: {},
    setData(patch) { Object.assign(this.data, patch) },
    triggerEvent(name, detail) { events.push({ name, detail }) }
  })
  return { inst, cfg, calls, toasts, events }
}

;(async () => {
  // ================================================================
  console.log('\n=== 1) 金额清洗：只认最多两位小数 ===')
  // ================================================================
  {
    const { inst } = loadComp()
    const type = (v) => { inst.onAmountInput({ detail: { value: v } }); return inst.data.amount }

    t(type('12.345') === '12.34', '12.345 → 12.34（截到两位）')
    t(type('1.2.3') === '1.23', '1.2.3 → 1.23（多余的点点掉）')
    t(type('12a3') === '123', '12a3 → 123（非数字剔除）')
    t(type('') === '', '空字符串保持空')
    t(type('0.5') === '0.5', '0.5 正常保留')
    t(type('1234567890123') === '1234567890', '超长截到 10 位（防溢出）')
  }

  // ================================================================
  console.log('\n=== 2) 收支切换 / 清空 ===')
  // ================================================================
  {
    const { inst } = loadComp()
    inst.onTypeChange({ currentTarget: { dataset: { type: 'income' } } })
    t(inst.data.type === 'income', '切到收入')
    inst.onTypeChange({ currentTarget: { dataset: { type: 'expense' } } })
    t(inst.data.type === 'expense', '切回支出')

    inst.setData({ amount: '88' })
    inst.clearAmount()
    t(inst.data.amount === '', '清空金额')
  }

  // ================================================================
  console.log('\n=== 3) chip：点是预填，长按才直接存 ===')
  // ================================================================
  {
    const picks = [
      { title: '瑞幸咖啡', type: 'expense', amount: 15, product: '拿铁', count: 4 },
      { title: '工资', type: 'income', amount: 10000, product: '', count: 2 }
    ]
    const { inst, calls } = loadComp()
    inst.setData({ picks })

    // 点一下：只预填，不发请求
    inst.onPick({ currentTarget: { dataset: { index: 0 } } })
    t(inst.data.amount === '15' && inst.data.title === '瑞幸咖啡' && inst.data.type === 'expense',
      '点 chip → 预填金额/对方/收支（实际 ' + inst.data.amount + ' / ' + inst.data.title + '）')
    t(calls.length === 0, '点 chip 不发请求（还能改金额）')

    // 长按：直接落库
    await inst.onPickSave({ currentTarget: { dataset: { index: 1 } } })
    const add = calls.find(c => c.kind === 'call' && c.data && c.data.action === 'add')
    t(!!add, '长按 chip → 直接提交 add')
    t(add && add.data.bill.type === 'income' && Number(add.data.bill.amount) === 10000,
      '长按提交的是该 chip 的收支与金额（income / 10000，实际 ' +
      (add && add.data.bill.type) + ' / ' + (add && add.data.bill.amount) + '）')
  }

  // ================================================================
  console.log('\n=== 4) 保存：参数形态与未通过校验的情况 ===')
  // ================================================================
  {
    const { inst, calls, toasts } = loadComp()

    // 空金额不提交
    inst.setData({ amount: '' })
    inst.onSave()
    t(calls.filter(c => c.kind === 'call').length === 0, '空金额不发请求')
    t(toasts.some(x => x && x.indexOf('金额') !== -1), '提示"请输入金额"')

    // 0 不提交
    inst.setData({ amount: '0' })
    inst.onSave()
    t(calls.filter(c => c.kind === 'call').length === 0, '金额 0 不发请求')

    // 正常提交
    inst.setData({ amount: '18.5', title: '便利店', type: 'expense' })
    await inst.onSave()
    const add = calls.find(c => c.data && c.data.action === 'add')
    t(!!add && add.name === 'parseCSV', '走 parseCSV 云函数（与完整记账页同一条链路）')
    t(add.data.bill.amount === '18.5', '金额原样传（云端负责 round）')
    t(add.data.bill.title === '便利店', '对方传上去了')
    t(/^\d{4}-\d{2}-\d{2}$/.test(add.data.bill.date), '日期是 YYYY-MM-DD（实际 ' + add.data.bill.date + '）')
    t(/^\d{2}:\d{2}$/.test(add.data.bill.time), '时间是 HH:mm（实际 ' + add.data.bill.time + '）')
    t(add.data.bill.type === 'expense', 'type 归一化成 expense')
  }

  // ================================================================
  console.log('\n=== 5) 保存结果：成功关面板 / 失败不关 ===')
  // ================================================================
  {
    // 成功
    {
      const { inst, events } = loadComp({ code: 0, data: {} })
      inst.setData({ amount: '20', title: '地铁' })
      await inst.onSave()
      t(events.some(e => e.name === 'done'), '成功后抛 done 事件（首页据此刷新）')
      t(events.some(e => e.name === 'close'), '成功后抛 close 事件（面板收起）')
      t(inst.data.submitting === false, 'submitting 复位')
    }
    // 云端拒绝
    {
      const { inst, events, toasts } = loadComp({ code: -1, message: '疑似重复记录' })
      inst.setData({ amount: '20', title: '地铁' })
      await inst.onSave()
      t(!events.some(e => e.name === 'close'), '失败时**不关**面板（用户可改后重试）')
      t(toasts.some(x => x === '疑似重复记录'), '云端给的提示原样转给用户')
      t(inst.data.submitting === false, '失败后 submitting 也要复位')
    }
  }

  // ================================================================
  console.log('\n=== 6) 更多选项：带着已填内容进完整页 ===')
  // ================================================================
  {
    const { inst, calls } = loadComp()
    inst.setData({ amount: '66', title: '滴滴出行', type: 'income' })
    inst.goFullPage()
    const nav = calls.find(c => c.kind === 'navigate')
    t(!!nav, '触发了跳转')
    t(nav && nav.url.indexOf('/pages/add-bill/add-bill?') === 0, '跳到完整记账页（实际 ' + (nav && nav.url) + '）')
    t(nav && nav.url.indexOf('amount=66') !== -1, '带上已填金额')
    t(nav && nav.url.indexOf('type=income') !== -1, '带上收支')
  }

  // ================================================================
  console.log('\n=== 7) 「常记的」每次打开都刷新（配置页改完要能立刻看到）===')
  // ================================================================
  {
    const picksRes = {
      code: 0,
      data: {
        source: 'user',
        picks: [{ title: '地铁', type: 'expense', amount: 3, product: '', categoryId: '' }]
      }
    }
    const { inst, cfg, calls } = loadComp(picksRes)
    const pickCalls = () => calls.filter(c => c.data && c.data.action === 'quickPicks').length

    // 直接连调两次：不能有"只拉一次"的门控
    await inst.loadPicks()
    const after1 = pickCalls()
    await inst.loadPicks()
    const after2 = pickCalls()

    t(after1 === 1, '第一次调用会请求')
    t(after2 === 2,
      `第二次调用仍然请求（实际累计 ${after2} 次）—— 用一次性缓存会让配置页改完首页不更新`)

    // 打开面板（visible=true）也要触发拉取
    cfg.observers.visible.call(inst, true)
    await new Promise(r => setTimeout(r, 40))
    t(pickCalls() === 3, `打开面板会触发拉取（实际累计 ${pickCalls()} 次）`)

    // 数据到位后 chips 是新的
    t(inst.data.picks.length === 1 && inst.data.picks[0].title === '地铁', 'chips 用云端的返回')
  }

  console.log('\n' + (fail ? '❌ ' + fail + ' 项未通过' : '✅ 全部通过'))
  process.exit(fail ? 1 : 0)
})()
