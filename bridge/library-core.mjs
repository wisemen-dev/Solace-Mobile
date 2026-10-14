// 桌面端 src/main/library.js（v0.15.3）的异步移植版。
// 数据格式与桌面端完全一致：library.json / files/<id>.pdf / covers/<id>.jpg /
// textindex/{index.json, <id>.json}，整个 SolaceLibrary 目录可在桌面与平板
// 之间互相搬运续用（SHA-256 与 UUID 两端同值，去重与关联不破）。
//
// 与桌面版的差异（详见 docs/PORTING.md）：
// - 全部 API 异步化：WebView 没有同步文件 IO
// - importFile 接收 { fileName, size, bytes }：Android 文件选择器给的是
//   内容而非路径，originalPath 因此恒为 null
// - 无资料库 relocate / 指针文件：位置固定在应用专属外部目录
// - 删除笔记没有系统回收站：keepNotes（改名保留）语义保留，否则永久删除
//
// 逻辑经过逐段对照移植（原子写、损坏恢复跳过清扫、内容去重回填、导入
// 串行化、孤儿清理只认严格 UUID、索引分片缓存淘汰、设置白名单），
// 修改这里请同步对照桌面版，保持两端行为一致。

import { bytesToBase64, base64ToBytes } from './base64.mjs'
import { createSerialQueue } from './serial-queue.mjs'
import { isNotFoundError } from './file-errors.mjs'
// 双端共享纯函数（桌面 src/main/library-shared.cjs 经 sync-www 搬运至此；
// 纪律见文件头。Node ESM import CJS 走默认导出 interop，esbuild 同样支持）
import shared from './library-shared.cjs'

export function createLibrary ({ fs, sha256, randomUUID, hashStorageFile, now = () => new Date() }) {
  let data = null
  let committedData = null // 渲染层只读已提交状态，不暴露在途导入/删除
  let startupNotice = null
  let textIndexMeta = { version: 1, entries: {} }
  let legacyMigration = null // 旧索引搬迁的 in-flight promise（并发调用等同一轮完成）

  // 原子写只保护文件完整性；整个「改内存 → 写库 → 失败回滚」也必须串行。
  // 所有资料库变更共用此队列，避免设置/进度把失败导入的中间态写回磁盘。
  const mutationQ = createSerialQueue()
  function mutate (fn) {
    return mutationQ.run(async () => {
      const before = structuredClone(data)
      const beforeMeta = structuredClone(textIndexMeta)
      try {
        const result = await fn()
        committedData = structuredClone(data)
        return structuredClone(result)
      } catch (err) {
        // 去重回填等步骤可能已经成功提交；失败只回退到最近一次落库状态。
        data = structuredClone(committedData || before)
        textIndexMeta = beforeMeta
        shardCache.clear()
        shardCacheChars = 0
        throw err
      }
    })
  }
  const mutator = fn => (...args) => mutate(() => fn(...args))

  /* ---- 启动与加载 ---- */

  // 损坏备份名：重名顺延编号（与桌面端 library.js 同规则），第二次损坏
  // 不覆盖上一份可抢救的副本
  async function nextCorruptName (p) {
    let backup = `${p}.corrupt`
    let suffix = 1
    while (await fs.exists(backup)) backup = `${p}.corrupt.${suffix++}`
    return backup
  }

  async function init () {
    startupNotice = null
    try {
      await loadRoot()
    } catch (err) {
      // 只有库文件确实损坏才走恢复重建；磁盘满/读取失败等瞬时错误照抛，
      // 由启动错误页兜底——绝不能把完好的 library.json 改名重建
      if (err.code !== 'LIBRARY_CORRUPT') throw err
      // 坏库不能把应用挡在门外：改名留档供抢救，原地重建空库；本次跳过
      // 孤儿清扫——库已空，清扫会把 files/ 下的 PDF 副本全删掉，而它们
      // 可能是用户唯一的副本（与桌面端同一取舍）
      const backup = await nextCorruptName('library.json')
      try { await fs.rename('library.json', backup) } catch { /* 改不了名则本次启动仍会失败 */ }
      // textindex/ 一律原地不动：docId 没变，从备份里抢救回条目后索引还能直接复用
      startupNotice = `资料库数据文件损坏，已新建空资料库。\n原文件保留为资料库内 ${backup}，库内 PDF 副本与全文索引未删除，可手动取回或重新导入。`
      await loadRoot({ sweep: false })
    }
    committedData = structuredClone(data)
  }

  async function loadRoot (opts = {}) {
    await fs.mkdirp('files')
    await fs.mkdirp('covers')
    await fs.mkdirp('textindex')
    if (await fs.exists('library.json')) {
      // 读取失败是瞬时错误（磁盘/权限），不标损坏；只有解析/校验失败才是坏库
      const raw = await fs.readFileText('library.json')
      try {
        data = JSON.parse(raw)
        assertLibraryShape()
      } catch (err) {
        err.code = 'LIBRARY_CORRUPT'
        throw err
      }
    } else {
      data = {
        version: 1,
        createdAt: now().toISOString(),
        categories: [], // { id, name, parentId: null }，parentId 构成分类树
        tags: [],       // { id, name }
        documents: [],  // 见 importFile()
        history: [],    // 打开事件 { docId, at, type }
        smartShelves: [], // { id, name, filters }
        settings: { theme: 'auto', viewMode: 'grid' }
      }
      await save()
    }
    // 逐版本新增字段，缺了补默认值（旧库平滑升级）
    if (!Array.isArray(data.history)) data.history = []
    if (!Array.isArray(data.smartShelves)) data.smartShelves = []
    if (!data.settings) data.settings = { theme: 'auto', viewMode: 'grid' }
    normalizeDocuments()
    normalizeOpenDays()
    shardCache.clear()
    shardCacheChars = 0
    legacyMigration = null
    textIndexMeta = await readTextIndexMeta()
    if (opts.sweep !== false) await pruneTextIndexMeta()
    if (opts.sweep !== false) await sweepOrphans()
  }

  // 渲染层拿到的是深拷贝：桌面端经 IPC 结构化克隆，直接传引用会让渲染层
  // 的就地修改绕过 save() 落库（updateDoc 之外的脏写）
  function getData () {
    return structuredClone(committedData || data)
  }

  function getStartupNotice () {
    return startupNotice
  }

  // 文档标识形状校验：与桌面 library-paths.assertDocumentId 同义。库内文档
  // 一律以 UUID 命名（files/<id>.pdf、covers/<id>.jpg、notes/<id>/），id 非法
  // 会让孤儿清扫失去比对基准——只认 UUID 形状的文件会被全数误删
  const DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  function assertDocumentId (id) {
    if (typeof id !== 'string' || !DOC_ID_RE.test(id)) throw new Error('非法文档标识')
    return id
  }

  // 结构校验：合法 JSON 不代表是本应用的库。缺核心集合或文档条目 id 非法/
  // 重复时抛错走「损坏恢复」路径，绝不能顺成空库继续跑——紧接着的孤儿清扫
  // 会把 files/ 下的 PDF 副本全判为孤儿永久删掉（不可逆）。逐条 id 校验是
  // 桌面端 assertLibraryShape 的同款防线
  function assertLibraryShape (obj = data) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('不是对象')
    for (const key of ['documents', 'categories', 'tags']) {
      if (!Array.isArray(obj[key])) throw new Error(`缺少 ${key} 集合`)
    }
    const ids = new Set()
    for (const doc of obj.documents) {
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('非法文档条目')
      const id = assertDocumentId(doc.id).toLowerCase()
      if (ids.has(id)) throw new Error('文档标识重复')
      ids.add(id)
    }
  }

  // 临时文件 + 原子重命名：写入中断也不会留下半个坏文件
  async function save () {
    await fs.writeFileAtomicText('library.json', JSON.stringify(data, null, 2))
    committedData = structuredClone(data)
  }

  const stemOf = (name) => String(name || '').replace(/\.[^.\\/]+$/, '')

  // 文档字段归一化：只补不覆盖（桌面端同注释）
  function normalizeDocuments () {
    for (const d of data.documents) {
      if (!Array.isArray(d.tagIds)) d.tagIds = []
      if (d.categoryId === undefined) d.categoryId = null
      if (!Number.isFinite(d.openCount)) d.openCount = 0
      if (typeof d.title !== 'string' || !d.title) d.title = stemOf(d.fileName) || '未命名文档'
    }
  }

  function findDoc (id) {
    const doc = data.documents.find(d => d.id === id)
    if (!doc) throw new Error(`文档不存在: ${id}`)
    return doc
  }

  /* ---- 导入（内容去重 + 串行化） ---- */

  // 内容级去重：字节相同的 PDF 不重复入库。新条目带 hash 直接比对；
  // 旧库条目（桌面端 0.9.x 之前导入的）没有 hash，只对同大小的文件现算
  // 一次并回填（并落盘），之后走 hash 快路径——与桌面端 findDuplicate
  // 同逻辑，名字带上 Backfill 以明示「会写盘」。
  // 回填哈希优先用注入的原生流式实现（hashStorageFile）；未注入时回落
  // base64 过桥 + JS 计算（Node 单测路径，真机不走这条）
  async function findDuplicateAndBackfill (hash, size) {
    let backfilled = false
    let dup = null
    for (const d of data.documents) {
      if (d.hash) {
        if (d.hash === hash) { dup = d; break }
        continue
      }
      if (d.size !== size) continue
      try {
        if (hashStorageFile) {
          d.hash = (await hashStorageFile(`files/${d.id}.pdf`)).hash
        } else {
          d.hash = await sha256(base64ToBytes(await fs.readFileB64(`files/${d.id}.pdf`)))
        }
        backfilled = true
        if (d.hash === hash) dup = d
      } catch { /* 副本丢失的旧条目跳过 */ }
      if (dup) break
    }
    if (backfilled) await save()
    return dup
  }

  // 导入串行化：查重 → 复制 → 写数据中间有多个 await，本身不原子；用一条
  // promise 链排队，队列内不并发（与桌面端 importChain 同法）
  // 导入统一内核：meta（fileName/size/hash）+ performCopy(destRelPath)。
  // 哈希与复制的实现由调用方注入——平板真机传原生流式实现（文件内容
  // 不过 JS 桥，主线程零参与）；Node 单测与 WebView 文件选择兜底传 JS 实现
  // （读 bytes → subtle 哈希 → base64 写盘）。语义与桌面端逐条对齐
  function importWith (meta, performCopy) {
    return mutate(() => importWithLocked(meta, performCopy))
  }

  async function importWithLocked (meta, performCopy) {
    const name = String(meta.fileName || '')
    if (!name.toLowerCase().endsWith('.pdf')) throw new Error('仅支持 PDF 文件')
    const size = Math.floor(Number(meta.size))
    const hash = String(meta.hash || '')
    if (!Number.isFinite(size) || size < 0) throw new Error('无效的文件大小')
    if (!hash) throw new Error('缺少内容哈希')
    const dup = await findDuplicateAndBackfill(hash, size)
    if (dup) {
      const err = new Error(`与已入库的《${dup.title}》内容相同`)
      err.duplicate = { title: dup.title, docId: dup.id }
      throw err
    }
    const id = randomUUID()
    const target = `files/${id}.pdf`
    let committed = false
    try {
      await performCopy(target)
      const doc = {
        id,
        title: stemOf(name),
        fileName: name,
        originalPath: null, // 平板端拿不到来源路径；字段保留，两端数据形状一致
        size,
        hash,
        addedAt: now().toISOString(),
        openedAt: null,
        openCount: 0,
        categoryId: null,
        tagIds: []
      }
      data.documents.push(doc)
      try {
        await save()
      } catch (err) {
        // 落库失败：撤条目并清掉刚写的副本，别让「文件在、册上无」的半截
        // 状态留给下次启动的孤儿清扫连坐（与桌面 importPdfLocked 同法）
        data.documents = data.documents.filter(d => d !== doc)
        throw err
      }
      committed = true
      return doc
    } finally {
      if (!committed) await fs.rm(target)
    }
  }

  // JS 兜底导入（WebView 文件选择器返回 File 对象时；单测也走这里）。
  // 哈希在链外算（subtle 是原生实现，实测 10MB≈29ms，不构成瓶颈），
  // 复制仍走 base64 写盘——慢路径仅兜底用
  function importFile (file) {
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes)
    // 空内容拒绝（全量审查 P2-3）：bytes 缺失时 new Uint8Array(undefined)
    // 得空数组，原先 0 字节照常入库——产出打不开的空书条目
    if (!bytes || !bytes.length) return Promise.reject(new Error('文件内容为空或读取失败，未导入'))
    const name = String(file.fileName || '')
    if (!name.toLowerCase().endsWith('.pdf')) {
      return Promise.reject(new Error('仅支持 PDF 文件'))
    }
    return (async () => {
      const size = Number.isFinite(file.size) ? file.size : bytes.length
      const hash = await sha256(bytes)
      return importWith({ fileName: name, size, hash }, async (dest) => {
        await fs.writeB64(dest, bytesToBase64(bytes))
      })
    })()
  }

  // 暂存式导入（真机主路径）：复制与哈希由 performCopyAndHash(stagingPath)
  // 一次完成（内容同源），写入 files/.incoming-<id>.pdf 暂存；查重通过后
  // 原子改名为正式副本。与「先哈希后复制」相比，登记的 hash 与副本内容
  // 严格一致，不存在两步之间文件仍在被写入的竞态。查重不通过时删除暂存
  function importVia (meta, performCopyAndHash) {
    return mutate(() => importViaLocked(meta, performCopyAndHash))
  }

  async function importViaLocked (meta, performCopyAndHash) {
    const name = String(meta.fileName || '')
    if (!name.toLowerCase().endsWith('.pdf')) throw new Error('仅支持 PDF 文件')
    const id = randomUUID()
    const staging = `files/.incoming-${id}.pdf`
    const target = `files/${id}.pdf`
    let committed = false
    try {
      let info
      try {
        info = await performCopyAndHash(staging)
      } catch (err) {
        await fs.rm(staging) // 原生失败已自清，这里兜底实现未清的情况
        throw err
      }
      const size = Math.floor(Number(info.size))
      const hash = String(info.hash || '')
      if (!Number.isFinite(size) || size < 0 || !hash) throw new Error('导入结果不完整')
      const dup = await findDuplicateAndBackfill(hash, size)
      if (dup) {
        const err = new Error(`与已入库的《${dup.title}》内容相同`)
        err.duplicate = { title: dup.title, docId: dup.id }
        throw err
      }
      await fs.rename(staging, target)
      const doc = {
        id,
        title: stemOf(name),
        fileName: name,
        originalPath: null,
        size,
        hash,
        addedAt: now().toISOString(),
        openedAt: null,
        openCount: 0,
        categoryId: null,
        tagIds: []
      }
      data.documents.push(doc)
      try {
        await save()
      } catch (err) {
        data.documents = data.documents.filter(d => d !== doc)
        throw err
      }
      committed = true
      return doc
    } finally {
      // 未走到落库成功：暂存与正式副本都不留（失败/查重/落库失败全覆盖）
      if (!committed) {
        await fs.rm(staging)
        await fs.rm(target)
      }
    }
  }

  /* ---- 文档：编辑 / 删除 / 进度 ---- */

  // patch 只允许改 title/categoryId/tagIds，写入侧做形状收敛（同桌面端）
  async function updateDoc (id, patch) {
    const doc = findDoc(id)
    if ('title' in patch) {
      const t = String(patch.title == null ? '' : patch.title).trim()
      doc.title = t || stemOf(doc.fileName) || '未命名文档'
    }
    if ('categoryId' in patch) {
      doc.categoryId = patch.categoryId == null ? null : String(patch.categoryId)
    }
    if ('tagIds' in patch) {
      doc.tagIds = Array.isArray(patch.tagIds) ? patch.tagIds.map(String) : doc.tagIds
    }
    await save()
    return structuredClone(doc)
  }

  // 删除文档：先提交逻辑删除（失败由变更队列回滚），库内文件尽力而为；
  // 删不掉的列入 leftovers 由下次启动的孤儿清理补删（同桌面端）。
  // keepNotes：把 notes/<id>/ 改名为「已删书-书名-时间」保留
  async function removeDoc (id, opts = {}) {
    const doc = findDoc(id)
    data.documents = data.documents.filter(d => d.id !== id)
    await save() // 唯一提交点；成功之后缓存/文件清理失败不再谎报删除失败
    const leftovers = []
    if (textIndexMeta.entries[id]) {
      delete textIndexMeta.entries[id]
      try { await saveTextIndexMeta() } catch { leftovers.push('textindex/index.json') }
      dropShardCache(id)
    }
    const base = (p) => p.split('/').pop()
    for (const p of [`files/${doc.id}.pdf`, `covers/${doc.id}.jpg`, `textindex/${doc.id}.json`, `annotations/${doc.id}.json`, `links/${doc.id}.json`]) {
      if (!await fs.rm(p)) leftovers.push(base(p))
    }
    let notesKeptTo = null
    let notesPurged = false
    const notesDir = `notes/${doc.id}`
    let hasNotes = false
    try { hasNotes = await fs.exists(notesDir) } catch { leftovers.push(base(notesDir)) }
    if (opts.keepNotes && hasNotes) {
      // Android 目录名约束与 Windows 类似（\ / : * ? " < > | 及结尾点空格）
      const safe = String(doc.title || '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim().slice(0, 40)
        .replace(/[\s.]+$/, '').trim() || '未命名'
      const p = n => String(n).padStart(2, '0')
      const t = now()
      const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
      let dest = `notes/已删书-${safe}-${stamp}`
      let n = 2
      try {
        while (await fs.exists(dest)) dest = `notes/已删书-${safe}-${stamp} (${n++})`
        await fs.rename(notesDir, dest)
        notesKeptTo = base(dest)
      } catch {
        // 改名失败（目录被占用）就原样保留，宁可留在 UUID 目录里也不丢笔记
        leftovers.push(base(notesDir))
      }
    } else if (hasNotes) {
      // 平板端没有系统回收站：永久删除并如实标注
      if (await fs.rm(notesDir, { recursive: true })) notesPurged = true
      else leftovers.push(base(notesDir))
    }
    return { title: doc.title, leftovers, notesKeptTo, notesPurged }
  }

  async function readFileBuffer (id) {
    findDoc(id)
    try {
      return base64ToBytes(await fs.readFileB64(`files/${findDoc(id).id}.pdf`))
    } catch (err) {
      // 只有「文件不存在」才判副本丢失（被手动清理等）；I/O、权限、base64
      // 损坏等故障原样上抛——此前 catch-all 把瞬时磁盘故障也报成
      // 「请删除重导」，诱导用户删书（全量审查 P2-1）
      if (isNotFoundError(err)) {
        throw new Error('库内 PDF 副本已丢失，请删除这本书后重新导入（原文件不受影响）')
      }
      throw err
    }
  }

  /* ---- 阅读足迹（按天立账） ---- */

  async function markOpened (id, type = 'open') {
    const doc = findDoc(id)
    doc.openedAt = now().toISOString()
    doc.openCount += 1
    data.history.push({ docId: id, at: doc.openedAt, type })
    if (data.history.length > 200) data.history = data.history.slice(-200)
    countOpenDay(doc.openedAt)
    await save()
  }

  /* ---- 阅读足迹：dayKey 族已上移共享层（library-shared.cjs，双端同源） ---- */
  const dayKey = shared.dayKey

  function countOpenDay (at) {
    shared.countOpenDay(at, data)
  }

  function getOpenStats () {
    return shared.getOpenStats((committedData || data).openDays, now())
  }

  function normalizeOpenDays () {
    if (data.openDays && typeof data.openDays === 'object') return
    data.openDays = {}
    for (const h of data.history) {
      if (!h || !h.at) continue
      const d = new Date(h.at)
      if (Number.isNaN(d.getTime())) continue
      const k = dayKey(d)
      data.openDays[k] = (data.openDays[k] || 0) + 1
    }
  }

  async function setProgress (id, page, totalPages) {
    const doc = findDoc(id)
    page = Math.floor(Number(page))
    totalPages = Math.floor(Number(totalPages))
    if (!(page >= 1) || !(totalPages >= 1)) return structuredClone(doc)
    doc.progress = { page: Math.min(page, totalPages), totalPages, at: now().toISOString() }
    await save()
    return structuredClone(doc)
  }

  /* ---- 封面 ---- */

  async function setCover (id, dataUrl) {
    findDoc(id)
    const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ''))
    if (!m) throw new Error('无效的封面数据')
    await fs.writeFileAtomicB64(`covers/${id}.jpg`, m[2])
    findDoc(id).hasCover = true
    await save()
    return true
  }

  async function getCoverDataUrl (id) {
    findDoc(id)
    if (!await fs.exists(`covers/${id}.jpg`)) return null
    return `data:image/jpeg;base64,${await fs.readFileB64(`covers/${id}.jpg`)}`
  }

  /* ---- 全文索引（分片 + 缓存，同桌面端 v0.15.3 结构） ---- */

  // 搜索关键词归一化：必须与渲染层 util.js 的 normText 一致（兜底）。
  // 数据层版已上移共享层
  const normalizeKeyword = shared.normalizeKeyword

  const shardCache = new Map()
  let shardCacheChars = 0
  // WebView 内存预算比桌面主进程紧，缓存上限减半
  const SHARD_CACHE_MAX_CHARS = 32 * 1024 * 1024

  function cacheShard (id, pages) {
    let chars = 0
    for (const p of pages) chars += p.length
    if (chars > SHARD_CACHE_MAX_CHARS) return
    const old = shardCache.get(id)
    if (old) {
      shardCache.delete(id)
      shardCacheChars -= old.chars
    }
    shardCache.set(id, { pages, chars })
    shardCacheChars += chars
    for (const [key, val] of shardCache) {
      if (shardCacheChars <= SHARD_CACHE_MAX_CHARS) break
      if (key === id) continue
      shardCache.delete(key)
      shardCacheChars -= val.chars
    }
  }

  function dropShardCache (id) {
    const old = shardCache.get(id)
    if (!old) return
    shardCache.delete(id)
    shardCacheChars -= old.chars
  }

  async function writeShard (id, entry) {
    await fs.writeFileAtomicText(`textindex/${id}.json`, JSON.stringify({
      pages: Array.isArray(entry.pages) ? entry.pages.map(String) : [],
      failed: !!entry.failed,
      ver: Number(entry.ver) || undefined,
      at: entry.at || now().toISOString()
    }))
  }

  async function readTextIndexMeta () {
    let raw
    try {
      raw = await fs.readFileText('textindex/index.json')
    } catch (err) {
      // 缺失 = 尚无索引，返回空表；其他 I/O 故障照抛（init 走启动错误页）——
      // 吞成空表会让下一次 saveTextIndexMeta 用空表覆盖掉全部索引元数据
      if (isNotFoundError(err)) return { version: 1, entries: {} }
      throw err
    }
    try {
      const obj = JSON.parse(raw)
      if (obj && obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries)) {
        return { version: 1, entries: obj.entries }
      }
    } catch { /* 按损坏处理 */ }
    // meta 损坏不值得挡门：索引退回「无」，渲染层按需重建。备份用顺延
    // 编号（全量审查 P3：与 nextCorruptName 同策略，二次损坏不覆盖上一份）
    try { await fs.rename('textindex/index.json', await nextCorruptName('textindex/index.json')) } catch { /* 继续 */ }
    return { version: 1, entries: {} }
  }

  async function saveTextIndexMeta () {
    await fs.writeFileAtomicText('textindex/index.json', JSON.stringify(textIndexMeta))
  }

  async function pruneTextIndexMeta () {
    const ids = new Set(data.documents.map(d => d.id))
    let changed = false
    for (const id of Object.keys(textIndexMeta.entries)) {
      if (!ids.has(id)) {
        delete textIndexMeta.entries[id]
        dropShardCache(id)
        changed = true
      }
    }
    // 分片文件本身不主动删：孤儿分片是惰性的，误删不可逆（同桌面端取舍）
    if (changed) await saveTextIndexMeta()
  }

  // 0.15.x 桌面端的单文件索引 → 分片，一次性搬迁（推库过来的旧桌面库兼容）。
  // 共享 in-flight promise：并发调用者等同一轮完成，不会读到半成品；
  // 失败不缓存——一次瞬时 stat 故障若把 rejected promise 永久留在缓存里，
  // 索引功能会整会话瘫痪
  function migrateLegacyTextIndex () {
    if (!legacyMigration) {
      legacyMigration = migrateLegacyTextIndexNow().catch(err => {
        legacyMigration = null // 允许下次调用重试
        throw err
      })
    }
    return legacyMigration
  }

  async function migrateLegacyTextIndexNow () {
    if (!await fs.exists('textindex.json')) return
    try {
      const old = JSON.parse(await fs.readFileText('textindex.json'))
      for (const [id, e] of Object.entries(old || {})) {
        try { assertDocumentId(id) } catch { continue } // 非法键跳过（与桌面端同款防御）
        if (!e || !Array.isArray(e.pages)) continue
        await writeShard(id, e)
        textIndexMeta.entries[id] = { ver: Number(e.ver) || undefined, failed: !!e.failed, at: e.at }
      }
      await saveTextIndexMeta()
      await fs.rename('textindex.json', 'textindex.json.migrated')
    } catch {
      try { await fs.rename('textindex.json', 'textindex.json.corrupt') } catch { /* 下次再试 */ }
    }
  }

  async function getTextIndexStatus () {
    await migrateLegacyTextIndex()
    const out = {}
    for (const [id, e] of Object.entries(textIndexMeta.entries)) {
      out[id] = { ver: e.ver, failed: !!e.failed }
    }
    return out
  }

  async function readShardPages (id) {
    const cached = shardCache.get(id)
    if (cached) return cached.pages
    let raw
    try {
      raw = await fs.readFileText(`textindex/${id}.json`)
    } catch (err) {
      // 缺失 = 分片真丢了，返回 null 由调用方删 meta 自愈重建；
      // I/O 故障必须上抛——返回 null 会被当成「分片损坏」删掉条目
      if (isNotFoundError(err)) return null
      throw err
    }
    let obj
    try { obj = JSON.parse(raw) } catch { return null }
    if (!obj || !Array.isArray(obj.pages)) return null
    cacheShard(id, obj.pages)
    return obj.pages
  }

  // 只回传 { docId: 首个命中页码 }；逐本 await + 周期让出，不长时间霸住
  // WebView 主线程（搜索期间界面仍可响应输入）
  async function searchTextIndex (kw) {
    const needle = normalizeKeyword(kw)
    if (!needle) return {}
    // 一次性旧格式迁移须串行（内部有写）；走队列 await 缓存 promise
    await mutate(() => migrateLegacyTextIndex())
    const live = new Set(data.documents.map(d => d.id))
    const hits = {}
    // 本函数已出 mutation 队列裸跑（全量审查 P2-2）：大库逐分片读期间，
    // 翻页进度落盘等短写不再排队等搜索整段跑完（窗口内杀进程会丢进度）。
    // 自愈路径（分片丢失清 meta 落盘）因此不能在循环内直接写——收集
    // 后回队执行，文件层安全由 per-path 写串行兜底
    const stale = []
    const ids = Object.keys(textIndexMeta.entries).filter(id => live.has(id) && !textIndexMeta.entries[id].failed)
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      let pages
      try {
        pages = await readShardPages(id)
      } catch {
        continue // 读故障：跳过本书，不动 meta（故障不该当损坏删条目）
      }
      if (pages) {
        for (let n = 0; n < pages.length; n++) {
          if (pages[n].includes(needle)) { hits[id] = n + 1; break }
        }
      } else {
        // 分片丢失/损坏：清掉 meta 让渲染层重新提取，索引自愈
        stale.push(id)
      }
      if ((i & 15) === 15) await new Promise(r => setTimeout(r, 0))
    }
    if (stale.length) {
      mutate(() => {
        for (const id of stale) delete textIndexMeta.entries[id]
        return saveTextIndexMeta()
      }).catch(() => { /* 自愈失败：下次搜索再试（meta 未提交会回滚） */ })
    }
    return hits
  }

  async function setTextIndex (id, payload) {
    findDoc(id)
    await migrateLegacyTextIndex()
    const entry = {
      pages: Array.isArray(payload && payload.pages) ? payload.pages.map(String) : [],
      failed: !!(payload && payload.failed),
      ver: Number(payload && payload.ver) || undefined,
      at: now().toISOString()
    }
    await writeShard(id, entry)
    textIndexMeta.entries[id] = { ver: entry.ver, failed: entry.failed, at: entry.at }
    await saveTextIndexMeta()
    dropShardCache(id) // 重建后的正文与缓存不同，失效掉
    return true
  }

  /* ---- 孤儿清理 ---- */

  // 库内文件一律以「UUID + 固定扩展名」命名；清扫只认这个形状，其它文件
  // 一律不动（用户自己放进 files/ 的 rust-book.pdf 不是孤儿）。
  // 无主副本只清不在册的；库为空时一律不清（同桌面端的不可逆风险取舍）
  // 清扫正则上移共享层（口径与桌面端永远一致——清扫误删是最高危操作）
  const APP_FILE_RE = shared.APP_FILE_RE
  const APP_TMP_RE = shared.APP_TMP_RE
  // importVia 的暂存副本（带点前缀，用户文件不可能撞上该命名）：崩溃残留，
  // 与 *.tmp 一样永远可清。平板专有，不入共享层
  const APP_STAGING_RE = /^\.incoming-[0-9a-f-]{36}\.pdf$/i

  async function sweepOrphans () {
    await fs.rm('library.json.tmp')
    await fs.rm('textindex/index.json.tmp')
    // 崩溃残留清扫补全（全量审查 P3）：侧车与封面的 tmp 同样可能残留——
    // covers/<id>.jpg.tmp（封面写）、annotations/links 的 .json.tmp、
    // notes 的 .md.tmp（各自写队列的原子写中间态）。逐目录枚举 + 严格
    // 后缀匹配，绝不动正常数据
    for (const [dir, test] of [
      ['covers', n => n.endsWith('.jpg.tmp')],
      ['annotations', n => n.endsWith('.json.tmp')],
      ['links', n => n.endsWith('.json.tmp')],
      ['notes', n => n.endsWith('.md.tmp')]
    ]) {
      let entries
      try { entries = await fs.readdir(dir) } catch { continue }
      for (const e of entries) {
        if (test(e.name)) await fs.rm(`${dir}/${e.name}`)
      }
    }
    let staged = []
    try { staged = await fs.readdir('files') } catch { /* 目录尚未建立 */ }
    for (const e of staged) {
      if (APP_STAGING_RE.test(e.name)) await fs.rm(`files/${e.name}`)
    }
    let shards = []
    try { shards = await fs.readdir('textindex') } catch { /* 目录尚未建立 */ }
    for (const e of shards) {
      if (APP_TMP_RE.test(e.name)) await fs.rm(`textindex/${e.name}`)
    }
    if (!data.documents.length) return
    // 两侧统一小写比较（模式串带 /i，捕获名是原样大小写；与桌面端同规则）
    const ids = new Set(data.documents.map(d => d.id.toLowerCase()))
    for (const sub of ['files', 'covers']) {
      let entries
      try { entries = await fs.readdir(sub) } catch { continue }
      for (const e of entries) {
        const m = APP_FILE_RE.exec(e.name)
        if (!m || ids.has(m[1].toLowerCase())) continue
        await fs.rm(`${sub}/${e.name}`)
      }
    }
  }

  /* ---- 分类 / 标签 / 收藏夹 / 设置（与桌面端逐条对齐） ---- */

  async function addCategory (name, parentId = null) {
    const trimmed = String(name || '').trim()
    if (!trimmed) throw new Error('分类名不能为空')
    if (parentId != null && !data.categories.some(c => c.id === parentId)) throw new Error('父分类不存在')
    if (data.categories.some(c => c.name === trimmed)) throw new Error(`分类已存在: ${trimmed}`)
    const cat = { id: randomUUID(), name: trimmed, parentId: parentId || null }
    data.categories.push(cat)
    await save()
    return cat
  }

  // 拖拽/换父：禁止移到自己子孙下面成环。校验段上移共享层
  // （assertMoveCategory，双端同源——环可由互传/手改带入）
  async function moveCategory (id, parentId) {
    const { cat, target } = shared.assertMoveCategory(data.categories, id, parentId)
    if (cat.parentId === target) return cat
    cat.parentId = target
    await save()
    return cat
  }

  async function renameCategory (id, name) {
    const cat = data.categories.find(c => c.id === id)
    if (!cat) throw new Error(`分类不存在: ${id}`)
    const trimmed = String(name || '').trim()
    if (!trimmed) throw new Error('分类名不能为空')
    if (data.categories.some(c => c.id !== id && c.name === trimmed)) throw new Error(`分类已存在: ${trimmed}`)
    cat.name = trimmed
    await save()
    return cat
  }

  async function removeCategory (id) {
    const cat = data.categories.find(c => c.id === id)
    if (!cat) throw new Error(`分类不存在: ${id}`)
    // 子分类与直属文档上移到被删分类的父级，组织结构不散架
    const parentId = cat.parentId || null
    data.categories.forEach(c => { if (c.parentId === id) c.parentId = parentId })
    data.documents.forEach(d => { if (d.categoryId === id) d.categoryId = parentId })
    for (const s of data.smartShelves || []) {
      if (s.filters && s.filters.categoryId === id) s.filters.categoryId = parentId
    }
    data.categories = data.categories.filter(c => c.id !== id)
    await save()
    return true
  }

  async function addTag (name) {
    const trimmed = String(name || '').trim()
    if (!trimmed) throw new Error('标签名不能为空')
    const existed = data.tags.find(t => t.name === trimmed)
    if (existed) return existed
    const tag = { id: randomUUID(), name: trimmed }
    data.tags.push(tag)
    await save()
    return tag
  }

  async function removeTag (id) {
    data.documents.forEach(d => { if (Array.isArray(d.tagIds)) d.tagIds = d.tagIds.filter(t => t !== id) })
    data.tags = data.tags.filter(t => t.id !== id)
    for (const s of data.smartShelves || []) {
      if (s.filters && s.filters.tagId === id) delete s.filters.tagId
    }
    await save()
    return true
  }

  async function addSmartShelf (name, filters) {
    const trimmed = String(name || '').trim()
    if (!trimmed) throw new Error('收藏夹名称不能为空')
    if (data.smartShelves.some(s => s.name === trimmed)) throw new Error(`收藏夹已存在: ${trimmed}`)
    const clean = {}
    if (filters && filters.categoryId !== undefined) clean.categoryId = filters.categoryId
    if (filters && filters.tagId) clean.tagId = filters.tagId
    if (filters && filters.keyword) clean.keyword = filters.keyword
    if (!Object.keys(clean).length) throw new Error('当前没有可保存的筛选条件')
    const shelf = { id: randomUUID(), name: trimmed, filters: clean }
    data.smartShelves.push(shelf)
    await save()
    return shelf
  }

  async function renameSmartShelf (id, name) {
    const shelf = data.smartShelves.find(s => s.id === id)
    if (!shelf) throw new Error(`收藏夹不存在: ${id}`)
    const trimmed = String(name || '').trim()
    if (!trimmed) throw new Error('收藏夹名称不能为空')
    if (data.smartShelves.some(s => s.id !== id && s.name === trimmed)) throw new Error(`收藏夹已存在: ${trimmed}`)
    shelf.name = trimmed
    await save()
    return shelf
  }

  async function removeSmartShelf (id) {
    data.smartShelves = data.smartShelves.filter(s => s.id !== id)
    await save()
    return true
  }

  // 设置白名单：键集合与归一规则上移共享层（两端并集——库互搬时设置不丢）
  async function updateSettings (patch) {
    // settings 被污染成原始类型时（互传/手改 library.json），严格模式下
    // `data.settings[key]=` 抛 TypeError、设置功能全瘫（全量审查 P3）——
    // 就地自愈为空对象，本次 patch 正常落；changed 判定省掉无谓写盘
    if (typeof data.settings !== 'object' || data.settings === null || Array.isArray(data.settings)) data.settings = {}
    const changed = shared.applySettingsPatch(data.settings, patch || {})
    if (changed) await save()
    return structuredClone(data.settings)
  }

  return {
    init,
    getData,
    getStartupNotice,
    importFile,
    importWith,
    importVia,
    updateDoc: mutator(updateDoc),
    removeDoc: mutator(removeDoc),
    readFileBuffer,
    markOpened: mutator(markOpened),
    getOpenStats,
    setProgress: mutator(setProgress),
    setCover: mutator(setCover),
    getCoverDataUrl,
    getTextIndexStatus: mutator(getTextIndexStatus),
    setTextIndex: mutator(setTextIndex),
    searchTextIndex,
    addCategory: mutator(addCategory),
    renameCategory: mutator(renameCategory),
    moveCategory: mutator(moveCategory),
    removeCategory: mutator(removeCategory),
    addTag: mutator(addTag),
    removeTag: mutator(removeTag),
    addSmartShelf: mutator(addSmartShelf),
    renameSmartShelf: mutator(renameSmartShelf),
    removeSmartShelf: mutator(removeSmartShelf),
    updateSettings: mutator(updateSettings)
  }
}
