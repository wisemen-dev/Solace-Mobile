// 摘录链接锚点数据层：links/<docId>.json（移动端专有；与 notes/ 的 .md 解耦，
// 桌面端不识别即忽略，同 annotations/ 模式）。
// records[file] = { excerpts: [{ page, text, hint? }] }；损坏留档同 annotations-core
export function createLinks ({ fs }) {
  function docFile (docId) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(String(docId || ''))) throw new Error('非法文档标识')
    return `links/${docId}.json`
  }

  // 记录文件名：纯 basename、.md 结尾，其余约束与 notes-core 的 notePath 逐条
  // 对齐（禁路径成分、禁以 . 开头、禁首尾空白）——放得比 notes 侧宽就会存下
  // notes.list 永远匹配不上的孤儿条目（.md 判据用 toLowerCase，同 notes.list）
  function checkFile (file) {
    const name = String(file || '')
    if (!name || name.length > 120 || name !== name.trim() || name.startsWith('.') ||
        /[\\/:*?"<>|]/.test(name) || !name.toLowerCase().endsWith('.md')) {
      throw new Error('非法记录文件名')
    }
    return name
  }

  function validateEntry (file, entry) {
    checkFile(file)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('非法锚点条目')
    if (!Array.isArray(entry.excerpts) || !entry.excerpts.length) throw new Error('锚点条目需至少一处摘录')
    for (const e of entry.excerpts) {
      if (!e || typeof e !== 'object') throw new Error('非法摘录')
      if (!Number.isInteger(e.page) || e.page < 1) throw new Error('非法摘录页码')
      if (typeof e.text !== 'string' || !e.text.trim()) throw new Error('非法摘录文本')
      if (e.hint != null &&
          (typeof e.hint !== 'object' || !Number.isInteger(e.hint.item) || !Number.isInteger(e.hint.char))) {
        throw new Error('非法定位提示')
      }
    }
  }

  function validate (data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('非法链接数据')
    if (data.version !== 1) throw new Error('不支持的链接数据版本')
    if (!data.records || typeof data.records !== 'object' || Array.isArray(data.records)) throw new Error('非法记录表')
    for (const [file, entry] of Object.entries(data.records)) validateEntry(file, entry)
  }

  const emptyData = () => ({ version: 1, records: {} })

  // 读+校验；损坏 → 留档（rename 顺延编号；失败用原文落副本兜底）→ 空+notice
  async function loadValidated (docId) {
    const p = docFile(docId)
    if (!await fs.exists(p)) return emptyData()
    const raw = await fs.readFileText(p)
    try {
      const d = JSON.parse(raw)
      validate(d)
      return d
    } catch {
      let n = 1
      while (await fs.exists(`links/${docId}.corrupt-${n}.json`)) n++
      const archive = `links/${docId}.corrupt-${n}.json`
      let archived = false
      try {
        await fs.rename(p, archive)
        archived = true
      } catch {
        try { await fs.writeText(archive, raw); archived = true; await fs.rm(p) } catch { /* notice 如实 */ }
      }
      return {
        ...emptyData(),
        notice: archived
          ? '这本书的摘录链接数据损坏，已重置；原文件保留为资料库内 links 下的 .corrupt 备份。'
          : '这本书的摘录链接数据损坏，已重置；原文件留档失败（文件可能被占用），再次写入将覆盖损坏文件。'
      }
    }
  }

  let writeChain = Promise.resolve()

  async function read (docId, validFiles) {
    await writeChain.catch(() => {})
    const data = await loadValidated(docId)
    if (validFiles instanceof Set) {
      let pruned = false
      for (const key of Object.keys(data.records)) {
        if (!validFiles.has(key)) { delete data.records[key]; pruned = true }
      }
      if (pruned) await write(docId, data)
    }
    return data
  }

  // 校验失败在排队前就拒绝（async 函数内同步抛错 = Promise 拒绝，调用方统一
  // try/catch 即可；同 annotations-core.write 的约定）
  async function write (docId, data) {
    validate(data)
    const run = writeChain.then(() => writeLocked(docId, data))
    writeChain = run.then(() => {}, () => {})
    return run
  }

  async function writeLocked (docId, data) {
    const p = docFile(docId)
    const records = {}
    for (const [file, entry] of Object.entries(data.records)) {
      if (entry.excerpts.length) records[file] = entry
    }
    if (!Object.keys(records).length) {
      // 空表删文件而非留空壳（与「不存在 = 没有摘录」语义对齐）。删除失败必须
      // 报错：静默成功会让旧条目残留、下次读取「复活」；文件本就不存在时
      // 适配器与 mem-fs 都返回 true（无可清理视为成功），故删笔记联动清侧车
      // 对没有摘录的书是无害操作
      if (!await fs.rm(p)) throw new Error('删除链接文件失败（文件可能被占用）')
      return true
    }
    await fs.mkdirp('links')
    await fs.writeFileAtomicText(p, JSON.stringify({ version: 1, records }))
    return true
  }

  // 读改写串行化（同一写链内：损坏文件先留档再写新数据，不丢原文）
  function mutate (docId, fn) {
    const run = writeChain.then(async () => {
      const data = await loadValidated(docId)
      fn(data)
      return writeLocked(docId, data)
    })
    writeChain = run.then(() => {}, () => {})
    return run
  }

  async function setEntry (docId, file, entry) {
    if (entry == null) return removeEntry(docId, file)
    validateEntry(file, entry)
    return mutate(docId, (d) => { d.records[file] = JSON.parse(JSON.stringify(entry)) })
  }

  async function removeEntry (docId, file) {
    checkFile(file)
    return mutate(docId, (d) => { delete d.records[file] })
  }

  return { read, write, setEntry, removeEntry }
}
