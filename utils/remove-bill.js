/**
 * 删除账单 —— 两个入口的统一出口
 * ---------------------------------------------------------------------------
 * 入口：① 账单列表左滑  ② 账单详情弹层底部的「删除记录」
 * 两处都要「二次确认 → 调云函数 → 统一提示」，写两遍必然走样（比如某处忘了
 * 兜住异常、某处把 loading 盖在确认弹窗上），所以集中在这里。
 * （首页曾有第三个入口「减一笔」，v0.4.0 已移除 —— 见 README「已知的取舍」）
 *
 * ⚠️ 为什么删除必须走云函数，而不是客户端 db.collection().doc(id).remove()？
 *    1. 云函数写入的文档（导入的账单、手动记账）客户端不一定删得掉 ——
 *       集合权限一旦不是「仅创建者可写」，前端 remove 会被静默拒绝；
 *    2. 客户端删除**没法校验归属**，云函数侧才能把 _openid 写进条件里，
 *       保证「只能删自己的」；
 *    3. 出错信息能统一收口（云函数 return code/message），前端好提示。
 *
 * ⚠️ 顺序不能反：showLoading 带 mask 会盖在 showModal 之上，用户点不到弹窗按钮
 *    （表现为"卡住"）。所以必须先确认、后 loading。
 */

const CLOUD_FN = 'parseCSV'

/** 金额文案：收入 +¥12.00 / 支出 -¥12.00 —— 与页面上的写法保持一致 */
function amountText(bill) {
  const n = Number(bill && bill.amount)
  const value = n === n && n !== Infinity && n !== -Infinity ? n : 0
  return (bill && bill.type === 'income' ? '+' : '-') + '¥' + value.toFixed(2)
}

/** 确认弹窗的默认文案 */
function defaultContent(bill) {
  const title = (bill && bill.title) || (bill && bill.type === 'income' ? '收入' : '支出')
  return `将删除「${title}」${amountText(bill)} 这条记录，删除后无法恢复。`
}

/**
 * 调云函数删除（不弹确认）
 * @param {string|string[]} ids
 * @returns {Promise<Object>} 云函数返回体（含 deleted 条数）
 */
function removeBills(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
  if (!list.length) return Promise.resolve({ deleted: 0 })

  return wx.cloud
    .callFunction({ name: CLOUD_FN, data: { action: 'delete', ids: list } })
    .then(res => {
      const r = (res && res.result) || {}
      if (r.code !== 0) throw new Error(r.message || '删除失败')
      // deleted 为 0：记录已被删掉或不属于当前用户 —— 也要告诉用户，不能假装成功
      if (!r.deleted) throw new Error('这条记录已不存在')
      return r
    })
}

/** 二次确认弹窗（Promise 化，失败也不抛） */
function confirmRemove(content) {
  return new Promise(resolve => {
    wx.showModal({
      title: '删除这笔记录',
      content: content || '删除后无法恢复，确定删除吗？',
      confirmText: '删除',
      confirmColor: '#E5484D',   // 与 --income（这个项目里的红色）同值：危险操作统一红
      success: res => resolve(!!res.confirm),
      fail: () => resolve(false)
    })
  })
}

/**
 * 「确认 + 删除 + 提示」一条龙
 * @param {Object} bill 账单对象（必须有 _id）
 * @param {string} [content] 自定义确认文案
 * @returns {Promise<boolean>} 是否真的删掉了
 */
async function confirmAndRemove(bill, content) {
  if (!bill || !bill._id) return false

  const ok = await confirmRemove(content || defaultContent(bill))
  if (!ok) return false

  wx.showLoading({ title: '删除中...', mask: true })
  try {
    await removeBills([bill._id])
    wx.hideLoading()
    wx.showToast({ title: '已删除', icon: 'success' })
    return true
  } catch (err) {
    wx.hideLoading()
    console.error('删除失败:', err)
    wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' })
    return false
  }
}

module.exports = {
  removeBills: removeBills,
  confirmRemove: confirmRemove,
  confirmAndRemove: confirmAndRemove,
  defaultContent: defaultContent
}
