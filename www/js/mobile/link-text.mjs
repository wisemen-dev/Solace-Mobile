// 页面文本构建 / 句子切分 / 偏移映射 / 重锚定查找（纯函数，node 可单测）。
// items = pdf.js getTextContent().items（[{ str, hasEOL }]）

export function buildPageText (items) {
  let text = ''
  const spans = []
  for (let i = 0; i < items.length; i++) {
    const s = String(items[i].str ?? '')
    const start = text.length
    text += s
    spans.push({ start, end: text.length })
    if (items[i].hasEOL) text += '\n'
  }
  return { text, spans }
}

export function offsetToItem (spans, off) {
  for (let i = 0; i < spans.length; i++) {
    if (off < spans[i].start) {
      return i > 0
        ? { item: i - 1, char: spans[i - 1].end - spans[i - 1].start }
        : { item: 0, char: 0 }
    }
    if (off < spans[i].end) return { item: i, char: off - spans[i].start }
  }
  const last = spans.length - 1
  return last >= 0 ? { item: last, char: spans[last].end - spans[last].start } : { item: 0, char: 0 }
}

const CLOSERS = '」』”’）】》»\')]'

export function splitSentences (text) {
  const out = []
  let start = 0
  const isEnd = (ch, next) => {
    if ('。！？；…!?;'.includes(ch)) return true
    if (ch === '\n') return true
    if (ch === '.' && (next === undefined || next === ' ' || next === '\n' || next === '\t')) return true
    return false
  }
  for (let i = 0; i < text.length; i++) {
    if (!isEnd(text[i], text[i + 1])) continue
    let end = i + 1
    while (end < text.length && CLOSERS.includes(text[end])) end++
    // 终止符后的空白归上一句：'.' 后跟空格才断句，那个空格属于本句；
    // 换行同理（'\n' 是终止符本身，已被包含）。不吸收会切出只含 '\n' 的
    // 垃圾句——归一化后为空，点上去毫无反应
    while (end < text.length && /\s/.test(text[end])) end++
    out.push({ start, end })
    start = end
  }
  if (start < text.length) out.push({ start, end: text.length })
  return out
}

export function sentenceAt (sentences, off) {
  for (let i = 0; i < sentences.length; i++) if (off < sentences[i].end) return i
  return sentences.length - 1
}

export function normalizeText (s) { return String(s ?? '').replace(/\s+/g, ' ').trim() }

// 自由选区（§6.6）：a/b 为页面文本偏移（方向不限，内部排序），返回与整句
// 选集同形的 { text, hint }——text 承载选区全部信息，hint 取起点供重锚定
// 消歧。空/纯空白返回 null（调用方丢弃，不出确认小条）
export function makeFreeSelection (pageText, spans, offA, offB) {
  const a = Math.max(0, Math.min(offA, offB))
  const b = Math.min(pageText.length, Math.max(offA, offB))
  const text = normalizeText(pageText.slice(a, b))
  if (!text) return null
  return { text, hint: offsetToItem(spans, a) }
}

// 端点步进（§6.6 确认小条 ‹/›）：向外移一字并跳过空白——落在空白上
// 视觉无变化。dir<0 左端外扩（a 左移），dir>0 右端外扩（b 右移）
export function stepEndpoint (pageText, off, dir) {
  if (dir < 0) {
    let a = off
    while (a > 0 && /\s/.test(pageText[a - 1])) a--
    return Math.max(0, a - 1)
  }
  let b = off
  while (b < pageText.length && /\s/.test(pageText[b])) b++
  return Math.min(pageText.length, b + 1)
}

export function buildSearchIndex (text) {
  let norm = ''
  const back = []
  let pendingSpace = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (norm.length && !pendingSpace) { norm += ' '; back.push(i) }
      pendingSpace = true
      continue
    }
    pendingSpace = false
    norm += ch
    back.push(i)
  }
  if (norm.endsWith(' ')) { norm = norm.slice(0, -1); back.pop() }
  back.push(text.length)
  return { norm, back }
}

export function findRangeByText (text, target, hintRaw = null) {
  const t = normalizeText(target)
  if (!t) return null
  const { norm, back } = buildSearchIndex(text)
  const hits = []
  let idx = norm.indexOf(t)
  while (idx >= 0) { hits.push(idx); idx = norm.indexOf(t, idx + 1) }
  if (!hits.length) return null
  let pick = hits[0]
  if (hits.length > 1 && hintRaw != null) {
    let best = Infinity
    for (const h of hits) {
      const d = Math.abs(back[h] - hintRaw)
      if (d < best) { best = d; pick = h }
    }
  }
  return { start: back[pick], end: back[pick + t.length] }
}
