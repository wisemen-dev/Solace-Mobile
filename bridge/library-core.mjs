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

export function createLibrary ({ fs, sha256, randomUUID, now = () => new Date() }) {
  let data = null
  let startupNotice = null
  let textIndexMeta = { version: 1, entries: {} }
  let legacyMigrationDone = false

  /* ---- 启动与加载 ---- */

  async function init () {
    startupNotice = null
    try {
      await loadRoot()
    } catch (err) {
      // 默认库损坏（library.json 解析失败/结构缺失）：不能把应用挡在门外。
      // 坏文件改名留档为 .corrupt 供抢救，原地重建空库；本次跳过孤儿清扫
      // ——库已空，清扫会把 files/ 下的 PDF 副本全删掉，而它们可能是用户
      // 唯一的副本（与桌面端同一取舍）
      try { await fs.rename('library.json', 'library.json.corrupt') } catch { /* 改不了名则本次启动仍会失败 */ }
      // textindex/ 一律原地不动：docId 没变，从 library.json.corrupt 里抢救回
      // 条目后索引还能直接复用
      startupNotice = '资料库数据文件损坏，已新建空资料库。\n原文件保留为资料库内 library.json.corrupt，库内 PDF 副本与全文索引未删除，可手动取回或重新导入。'
      await loadRoot({ sweep: false })
    }
  }

  async function loadRoot (opts = {}) {
    await fs.mkdirp('files')
    await fs.mkdirp('covers')
    await fs.mkdirp('textindex')
    if (await fs.exists('library.json')) {
      data = JSON.parse(await fs.readFileText('library.json'))
      assertLibraryShape()
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
    legacyMigrationDone = false
    textIndexMeta = await readTextIndexMeta()
    if (opts.sweep !== false) await pruneTextIndexMeta()
    if (opts.sweep !== false) await sweepOrphans()
  }

  // 渲染层拿到的是深拷贝：桌面端经 IPC 结构化克隆，直接传引用会让渲染层
  // 的就地修改绕过 save() 落库（updateDoc 之外的脏写）
  function getData () {
    return structuredClone(data)
  }

  function getStartupNotice () {
    return startupNotice
  }

  // 结构校验：合法 JSON 不代表是本应用的库。缺核心集合时抛错走「损坏恢复」
  // 路径，绝不能顺成空库继续跑——紧接着的孤儿清扫会把 files/ 下的 PDF 副本
  // 全判为孤儿永久删掉（不可逆），与桌面端 assertLibraryShape 同一防御
  function assertLibraryShape (obj = data) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('不是对象')
    for (const key of ['documents', 'categories', 'tags']) {
      if (!Array.isArray(obj[key])) throw new Error(`缺少 ${key} 集合`)
    }
  }

  // 临时文件 + 原子重命名：写入中断也不会留下半个坏文件
  async function save () {
    await fs.writeFileAtomicText('library.json', JSON.stringify(data, null, 2))
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
  // 一次并回填，之后走 hash 快路径——与桌面端 findDuplicate 同逻辑
  async function findDuplicate (hash, size) {
    let backfilled = false
    let dup = null
    for (const d of data.documents) {
      if (d.hash) {
        if (d.hash === hash) { dup = d; break }
        continue
      }
      if (d.size !== size) continue
      try {
        d.hash = await sha256(base64ToBytes(await fs.readFileB64(`files/${d.id}.pdf`)))
        backfilled = true
        if (d.hash === hash) dup = d
      } catch { /* 副本丢失的旧条目跳过 */ }
      if (dup) break
    }
    if (backfilled) await save()
    return dup
  }

  // 导入串行化：算哈希 → 查重 → 写副本 → 写数据中间有多个 await，本身
  // 不原子；用一条 promise 链排队，队列内不并发（与桌面端 importChain 同法）
  let importChain = Promise.resolve()

  function importFile (file) {
    const run = importChain.then(() => importFileLocked(file))
    importChain = run.then(() => {}, () => {})
    return run
  }

  async function importFileLocked (file) {
    const name = String(file.fileName || '')
    if (!name.toLowerCase().endsWith('.pdf')) throw new Error('仅支持 PDF 文件')
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes)
    const size = Number.isFinite(file.size) ? file.size : bytes.length
    const hash = await sha256(bytes)
    const dup = await findDuplicate(hash, size)
    if (dup) {
      const err = new Error(`与已入库的《${dup.title}》内容相同`)
      err.duplicate = { title: dup.title, docId: dup.id }
      throw err
    }
    const id = randomUUID()
    await fs.writeB64(`files/${id}.pdf`, bytesToBase64(bytes))
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
    await save()
    return doc
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

  // 删除文档：先逻辑删除（改数据落库，必然成功），库内文件尽力而为；
  // 删不掉的列入 leftovers 由下次启动的孤儿清理补删（同桌面端）。
  // keepNotes：把 notes/<id>/ 改名为「已删书-书名-时间」保留
  async function removeDoc (id, opts = {}) {
    const doc = findDoc(id)
    data.documents = data.documents.filter(d => d.id !== id)
    if (textIndexMeta.entries[id]) {
      delete textIndexMeta.entries[id]
      await saveTextIndexMeta()
      dropShardCache(id)
    }
    await save()
    const leftovers = []
    const base = (p) => p.split('/').pop()
    for (const p of [`files/${doc.id}.pdf`, `covers/${doc.id}.jpg`, `textindex/${doc.id}.json`]) {
      if (!await fs.rm(p)) leftovers.push(base(p))
    }
    let notesKeptTo = null
    let notesPurged = false
    const notesDir = `notes/${doc.id}`
    if (opts.keepNotes && await fs.exists(notesDir)) {
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
      while (await fs.exists(dest)) dest = `notes/已删书-${safe}-${stamp} (${n++})`
      try {
        await fs.rename(notesDir, dest)
        notesKeptTo = base(dest)
      } catch {
        // 改名失败（目录被占用）就原样保留，宁可留在 UUID 目录里也不丢笔记
      }
    } else if (await fs.exists(notesDir)) {
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
    } catch {
      // 副本可能已被手动清理：给出可读错误（同桌面端文案）
      throw new Error('库内 PDF 副本已丢失，请删除这本书后重新导入（原文件不受影响）')
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

  const OPEN_DAYS_KEEP = 400
  const dayKey = (d) => {
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  function countOpenDay (at) {
    if (!data.openDays || typeof data.openDays !== 'object') data.openDays = {}
    const k = dayKey(new Date(at))
    data.openDays[k] = (data.openDays[k] || 0) + 1
    const keys = Object.keys(data.openDays)
    if (keys.length > OPEN_DAYS_KEEP) {
      keys.sort()
      for (const old of keys.slice(0, keys.length - OPEN_DAYS_KEEP)) delete data.openDays[old]
    }
  }

  function getOpenStats () {
    const days = data.openDays || {}
    const d = now()
    let opens7d = 0
    let opens30d = 0
    for (let i = 0; i < 30; i++) {
      const n = days[dayKey(d)] || 0
      if (i < 7) opens7d += n
      opens30d += n
      d.setDate(d.getDate() - 1)
    }
    return { opens7d, opens30d }
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
    await fs.writeB64(`covers/${id}.jpg`, m[2])
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

  // 搜索关键词归一化：必须与渲染层 util.js 的 normText 一致（兜底）
  const normalizeKeyword = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

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
    } catch {
      return { version: 1, entries: {} }
    }
    try {
      const obj = JSON.parse(raw)
      if (obj && obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries)) {
        return { version: 1, entries: obj.entries }
      }
    } catch { /* 按损坏处理 */ }
    // meta 损坏不值得挡门：索引退回「无」，渲染层按需重建
    try { await fs.rename('textindex/index.json', 'textindex/index.json.corrupt') } catch { /* 继续 */ }
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

  // 0.15.x 桌面端的单文件索引 → 分片，一次性搬迁（推库过来的旧桌面库兼容）
  async function migrateLegacyTextIndex () {
    if (legacyMigrationDone) return
    legacyMigrationDone = true
    if (!await fs.exists('textindex.json')) return
    try {
      const old = JSON.parse(await fs.readFileText('textindex.json'))
      for (const [id, e] of Object.entries(old || {})) {
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
    let obj
    try {
      obj = JSON.parse(await fs.readFileText(`textindex/${id}.json`))
    } catch {
      return null
    }
    if (!obj || !Array.isArray(obj.pages)) return null
    cacheShard(id, obj.pages)
    return obj.pages
  }

  // 只回传 { docId: 首个命中页码 }；逐本 await + 周期让出，不长时间霸住
  // WebView 主线程（搜索期间界面仍可响应输入）
  async function searchTextIndex (kw) {
    const needle = normalizeKeyword(kw)
    if (!needle) return {}
    await migrateLegacyTextIndex()
    const live = new Set(data.documents.map(d => d.id))
    const hits = {}
    const ids = Object.keys(textIndexMeta.entries).filter(id => live.has(id) && !textIndexMeta.entries[id].failed)
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const pages = await readShardPages(id)
      if (pages) {
        for (let n = 0; n < pages.length; n++) {
          if (pages[n].includes(needle)) { hits[id] = n + 1; break }
        }
      } else {
        // 分片丢失/损坏：清掉 meta 让渲染层重新提取，索引自愈
        delete textIndexMeta.entries[id]
        await saveTextIndexMeta()
      }
      if ((i & 15) === 15) await new Promise(r => setTimeout(r, 0))
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
  const APP_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(pdf|jpg)$/i
  const APP_TMP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.tmp$/i

  async function sweepOrphans () {
    await fs.rm('library.json.tmp')
    await fs.rm('textindex/index.json.tmp')
    let shards = []
    try { shards = await fs.readdir('textindex') } catch { /* 目录尚未建立 */ }
    for (const e of shards) {
      if (APP_TMP_RE.test(e.name)) await fs.rm(`textindex/${e.name}`)
    }
    if (!data.documents.length) return
    const ids = new Set(data.documents.map(d => d.id))
    for (const sub of ['files', 'covers']) {
      let entries
      try { entries = await fs.readdir(sub) } catch { continue }
      for (const e of entries) {
        const m = APP_FILE_RE.exec(e.name)
        if (!m || ids.has(m[1])) continue
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

  // 拖拽/换父：沿父链向上检查，禁止移到自己子孙下面成环；visited 防御
  // 手改 library.json 造成的既有环
  async function moveCategory (id, parentId) {
    const cat = data.categories.find(c => c.id === id)
    if (!cat) throw new Error(`分类不存在: ${id}`)
    const target = parentId || null
    if (target === id) throw new Error('不能移动到自身')
    if (target != null) {
      let cursor = data.categories.find(c => c.id === target)
      if (!cursor) throw new Error('目标分类不存在')
      const seen = new Set()
      while (cursor) {
        if (cursor.id === id) throw new Error('不能移动到自己的子分类下')
        if (seen.has(cursor.id)) throw new Error('分类层级数据异常（parentId 成环），请先修复 library.json')
        seen.add(cursor.id)
        cursor = data.categories.find(c => c.id === cursor.parentId) || null
      }
    }
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

  // 设置白名单：与桌面端完全一致的键集合与收敛规则（含平板用不到的
  // watch/阅读器路径键——留着它们，库在两端互搬时设置不丢）
  async function updateSettings (patch) {
    if (!data.settings) data.settings = {}
    const strings = ['notesEditorPath', 'pdfReaderPath', 'externalToolPath', 'watchFolder', 'watchCategory']
    const booleans = ['resumeReading', 'confetti', 'openingAnimation', 'watchEnabled']
    const numbers = { dormantDays: 1, indexPageLimit: 1 }
    const enums = {
      coverSize: ['small', 'medium', 'large'],
      theme: ['auto', 'ink', 'paper', 'dusk'],
      viewMode: ['grid', 'spine', 'shelf']
    }
    for (const key of strings) if (key in patch) data.settings[key] = String(patch[key])
    for (const key of booleans) if (key in patch) data.settings[key] = patch[key] === true
    for (const key of Object.keys(numbers)) {
      if (!(key in patch)) continue
      const n = Math.floor(Number(patch[key]))
      if (Number.isFinite(n) && n >= numbers[key]) data.settings[key] = n
    }
    for (const key of Object.keys(enums)) {
      if (key in patch && enums[key].includes(patch[key])) data.settings[key] = patch[key]
    }
    await save()
    return structuredClone(data.settings)
  }

  return {
    init,
    getData,
    getStartupNotice,
    importFile,
    updateDoc,
    removeDoc,
    readFileBuffer,
    markOpened,
    getOpenStats,
    setProgress,
    setCover,
    getCoverDataUrl,
    getTextIndexStatus,
    setTextIndex,
    searchTextIndex,
    addCategory,
    renameCategory,
    moveCategory,
    removeCategory,
    addTag,
    removeTag,
    addSmartShelf,
    renameSmartShelf,
    removeSmartShelf,
    updateSettings
  }
}
