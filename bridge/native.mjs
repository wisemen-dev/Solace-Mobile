// SolaceNative 原生插件（android/.../SolaceNativePlugin.java）的 JS 封装。
// 名字经 registerPlugin 与 Java 侧 @CapacitorPlugin(name = "SolaceNative") 对上
import { registerPlugin } from '@capacitor/core'

const SolaceNative = registerPlugin('SolaceNative')

// 按关键字找可启动的应用（label 或包名包含关键字，大小写不敏感）
export async function findApps (keyword) {
  const r = await SolaceNative.findApps({ keyword: String(keyword || '') })
  return r.apps || []
}

// 多关键字检索并按包名去重：Olib 的包名是 com.open_library.app，
// label/包名都不含连续子串 "olib"（open_library 里 o 与 lib 之间隔着
// 隐字符下划线），单一关键字会漏检
const OLIB_KEYWORDS = ['olib', 'open_library', 'openlibrary', 'open library']

export async function findOlibCandidates () {
  const seen = new Map()
  for (const kw of OLIB_KEYWORDS) {
    try {
      for (const app of await findApps(kw)) {
        if (!seen.has(app.package)) seen.set(app.package, app)
      }
    } catch { /* 单个关键字失败不影响其余 */ }
  }
  // 精确包名优先排前
  return [...seen.values()].sort((a, b) =>
    (b.package === 'com.open_library.app') - (a.package === 'com.open_library.app'))
}

// 按包名拉起应用，返回是否成功
export async function launchApp (pkg) {
  const r = await SolaceNative.launchApp({ package: pkg })
  if (r && r.error) throw new Error(r.error)
  return !!r.ok
}

// 系统目录选择器（SAF）。返回 { canceled: true } 或 { canceled, uri, name }
// tree URI 查 display name 常为 null（Java 侧已兜底「所选文件夹」），JS 侧
// 再从 URI 尾段解码出真实目录名，设置面板的展示更可读
export async function pickFolder () {
  const r = await SolaceNative.pickFolder()
  if (r && !r.canceled) {
    try {
      const tail = decodeURIComponent(String(r.uri)).split('/').filter(Boolean).pop() || ''
      const name = tail.replace(/^primary:/, '').split('/').pop()
      if (name) r.name = name
    } catch { /* 解码失败保留原生返回的 name */ }
  }
  return r
}

// 枚举授权目录下的全部 PDF（递归）：[{ name, uri, size, mtime }]
export async function listPdfs (uri) {
  const r = await SolaceNative.listPdfs({ uri })
  if (r && r.error) throw new Error(r.error)
  return r.files || []
}

/* ---- 原生导入管线（性能关键路径，内容不过 JS 桥） ---- */

// SAF 多选 PDF。返回 { canceled, files: [{ uri, name, size }] }
export async function pickPdfs () {
  return SolaceNative.pickPdfs()
}

// 复制 + 哈希一次完成（内容同源，消除先哈希后复制的写入竞态）。
// 返回 { size, hash }；失败时原生侧已清掉半截文件
export async function copyAndHash (uri, destPath) {
  const r = await SolaceNative.copyAndHash({ uri, destPath })
  if (r && r.error) throw new Error(r.error)
  return r
}

// 库内文件（资料库相对路径）的原生流式哈希。返回 { hash }
export async function hashLibraryPath (path) {
  const r = await SolaceNative.hashLibraryPath({ path })
  if (r && r.error) throw new Error(r.error)
  return r
}
