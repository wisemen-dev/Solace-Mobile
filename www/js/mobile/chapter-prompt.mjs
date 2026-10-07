// 章界与跨章判定（纯函数，node 可单测）。设计书 READING-RECORDS-DESIGN §5.1：
// 大纲顶级条目为章；向前翻页跨过某章最后一页 = 读完该章（提示对象是
// **离开的**章）；短于 minPages 的章不提示（密集小节防刷屏）。
const normTitle = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)

// 大纲条目（preview.js 派发的 flat：{title,page,depth}）→ 章表：
// 取顶级（depth 0）、页码有效、标题非空；按页升序，同页去重（保首个）
export function topChapters (items) {
  const out = []
  for (const it of items || []) {
    if (!it || it.depth !== 0) continue
    const page = Number(it.page)
    if (!Number.isInteger(page) || page < 1) continue
    const title = normTitle(it.title)
    if (!title) continue
    out.push({ title, page })
  }
  out.sort((a, b) => a.page - b.page)
  const dedup = []
  for (const c of out) {
    if (dedup.length && dedup[dedup.length - 1].page === c.page) continue
    dedup.push(c)
  }
  return dedup
}

// 页 → 章下标：起页 <= page 的最后一章；第一章之前（前言/封面区）= -1
export function chapterIndexAt (chapters, page) {
  if (!Array.isArray(chapters) || !chapters.length) return -1
  const p = Number(page)
  if (!Number.isFinite(p)) return -1
  let idx = -1
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].page <= p) idx = i
    else break
  }
  return idx
}

// 离开的章是否够长（>= minPages）：章长 = 下一章起页 − 本章起页。
// 最后一章没有下界，恒视为足够（它不可能作为「被离开的章」出现——
// 后面没有章，不可能向前离开它，此分支只为健壮）
export function chapterLongEnough (chapters, index, minPages = 4) {
  if (!Array.isArray(chapters) || index < 0 || index >= chapters.length) return false
  const next = chapters[index + 1]
  if (!next) return true
  return next.page - chapters[index].page >= minPages
}

// 跨界检测：prevPage → page 向前跨过章界时返回被离开章的下标，否则 null。
// 前言区（下标 -1）不算章——从前言翻进第 1 章不提示
export function detectCross (chapters, prevPage, page) {
  const prev = chapterIndexAt(chapters, prevPage)
  const curr = chapterIndexAt(chapters, page)
  if (prev < 0 || curr <= prev) return -1
  return prev
}
