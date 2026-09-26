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

  async function list (docId) {
    const dir = docDir(docId)
    let entries
    try {
      entries = await fs.readdir(dir)
    } catch {
      return { notes: [] } // 这本书还没有笔记目录
    }
    const notes = []
    for (const ent of entries) {
      if (ent.type === 'directory' || !ent.name.toLowerCase().endsWith('.md')) continue
      let st
      try {
        st = await fs.stat(`${dir}/${ent.name}`)
      } catch {
        continue // readdir 与 stat 的间隙里被删的文件：跳过
      }
      notes.push({
        file: ent.name,
        mtime: new Date(st.mtime).toISOString(),
        birth: new Date(st.ctime ?? st.mtime).toISOString(),
        size: st.size
      })
    }
    notes.sort((a, b) => new Date(b.mtime) - new Date(a.mtime)) // 最近修改在上
    return { notes }
  }

  // 一键新建：文件名「日期 时间（含秒）」，模板含书名/时间/建笔记时的页码，
  // 与桌面端完全一致（桌面端可把同一目录下建出的笔记拿到 Typora 续写）
  async function create (docId, payload = {}) {
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
