// 摘录链接（link.js）：把页面的隐藏文本层铺在 PDF 之上，供选句与标记。
// 文本层核心（懒建 + 代数作废 + 按页缓存）、选词模式、标记渲染与记录编辑器。
//
// 三个来源共同决定层内容：layout 事件（docId/页码/pageObj/viewport）、
// linksCache（本书的锚点记录）、textCache（按 doc:page 缓存的文本与区间映射）。
import pdfjsLib from '../pdfjs.js'
import { askConfirm } from '../dialog.js'
import { esc } from '../util.js'
import { closeNotes } from '../notespanel.js'
import { buildPageText, splitSentences, sentenceAt, normalizeText, offsetToItem, findRangeByText } from './link-text.mjs'
import { generateRecordMd, parseRecordMd } from './link-md.mjs'
import { jumpPage } from './page-jump.mjs'

let host = null            // #previewBody（滚动容器，style.css 已 position:relative）
let pdfCanvas = null
let layer = null           // .ink-text-layer（懒建）
let lastLayout = null      // 最近一次 layout detail（含 pageObj/viewport）
let buildSeq = 0
const textCache = new Map()          // `${docId}:${page}` -> { tc, items, pageText, spans }
// 每页 TextContent 数十 KB 级且无失效时机，LRU 封顶防长会话逐页翻多本书后
// 只增不减（移动 WebView 内存压力 → OOM）
const TEXT_CACHE_MAX = 24
function textCacheGet (key) {
  if (!textCache.has(key)) return undefined
  const v = textCache.get(key)
  textCache.delete(key); textCache.set(key, v) // 重插 = 标记最近使用
  return v
}
function textCacheSet (key, v) {
  textCache.delete(key); textCache.set(key, v)
  while (textCache.size > TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value)
}
const linksCache = new Map()         // docId -> { records }
let selections = []                  // [{ page, text, hint }]（选词模式的整句选集）
let tray = null                      // #linkTray（选词托盘，懒建）
let pendingFlash = null              // { docId, file, page }：跳回定位待闪标记（同页当场闪，异页等渲染）
let layerDown = null                 // 点按判定起点 { id, x, y, t }（与 mobile.js 同风格）

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
  try {
    const data = await window.solace.readNoteLinks(docId)
    if (data.notice) window.toast?.(data.notice)
    linksCache.set(docId, data)
    return data
  } catch {
    // 读失败按无记录，但**不缓存**：一次瞬时失败（如读目录失败触发的保护性
    // 上抛）不该把「空」钉到整段预览会话，下次渲染重试
    return { records: {} }
  }
}

function ensureLayer () {
  ensureDom()
  if (layer || !host) return
  layer = document.createElement('div')
  layer.className = 'ink-text-layer'
  layer.hidden = true
  host.insertBefore(layer, document.getElementById('previewError'))
  // 点按/选择监听在模块底部统一绑定（见 onLayerTap；本函数只管图层 DOM）
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
  let entry = textCacheGet(key)
  if (!entry) {
    const tc = await d.pageObj.getTextContent()
    if (seq !== buildSeq) return
    const { text, spans } = buildPageText(tc.items)
    entry = { tc, items: tc.items, pageText: text, spans }
    textCacheSet(key, entry)
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
  // 预览关闭 = 会话结束：选词状态必须全复位——残留的 linkSelecting 会挡住
  // 边缘点按翻页、吞掉下一个返回键；残留的选集/托盘会在下一本书里以当前书
  // 为 docId 误存旧书摘录
  selections = []
  window.linkSelecting = false
  document.body.classList.remove('link-selecting')
  if (tray) tray.hidden = true
  pendingFlash = null
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
  const entry = textCacheGet(`${d.docId}:${d.page}`)
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
  // 跳回定位：目标页渲染完才闪（一次性消费；同页跳回在 jumpToExcerpt 直接闪）
  if (pendingFlash && pendingFlash.docId === d.docId && String(pendingFlash.page) === String(d.page)) {
    tryFlashNow()
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
  // §6.5：进选词自动收起目录/笔记面板（preview.js 的「点正文收面板」只覆盖
  // 正文点击，从顶栏按钮进选词不经过它；留着面板会压住选词区与点按）
  const toc = document.getElementById('tocPanel')
  if (toc) toc.hidden = true
  closeNotes()
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
  // 点按判定（§6.2，同 mobile.js 风格）：<300ms 且位移 <12px 才算点按。
  // 横向滑动翻页在选词模式是保留手势（跨页累积靠它），其释放也会路过本层
  // ——不设门槛会把翻页当成选句，甚至误开标记编辑器
  const d = layerDown
  layerDown = null
  if (!d || e.pointerId !== d.id) return
  if (Date.now() - d.t >= 300 || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 12) return
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
  const entry = textCacheGet(`${lastLayout.docId}:${lastLayout.page}`)
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
  buildLayer(lastLayout).catch(() => {}) // 重绘选中态（标记与选中态在一次重建里合并渲染）
}

// 记录编辑器：创建（整理本次选集）与编辑（回读 .md 正文）两条入口
let edDlg = null
let edCtx = null       // { mode, docId, file?, title, total, excerpts, degraded }
let edDirty = false
let edExcerptsTouched = false // 本次编辑是否动过摘录 chips（降级时据此决定是否写侧车）
let edSaving = false
let edOpening = false   // openEditor 的 await 窗口防重入（二次 showModal 会抛 InvalidStateError）
let edClosing = false   // requestEditorClose 的 await 窗口防重入（连按返回会叠开确认框）

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
  edDlg.addEventListener('solace-close-request', (e) => { if (edSaving || edDirty) { e.preventDefault(); requestEditorClose() } })
  edDlg.addEventListener('cancel', (e) => { e.preventDefault(); requestEditorClose() })
}

function renderChips () {
  const box = edDlg.querySelector('#linkChips')
  const chips = edCtx.excerpts.map((x, i) =>
    `<span class="link-chip"><b>第 ${x.page} 页</b> ${esc(x.text.slice(0, 40))}<button class="chip-x" data-i="${i}" title="移除">✕</button></span>`).join('')
  // 降级（正文被外部改过）时正文按原样保存、不重建摘录区，但摘录条目仍要
  // 可移除——归属释放（§6.2）与「全移除退化为普通笔记」（§6.3）都靠它
  box.innerHTML = (edCtx.degraded
    ? '<span class="link-chip-degraded">正文格式已被外部修改，将按原样保存；摘录仍可在此移除</span>'
    : '') + chips
  box.querySelectorAll('.chip-x').forEach(b => b.addEventListener('click', () => {
    if (edSaving) return
    edCtx.excerpts.splice(Number(b.dataset.i), 1)
    edDirty = true
    edExcerptsTouched = true
    renderChips()
  }))
}

async function openEditor (opts = {}) {
  if (edSaving || edOpening) return
  edOpening = true
  try {
    ensureEditor()
    if (opts.mode === 'edit') {
      const docLinks = linksCache.get(opts.docId)
      const rec = docLinks && docLinks.records[opts.file]
      if (!rec) { window.toast?.('记录已不存在'); return }
      let raw = ''
      try {
        raw = await window.solace.readNote(opts.docId, opts.file)
      } catch (err) { window.toast?.(`读取失败：${err.message || err}`); return }
      if (edSaving) return // 读笔记期间另一条编辑流程可能已经开始保存
      const parsed = parseRecordMd(raw)
      // 正文被外部改过（无【摘录】头）→ 降级：按普通笔记保存，锚点保留不动
      edCtx = { mode: 'edit', flow: 'edit', docId: opts.docId, file: opts.file, excerpts: rec.excerpts.map(x => ({ ...x })), degraded: !parsed.ok }
      edDlg.querySelector('#linkRecordText').value = parsed.body
      edDlg.querySelector('#linkRecordTitle').textContent = '摘录记录'
    } else {
      edCtx = {
        mode: 'create',
        flow: 'create', // 流程来源（mode 会在建文件后转 edit 防重复建，flow 不变）
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
    edExcerptsTouched = false
    renderChips()
    edDlg.showModal()
    setTimeout(() => edDlg.querySelector('#linkRecordText').focus(), 60)
  } finally {
    edOpening = false
  }
}

async function requestEditorClose () {
  if (edSaving || edClosing) return
  edClosing = true
  try {
    if (edDirty) {
      const r = await askConfirm({ title: '放弃未保存的修改？', text: '关闭后这些内容将丢失。', okText: '放弃修改' })
      if (!r) return
    }
    edDirty = false
    edDlg.close()
    // 创建流取消：选集保留、仍在选词模式（spec §6.3），无需额外动作
  } finally {
    edClosing = false
  }
}

async function saveEditor () {
  if (edSaving || !edCtx) return
  edSaving = true
  // 存储等待期间冻结编辑与关闭，保存的正文和侧车保持同一个快照。
  edDlg.querySelectorAll('textarea, button').forEach(el => { el.disabled = true })
  try {
    if (edCtx.mode === 'create') {
      const { file } = await window.solace.createNote(edCtx.docId, { title: edCtx.title, page: edCtx.excerpts[0]?.page || 1, total: edCtx.total })
      edCtx.file = file
      edCtx.mode = 'edit' // 失败重试时不再重复建文件（幂等）
    }
    const body = edDlg.querySelector('#linkRecordText').value
    const content = edCtx.degraded ? body : generateRecordMd(edCtx.excerpts, body)
    await window.solace.writeNote(edCtx.docId, edCtx.file, content)
    // 摘录全移除 → entry 传 null 即删条目（.md 退化成普通笔记/外改格式原样）；
    // 降级时仅在摘录被改动过才写侧车（未动则承诺「锚点保留不动」）
    if (!edCtx.degraded || edExcerptsTouched) {
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
    // 仅创建流程完成才退出选词：编辑已链接句保存时保留累积选集（§6.3 防误丢）
    if (edCtx.flow === 'create' && window.linkSelecting) closeSelection(true)
  } catch (err) {
    window.toast?.(`保存失败：${err.message || err}`) // 留在编辑器，重试幂等（同一 file）
  } finally {
    edSaving = false
    edDlg.querySelectorAll('textarea, button').forEach(el => { el.disabled = false })
  }
}

/* ================= 笔记列表整合（记录行 / 新建入口 / 跳回定位） ============ */

function hasRecord (docId, file) {
  const rec = docId && linksCache.get(docId) && linksCache.get(docId).records[file]
  return !!(rec && rec.excerpts && rec.excerpts.length)
}

// 记录行徽标 + 首条摘录片段（notespanel 补丁在行尾留了 .note-link-row 钩子位）
window.__linkNoteRowExtra = (file) => {
  const docId = lastLayout && lastLayout.docId
  if (!hasRecord(docId, file)) return ''
  const x = linksCache.get(docId).records[file].excerpts[0]
  return `<span class="link-badge">🔗</span><span class="link-snip">第 ${x.page} 页 · ${esc(x.text.slice(0, 24))}</span>`
}

// 「＋新建」入口替换：在预览里新建笔记 = 从选句开始（返回 true = 已接管）
window.__linkNewOverride = (session) => {
  if (!session || !lastLayout || session.id !== lastLayout.docId) return false
  closeNotes()
  openSelection().catch(() => {})
  return true
}

// 记录行点击：跳回原文定位（返回 true = 已接管，不再打开笔记编辑器）
window.__linkRecordTap = (docId, file) => {
  if (!hasRecord(docId, file)) return false
  jumpToExcerpt(docId, file)
  return true
}

// 记录被删（notespanel 补丁回调，单条与批量两条路径都调）：清缓存 + 重绘
// 标记，否则标记要等下次保存/重开预览才消失。批量删除会连续回调，重绘合并
// 到一次（每个文件都重建文本层太浪费）
let relinkTimer = 0
window.__linkNoteDeleted = (docId, file) => {
  const cache = linksCache.get(docId)
  if (cache && cache.records) delete cache.records[file]
  clearTimeout(relinkTimer)
  relinkTimer = setTimeout(() => {
    if (lastLayout && lastLayout.docId === docId) buildLayer(lastLayout).catch(() => {})
  }, 30)
}

// 待闪标记消费：滚动到目标 + 闪烁。目标页已是当前页时当场消费——同页跳回
// 不触发翻页重渲染，不直接闪就会一直挂在 pendingFlash 上，下次本页任意
// 重渲染才乱闪
function tryFlashNow () {
  if (!pendingFlash || !lastLayout || !layer) return false
  if (pendingFlash.docId !== lastLayout.docId) return false
  if (String(pendingFlash.page) !== String(lastLayout.page)) return false
  const t = layer.querySelector(`.lnk[data-file="${CSS.escape(pendingFlash.file)}"]`)
  pendingFlash = null
  if (!t) return false
  t.scrollIntoView({ block: 'center' })
  t.classList.add('lnk-flash')
  setTimeout(() => t.classList.remove('lnk-flash'), 1100)
  return true
}

// 跳回：借页码输入框回车跳页，目标页渲染完成后由 pendingFlash 滚动 + 闪烁。
// 顺手收起笔记面板——不然跳过去也被面板挡着，看不见闪烁的目标
function jumpToExcerpt (docId, file) {
  const rec = linksCache.get(docId) && linksCache.get(docId).records[file]
  if (!rec || !rec.excerpts.length) return false
  closeNotes()
  pendingFlash = { docId, file, page: rec.excerpts[0].page }
  if (!tryFlashNow()) jumpPage(rec.excerpts[0].page) // 异页：借页码回车跳页
  return true
}

// 点按监听绑在 #previewBody（静态 HTML，模块求值时已在）。文本层默认
// pointer-events:none，选词模式下由 CSS 放开，事件冒泡到 body 层最稳
document.getElementById('previewBody')?.addEventListener('pointerdown', (e) => {
  layerDown = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() }
}, { passive: true })
document.getElementById('previewBody')?.addEventListener('pointercancel', (e) => {
  if (layerDown && e.pointerId === layerDown.id) layerDown = null
}, { passive: true })
document.getElementById('previewBody')?.addEventListener('pointerup', onLayerTap)
