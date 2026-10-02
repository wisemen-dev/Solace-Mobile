// 手写标注层：预览页面上的矢量墨迹（双 canvas 叠层——静态已提交墨迹 +
// 活动笔画）。数据经 window.solace.read/writeAnnotations 落
// annotations/<docId>.json；坐标一律 PDF scale=1 视口空间（左上原点，
// 单位 = 页面单位），渲染时统一乘 kx（设备像素/页面单位）——与 dpr、
// fitWidth、设备无关，任意倍率重绘不失真。
//
// 生命周期：preview.js 每次页面布局完成 dispatch 'solace-ink-layout'
// （detail 携带 docId/页码/尺寸/变换系数），关闭预览 dispatch
// 'solace-ink-close'。本模块惰性建 DOM：首次进入标注模式才挂墨迹层。
import { getStroke } from '../../vendor/perfect-freehand.js'

const PEN = { color: '#e03131', width: 2.5 } // P2 默认红笔；色板/粗细 P3 进工具栏

let host = null          // #previewBody（滚动容器，已 position:relative）
let pdfCanvas = null     // #previewCanvas（定位锚，尺寸锚）
let layer = null         // 墨迹容器（absolute 对齐 pdfCanvas）
let staticCv = null      // 已提交墨迹：提交/翻页/布局变化时重绘
let liveCv = null        // 正在画的这一笔：每 rAF 清空重画
let toolbar = null

let active = false
window.inkActive = false // mobile.js 的翻页/点按手势在标注模式下让位给绘制

let lastLayout = null    // 最近一次 layout 事件 detail（含 docId/page/尺寸）
let book = { version: 1, pages: {} } // 整本书内存模型；防抖写盘
let loadedDoc = null     // book 当前归属的 docId（null = 空置，等 layout 对账）
let dirty = false
let saveTimer = 0
let pendingWrite = null  // 在途写盘；loadBook 前须等它完成，防旧盘态覆盖新内存
const retryWrites = []   // 换书时写失败的旧书快照（docId 已换，不能走 dirty 重试）
let failToastAt = 0      // 写失败 toast 节流（持续失败时不刷屏）

let drawing = null       // 活动笔画 { ptr, pts: [{x,y,p}], color, width }
let rafPending = false
let penDown = false      // 手写笔在屏期间忽略 touch：防手掌误触（已确认用笔）

/* ================= DOM（惰性） ================= */

function ensureDom () {
  if (layer) return
  host = document.getElementById('previewBody')
  pdfCanvas = document.getElementById('previewCanvas')
  if (!host || !pdfCanvas) return

  layer = document.createElement('div')
  layer.className = 'ink-layer'
  layer.hidden = true
  staticCv = document.createElement('canvas')
  staticCv.className = 'ink-canvas'
  liveCv = document.createElement('canvas')
  liveCv.className = 'ink-canvas'
  layer.append(staticCv, liveCv)
  host.appendChild(layer)
  layer.addEventListener('pointerdown', onDown)
  layer.addEventListener('pointermove', onMove)
  layer.addEventListener('pointerup', onUp)
  layer.addEventListener('pointercancel', onUp)

  toolbar = document.createElement('div')
  toolbar.className = 'ink-toolbar'
  toolbar.hidden = true
  toolbar.innerHTML = `
    <button class="ink-btn ink-tool active" data-tool="pen" title="画笔">✏️ 笔</button>
    <button class="ink-btn" id="btnInkDone" title="退出标注并保存">✓ 完成</button>`
  document.getElementById('previewOverlay')?.appendChild(toolbar)
  toolbar.querySelector('#btnInkDone').addEventListener('click', () => setActive(false))
  // P3：荧光笔/橡皮/撤销重做/色板/粗细/清页在此扩展
}

function setActive (on) {
  ensureDom()
  if (!layer) return
  active = on
  window.inkActive = on
  toolbar.hidden = !on
  if (on) {
    layer.hidden = false
    applyLayout(lastLayout)
    if (lastLayout) syncBookToDoc(lastLayout.docId)
    else redrawStatic()
  } else {
    flushSave()
    layer.hidden = true
  }
}

document.getElementById('btnInk')?.addEventListener('click', () => setActive(!active))

/* ================= layout / close 事件（preview.js 补丁派发） ================= */

window.addEventListener('solace-ink-layout', (e) => {
  const d = e.detail
  if (!d || !d.docId) return
  lastLayout = d
  if (!active || !layer) return
  syncBookToDoc(d.docId)
  applyLayout(d)
  redrawStatic()
})

window.addEventListener('solace-ink-close', () => {
  if (!layer) return
  flushSave()
  active = false
  window.inkActive = false
  layer.hidden = true
  toolbar.hidden = true
  // 关预览即弃内存模型：重开（哪怕同一本书）从盘上重读，内存永不比盘旧
  loadedDoc = null
  book = { version: 1, pages: {} }
})

/* ================= 数据加载与保存 ================= */

// book 与当前 docId 的对账：换书/关后重开/激活早于首次 layout 都经此归位。
// 旧书若脏：先落盘再换（此刻 book/loadedDoc 仍属于旧书）；写失败入重试
// 队列（快照已脱离引用，不会污染新书的 dirty 语义）
function syncBookToDoc (docId) {
  if (loadedDoc === docId) { redrawStatic(); return }
  if (loadedDoc && dirty) {
    const oldDoc = loadedDoc
    const oldBook = book
    doWrite(oldDoc, oldBook).then((ok) => {
      if (!ok) retryWrites.push({ docId: oldDoc, data: oldBook })
    })
  }
  loadedDoc = docId
  dirty = false
  clearTimeout(saveTimer)
  saveTimer = 0
  book = { version: 1, pages: {} }
  loadBook(docId)
}

async function loadBook (docId) {
  // 在途写盘先等完（退出标注→立刻重进的窗口：不等会读回旧盘态覆盖内存）
  if (pendingWrite) await pendingWrite.catch(() => {})
  let res = null
  try {
    res = await window.solace.readAnnotations(docId)
  } catch (err) {
    window.toast?.(`标注读取失败：${err.message || err}`)
  }
  // 读取期间又换书/关预览：本次结果作废（book 已归属别的 docId）
  if (loadedDoc !== docId) return
  if (res) {
    if (res.notice) window.toast?.(res.notice)
    // 笔级合并：盘上页为底，在途窗口画的内存页把「盘上同页旧笔 + 内存新笔」
    // 拼接（内存页只可能来自本窗口的 commitStroke，全是新增笔）——页级覆盖
    // 会把盘上旧笔弄丢
    const diskPages = res.pages || {}
    const merged = { ...diskPages }
    for (const key of Object.keys(book.pages)) {
      const mem = book.pages[key]
      const disk = diskPages[key]
      merged[key] = disk
        ? { w: disk.w, h: disk.h, strokes: disk.strokes.concat(mem.strokes) }
        : mem
    }
    book = { version: 1, pages: merged }
  } else if (!dirty) {
    book = { version: 1, pages: {} }
  }
  redrawStatic()
}

function scheduleSave () {
  dirty = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 1500)
}

async function doWrite (docId, data) {
  try {
    await window.solace.writeAnnotations(docId, data)
    return true
  } catch (err) {
    if (Date.now() - failToastAt > 8000) {
      failToastAt = Date.now()
      window.toast?.(`标注保存失败：${err.message || err}`)
    }
    return false
  }
}

async function flushSave () {
  clearTimeout(saveTimer)
  saveTimer = 0
  // 先补写换书时失败的旧书快照（与当前书无关；仍失败则留在队列）
  while (retryWrites.length) {
    const w = retryWrites[0]
    if (await doWrite(w.docId, w.data)) retryWrites.shift()
    else break
  }
  if (!dirty || !lastLayout || loadedDoc !== lastLayout.docId) return
  dirty = false
  // book 传引用：写盘在途的落笔会原样进入本次写（数据层串行化+同步
  // stringify 保证不撕裂）；失败置回 dirty 由防抖重试
  const p = (async () => {
    const ok = await doWrite(loadedDoc, book)
    if (!ok) dirty = true
  })()
  pendingWrite = p.finally(() => { if (pendingWrite === p) pendingWrite = null })
  await p
  if (dirty) scheduleSave()
}

/* ================= 指针绘制 ================= */

function toPageXY (e) {
  // 显示矩形换算（rect 是实际渲染盒，天然兼容 css 尺寸与滚动）
  const r = pdfCanvas.getBoundingClientRect()
  return {
    x: (e.clientX - r.left) / r.width * lastLayout.baseW,
    y: (e.clientY - r.top) / r.height * lastLayout.baseH,
    p: e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5
  }
}

function onDown (e) {
  if (!active || !lastLayout) return
  if (e.pointerType === 'pen') penDown = true
  else if (e.pointerType === 'touch' && penDown) return // 手掌：笔在屏，忽略
  if (drawing) return // 已有一笔进行中：第二根手指不起新笔（P3 做双指滚动）
  if (e.button !== undefined && e.button !== 0) return
  e.preventDefault()
  layer.setPointerCapture?.(e.pointerId)
  drawing = {
    ptr: e.pointerId,
    docId: lastLayout.docId, // 提交时对账：画到一半换书则这笔作废（坐标系已变）
    pts: [toPageXY(e)],
    color: PEN.color,
    width: PEN.width,
    simPressure: e.pointerType !== 'pen'
  }
}

function onMove (e) {
  if (!drawing || e.pointerId !== drawing.ptr) return
  const pt = toPageXY(e)
  const last = drawing.pts[drawing.pts.length - 1]
  // 抽稀：<1 页面单位的移动不采（2 秒笔画约省一半点）
  if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 1) return
  drawing.pts.push(pt)
  if (!rafPending) {
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      drawLive()
    })
  }
}

function onUp (e) {
  if (e.pointerType === 'pen') penDown = false
  if (!drawing || e.pointerId !== drawing.ptr) return
  commitStroke()
}

function commitStroke () {
  const d = drawing
  drawing = null
  clearLive()
  if (!d || !d.pts.length || !lastLayout) return
  if (loadedDoc !== d.docId || loadedDoc !== lastLayout.docId) return
  const key = String(lastLayout.page)
  let pageObj = book.pages[key]
  if (!pageObj) pageObj = book.pages[key] = { w: lastLayout.baseW, h: lastLayout.baseH, strokes: [] }
  // 压感省空间：点的压力全为 0.5（手指/鼠标）时扁平存 [x,y]，否则存 [x,y,p]
  const uniform = d.pts.every(pt => pt.p === 0.5)
  const flat = []
  for (const pt of d.pts) {
    flat.push(pt.x, pt.y)
    if (!uniform) flat.push(pt.p)
  }
  pageObj.strokes.push({ tool: 'pen', color: d.color, width: d.width, pressure: uniform ? 0 : 1, pts: flat })
  redrawStatic()
  scheduleSave()
}

/* ================= 渲染 ================= */

function pageKx () {
  return lastLayout ? lastLayout.w / lastLayout.baseW : 1
}

function applyLayout (d) {
  if (!d || !layer) return
  layer.style.left = pdfCanvas.offsetLeft + 'px'
  layer.style.top = pdfCanvas.offsetTop + 'px'
  layer.style.width = d.cssW + 'px'
  layer.style.height = d.cssH + 'px'
  for (const cv of [staticCv, liveCv]) {
    cv.width = d.w
    cv.height = d.h
    cv.style.width = d.cssW + 'px'
    cv.style.height = d.cssH + 'px'
  }
}

function decodePts (s) {
  const step = s.pressure ? 3 : 2
  const out = []
  for (let i = 0; i + 1 < s.pts.length; i += step) {
    const x = s.pts[i], y = s.pts[i + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const p = s.pressure ? s.pts[i + 2] : 0.5
    out.push({ x, y, p: Number.isFinite(p) ? p : 0.5 })
  }
  return out
}

function strokeOpts (s, live) {
  return {
    size: s.width,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !s.pressure, // 无真压感：按速度模拟（重绘结果一致）
    last: !live // 活动笔画不算收尾（末端不 taper）
  }
}

function paintStroke (ctx, s, live) {
  const pts = live ? s.pts : decodePts(s)
  if (!pts.length) return
  const poly = getStroke(pts, strokeOpts(s, live))
  if (!poly.length) return
  ctx.fillStyle = s.color
  ctx.beginPath()
  ctx.moveTo(poly[0][0], poly[0][1])
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1])
  ctx.closePath()
  ctx.fill()
}

function redrawStatic () {
  if (!staticCv || !lastLayout) return
  const ctx = staticCv.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, staticCv.width, staticCv.height)
  const k = pageKx()
  ctx.setTransform(k, 0, 0, k, 0, 0) // 之后一律页面坐标空间
  const pageObj = book.pages[String(lastLayout.page)]
  if (pageObj) for (const s of pageObj.strokes) paintStroke(ctx, s, false)
}

function drawLive () {
  if (!drawing || !liveCv || !lastLayout) return
  const ctx = liveCv.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, liveCv.width, liveCv.height)
  const k = pageKx()
  ctx.setTransform(k, 0, 0, k, 0, 0)
  paintStroke(ctx, { pts: drawing.pts, color: drawing.color, width: drawing.width, pressure: drawing.simPressure ? 0 : 1 }, true)
}

function clearLive () {
  if (!liveCv) return
  const ctx = liveCv.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, liveCv.width, liveCv.height)
}
