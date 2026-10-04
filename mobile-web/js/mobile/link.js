// 摘录链接（link.js）：把页面的隐藏文本层铺在 PDF 之上，供选句与标记。
// P2-T6：文本层核心（懒建 + 代数作废 + 按页缓存）；选词与记录编辑器见后续任务。
//
// 三个来源共同决定层内容：layout 事件（docId/页码/pageObj/viewport）、
// linksCache（本书的锚点记录）、textCache（按 doc:page 缓存的文本与区间映射）。
import pdfjsLib from '../pdfjs.js'
import { buildPageText, splitSentences, sentenceAt, normalizeText, offsetToItem } from './link-text.mjs'

let host = null            // #previewBody（滚动容器，style.css 已 position:relative）
let pdfCanvas = null
let layer = null           // .ink-text-layer（懒建）
let lastLayout = null      // 最近一次 layout detail（含 pageObj/viewport）
let buildSeq = 0
const textCache = new Map()          // `${docId}:${page}` -> { tc, items, pageText, spans }
const linksCache = new Map()         // docId -> { records }
let selections = []                  // [{ page, text, hint }]（选词模式的整句选集）
let tray = null                      // #linkTray（选词托盘，懒建）

window.linkSelecting = false

function ensureDom () {
  if (host) return
  host = document.getElementById('previewBody')
  pdfCanvas = document.getElementById('previewCanvas')
}

// 懒建：本书有记录、或正在选词，才需要文本层；纯图形书不占 DOM
function shouldBuild () {
  const recs = lastLayout && linksCache.get(lastLayout.docId)
  return window.linkSelecting || !!(recs && Object.keys(recs.records).length)
}

async function loadLinks (docId) {
  if (!docId || linksCache.has(docId)) return linksCache.get(docId)
  let data = { records: {} }
  try { data = await window.solace.readNoteLinks(docId) } catch { /* 读失败按无记录 */ }
  if (data.notice) window.toast?.(data.notice)
  linksCache.set(docId, data)
  return data
}

function ensureLayer () {
  ensureDom()
  if (layer || !host) return
  layer = document.createElement('div')
  layer.className = 'ink-text-layer'
  layer.hidden = true
  host.insertBefore(layer, document.getElementById('previewError'))
  // 选词模式的点按/选择监听在 T7 接入（本任务只有渲染，无交互）
}

function applyLayout (d) {
  if (!layer || !d) return
  layer.style.left = pdfCanvas.offsetLeft + 'px'
  layer.style.top = pdfCanvas.offsetTop + 'px'
  layer.style.width = d.cssW + 'px'
  layer.style.height = d.cssH + 'px'
  // span 的字号与定位是 calc(var(--scale-factor)*…)：必须给 CSS 尺度而非
  // 设备像素尺度（dpr=1 时两者相同，平板上差一倍、文字会大一圈且错位）
  layer.style.setProperty('--scale-factor', String(d.cssW / d.baseW))
}

async function buildLayer (d) {
  const seq = ++buildSeq
  await loadLinks(d.docId)
  if (seq !== buildSeq) return
  if (!shouldBuild()) { layer.textContent = ''; layer.hidden = true; return }
  const key = `${d.docId}:${d.page}`
  let entry = textCache.get(key)
  if (!entry) {
    const tc = await d.pageObj.getTextContent()
    if (seq !== buildSeq) return
    const { text, spans } = buildPageText(tc.items)
    entry = { tc, items: tc.items, pageText: text, spans }
    textCache.set(key, entry)
  }
  // TextLayer 只会往容器里 append：不清空会逐页/逐次累积
  layer.textContent = ''
  const tl = new pdfjsLib.TextLayer({
    textContentSource: entry.tc,
    container: layer,
    viewport: d.pageObj.getViewport({ scale: d.cssW / d.baseW })
  })
  await tl.render()
  if (seq !== buildSeq) return
  // textDivs[i] 与 items[i] 一一对应（含 hasEOL 项；br 不在 textDivs 里）
  tl.textDivs.forEach((el, i) => { el.dataset.item = String(i) })
  layer.hidden = false
  // L10 降级：选词模式下遇到没有文字的页 → 提示并退出（无文字书不建层的
  // 懒建规则与选词强建冲突时：强建一次、发现无字即退）
  if (window.linkSelecting && !tl.textDivs.length) {
    window.toast?.('本页没有可选择的文字，翻到有文字的页面再试')
    closeSelection(true)
  }
}

window.addEventListener('solace-ink-layout', async (e) => {
  const d = e.detail
  if (!d || !d.docId || !d.pageObj) return
  ensureLayer()
  lastLayout = d
  applyLayout(d)
  await buildLayer(d)
})

window.addEventListener('solace-ink-close', () => {
  buildSeq++
  lastLayout = null
  if (layer) { layer.textContent = ''; layer.hidden = true }
})

/* ================= 选词模式（整句点选 / 托盘 / 跨页 / 与墨水互斥） ========= */

function ensureTray () {
  if (tray) return
  tray = document.createElement('div')
  tray.id = 'linkTray'
  tray.className = 'link-tray'
  tray.hidden = true
  tray.innerHTML = `
    <span id="linkTrayCount" class="link-tray-count"></span>
    <button id="btnLinkCancel" class="btn-ghost">取消</button>
    <button id="btnLinkDone" class="btn-primary" disabled>完成</button>`
  document.getElementById('previewOverlay').appendChild(tray)
  tray.querySelector('#btnLinkCancel').addEventListener('click', () => closeSelection(true))
  tray.querySelector('#btnLinkDone').addEventListener('click', () => openEditor({ mode: 'create' }))
}

function trayUpdate () {
  if (!tray) return
  const pages = new Set(selections.map(s => s.page))
  tray.querySelector('#linkTrayCount').textContent = `已选 ${selections.length} 处 · 跨 ${pages.size} 页`
  tray.querySelector('#btnLinkDone').disabled = selections.length === 0
}

async function openSelection () {
  ensureDom(); ensureLayer(); ensureTray()
  // 与墨水互斥：选词中不叠标注模式（ink 的退出即冲刷保存）
  if (window.inkActive) window.dispatchEvent(new CustomEvent('solace-ink-exit-request'))
  window.linkSelecting = true
  selections = []
  trayUpdate()
  tray.hidden = false
  document.body.classList.add('link-selecting')
  if (lastLayout) await buildLayer(lastLayout)
}

function closeSelection (clear) {
  if (clear) selections = []
  window.linkSelecting = false
  document.body.classList.remove('link-selecting')
  if (tray) tray.hidden = true
  buildSeq++
  if (lastLayout) buildLayer(lastLayout).catch(() => {})
}

window.addEventListener('solace-link-cancel-request', () => { if (window.linkSelecting) closeSelection(true) })
document.getElementById('btnLink')?.addEventListener('click', () => openSelection())

// 选词模式点按：caret 命中 → 页面文本偏移 → 整句扩选/取消。
// 命中判据用 [data-item] 反查文本项，再把 span 内字符偏移换算成页面文本偏移
function onLayerTap (e) {
  if (!window.linkSelecting || !lastLayout) return
  const caret = document.caretPositionFromPoint
    ? document.caretPositionFromPoint(e.clientX, e.clientY)
    : (document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null)
  if (!caret) return
  const node = caret.offsetNode || caret.startContainer
  const el = node && node.nodeType === 1 ? node : node && node.parentElement
  const itemEl = el && el.closest('[data-item]')
  if (!itemEl || !layer.contains(itemEl)) return
  const item = Number(itemEl.dataset.item)
  const charInNode = caret.offset !== undefined ? caret.offset : caret.startOffset
  const entry = textCache.get(`${lastLayout.docId}:${lastLayout.page}`)
  if (!entry || !entry.spans[item]) return
  const span = entry.spans[item]
  const off = span.start + Math.min(charInNode, span.end - span.start)
  const sentences = splitSentences(entry.pageText)
  const si = sentenceAt(sentences, off)
  const r = sentences[si]
  if (!r) return
  const text = normalizeText(entry.pageText.slice(r.start, r.end))
  if (!text) return
  const hint = offsetToItem(entry.spans, r.start)
  const idx = selections.findIndex(s => s.page === lastLayout.page && s.hint.item === hint.item && s.hint.char === hint.char)
  if (idx >= 0) selections.splice(idx, 1) // 再点同一句 = 取消
  else selections.push({ page: lastLayout.page, text, hint })
  trayUpdate()
  buildLayer(lastLayout).catch(() => {}) // 重绘选中态（T8 标记渲染后合并进同一渲染）
}

// 占位：完整的记录编辑器在 T9 落地时替换本函数（保证中间提交不落破损态）
function openEditor () { window.toast?.('记录编辑器将在下一任务接入') }

// 点按监听绑在 #previewBody（静态 HTML，模块求值时已在）。文本层默认
// pointer-events:none，选词模式下由 CSS 放开，事件冒泡到 body 层最稳
document.getElementById('previewBody')?.addEventListener('pointerup', onLayerTap)
