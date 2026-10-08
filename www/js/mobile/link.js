// 摘录链接（link.js）：把页面的隐藏文本层铺在 PDF 之上，供选句与标记。
// 文本层核心（懒建 + 代数作废 + 按页缓存）、选词模式、标记渲染、记录查看器
// （点标记先看后编）与记录编辑器；追加会话（§6.7）向已有记录二次添加摘录。
//
// 三个来源共同决定层内容：layout 事件（docId/页码/pageObj/viewport）、
// linksCache（本书的锚点记录）、textCache（按 doc:page 缓存的文本与区间映射）。
import pdfjsLib from '../pdfjs.js'
import { askConfirm } from '../dialog.js'
import { esc } from '../util.js'
import { closeNotes } from '../notespanel.js'
import { buildPageText, splitSentences, sentenceAt, normalizeText, offsetToItem, findRangeByText, makeFreeSelection, stepEndpoint } from './link-text.mjs'
import { generateRecordMd, generateSummaryMd, parseRecordMd } from './link-md.mjs'
import { jumpPage } from './page-jump.mjs'
import { makeLru } from './lru-cache.mjs'
import { groupRectsToBands } from './bands.mjs'

let host = null            // #previewBody（滚动容器，style.css 已 position:relative）
let pdfCanvas = null
let layer = null           // .ink-text-layer（懒建）
let lastLayout = null      // 最近一次 layout detail（含 pageObj/viewport）
let buildSeq = 0
// 每页 TextContent 数十 KB 级且无失效时机，LRU 封顶防长会话逐页翻多本书后
// 只增不减（移动 WebView 内存压力 → OOM）
const textCache = makeLru(24) // `${docId}:${page}` -> { tc, items, pageText, spans }
const linksCache = new Map()         // docId -> { records }
let selections = []                  // [{ page, text, hint }]（选词模式的整句选集）
let appendTarget = null              // 追加会话目标文件名（null = 新建会话，§6.7）
let tray = null                      // #linkTray（选词托盘，懒建）
let pendingFlash = null              // { docId, file, page }：跳回定位待闪标记（同页当场闪，异页等渲染）
let layerDown = null                 // 点按判定起点 { id, x, y, t }（与 mobile.js 同风格）
let pressTimer = null                // 长按定时器（自由拖选入口，§6.6）
let press = null                     // 长按观察中的按下 { id, x, y }
let dragSel = null                   // 进行中的拖选 { ptr, a, b }（页面文本偏移）
let dragPending = null               // 抬手/短点后待确认的选区 { page, a, b, text, hint }
let dragBar = null                   // 拖选确认小条（‹ › ✕ ✓ 圆钮）
let dragRaf = 0                      // 拖选预览的 rAF 节流句柄
let dragRowY = null                  // 拖选行锚：最近有效命中项的中心 y（防垂直抖动跳行）
let dragRowH = 0                     // 行锚所在行高（吸附阈值 = 0.6 × 行高）
const selPtrs = new Map()            // 选词模式的活动指针 id -> {x,y}（双指滚动用）
let selScroll = null                 // 双指滚动锚点 {x,y}
let flick = null                     // 单指快滑观察 { id, x, y }
let flickScrolled = false            // 本次快滑是否真的滚动了（up 据此截断翻页语义）

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
  // 拖选确认是单页模态：翻页即丢弃待确认选区（§6.6）
  if (dragPending && String(dragPending.page) !== String(d.page)) {
    dragPending = null
    if (dragBar) dragBar.hidden = true
  }
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
  // 预览关闭 = 会话结束：统一走 closeSelection 收口（§6.7「预览关闭：会话作废，
  // appendTarget 清空」+ §6.6 拖选/确认小条清理）——此前只复位选词子集，追加
  // 目标与待确认选区会残留到同书重开后的新会话（第四轮审查 Spec-1）。
  // 先断布局再收口：closeSelection 的重建分支（buildLayer）随之自然跳过
  pendingFlash = null
  lastLayout = null
  closeSelection(true)
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

// 沿文本项子节点（文本节点 + .lnk 标记 span）累计字符长度，把项内相对偏移
// [from, to] 定位成 DOM Range 端点；越界/落空返回 null（该项无字可选）
function locateOffsets (el, from, to) {
  let acc = 0
  let s = null
  let e = null
  const walk = (node) => {
    if (s && e) return
    if (node.nodeType === 3) {
      const len = node.data.length
      if (!s && from >= acc && from <= acc + len) s = { node, off: from - acc }
      if (!e && to >= acc && to <= acc + len) e = { node, off: to - acc }
      acc += len
    } else {
      for (const c of node.childNodes) { walk(c); if (s && e) return }
    }
  }
  walk(el)
  return s && e ? { s, e } : null
}

// 按行统一带渲染（拍板 2026-10-07）：拖选（蓝）/入选（紫）不再做内联背景，
// 而是层内 .lnk-bands 容器上的等高带 div——容器插在层首，与文本项同为绝对
// 定位按 DOM 序绘制。2026-10-08 持久琥珀标记同样移交带渲染（用户实测：
// 保存后标记按文本项内联背景宽度不一、中英文项间露出断隔——拖选时等高带
// 正常、落盘标记回退旧内联即此根因）；span 仅保留为点击锚（dataset.file +
// 文字盒命中），带补上项间隙的全宽命中。带列表序即 z 序：琥珀垫底，
// 进行中的拖选/入选蓝紫在上（动态反馈 > 既有状态，半透明叠加仍透出琥珀）。
// 几何用 DOM Range 的 getClientRects：字符级精确，多行文本项自动逐行分片
function renderBands (bandSel, bandDrag, bandLnk) {
  if (!layer) return
  let box = layer.querySelector(':scope > .lnk-bands')
  if (!box) {
    box = document.createElement('div')
    box.className = 'lnk-bands'
    layer.insertBefore(box, layer.firstChild)
  }
  box.textContent = ''
  if (typeof document.createRange !== 'function') return // node 桩环境：带渲染跳过（断言不看 DOM）
  const layerRect = layer.getBoundingClientRect()
  if (!layerRect.width && !layerRect.height) return
  // 琥珀带带 lnk class + dataset.file：pointerup 的 closest('.lnk') 直接命中，
  // 点击开查看器零新增监听（容器 pointer-events:none，琥珀带在 CSS 单独放开）。
  // 琥珀按 file 分组独立画带：一行内多条摘录时各自成带，点击归属与 span 同义
  const groups = []
  if (bandLnk) for (const [file, m] of bandLnk) groups.push({ map: m, cls: 'lnk-band-lnk', file })
  groups.push({ map: bandDrag, cls: 'lnk-band-drag' })
  groups.push({ map: bandSel, cls: 'lnk-band-sel' })
  for (const { map, cls, file } of groups) {
    const rects = []
    for (const [i, list] of map || new Map()) {
      const el = layer.querySelector(`[data-item="${i}"]`)
      if (!el) continue
      for (const { from, to } of list) {
        const loc = locateOffsets(el, from, to)
        if (!loc) continue
        const range = document.createRange()
        try {
          range.setStart(loc.s.node, loc.s.off)
          range.setEnd(loc.e.node, loc.e.off)
          // pdf.js 文本项是「大字号 + transform 缩放」：Range 矩形的**高**按未缩放
          // 行盒计算（恒 ~39px 且不分字号），只有 X 是字符级可靠——X 取 Range、
          // Y/高取元素视觉盒（getBoundingClientRect 已含 transform，真机实测）
          const ir = el.getBoundingClientRect()
          let x0 = Infinity; let x1 = -Infinity
          for (const rr of range.getClientRects()) {
            if (rr.width <= 0) continue
            x0 = Math.min(x0, rr.x); x1 = Math.max(x1, rr.x + rr.width)
          }
          if (x1 > x0) rects.push({ x: x0 - layerRect.x, y: ir.y - layerRect.y, w: x1 - x0, h: ir.height })
        } catch { /* 端点落在非法节点边界：本项跳过，其余带照画 */ }
      }
    }
    for (const b of groupRectsToBands(rects)) {
      const div = document.createElement('div')
      div.className = 'lnk-band ' + cls + (file ? ' lnk' : '')
      if (file) div.dataset.file = file
      div.style.left = b.x + 'px'
      div.style.top = b.y + 'px'
      div.style.width = b.w + 'px'
      div.style.height = b.h + 'px'
      box.appendChild(div)
    }
  }
}

// 记录锚点（.lnk，text 经 findRangeByText 重锚定）合并成**一遍**重建：
// 分两遍时后一遍会拿原文本重切，把前一遍的标记覆盖掉。
// 选词选中态/拖选高亮（拍板 2026-10-07）改为**按行统一带**（renderBands）——
// 旧内联背景随文本项字体盒高低错落，跨字号混排观感差
function renderMarkers (d) {
  const entry = textCache.get(`${d.docId}:${d.page}`)
  if (!entry) return
  const byItem = new Map()
  // 琥珀带按 file 分组（renderBands 约定）：span 锚与带视觉同源同区间
  const bandLnk = new Map()
  const docLinks = linksCache.get(d.docId)
  for (const [file, rec] of Object.entries((docLinks && docLinks.records) || {})) {
    for (const ex of (rec && rec.excerpts) || []) {
      if (ex.page !== d.page) continue
      const hint = ex.hint != null && entry.spans[ex.hint.item]
        ? entry.spans[ex.hint.item].start + ex.hint.char
        : null
      const r = findRangeByText(entry.pageText, ex.text, hint)
      if (r) {
        rangesToItems(entry, r.start, r.end, file, 'lnk', byItem)
        if (!bandLnk.has(file)) bandLnk.set(file, new Map())
        rangesToItems(entry, r.start, r.end, null, null, bandLnk.get(file))
      }
    }
  }
  const bandSel = new Map() // item -> [{from, to}]（项内相对偏移）
  const bandDrag = new Map()
  if (window.linkSelecting) {
    for (const sel of selections) {
      if (sel.page !== d.page) continue
      const hint = entry.spans[sel.hint.item] ? entry.spans[sel.hint.item].start + sel.hint.char : null
      const r = findRangeByText(entry.pageText, sel.text, hint)
      if (r) rangesToItems(entry, r.start, r.end, null, null, bandSel)
    }
    // 自由拖选（§6.6）：进行中与待确认共用；offset 是页面文本偏移，无需重锚定
    const drag = dragPending && String(dragPending.page) === String(d.page)
      ? dragPending
      : (dragSel ? { a: dragSel.a, b: dragSel.b } : null)
    if (drag) rangesToItems(entry, Math.min(drag.a, drag.b), Math.max(drag.a, drag.b), null, null, bandDrag)
  }
  // 上一轮画过标记的项也要重切：byItem 只含本轮有条目的项，不补则旧标记
  // 残留（真机实测残留 31 字）。空列表 = paintItem 重切回纯文本
  for (const mk of layer.querySelectorAll('.lnk')) {
    const itemEl = mk.closest && mk.closest('[data-item]')
    const i = itemEl && Number(itemEl.dataset.item)
    if (i !== undefined && !byItem.has(i)) byItem.set(i, [])
  }
  for (const [i, list] of byItem) {
    const el = layer.querySelector(`[data-item="${i}"]`)
    if (el) paintItem(el, list)
  }
  renderBands(bandSel, bandDrag, bandLnk)
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
  tray.querySelector('#btnLinkDone').addEventListener('click', () => {
    if (appendTarget) commitAppend().catch(() => {})
    else openEditor({ mode: 'create' })
  })
}

function trayUpdate () {
  if (!tray) return
  const pages = new Set(selections.map(s => s.page))
  tray.querySelector('#linkTrayCount').textContent = appendTarget
    ? `追加到「${appendTarget.replace(/\.md$/i, '')}」· 已选 ${selections.length} 处 · 跨 ${pages.size} 页`
    : `已选 ${selections.length} 处 · 跨 ${pages.size} 页`
  const done = tray.querySelector('#btnLinkDone')
  done.disabled = selections.length === 0
  done.textContent = appendTarget ? '併入' : '完成'
}

async function openSelection (opts = {}) {
  ensureDom(); ensureLayer(); ensureTray()
  // §6.5：进选词自动收起目录/笔记面板（preview.js 的「点正文收面板」只覆盖
  // 正文点击，从顶栏按钮进选词不经过它；留着面板会压住选词区与点按）
  const toc = document.getElementById('tocPanel')
  if (toc) toc.hidden = true
  closeNotes()
  // 与墨水互斥：选词中不叠标注模式（ink 的退出即冲刷保存）
  if (window.inkActive) window.dispatchEvent(new CustomEvent('solace-ink-exit-request'))
  window.linkSelecting = true
  appendTarget = opts.appendTo || null // 追加会话（§6.7）：目标记录在托盘文案示名
  selections = []
  trayUpdate()
  tray.hidden = false
  document.body.classList.add('link-selecting')
  if (lastLayout) await buildLayer(lastLayout)
}

function closeSelection (clear) {
  if (clear) selections = []
  appendTarget = null // 会话结束（完成/取消/预览关闭/互斥退出）目标一并作废
  clearDragState() // 拖选/确认小条随模式退出一并清理（§6.6）
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
// 坐标 → 页面文本偏移（§6.2 与 §6.6 共用：点选整句 / 长按拖选同一条命中链路）
function caretToOffset (x, y) {
  const caret = document.caretPositionFromPoint
    ? document.caretPositionFromPoint(x, y)
    : (document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null)
  if (!caret) return null
  const node = caret.offsetNode || caret.startContainer
  const el = node && node.nodeType === 1 ? node : node && node.parentElement
  const itemEl = el && el.closest('[data-item]')
  if (!itemEl || !layer.contains(itemEl)) return null
  const item = Number(itemEl.dataset.item)
  const entry = textCache.get(`${lastLayout.docId}:${lastLayout.page}`)
  if (!entry || !entry.spans[item]) return null
  // caret 偏移要相对**整个文本项**量：标记 span 把项文本切成了多个节点，
  // 直接取 caret.offset（相对所在文本节点）会算错
  let charInItem
  try {
    const range = document.createRange()
    range.selectNodeContents(itemEl)
    range.setEnd(node, caret.offset !== undefined ? caret.offset : caret.startOffset)
    charInItem = range.toString().length
  } catch { return null }
  const span = entry.spans[item]
  return span.start + Math.min(charInItem, span.end - span.start)
}

// caret 命中兜底（§6.6 修订）：caretPositionFromPoint 在行间隙/段落间隙返回
// null——拖选终点会冻结在最后一次命中上，纵向拖动看起来「没反应」（真机
// 实测 a=b=起点）。退化为几何近似：在层内找指针 y 所在（或最近）的文本行，
// x 偏左取行首、偏右取行尾——精度足够拖选（误差至多半个文本项）
function caretToOffsetFallback (x, y, entry) {
  if (!layer) return null
  // §6.6 三轮修订（真机实测两处缺陷）：
  // ① 必须用 getBoundingClientRect（视觉盒）：pdf.js 的文本项 span 带
  //   transform:scale（--scale-factor ≈7.8），offsetTop/offsetHeight 是未
  //   缩放的布局盒——与 clientY 混比坐标系错位，行选择完全失真；
  // ② 不能「d=0 即停」：多行文本项的盒子高百余 px，垂直罩住后面的单项
  //   行，先遍历到大盒就 break 会让终点跳回多行项开头（拖选稍偏即跨行）。
  //   全遍历按（垂直距离，盒高）双键取最优：d 相同时矮盒胜——行级盒子
  //   比跨行大盒更精确地指明指针所在的视觉行
  let best = null
  let bestKey = Infinity
  const items = layer.querySelectorAll('[data-item]')
  for (const el of items) {
    const r = el.getBoundingClientRect()
    const h = r.height || 1
    const d = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0)
    const key = d * 1000 + Math.min(h, 200)
    if (key < bestKey) { bestKey = key; best = el }
  }
  if (!best) return null
  const item = Number(best.dataset.item)
  const sp = entry.spans[item]
  if (!sp) return null
  const br = best.getBoundingClientRect()
  return x > br.left + (br.width || 0) / 2 ? sp.end : sp.start
}

// 拖选/点选共用的命中入口：先精确 caret，失败走行几何兜底
function caretOffsetForDrag (x, y) {
  if (!lastLayout) return null
  const entry = textCache.get(`${lastLayout.docId}:${lastLayout.page}`)
  if (!entry) return null
  const off = caretToOffset(x, y)
  if (off != null) return off
  return caretToOffsetFallback(x, y, entry)
}

// 行锚（§6.6 三轮）：页面文本偏移 → 所在文本项的行几何（client 坐标）。
// 拖选期间据此把指针 y 吸附到当前行——垂直微偏（不足 0.6 行高）与快速
// 滑动的稀疏采样抖动不再把终点命中到相邻行；大位移跨行选择不受影响
function rowAnchorForOffset (off) {
  if (!lastLayout || !layer) return null
  const entry = textCache.get(`${lastLayout.docId}:${lastLayout.page}`)
  if (!entry) return null
  const it = offsetToItem(entry.spans, off)
  if (!it) return null
  const el = layer.querySelector(`[data-item="${it.item}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  // 多行文本项的盒子跨多个视觉行，中心 y 不指向具体行——不锚（保持上一
  // 个有效行锚），吸附半径也不会被百余 px 的大盒撑爆
  if (r.height > 30) return null
  return { y: r.top + r.height / 2, h: r.height || 14 }
}

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
    // §6.7：点标记先看后编——查看器（只读）里再进编辑/追加
    openViewer(lastLayout.docId, mk.dataset.file).catch(() => {})
    return
  }
  if (!window.linkSelecting) return
  // 短点在待确认选区上 = 取消它（滚动不取消——那是查看操作；只有明确的
  // 点按意图才视为「不要这段了」）
  if (dragPending) { cancelDragPending(); return }
  const off = caretToOffset(e.clientX, e.clientY)
  if (off == null) return
  const entry = textCache.get(`${lastLayout.docId}:${lastLayout.page}`)
  if (!entry) return
  const sentences = splitSentences(entry.pageText)
  const si = sentenceAt(sentences, off)
  const r = sentences[si]
  if (!r) return
  const text = normalizeText(entry.pageText.slice(r.start, r.end))
  if (!text) return
  const hint = offsetToItem(entry.spans, r.start)
  // 整句预选（§6.6 修订）：与自由选区同一条确认链（小条 + 步进 + 入选/取消），
  // 不再直接入集——选词模式下不存在「无确认入集」，误点可反悔
  dragPending = { page: lastLayout.page, a: r.start, b: r.end, text, hint }
  ensureDragBar()
  dragBar.hidden = false
  renderMarkers(lastLayout)
}

/* ================= 自由拖选（§6.6：长按起点 + 拖动 + 确认小条） ============ */

function ensureDragBar () {
  if (dragBar) return
  dragBar = document.createElement('div')
  dragBar.id = 'linkDragBar'
  dragBar.className = 'link-drag-bar'
  dragBar.hidden = true
  // §6.6 修订：无文字预览（页面高亮即所见），圆钮图标组与文字型托盘区分
  dragBar.innerHTML = `
    <button class="drag-step" title="左端向外一字" aria-label="扩左">‹</button>
    <button class="drag-step" title="右端向外一字" aria-label="扩右">›</button>
    <button title="取消" aria-label="取消">✕</button>
    <button class="primary" title="入选" aria-label="入选">✓</button>`
  document.getElementById('previewOverlay').appendChild(dragBar)
  const [btnL, btnR, btnX, btnOk] = dragBar.querySelectorAll('button')
  btnL.addEventListener('click', () => stepDrag(-1))
  btnR.addEventListener('click', () => stepDrag(1))
  btnX.addEventListener('click', () => cancelDragPending())
  btnOk.addEventListener('click', () => commitDragPending())
}

// 端点步进后重算选区：text/hint 跟随端点变化（hint 恒为当前起点）
function stepDrag (dir) {
  if (!dragPending || !lastLayout) return
  const entry = textCache.get(`${lastLayout.docId}:${lastLayout.page}`)
  if (!entry) return
  if (dir < 0) dragPending.a = stepEndpoint(entry.pageText, dragPending.a, -1)
  else dragPending.b = stepEndpoint(entry.pageText, dragPending.b, 1)
  const made = makeFreeSelection(entry.pageText, entry.spans, dragPending.a, dragPending.b)
  if (!made) return
  dragPending.text = made.text
  dragPending.hint = made.hint
  renderMarkers(lastLayout)
}

function commitDragPending () {
  if (!dragPending) return
  const p = dragPending
  // 与整句「再点取消」对称：完全相同的选区（页+文字+起点）再入 = 移除
  const idx = selections.findIndex(s => s.page === p.page && s.text === p.text &&
    s.hint.item === p.hint.item && s.hint.char === p.hint.char)
  if (idx >= 0) {
    selections.splice(idx, 1)
    window.toast?.('已移除该选区')
  } else {
    selections.push({ page: p.page, text: p.text, hint: p.hint })
  }
  dragPending = null
  dragBar.hidden = true
  trayUpdate()
  renderMarkers(lastLayout)
}

function cancelDragPending () {
  if (!dragPending) return
  dragPending = null
  dragBar.hidden = true
  if (lastLayout) renderMarkers(lastLayout)
}

function clearDragState () {
  clearTimeout(pressTimer)
  pressTimer = null
  press = null
  dragSel = null
  dragRowY = null
  dragRowH = 0
  dragPending = null
  window.linkDragging = false
  cancelAnimationFrame(dragRaf)
  dragRaf = 0
  selPtrs.clear()
  selScroll = null
  flick = null
  flickScrolled = false
  if (dragBar) dragBar.hidden = true
}

// 选词手势主权（§6.6 修订）：文本层 touch-action:none（见 mobile.css），浏览器
// pan 不再参与——单指三态（快滑滚动 / 长按拖选 / 短点预选）+ 双指滚动全部
// 由本模块分发。滚动为应用自实现（跟手、无 fling 惯性，同墨迹层手感）
const bodyEl = document.getElementById('previewBody')
const twoMid = () => {
  let x = 0, y = 0
  for (const p of selPtrs.values()) { x += p.x; y += p.y }
  return { x: x / selPtrs.size, y: y / selPtrs.size }
}

bodyEl?.addEventListener('pointerdown', (e) => {
  if (!window.linkSelecting) return
  // 按下不取消待确认选区：滚动（快滑/双指）是查看操作，不该破坏它——
  // 取消只发生在「真正开新选择」时（短点 onLayerTap / 长按 timer 回调）
  selPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
  // 第二指落下：单指状态作废（拖选/长按/快滑），进入双指滚动（同墨迹层惯例）
  if (selPtrs.size >= 2) {
    clearTimeout(pressTimer); pressTimer = null; press = null
    if (dragSel) { dragSel = null; window.linkDragging = false; if (lastLayout) renderMarkers(lastLayout) }
    flick = null; flickScrolled = false
    selScroll = twoMid()
    return
  }
  if (press || dragSel) return
  const { x, y } = { x: e.clientX, y: e.clientY }
  const pid = e.pointerId
  press = { id: pid, x, y }
  pressTimer = setTimeout(() => {
    pressTimer = null
    press = null
    if (!lastLayout) return
    const entry = textCache.get(`${lastLayout.docId}:${lastLayout.page}`)
    if (!entry) return
    const off = caretOffsetForDrag(x, y)
    if (off == null) return
    cancelDragPending() // 长按开新段：此刻才替换待确认选区
    dragSel = { ptr: pid, a: off, b: off }
    const anchor = rowAnchorForOffset(off)
    dragRowY = anchor ? anchor.y : null
    dragRowH = anchor ? anchor.h : 0
    window.linkDragging = true
    try { navigator.vibrate?.(8) } catch { /* 无振动模块忽略 */ }
    try { layer.setPointerCapture?.(pid) } catch { /* 合成事件无真实指针 */ }
    renderMarkers(lastLayout)
  }, 400)
}, true)
bodyEl?.addEventListener('pointermove', (e) => {
  const p = selPtrs.get(e.pointerId)
  if (p) { p.x = e.clientX; p.y = e.clientY }
  // 双指滚动（跟手，横向纵向都滚）
  if (selScroll && selPtrs.size >= 2) {
    const m = twoMid()
    const b = bodyEl
    b.scrollTop -= m.y - selScroll.y
    b.scrollLeft -= m.x - selScroll.x
    selScroll = m
    return
  }
  // 长按拖选
  if (dragSel && e.pointerId === dragSel.ptr) {
    // 行锚吸附：垂直位移不足 0.6 行高时用行锚 y 命中（微偏/快滑不跳行），
    // 超过则放行真实 y——跨行纵向拖选照常
    let cy = e.clientY
    if (dragRowY != null && dragRowH > 0 && Math.abs(cy - dragRowY) < dragRowH * 0.6) {
      cy = dragRowY
    }
    const off = caretOffsetForDrag(e.clientX, cy)
    if (off != null && off !== dragSel.b) {
      dragSel.b = off
      const anchor = rowAnchorForOffset(off)
      if (anchor) { dragRowY = anchor.y; dragRowH = anchor.h }
      // rAF 节流：renderMarkers 重切 span 足够轻，但不随 move 事件频率跑
      if (!dragRaf) {
        dragRaf = requestAnimationFrame(() => {
          dragRaf = 0
          if (dragSel && lastLayout) renderMarkers(lastLayout)
        })
      }
    }
    return
  }
  // 长按窗口内位移超限 = 快滑开始，取消定时器转入跟手滚动
  if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) >= 12) {
    clearTimeout(pressTimer)
    pressTimer = null
    flick = { id: e.pointerId, x: e.clientX, y: e.clientY }
    flickScrolled = false
    press = null
  }
  if (flick && e.pointerId === flick.id) {
    const b = bodyEl
    const before = b.scrollTop + b.scrollLeft
    b.scrollTop -= e.clientY - flick.y
    b.scrollLeft -= e.clientX - flick.x
    flick.x = e.clientX; flick.y = e.clientY
    // 实际滚了才记（横向无溢出时 scrollLeft 不动，纵滚也可能已在边界）
    if (b.scrollTop + b.scrollLeft !== before) flickScrolled = true
  }
}, true)
bodyEl?.addEventListener('pointerup', (e) => {
  clearTimeout(pressTimer)
  pressTimer = null
  press = null
  selPtrs.delete(e.pointerId)
  if (selScroll) { if (selPtrs.size < 2) selScroll = null; return }
  if (dragSel && e.pointerId === dragSel.ptr) {
    const sel = dragSel
    dragSel = null
    window.linkDragging = false
    // 标记消费而非 stopPropagation：截断会让 mobile.js 的 activePtrs 账本
    // 残留（它只在自收的 up 里 delete），残留一枚指针后其单指手势判定
    // 永久失效、横滑翻页失灵（真机实测）。见 mobile.js 的对应让位
    e.__consumedByLink = true
    if (!lastLayout) return
    const entry = textCache.get(`${lastLayout.docId}:${lastLayout.page}`)
    const made = entry && makeFreeSelection(entry.pageText, entry.spans, sel.a, sel.b)
    // 空/微选区（<2 字，拖回起点附近）静默丢弃，不出小条——「拖空即取消」
    if (!made || made.text.length < 2) { renderMarkers(lastLayout); return }
    dragPending = {
      page: lastLayout.page,
      a: Math.min(sel.a, sel.b),
      b: Math.max(sel.a, sel.b),
      text: made.text,
      hint: made.hint
    }
    ensureDragBar()
    dragBar.hidden = false
    renderMarkers(lastLayout)
    return
  }
  if (flick && e.pointerId === flick.id) {
    const scrolled = flickScrolled
    flick = null
    flickScrolled = false
    // 滚了就不翻页/不点按（同 __consumedByLink 标记协议）；没滚（如横向
    // 无溢出的横滑）放行给 mobile.js 的滑动翻页——跨页累积手势保留
    if (scrolled) e.__consumedByLink = true
    return
  }
}, true)
bodyEl?.addEventListener('pointercancel', (e) => {
  clearTimeout(pressTimer)
  pressTimer = null
  press = null
  selPtrs.delete(e.pointerId)
  if (selPtrs.size < 2) selScroll = null
  if (flick && e.pointerId === flick.id) { flick = null; flickScrolled = false }
  if (dragSel && e.pointerId === dragSel.ptr) {
    dragSel = null
    window.linkDragging = false
    if (lastLayout) renderMarkers(lastLayout)
  }
}, true)
// 系统长按菜单（复制/分享）：选词与拖选期间全部抑制
bodyEl?.addEventListener('contextmenu', (e) => {
  if (window.linkSelecting || window.linkDragging) e.preventDefault()
})

/* ================= 记录查看器（§6.7：点标记先看后编 + 追加入口） ========= */

let viewDlg = null
let viewCtx = null       // { docId, file, degraded }
let viewOpening = false  // openViewer 的 await 窗口防重入（同 edOpening 风格）
let viewDeleting = false // 删除链防重入（确认框与 trashNote 的 await 窗口）

function ensureViewer () {
  if (viewDlg) return
  const wrap = document.createElement('div')
  wrap.innerHTML = `
    <dialog id="linkViewDialog" class="dialog note-editor-dialog link-view-dialog">
      <div class="stats-head"><h3 id="linkViewTitle">摘录记录</h3>
        <button id="btnLinkViewClose" class="btn-ghost" title="关闭">✕</button></div>
      <div id="linkViewChips" class="link-chips"></div>
      <div id="linkViewBody" class="link-view-body"></div>
      <div class="dialog-foot">
        <button id="btnLinkViewDelete" class="btn-ghost" title="删除" aria-label="删除">🗑</button>
        <button id="btnLinkViewAppend" class="btn-ghost" title="追加摘录" aria-label="追加摘录">＋</button>
        <button id="btnLinkViewEdit" class="btn-primary" title="编辑" aria-label="编辑">✎</button>
      </div>
    </dialog>`
  document.body.appendChild(wrap.firstElementChild)
  viewDlg = document.getElementById('linkViewDialog')
  viewDlg.querySelector('#btnLinkViewClose').addEventListener('click', () => viewDlg.close())
  // 查看器无脏状态：Esc（cancel）与返回键（solace-close-request）都直接关——
  // boot.mjs 对未 preventDefault 的 close-request 自动 close，此处无需接管
  viewDlg.querySelector('#btnLinkViewEdit').addEventListener('click', () => {
    if (!viewCtx) return
    const { docId, file } = viewCtx
    viewDlg.close()
    openEditor({ mode: 'edit', docId, file, fromViewer: true }).catch(() => {})
  })
  viewDlg.querySelector('#btnLinkViewAppend').addEventListener('click', () => {
    if (!viewCtx) return
    const { docId, file } = viewCtx
    viewDlg.close()
    if (lastLayout && lastLayout.docId === docId) openSelection({ appendTo: file }).catch(() => {})
  })
  // 删除整条记录（§6.7 生命线补全）：确认 → trashNote（桥内同链清侧车）→
  // 复用 notespanel 删除钩子的清理链（清缓存 + 防抖重绘标记）→ 通知列表刷新
  viewDlg.querySelector('#btnLinkViewDelete').addEventListener('click', async () => {
    if (!viewCtx || viewDeleting) return
    const { docId, file } = viewCtx
    viewDeleting = true
    try {
      const ok = await askConfirm({ title: '删除这条摘录记录？', text: '摘录引用与批注将一并删除，正文标记随之消失。', okText: '删除' })
      if (!ok) return
      await window.solace.trashNote(docId, file)
      viewCtx = null
      viewDlg.close()
      window.__linkNoteDeleted(docId, file)
      window.dispatchEvent(new CustomEvent('solace-note-saved', { detail: { docId } }))
      window.toast?.('记录已删除')
    } catch (err) {
      window.toast?.(`删除失败：${err.message || err}`) // 查看器留在原地可重试
    } finally {
      viewDeleting = false
    }
  })
}

// 只读 chips：点按 = 关查看器 + 跳到该条摘录所在页并闪烁（定位语义同列表行）。
// 章总结记录：唯一 chip = 章锚点，点按跳章首页（无正文标记可闪）
// chip 主文字（查看器/编辑器共用，审查四轮 Standards-3 去重）：页码 + 截断文本
const chipLabel = (x) => `<b>第 ${x.page} 页</b> ${esc(x.text.slice(0, 40))}`

function renderViewerChips () {
  const docLinks = linksCache.get(viewCtx.docId)
  const rec = docLinks && docLinks.records[viewCtx.file]
  const box = viewDlg.querySelector('#linkViewChips')
  const chips = rec && rec.summary
    ? `<span class="link-chip link-view-chip" data-k="s"><b>第 ${rec.summary.page} 页</b> ${esc(rec.summary.chapter)}<i class="chip-go">›</i></span>`
    : ((rec && rec.excerpts) || []).map((x, i) =>
      `<span class="link-chip link-view-chip" data-k="${i}">${chipLabel(x)}<i class="chip-go">›</i></span>`).join('')
  box.innerHTML = (viewCtx.degraded
    ? '<span class="link-chip-degraded">正文格式已被外部修改；编辑将按原样保存，追加仅入锚点</span>'
    : '') + chips
  box.querySelectorAll('.link-view-chip').forEach(el =>
    el.addEventListener('click', () => {
      if (!viewCtx) return
      const { docId, file } = viewCtx
      const r = linksCache.get(docId) && linksCache.get(docId).records[file]
      viewDlg.close()
      if (r && r.summary) { closeNotes(); jumpPage(r.summary.page); return }
      jumpToExcerpt(docId, file, Number(el.dataset.k))
    }))
}

// 读取并解析一份记录 md（查看器/编辑器/追加三处共用；审查四轮 Standards-3 去重）。
// 读取失败返回 { error }（调用方各自 toast/退出），成功返回 { raw, parsed, degraded }
async function loadRecordMd (docId, file) {
  let raw = ''
  try {
    raw = await window.solace.readNote(docId, file)
  } catch (err) {
    return { error: err }
  }
  const parsed = parseRecordMd(raw)
  return { raw, parsed, degraded: !parsed.ok }
}

async function openViewer (docId, file) {
  if (viewOpening) return
  viewOpening = true
  try {
    ensureViewer()
    if (!linksCache.has(docId)) await loadLinks(docId)
    const rec = linksCache.get(docId) && linksCache.get(docId).records[file]
    if (!rec || (!rec.excerpts.length && !rec.summary)) { window.toast?.('记录已不存在'); return }
    const ld = await loadRecordMd(docId, file)
    if (ld.error) { window.toast?.(`读取失败：${ld.error.message || ld.error}`); return }
    const { raw, parsed, degraded } = ld
    viewCtx = { docId, file, degraded }
    viewDlg.querySelector('#linkViewTitle').textContent = rec.summary
      ? `章节总结 · ${rec.summary.chapter.slice(0, 24)}`
      : `摘录记录 · ${file.replace(/\.md$/i, '')}`
    viewDlg.querySelector('#linkViewBody').textContent = parsed.ok ? parsed.body : raw
    // 总结记录无摘录可追加（§5.2），追加钮整条隐藏
    viewDlg.querySelector('#btnLinkViewAppend').hidden = !!rec.summary
    renderViewerChips()
    viewDlg.showModal()
  } finally {
    viewOpening = false
  }
}

/* ================= 追加会话（§6.7：「併入」直接保存，不过编辑器） ========= */

// 每句已经过确认小条，併入即保存；改正文走查看器的「编辑」专路
let appendSaving = false

async function commitAppend () {
  if (appendSaving || !appendTarget || !lastLayout) return
  const docId = lastLayout.docId
  const file = appendTarget
  appendSaving = true
  // 存储等待期间冻结托盘按钮（防重复併入并发写）
  const trayBtns = tray
    ? [tray.querySelector('#btnLinkCancel'), tray.querySelector('#btnLinkDone')].filter(Boolean)
    : []
  trayBtns.forEach(b => { b.disabled = true })
  try {
    if (!linksCache.has(docId)) await loadLinks(docId)
    const rec = linksCache.get(docId) && linksCache.get(docId).records[file]
    if (!rec || !rec.excerpts || !rec.excerpts.length) {
      window.toast?.('记录已不存在')
      closeSelection(true)
      return
    }
    // 查重：与本记录现有摘录完全相同（页+文字+起点 hint）的选区跳过
    const same = (a, b) => a.page === b.page && a.text === b.text &&
      a.hint && b.hint && a.hint.item === b.hint.item && a.hint.char === b.hint.char
    const fresh = selections.filter(s => !rec.excerpts.some(e => same(e, s)))
    if (!fresh.length) {
      window.toast?.('所选摘录均已在该记录中')
      return // 留在选词：可取消或换选，不写盘
    }
    const merged = [
      ...rec.excerpts.map(x => ({ ...x })),
      ...fresh.map(s => ({ page: s.page, text: s.text, hint: s.hint }))
    ]
    const ld = await loadRecordMd(docId, file)
    if (ld.error) { window.toast?.(`读取失败：${ld.error.message || ld.error}`); return }
    const { parsed } = ld
    // 降级（正文被外部改过）→ md 原样不动、仅写侧车：与编辑器「降级按原样
    // 保存」语义一致，不重建摘录区
    if (parsed.ok) {
      await window.solace.writeNote(docId, file, generateRecordMd(merged, parsed.body))
    }
    // body0 是行显示快照（§7.2），併入只动摘录——原快照必须随行保留
    await window.solace.setNoteLinkEntry(docId, file, { excerpts: merged, body0: rec.body0 || '' })
    window.toast?.(`已追加 ${fresh.length} 处摘录`)
    closeSelection(true)
    linksCache.delete(docId)
    await loadLinks(docId)
    // 数据已落盘，标记渲染失败不该把追加报成失败（fire-and-forget）
    if (lastLayout && lastLayout.docId === docId) buildLayer(lastLayout).catch(() => {})
    window.dispatchEvent(new CustomEvent('solace-note-saved', { detail: { docId } }))
    openViewer(docId, file).catch(() => {})
  } catch (err) {
    window.toast?.(`追加失败：${err.message || err}`) // 留在选词，重试幂等（合并结果一致）
  } finally {
    appendSaving = false
    trayBtns.forEach(b => { b.disabled = false })
  }
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
    <dialog id="linkRecordDialog" class="dialog note-editor-dialog link-edit-dialog">
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
  // 章总结：唯一 chip = 章锚点，不可移除（移除即失去记录身份）
  if (edCtx.summary) {
    box.innerHTML = `<span class="link-chip"><b>第 ${edCtx.summary.page} 页</b> ${esc(edCtx.summary.chapter)} · 章锚点</span>`
    return
  }
  const chips = edCtx.excerpts.map((x, i) =>
    `<span class="link-chip">${chipLabel(x)}<button class="chip-x" data-i="${i}" title="移除">✕</button></span>`).join('')
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
      const ld = await loadRecordMd(opts.docId, opts.file)
      if (ld.error) { window.toast?.(`读取失败：${ld.error.message || ld.error}`); return }
      if (edSaving) return // 读笔记期间另一条编辑流程可能已经开始保存
      const { parsed, degraded } = ld
      // 正文被外部改过（无【摘录】/【总结】头）→ 降级：按普通笔记保存，锚点保留不动
      edCtx = {
        mode: 'edit', flow: 'edit', docId: opts.docId, file: opts.file,
        excerpts: rec.excerpts.map(x => ({ ...x })),
        summary: rec.summary ? { ...rec.summary } : null,
        degraded, fromViewer: !!opts.fromViewer
      }
      edDlg.querySelector('#linkRecordText').value = parsed.body
      edDlg.querySelector('#linkRecordTitle').textContent = rec.summary ? '章节总结' : '摘录记录'
    } else if (opts.mode === 'summary') {
      // 新建章总结（§5.2）：来自跨章小条或面板 📝 钮；同章已有记录的路径
      // 在 __linkOpenSummary 里已分流到 edit，到这里一定是新建
      edCtx = {
        mode: 'create',
        flow: 'summary', // 建文件后 mode 转 edit，flow 保持标记总结流
        docId: opts.docId,
        title: opts.chapter.title,
        total: Number((document.getElementById('pageTotal') || {}).textContent) || 0,
        excerpts: [],
        summary: { page: opts.chapter.page, chapter: opts.chapter.title },
        degraded: false
      }
      edDlg.querySelector('#linkRecordText').value = ''
      edDlg.querySelector('#linkRecordTitle').textContent = `写总结 · ${opts.chapter.title.slice(0, 20)}`
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
    // 创建流取消：选集保留、仍在选词模式（spec §6.3），无需额外动作。
    // 编辑流取消（放弃修改）：来源是查看器则回看旧内容（§6.7）
    if (edCtx && edCtx.fromViewer) openViewer(edCtx.docId, edCtx.file).catch(() => {})
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
      // 总结流建文件落在章起页；摘录流落在首条摘录页
      const page = edCtx.summary ? edCtx.summary.page : (edCtx.excerpts[0]?.page || 1)
      const { file } = await window.solace.createNote(edCtx.docId, { title: edCtx.title, page, total: edCtx.total })
      edCtx.file = file
      edCtx.mode = 'edit' // 失败重试时不再重复建文件（幂等）
    }
    const body = edDlg.querySelector('#linkRecordText').value
    // body0：正文首个非空行快照（列表行内容优先显示用；§7.2 侧车镜像字段）
    const body0 = (body.split('\n').map(s => s.trim()).find(Boolean) || '').slice(0, 40)
    const content = edCtx.summary
      ? (edCtx.degraded ? body : generateSummaryMd(edCtx.summary, body))
      : (edCtx.degraded ? body : generateRecordMd(edCtx.excerpts, body))
    await window.solace.writeNote(edCtx.docId, edCtx.file, content)
    // 摘录全移除 → entry 传 null 即删条目（.md 退化成普通笔记/外改格式原样）；
    // 降级时仅在摘录被改动过才写侧车（未动则承诺「锚点保留不动」）；
    // 总结流锚点恒在（章锚点即记录身份），总是写
    if (edCtx.summary || !edCtx.degraded || edExcerptsTouched) {
      const entry = edCtx.summary
        ? { excerpts: [], summary: edCtx.summary, body0 }
        : (edCtx.excerpts.length ? { excerpts: edCtx.excerpts, body0 } : null)
      await window.solace.setNoteLinkEntry(edCtx.docId, edCtx.file, entry)
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
    // 来源是查看器的编辑：保存后回看最新内容（§6.7）；摘录被全删则记录已
    // 退化为普通笔记——无内容可看，说明后不重开（总结记录锚点恒在，恒回看）
    if (edCtx.fromViewer) {
      if (edCtx.summary || edCtx.excerpts.length) openViewer(edCtx.docId, edCtx.file).catch(() => {})
      else window.toast?.('摘录已全部移除，记录已退化为普通笔记')
    }
  } catch (err) {
    window.toast?.(`保存失败：${err.message || err}`) // 留在编辑器，重试幂等（同一 file）
  } finally {
    edSaving = false
    edDlg.querySelectorAll('textarea, button').forEach(el => { el.disabled = false })
  }
}

/* ================= 笔记列表整合（记录行 / 新建入口 / 跳回定位） ============ */

// 记录条目（有摘录锚点或章锚点皆算）；普通笔记返回 null
function recordEntry (docId, file) {
  const rec = docId && linksCache.get(docId) && linksCache.get(docId).records[file]
  return (rec && ((rec.excerpts && rec.excerpts.length) || rec.summary)) ? rec : null
}

// 行内容优先（READING-RECORDS-DESIGN §6）：主行 = 批注正文首行（body0
// 显示快照，免逐文件 IO）→ 摘录文字 → 章名；次行 = 类型 · 章/页 · 相对
// 时间。返回 null = 普通笔记，走桌面默认行（时间戳文件名只在默认行出现）
window.__linkNoteMain = (file, relWhen) => {
  const docId = lastLayout && lastLayout.docId
  const rec = recordEntry(docId, file)
  if (!rec) return null
  const when = esc(relWhen || '')
  if (rec.summary) {
    const main = (rec.body0 || '').trim() || `《${rec.summary.chapter}》总结`
    return `<span class="note-name">${esc(main.slice(0, 48))}</span>` +
      `<span class="note-when">📝 ${esc(rec.summary.chapter.slice(0, 20))} · ${when}</span>`
  }
  const x = rec.excerpts[0]
  const main = (rec.body0 || '').trim() || x.text
  return `<span class="note-name">${esc(main.slice(0, 48))}</span>` +
    `<span class="note-when">🔗 第 ${x.page} 页 · ${when}</span>`
}

// 页序排序（§6）：锚点页升序（总结取章起页、摘录取首条页），同页按修改
// 时间；自由笔记无锚点排尾部按时间倒序。缓存缺席（读失败等）原样返回
window.__linkNoteSort = (notes) => {
  const docId = lastLayout && lastLayout.docId
  const cache = docId && linksCache.get(docId)
  if (!cache || !Array.isArray(notes)) return notes
  const pageOf = (file) => {
    const r = cache.records[file]
    if (!r) return null
    if (r.summary) return r.summary.page
    return r.excerpts && r.excerpts[0] ? r.excerpts[0].page : null
  }
  const anchored = []
  const plain = []
  for (const n of notes) {
    const p = pageOf(n.file)
    if (p == null) plain.push(n)
    else anchored.push({ n, p })
  }
  anchored.sort((a, b) => a.p - b.p || String(a.n.mtime).localeCompare(String(b.n.mtime)))
  plain.sort((a, b) => String(b.n.mtime).localeCompare(String(a.n.mtime)))
  return anchored.map(x => x.n).concat(plain)
}

// 章总结状态（chapter-prompt 小条用）：known=false 表示缓存未就绪（按未
// 知处理，小条按未总结展示，点开仍会正确建/续写）
window.__linkSummaryState = (docId, chapterTitle) => {
  const cache = docId && linksCache.get(docId)
  if (!cache) return { known: false, exists: false }
  for (const r of Object.values(cache.records)) {
    if (r.summary && r.summary.chapter === chapterTitle) return { known: true, exists: true }
  }
  return { known: true, exists: false }
}

// 打开章总结：该章已有（按章名精确匹配）→ 编辑续写；没有 → 新建（§5.2）
window.__linkOpenSummary = async (docId, chapter) => {
  if (!docId || !chapter || !chapter.title) return false
  if (!linksCache.has(docId)) await loadLinks(docId)
  const cache = linksCache.get(docId)
  if (cache) {
    for (const [f, r] of Object.entries(cache.records)) {
      if (r.summary && r.summary.chapter === chapter.title) {
        openEditor({ mode: 'edit', docId, file: f }).catch(() => {})
        return true
      }
    }
  }
  openEditor({ mode: 'summary', docId, chapter }).catch(() => {})
  return true
}

// 「＋新建」入口替换：在预览里新建笔记 = 从选句开始（返回 true = 已接管）
window.__linkNewOverride = (session) => {
  if (!session || !lastLayout || session.id !== lastLayout.docId) return false
  closeNotes()
  openSelection().catch(() => {})
  return true
}

// 记录行点击：摘录 → 跳回原文定位；总结 → 打开查看器（章锚点无正文标记
// 可闪）。返回 true = 已接管，不再打开笔记编辑器
window.__linkRecordTap = (docId, file) => {
  const rec = recordEntry(docId, file)
  if (!rec) return false
  if (rec.summary) {
    openViewer(docId, file).catch(() => {})
    return true
  }
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
  // 优先闪带（span 背景已移交带，闪 span 不可见）；带缺位（极端：几何全部
  // 落空）退回 span 兜底，滚动定位行为一致
  const t = layer.querySelector(`.lnk-band-lnk[data-file="${CSS.escape(pendingFlash.file)}"]`)
    || layer.querySelector(`.lnk[data-file="${CSS.escape(pendingFlash.file)}"]`)
  pendingFlash = null
  if (!t) return false
  t.scrollIntoView({ block: 'center' })
  t.classList.add('lnk-flash')
  setTimeout(() => t.classList.remove('lnk-flash'), 1100)
  return true
}

// 跳回：借页码输入框回车跳页，目标页渲染完成后由 pendingFlash 滚动 + 闪烁。
// k 指定跳到第几处摘录（查看器 chip 跳转用，§6.7；列表行默认第一处）。
// 顺手收起笔记面板——不然跳过去也被面板挡着，看不见闪烁的目标
function jumpToExcerpt (docId, file, k = 0) {
  const rec = linksCache.get(docId) && linksCache.get(docId).records[file]
  if (!rec || !rec.excerpts.length) return false
  const ex = rec.excerpts[k] || rec.excerpts[0]
  closeNotes()
  pendingFlash = { docId, file, page: ex.page }
  if (!tryFlashNow()) jumpPage(ex.page) // 异页：借页码回车跳页
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
