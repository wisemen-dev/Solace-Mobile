// 桌面端 src/main/notes.js 的移植：每本书的笔记是 notes/<docId>/ 下的
// 独立 .md 文件，目录扫描是唯一事实来源，library.json 不登记笔记。
// 差异：平板端没有 Typora/外部编辑器——openNote 的「打开」动作由渲染层
// 的内置 Markdown 编辑器接管（boot.mjs 返回正文，编辑器经 writeNote 写回），
// 文件本身仍是普通 .md，与桌面端完全互通。
export function createNotes ({ fs, now = () => new Date() }) {
  // docId 是入库时生成的 UUID；白名单校验防路径穿越（同桌面端）
  function docDir (docId) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(String(docId || ''))) throw new Error('非法文档标识')
    return `notes/${docId}`
  }

  // file 必须是纯文件名（basename），禁止任何路径成分
  function notePath (docId, file) {
    const name = String(file || '')
    if (!name || name !== name.trim() || /[\\/:*?"<>|]/.test(name) || name.startsWith('.')) {
      throw new Error('非法笔记文件名')
    }
    return `${docDir(docId)}/${name}`
  }

  // 「不存在」类错误分类：只有它才是正常空态。Capacitor 原生侧（IONFILE
  // DoesNotExist）报 "... does not exist."（code OS-PLUG-FILE-0008）；
  // 内存/web 实现为 ENOENT / "no such"。分不清的一律上抛——宁可让调用方
  // 看到错误，也不能把真故障谎报成空列表
  const isNotFoundError = (e) => {
    if (e && e.code === 'OS-PLUG-FILE-0008') return true
    return /does not exist|ENOENT|no such/i.test(String((e && e.message) || e || ''))
  }

  async function list (docId) {
    const dir = docDir(docId)
    let entries
    try {
      entries = await fs.readdir(dir)
    } catch (e) {
      // 目录不存在 = 这本书还没有笔记（目录由 createNote 懒建）；其余读失败
      // 必须上抛：这份列表是摘录锚点「.md 真不在」的唯一判据，谎报空列表
      // 会被孤儿剪除当成「笔记全被删了」而清光整本侧车（数据损失）
      if (isNotFoundError(e)) return { notes: [] }
      throw e
    }
    const notes = []
    for (const ent of entries) {
      if (ent.type === 'directory' || !ent.name.toLowerCase().endsWith('.md')) continue
      let st = null
      try {
        st = await fs.stat(`${dir}/${ent.name}`)
      } catch { /* stat 失败不得丢条目：漏出会被孤儿剪除误删该条锚点，元数据置空即可 */ }
      notes.push({
        file: ent.name,
        mtime: st ? new Date(st.mtime).toISOString() : null,
        birth: st ? new Date(st.ctime ?? st.mtime).toISOString() : null,
        size: st ? st.size : 0
      })
    }
    notes.sort((a, b) => new Date(b.mtime || 0) - new Date(a.mtime || 0)) // 最近修改在上
    return { notes }
  }

  // 新建串行化：文件名「检查 → 写入」跨 await，同秒并发双击会算出同名
  // 文件互相覆盖（桌面端同步 IO 天然原子）；排队后与桌面行为等价
  let createChain = Promise.resolve()
  function create (docId, payload = {}) {
    const run = createChain.then(() => createLocked(docId, payload))
    createChain = run.then(() => {}, () => {})
    return run
  }

  // 一键新建：文件名「日期 时间（含秒）」，模板含书名/时间/建笔记时的页码，
  // 与桌面端完全一致（桌面端可把同一目录下建出的笔记拿到 Typora 续写）
  async function createLocked (docId, payload = {}) {
    const dir = docDir(docId)
    await fs.mkdirp(dir)
    const t = now()
    const p = (n) => String(n).padStart(2, '0')
    const date = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
    const hm = `${p(t.getHours())}:${p(t.getMinutes())}`
    const stamp = `${date} ${p(t.getHours())}.${p(t.getMinutes())}.${p(t.getSeconds())}`
    let file = `${stamp}.md`
    let n = 2
    while (await fs.exists(`${dir}/${file}`)) file = `${stamp} (${n++}).md`
    const lines = [
      `# 《${String(payload.title || '未命名')}》笔记`,
      '',
      `- 创建：${date} ${hm}`
    ]
    const page = Math.floor(Number(payload.page))
    const total = Math.floor(Number(payload.total))
    if (page >= 1 && total >= 1) lines.push(`- 位置：第 ${Math.min(page, total)} / ${total} 页`)
    lines.push('', '')
    await fs.writeText(notePath(docId, file), lines.join('\n'))
    return { file }
  }

  async function read (docId, file) {
    const p = notePath(docId, file)
    if (!await fs.exists(p)) throw new Error('笔记文件不存在')
    return fs.readFileText(p)
  }

  async function write (docId, file, text) {
    const p = notePath(docId, file)
    if (!await fs.exists(p)) throw new Error('笔记文件不存在')
    await fs.writeFileAtomicText(p, String(text ?? ''))
    return true
  }

  // 平板端没有回收站：删除即永久（界面文案已如实标注）
  async function trash (docId, file) {
    const p = notePath(docId, file)
    if (await fs.exists(p)) {
      if (!await fs.rm(p)) throw new Error('删除失败（文件可能被占用）')
    }
    return true
  }

  return { list, create, read, write, trash }
}
