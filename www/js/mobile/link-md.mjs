// 摘录记录 .md 的生成与解析（纯函数，node 可单测）。
// 记录文件放 notes/<docId>/（.md 互通不变量）；摘录区由锚点数据重建，
// .md 是锚点的可读镜像——桌面 Typora 看到的即完整摘录+正文。
// 章节总结（READING-RECORDS-DESIGN §7.1）同构：【总结】头两行 + 正文。
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

export function generateRecordMd (excerpts, body) {
  const lines = []
  for (const e of excerpts || []) {
    const page = Math.max(1, Math.floor(Number(e.page)) || 1)
    lines.push(`> 【摘录】第 ${page} 页`)
    lines.push('> ' + norm(e.text))
  }
  const head = lines.length ? lines.join('\n') + '\n\n' : ''
  return head + String(body ?? '')
}

// 章节总结 md：标记行 + 章名行 + 空行 + 总结正文（与【摘录】头同构，
// 桌面 Typora 可读可改；章名截 60 字防超长大纲标题撑爆头区）
export function generateSummaryMd (summary, body) {
  const page = Math.max(1, Math.floor(Number(summary && summary.page)) || 1)
  const chapter = norm(summary && summary.chapter).slice(0, 60) || '本章'
  return `> 【总结】第 ${page} 页\n> ${chapter}\n\n${String(body ?? '')}`
}

// 解析：文件头部连续的 > 行为摘录/总结区（`> 【摘录】第 N 页` /
// `> 【总结】第 N 页` 开新块）；第一个非 > 行（包括分隔空行）终止头区。
// 返回 { ok, kind, body }：kind 'excerpt' | 'summary'。
// 没有【摘录】/【总结】头 = 普通笔记/被手改 → 降级（ok=false，整份当
// 正文，调用方不再重建头区；锚点仍有效）
export function parseRecordMd (text) {
  const src = String(text ?? '')
  const lines = src.split('\n')
  let i = 0
  let kind = null
  let lastHead = -1
  while (i < lines.length) {
    const ln = lines[i]
    // \r?：桌面 Typora 以 CRLF 保存时行尾带回车，不容忍会整份误判降级
    if (/^> 【摘录】第 \d+ 页\r?$/.test(ln)) { kind = kind || 'excerpt'; lastHead = i; i++; continue }
    if (/^> 【总结】第 \d+ 页\r?$/.test(ln)) { kind = 'summary'; lastHead = i; i++; continue }
    if (ln.startsWith('>')) { lastHead = i; i++; continue }
    break
  }
  if (!kind) return { ok: false, body: src }
  let j = lastHead + 1
  // 生成器只插入一个空行；正文自带的空行和引用必须逐字保留。
  if (j < lines.length && !lines[j].trim()) j++
  return { ok: true, kind, body: lines.slice(j).join('\n') }
}
