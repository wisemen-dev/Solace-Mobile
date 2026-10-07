/* 高亮带行聚类（纯函数，可单测）——拖选/入选态带状高亮的几何核心
 *（拍板 2026-10-07：按行统一带，替代随字体高低错落的内联背景）。
 *
 * 输入：字符片段矩形列表 [{x, y, w, h}]（视觉坐标，含多行文本项的逐行分片）。
 * 输出：每视觉行一条等高带 {x, y, w, h}：
 * - 行聚类：按 y 中心排序后贪心聚类，容差 = max(本片高, 当前行最高片高)/2
 *   ——基线对齐的大/小字同行时中心差 = (h大-h小)/2 < h大/2 必聚同行；
 *   相邻两行等高字的中心差 ≈ 行距 ≥ 字高 > h/2 必分行
 * - 行高 = 该行最高片段 ×(1+pad)（上下匀称边距），带中心对齐最高片段中心
 *   （小字贴基线，自然落在大字带的下半区，符合阅读直觉）
 * - 零宽/零高片段（行尾空白等）过滤
 */
export function groupRectsToBands (rects, pad = 0.12) {
  const frags = rects
    .filter(r => r.w > 0 && r.h > 0)
    .map(r => ({ ...r, cy: r.y + r.h / 2 }))
  if (!frags.length) return []
  frags.sort((a, b) => a.cy - b.cy || a.x - b.x)
  const rows = []
  for (const f of frags) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(f.cy - row.cy) <= Math.max(row.maxH, f.h) / 2) {
      row.items.push(f)
      row.maxH = Math.max(row.maxH, f.h)
      row.cy = row.items.reduce((s, r) => s + r.cy, 0) / row.items.length
    } else {
      rows.push({ items: [f], maxH: f.h, cy: f.cy })
    }
  }
  return rows.map(row => {
    // 最高片段决定带高与带的垂直中心
    const tall = row.items.reduce((a, b) => (b.h > a.h ? b : a))
    const h = row.maxH * (1 + pad)
    const x = Math.min(...row.items.map(r => r.x))
    const right = Math.max(...row.items.map(r => r.x + r.w))
    return { x, y: tall.cy - h / 2, w: right - x, h }
  })
}
