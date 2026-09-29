// 桌面端 watcher.js 的 Android 等价物。Android 没有目录变更通知（SAF 无
// fs.watch 对应物），改为「SAF 授权目录 + 时机触发补扫」：
//   触发时机 = 应用启动 / 回到前台 / 设置里（重新）启用或换目录
// 其余语义与桌面端逐条对齐：
//   - 稳定判定：新文件隔 1.5s 两次枚举对比 size/mtime，仍在写的跳过
//     （下载器渐进写入，Olib/aria2 场景与桌面端相同）
//   - 内容级去重：原生流式 SHA-256 挡下，重复静默跳过
//   - 失败记录：文件 mtime 未变则本次会话不重试，变了（重新下载）放行
//   - 通知聚合：800ms 内的入库合并成一条 toast（渲染层文案现成）
//   - 导入走原生管线（copyAndHash），文件内容不过 JS 桥
// 与桌面端的差异（性能取舍，详见 docs/PORTING.md）：多一份 watch-state.json
// 记录「已处理过的文件（size+mtime）」，未变化的文件每次补扫直接跳过，
// 不再像桌面端那样每次重启都重读重算全部哈希——平板的补扫频率是「每次
// 回前台」，重读不可接受。状态文件删掉无副作用：全部文件重新撞一次
// 内容去重而已。
import { listPdfs, copyAndHash } from './native.mjs'

export function createWatch ({ lib, fs, getSettings }) {
  let callbacks = null
  let scanSeq = 0 // 扫描代数：换目录/停用后，旧扫描在检查点自行退出
  let lastScanAt = 0
  // 回前台补扫的最小间隔：SAF 全量枚举本身有成本（几百文件秒级，虽在
  // io 线程不卡 UI），频繁切换应用时不该每次都扫；但主路径是「去 Olib
  // 下载完切回」，30s 窗口既合并了频繁切换，又不会漏掉刚下完的书
  const RESCAN_THROTTLE_MS = 30000
  const failed = new Map() // uri -> mtime：导入失败的文件，未变化不重试
  let notifyQueue = []
  let notifyTimer = null
  let state = null // uri -> { size, mtime }，watch-state.json
  let stateDirty = false

  function init (cb) {
    callbacks = cb || {}
  }

  async function loadState () {
    if (state) return state
    try {
      state = JSON.parse(await fs.readFileText('watch-state.json'))
      if (!state || typeof state !== 'object' || Array.isArray(state)) state = {}
    } catch {
      state = {}
    }
    return state
  }

  async function saveState () {
    if (!stateDirty) return
    stateDirty = false
    try {
      await fs.writeFileAtomicText('watch-state.json', JSON.stringify(state))
    } catch { /* 状态写失败只影响性能（下次重扫），不报错打扰 */ }
  }

  function notifyImported (doc) {
    notifyQueue.push({ id: doc.id, title: doc.title })
    clearTimeout(notifyTimer)
    notifyTimer = setTimeout(() => {
      const docs = notifyQueue
      notifyQueue = []
      if (docs.length && callbacks && callbacks.onImported) callbacks.onImported(docs)
    }, 800)
  }

  function reportError (message) {
    if (callbacks && callbacks.onError) callbacks.onError(message)
  }

  async function importOne (file, st) {
    try {
      // 原生暂存管线：复制+哈希一次完成（内容同源，无写入竞态），
      // 查重通过后由数据层原子转正
      const doc = await lib.importVia({ fileName: file.name }, (staging) => copyAndHash(file.uri, staging))
      const catId = getSettings().watchCategory
      if (catId) {
        const data = lib.getData()
        if (data.categories.some(c => c.id === catId)) {
          try { await lib.updateDoc(doc.id, { categoryId: catId }) } catch { /* 归类失败不影响入库 */ }
        }
      }
      st[file.uri] = { size: file.size, mtime: file.mtime }
      stateDirty = true
      notifyImported(doc)
    } catch (err) {
      if (err && err.duplicate) {
        // 内容已在库中：记入状态，后续补扫直接跳过（桌面端靠重算哈希挡，
        // 平板补扫频繁，改为状态短路）
        st[file.uri] = { size: file.size, mtime: file.mtime }
        stateDirty = true
        return
      }
      failed.set(file.uri, file.mtime)
      reportError(`${file.name} 入库失败（${(err && err.message) || err}），本次运行内不再重试`)
    }
  }

  // 是否该立即补扫：节流 + 并发防重入
  function shouldRun () {
    if (Date.now() - lastScanAt < RESCAN_THROTTLE_MS) return false
    lastScanAt = Date.now()
    return true
  }

  async function scan (opts = {}) {
    const s = getSettings()
    if (!s.watchTreeUri || s.watchEnabled === false) return
    if (!opts.force && !shouldRun()) return
    const gen = ++scanSeq
    const st = await loadState()
    try {
      const files = await listPdfs(s.watchTreeUri)
      // 清理已离开目录的陈旧记录（文件被删/移走）：状态表不再无限增长
      const seen = new Set(files.map(f => f.uri))
      for (const k of Object.keys(st)) {
        if (!seen.has(k)) { delete st[k]; stateDirty = true }
      }
      for (const k of [...failed.keys()]) {
        if (!seen.has(k)) failed.delete(k)
      }
      // 候选：没处理过、或处理过后文件又变了（重新下载）
      const candidates = files.filter(f => {
        const seen = st[f.uri]
        if (!seen) return true
        return seen.size !== f.size || seen.mtime !== f.mtime
      })
      if (candidates.length) {
        // 稳定判定：下载器渐进写入，两次枚举间 size/mtime 仍在变的跳过，
        // 留给下次补扫（桌面端是事件防抖 + 两次 stat，这里扫描式等价）
        await new Promise(r => setTimeout(r, 1500))
        if (gen !== scanSeq) return // 期间配置已变（换目录/停用）
        const again = new Map((await listPdfs(s.watchTreeUri)).map(f => [f.uri, f]))
        for (const f of candidates) {
          if (gen !== scanSeq) return
          const cur = again.get(f.uri)
          if (!cur || cur.size !== f.size || cur.mtime !== f.mtime) continue
          const failedAt = failed.get(f.uri)
          if (failedAt != null && failedAt === cur.mtime) continue
          await importOne(f, st)
        }
      }
      await saveState()
    } catch (err) {
      reportError(`自动入库：${(err && err.message) || err}（可到设置 → 资料库 重新选择文件夹）`)
    }
  }

  return { init, scan }
}
