// window.solace 桥：以桌面端 preload.js 暴露的同一套方法签名，把渲染层
// 的全部请求接到上面的数据层移植版上。渲染层代码（app.js / preview.js /
// settings.js / notespanel.js …）零感知——它们只知道 window.solace.* 返回
// Promise，分不清后面是 Electron IPC 还是 Capacitor Filesystem。
//
// 打包：esbuild 把本文件连同 @capacitor/core、@capacitor/filesystem 一起
// bundle 成一个经典脚本（www/vendor/solace-bridge.js），在 index.html 里
// 先于 app.js 加载——经典脚本同步执行，window.solace 在任何模块代码运行
// 前就位。
import { fs, rootUri, fileUrl } from './fs-adapter.mjs'
import { createLibrary } from './library-core.mjs'
import { createNotes } from './notes-core.mjs'
import { createAnnotations } from './annotations-core.mjs'
import { createLinks } from './links-core.mjs'
import { sha256Hex } from './sha256.mjs'
import { App } from '@capacitor/app'
import { findApps, findOlibCandidates, launchApp, pickFolder, pickPdfs, copyAndHash, hashLibraryPath } from './native.mjs'
import { createWatch } from './olib-watch.mjs'

const randomUUID = () => {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  // 兜底：非安全上下文（不应出现，防御性保留）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

const lib = createLibrary({ fs, sha256: sha256Hex, randomUUID, hashStorageFile: hashLibraryPath })
const notes = createNotes({ fs })
const annotations = createAnnotations({ fs })
const links = createLinks({ fs })

// 自动入库（Olib 下载目录补扫）：settings 随取随读，配置变更即时生效
const watch = createWatch({ lib, fs, getSettings: () => lib.getSettings() })

// 资料库初始化是异步的（读 library.json）；app.js 的 refresh() 可能在它
// 完成前就发起 getLibrary——每个方法先 await ready 再干活
const ready = lib.init()

// 初始化失败（磁盘满/目录不可写等）不能变成一个不报错的空壳界面：
// 全屏错误页兜底（桌面端对应场景是 dialog.showErrorBox）
ready.catch((err) => {
  const div = document.createElement('div')
  div.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#101418;color:#e8edf2;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;' +
    'padding:48px;text-align:center;font-size:15px;line-height:1.8;font-family:sans-serif'
  const msg = document.createElement('div')
  msg.style.cssText = 'opacity:.75;max-width:560px;word-break:break-all;font-size:13px'
  msg.textContent = String((err && err.message) || err)
  div.innerHTML = '<div style="font-size:42px">⚠️</div><b style="font-size:17px">资料库无法初始化</b>'
  div.appendChild(msg)
  const hint = document.createElement('div')
  hint.style.cssText = 'opacity:.5;font-size:12.5px'
  hint.textContent = '清理存储空间或重启应用后重试；已入库的书籍不受影响'
  div.appendChild(hint)
  document.body.appendChild(div)
})

const gate = (fn) => async (...args) => {
  await ready
  return fn(...args)
}

/* ---- 导入：WebView 原生 <input type=file> 走系统文件选择器 ---- */

// Android 上取消选择不触发 change：焦点回到窗口后做延迟兜底。
// 兜底窗口内的真实选择不会被误吞（有文件时 change 已先触发并置 settled）
function pickPdfFiles () {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = 'application/pdf,.pdf'
    input.style.display = 'none'
    document.body.appendChild(input)
    let settled = false
    const done = (files) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => done([...input.files]))
    const onFocus = () => {
      setTimeout(() => {
        if (!settled && (!input.files || !input.files.length)) done([])
      }, 1200)
    }
    window.addEventListener('focus', onFocus, { once: true })
    input.click()
  })
}

async function importDialog () {
  const imported = []
  const errors = []
  const duplicates = []
  // 优先原生管线（SAF 多选 + 原生流式哈希/复制，主线程零参与）；
  // 原生选择器异常时兜底 WebView 文件选择（JS 字节路径，慢但不失效）
  let entries = null
  try {
    const r = await pickPdfs()
    // 用户取消：直接结束（entries 保持 null 会落进下面兜底，再弹一次选择器）
    if (r.canceled) return { imported: [], errors: [], duplicates: [] }
    entries = r.files || []
  } catch { /* 原生选择器异常：回落 WebView 文件选择 */ }
  const files = entries || await pickPdfFiles()
  for (const f of files) {
    try {
      let doc
      if (entries) {
        // 原生暂存管线：复制+哈希一次完成（内容同源，无写入竞态），
        // 查重通过后由数据层把暂存文件原子转正
        doc = await lib.importVia({ fileName: f.name }, (staging) => copyAndHash(f.uri, staging))
      } else {
        const bytes = new Uint8Array(await f.arrayBuffer())
        doc = await lib.importFile({ fileName: f.name, size: f.size, bytes })
      }
      imported.push(doc)
    } catch (err) {
      if (err.duplicate) duplicates.push({ file: f.name, title: err.duplicate.title })
      else errors.push({ file: f.name, message: String(err.message || err) })
    }
  }
  return { imported, errors, duplicates }
}

/* ---- window.solace（签名与桌面端 preload.js 一一对应） ---- */

// 侧车迟到写防御的查询（用途见 writeNote / setNoteLinkEntry / writeAnnotations
// 的注释）：书是否仍在库。用 hasDocument 的 O(1) 索引查询——这里每次写
// 都会走，不能为了一个布尔值深拷贝整库。
const docAlive = (id) => lib.hasDocument(id)

const solace = {
  // 平台标记：渲染层的移动端分支（打开=预览、拖拽导入禁用等）据此分流
  isMobile: true,

  // 资料库
  getLibrary: gate(() => lib.getData()),
  getOpenStats: gate(() => lib.getOpenStats()),
  importDialog: gate(importDialog),
  importPaths: gate(async () => ({ imported: [], errors: [], duplicates: [] })), // 触屏无拖拽导入
  getLibraryInfo: gate(async () => ({ rootDir: (await rootUri()) || 'SolaceLibrary（应用专属目录）', canRelocate: false })),
  openLibraryRoot: gate(async () => true), // 平板端无文件管理器直达，占位成功
  inspectTarget: gate(async () => { throw new Error('平板端资料库位置固定，不支持迁移') }),
  relocateLibrary: gate(async () => { throw new Error('平板端资料库位置固定，不支持迁移') }),
  // 目录选择走 SAF（系统授权）：返回 { canceled, uri, name }，供监视文件夹配置
  pickDirectory: gate(async () => {
    try {
      const r = await pickFolder()
      return r && r.canceled ? null : r
    } catch (err) {
      // SAF 启动异常按「取消」返回并提示——渲染层调用点无 catch，
      // 原样上抛会成为 unhandled rejection、按钮静默无反馈
      window.toast?.(`选择文件夹失败：${(err && err.message) || err}`)
      return null
    }
  }),
  pickFile: gate(async () => null),

  // 文档
  updateDoc: gate((id, patch) => lib.updateDoc(id, patch)),
  // 批量改/删：一次落库（批量归档 50 本不再写 50 次 library.json）
  updateDocs: gate((ids, patch) => lib.updateDocs(ids, patch)),
  removeDoc: gate((id, opts) => lib.removeDoc(id, opts || {})),
  removeDocs: gate((ids, opts) => lib.removeDocs(ids, opts || {})),
  openDoc: gate(async () => { throw new Error('平板端请用内置预览阅读') }),
  markRead: gate((id) => lib.markOpened(id, 'read')),
  readPreview: gate((id) => lib.readFileBuffer(id)), // 字节路径（调试/兜底）
  // 库内 PDF 的直读 URL：WebView 原生拦截 _capacitor_file_ 流式返回，
  // 内容不过 JS 桥——预览/封面/索引的加载全走这条（性能关键路径）
  getDocUrl: gate(async (id) => {
    if (!lib.hasDocument(id)) throw new Error(`文档不存在: ${id}`)
    return fileUrl(`files/${id}.pdf`)
  }),
  setProgress: gate((id, page, totalPages) => lib.setProgress(id, page, totalPages)),

  // 全文索引
  getTextIndexStatus: gate(() => lib.getTextIndexStatus()),
  searchTextIndex: gate((kw, token) => lib.searchTextIndex(kw, token)),
  setTextIndex: gate((id, payload) => lib.setTextIndex(id, payload)),

  // 封面
  setCover: gate((id, dataUrl) => lib.setCover(id, dataUrl)),
  getCover: gate((id) => lib.getCoverDataUrl(id)),
  // 封面直读 URL（与 getDocUrl 同一条 _capacitor_file_ 快路径）：渲染层
  // <img src> 由 WebView 原生流式加载，不再把 JPEG base64 过 JS 桥。
  // 文件缺失返回 null，渲染层回落到「重新生成封面」。
  getCoverUrl: gate(async (id) => {
    if (!lib.hasDocument(id)) throw new Error(`文档不存在: ${id}`)
    if (!await fs.exists(`covers/${id}.jpg`)) return null
    return fileUrl(`covers/${id}.jpg`)
  }),

  // 分类
  addCategory: gate((name, parentId) => lib.addCategory(name, parentId)),
  renameCategory: gate((id, name) => lib.renameCategory(id, name)),
  moveCategory: gate((id, parentId) => lib.moveCategory(id, parentId)),
  removeCategory: gate((id) => lib.removeCategory(id)),

  // 标签
  addTag: gate((name) => lib.addTag(name)),
  removeTag: gate((id) => lib.removeTag(id)),

  // 智能收藏夹
  saveShelf: gate((name, filters) => lib.addSmartShelf(name, filters)),
  renameShelf: gate((id, name) => lib.renameSmartShelf(id, name)),
  removeShelf: gate((id) => lib.removeSmartShelf(id)),

  // 设置
  updateSettings: gate(async (patch) => {
    const s = await lib.updateSettings(patch)
    // 监视设置变化即补扫：重新启用/换目录时把期间落盘的文件收进来
    // （与桌面端 watcher.configure 的语义对齐）
    if ('watchEnabled' in patch || 'watchTreeUri' in patch) {
      watch.scan({ force: true }).catch(() => {})
    }
    return s
  }),

  // 外部工具与自动入库（对应桌面端「打开下载器 + 监视文件夹」）
  // 平板端：拉起 Olib（包名可配置，缺省按关键字自动检测）
  launchTool: gate(async () => {
    const s = lib.getSettings()
    let pkg = s.externalToolPackage || ''
    if (!pkg) {
      const apps = await findOlibCandidates()
      if (apps.length === 1) pkg = apps[0].package
      else if (apps.length > 1) throw new Error('检测到多个可能的应用，请到 设置 → 资料库 → 下载工具 指定包名')
      else throw new Error('未检测到 Olib，请先安装；或到 设置 → 资料库 → 下载工具 填写包名')
    }
    const ok = await launchApp(pkg)
    if (!ok) throw new Error(`无法启动 ${pkg}（应用可能未安装）`)
    return true
  }),
  // 原生应用检索（设置面板「检测…」按钮用；Olib 检测走多关键字集合）
  findApps: gate((keyword) => keyword ? findApps(keyword) : findOlibCandidates()),
  // 自动入库事件（app.js 已监听：imported → toast+刷新；error → toast）
  onWatchEvent: (cb) => {
    watch.init({
      onImported: (docs) => cb({ type: 'imported', docs }),
      onError: (message) => cb({ type: 'error', message })
    })
  },

  // 笔记：列表/新建/删除与桌面端同形；打开改为交内置编辑器（inApp）
  listNotes: gate((id) => notes.list(id)),
  createNote: gate((id, payload) => notes.create(id, payload)),
  openNote: gate(async (id, file) => {
    const doc = lib.getDocument(id)
    const content = await notes.read(id, file)
    return { inApp: true, title: (doc && doc.title) || '笔记', content }
  }),
  // 删除笔记：随后清掉摘录链接的侧车条目。侧车清理失败不把已成功的删除
  // 报成失败——残留条目由下次 readNoteLinks 的孤儿剪除兜底，渲染侧已即时
  // 清缓存重绘（该书没有 links 文件时 rm 返回 true = 无可清理视为成功）
  trashNote: gate(async (id, file) => {
    await notes.trash(id, file)
    try {
      await links.removeEntry(id, file)
    } catch { /* 见上：GC 兜底 */ }
  }),
  revealNote: gate(async () => true), // 无「在文件夹中查看」，按钮已隐藏
  // 移动端内置编辑器专用：读写笔记正文
  readNote: gate((id, file) => notes.read(id, file)),
  writeNote: gate(async (id, file, text) => {
    if (!docAlive(id)) return false
    return notes.write(id, file, text)
  }),

  // 摘录链接锚点（移动端专有；links/<docId>.json，与 notes/ 的 .md 解耦）。
  // 一次读改写：按现存 .md 剪除孤儿（仅发现孤儿时写回），保留损坏告示——读取
  // 失败（目录扫描真故障）会向上抛，不会谎报空表导致误剪
  readNoteLinks: gate(async (id) => {
    // 笔记集合快照必须在 links 写队列内取（见 links-core 的 provider 注释）：
    // 队列外提前取的过期快照会把并发保存中刚写入的锚点误剪成孤儿
    return links.readPruned(id, async () => (await notes.list(id)).notes.map(f => f.file))
  }),
  // 侧车迟到写防御（全量审查 P2-4）：删书后 UI 层的防抖冲刷/重试队列
  // 可能仍持有旧书数据（ink.js retryWrites 在下次 flushSave 无条件重写、
  // links setEntry 排队同理），把刚清掉的 notes/links 侧车复活成永不再
  // 清理的孤儿。桥侧统一兜底：写前查书仍在库，不在则返回 false 拒绝
  // ——丢的只是死数据，UI 层按写失败处理即可
  setNoteLinkEntry: gate(async (id, file, entry) => {
    if (!docAlive(id)) return false
    return links.setEntry(id, file, entry)
  }), // entry=null → 删除

  // 手写标注（移动端专有；annotations/<docId>.json，与 notes/ 的 .md 解耦）
  readAnnotations: gate((id) => annotations.read(id)),
  writeAnnotations: gate(async (id, data) => {
    if (!docAlive(id)) return false
    return annotations.write(id, data)
  }),

  // 桌面端经 webUtils 转换 File 路径；平板端不提供，渲染层据此禁用拖入导入
  getStartupNotice: () => lib.getStartupNotice()
}

window.solace = solace

// 自动入库的补扫时机：启动后稍等片刻（让首屏与索引进度先跑）+ 回到前台
// （用户从 Olib 下载完切回来的主路径）。节流在 watch.scan 内部
ready.then(() => {
  setTimeout(() => watch.scan({ force: true }).catch(() => {}), 3000)
}).catch(() => {}) // init 失败已有错误页兜底，这里避免额外的 unhandled rejection 噪声
// 回后台冲刷墨迹：Android 随时可能回收进程，防抖窗口（1.5s）内的笔画必须
// 立刻落盘。墨迹层由 ink.js 动态创建，未创建时这次派发没有监听者，无害
App.addListener('appStateChange', ({ isActive }) => {
  if (isActive) { watch.scan().catch(() => {}); return }
  window.dispatchEvent(new CustomEvent('solace-ink-flush'))
})

// Android 返回键语义：关最上层的浮层（对话框 > 预览 > 抽屉），都没有才
// 退出应用——不然看书中随手一划返回手势就把整个应用杀了。
// 桥脚本在 body 末尾执行，DOM 已就绪

// 模态对话框的打开顺序栈：querySelector('dialog[open]') 拿到的是 DOM 顺序
// 第一个，不是最上层——原生 dialog 的层叠按打开顺序而非 DOM 顺序。
// 在 showModal 上挂钩子记录打开顺序，close 事件（捕获阶段可收到不冒泡
// 的事件）负责出栈，返回键总是关真正在最上面的那个
const dialogStack = []
{
  const origShowModal = HTMLDialogElement.prototype.showModal
  HTMLDialogElement.prototype.showModal = function (...args) {
    origShowModal.apply(this, args)
    if (!dialogStack.includes(this)) dialogStack.push(this)
  }
  document.addEventListener('close', (e) => {
    const i = dialogStack.indexOf(e.target)
    if (i >= 0) dialogStack.splice(i, 1)
  }, true)
}

// 「再按一次退出」的计时只在根界面有效：被浮层消费掉的返回键一律清零，
// 否则关掉预览/抽屉后 2 秒内再按会直接退出（与防误触意图相悖）
let lastBackAt = 0

App.addListener('backButton', () => {
  const dlg = dialogStack[dialogStack.length - 1]
  if (dlg) {
    // 先给对话框自己一个拦截机会（如笔记编辑器的未保存确认），
    // 不拦截才真正关闭
    const ev = new CustomEvent('solace-close-request', { cancelable: true })
    dlg.dispatchEvent(ev)
    if (!ev.defaultPrevented) dlg.close()
    lastBackAt = 0
    return
  }
  // 顶栏溢出菜单（⋯）：先收菜单，不落穿到「再按一次退出」——菜单开着连按
  // 两次返回会把应用关掉（真机自查 2026-10-08）。app.js 的 closeTopbarMore
  // 未导出，这里复刻其三个动作（与下方关预览的 DOM 直操作同款纪律）
  const topbarMore = document.getElementById('topbarMore')
  if (topbarMore && topbarMore.classList.contains('open')) {
    topbarMore.classList.remove('open')
    const moreTrigger = document.getElementById('btnTopbarMore')
    if (moreTrigger) {
      moreTrigger.classList.remove('on')
      moreTrigger.setAttribute('aria-expanded', 'false')
    }
    lastBackAt = 0
    return
  }
  // 阅读工具簇展开：先收簇，不关预览（TOOLS-CLUSTER-DESIGN §6 路径 6）
  if (window.__toolsClose?.()) {
    lastBackAt = 0
    return
  }
  // 摘录链接选词模式：返回键 = 取消选词（清空选集退出）
  if (window.linkSelecting) {
    window.dispatchEvent(new CustomEvent('solace-link-cancel-request'))
    lastBackAt = 0
    return
  }
  // 标注模式：先退出标注（ink 退出即冲刷保存），而不是直接关预览
  if (window.inkActive) {
    window.dispatchEvent(new CustomEvent('solace-ink-exit-request'))
    lastBackAt = 0
    return
  }
  const overlay = document.getElementById('previewOverlay')
  if (overlay && !overlay.hidden) {
    // 走按钮链路：app.js 的 closePreviewAndRefresh 会先落库进度再刷新
    document.getElementById('btnPreviewClose')?.click()
    lastBackAt = 0
    return
  }
  const sidebar = document.querySelector('.sidebar')
  if (sidebar && sidebar.classList.contains('open')) {
    sidebar.classList.remove('open')
    const bd = document.getElementById('drawerBackdrop')
    if (bd) bd.hidden = true
    lastBackAt = 0
    return
  }
  // 根界面：再按一次退出（Android 惯例，防误触）；2 秒窗口
  const now = Date.now()
  if (now - lastBackAt < 2000) {
    App.exitApp()
  } else {
    lastBackAt = now
    window.toast?.('再按一次退出 Solace', 1600)
  }
})

// 启动告示（资料库损坏重建等）：等渲染层就绪后经其 toast 通道提示。
// app.js 的 window.toast 在模块求值后才存在，这里延迟轮询
ready.then(async () => {
  const notice = lib.getStartupNotice()
  if (!notice) return
  let tries = 0
  const timer = setInterval(() => {
    tries++
    if (typeof window.toast === 'function') {
      window.toast(notice, 8000)
      clearInterval(timer)
    } else if (tries > 40) {
      clearInterval(timer)
    }
  }, 250)
}).catch(() => {})
