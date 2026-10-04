// 内存 fs：模拟 Capacitor Filesystem 适配器的接口（相对路径、原子写、
// rename/rm 语义），供各数据层单测注入。从 library-core.test.js 抽取共用。
import { bytesToBase64, base64ToBytes } from '../bridge/base64.mjs'

export function createMemFs () {
  const files = new Map() // path -> { data: Buffer, isDir, mtime }
  const now = () => 1700000000000
  const ensureDir = (p) => { if (!files.has(p)) files.set(p, { isDir: true, mtime: now() }) }

  return {
    files,
    async readFileText (p) {
      const e = files.get(p)
      if (!e || e.isDir) throw new Error(`ENOENT: ${p}`)
      return e.data.toString('utf8')
    },
    async readFileB64 (p) {
      const e = files.get(p)
      if (!e || e.isDir) throw new Error(`ENOENT: ${p}`)
      return bytesToBase64(new Uint8Array(e.data))
    },
    async writeFileAtomicText (p, text) {
      files.set(`${p}.tmp`, { data: Buffer.from(text, 'utf8'), mtime: now() })
      files.delete(`${p}.tmp`)
      files.set(p, { data: Buffer.from(text, 'utf8'), mtime: now() })
    },
    async writeFileAtomicB64 (p, b64) {
      files.set(p, { data: Buffer.from(base64ToBytes(b64)), mtime: now() })
    },
    async writeText (p, text) {
      files.set(p, { data: Buffer.from(text, 'utf8'), mtime: now() })
    },
    async writeB64 (p, b64) {
      files.set(p, { data: Buffer.from(base64ToBytes(b64)), mtime: now() })
    },
    async rename (from, to) {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`)
      files.set(to, files.get(from))
      files.delete(from)
    },
    async exists (p) { return files.has(p) },
    async stat (p) {
      const e = files.get(p)
      if (!e) throw new Error(`ENOENT: ${p}`)
      return { type: e.isDir ? 'directory' : 'file', size: e.isDir ? 0 : e.data.length, mtime: e.mtime, ctime: e.mtime }
    },
    async readdir (p) {
      const out = []
      const prefix = p ? `${p}/` : ''
      for (const [path, e] of files) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        if (!rest || rest.includes('/')) continue
        out.push({ name: rest, type: e.isDir ? 'directory' : 'file' })
      }
      return out
    },
    async mkdirp (p) {
      const parts = String(p).split('/').filter(Boolean)
      let cur = ''
      for (const seg of parts) { cur = cur ? `${cur}/${seg}` : seg; ensureDir(cur) }
    },
    async rm (p, { recursive = false } = {}) {
      const e = files.get(p)
      if (!e) return true // 不存在 = 无可清理，视为成功（对齐适配器语义）
      if (e.isDir && !recursive) {
        const hasKids = [...files.keys()].some(k => k.startsWith(`${p}/`))
        if (hasKids) return false
      }
      for (const k of [...files.keys()]) {
        if (k === p || k.startsWith(`${p}/`)) files.delete(k)
      }
      return true
    }
  }
}
