// 阅读工具簇：标注/笔记/链接三钮收拢的开合状态机与光环同步。
// 结构由 sync-www.mjs 补丁注入（#toolsCluster），样式与动效在 mobile.css
// 的 .tools-* 区块，规格见 docs/TOOLS-CLUSTER-DESIGN.md §5/§6。
// 三功能钮 ID 不变，preview.js/ink.js/link.js 的绑定照旧；本模块只追加
// 行为（收簇、光环、互斥让位），不替换不占用任何既有监听。
import { closeNotes } from '../notespanel.js'

const cluster = document.getElementById('toolsCluster')
const trigger = document.getElementById('btnTools')

function isOpen () { return !!(cluster && cluster.classList.contains('open')) }

function openCluster () {
  cluster.classList.add('open')
  trigger.setAttribute('aria-expanded', 'true')
  // 展开时目录胶囊让位（真机自查 2026-10-08）：水平菜单自触发器向左生长
  // 会罩住同排的目录胶囊（实测重叠 848–1010 vs 928–1003）——「互斥让位」
  // 家族：菜单存续期间胶囊淡出（[hidden] 的无大纲钮不受影响，CSS 有 :not 守卫）
  document.body.classList.add('tools-open')
}

function closeCluster () {
  cluster.classList.remove('open')
  trigger.setAttribute('aria-expanded', 'false')
  document.body.classList.remove('tools-open')
}

// 返回键链（boot.mjs）：簇展开时返回键先收簇、不关预览（§6 路径 6）
window.__toolsClose = function () {
  if (!isOpen()) return false
  closeCluster()
  return true
}

if (cluster && trigger) {
  trigger.addEventListener('click', () => (isOpen() ? closeCluster() : openCluster()))

  // 点任一功能钮：原绑定照常触发，簇随后收起（§6 路径 3）
  for (const id of ['btnInk', 'btnLink', 'btnNotes']) {
    document.getElementById(id)?.addEventListener('click', closeCluster)
  }

  // 阅读浮层与创作模式互斥让位（真机复现：目录开着进标注，面板 z6 悬在
  // 墨迹层 z2 之上，左侧 ~300px 落笔/拖选全被拦截）。双向收口：
  // - 进标注/链接 → 目录与笔记面板让位
  // - 开目录/笔记面板 → 退出标注/选词（墨迹退出即冲刷保存，批注常显不丢；
  //   选词退出即清选集）。面板与模式不再同屏叠放
  const tocPanel = document.getElementById('tocPanel')
  const yieldPanels = () => {
    if (tocPanel && !tocPanel.hidden) tocPanel.hidden = true
    closeNotes()
  }
  const yieldModes = () => {
    if (window.linkSelecting) window.dispatchEvent(new CustomEvent('solace-link-cancel-request'))
    if (window.inkActive) window.dispatchEvent(new CustomEvent('solace-ink-exit-request'))
  }
  document.getElementById('btnInk')?.addEventListener('click', yieldPanels)
  document.getElementById('btnLink')?.addEventListener('click', yieldPanels)
  document.getElementById('btnToc')?.addEventListener('click', yieldModes)
  document.getElementById('btnNotes')?.addEventListener('click', yieldModes)

  // 簇外点按收簇（§6 路径 4）：捕获相先于目标处理——不拦事件，
  // 被点元素（如目录钮）照常工作，两个动作同时发生
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !cluster.contains(e.target)) closeCluster()
  }, true)

  // Esc 先收簇、不关预览（§6 路径 5）：捕获相拦在 app.js 全局 Esc
  // （冒泡相）之前；输入控件内的 Esc 让位原生行为、对话框开着让位
  // 对话框——判据与 app.js 的全局 Esc 一致
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen()) return
    const tag = e.target && e.target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (document.querySelector('dialog[open]')) return
    e.stopPropagation()
    closeCluster()
  }, true)

  // 关预览瞬时复位（§6 路径 7）：overlay 置 hidden（display:none）期间
  // 完成类移除，过渡不上屏；重开预览不残留展开态
  const overlay = document.getElementById('previewOverlay')
  if (overlay) {
    new MutationObserver(() => {
      if (overlay.hidden && isOpen()) closeCluster()
    }).observe(overlay, { attributes: true, attributeFilter: ['hidden'] })
  }
}

// 模式光环（§5.4）：选词 body.link-selecting（link.js 维护）/
// 标注 body.ink-active（ink.js setActive 与 ink-close 直排两处共同维护）。
// 单观察器看 body 类变化，两模式任一激活即亮
function syncHalo () {
  trigger?.classList.toggle(
    'tools-active',
    document.body.classList.contains('ink-active') ||
    document.body.classList.contains('link-selecting')
  )
}
new MutationObserver(syncHalo).observe(document.body, { attributes: true, attributeFilter: ['class'] })
syncHalo()
