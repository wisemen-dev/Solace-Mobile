// 手写标注数据层：annotations/<docId>.json，矢量墨迹（点坐标数组）。
// 与 notes/<docId>/*.md 完全解耦——listNotes 只认 .md，两条路径永不相交，
// 桌面端 Typora 互通不变量零影响；桌面端不识别本目录即静默忽略。
// 坐标系是 PDF scale=1 视口空间（左上原点，单位=用户单位），与 dpr、
// fitWidth、设备无关；渲染层只需乘一个变换系数，任意倍率重绘不失真。
import { checkDocId } from './doc-id.mjs'
import { createSerialQueue } from './serial-queue.mjs'
import { readSidecarJson } from './sidecar-json.mjs'

export function createAnnotations ({ fs }) {
  // docId 是入库时生成的 UUID；白名单校验防路径穿越（共用检查见 doc-id.mjs）
  function docFile (docId) {
    return `annotations/${checkDocId(docId)}.json`
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

  // 写串行化：校验 → 归一化（丢空页）→ 空墨迹删文件 / 原子写。队列排队
  // （serial-queue），防抖写与冲刷并发时只落最终状态。读也排队于链尾
  // （settled）：在途写未结算前读会拿到写入前的旧态（换书冲刷/退出即冲刷
  // 与紧接着的重读窗口都靠这条保证）
  const writeQ = createSerialQueue()

  // 空结构工厂：读缺失/损坏回退共用（形状单一定义，防字面量漂移）
  const emptyData = () => ({ version: 1, pages: {} })

  // 读：不存在 = 没画过（不预建空文件，零成本默认路径）；读取失败（磁盘/
  // 权限等瞬时错误）向上抛——吞成「没画过」会让渲染层用空书覆写盘上墨迹；
  // 损坏/结构非法走 sidecar-json 的留档 + 空回退（notice 随返回值携带）
  async function read (docId) {
    await writeQ.settled() // 等全部在途写结算，不读旧态
    return readSidecarJson({
      fs,
      path: docFile(docId),
      dir: 'annotations',
      docId,
      label: '手写标注',
      empty: emptyData,
      validate
    })
  }

  // 校验失败在排队前就拒绝（async 函数内同步抛错 = Promise 拒绝，
  // 调用方统一 try/catch 即可）
  async function write (docId, data) {
    validate(data) // 非法数据在排队前就拒绝，不占队列
    // 固化快照再入队：调用方（渲染层）持有活引用，排队等待期间对模型的
    // 改动不应混进本次落盘（对齐 links-core setEntry 的深拷贝）
    const snapshot = JSON.parse(JSON.stringify(data))
    return writeQ.run(() => writeLocked(docId, snapshot))
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
