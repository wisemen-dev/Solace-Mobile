// 摘录链接（link.js）：把页面的隐藏文本层铺在 PDF 之上，供选句与标记。
// P2-T6：文本层核心（懒建 + 代数作废 + 按页缓存）；选词与记录编辑器见后续任务。
//
// 三个来源共同决定层内容：layout 事件（docId/页码/pageObj/viewport）、
// linksCache（本书的锚点记录）、textCache（按 doc:page 缓存的文本与区间映射）。
import pdfjsLib from '../pdfjs.js'
import { askConfirm } from '../dialog.js'
import { esc } from '../util.js'
import { buildPageText, splitSentences, sentenceAt, normalizeText, offsetToItem, findRangeByText } from './link-text.mjs'
import { generateRecordMd, parseRecordMd } from './link-md.mjs'

let host = null            // #previewBody（滚动容器，style.css 已 position:relative）
let pdfCanvas = null
let layer = null           // .ink-text-layer（懒建）
let lastLayout = null      // 最近一次 layout detail（含 pageObj/viewport）
let buildSeq = 0
const textCache = new Map()          // `${docId}:${page}` -> { tc, items, pageText, spans }
const linksCache = new Map()         // docId -> { records }
let selections = []                  // [{ page, text, hint }]（选词模式的整句选集）
let tray = null                      // #linkTray（选词托盘，懒建）
let pendingFlash = null              // { docId, file }：跳回定位时等目标页渲染完再闪烁

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
  renderMarkers(d)
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

/* ================= 标记渲染（记录锚点 / 选词选中态） ================= */

// 把页面文本区间 [start,end) 拆到它覆盖的各个文本项上（存项内相对偏移）
function rangesToItems (entry, start, end, file, cls, byItem) {
  for (let i = 0; i < entry.spans.length; i++) {
    const s = entry.spans[i]
    const a = Math.max(start, s.start)
    const b = Math.min(end, s.end)
    if (a >= b) continue
    const list = byItem.get(i) || []
    list.push({ from: a - s.start, to: b - s.start, file, cls })
    byItem.set(i, list)
  }
}

// 按区间把某项文本切成 文本节点 + 标记 span（一遍重建，重叠段取先登记者）
function paintItem (el, list) {
  const text = el.textContent
  const cuts = [...new Set([0, text.length, ...list.flatMap(r => [r.from, r.to])])]
    .filter(n => n >= 0 && n <= text.length).sort((a, b) => a - b)
  el.textContent = ''
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k]
    const b = cuts[k + 1]
    if (a >= b) continue
    const seg = text.slice(a, b)
    const hit = list.find(r => r.from <= a && b <= r.to)
    if (hit) {
      const mk = document.createElement('span')
      mk.className = hit.cls
      mk.dataset.file = hit.file
      mk.textContent = seg
      el.appendChild(mk)
    } else {
      el.appendChild(document.createTextNode(seg))
    }
  }
}

// 记录锚点（.lnk，text 经 findRangeByText 重锚定）+ 选词选中态（.lnk-sel）
// 合并成**一遍**重建：分两遍时后一遍会拿原文本重切，把前一遍的标记覆盖掉
function renderMarkers (d) {
  const entry = textCache.get(`${d.docId}:${d.page}`)
  if (!entry) return
  const byItem = new Map()
  const docLinks = linksCache.get(d.docId)
  for (const [file, rec] of Object.entries((docLinks && docLinks.records) || {})) {
    for (const ex of (rec && rec.excerpts) || []) {
      if (ex.page !== d.page) continue
      const hint = ex.hint != null && entry.spans[ex.hint.item]
        ? entry.spans[ex.hint.item].start + ex.hint.char
        : null
      const r = findRangeByText(entry.pageText, ex.text, hint)
      if (r) rangesToItems(entry, r.start, r.end, file, 'lnk', byItem)
    }
  }
  if (window.linkSelecting) {
    for (const sel of selections) {
      if (sel.page !== d.page) continue
      const hint = entry.spans[sel.hint.item] ? entry.spans[sel.hint.item].start + sel.hint.char : null
      const r = findRangeByText(entry.pageText, sel.text, hint)
      if (r) rangesToItems(entry, r.start, r.end, '__sel__', 'lnk-sel', byItem)
    }
  }
  for (const [i, list] of byItem) {
    const el = layer.querySelector(`[data-item="${i}"]`)
    if (el) paintItem(el, list)
  }
  // 跳回定位：目标页渲染完才闪（一次性消费）
  if (pendingFlash && pendingFlash.docId === d.docId) {
    const t = layer.querySelector(`.lnk[data-file="${CSS.escape(pendingFlash.file)}"]`)
    pendingFlash = null
    if (t) {
      t.scrollIntoView({ block: 'center' })
      t.classList.add('lnk-flash')
      setTimeout(() => t.classList.remove('lnk-flash'), 1100)
    }
  }
}

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

// 点按分流：记录标记优先（阅读模式也可点开，选中态标记不响应），其余走选词。
// 选词时命中判据用 [data-item] 反查文本项，再把项内字符偏移换算成页面文本偏移
function onLayerTap (e) {
  if (!lastLayout) return
  const mk = e.target && e.target.closest && e.target.closest('.lnk')
  if (mk && mk.dataset.file !== '__sel__') {
    openEditor({ mode: 'edit', file: mk.dataset.file, docId: lastLayout.docId })
    return
  }
  if (!window.linkSelecting) return
  const caret = document.caretPositionFromPoint
    ? document.caretPositionFromPoint(e.clientX, e.clientY)
    : (document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null)
  if (!caret) return
  const node = caret.offsetNode || caret.startContainer
  const el = node && node.nodeType === 1 ? node : node && node.parentElement
  const itemEl = el && el.closest('[data-item]')
  if (!itemEl || !layer.contains(itemEl)) return
  const item = Number(itemEl.dataset.item)
  const entry = textCache.get(`${lastLayout.docId}:${lastLayout.page}`)
  if (!entry || !entry.spans[item]) return
  // caret 偏移要相对**整个文本项**量：标记 span 把项文本切成了多个节点，
  // 直接取 caret.offset（相对所在文本节点）会算错
  let charInItem
  try {
    const range = document.createRange()
    range.selectNodeContents(itemEl)
    range.setEnd(node, caret.offset !== undefined ? caret.offset : caret.startOffset)
    charInItem = range.toString().length
  } catch { return }
  const span = entry.spans[item]
  const off = span.start + Math.min(charInItem, span.end - span.start)
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

// 记录编辑器：创建（整理本次选集）与编辑（回读 .md 正文）两条入口
let edDlg = null
let edCtx = null       // { mode, docId, file?, title, total, excerpts, degraded }
let edDirty = false
let edSaving = false

function ensureEditor () {
  if (edDlg) return
  const wrap = document.createElement('div')
  wrap.innerHTML = `
    <dialog id="linkRecordDialog" class="dialog note-editor-dialog">
      <div class="stats-head"><h3 id="linkRecordTitle">摘录记录</h3>
        <button id="btnLinkEdClose" class="btn-ghost" title="关闭">✕</button></div>
      <div id="linkChips" class="link-chips"></div>
      <textarea id="linkRecordText" class="note-editor-text" spellcheck="false" placeholder="写点什么…"></textarea>
      <div class="dialog-foot">
        <button id="btnLinkEdCancel" class="btn-ghost">取消</button>
        <button id="btnLinkEdSave" class="btn-primary">保存</button>
      </div>
    </dialog>`
  document.body.appendChild(wrap.firstElementChild)
  edDlg = document.getElementById('linkRecordDialog')
  edDlg.querySelector('#linkRecordText').addEventListener('input', () => { edDirty = true })
  edDlg.querySelector('#btnLinkEdSave').addEventListener('click', saveEditor)
  edDlg.querySelector('#btnLinkEdCancel').addEventListener('click', requestEditorClose)
  edDlg.querySelector('#btnLinkEdClose').addEventListener('click', requestEditorClose)
  // 返回键：boot.mjs 先给最上层对话框一次拦截机会（未保存时弹确认）
  edDlg.addEventListener('solace-close-request', (e) => { if (edDirty) { e.preventDefault(); requestEditorClose() } })
}

function renderChips () {
  const box = edDlg.querySelector('#linkChips')
  box.innerHTML = edCtx.degraded
    ? '<span class="link-chip-degraded">文件格式已被外部修改，将按普通笔记保存（锚点保留）</span>'
    : edCtx.excerpts.map((x, i) =>
      `<span class="link-chip"><b>第 ${x.page} 页</b> ${esc(x.text.slice(0, 40))}<button class="chip-x" data-i="${i}" title="移除">✕</button></span>`).join('')
  box.querySelectorAll('.chip-x').forEach(b => b.addEventListener('click', () => {
    edCtx.excerpts.splice(Number(b.dataset.i), 1)
    edDirty = true
    renderChips()
  }))
}

async function openEditor (opts = {}) {
  ensureEditor()
  if (opts.mode === 'edit') {
    const docLinks = linksCache.get(opts.docId)
    const rec = docLinks && docLinks.records[opts.file]
    if (!rec) { window.toast?.('记录已不存在'); return }
    let raw = ''
    try {
      raw = await window.solace.readNote(opts.docId, opts.file)
    } catch (err) { window.toast?.(`读取失败：${err.message || err}`); return }
    const parsed = parseRecordMd(raw)
    // 正文被外部改过（无【摘录】头）→ 降级：按普通笔记保存，锚点保留不动
    edCtx = { mode: 'edit', docId: opts.docId, file: opts.file, excerpts: rec.excerpts.map(x => ({ ...x })), degraded: !parsed.ok }
    edDlg.querySelector('#linkRecordText').value = parsed.body
    edDlg.querySelector('#linkRecordTitle').textContent = '摘录记录'
  } else {
    edCtx = {
      mode: 'create',
      docId: lastLayout.docId,
      title: (document.getElementById('previewTitle') || {}).textContent || '摘录',
      total: Number((document.getElementById('pageTotal') || {}).textContent) || 0,
      excerpts: selections.map(s => ({ ...s })),
      degraded: false
    }
    edDlg.querySelector('#linkRecordText').value = ''
    edDlg.querySelector('#linkRecordTitle').textContent = '新建摘录记录'
  }
  edDirty = false
  renderChips()
  edDlg.showModal()
  setTimeout(() => edDlg.querySelector('#linkRecordText').focus(), 60)
}

async function requestEditorClose () {
  if (edDirty) {
    const r = await askConfirm({ title: '放弃未保存的修改？', text: '关闭后这些内容将丢失。', okText: '放弃修改' })
    if (!r) return
  }
  edDirty = false
  edDlg.close()
  // 创建流取消：选集保留、仍在选词模式（spec §6.3），无需额外动作
}

async function saveEditor () {
  if (edSaving || !edCtx) return
  edSaving = true
  const btn = edDlg.querySelector('#btnLinkEdSave')
  btn.disabled = true
  try {
    if (edCtx.mode === 'create') {
      const { file } = await window.solace.createNote(edCtx.docId, { title: edCtx.title, page: edCtx.excerpts[0]?.page || 1, total: edCtx.total })
      edCtx.file = file
      edCtx.mode = 'edit' // 失败重试时不再重复建文件（幂等）
    }
    const body = edDlg.querySelector('#linkRecordText').value
    const content = edCtx.degraded ? body : generateRecordMd(edCtx.excerpts, body)
    await window.solace.writeNote(edCtx.docId, edCtx.file, content)
    if (!edCtx.degraded) {
      // 摘录全移除 → entry 传 null 即删条目（.md 同步退化成普通笔记）
      await window.solace.setNoteLinkEntry(edCtx.docId, edCtx.file, edCtx.excerpts.length ? { excerpts: edCtx.excerpts } : null)
    }
    const { docId } = edCtx
    edDirty = false
    edDlg.close()
    window.toast?.('记录已保存')
    linksCache.delete(docId)
    await loadLinks(docId)
    if (lastLayout && lastLayout.docId === docId) await buildLayer(lastLayout)
    window.dispatchEvent(new CustomEvent('solace-note-saved', { detail: { docId } }))
    if (window.linkSelecting) closeSelection(true) // 创建完成即退出选词
  } catch (err) {
    window.toast?.(`保存失败：${err.message || err}`) // 留在编辑器，重试幂等（同一 file）
  } finally {
    edSaving = false
    btn.disabled = false
  }
}

// 点按监听绑在 #previewBody（静态 HTML，模块求值时已在）。文本层默认
// pointer-events:none，选词模式下由 CSS 放开，事件冒泡到 body 层最稳
document.getElementById('previewBody')?.addEventListener('pointerup', onLayerTap)
