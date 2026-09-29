// CDP 求值助手：连接平板 WebView 的 DevTools，执行一段 JS 并回显结果。
// 用法：node scripts/cdp-eval.mjs "<表达式>"
// 注意：Runtime.evaluate 不支持顶层 await，表达式请自带 async IIFE：
//   node scripts/cdp-eval.mjs "(async () => 1+1)()"
// WebView 的 DevTools socket 名带进程号，这里自动探测，避免每次手查。
import { spawnSync } from 'node:child_process'

const out = spawnSync('adb', ['shell', 'cat /proc/net/unix'], { encoding: 'utf8' })
const sock = String(out.stdout || '').match(/@(webview_devtools_remote_\d+)/)?.[1]
if (!sock) {
  console.error('未找到 WebView devtools socket（adb 不可用，或应用未在前台运行）')
  process.exit(1)
}
const fwd = spawnSync('adb', ['forward', 'tcp:9222', `localabstract:${sock}`], { stdio: 'ignore' })
if (fwd.status !== 0) {
  console.error('adb forward 失败（9222 端口可能被占用）')
  process.exit(1)
}

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('localhost'))
if (!page) {
  console.error('没有 WebView 页面目标：', list.map(t => `${t.type}:${t.url}`))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
const expr = process.argv[2] || '1+1'

ws.onopen = () => {
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: expr, awaitPromise: true, returnByValue: true }
  }))
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id === 1) {
    if (msg.result?.exceptionDetails) {
      console.error('异常：', msg.result.exceptionDetails.exception?.description ||
        JSON.stringify(msg.result.exceptionDetails).slice(0, 2000))
    } else {
      const v = msg.result?.result?.value
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
    }
    ws.close()
    process.exit(0)
  }
}
ws.onerror = (e) => { console.error('WebSocket 错误', e.message || e); process.exit(1) }
setTimeout(() => { console.error('超时'); process.exit(1) }, 20000)
