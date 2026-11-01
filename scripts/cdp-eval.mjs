// CDP 求值助手：连接平板 WebView 的 DevTools，执行一段 JS 并回显结果。
// 用法：node scripts/cdp-eval.mjs "<表达式>" [--serial <设备序列号>]
// 注意：Runtime.evaluate 不支持顶层 await，表达式请自带 async IIFE：
//   node scripts/cdp-eval.mjs "(async () => 1+1)()"
// WebView 的 DevTools socket 名带进程号，这里自动探测，避免每次手查。
// 多设备：不指定序列号时 adb 会因「more than one device」直接失败——挂两台
// 设备（手机 + 平板）调试时必须显式指定，或设环境变量 ANDROID_SERIAL
import { cdpBootstrap, cdpPage } from './cdp-conn.mjs'

// 连接引导（serial/socket/forward/页面目标）抽到 cdp-conn.mjs 与 cdp-touch
// 共用（第四轮审查）：两脚本各持一份时修复只进一份，漂移即复发
const argv = process.argv.slice(2)
const { port, serialIdx } = cdpBootstrap({ argv })
const expr = argv.filter((a, i) => a !== '--serial' && i !== serialIdx + 1)[0] || '1+1'

const page = await cdpPage(port)

const ws = new WebSocket(page.webSocketDebuggerUrl)

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
