// Capacitor Filesystem 的薄封装：桥内全部使用相对于资料库根目录的
// POSIX 风格相对路径（'library.json'、'files/<id>.pdf'……），适配器负责
// 拼 ROOT 与选择 Directory——上层（library-core / notes-core）只见相对
// 路径，因此可以注入内存实现直接在 Node 下单测。
//
// Directory.External = 应用专属外部目录（/storage/emulated/0/Android/data/
// <pkg>/files），免任何权限；应用卸载时随之删除。整个 SolaceLibrary/
// 放在这里，可用 adb push / USB MTP 与桌面端整库互传。
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { LIB_ROOT } from './constants.mjs'

const ROOT = LIB_ROOT
const DIR = Directory.External

const abs = (p) => `${ROOT}/${String(p).replace(/^\/+/, '')}`

async function statOf (p) {
  return Filesystem.stat({ path: abs(p), directory: DIR })
}

// 原子写：临时文件 + 重命名，与桌面端 atomicWriteFile 同语义。
// 同一目标串行化：WebView 里多个异步写可交错（A 写 tmp、B 写 tmp、A 先 rename
// 把 tmp 搬走 → B rename 失败）；固定 tmp 名保持不变，崩溃残留仍可被启动清扫识别
const writeChains = new Map()
async function writeFileAtomicText (p, text) {
  const prev = writeChains.get(p) || Promise.resolve()
  const run = prev.then(async () => {
    const tmp = `${p}.tmp`
    await Filesystem.writeFile({ path: abs(tmp), data: text, directory: DIR, encoding: Encoding.UTF8 })
    await Filesystem.rename({ from: abs(tmp), to: abs(p), directory: DIR, toDirectory: DIR })
  })
  const tail = run.then(() => {}, () => {})
  writeChains.set(p, tail)
  tail.then(() => { if (writeChains.get(p) === tail) writeChains.delete(p) })
  return run
}

export const fs = {
  // 文本读写（library.json、索引分片、笔记）
  async readFileText (p) {
    const r = await Filesystem.readFile({ path: abs(p), directory: DIR, encoding: Encoding.UTF8 })
    return r.data
  },
  // base64 读写（PDF 副本、封面 jpg）
  async readFileB64 (p) {
    const r = await Filesystem.readFile({ path: abs(p), directory: DIR })
    return r.data
  },
  writeFileAtomicText,
  async writeText (p, text) {
    await Filesystem.writeFile({ path: abs(p), data: text, directory: DIR, encoding: Encoding.UTF8 })
  },
  async writeB64 (p, b64) {
    await Filesystem.writeFile({ path: abs(p), data: b64, directory: DIR })
  },
  async rename (from, to) {
    await Filesystem.rename({ from: abs(from), to: abs(to), directory: DIR, toDirectory: DIR })
  },
  async exists (p) {
    try { await statOf(p); return true } catch { return false }
  },
  // { type: 'file'|'directory', size, mtime(ms), ctime(ms) }
  async stat (p) {
    return statOf(p)
  },
  // [{ name, type }]
  async readdir (p) {
    const r = await Filesystem.readdir({ path: abs(p), directory: DIR })
    return r.files
  },
  async mkdirp (p) {
    try {
      await Filesystem.mkdir({ path: abs(p), directory: DIR, recursive: true })
    } catch { /* 已存在（recursive 在部分实现里对已存在目录也会抛） */ }
  },
  // 删除文件或目录（目录需 recursive）；返回是否删除成功，不抛错。
  // 与桌面端 rmSync({force:true}) 对齐：目标不存在也视为成功（没东西可清
  // 就不报 leftover）
  async rm (p, { recursive = false } = {}) {
    let st
    try {
      st = await statOf(p)
    } catch {
      return true // 不存在 = 无可清理，视为成功
    }
    try {
      if (st.type === 'directory') {
        await Filesystem.rmdir({ path: abs(p), directory: DIR, recursive })
      } else {
        await Filesystem.deleteFile({ path: abs(p), directory: DIR })
      }
      return true
    } catch {
      return false
    }
  }
}

// 资料库根的物理位置（设置面板展示用；可能取不到则返回 null）
export async function rootUri () {
  try {
    await fs.mkdirp('')
    return (await Filesystem.getUri({ path: ROOT, directory: DIR })).uri
  } catch {
    return null
  }
}

// 库内文件的直读 URL：走 Capacitor 内置资源服务器（/_capacitor_file_ 前缀
// 由 WebViewLocalServer 原生拦截、直接 FileInputStream 流式返回）——文件
// 内容完全不过 JS 桥，无 base64、无主线程解码，大 PDF 的全速路径。
// pdf.js 以 url 方式加载即用（服务端不支持 Range 时自动整取，仍远快于桥）
export async function fileUrl (relPath) {
  const r = await Filesystem.getUri({ path: abs(relPath), directory: DIR })
  const p = String(r.uri).replace(/^file:\/\//, '')
  return `https://localhost/_capacitor_file_${p}`
}
