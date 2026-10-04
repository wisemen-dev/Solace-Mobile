// 平板端触屏适配层：与桌面渲染代码并存，不改其结构。
// 1. 侧栏抽屉（窄屏） 2. 预览滑动/边缘点按翻页 3. 内置笔记编辑器
// 4. 抽屉内选择后自动收起 5. Android 返回键语义（桥负责，这里只兜底）
// 手写标注层（ink.js）独立成模块，在此挂载
import { askConfirm } from '../dialog.js'
import './ink.js'
import './link.js'

const $ = (sel) => document.querySelector(sel)

/* ================= 侧栏抽屉 ================= */

const sidebar = $('.sidebar')
const backdrop = $('#drawerBackdrop')
const drawerMq = window.matchMedia('(max-width: 899.98px)')

function drawerOpen () {
  return sidebar.classList.contains('open')
}
function openDrawer () {
  if (!drawerMq.matches) return
  sidebar.classList.add('open')
  backdrop.hidden = false
}
function closeDrawer () {
  sidebar.classList.remove('open')
  backdrop.hidden = true
}

$('#btnDrawer')?.addEventListener('click', () => (drawerOpen() ? closeDrawer() : openDrawer()))
backdrop?.addEventListener('click', closeDrawer)
drawerMq.addEventListener?.('change', (e) => { if (!e.matches) closeDrawer() })

// 抽屉内点了分类/标签/收藏夹：轻微延迟后收起，让激活态先被看见
document.body.addEventListener('click', (e) => {
  if (!e.target.closest('#catList li, #tagList li, #shelfList li')) return
  setTimeout(closeDrawer, 140)
})

/* ========== 桌面专属设置行隐藏（:has() 的等价运行时实现） ========== */

// 原以 .settings-row:has(#setRootPath) 等选择器隐藏；:has() 需要较新的
// WebView，改为运行时等价隐藏（元素随设置面板静态存在，加载时即可处理）
for (const id of ['setRootPath', 'setPdfReader', 'setTool']) {
  document.getElementById(id)?.closest('.settings-row')?.style.setProperty('display', 'none')
}

/* ================= 预览手势：滑动翻页 + 边缘点按翻页 ================= */

// 用 Pointer Events 而非 Touch Events：previewBody 是 overflow:auto 的
// 滚动容器，横向滑动会被原生滚动手势接管并派发 pointercancel，
// touchend 往往收不到；pointerup 不受影响
const previewBody = $('#previewBody')
const btnNext = $('#btnNextPage')
const btnPrev = $('#btnPrevPage')

// 活跃指针集合：第二根手指落下即放弃本轮手势并复位——双指轻点/搭屏
// （横屏双手持机时很常见）不应被当成单指点按或滑动误翻页。
// 标注模式下（window.inkActive）单指让位给绘制，手势逻辑整体短路
const activePtrs = new Set()
let ptr = null // 单指手势起点 { id, x, y, t }

previewBody.addEventListener('pointerdown', (e) => {
  if (window.inkActive) return
  activePtrs.add(e.pointerId)
  if (activePtrs.size > 1) {
    ptr = null
    return
  }
  ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now() }
}, { passive: true })

previewBody.addEventListener('pointerup', (e) => {
  activePtrs.delete(e.pointerId)
  if (window.inkActive) return
  if (!ptr || e.pointerId !== ptr.id) return
  const p = ptr
  ptr = null
  const dx = e.clientX - p.x
  const dy = e.clientY - p.y
  const dt = Date.now() - p.t
  const dist = Math.hypot(dx, dy)

  // 快速点按（非滑动）：左右 20% 是翻页热区，中央留给原生点击行为
  // （收起目录/笔记面板）
  if (dt < 300 && dist < 12) {
    if (window.linkSelecting) return // 选词模式：点按=选句，关边缘点按翻页（滑动翻页保留）
    const rect = previewBody.getBoundingClientRect()
    const rel = (e.clientX - rect.left) / rect.width
    if (rel < 0.2) btnPrev?.click()
    else if (rel > 0.8) btnNext?.click()
    return
  }
  // 水平滑动翻页：横向位移明显大于纵向（纵向是滚动）
  if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
    if (dx < 0) btnNext?.click()
    else btnPrev?.click()
  }
}, { passive: true })

previewBody.addEventListener('pointercancel', (e) => {
  activePtrs.delete(e.pointerId)
  if (ptr && e.pointerId === ptr.id) ptr = null
}, { passive: true })

/* ================= 内置笔记编辑器（桌面端经 Typora 打开的等价物） ===== */

const editorHost = document.createElement('div')
editorHost.innerHTML = `
  <dialog id="noteEditorDialog" class="dialog note-editor-dialog">
    <div class="stats-head">
      <h3 id="noteEditorTitle">笔记</h3>
      <button id="btnNoteEdClose" class="btn-ghost" title="关闭">✕</button>
    </div>
    <textarea id="noteEditorText" class="note-editor-text" spellcheck="false"></textarea>
    <div class="dialog-foot">
      <button id="btnNoteEdCancel" class="btn-ghost">取消</button>
      <button id="btnNoteEdSave" class="btn-primary">保存</button>
    </div>
  </dialog>`
document.body.appendChild(editorHost)

const editorDlg = editorHost.querySelector('#noteEditorDialog')
const editorTitle = editorHost.querySelector('#noteEditorTitle')
const editorText = editorHost.querySelector('#noteEditorText')
let editorCtx = null // { docId, file }：保存时绑定，防止编辑期间切书串写
let editorDirty = false // 有未保存修改时不允许静默关闭（含返回键）

editorText.addEventListener('input', () => { editorDirty = true })

// notespanel.openOne 的移动端分支调用；content 是 .md 全文
window.openNoteEditor = function (docId, file, title, content) {
  // 摘录记录：不打开笔记编辑器，跳回原文定位（link.js 的钩子）
  if (window.__linkRecordTap?.(docId, file)) return
  editorCtx = { docId, file }
  editorTitle.textContent = `《${title || '笔记'}》 · ${String(file || '').replace(/\.md$/i, '')}`
  editorText.value = content ?? ''
  editorDirty = false
  editorDlg.showModal()
  setTimeout(() => editorText.focus(), 60)
}

// 有未保存修改时先确认再关；确认放弃才真正关闭
async function requestEditorClose () {
  if (editorDirty) {
    const res = await askConfirm({
      title: '放弃未保存的修改？',
      text: '笔记内容自上次保存后已修改，关闭后将丢失这些修改。',
      okText: '放弃修改'
    })
    if (!res) return
  }
  editorDirty = false
  editorDlg.close()
}

// 返回键（桥的 backButton 对话框分支）：拦截关闭请求，走未保存确认
editorDlg.addEventListener('solace-close-request', (e) => {
  if (!editorDirty) return
  e.preventDefault()
  requestEditorClose()
})

async function saveEditor () {
  if (!editorCtx) return
  const { docId, file } = editorCtx
  try {
    await window.solace.writeNote(docId, file, editorText.value)
    editorDirty = false
    editorCtx = null // 已保存，后续关闭不再触发确认
    editorDlg.close()
    window.toast?.('笔记已保存')
    // 笔记面板若开着则刷新列表的修改时间（notespanel 的移动端补丁监听）
    window.dispatchEvent(new CustomEvent('solace-note-saved', { detail: { docId } }))
  } catch (err) {
    window.toast?.(`保存失败：${err.message || err}`)
  }
}

editorHost.querySelector('#btnNoteEdSave').addEventListener('click', saveEditor)
editorHost.querySelector('#btnNoteEdCancel').addEventListener('click', requestEditorClose)
editorHost.querySelector('#btnNoteEdClose').addEventListener('click', requestEditorClose)
editorDlg.addEventListener('click', (e) => { if (e.target === editorDlg) requestEditorClose() })

/* ================= Android 返回键 ================= */

// 返回键语义（关浮层 → 退出）由桥接层统一处理（需 @capacitor/app 原生
// 插件），见 bridge/boot.mjs；本模块只负责收抽屉的兜底同步
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOpen()) closeDrawer()
})
