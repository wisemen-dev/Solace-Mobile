// 从桌面仓库搬运渲染层 → www/，并施加移动端补丁、收拢 vendor 资产。
// 幂等可重跑：上游桌面端更新后，重跑本脚本即可同步（补丁锚点若被上游
// 改动会显式报错，防止静默漂移）。
//
// 用法：node scripts/sync-www.mjs [--src <桌面仓库路径>]
//   或设环境变量 SOLACE_DESKTOP
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const srcIdx = args.indexOf('--src')
const srcArg = srcIdx >= 0 ? args[srcIdx + 1] : undefined
if (srcIdx >= 0 && (!srcArg || srcArg.startsWith('--'))) {
  console.error('--src 需要跟一个桌面仓库路径参数')
  process.exit(1)
}
const SRC = srcArg || process.env.SOLACE_DESKTOP || 'E:/Learning/pycharm/ExperProject/Solace_Rust'

const R = join(SRC, 'src/renderer')
const NM = join(SRC, 'node_modules')

// 先验源再拆 www/：否则路径打错时 www 已被清空，后续 cap sync 会打进半空资产
for (const [label, p] of [['渲染层', R], ['node_modules', NM]]) {
  if (!existsSync(p)) {
    console.error(`桌面仓库缺 ${label}：${p}\n请用 --src <路径> 或环境变量 SOLACE_DESKTOP 指定有效仓库`)
    process.exit(1)
  }
}

const WWW = join(root, 'www')
// 全量审查 P1-4：先整删 www 再打补丁的旧顺序，在锚点失败时会留下半打补丁且
// 桥缺失的毒化 www——直接 cap sync 会装出 window.solace 不存在的废包。现全部
// 构建先落 .www-staging，44 处补丁全部校验通过后才删旧换新；失败时 www 完整
// 无损，staging 残留由下次运行自清（.gitignore 已忽略）
const STAGING = join(root, '.www-staging')

/* ---- 1. 全量重建 www/（桥 bundle 由 build-bridge.mjs 生成，同样在 www/） ---- */
rmSync(STAGING, { recursive: true, force: true })
mkdirSync(join(STAGING, 'css'), { recursive: true })
mkdirSync(join(STAGING, 'js'), { recursive: true })
mkdirSync(join(STAGING, 'vendor/pdfjs/build'), { recursive: true })

cpSync(join(R, 'index.html'), join(STAGING, 'index.html'))
cpSync(join(R, 'css', 'style.css'), join(STAGING, 'css', 'style.css'))
cpSync(join(R, 'js'), join(STAGING, 'js'), { recursive: true })

/* ---- 2. vendor：pdf.js 与霞鹜文楷（从桌面仓库 node_modules 收拢） ---- */
cpSync(join(NM, 'pdfjs-dist/build/pdf.min.mjs'), join(STAGING, 'vendor/pdfjs/build/pdf.min.mjs'))
cpSync(join(NM, 'pdfjs-dist/build/pdf.worker.min.mjs'), join(STAGING, 'vendor/pdfjs/build/pdf.worker.min.mjs'))
cpSync(join(NM, 'pdfjs-dist/cmaps'), join(STAGING, 'vendor/pdfjs/cmaps'), { recursive: true })
cpSync(join(NM, 'pdfjs-dist/standard_fonts'), join(STAGING, 'vendor/pdfjs/standard_fonts'), { recursive: true })

mkdirSync(join(STAGING, 'vendor/lxgw/files'), { recursive: true })
for (const css of ['lxgwwenkailite-regular.css', 'lxgwwenkailite-bold.css']) {
  cpSync(join(NM, 'lxgw-wenkai-lite-webfont', css), join(STAGING, 'vendor/lxgw', css))
}
cpSync(join(NM, 'lxgw-wenkai-lite-webfont/files'), join(STAGING, 'vendor/lxgw/files'), { recursive: true })
// 字体协议随行（OFL）
for (const lic of ['OFL.txt', 'LICENSE']) {
  try { cpSync(join(NM, 'lxgw-wenkai-lite-webfont', lic), join(STAGING, 'vendor/lxgw', lic)) } catch { /* 可选 */ }
}

/* ---- 3. 移动端适配层（本仓库自带） ---- */
cpSync(join(root, 'mobile-web/css'), join(STAGING, 'css'), { recursive: true })
cpSync(join(root, 'mobile-web/js'), join(STAGING, 'js'), { recursive: true })

/* ---- 3.5 共享纯函数层（复用优化 C3）：从桌面仓库搬运 library-shared.cjs
   到 bridge/（git 跟踪的源码树，非 www 产物）。桌面是唯一事实源：
   两端行为一致靠这一份文件，改共享逻辑只在桌面改、sync 搬运。
   缺文件显式报错（桌面仓库结构变化时提示），不用锚点（整文件覆盖） ---- */
if (!existsSync(join(SRC, 'src/main/library-shared.cjs'))) {
  console.error(`桌面仓库缺 src/main/library-shared.cjs（共享纯函数层）——请检查 ${SRC}`)
  process.exit(1)
}
cpSync(join(SRC, 'src/main/library-shared.cjs'), join(root, 'bridge/library-shared.cjs'))
console.log('共享层：bridge/library-shared.cjs ← 桌面 src/main/library-shared.cjs')

/* ---- 4. 移动端补丁（锚点缺失即报错，防上游改动后静默漂移） ---- */

const patchStats = {}
function patch (relPath, replacements) {
  const file = join(STAGING, relPath)
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
  patchStats[relPath] = replacements.length
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
  // 抽屉背板（锚定侧栏收尾结构而非裸 </aside>：split/join 是全量替换，
  // 上游若新增第二个 aside 会把背板静默插成两份——锚到唯一文本上，
  // 漂移只会显式报错。2026-10-08 上游删除 side-foot 尾注后改锚 shelfList
  // 收尾，id 唯一性不变）
  [`        <ul id="shelfList" class="side-list"></ul>
      </nav>
    </aside>`,
   `        <ul id="shelfList" class="side-list"></ul>
      </nav>
    </aside>

    <div id="drawerBackdrop" class="drawer-backdrop" hidden></div>`],
  // 桥（经典脚本，同步执行，先于一切模块）+ 移动端适配模块 + 原有 app.js
  ['  <script type="module" src="js/app.js"></script>',
   '  <script src="vendor/solace-bridge.js"></script>\n  <script type="module" src="js/mobile/mobile.js"></script>\n  <script type="module" src="js/app.js"></script>'],
  // 阅读工具簇（v0.5.2，设计书 docs/TOOLS-CLUSTER-DESIGN.md）：桌面端
  // #btnNotes 行整替为「三条杠圆钮 + 展开菜单」。三功能钮 ID 不变
  // （#btnInk/#btnLink/#btnNotes 移入簇内），preview.js/ink.js/link.js 的
  // 绑定照旧生效；开合状态在 tools.js、样式与动效在 mobile.css 的 .tools-*。
  // 菜单在触发器之前（z 低于触发器）：长出/没入都从触发器身后走
  [`        <button id="btnNotes" class="btn-ghost" title="本书的阅读笔记">笔记</button>`,
   `        <div id="toolsCluster" class="tools-cluster">
          <div id="toolsMenu" class="tools-menu" role="menu" aria-label="阅读工具">
            <div class="tools-slot" style="--tools-i: 0">
              <button id="btnInk" class="tools-circle" role="menuitem" title="手写标注" aria-label="标注">
                <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 3.4l3.4 3.4L7.4 16H4v-3.4z"/><path d="M11.4 5.2l3.4 3.4"/></svg>
              </button>
            </div>
            <div class="tools-slot" style="--tools-i: 1">
              <button id="btnLink" class="tools-circle" role="menuitem" title="摘录链接" aria-label="链接">
                <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 7l1.4-1.4a2.1 2.1 0 0 1 3 3L13 10"/><path d="M10 13l-1.4 1.4a2.1 2.1 0 0 1-3-3L7 10"/><path d="M8.6 11.4l2.8-2.8"/></svg>
              </button>
            </div>
            <div class="tools-slot" style="--tools-i: 2">
              <button id="btnNotes" class="tools-circle" role="menuitem" title="本书的阅读笔记" aria-label="笔记">
                <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5H6A1.5 1.5 0 0 0 4.5 4v12A1.5 1.5 0 0 0 6 17.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5z"/><path d="M11.5 2.5v4h4"/><path d="M7.5 10.5h5M7.5 13.5h5"/></svg>
              </button>
            </div>
          </div>
          <button id="btnTools" class="tools-trigger" title="标注 / 笔记 / 链接" aria-label="阅读工具" aria-haspopup="true" aria-expanded="false" aria-controls="toolsMenu"><span class="tools-bar"></span><span class="tools-bar"></span><span class="tools-bar"></span></button>
        </div>`],
  // 监视文件夹输入框：平板端只读（目录经 SAF 授权选择，不能手输 URI）
  ['<input id="setWatchFolder" class="field-input" type="text" placeholder="D:\\Downloads\\books" />',
   '<input id="setWatchFolder" class="field-input" type="text" readonly placeholder="点「浏览…」选择 Olib 的保存目录" />'],
  // 资料库分区追加「下载工具（Olib）」行（平板端专属，桌面同步不会带上）
  [`        <div class="settings-row">
          <div class="settings-label">自动入库归入分类<span class="hint">自动入库的书统一归入该分类，便于后续整理</span></div>
          <select id="setWatchCategory" class="settings-select"></select>
        </div>
      </section>`,
   `        <div class="settings-row">
          <div class="settings-label">自动入库归入分类<span class="hint">自动入库的书统一归入该分类，便于后续整理</span></div>
          <select id="setWatchCategory" class="settings-select"></select>
        </div>
        <div class="settings-row col">
          <div class="settings-label">下载工具（Olib）<span class="hint">命令面板「打开外部工具」启动的平板应用；把 Olib 的保存目录设到上面，搜到即入库。留空自动检测，检测不到或有多个时在此指定</span></div>
          <div class="path-row">
            <input id="setOlibPackage" class="field-input" type="text" placeholder="自动检测" />
            <button id="btnDetectOlib" class="btn-ghost">检测…</button>
          </div>
        </div>
      </section>`]
])

patch('js/pdfjs.js', [
  ['../../../node_modules/pdfjs-dist/build/pdf.min.mjs', '../../vendor/pdfjs/build/pdf.min.mjs'],
  ['../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', '../../vendor/pdfjs/build/pdf.worker.min.mjs'],
  ['../../../node_modules/pdfjs-dist/cmaps/', '../../vendor/pdfjs/cmaps/'],
  ['../../../node_modules/pdfjs-dist/standard_fonts/', '../../vendor/pdfjs/standard_fonts/']
])









/* ---- 5. 全部补丁成功——staging 原子替换 www/ ----
   旧序「先删 www 再打补丁」在锚点失败时会留下半打补丁且桥缺失的毒化
   www（直接 cap sync 装出 window.solace 不存在的废包）。现在构建全程落
   staging，44 处补丁全部校验通过才走到这里删旧换新；任何失败路径
   www 完整无损，staging 残留由下次运行自清 */
rmSync(WWW, { recursive: true, force: true })
renameSync(STAGING, WWW)

console.log(`www/ 同步完成（源：${SRC}）`)
console.log(`补丁：${Object.entries(patchStats).map(([f, n]) => `${f}×${n}`).join(', ')}（共${Object.values(patchStats).reduce((a, b) => a + b, 0)}）`)

// 顺手重建桥 bundle：本脚本全量重建 www/ 时会删掉 www/vendor/solace-bridge.js
// （git 跟踪文件），不重建的话「只跑 www + 直接 cap sync / Android Studio 构建」
// 会把缺桥的渲染层打进包（window.solace 不存在，界面整体不可用）
const bridge = spawnSync(process.execPath, [join(root, 'scripts/build-bridge.mjs')], { stdio: 'inherit' })
if (bridge.status !== 0) process.exit(bridge.status || 1)
