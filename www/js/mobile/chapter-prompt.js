// 章节总结提醒（READING-RECORDS-DESIGN §5.1）：向前翻页跨过章界时，底部
// 浮现非阻断小条——读完一章可选写总结。章界与守卫判定是纯函数
// （chapter-prompt.mjs，随单测）；本模块只管事件接线、小条 DOM 与生命周期。
import { topChapters, chapterIndexAt, chapterLongEnough, detectCross } from './chapter-prompt.mjs'

const overlay = document.getElementById('previewOverlay')

let chapters = []        // 本书章表（无大纲 = 空 → 功能自然缺席，§5.4）
let prompted = new Set() // 已提示过的章下标（内存去重，开书/换书重置）
let prevPage = null      // 上一次渲染的页码（跨界检测用）
let lastDocId = null
let lastPage = null      // 最近页码（📝 手动入口取当前章用）
let bar = null
let hideTimer = 0

function hideBar () {
  if (bar) bar.hidden = true
  clearTimeout(hideTimer)
}

function resetBook () {
  chapters = []
  prompted = new Set()
  prevPage = null
  lastPage = null
  lastDocId = null
  hideBar()
  const btn = document.getElementById('btnNoteSummary')
  if (btn) btn.hidden = true
}

// 守卫（§5.1）：创作模式中、对话框开着、预览没开——都不打扰
function suppressed () {
  return window.inkActive || window.linkSelecting ||
    !!document.querySelector('dialog[open]') || !overlay || overlay.hidden
}

function ensureBar () {
  if (bar) return
  bar = document.createElement('div')
  bar.className = 'chapter-prompt'
  bar.hidden = true
  bar.innerHTML = `
    <span class="cp-text"></span>
    <button class="cp-write" title="写本章总结"><span class="cp-ico">✎</span><span class="cp-label"></span></button>
    <button class="cp-close" title="收起">✕</button>`
  // 挂 previewOverlay（不随正文滚动）；bottom 74px = 底栏(58) + 间隙
  overlay.appendChild(bar)
  bar.querySelector('.cp-write').addEventListener('click', () => {
    const idx = Number(bar.dataset.idx)
    const ch = chapters[idx]
    hideBar()
    if (ch && lastDocId) window.__linkOpenSummary?.(lastDocId, ch)
  })
  bar.querySelector('.cp-close').addEventListener('click', hideBar)
}

function showBar (index) {
  const ch = chapters[index]
  if (!ch || !lastDocId) return
  ensureBar()
  const st = window.__linkSummaryState?.(lastDocId, ch.title) || { known: false, exists: false }
  bar.dataset.idx = String(index)
  bar.querySelector('.cp-text').textContent = st.exists ? `《${ch.title}》已总结` : `读完《${ch.title}》`
  bar.querySelector('.cp-label').textContent = st.exists ? '查看' : '写总结'
  bar.hidden = false
  clearTimeout(hideTimer)
  hideTimer = setTimeout(hideBar, 6000) // 6 秒无操作自动散（§5.1）
}

/* ---- 大纲：preview.js 补丁在目录构建完成时派发（无大纲不派发） ---- */
window.addEventListener('solace-outline', (e) => {
  chapters = topChapters(e.detail && e.detail.items)
  prompted = new Set()
  const btn = document.getElementById('btnNoteSummary')
  if (btn) btn.hidden = !chapters.length
})

/* ---- 翻页：布局事件带页码（含首次打开）。换书/开书重置；向前跨界提示 ---- */
window.addEventListener('solace-ink-layout', (e) => {
  const d = e.detail
  if (!d || !d.docId || d.page == null) return
  if (d.docId !== lastDocId) {
    // 开书/换书：清去重与页码轨迹（chapters 等下一次大纲派发重置）
    prompted = new Set()
    prevPage = null
    lastDocId = d.docId
    hideBar()
  }
  const from = prevPage
  prevPage = d.page
  lastPage = d.page
  if (from == null) return            // 首次布局不是跨界
  if (from === d.page) return
  if (!chapters.length) return        // 无大纲：功能缺席（§5.4）
  if (suppressed()) { hideBar(); return }
  const idx = detectCross(chapters, from, d.page)
  if (idx >= 0 && chapterLongEnough(chapters, idx) && !prompted.has(idx)) {
    prompted.add(idx)
    showBar(idx)
  } else {
    hideBar() // 继续翻页消散（§5.1）
  }
})

/* ---- 关预览：复位全部状态，重开不残留 ---- */
window.addEventListener('solace-ink-close', resetBook)

/* ---- 创作模式互斥（同 tools.js 的让位原则）：进标注/选词即收小条 ---- */
new MutationObserver(() => {
  if (document.body.classList.contains('ink-active') || document.body.classList.contains('link-selecting')) hideBar()
}).observe(document.body, { attributes: true, attributeFilter: ['class'] })

/* ---- 簇外点按消散（不拦事件——被点元素照常工作） ---- */
document.addEventListener('pointerdown', (e) => {
  if (bar && !bar.hidden && !bar.contains(e.target)) hideBar()
}, true)

/* ---- 面板手动入口：「📝 总结」为当前页所在章写/续写（§5.3） ---- */
const btnNew = document.getElementById('btnNoteNew')
if (btnNew && btnNew.parentNode) {
  const btn = document.createElement('button')
  btn.id = 'btnNoteSummary'
  btn.className = 'btn-ghost'
  btn.title = '为当前所在的章写总结'
  btn.hidden = true // 无大纲的书功能缺席（§5.4），大纲派发后再亮出
  btn.textContent = '📝 总结'
  btn.addEventListener('click', () => {
    if (!lastDocId || !chapters.length || lastPage == null) return
    const i = chapterIndexAt(chapters, lastPage)
    if (i < 0) { window.toast?.('当前页不在任何章内'); return }
    window.__linkOpenSummary?.(lastDocId, chapters[i])
  })
  btnNew.parentNode.insertBefore(btn, btnNew)
}
