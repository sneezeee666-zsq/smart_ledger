const user = require('./utils/user.js')

App({
  onLaunch() {
    // 初始化云开发环境
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
    } else {
      wx.cloud.init({
        env: 'cloud1-d7gne5bpf2229f19b',
        traceUser: true
      })
    }

    // 用户档案：身份由云开发隐式提供（openid），前端不需要登录也不需要存 token，
    // 这里只是把昵称 / 主题偏好从云端同步回本机。详见 utils/user.js。
    //
    // ⚠️ 这是异步的，页面首帧读的是本机缓存 —— 在一台**新设备**上首次打开时，
    //    可能出现「默认绿 → 账号里存的主题」一次跳变。这是刻意的取舍：
    //    为了消灭这一次跳变而让首屏等网络，代价更大。
    user.load().then(() => {
      user.adoptRemoteTheme()
    })
  },

  globalData: {
    /**
     * 账单分类配置（仅用于「分类筛选」的选项列表：名称 + 图标）
     *
     * ⚠️ 真正的分类判定与配色都在云端：
     *    - 判定规则：cloudfunctions/parseCSV 的 smartClassify
     *    - 展示配色：cloudfunctions/getStatistics 的 CATEGORY_META
     *    这里不重复存一份 color，避免三处色板各自漂移。
     *    新增分类时，需要同时改云端的规则与 CATEGORY_META，以及下面这个列表。
     */
    categories: {
      expense: [
        { id: 'food', name: '餐饮', icon: '🍜' },
        { id: 'transport', name: '交通', icon: '🚗' },
        { id: 'shopping', name: '购物', icon: '🛒' },
        { id: 'entertainment', name: '娱乐', icon: '🎮' },
        { id: 'housing', name: '住房', icon: '🏠' },
        { id: 'medical', name: '医疗健康', icon: '💊' },
        { id: 'education', name: '教育', icon: '📚' },
        { id: 'communication', name: '通讯', icon: '📱' },
        { id: 'other_expense', name: '其他支出', icon: '📝' }
      ],
      income: [
        { id: 'salary', name: '工资', icon: '💰' },
        { id: 'bonus', name: '奖金', icon: '🎁' },
        { id: 'investment', name: '理财收益', icon: '📈' },
        { id: 'parttime', name: '兼职', icon: '💼' },
        { id: 'red_packet', name: '红包/转账', icon: '🧧' },
        { id: 'refund', name: '退款', icon: '↩️' },
        { id: 'other_income', name: '其他收入', icon: '💵' }
      ]
    }
  }
})
