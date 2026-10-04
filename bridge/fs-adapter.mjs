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
import { isNotFoundError } from './file-errors.mjs'

const ROOT = LIB_ROOT
const DIR = Directory.External

const abs = (p) => `${ROOT}/${String(p).replace(/^\/+/, '')}`

// 注入原生文件系统供故障测试使用；真机默认使用 Capacitor 插件。
export function createFsAdapter ({ filesystem = Filesystem } = {}) {
  async function statOf (p) {
    return filesystem.stat({ path: abs(p), directory: DIR })
  }

  // 原子写：临时文件 + 重命名，与桌面端 atomicWriteFile 同语义。
  // 同一目标串行化：WebView 里多个异步写可交错（A 写 tmp、B 写 tmp、A 先 rename
  // 把 tmp 搬走 → B rename 失败）；固定 tmp 名保持不变，崩溃残留仍可被启动清扫识别
  const writeChains = new Map()
  function atomicWrite (p, writeTmp) {
    const prev = writeChains.get(p) || Promise.resolve()
    const run = prev.then(async () => {
      const tmp = `${p}.tmp`
      await writeTmp(tmp)
      await filesystem.rename({ from: abs(tmp), to: abs(p), directory: DIR, toDirectory: DIR })
    })
    const tail = run.then(() => {}, () => {})
    writeChains.set(p, tail)
    tail.then(() => { if (writeChains.get(p) === tail) writeChains.delete(p) })
    return run
  }

  return {
    // 文本读写（library.json、索引分片、笔记）
    async readFileText (p) {
      const r = await filesystem.readFile({ path: abs(p), directory: DIR, encoding: Encoding.UTF8 })
      return r.data
    },
    // base64 读写（PDF 副本、封面 jpg）
    async readFileB64 (p) {
      const r = await filesystem.readFile({ path: abs(p), directory: DIR })
      return r.data
    },
    writeFileAtomicText: (p, text) => atomicWrite(p,
      tmp => filesystem.writeFile({ path: abs(tmp), data: text, directory: DIR, encoding: Encoding.UTF8 })),
    writeFileAtomicB64: (p, b64) => atomicWrite(p,
      tmp => filesystem.writeFile({ path: abs(tmp), data: b64, directory: DIR })),
    async writeText (p, text) {
      await filesystem.writeFile({ path: abs(p), data: text, directory: DIR, encoding: Encoding.UTF8 })
    },
    async writeB64 (p, b64) {
      await filesystem.writeFile({ path: abs(p), data: b64, directory: DIR })
    },
    async rename (from, to) {
      await filesystem.rename({ from: abs(from), to: abs(to), directory: DIR, toDirectory: DIR })
    },
    async exists (p) {
      try { await statOf(p); return true } catch (err) {
        if (isNotFoundError(err)) return false
        throw err
      }
    },
    // { type: 'file'|'directory', size, mtime(ms), ctime(ms) }
    async stat (p) {
      return statOf(p)
    },
    // [{ name, type }]
    async readdir (p) {
      const r = await filesystem.readdir({ path: abs(p), directory: DIR })
      return r.files
    },
    async mkdirp (p) {
      try {
        await filesystem.mkdir({ path: abs(p), directory: DIR, recursive: true })
      } catch (err) {
        if (err?.code !== 'OS-PLUG-FILE-0010' && !/already exists|EEXIST/i.test(String(err?.message || err))) throw err
      }
    },
    // 删除文件或目录（目录需 recursive）；返回是否删除成功，不抛错。
    // 与桌面端 rmSync({force:true}) 对齐：目标不存在也视为成功（没东西可清
    // 就不报 leftover）
    async rm (p, { recursive = false } = {}) {
      let st
      try {
        st = await statOf(p)
      } catch (err) {
        return isNotFoundError(err) // 只有确实不存在才等价于删除成功
      }
      try {
        if (st.type === 'directory') {
          await filesystem.rmdir({ path: abs(p), directory: DIR, recursive })
        } else {
          await filesystem.deleteFile({ path: abs(p), directory: DIR })
        }
        return true
      } catch {
        return false
      }
    }
  }
}

export const fs = createFsAdapter()

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
