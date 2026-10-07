// 简介卡统计聚合（纯函数，node 可单测）。设计书 DOC-INFO-DESIGN §5：
// 摘录/总结出自链接侧车（同一记录可兼有两类锚点时各计一次、文件数只计
// 一次）；批注页数 = 标注侧车有笔画的页键数（写侧已剪空页）；自由笔记
// = listNotes 的 .md 总数 − 有侧车条目的记录文件数。
export function docStats (links, annotations, notes) {
  const records = links && links.records && typeof links.records === 'object' ? links.records : {}
  let excerpts = 0
  let summaries = 0
  let recordFiles = 0
  for (const r of Object.values(records)) {
    if (!r || typeof r !== 'object') continue
    const hasEx = Array.isArray(r.excerpts) && r.excerpts.length > 0
    if (hasEx) excerpts++
    if (r.summary) summaries++
    if (hasEx || r.summary) recordFiles++
  }
  const inkPages = annotations && annotations.pages && typeof annotations.pages === 'object'
    ? Object.keys(annotations.pages).length
    : 0
  const noteFiles = notes && Array.isArray(notes.notes) ? notes.notes.length : 0
  return { excerpts, summaries, inkPages, notes: Math.max(0, noteFiles - recordFiles) }
}
