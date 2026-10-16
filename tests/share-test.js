/**
 * 分享（转发）离线验证
 *
 * 背景：正式版上线后发现「点右上角三个点 → 当前页面无法转发」。
 * 根因是**全项目没有一个页面定义 onShareAppMessage** —— 微信规定只有定义了
 * 该生命周期，右上角菜单才会出现"转发"按钮。这条规则不会报任何错，
 * 所以用这个套件把分享的**内容正确性**和**隐私安全性**钉住。
 *
 * 守四件事：
 *   1. 通用分享（账单/我的等隐私页）**绝不能夹带用户数据** —— 默认分享是
 *      当前页面截图，会把交易明细截走，所以这些页面必须指定固定封面
 *   2. 统计页的内容分享：周期标签、金额口径、path 带周期（被分享者
 *      打开看到同一个周期，而不是默认月）
 *   3. 每个页面都真的定义了 onShareAppMessage（用 Page 桩加载页面验证）
 *   4. 封面图文件真实存在（缺了就是分享一个破图）
 *
 * 运行：node tests/share-test.js
 */
const path = require('path')
const fs = require('fs')

const share = require(path.join(__dirname, '..', 'utils', 'share.js'))

let fail = 0
function t(ok, msg) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + msg)
  if (!ok) fail++
}

const ROOT = path.join(__dirname, '..')

;(async () => {
  // ================================================================
  console.log('\n=== 1) 通用分享：只介绍小程序，不带任何用户数据 ===')
  // ================================================================
  {
    const s = share.appShare()
    t(s.path === '/pages/index/index', '默认分享后打开首页')
    t(s.imageUrl === share.SHARE_COVER, '指定了固定封面（不用页面截图）')
    t(typeof s.title === 'string' && s.title.length > 0, '有标题')

    // 隐私红线：返回体只允许这三个键。多出任何一个字段都意味着
    // 可能把用户数据带上了分享卡片。
    const keys = Object.keys(s).sort().join(',')
    t(keys === 'imageUrl,path,title',
      '返回体只有 imageUrl/path/title 三个键（实际：' + keys + '）—— 不带任何账单数据')

    const s2 = share.appShare('/pages/bills/bills')
    t(s2.path === '/pages/bills/bills', '可以指定落地页（账单页分享用）')

    // 封面图必须真的存在
    t(fs.existsSync(path.join(ROOT, share.SHARE_COVER)),
      '封面图文件存在：' + share.SHARE_COVER)
  }

  // ================================================================
  console.log('\n=== 2) 统计页内容分享：周期标签 / 金额口径 / path ===')
  // ================================================================
  {
    const m = share.statsShare({ currentPeriod: 'month', summary: { expense: 1234.56 } })
    t(m.title === '本月支出 ¥1234.56，看看钱花在哪',
      '本月 + 完整两位小数（实际：' + m.title + '）')
    t(m.path === '/pages/stats/stats?period=month',
      'path 带上周期，被分享者打开看到同一个月（实际：' + m.path + '）')
    t(m.imageUrl === undefined, '不设 imageUrl → 微信用当前页面截图（带图表，传播力强）')

    t(share.statsShare({ currentPeriod: 'week', summary: { expense: 88 } }).title.indexOf('本周') === 0,
      '本周')
    t(share.statsShare({ currentPeriod: 'year', summary: { expense: 88 } }).title.indexOf('本年') === 0,
      '本年')

    // 金额口径与 chart-format 一致（10 万以下不缩写）
    const big = share.statsShare({ currentPeriod: 'month', summary: { expense: 150000 } })
    t(big.title.indexOf('15.00万') !== -1, '超过 10 万按 chart-format 口径缩写（实际：' + big.title + '）')

    // 没有支出时的降级（别出现 ¥0 这种没意义的文案）
    const zero = share.statsShare({ currentPeriod: 'month', summary: { expense: 0 } })
    t(zero.title === '本月账本，看看钱花在哪', '支出为 0 时不报金额（实际：' + zero.title + '）')

    // 脏输入不炸
    const dirty = share.statsShare(null)
    t(typeof dirty.title === 'string' && dirty.title.length > 0, '传 null 不炸，退回默认周期')
    const dirty2 = share.statsShare({ summary: null })
    t(typeof dirty2.title === 'string', 'summary 为 null 不炸')
  }

  // ================================================================
  console.log('\n=== 3) 朋友圈分享 ===')
  // ================================================================
  {
    const p = share.timelineShare()
    t(p.title.indexOf(share.APP_NAME) === 0, '标题带应用名（实际：' + p.title + '）')
    t(p.imageUrl === share.SHARE_COVER, '朋友圈分享必须给图片 → 用固定封面')
    t(p.query === undefined, '不带 query（朋友圈入口只进首页）')
  }

  // ================================================================
  console.log('\n=== 4) 页面级：每个页面都真的能转发（Page 桩）===')
  // ================================================================
  {
    const PAGES = ['index', 'bills', 'stats', 'ai', 'profile', 'import', 'add-bill', 'budget', 'vip']
    const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))

    // 与 app.json 注册的页面对齐（漏一个就是这个 bug 复发）
    const missing = appJson.pages.filter(p => PAGES.indexOf(p.replace('pages/', '').replace(/\/.*/, '')) === -1)
    t(missing.length === 0, 'app.json 注册的页面都在待验清单里（漏的：' + missing.join(',') + '）')

    let captured = null
    global.getApp = () => ({ globalData: {} })   // bills.js 等页面在模块级取 app 实例
    global.wx = {
      getStorageSync() { return '' },
      setStorageSync() {},
      setTabBarStyle() {}, setTabBarItem() {}, setNavigationBarColor() {}, setBackgroundColor() {},
      showToast() {}, showLoading() {}, hideLoading() {},
      getWindowInfo() { return { statusBarHeight: 20 } },
      getMenuButtonBoundingClientRect() { return { top: 0, height: 0 } },
      env: { USER_DATA_PATH: '' },
      cloud: {
        database() { return { collection: () => ({ where: () => ({}), add: () => Promise.resolve({}) }) } },
        callFunction() { return Promise.resolve({ result: { code: 0, data: {} } }) }
      }
    }
    global.Page = (cfg) => { captured = cfg }

    for (const p of PAGES) {
      const file = path.join(ROOT, 'pages', p, p + '.js')
      if (!fs.existsSync(file)) continue
      // 每个页面独立加载：清掉它依赖的 utils 缓存，避免相互污染
      for (const k of Object.keys(require.cache)) {
        if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k]
      }
      captured = null
      try {
        delete require.cache[file]
        require(file)
      } catch (e) {
        t(false, `pages/${p} 加载失败：${e.message}`)
        continue
      }
      if (!captured) { t(false, `pages/${p} 没有调用 Page()`); continue }

      const hasApp = typeof captured.onShareAppMessage === 'function'
      const hasTl = typeof captured.onShareTimeline === 'function'
      if (!hasApp) { t(false, `pages/${p} 缺 onShareAppMessage（右上角没有转发按钮）`); continue }

      // 调一次，验证返回体是微信能吃的形状
      const r = captured.onShareAppMessage.call({ data: { currentPeriod: 'month', summary: { expense: 100 } } })
      const shapeOk = r && typeof r.title === 'string' && r.title.length > 0 &&
        typeof r.path === 'string' && r.path.charAt(0) === '/'
      t(shapeOk, `pages/${p} onShareAppMessage 返回合法（title + path，path 以 / 开头）`)

      if (hasTl) {
        const tl = captured.onShareTimeline.call({ data: {} })
        t(tl && typeof tl.imageUrl === 'string', `pages/${p} onShareTimeline 返回合法（带图片）`)
      } else {
        t(true, `pages/${p} 有 onShareAppMessage（未配朋友圈分享，可选）`)
      }
    }
  }

  console.log('\n' + (fail ? '❌ ' + fail + ' 项未通过' : '✅ 全部通过'))
  process.exit(fail ? 1 : 0)
})()
