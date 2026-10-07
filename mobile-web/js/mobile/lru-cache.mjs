/* LRU 缓存（Map 重插实现）——link.js 文本层缓存（24 页）与 doc-info.js
 * 作者缓存（12 条）共用（第四轮审查 Standards-5 去重：两处手写同形驱逐）。
 * 约定：get 命中返回缓存值（可为 '' 等假值），未命中返回 undefined——
 * 调用方以 undefined 判 miss，不要用真值判断。
 */
export function makeLru (cap) {
  const m = new Map()
  return {
    get (key) {
      if (!m.has(key)) return undefined
      const v = m.get(key)
      m.delete(key); m.set(key, v) // 重插 = 标记最近使用
      return v
    },
    set (key, v) {
      m.delete(key); m.set(key, v)
      while (m.size > cap) m.delete(m.keys().next().value) // 驱逐最旧
    },
    has (key) { return m.has(key) },
    get size () { return m.size }
  }
}
