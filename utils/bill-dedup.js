/**
 * 导入去重的「挑拣」逻辑（纯函数，放 utils 是为了能离线单测）
 *
 * ⚠️ 为什么去重要分成两半？
 *    云端只回答「这些键里哪些已在库里」（dedupBills 返回 dupIdx），
 *    「本批次内部重复」在这里判。分开的好处是前端可以**分批**把键提交给云函数
 *    （任意大的文件都不会撑爆单次调用的大小限制），而批内去重依然完整 ——
 *    本地这个 Set 跨越所有批次，第二批里出现与第一批相同的键照样会被挑掉。
 *
 *    以前是云端一遍过滤完再回传整份账单，问题就出在「回传」上：
 *    wx.cloud.callFunction 的 data/result 有传输大小限制（官方建议临界值 100KB），
 *    500 条账单 ≈165KB，直接报 data exceed max size。
 */

/**
 * 从一批解析结果里挑出真正要写进库的记录
 *
 * @param {Array} bills      解析出的账单（与 keys 逐下标对齐）
 * @param {Array<string>} keys 云端算出的判重键（makeBillKey 的结果）
 * @param {Set<number>|Array<number>} dbDupIdx 云端检出的「已在库里」的下标
 * @returns {{ newBills: Array, duplicateCount: number }}
 */
function filterNewBills(bills, keys, dbDupIdx) {
  const list = Array.isArray(bills) ? bills : []
  const keyList = Array.isArray(keys) ? keys : []
  const dbDup = dbDupIdx instanceof Set ? dbDupIdx : new Set(dbDupIdx || [])

  const seen = new Set()
  const newBills = []
  let duplicateCount = 0

  for (let i = 0; i < list.length; i++) {
    const key = keyList[i]

    // 与库里重复，或本批次内部重复（同一把键第二次出现）
    // ⚠️ 两个条件用 ||，且「本批次重复」必须也计数：
    //    用户看到的「重复跳过 N 条」要能和「本次新增 + 重复 = 解析总数」对上。
    if (dbDup.has(i) || seen.has(key)) {
      duplicateCount++
      continue
    }

    seen.add(key)
    newBills.push(list[i])
  }

  return { newBills, duplicateCount }
}

module.exports = {
  filterNewBills
}
