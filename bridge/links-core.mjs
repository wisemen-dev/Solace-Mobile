// 摘录链接锚点数据层：links/<docId>.json（移动端专有；与 notes/ 的 .md 解耦，
// 桌面端不识别即忽略，同 annotations/ 模式）。
// records[file] = { excerpts: [{ page, text, hint? }] }；损坏留档同 annotations-core
import { checkDocId } from './doc-id.mjs'
import { createSerialQueue } from './serial-queue.mjs'
import { readSidecarJson } from './sidecar-json.mjs'

export function createLinks ({ fs }) {
  function docFile (docId) {
    return `links/${checkDocId(docId)}.json`
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

  // 读+校验（损坏 → 留档 + 空回退 + notice，共用实现见 sidecar-json）
  function loadValidated (docId) {
    return readSidecarJson({
      fs,
      path: docFile(docId),
      dir: 'links',
      docId,
      label: '摘录链接',
      empty: emptyData,
      validate
    })
  }

  const writeQ = createSerialQueue()

  // 纯读：不写盘（孤儿剪除已拆到 pruneOrphans，读名即读）
  async function read (docId) {
    await writeQ.settled()
    return loadValidated(docId)
  }

  // 孤儿判据的现存笔记集合：可直接传 Set，也可传 async provider——provider 在
  // 写队列任务内求值。快照若在队列外提前取得，「md 已落盘、锚点已写入、快照
  // 过期」的交错会把刚保存的锚点误剪成孤儿（md 在、锚点无，不可自愈）；保存
  // 流程恒先落 md 再写锚点，故队列内取实时集合即不存在此窗口
  const resolveValidFiles = async (v) => (typeof v === 'function' ? new Set(await v()) : v)

  // 孤儿剪除：validFiles（现存 .md 文件名集合）之外的条目删除，仅在发现
  // 孤儿时写回（空表即删文件，见 writeLocked）；返回是否剪除过
  function pruneOrphans (docId, validFiles) {
    return writeQ.run(async () => (await pruneLocked(docId, await resolveValidFiles(validFiles))).pruned)
  }

  // 桥接读取只加载一次，保留损坏回退的 notice，不再剪除后重新读空文件。
  function readPruned (docId, validFiles) {
    return writeQ.run(async () => (await pruneLocked(docId, await resolveValidFiles(validFiles))).data)
  }

  async function pruneLocked (docId, validFiles) {
    const data = await loadValidated(docId)
    let pruned = false
    for (const key of Object.keys(data.records)) {
      if (!validFiles.has(key)) { delete data.records[key]; pruned = true }
    }
    if (pruned) await writeLocked(docId, data)
    return { data, pruned }
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

  // 读改写串行化（同一队列内：损坏文件先留档再写新数据，不丢原文）
  function mutate (docId, fn) {
    return writeQ.run(async () => {
      const data = await loadValidated(docId)
      fn(data)
      return writeLocked(docId, data)
    })
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

  return { read, readPruned, pruneOrphans, setEntry, removeEntry }
}
