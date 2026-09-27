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
  // 抽屉背板（锚定侧栏收尾行而非裸 </aside>：split/join 是全量替换，
  // 上游若新增第二个 aside 会把背板静默插成两份——锚到唯一文本上，
  // 漂移只会显式报错）
  [`      <div class="side-foot">本地资料库 · 数据不出你的电脑</div>
    </aside>`,
   `      <div class="side-foot">本地资料库 · 数据不出你的电脑</div>
    </aside>

    <div id="drawerBackdrop" class="drawer-backdrop" hidden></div>`],
  // 桥（经典脚本，同步执行，先于一切模块）+ 移动端适配模块 + 原有 app.js
  ['  <script type="module" src="js/app.js"></script>',
   '  <script src="vendor/solace-bridge.js"></script>\n  <script type="module" src="js/mobile/mobile.js"></script>\n  <script type="module" src="js/app.js"></script>'],
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

// 加载点统一换 URL 直读（_capacitor_file_ 由 WebView 原生拦截流式返回，
// 内容不过 JS 桥；桌面端同步渲染层无此方法，自动回落字节路径）
patch('js/preview.js', [
  [`    const buffer = await window.solace.readPreview(id, sessionId)
    if (!isCurrentSession(token)) return
    // IPC 送来的就是 Uint8Array，直接用（再包一层 new Uint8Array 会白复制
    // 一整份文件——大 PDF 上就是几十 MB 的无谓内存与耗时）
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    const task = pdfjsLib.getDocument({ data, ...docParams })`,
   `    const loadOpts = window.solace.getDocUrl
      ? { url: await window.solace.getDocUrl(id), ...docParams }
      : { data: await window.solace.readPreview(id, sessionId), ...docParams }
    if (!isCurrentSession(token)) return
    const task = pdfjsLib.getDocument(loadOpts)`]
])

patch('js/covers.js', [
  [`async function generateCover (task) {
  try {
    const buffer = await window.solace.readPreview(task.doc.id, task.sessionId)
    if (task.generation !== generation) return null
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    task.loadingTask = pdfjsLib.getDocument({ data, ...docParams })`,
   `async function generateCover (task) {
  try {
    const loadOpts = window.solace.getDocUrl
      ? { url: await window.solace.getDocUrl(task.doc.id), ...docParams }
      : { data: await window.solace.readPreview(task.doc.id, task.sessionId), ...docParams }
    if (task.generation !== generation) return null
    task.loadingTask = pdfjsLib.getDocument(loadOpts)`],
  // 预览打开时封面队列让路：pdf.js 解析仍与翻页争 CPU，读书永远优先
  [`    while (queue.length && epoch === generation) {
      const task = queue.shift()`,
   `    while (queue.length && epoch === generation) {
      if (window.currentPreviewId) { await new Promise(r => setTimeout(r, 400)); continue }
      const task = queue.shift()`]
])

patch('js/textindex.js', [
  [`    const buffer = await window.solace.readPreview(docId, sessionId)
    if (task.generation !== generation) return
    // IPC 送来的就是 Uint8Array，直接用（再包一层 new Uint8Array 会白复制
    // 一整份文件）；万一拿到别的形态才走包装兜底
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    task.loadingTask = pdfjsLib.getDocument({ data, ...docParams })`,
   `    const loadOpts = window.solace.getDocUrl
      ? { url: await window.solace.getDocUrl(docId), ...docParams }
      : { data: await window.solace.readPreview(docId, sessionId), ...docParams }
    if (task.generation !== generation) return
    task.loadingTask = pdfjsLib.getDocument(loadOpts)`],
  // 预览打开时索引队列让路（同上）
  [`    while (pending.size && epoch === generation) {
      const task = pending.values().next().value`,
   `    while (pending.size && epoch === generation) {
      if (window.currentPreviewId) { await new Promise(r => setTimeout(r, 500)); continue }
      const task = pending.values().next().value`]
])

patch('js/app.js', [
  // 「打开」：平板端没有外部阅读器，直接进内置预览
  [`      case 'open-doc': {
        await window.solace.openDoc(id, sessionId)
        refresh()
        break
      }`,
   `      case 'open-doc': {
        if (window.solace.isMobile) {
          const doc = data.documents.find(d => d.id === id)
          if (doc) openPreview(doc)
          break
        }
        await window.solace.openDoc(id, sessionId)
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

patch('js/settings.js', [
  // 监视文件夹显示名：平板端存 SAF 目录名（uri 不可读也不可手输）。
  // 注意用 .value 赋值而非 setAttribute('value')——后者只设默认值，
  // 面板重开时会显示用户上次输入的脏值而非已存值
  [`  $('#setWatchFolder').value = s.watchFolder || ''`,
   `  $('#setWatchFolder').value = window.solace.isMobile ? (s.watchFolderName || '') : (s.watchFolder || '')
  $('#setOlibPackage').value = s.externalToolPackage || ''`],
  // 「浏览…」：平板端走 SAF 系统目录选择器，返回 { uri, name }
  [`$('#btnBrowseWatch').addEventListener('click', async () => {
  if (relocating) return
  const sessionId = panelSession
  try {
    const p = await window.solace.pickDirectory({ title: '选择自动入库监视文件夹' })
    if (!p || relocating || sessionId !== panelSession) return
    $('#setWatchFolder').value = p
    $('#setWatchEnabled').checked = true // 选了文件夹即视为想启用
    await save({ watchFolder: p, watchEnabled: true }, sessionId)
  } catch (err) {
    if (!relocating && sessionId === panelSession) window.toast?.(\`选择失败：\${err.message || err}\`)
  }
})`,
   `$('#btnBrowseWatch').addEventListener('click', async () => {
  if (window.solace.isMobile) {
    const r = await window.solace.pickDirectory({ title: '选择自动入库监视文件夹' })
    if (r && r.uri) {
      $('#setWatchFolder').value = r.name
      $('#setWatchEnabled').checked = true // 选了文件夹即视为想启用
      save({ watchTreeUri: r.uri, watchFolderName: r.name, watchEnabled: true })
    }
    return
  }
  if (relocating) return
  const sessionId = panelSession
  try {
    const p = await window.solace.pickDirectory({ title: '选择自动入库监视文件夹' })
    if (!p || relocating || sessionId !== panelSession) return
    $('#setWatchFolder').value = p
    $('#setWatchEnabled').checked = true // 选了文件夹即视为想启用
    await save({ watchFolder: p, watchEnabled: true }, sessionId)
  } catch (err) {
    if (!relocating && sessionId === panelSession) window.toast?.(\`选择失败：\${err.message || err}\`)
  }
})`],
  // 平板端输入框只读，change 不会由用户触发；防御性短路
  [`$('#setWatchFolder').addEventListener('change', (e) => save({ watchFolder: e.target.value.trim() }))`,
   `$('#setWatchFolder').addEventListener('change', (e) => {
  if (window.solace.isMobile) return
  save({ watchFolder: e.target.value.trim() })
})`],
  // 下载工具（Olib）：包名手输保存 + 「检测…」自动发现
  [`dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() }) // 点 backdrop 关闭`,
   `dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() }) // 点 backdrop 关闭

/* ---- 平板端：下载工具（Olib）包名 ---- */
$('#setOlibPackage')?.addEventListener('change', (e) => save({ externalToolPackage: e.target.value.trim() }))
$('#btnDetectOlib')?.addEventListener('click', async () => {
  let apps
  try {
    apps = await window.solace.findApps() // 无关键字 = Olib 多关键字检测（含 open_library 包名）
  } catch (err) {
    window.toast?.(\`检测失败：\${err.message || err}\`)
    return
  }
  if (!apps.length) { window.toast?.('未检测到 Olib，请确认已安装；也可手动填写包名'); return }
  if (apps.length === 1) {
    $('#setOlibPackage').value = apps[0].package
    save({ externalToolPackage: apps[0].package })
    window.toast?.(\`已选定 \${apps[0].label}（\${apps[0].package}）\`)
    return
  }
  const picked = await askChoice({
    title: '选择下载工具',
    text: '检测到多个可能的应用，选择哪一个作为「打开外部工具」的目标。',
    choices: apps.slice(0, 4).map(a => ({ label: \`\${a.label}（\${a.package}）\`, value: a.package, primary: a.package.includes('open_library') }))
  })
  if (picked) { $('#setOlibPackage').value = picked; save({ externalToolPackage: picked }) }
})`]
])

patch('js/notespanel.js', [
  // 「打开笔记」：内置 Markdown 编辑器接管（桌面端是 Typora）
  [`async function openOne (file, session) {
  if (!isCurrentSession(session)) return
  try {
    const res = await window.solace.openNote(session.id, file, {}, session.sessionId)`,
   `async function openOne (file, session) {
  if (window.solace.isMobile) {
    try {
      const res = await window.solace.openNote(session.id, file, {}, session.sessionId)
      if (res && res.inApp) window.openNoteEditor(session.id, file, res.title, res.content)
    } catch (err) {
      window.toast?.(\`打开失败：\${err.message || err}\`)
    }
    return
  }
  if (!isCurrentSession(session)) return
  try {
    const res = await window.solace.openNote(session.id, file, {}, session.sessionId)`],
  ['将移入系统回收站。', '将直接删除（平板端无回收站）。'],
  // 内置编辑器保存后刷新列表的修改时间（面板开着且是同一本书时）
  [`btnNew.addEventListener('click', async () => {`,
   `window.addEventListener('solace-note-saved', (e) => {
  if (panel.hidden || !doc) return
  if (e.detail && e.detail.docId && e.detail.docId !== doc.id) return
  load()
})

btnNew.addEventListener('click', async () => {`]
])

console.log(`www/ 同步完成（源：${SRC}）`)
console.log('补丁：index.html×9, pdfjs.js×4, preview.js×1, covers.js×2, textindex.js×2, app.js×5, settings.js×4, notespanel.js×3（共30）')
