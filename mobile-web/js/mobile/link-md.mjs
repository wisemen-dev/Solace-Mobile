// 摘录记录 .md 的生成与解析（纯函数，node 可单测）。
// 记录文件放 notes/<docId>/（.md 互通不变量）；摘录区由锚点数据重建，
// .md 是锚点的可读镜像——桌面 Typora 看到的即完整摘录+正文。
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

// 解析：文件头部连续的 > 行为摘录区（`> 【摘录】第 N 页` 开新块）；
// 第一个非 > 行（包括分隔空行）终止摘录区。没有【摘录】头 = 普通笔记/被手改 → 降级
// （ok=false，整份当正文，调用方不再重建摘录区；锚点仍有效）
export function parseRecordMd (text) {
  const src = String(text ?? '')
  const lines = src.split('\n')
  let i = 0
  let sawHeader = false
  let lastExcerpt = -1
  while (i < lines.length) {
    const ln = lines[i]
    if (/^> 【摘录】第 \d+ 页$/.test(ln)) { sawHeader = true; lastExcerpt = i; i++; continue }
    if (ln.startsWith('>')) { lastExcerpt = i; i++; continue }
    break
  }
  if (!sawHeader) return { ok: false, body: src }
  let j = lastExcerpt + 1
  // 生成器只插入一个空行；正文自带的空行和引用必须逐字保留。
  if (j < lines.length && !lines[j].trim()) j++
  return { ok: true, body: lines.slice(j).join('\n') }
}
