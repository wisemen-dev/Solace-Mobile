// 沉浸式阅读（UX 优化，2026-11-07 拍板）：预览打开 3 秒无操作自动隐藏
// 顶/底栏；点按正文中心区切换；翻页/滚动只重置计时、不唤出（唤出仅靠
// 点按与工作状态）。任何「工作状态」（标注/选词/工具簇/目录/笔记面板/
// 对话框）自动唤出并暂停自动沉浸，全部退出后恢复计时。
// 隐藏形态是**原地淡出**（opacity + pointer-events，见 mobile.css）：栏在
// flex 布局流里（flex-shrink:0），display/位移会让正文区重排——跳动的
// 布局比常驻的栏更伤阅读。沉浸时贴底一条 2px 进度线保住位置感（翻页
// 短暂增亮）。移动端专有资产（零补丁），桌面无此行为。
const body = document.body
const overlay = document.getElementById('previewOverlay')
const host = document.getElementById('previewBody')

const DELAY = 3000
let immersive = false
let timer = 0
let reflowTimer = 0
let lastPage = 0
let bar = null
let litTimer = 0

// 工作状态：创作模式 / 工具簇展开 / 面板 / 对话框任一在场即非 armed——
// 沉浸既不进入也不保持
function working () {
  return !!(window.inkActive || window.linkSelecting ||
    body.classList.contains('tools-open') ||
    document.querySelector('dialog[open]') ||
    (document.getElementById('tocPanel') && !document.getElementById('tocPanel').hidden) ||
    (document.getElementById('notesPanel') && !document.getElementById('notesPanel').hidden))
}

function previewOpen () {
  return !!(overlay && !overlay.hidden)
}

function setImmersive (on) {
  if (on === immersive) return
  immersive = on
  if (on) body.classList.add('preview-immersive')
  else body.classList.remove('preview-immersive')
  // 栏收起/展开改变 previewBody 可视高：等 200ms 高度动画结束再派发
  // resize，preview.js 的 fit 重算拿到稳定尺寸（「适应」模式整页随视口
  // 长大填满；fit-width 宽度未变、fitted 不变零重画）。提前派发会读到
  // 动画中间值算出半吊子尺寸
  clearTimeout(reflowTimer)
  reflowTimer = setTimeout(() => {
    window.dispatchEvent(new Event('resize'))
  }, 220)
}

// 3 秒无操作进入沉浸；到点复查（计时期间可能开了面板/对话框）。
// 沉浸中调用是无操作：翻页/滚动保持沉浸
function schedule () {
  clearTimeout(timer)
  if (immersive) return
  timer = setTimeout(() => {
    if (previewOpen() && !working()) setImmersive(true)
  }, DELAY)
}

// 唤出顶/底栏；工作状态全退出时重新起 3s 计时
function wake () {
  setImmersive(false)
  if (previewOpen() && !working()) schedule()
}

/* ---- 进度线：沉浸时贴底 2px，宽度 = 当前页/总页，翻页短暂增亮 ---- */

function ensureBar () {
  if (bar || !overlay) return
  bar = document.createElement('div')
  bar.className = 'imm-progress'
  overlay.appendChild(bar)
}

function updateBar () {
  ensureBar()
  if (!bar) return
  const total = Number((document.getElementById('pageTotal') || {}).textContent) || 0
  if (!total || !lastPage) return
  bar.style.width = (Math.min(100, lastPage / total * 100)).toFixed(2) + '%'
  bar.classList.add('lit')
  clearTimeout(litTimer)
  litTimer = setTimeout(() => bar.classList.remove('lit'), 700)
}

/* ---- 事件源 ---- */

// 预览布局（含首次打开与每次翻页）：更新进度线；未沉浸时重置计时
window.addEventListener('solace-ink-layout', (e) => {
  const d = e.detail
  if (!d || d.page == null) return
  lastPage = Number(d.page) || 0
  updateBar()
  if (!immersive) schedule()
})

window.addEventListener('solace-ink-close', () => {
  clearTimeout(timer)
  setImmersive(false)
  lastPage = 0
  if (bar) bar.style.width = '0%'
})

// 滚动是阅读操作：未沉浸时重置计时
host?.addEventListener('scroll', () => { if (!immersive) schedule() }, { passive: true })

// 点按正文中心区切换（短点 <300ms、位移 <12px，与 link.js 点按判定同风格）。
// 边缘不响应：左右 20% 是既有点按翻页热区，上下留出栏区域——沉浸切换
// 与既有手势零冲突。创作模式（标注/选词）点按有自己的语义，直接让位
let down = null
host?.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: Date.now() }
}, { passive: true })
host?.addEventListener('pointerup', (e) => {
  if (!down) return
  const d = down
  down = null
  if (Date.now() - d.t >= 300 || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 12) return
  if (!previewOpen() || working()) return
  const r = host.getBoundingClientRect()
  const fx = (e.clientX - r.left) / r.width
  const fy = (e.clientY - r.top) / r.height
  if (fx < 0.2 || fx > 0.8 || fy < 0.15 || fy > 0.85) return
  if (immersive) wake() // 唤出并重新计时
  else { clearTimeout(timer); setImmersive(true) } // 手动进入：立即沉浸
})

// 工作状态出现/消退：body class（ink-active/link-selecting/tools-open）与
// 面板 hidden 的变化驱动——出现即唤出，全部退出且未沉浸时恢复计时
function onStatesChanged () {
  if (working()) { clearTimeout(timer); setImmersive(false) }
  else if (!immersive) schedule()
}
if (typeof MutationObserver !== 'undefined') {
  const obs = new MutationObserver(onStatesChanged)
  obs.observe(body, { attributes: true, attributeFilter: ['class'] })
  for (const id of ['tocPanel', 'notesPanel']) {
    const p = document.getElementById(id)
    if (p) obs.observe(p, { attributes: true, attributeFilter: ['hidden'] })
  }
}

// 对话框关闭（showModal 打开时进不了沉浸——到点复查拦住；关闭后恢复计时）
document.addEventListener('close', () => {
  if (!immersive) schedule()
}, true)
