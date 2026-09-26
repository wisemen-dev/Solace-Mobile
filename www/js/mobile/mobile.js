// 平板端触屏适配层：与桌面渲染代码并存，不改其结构。
// 1. 侧栏抽屉（窄屏） 2. 预览滑动/边缘点按翻页 3. 内置笔记编辑器
// 4. 抽屉内选择后自动收起 5. 双击返回键关预览（Android 返回手势的兜底）
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

/* ================= 预览手势：滑动翻页 + 边缘点按翻页 ================= */

const previewBody = $('#previewBody')
const btnNext = $('#btnNextPage')
const btnPrev = $('#btnPrevPage')

let touchX = 0
let touchY = 0
let touchT = 0

previewBody.addEventListener('touchstart', (e) => {
  const t = e.touches[0]
  touchX = t.clientX
  touchY = t.clientY
  touchT = Date.now()
}, { passive: true })

previewBody.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0]
  const dx = t.clientX - touchX
  const dy = t.clientY - touchY
  const dt = Date.now() - touchT
  const dist = Math.hypot(dx, dy)

  // 快速点按（非滑动）：左右 20% 是翻页热区，中央留给原生点击行为
  // （收起目录/笔记面板）
  if (dt < 300 && dist < 12) {
    const rect = previewBody.getBoundingClientRect()
    const rel = (t.clientX - rect.left) / rect.width
    if (rel < 0.2) btnPrev?.click()
    else if (rel > 0.8) btnNext?.click()
    return
  }
  // 水平滑动翻页：横向位移明显大于纵向（纵向是滚动）
  if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) {
    if (dx < 0) btnNext?.click()
    else btnPrev?.click()
  }
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

// notespanel.openOne 的移动端分支调用；content 是 .md 全文
window.openNoteEditor = function (docId, file, title, content) {
  editorCtx = { docId, file }
  editorTitle.textContent = `《${title || '笔记'}》 · ${String(file || '').replace(/\.md$/i, '')}`
  editorText.value = content ?? ''
  editorDlg.showModal()
  setTimeout(() => editorText.focus(), 60)
}

async function saveEditor () {
  if (!editorCtx) return
  const { docId, file } = editorCtx
  try {
    await window.solace.writeNote(docId, file, editorText.value)
    editorDlg.close()
    window.toast?.('笔记已保存')
    // 笔记面板若开着，刷新列表的修改时间
    window.dispatchEvent(new CustomEvent('solace-note-saved'))
  } catch (err) {
    window.toast?.(`保存失败：${err.message || err}`)
  }
}

editorHost.querySelector('#btnNoteEdSave').addEventListener('click', saveEditor)
editorHost.querySelector('#btnNoteEdCancel').addEventListener('click', () => editorDlg.close())
editorHost.querySelector('#btnNoteEdClose').addEventListener('click', () => editorDlg.close())
editorDlg.addEventListener('click', (e) => { if (e.target === editorDlg) editorDlg.close() })

/* ================= Android 返回键 ================= */

// 返回键语义（关浮层 → 退出）由桥接层统一处理（需 @capacitor/app 原生
// 插件），见 bridge/boot.mjs；本模块只负责收抽屉的兜底同步
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOpen()) closeDrawer()
})
