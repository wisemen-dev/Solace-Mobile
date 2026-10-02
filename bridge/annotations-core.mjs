// 手写标注数据层：annotations/<docId>.json，矢量墨迹（点坐标数组）。
// 与 notes/<docId>/*.md 完全解耦——listNotes 只认 .md，两条路径永不相交，
// 桌面端 Typora 互通不变量零影响；桌面端不识别本目录即静默忽略。
// 坐标系是 PDF scale=1 视口空间（左上原点，单位=用户单位），与 dpr、
// fitWidth、设备无关；渲染层只需乘一个变换系数，任意倍率重绘不失真。
export function createAnnotations ({ fs }) {
  // docId 是入库时生成的 UUID；白名单校验防路径穿越（同 notes-core）
  function docFile (docId) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(String(docId || ''))) throw new Error('非法文档标识')
    return `annotations/${docId}.json`
  }

  // 结构浅校验：形状不对拒绝读认/写盘（防渲染层 bug 把垃圾写进资料库）。
  // pts 的数值完整性由渲染层容错，这里不递归
  function validate (data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('非法标注数据')
    if (data.version !== 1) throw new Error('不支持的标注数据版本')
    if (!data.pages || typeof data.pages !== 'object' || Array.isArray(data.pages)) throw new Error('非法标注页表')
    for (const key of Object.keys(data.pages)) {
      // 页码 1 起（渲染层 lastLayout.page），"0" 是渲染 bug 的形状
      if (!/^\d{1,5}$/.test(key) || Number(key) < 1) throw new Error('非法页码键')
      const page = data.pages[key]
      if (!page || typeof page !== 'object' || Array.isArray(page)) throw new Error('非法页数据')
      if (!(Number.isFinite(page.w) && page.w > 0) || !(Number.isFinite(page.h) && page.h > 0)) throw new Error('非法页尺寸')
      if (!Array.isArray(page.strokes)) throw new Error('非法笔迹列表')
      for (const s of page.strokes) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('非法笔迹')
        if (s.tool !== 'pen' && s.tool !== 'hl') throw new Error('非法笔迹工具')
        if (typeof s.color !== 'string' || !s.color) throw new Error('非法笔迹颜色')
        if (!(Number.isFinite(s.width) && s.width > 0)) throw new Error('非法笔迹宽度')
        if (s.pressure !== 0 && s.pressure !== 1) throw new Error('非法压感标记')
        if (!Array.isArray(s.pts)) throw new Error('非法点集')
      }
    }
  }

  // 读：文件不存在 = 没画过（不预建空文件，零成本默认路径）；读取失败
  // （磁盘/权限等瞬时错误）向上抛——吞成「没画过」会让渲染层用空书覆写
  // 盘上墨迹。损坏/结构非法 = 改名留档（顺延编号）后按空墨迹继续，不阻断
  // 阅读。并发的第二次损坏读会因文件已被搬走而走 ENOENT 分支，最坏各自
  // 报一次 notice
  async function read (docId) {
    const p = docFile(docId)
    if (!await fs.exists(p)) return { version: 1, pages: {} }
    const raw = await fs.readFileText(p)
    try {
      const data = JSON.parse(raw)
      validate(data)
      return data
    } catch {
      let n = 1
      while (await fs.exists(`annotations/${docId}.corrupt-${n}.json`)) n++
      try { await fs.rename(p, `annotations/${docId}.corrupt-${n}.json`) } catch { /* 搬不动则放弃留档 */ }
      return { version: 1, pages: {}, notice: '这本书的手写标注数据损坏，已重置；原文件保留为资料库内 annotations 下的 .corrupt 备份。' }
    }
  }

  // 写串行化：校验 → 归一化（丢空页）→ 空墨迹删文件 / 原子写。
  // promise 链排队（同 notes-core 的 createChain 模式），防抖写与冲刷
  // 并发时只落最终状态
  let writeChain = Promise.resolve()
  // async 保证校验失败以 Promise 拒绝返回（而非同步抛出），调用方统一
  // try/catch 即可
  async function write (docId, data) {
    validate(data) // 非法数据在排队前就拒绝，不占队列
    const run = writeChain.then(() => writeLocked(docId, data))
    writeChain = run.then(() => {}, () => {})
    return run
  }

  async function writeLocked (docId, data) {
    const p = docFile(docId)
    const pages = {}
    for (const key of Object.keys(data.pages)) {
      if (data.pages[key].strokes.length) pages[key] = data.pages[key]
    }
    if (!Object.keys(pages).length) {
      // 全书无墨迹：删文件而非写空壳（与「不存在 = 没画过」语义对齐）。
      // 删除失败必须报错：静默成功会让旧墨迹文件残留，下次读取「复活」
      // 已清空的笔迹（对齐 notes-core trash 的检查方式）
      if (!await fs.rm(p)) throw new Error('删除标注文件失败（文件可能被占用）')
      return true
    }
    await fs.mkdirp('annotations')
    await fs.writeFileAtomicText(p, JSON.stringify({ version: 1, pages }))
    return true
  }

  return { read, write }
}
