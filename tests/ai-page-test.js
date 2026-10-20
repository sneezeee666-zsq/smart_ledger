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
  console.log('\n=== 4) 深度思考模拟本身：文案与等待 ===')
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
    t(toastTitle === '生成失败，请重试', '失败提示可操作（实际："' + toastTitle + '"）')
  }

  console.log('\n' + (fail ? '❌ ' + fail + ' 项未通过' : '✅ 全部通过'))
  process.exit(fail ? 1 : 0)
})()
