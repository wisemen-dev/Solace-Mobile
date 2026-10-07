// 手写标注层：预览页面上的矢量墨迹（双 canvas 叠层——静态已提交墨迹 +
// 活动笔画）。数据经 window.solace.read/writeAnnotations 落
// annotations/<docId>.json；坐标一律 PDF scale=1 视口空间（左上原点，
// 单位 = 页面单位），渲染时统一乘 kx（设备像素/页面单位）——与 dpr、
// fitWidth、设备无关，任意倍率重绘不失真。
//
// P3：工具栏（笔/荧光笔/橡皮/撤销重做/色板/粗细/清页）、荧光笔「不叠深不
// 盖字」（离屏并集 + multiply）、会话级撤销栈、双指滚动、返回键退出。
//
// 生命周期：preview.js 每次页面布局完成 dispatch 'solace-ink-layout'
// （detail 携带 docId/页码/尺寸/变换系数），关闭预览 dispatch
// 'solace-ink-close'。本模块惰性建 DOM：首次进入标注模式才挂墨迹层。
import { getStroke } from '../../vendor/perfect-freehand.js'
import { askConfirm } from '../dialog.js'
import { jumpPage } from './page-jump.mjs'
import { splitStroke } from './ink-erase.mjs'

// 工具配置：色板与粗细按工具独立（荧光笔 5 色、笔 5 色、粗细三档；
// 橡皮无色板（colors 恒空——各弹层/按钮逻辑按「有无色板」统一判定，不特判
// 工具名）、尺寸四档（拍板 2026-10-07：最小 4 = 屏上 ≈14px，恰为最粗笔画
// 宽的「笔尖级」精确档；调研锚点 GoodNotes 6 Precision Eraser / Notability
// 滑杆——用户普遍嫌最小档太大，见 ANNOTATION-DESIGN §13 增补））
const TOOLS = {
  pen: { colors: ['#212529', '#e03131', '#1971c2', '#2f9e44', '#868e96'], widths: [1.5, 2.5, 4.0] },
  hl: { colors: ['#fff00a', '#ff6b6b', '#51cf66', '#4dabf7', '#b197fc'], widths: [8, 12, 18] },
  eraser: { colors: [], sizes: [4, 8, 14, 22] }
}
const TOOL_STATE_KEY = 'solace.ink.tools'
// 工具/颜色/粗细记忆：各工具一套，跨会话保留（localStorage，不进 library.json）
const toolMemo = { tool: 'pen', pen: { color: '#e03131', width: 2.5 }, hl: { color: '#fff00a', width: 12 }, eraser: { r: 14 } }
{
  try {
    const raw = JSON.parse(localStorage.getItem(TOOL_STATE_KEY) || '{}')
    if (TOOLS[raw.tool]) toolMemo.tool = raw.tool
    for (const t of ['pen', 'hl']) {
      const m = raw[t]
      if (m && TOOLS[t].colors.includes(m.color) && TOOLS[t].widths.includes(m.width)) toolMemo[t] = { color: m.color, width: m.width }
    }
    const em = raw.eraser
    if (em && TOOLS.eraser.sizes.includes(em.r)) toolMemo.eraser = { r: em.r }
  } catch { /* 存值损坏回默认 */ }
}
let tool = toolMemo.tool
function saveToolState () {
  try { localStorage.setItem(TOOL_STATE_KEY, JSON.stringify(toolMemo)) } catch { /* 存不进则仅本次会话生效 */ }
}
function curTool () { return toolMemo[tool] }

let host = null          // #previewBody（滚动容器，已 position:relative）
let pdfCanvas = null     // #previewCanvas（定位锚，尺寸锚）
let layer = null         // 墨迹容器（absolute 对齐 pdfCanvas）
let staticCv = null      // 已提交墨迹：提交/翻页/布局变化时重绘
let liveCv = null        // 正在画的这一笔：每 rAF 清空重画
let toolbar = null

let active = false
// mobile.js 的翻页/点按手势在标注模式下让位给绘制；getter 只读视图，单一状态源
Object.defineProperty(window, 'inkActive', { get: () => active })

let lastLayout = null    // 最近一次 layout 事件 detail（含 docId/page/尺寸）
const emptyBook = () => ({ version: 1, pages: {} }) // 空墨迹模型工厂
let book = emptyBook()   // 整本书内存模型；防抖写盘
let loadedDoc = null     // book 当前归属的 docId（null = 空置，等 layout 对账）
let loadSeq = 0          // 内存模型代数：每次归位/关闭 +1，作废旧的在途读取
let loadState = 'empty'  // loading / ready / error：读成功前不允许绘制或覆盖写
let dirty = false
let saveTimer = 0
let pendingWrite = null  // 在途写盘；loadBook 前须等它完成，防旧盘态覆盖新内存
const retryWrites = []   // 换书时写失败的旧书快照（docId 已换不能走 dirty 重试；
                         // 重进该书时回灌内存，见 loadBook）
// 换书旧书写盘的结算链（含失败入快照）：loadBook 读前必须等完——不等的话
// 读取可能赶在「写失败入队」之前结算，把快照当成盘上旧态丢弃
let switchFlush = Promise.resolve()
let failToastAt = 0      // 写失败 toast 节流（持续失败时不刷屏）

let drawing = null       // 活动笔画 { ptr, docId, pts:[{x,y,p}], tool, color, width }
let rafPending = false
let penDown = false      // 手写笔在屏期间忽略 touch：防手掌误触（已确认用笔）
let erasing = null       // 橡皮手势 { ptr, page, docId, origins:Map<原笔,首切下标>, segOrigin:Map<段,原笔> }
let cursorEl = null      // 橡皮光圈（尺寸预览，随指针移动）
const pointers = new Map() // 活动指针（双指滚动仲裁）：pointerId → { x, y }
let scrolling = null     // 双指滚动中：两指中点（页面 client 坐标）
const undoStack = []     // 会话级操作栈（关预览/换书清空）；op：add / remove
const redoStack = []
let hlOff = null         // 荧光笔离屏并集层（重绘时用）

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
  cursorEl = document.createElement('div')
  cursorEl.className = 'ink-cursor'
  layer.append(staticCv, liveCv, cursorEl)
  host.appendChild(layer)
  layer.addEventListener('pointerdown', onDown)
  layer.addEventListener('pointermove', onMove)
  layer.addEventListener('pointerup', onUp)
  layer.addEventListener('pointercancel', onUp)
  layer.addEventListener('pointerleave', () => { if (cursorEl) cursorEl.style.display = 'none' })

  toolbar = document.createElement('div')
  toolbar.className = 'ink-toolbar'
  toolbar.hidden = true
  toolbar.innerHTML = `
    <button class="ink-btn ink-tool" data-tool="pen" title="画笔">✏️ 笔</button>
    <button class="ink-btn ink-tool" data-tool="hl" title="荧光笔">🖍️ 荧光</button>
    <button class="ink-btn ink-tool" data-tool="eraser" title="橡皮（按大小局部擦拭）">🧽 橡皮</button>
    <span class="ink-sep"></span>
    <button class="ink-btn" id="btnInkUndo" title="撤销">↶</button>
    <button class="ink-btn" id="btnInkRedo" title="重做">↷</button>
    <span class="ink-sep"></span>
    <button class="ink-btn" id="btnInkPalette" title="颜色"><i class="ink-dot" id="inkDot"></i></button>
    <button class="ink-btn" id="btnInkWidth" title="粗细">━</button>
    <span class="ink-sep"></span>
    <button class="ink-btn" id="btnInkClear" title="清空本页">🗑 清页</button>
    <button class="ink-btn" id="btnInkDone" title="退出标注并保存">✓ 完成</button>
    <div class="ink-pop" id="inkPalette" hidden></div>
    <div class="ink-pop" id="inkWidths" hidden></div>`
  document.getElementById('previewOverlay')?.appendChild(toolbar)
  toolbar.querySelectorAll('.ink-tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)))
  toolbar.querySelector('#btnInkDone').addEventListener('click', () => setActive(false))
  toolbar.querySelector('#btnInkUndo').addEventListener('click', () => doUndo())
  toolbar.querySelector('#btnInkRedo').addEventListener('click', () => doRedo())
  toolbar.querySelector('#btnInkClear').addEventListener('click', () => clearPage())
  toolbar.querySelector('#btnInkPalette').addEventListener('click', () => togglePop('inkPalette'))
  toolbar.querySelector('#btnInkWidth').addEventListener('click', () => togglePop('inkWidths'))
  // 弹层外点按收起（toolbar 内点击不关）
  document.addEventListener('pointerdown', (e) => {
    if (popOpen && !toolbar.contains(e.target)) closePops()
  })
  syncToolbarUI()
}

/* ---- 工具栏状态与弹层（色板 / 粗细） ---- */

let popOpen = null
function togglePop (id) {
  if (popOpen === id) closePops()
  else openPop(id)
}
function openPop (id) {
  if (!TOOLS[tool].colors.length && id === 'inkPalette') return // 无色板的工具（橡皮）不弹色板
  closePops()
  buildPops()
  popOpen = id
  document.getElementById(id).hidden = false
}
function closePops () {
  popOpen = null
  const a = document.getElementById('inkPalette')
  const b = document.getElementById('inkWidths')
  if (a) a.hidden = true
  if (b) b.hidden = true
}
function buildPops () {
  const pal = document.getElementById('inkPalette')
  pal.innerHTML = ''
  // 无色板的工具（橡皮）：弹层清空即止——不留上一工具的残留色钮
  if (TOOLS[tool].colors.length) {
    for (const c of TOOLS[tool].colors) {
      const b = document.createElement('button')
      b.className = 'ink-color' + (c === curTool().color ? ' on' : '')
      b.dataset.color = c
      b.style.background = c
      b.title = c
      b.addEventListener('click', () => {
        curTool().color = c
        saveToolState()
        closePops()
        syncToolbarUI()
      })
      pal.appendChild(b)
    }
  }
  const ws = document.getElementById('inkWidths')
  ws.innerHTML = ''
  // 带尺寸档的工具（橡皮）：擦拭半径（页面单位），展示为圆点而非横条
  const hasSizes = !!TOOLS[tool].sizes
  const sizes = hasSizes ? TOOLS[tool].sizes : TOOLS[tool].widths
  const curSize = hasSizes ? curTool().r : curTool().width
  sizes.forEach((w, i) => {
    const b = document.createElement('button')
    b.className = 'ink-width' + (w === curSize ? ' on' : '')
    b.dataset.width = String(w)
    b.innerHTML = hasSizes
      ? `<i class="ink-erase-dot" style="width:${[6, 10, 15, 21][i] || 12}px;height:${[6, 10, 15, 21][i] || 12}px"></i>`
      : `<i style="height:${[4, 6, 9][i] || 5}px"></i>`
    b.title = String(w)
    b.addEventListener('click', () => {
      if (hasSizes) curTool().r = w
      else curTool().width = w
      saveToolState()
      closePops()
      syncToolbarUI()
      syncCursorSize()
    })
    ws.appendChild(b)
  })
}
function setTool (t) {
  if (t === tool) return
  if (!TOOLS[t]) return
  tool = t
  toolMemo.tool = t
  saveToolState()
  closePops()
  syncToolbarUI()
  syncCursorSize()
}
function syncToolbarUI () {
  if (!toolbar) return
  toolbar.querySelectorAll('.ink-tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool))
  const dot = document.getElementById('inkDot')
  if (dot) dot.style.background = tool === 'eraser' ? 'transparent' : curTool().color
  const palBtn = document.getElementById('btnInkPalette')
  if (palBtn) palBtn.disabled = !TOOLS[tool].colors.length // 橡皮无颜色；尺寸走粗细弹层
  syncCursorSize()
  const undo = document.getElementById('btnInkUndo')
  const redo = document.getElementById('btnInkRedo')
  if (undo) undo.disabled = !undoStack.length
  if (redo) redo.disabled = !redoStack.length
}

function setActive (on) {
  ensureDom()
  if (!layer) return
  active = on
  document.body.classList.toggle('ink-active', on) // 工具簇光环的观察源（tools.js）
  toolbar.hidden = !on
  if (on) {
    if (lastLayout) {
      applyLayout(lastLayout)
      syncBookToDoc(lastLayout.docId)
    }
    // applyLayout 重设 canvas 尺寸必清空位图（即使尺寸未变），必须重画
    redrawStatic()
  } else {
    flushSave() // 退出标注立即冲刷（不等 1.5s 防抖）
  }
  // 退出不隐藏墨迹层：批注在阅读模式持续可见（passive = 手势穿透）
  updateLayerVisibility()
}

document.getElementById('btnInk')?.addEventListener('click', () => {
  // 选词中进标注：先取消选词（清空选集退出），两种模式不并存
  if (!active && window.linkSelecting) window.dispatchEvent(new CustomEvent('solace-link-cancel-request'))
  setActive(!active)
})

/* ================= layout / close 事件（preview.js 补丁派发） ================= */

window.addEventListener('solace-ink-layout', (e) => {
  const d = e.detail
  if (!d || !d.docId) return
  ensureDom()
  if (!layer) return
  lastLayout = d
  syncBookToDoc(d.docId) // 阅读模式也要加载墨迹数据（换书才真正读盘）
  applyLayout(d)
  redrawStatic()
  updateLayerVisibility()
})

window.addEventListener('solace-ink-close', async () => {
  if (!layer) return
  active = false
  document.body.classList.remove('ink-active') // setActive 之外的直排复位，光环类不能漏同步
  layer.hidden = true
  layer.classList.remove('ink-passive')
  toolbar.hidden = true
  // 先冲刷再决定是否弃模型：flushSave 可能先补写重试队列（含 await），
  // 若提前同步重置 loadedDoc，守卫会把当前脏书拦下——笔迹静默丢失。
  // 冲刷失败（dirty 被置回）则保留模型不弃：重开同书直接复用（内存 ⊇ 盘），
  // 换书走 syncBookToDoc 的既有重试队列；成功才作废在途读取并弃模型
  const layoutAtClose = lastLayout
  await flushSave()
  if (pendingWrite) await pendingWrite.catch(() => {})
  if (dirty) return
  // 冲刷期间用户已重开（新 layout 已到）：模型归新会话，不得再清
  if (lastLayout !== layoutAtClose) return
  loadSeq++
  loadedDoc = null
  loadState = 'empty'
  book = emptyBook()
  clearHistory() // 关预览即会话结束：重开从零开始
})

// Android 返回键：标注模式激活时优先退出标注（boot.mjs 返回键链派发）。
// 退出即冲刷保存、无需确认；写失败有 toast + 重试 + 保留模型兜底
window.addEventListener('solace-ink-exit-request', () => { if (active) setActive(false) })

// 回后台冲刷（boot.mjs 的 appStateChange 派发）：进程可能被系统直接杀掉，
// 防抖窗口内的笔画必须立刻落盘。不设 active 守卫——阅读模式下模型仍可能带脏
// （写失败的快照队列），flushSave 内部自有 dirty 与归属校验
window.addEventListener('solace-ink-flush', () => { flushSave() })

/* ================= 数据加载与保存 ================= */

// 墨迹层可见性：标注模式必显；阅读模式仅当当前页有墨迹时显示（passive：
// pointer-events 关闭，滚动/翻页手势穿透到 previewBody）
function updateLayerVisibility () {
  if (!layer || !lastLayout) return
  const pageObj = book.pages[String(lastLayout.page)]
  const hasInk = !!(pageObj && pageObj.strokes.length)
  layer.hidden = !(active || hasInk)
  layer.classList.toggle('ink-passive', !active)
}

// book 与当前 docId 的对账：换书/关后重开/激活早于首次 layout 都经此归位。
// 旧书有未落盘内容或有在途写：先挂入结算链落盘再换——在途写的结算结果
// 未知（可能失败），必须等它结算后再补写一次旧书（引用最新、幂等），失败
// 入快照队列；loadBook 读前等链结算。快照已脱离引用，不污染新书的 dirty
function syncBookToDoc (docId) {
  if (loadedDoc === docId) {
    if (loadState === 'error') startLoad(docId)
    redrawStatic(); updateLayerVisibility(); return
  }
  clearHistory() // 会话边界：操作栈不跨书（条目只对当前书的页数组有效）
  if (loadedDoc && (dirty || pendingWrite)) {
    const oldDoc = loadedDoc
    const oldBook = book
    const inflight = pendingWrite
    switchFlush = switchFlush.then(async () => {
      if (inflight) await inflight.catch(() => {})
      const ok = await doWrite(oldDoc, oldBook)
      if (!ok) retryWrites.push({ docId: oldDoc, data: oldBook })
    })
  }
  loadedDoc = docId
  dirty = false
  clearTimeout(saveTimer)
  saveTimer = 0
  book = emptyBook()
  startLoad(docId)
}

function startLoad (docId) {
  loadState = 'loading'
  const seq = ++loadSeq
  loadBook(docId, seq).catch(err => {
    if (seq !== loadSeq || loadedDoc !== docId) return
    loadState = 'error'
    window.toast?.(`标注加载失败：${err.message || err}`, 6000)
  })
}

async function loadBook (docId, seq) {
  // 在途写盘先等完（退出标注→立刻重进的窗口：不等会读回旧盘态覆盖内存）；
  // 换书写盘链同样等完——它的失败入队要在下面查快照之前结算
  await switchFlush.catch(() => {})
  if (pendingWrite) await pendingWrite.catch(() => {})
  // 过期 load 先拦：防止下面的快照回灌被已作废的会话取走
  if (seq !== loadSeq) return
  // 该书存在换书写失败的快照：直接作内存基准并置脏补写（2026-10-03 复核：
  // 含删改仍成立——写从未成功过，快照即内存最新态，其中的「删」是用户意图，
  // 覆盖盘上旧态正是目的；反之读盘会读回缺笔迹的旧态，之后任何以内存为准
  // 的成功写都会把快照里的笔迹覆盖丢）
  const wi = retryWrites.findIndex(w => w.docId === docId)
  if (wi >= 0) {
    book = retryWrites.splice(wi, 1)[0].data
    dirty = true
    loadState = 'ready'
    scheduleSave()
    redrawStatic()
    updateLayerVisibility()
    return
  }
  let res = null
  try {
    res = await window.solace.readAnnotations(docId)
  } catch (err) {
    if (seq === loadSeq && loadedDoc === docId) {
      loadState = 'error'
      window.toast?.(`标注读取失败：${err.message || err}；重新进入标注可重试`, 6000)
    }
    return // 读故障绝不能放行空模型覆盖旧墨迹
  }
  // 代数作废：期间发生过归位/关闭（换书、关后重开——同书快速关开会有
  // 两个在途读取，仅比对 docId 区分不开，旧结果合并会把同一批笔迹翻倍）
  if (seq !== loadSeq) return
  if (loadedDoc !== docId) return
  loadState = 'ready'
  if (res) {
    if (res.notice) window.toast?.(res.notice)
    // loading 期间不允许修改模型，完整盘态直接成为本会话基准。
    book = { version: 1, pages: res.pages || {} }
  } else {
    book = emptyBook()
  }
  redrawStatic()
  updateLayerVisibility()
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
  // 先补写换书时失败的旧书快照（与当前书无关；仍失败则留在队列）。
  // 按身份移除而非 shift：写盘在途时条目可能已被 loadBook 的回灌取走，
  // 位置 shift 会误删排在后面的别的书快照
  while (retryWrites.length) {
    const w = retryWrites[0]
    if (await doWrite(w.docId, w.data)) {
      const i = retryWrites.indexOf(w)
      if (i >= 0) retryWrites.splice(i, 1)
    } else break
  }
  if (!dirty || !lastLayout || loadedDoc !== lastLayout.docId || loadState !== 'ready') return
  dirty = false
  // book 传引用：写盘在途的落笔会原样进入本次写（数据层串行化+同步
  // stringify 保证不撕裂）；失败置回 dirty 由防抖重试
  const p = (async () => {
    const ok = await doWrite(loadedDoc, book)
    if (!ok) dirty = true
  })()
  pendingWrite = p
  p.finally(() => { if (pendingWrite === p) pendingWrite = null })
  await p
  if (dirty) scheduleSave()
}

/* ================= 撤销/重做（会话级操作栈） ================= */

// op：{ type:'add', page, index, stroke }
//   | { type:'remove', page, removed:[{index, stroke}] }
//   | { type:'modify', page, mods:[{before, after:[stroke], index}] }（局部擦除切割）
// remove/modify 的下标是「操作当时」的数组下标——重放按引用优先定位，
// 下标兜底（后续操作可能移动位置）；撤销按记录反序处理即可精确还原

function pushOp (op) {
  undoStack.push(op)
  redoStack.length = 0
  syncToolbarUI()
}

function applyOp (op, inverse) {
  const pageObj = book.pages[op.page]
  if (!pageObj) return
  if (op.type === 'add') {
    if (inverse) {
      const i = pageObj.strokes[op.index] === op.stroke ? op.index : pageObj.strokes.indexOf(op.stroke)
      if (i >= 0) pageObj.strokes.splice(i, 1)
    } else {
      pageObj.strokes.splice(Math.min(op.index, pageObj.strokes.length), 0, op.stroke)
    }
  } else if (op.type === 'modify') {
    if (inverse) {
      // 撤销切割：幸存段列（同源段在页内连续）换回原笔
      for (let m = op.mods.length - 1; m >= 0; m--) {
        const mod = op.mods[m]
        const i = mod.after.length ? pageObj.strokes.indexOf(mod.after[0]) : Math.min(mod.index, pageObj.strokes.length)
        if (i < 0) continue
        pageObj.strokes.splice(i, mod.after.length, mod.before)
      }
    } else {
      for (const mod of op.mods) {
        // 引用优先定位；异常序列下未命中时按下标兜底插入（与 add 分支同宽恕度）
        let i = pageObj.strokes.indexOf(mod.before)
        if (i < 0) { pageObj.strokes.splice(Math.min(mod.index, pageObj.strokes.length), 0, ...mod.after); continue }
        pageObj.strokes.splice(i, 1, ...mod.after)
      }
    }
  } else if (inverse) {
    for (let i = op.removed.length - 1; i >= 0; i--) pageObj.strokes.splice(op.removed[i].index, 0, op.removed[i].stroke)
  } else {
    for (const r of op.removed) {
      const i = pageObj.strokes.indexOf(r.stroke)
      if (i >= 0) pageObj.strokes.splice(i, 1)
    }
  }
}

// 撤销目标页非当前页时跳过去（借页码输入框回车跳转）：改了哪能看见
function ensurePageVisible (page) {
  if (!lastLayout || String(lastLayout.page) === String(page)) return
  jumpPage(page)
}

function afterHistoryChange (op) {
  ensurePageVisible(op.page)
  redrawStatic()
  updateLayerVisibility()
  scheduleSave()
  syncToolbarUI()
}

function doUndo () {
  const op = undoStack.pop()
  if (!op) return
  applyOp(op, true)
  redoStack.push(op)
  afterHistoryChange(op)
}

function doRedo () {
  const op = redoStack.pop()
  if (!op) return
  applyOp(op, false)
  undoStack.push(op)
  afterHistoryChange(op)
}

function clearHistory () {
  undoStack.length = 0
  redoStack.length = 0
  syncToolbarUI()
}

async function clearPage () {
  if (!active || !lastLayout) return
  const pageKey = String(lastLayout.page)
  const pageObj = book.pages[pageKey]
  if (!pageObj || !pageObj.strokes.length) return
  const r = await askConfirm({ title: '清空本页', text: `清空第 ${pageKey} 页的全部手写标注？（可用「撤销」恢复）`, okText: '清空' })
  if (!r) return
  // 对话框期间可能翻页/换书：对账后才动手
  if (!active || !lastLayout || String(lastLayout.page) !== pageKey || loadedDoc !== lastLayout.docId) return
  const cur = book.pages[pageKey]
  if (!cur || !cur.strokes.length) return
  const removed = cur.strokes.map((s, i) => ({ index: i, stroke: s }))
  cur.strokes.length = 0
  pushOp({ type: 'remove', page: pageKey, removed })
  redrawStatic()
  updateLayerVisibility()
  scheduleSave()
}

/* ================= 指针绘制 / 擦除 / 双指滚动 ================= */

function toPageXY (e, t = tool) {
  // 显示矩形换算（rect 是实际渲染盒，天然兼容 css 尺寸与滚动）；
  // 荧光笔恒无压感（恒定宽度），只有真笔的笔工具才记压感
  const r = pdfCanvas.getBoundingClientRect()
  return {
    x: (e.clientX - r.left) / r.width * lastLayout.baseW,
    y: (e.clientY - r.top) / r.height * lastLayout.baseH,
    p: (t === 'pen' && e.pointerType === 'pen') ? (e.pressure || 0.5) : 0.5
  }
}

function twoMid () {
  const it = pointers.values()
  const a = it.next().value
  const b = it.next().value
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

// 面板（目录/笔记）或对话框打开期间不起笔（关闭后恢复）
function suspendDrawing () {
  return !!document.querySelector('dialog[open], .toc-panel:not([hidden])')
}

function onDown (e) {
  if (!active || !lastLayout) return
  if (loadState !== 'ready') {
    if (loadState === 'error') startLoad(lastLayout.docId)
    window.toast?.('正在读取标注，请稍候再落笔', 1600)
    return
  }
  if (e.button !== undefined && e.button !== 0) return
  if (suspendDrawing()) return
  if (e.pointerType === 'pen') penDown = true
  else if (e.pointerType === 'touch' && penDown) return // 手掌：笔在屏，绘制与滚动都让位
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size >= 2) {
    // 第二指落下：进行中的笔画作废，进入双指滚动（单指手势在本层已全部让位）
    if (drawing) { drawing = null; clearLive() }
    settleErase(erasing)
    erasing = null
    e.preventDefault()
    if (pointers.size === 2) scrolling = twoMid()
    return
  }
  e.preventDefault()
  try { layer.setPointerCapture?.(e.pointerId) } catch { /* 合成事件无真实指针，可忽略 */ }
  if (tool === 'eraser') {
    erasing = { ptr: e.pointerId, page: String(lastLayout.page), docId: lastLayout.docId, origins: new Map(), segOrigin: new Map() }
    eraseAt(toPageXY(e))
    return
  }
  drawing = {
    ptr: e.pointerId,
    docId: lastLayout.docId, // 提交时对账：画到一半换书则这笔作废（坐标系已变）
    page: String(lastLayout.page), // 同理翻页作废（与橡皮的中途放弃同款对账）
    pts: [toPageXY(e)],
    tool,
    color: curTool().color,
    width: curTool().width,
    simPressure: e.pointerType !== 'pen'
  }
}

function onMove (e) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  moveCursor(e)
  if (scrolling) {
    if (pointers.size >= 2) {
      const m = twoMid()
      host.scrollTop -= m.y - scrolling.y // 双指拖动滚页（自然方向）
      scrolling = m
    }
    return
  }
  if (erasing) {
    if (e.pointerId !== erasing.ptr) return
    eraseAt(toPageXY(e))
    return
  }
  if (!drawing || e.pointerId !== drawing.ptr) return
  if (loadedDoc !== drawing.docId || String(lastLayout.page) !== drawing.page) {
    // 翻页/换书后 rect 与坐标系已换新页，继续采点会把新页坐标混进旧页笔画
    drawing = null
    clearLive()
    return
  }
  const pt = toPageXY(e, drawing.tool)
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
  pointers.delete(e.pointerId)
  if (scrolling) {
    if (pointers.size < 2) scrolling = null
    return
  }
  if (erasing) {
    if (e.pointerId !== erasing.ptr) return
    const g = erasing
    erasing = null
    if (settleErase(g)) updateLayerVisibility()
    return
  }
  if (!drawing || e.pointerId !== drawing.ptr) return
  commitStroke()
}

/* ---- 橡皮（局部擦拭：矢量切割，ink-erase.mjs） ---- */

// 擦除手势被中止（第二指落下转滚动 / 中途翻页）：已切的保持切割，但必须
// 补齐记录与落盘——否则屏幕已切、盘未切，且撤销栈缺条（§12.5 一次手势 = 一条记录）
function settleErase (g) {
  if (!g || !g.origins.size || loadedDoc !== g.docId) return false // 书已换：旧模型已弃，无从补写
  const pageObj = book.pages[g.page]
  const mods = []
  if (pageObj) {
    for (const [origin, firstIdx] of g.origins) {
      // 该原笔的全部幸存段（同手势多刀只记一条：原笔 → 最终段集）
      const after = pageObj.strokes.filter(s => g.segOrigin.get(s) === origin)
      mods.push({ before: origin, after, index: after.length ? pageObj.strokes.indexOf(after[0]) : firstIdx })
    }
  }
  if (mods.length) pushOp({ type: 'modify', page: g.page, mods })
  scheduleSave()
  return true
}

function eraseAt (pt) {
  if (!erasing) return
  // 手势中途翻页/换书：放弃后续擦除；已切的保持切割并补齐记录与落盘（同书），
  // 书已换则旧模型已弃，无从补写（操作栈随换书清空）
  if (loadedDoc !== erasing.docId || String(lastLayout.page) !== erasing.page) {
    const g = erasing
    erasing = null
    settleErase(g)
    redrawStatic()
    updateLayerVisibility()
    return
  }
  const pageObj = book.pages[erasing.page]
  if (!pageObj) return
  const r = curTool().r
  let hit = false
  for (let i = pageObj.strokes.length - 1; i >= 0; i--) {
    const s = pageObj.strokes[i]
    const segs = splitStroke(s, pt.x, pt.y, r)
    if (!segs) continue
    // 段的原始归属：同手势对同一笔多刀切割只更新归属与最终段集
    const origin = erasing.segOrigin.get(s) ?? s
    if (!erasing.origins.has(origin)) erasing.origins.set(origin, i)
    pageObj.strokes.splice(i, 1, ...segs)
    for (const seg of segs) erasing.segOrigin.set(seg, origin)
    hit = true
  }
  if (hit) {
    redrawStatic()
    updateLayerVisibility()
  }
}

/* ---- 橡皮光圈：尺寸随指针实时可见（拍板 2026-10-07） ---- */

function syncCursorSize () {
  if (!cursorEl || !lastLayout) return
  if (!TOOLS[tool].sizes) { cursorEl.style.display = 'none'; return } // 光圈是带尺寸档工具（橡皮）专属
  // 直径 = 2r 页面单位 × 每单位 CSS 像素（cssW / baseW）
  const d = Math.max(6, Math.round(2 * curTool().r * (lastLayout.cssW / lastLayout.baseW)))
  cursorEl.style.width = d + 'px'
  cursorEl.style.height = d + 'px'
}

function moveCursor (e) {
  if (!cursorEl) return
  if (!TOOLS[tool].sizes) return
  const rect = layer.getBoundingClientRect()
  if (!rect.width) return
  cursorEl.style.display = 'block'
  cursorEl.style.left = (e.clientX - rect.left) + 'px'
  cursorEl.style.top = (e.clientY - rect.top) + 'px'
}

function commitStroke () {
  const d = drawing
  drawing = null
  clearLive()
  if (!d || !d.pts.length || !lastLayout) return
  if (loadedDoc !== d.docId || loadedDoc !== lastLayout.docId) return
  if (String(lastLayout.page) !== d.page) return // 翻页后抬手：旧页坐标不得进新页
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
  const stroke = { tool: d.tool, color: d.color, width: d.width, pressure: uniform ? 0 : 1, pts: flat }
  pageObj.strokes.push(stroke)
  pushOp({ type: 'add', page: key, index: pageObj.strokes.length - 1, stroke })
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
  syncCursorSize() // 布局尺寸变了，光圈直径跟随重算
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
  const hl = s.tool === 'hl'
  return {
    size: s.width,
    thinning: hl ? 0 : 0.5, // 荧光笔恒定宽度（不随速度/压感粗细）
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: hl ? false : !s.pressure, // 无真压感：按速度模拟（重绘结果一致）
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

// 画布复位：清位图并归还单位变换（页面坐标变换由调用方再设）
function resetCanvas (cv) {
  const ctx = cv.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, cv.width, cv.height)
  return ctx
}

function redrawStatic () {
  if (!staticCv || !lastLayout) return
  const ctx = resetCanvas(staticCv)
  const k = pageKx()
  ctx.setTransform(k, 0, 0, k, 0, 0) // 之后一律页面坐标空间
  const pageObj = book.pages[String(lastLayout.page)]
  if (!pageObj) return
  let hasHl = false
  for (const s of pageObj.strokes) {
    if (s.tool === 'hl') { hasHl = true; continue }
    paintStroke(ctx, s, false)
  }
  if (!hasHl) return
  // 荧光笔「不叠深」：同页荧光先在不透明离屏层并集（重叠颜色恒定），再以
  // multiply 一次性合成（压在其下的笔迹透出）；与 PDF 的相乘由 .ink-layer
  // 的 mix-blend-mode 负责（见 mobile.css）——合起来即「不叠深、不盖字」
  if (!hlOff) hlOff = document.createElement('canvas')
  if (hlOff.width !== staticCv.width) hlOff.width = staticCv.width
  if (hlOff.height !== staticCv.height) hlOff.height = staticCv.height
  const octx = hlOff.getContext('2d')
  octx.setTransform(1, 0, 0, 1, 0, 0)
  octx.clearRect(0, 0, hlOff.width, hlOff.height)
  octx.setTransform(k, 0, 0, k, 0, 0)
  for (const s of pageObj.strokes) if (s.tool === 'hl') paintStroke(octx, s, false)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'multiply'
  ctx.drawImage(hlOff, 0, 0)
  ctx.restore()
}

function drawLive () {
  if (!drawing || !liveCv || !lastLayout) return
  const ctx = resetCanvas(liveCv)
  const k = pageKx()
  ctx.setTransform(k, 0, 0, k, 0, 0)
  paintStroke(ctx, { pts: drawing.pts, color: drawing.color, width: drawing.width, tool: drawing.tool, pressure: drawing.simPressure ? 0 : 1 }, true)
}

function clearLive () {
  if (!liveCv) return
  resetCanvas(liveCv)
}
