// 摘录链接（link.js）：把页面的隐藏文本层铺在 PDF 之上，供选句与标记。
// P2-T6：文本层核心（懒建 + 代数作废 + 按页缓存）；选词与记录编辑器见后续任务。
//
// 三个来源共同决定层内容：layout 事件（docId/页码/pageObj/viewport）、
// linksCache（本书的锚点记录）、textCache（按 doc:page 缓存的文本与区间映射）。
import pdfjsLib from '../pdfjs.js'
import { buildPageText } from './link-text.mjs'

let host = null            // #previewBody（滚动容器，style.css 已 position:relative）
let pdfCanvas = null
let layer = null           // .ink-text-layer（懒建）
let lastLayout = null      // 最近一次 layout detail（含 pageObj/viewport）
let buildSeq = 0
const textCache = new Map()          // `${docId}:${page}` -> { tc, items, pageText, spans }
const linksCache = new Map()         // docId -> { records }

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
