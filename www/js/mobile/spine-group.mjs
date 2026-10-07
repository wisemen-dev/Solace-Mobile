/* 书脊分组（平板端口径）——纯函数，可单测。
 *
 * 桌面端 renderSpineShelves（app.js，sync 搬入 www）按直接分类分组、
 * 组头纯展示、搜索时仍分组。平板端四项决策（2026-10-07 拍板）经 app.js
 * 移动补丁接入本模块：
 *   1. 粒度：归并到顶级分类——子分类的书并入顶级父组，组序 = 顶级分类
 *      在 categories 数组中的顺序（与侧栏一致）
 *   2. 搜索（keyword 非空）是查找场景：不分组，全部书合成一组平铺
 *   3. 仅一组时（如侧栏已筛到某分类、全库未分类）同样平铺不渲染组头
 *   4. 悬空 categoryId（指向已删分类，上溯不到顶级）与无分类同归「未分类」
 *
 * 返回 { flat, groups }：flat=true 时 groups 恒为单组（全部 docs 原序、
 * name 空——组头不渲染），app 侧模板据此跳过组头。
 * 组内顺序保持传入 docs 的顺序（入库序），不引入新排序。
 */
export function groupSpines (docs, categories, keyword) {
  const byId = new Map(categories.map(c => [c.id, c]))
  const topOf = (id) => {
    let c = id ? byId.get(id) : null
    while (c && c.parentId) c = byId.get(c.parentId)
    return c ? c.id : null
  }
  const byTop = new Map()
  for (const d of docs) {
    const key = topOf(d.categoryId || null)
    if (!byTop.has(key)) byTop.set(key, [])
    byTop.get(key).push(d)
  }
  const groups = categories.filter(c => !c.parentId && byTop.has(c.id))
    .map(c => ({ key: c.id, name: c.name, docs: byTop.get(c.id) }))
  if (byTop.has(null)) groups.push({ key: null, name: '未分类', docs: byTop.get(null) })
  if (keyword || groups.length <= 1) {
    return { flat: true, groups: [{ key: null, name: '', docs: [...docs] }] }
  }
  return { flat: false, groups }
}
