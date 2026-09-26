// 纯 JS base64 编解码：Uint8Array <-> base64 字符串。
// 不用 atob/btoa：让 Node 单测与 WebView 双端行为完全一致，也避免
// 大数组一次性 spread 进 String.fromCharCode 造成调用栈溢出
const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < TABLE.length; i++) LOOKUP[TABLE.charCodeAt(i)] = i

export function bytesToBase64 (bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += TABLE[b0 >> 2]
    out += TABLE[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? TABLE[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? TABLE[b2 & 63] : '='
  }
  return out
}

export function base64ToBytes (b64) {
  const clean = String(b64).replace(/[\r\n\s=]/g, '')
  const out = new Uint8Array(Math.ceil(clean.length * 3 / 4))
  let o = 0
  let buf = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const v = LOOKUP[clean.charCodeAt(i) & 127]
    if (v < 0) throw new Error('非法 base64 数据')
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buf >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}
