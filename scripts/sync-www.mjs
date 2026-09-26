// 从桌面仓库搬运渲染层 → www/，并施加移动端补丁、收拢 vendor 资产。
// 幂等可重跑：上游桌面端更新后，重跑本脚本即可同步（补丁锚点若被上游
// 改动会显式报错，防止静默漂移）。
//
// 用法：node scripts/sync-www.mjs [--src <桌面仓库路径>]
//   或设环境变量 SOLACE_DESKTOP
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const srcIdx = args.indexOf('--src')
const SRC = srcIdx >= 0 ? args[srcIdx + 1]
  : process.env.SOLACE_DESKTOP || 'E:/Learning/pycharm/ExperProject/Solace_Rust'

const R = join(SRC, 'src/renderer')
const NM = join(SRC, 'node_modules')

const WWW = join(root, 'www')

/* ---- 1. 全量重建 www/（桥 bundle 由 build-bridge.mjs 生成，同样在 www/） ---- */
rmSync(WWW, { recursive: true, force: true })
mkdirSync(join(WWW, 'css'), { recursive: true })
mkdirSync(join(WWW, 'js'), { recursive: true })
mkdirSync(join(WWW, 'vendor/pdfjs/build'), { recursive: true })

cpSync(join(R, 'index.html'), join(WWW, 'index.html'))
cpSync(join(R, 'css', 'style.css'), join(WWW, 'css', 'style.css'))
cpSync(join(R, 'js'), join(WWW, 'js'), { recursive: true })

/* ---- 2. vendor：pdf.js 与霞鹜文楷（从桌面仓库 node_modules 收拢） ---- */
cpSync(join(NM, 'pdfjs-dist/build/pdf.min.mjs'), join(WWW, 'vendor/pdfjs/build/pdf.min.mjs'))
cpSync(join(NM, 'pdfjs-dist/build/pdf.worker.min.mjs'), join(WWW, 'vendor/pdfjs/build/pdf.worker.min.mjs'))
cpSync(join(NM, 'pdfjs-dist/cmaps'), join(WWW, 'vendor/pdfjs/cmaps'), { recursive: true })
cpSync(join(NM, 'pdfjs-dist/standard_fonts'), join(WWW, 'vendor/pdfjs/standard_fonts'), { recursive: true })

mkdirSync(join(WWW, 'vendor/lxgw/files'), { recursive: true })
for (const css of ['lxgwwenkailite-regular.css', 'lxgwwenkailite-bold.css']) {
  cpSync(join(NM, 'lxgw-wenkai-lite-webfont', css), join(WWW, 'vendor/lxgw', css))
}
cpSync(join(NM, 'lxgw-wenkai-lite-webfont/files'), join(WWW, 'vendor/lxgw/files'), { recursive: true })
// 字体协议随行（OFL）
for (const lic of ['OFL.txt', 'LICENSE']) {
  try { cpSync(join(NM, 'lxgw-wenkai-lite-webfont', lic), join(WWW, 'vendor/lxgw', lic)) } catch { /* 可选 */ }
}

/* ---- 3. 移动端适配层（本仓库自带） ---- */
cpSync(join(root, 'mobile-web/css'), join(WWW, 'css'), { recursive: true })
cpSync(join(root, 'mobile-web/js'), join(WWW, 'js'), { recursive: true })

/* ---- 4. 移动端补丁（锚点缺失即报错，防上游改动后静默漂移） ---- */

function patch (relPath, replacements) {
  const file = join(WWW, relPath)
  const raw = readFileSync(file, 'utf8')
  // 桌面仓库是 CRLF、本脚本锚点是 LF：统一在 LF 空间匹配，写回时还原
  const crlf = raw.includes('\r\n')
  let text = raw.replace(/\r\n/g, '\n')
  for (const [from, to] of replacements) {
    const normFrom = String(from).replace(/\r\n/g, '\n')
    const normTo = String(to).replace(/\r\n/g, '\n')
    if (!text.includes(normFrom)) {
      throw new Error(`补丁锚点缺失：${relPath}\n---\n${String(from)}\n---\n上游文件可能已改动，请对照更新补丁`)
    }
    text = text.split(normFrom).join(normTo)
  }
  writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text)
}

patch('index.html', [
  // 视口与安全区：WebView 必需，Electron 不需要
  ['  <meta charset="UTF-8" />',
   '  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />'],
  // 字体从 node_modules 相对路径改指 vendor/
  ['../../node_modules/lxgw-wenkai-lite-webfont/lxgwwenkailite-regular.css', 'vendor/lxgw/lxgwwenkailite-regular.css'],
  ['../../node_modules/lxgw-wenkai-lite-webfont/lxgwwenkailite-bold.css', 'vendor/lxgw/lxgwwenkailite-bold.css'],
  // 移动端覆盖样式
  ['  <link rel="stylesheet" href="css/style.css" />',
   '  <link rel="stylesheet" href="css/style.css" />\n  <link rel="stylesheet" href="css/mobile.css" />'],
  // 抽屉开关（窄屏显示，横屏宽屏隐藏）
  ['  <header class="topbar">',
   '  <header class="topbar">\n        <button id="btnDrawer" class="btn-ghost btn-drawer" title="分类与筛选">☰</button>'],
  // 抽屉背板
  ['  </aside>',
   '  </aside>\n\n  <div id="drawerBackdrop" class="drawer-backdrop" hidden></div>'],
  // 桥（经典脚本，同步执行，先于一切模块）+ 移动端适配模块 + 原有 app.js
  ['  <script type="module" src="js/app.js"></script>',
   '  <script src="vendor/solace-bridge.js"></script>\n  <script type="module" src="js/mobile/mobile.js"></script>\n  <script type="module" src="js/app.js"></script>']
])

patch('js/pdfjs.js', [
  ['../../../node_modules/pdfjs-dist/build/pdf.min.mjs', '../../vendor/pdfjs/build/pdf.min.mjs'],
  ['../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', '../../vendor/pdfjs/build/pdf.worker.min.mjs'],
  ['../../../node_modules/pdfjs-dist/cmaps/', '../../vendor/pdfjs/cmaps/'],
  ['../../../node_modules/pdfjs-dist/standard_fonts/', '../../vendor/pdfjs/standard_fonts/']
])

patch('js/app.js', [
  // 「打开」：平板端没有外部阅读器，直接进内置预览
  [`      case 'open-doc': {
        await window.solace.openDoc(id)
        refresh()
        break
      }`,
   `      case 'open-doc': {
        if (window.solace.isMobile) {
          const doc = data.documents.find(d => d.id === id)
          if (doc) openPreview(doc)
          break
        }
        await window.solace.openDoc(id)
        refresh()
        break
      }`],
  // 触屏无拖拽导入；导入走「导入 PDF」按钮（系统文件选择器）
  [`window.addEventListener('drop', async (e) => {
  e.preventDefault()`,
   `window.addEventListener('drop', async (e) => {
  e.preventDefault()
  if (window.solace.isMobile) return`],
  // 平板端无回收站，文案如实
  ['同时删除这本书的全部笔记（移入系统回收站）', '同时删除这本书的全部笔记（直接删除，无回收站）'],
  ['同时删除所选书籍的全部笔记（移入系统回收站）', '同时删除所选书籍的全部笔记（直接删除，无回收站）'],
  ['（系统回收站不可用）', '（平板端无回收站）']
])

patch('js/notespanel.js', [
  // 「打开笔记」：内置 Markdown 编辑器接管（桌面端是 Typora）
  [`async function openOne (file) {
  try {
    const res = await window.solace.openNote(doc.id, file)`,
   `async function openOne (file) {
  if (window.solace.isMobile) {
    try {
      const res = await window.solace.openNote(doc.id, file)
      if (res && res.inApp) window.openNoteEditor(doc.id, file, res.title, res.content)
    } catch (err) {
      window.toast?.(\`打开失败：\${err.message || err}\`)
    }
    return
  }
  try {
    const res = await window.solace.openNote(doc.id, file)`],
  ['将移入系统回收站。', '将直接删除（平板端无回收站）。']
])

console.log(`www/ 同步完成（源：${SRC}）`)
console.log('补丁：index.html×7, pdfjs.js×4, app.js×5, notespanel.js×2')
