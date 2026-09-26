// crypto.subtle 摘要：Capacitor WebView（https://localhost，属安全上下文）
// 与 Node 24（globalThis.crypto = webcrypto）都原生可用，双端同源。
// 导入去重需要与桌面端 library.js 的 crypto.createHash('sha256') 同值，
// 二者都是标准 SHA-256，十六进制输出一致——资料库在两端互认
export async function sha256Hex (data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
