/**
 * AI 分析页（pages/ai/ai.js）离线验证
 *
 * 这个页面的风险点与云函数不同 —— 结论的正确性由 insight-test.js 守，
 * 这里守的是**界面状态与用户操作是否对得上**。典型翻车方式：
 * 点了「近 7 天」， segmented 控件亮了、结论区清空了，
 * 可 hero 卡里那行说明小字还写着「最近 30 天」——
 * 每个字段都"对"，只有一行字没跟上，用户会以为切换失效，
 * 而这类 bug 从截图和代码 review 里都极难发现。
 *
 * 做法：用 global.Page 桩把页面配置捕获下来，再造一个带 setData 的实例直接调方法。
 * 不碰 wx.cloud 的真实链路，也不需要开发者工具。
 *
 * 运行：node tests/ai-page-test.js
 */
const path = require('path')

const AI_PAGE = path.join(__dirname, '..', 'pages/ai/ai.js')

let fail = 0
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

/**
 * 加载 ai 页并返回一个可调用的页面实例。
 * ⚠️ 每次都要重新 require：页面配置是模块级常量（DIMENSIONS/SCOPES 等），
 *    缓存会把上一次改过的 data 带进来。
 */
function loadAiPage() {
  global.wx = {
    getStorageSync() { return '' },
    setStorageSync() {},
    setTabBarStyle() {}, setTabBarItem() {},
    setNavigationBarColor() {}, setBackgroundColor() {},
    showToast() {}, showModal() {}, navigateTo() {},
    getMenuButtonBoundingClientRect() { return { top: 0, height: 0 } },
    env: { USER_DATA_PATH: '' },
    cloud: {
      callFunction() {
        return Promise.resolve({ result: { code: 0, data: { scope: { days: 30 }, insights: [], meta: { scanned: 0 } } } })
      }
    }
  }

  let captured = null
  global.Page = (cfg) => { captured = cfg }

  delete require.cache[AI_PAGE]
  require(AI_PAGE)

  if (!captured) throw new Error('没能捕获页面配置（ai.js 没有调用 Page()）')

  return Object.assign({}, captured, {
    data: JSON.parse(JSON.stringify(captured.data)),
    setData(patch) { Object.assign(this.data, patch) }
  })
}

;(async () => {
  // ================================================================
  console.log('\n=== 1) 切换分析范围：说明小字必须同步刷新（回归）===')
  // ================================================================
  {
    const page = loadAiPage()

    t(page.data.scopeDays === 30, '初始范围是近 30 天')
    t(page.data.scopeText === '最近 30 天（今天往前推 30 个自然日）',
      '初始说明小字与范围一致')

    page.onSwitchScope({ currentTarget: { dataset: { days: 7 } } })
    t(page.data.scopeDays === 7, '切到近 7 天后 scopeDays = 7')
    t(page.data.scopeText === '最近 7 天（今天往前推 7 个自然日）',
      '⚠️ 回归点：说明小字跟着变成"最近 7 天"（修复前这里仍写 30 天，看着像切换失效）')

    page.onSwitchScope({ currentTarget: { dataset: { days: 30 } } })
    t(page.data.scopeDays === 30 &&
      page.data.scopeText === '最近 30 天（今天往前推 30 个自然日）',
      '切回近 30 天，两个字段一起回')
  }

  // ================================================================
  console.log('\n=== 2) 切换范围的其它副作用 ===')
  // ================================================================
  {
    const page = loadAiPage()
    page.setData({ analyzed: true, insights: [{ id: 'x' }], loadFailed: true })

    page.onSwitchScope({ currentTarget: { dataset: { days: 7 } } })
    t(page.data.insights.length === 0, '切换后旧结论被清空（不同窗口的结果不能混着看）')
    t(page.data.analyzed === false, '切换后回到"还没分析"态')
    t(page.data.loadFailed === false, '切换后失败态也清掉')

    page.onSwitchScope({ currentTarget: { dataset: { days: 30 } } })
    t(page.data.scopeDays === 30, '点当前已选中的档位 → 范围不变')

    page.setData({ analyzing: true })
    page.onSwitchScope({ currentTarget: { dataset: { days: 7 } } })
    t(page.data.scopeDays === 30, '分析进行中不响应切换（避免结果窗口与所选范围错位）')
  }

  // ================================================================
  console.log('\n=== 3) 分析完成后：说明小字与云端返回的窗口一致 ===')
  // ================================================================
  {
    const page = loadAiPage()

    global.wx.cloud = {
      callFunction() {
        return Promise.resolve({
          result: { code: 0, data: { scope: { days: 7 }, insights: [], meta: { scanned: 0 } } }
        })
      }
    }

    // 「深度思考」会人为停留 3~10 秒。这里把时钟往前拨，
    // 让等待循环第一拍就结束 —— 否则这个用例要真的等十几秒。
    const realNow = Date.now
    let clock = realNow()
    Date.now = () => { clock += 60000; return clock }
    try {
      page.setData({ scopeDays: 7 })
      await page.onAnalyze()
    } finally {
      Date.now = realNow
    }

    t(page.data.scopeDays === 7, '按近 7 天分析')
    t(page.data.scopeText === '最近 7 天（今天往前推 7 个自然日）',
      '云端返回 7 天 → 说明小字也写 7 天（不是沿用上一次的文案）')
    t(page.data.analyzed === true && page.data.analyzing === false, '分析正常收尾')
  }

  // ================================================================
  console.log('\n=== 4) 分析失败：与「没有结论」分开表达 ===')
  // ================================================================
  {
    const page = loadAiPage()

    let toastTitle = ''
    global.wx.showToast = (o) => { toastTitle = o.title }
    global.wx.cloud = {
      callFunction() { return Promise.reject(new Error('网络波动')) }
    }

    const realNow = Date.now
    let clock = realNow()
    Date.now = () => { clock += 60000; return clock }
    try {
      await page.onAnalyze()
    } finally {
      Date.now = realNow
    }

    t(page.data.loadFailed === true, '云函数失败 → loadFailed = true（与"没有结论"分开表达）')
    t(page.data.insights.length === 0, '失败时清空旧结论而不是留着上一份')
    t(toastTitle === '分析失败，请重试', '失败提示可操作（实际："' + toastTitle + '"）')
  }

  // ================================================================
  console.log('\n=== 5) 「会分析什么」必须与云端规则一一对上 ===')
  // ================================================================
  // ⚠️ 这是新增规则时最容易漏的一步：云端默默多了一条结论，页面的「会分析什么」
  //    却没提 —— 用户看到一张没在清单里的卡片，会怀疑是随机生成的。
  //    这里直接把 insight.js 的 PRIORITY 键（= 全部规则 id）拿去和页面 DIMENSIONS 对账。
  {
    const fs = require('fs')
    const INSIGHT = path.join(__dirname, '..', 'cloudfunctions/getStatistics/lib/insight.js')
    const src = fs.readFileSync(INSIGHT, 'utf8')

    const block = src.match(/const PRIORITY = \{([\s\S]*?)\n\}/)
    const ids = block
      ? Array.from(block[1].matchAll(/^\s*(\w+):\s*\d+/gm)).map(m => m[1])
      : []

    t(ids.length >= 10, `能从 PRIORITY 读出全部规则 id（读到 ${ids.length} 个）`)

    // 规则 id → 页面维度 key 的映射。
    // baseline 是「概况」，每条分析都带一个底数，不算一个可勾选的维度 —— 豁免。
    const DIM_OF = {
      budget: 'budget', moonlight: 'moonlight', mom: 'mom', trend: 'trend',
      category: 'structure', catMom: 'catMom', fixed: 'fixed', night: 'night',
      large: 'large', smallFreq: 'small', merchant: 'merchant', weekend: 'weekend',
      noSpend: 'habit'
    }

    const page = loadAiPage()
    const dimKeys = page.data.dimensions.map(d => d.key)
    const missing = ids.filter(id => id !== 'baseline' && dimKeys.indexOf(DIM_OF[id]) === -1)

    t(missing.length === 0,
      `每条规则都能在「会分析什么」里找到对应条目（漏掉：${missing.join(',') || '无'}）`)

    const orphan = dimKeys.filter(k => Object.keys(DIM_OF).every(id => DIM_OF[id] !== k))
    t(orphan.length === 0, `页面没有讲过时（云端已不存在的维度：${orphan.join(',') || '无'}）`)

    t(page.data.dimensions.length === 13, `维度共 13 条（实际 ${page.data.dimensions.length}）`)
    t(page.data.dimensions.every(d => d.title && d.desc),
      '每条维度都有标题与说明（空说明等于让用户猜）')

    // 月度视角三条必须写明「和谁比」，否则用户会把自然月和滚动窗口混起来
    const momDim = page.data.dimensions.find(d => d.key === 'mom')
    const catMomDim = page.data.dimensions.find(d => d.key === 'catMom')
    const fixedDim = page.data.dimensions.find(d => d.key === 'fixed')
    t(momDim && momDim.desc.indexOf('上月') !== -1, '「跨月对比」的说明里点明与上月同期比')
    t(catMomDim && catMomDim.desc.indexOf('类目') !== -1, '「类目变化」的说明里点明是类目层面')
    t(fixedDim && fixedDim.desc.indexOf('每月') !== -1, '「固定支出」的说明里点明是每月都发生的')
  }

  // ================================================================
  console.log('\n=== 6) 口径标签与页脚笔数（「选 7 天却像 30 天」的回归）===')
  // ================================================================
  // ⚠️ 用户实测：「选仅 7 天，分析的还是 30 天的数据」。
  //    窗口其实一直是 7 天，是三件事让它看着像 30 天：
  //      ① 月度口径的结论排在前面（云端已改成后置 + 限流 2 条）
  //      ② 月度结论没有标识 → 用户把「本月 ¥3955」当成 7 天的数字
  //      ③ 页脚显示的是**取数条数**（3 个自然月），不是本期笔数
  {
    const page = loadAiPage()
    global.wx.cloud = {
      callFunction() {
        return Promise.resolve({
          result: {
            code: 0,
            data: {
              scope: { days: 7 },
              insights: [
                { id: 'trend', level: 'tip', title: '日均', detail: 'd', evidence: [], scope: 'window' },
                { id: 'budget', level: 'warn', title: '预算', detail: 'd', evidence: [], scope: 'month' }
              ],
              meta: { scanned: 62, windowCount: 16, hasBudget: true }
            }
          }
        })
      }
    }
    page.setData({ scopeDays: 7 })
    await page.onAnalyze()

    const win = page.data.insights.find(x => x.id === 'trend')
    const mon = page.data.insights.find(x => x.id === 'budget')
    t(win && win.scopeTag === '', '窗口口径的结论不带标签（它就是所选 N 天的数字）')
    t(mon && mon.scopeTag === '按自然月',
      `月度口径的结论带「按自然月」标签（实际 ${mon && JSON.stringify(mon.scopeTag)}）`)
  }

  {
    const fs = require('fs')
    const wxml = fs.readFileSync(path.join(__dirname, '..', 'pages/ai/ai.wxml'), 'utf8')

    t(/meta\.windowCount/.test(wxml), '页脚显示本期笔数 meta.windowCount')
    t(!/\{\{meta\.scanned\}\}/.test(wxml),
      '页脚不再直接显示 meta.scanned（它是 3 个自然月的取数条数，选 7 天时会显示成「扫描 62 笔」）')
    t(/ins-scope/.test(wxml), '结论卡渲染了口径标签（只有数据没有标签 = 用户还是会误会）')

    const sub = wxml.match(/hero-note-sub"[^>]*>([^<]+)</)
    t(!!sub && sub[1].indexOf('预算进度') !== -1,
      `hero 下方那行说明把「预算进度」也算进自然月口径（实际「${sub ? sub[1] : '未找到'}」）`)
  }

  console.log('\n' + (fail ? '❌ ' + fail + ' 项未通过' : '✅ 全部通过'))
  process.exit(fail ? 1 : 0)
})()
