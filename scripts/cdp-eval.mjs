// CDP 求值助手：连接平板 WebView 的 DevTools，执行一段 JS 并回显结果。
// 用法：node scripts/cdp-eval.mjs "<表达式>" [--serial <设备序列号>]
// 注意：Runtime.evaluate 不支持顶层 await，表达式请自带 async IIFE：
//   node scripts/cdp-eval.mjs "(async () => 1+1)()"
// WebView 的 DevTools socket 名带进程号，这里自动探测，避免每次手查。
// 多设备：不指定序列号时 adb 会因「more than one device」直接失败——挂两台
// 设备（手机 + 平板）调试时必须显式指定，或设环境变量 ANDROID_SERIAL
import { spawnSync } from 'node:child_process'
import { ANDROID_PKG } from '../bridge/constants.mjs'

// --serial <s> 优先，其次 ANDROID_SERIAL；都没有则交给 adb 自己决定
const argv = process.argv.slice(2)
const serialIdx = argv.indexOf('--serial')
const SERIAL = serialIdx >= 0 ? argv[serialIdx + 1] : process.env.ANDROID_SERIAL
const expr = argv.filter((a, i) => a !== '--serial' && i !== serialIdx + 1)[0] || '1+1'
const adb = (...args) => spawnSync('adb', SERIAL ? ['-s', SERIAL, ...args] : args, { encoding: 'utf8' })
// forward 单独一支：捕获输出（encoding）在本机会让 forward 失败，沿用原实现的
// stdio:'ignore' 并改用退出码判定
const adbQuiet = (...args) => spawnSync('adb', SERIAL ? ['-s', SERIAL, ...args] : args, { stdio: 'ignore' })
if (serialIdx >= 0 && !SERIAL) {
  console.error('--serial 需要跟一个设备序列号（adb devices 查看）')
  process.exit(1)
}

const out = adb('shell', 'cat /proc/net/unix')
if (out.error || out.status !== 0) {
  const hint = /more than one (device|emulator)/.test(String(out.stderr || ''))
    ? '（连接了多台设备，请用 --serial <序列号> 或设 ANDROID_SERIAL）'
    : ''
  console.error(`adb 不可用或执行失败${hint}：${out.error ? out.error.message : `exit ${out.status}`}`)
  process.exit(1)
}
// 应用重启后旧 WebView 的 devtools socket 仍会残留，且顺序不保证：
// 优先取与当前应用 PID 匹配的那个，取不到再退到最后一个
const sockets = [...String(out.stdout || '').matchAll(/@(webview_devtools_remote_(\d+))/g)]
const pid = String(adb('shell', 'pidof', ANDROID_PKG).stdout || '')
  .trim().split(/\s+/)[0]
const sock = (pid && sockets.find(m => m[2] === pid)?.[1]) || sockets.at(-1)?.[1]
if (!sock) {
  console.error('未找到 WebView devtools socket（adb 不可用，或应用未在前台运行）')
  process.exit(1)
}
const PORT = process.env.CDP_PORT || '9222'
const fwd = adbQuiet('forward', `tcp:${PORT}`, `localabstract:${sock}`)
if (fwd.status !== 0) {
  console.error(`adb forward 失败（${PORT} 端口可能被占用；可用 CDP_PORT 换端口）`)
  process.exit(1)
}

// fetch 带超时（全量审查 P2-7）：adb forward 口僵死时 fetch 无限挂起，
// 而尾部的 20s 兜底定时器此刻尚未注册（await 在其之前），进程假死
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(10_000) })).json()
const page = list.find(t => t.type === 'page' && t.url.includes('localhost'))
if (!page) {
  console.error('没有 WebView 页面目标：', list.map(t => `${t.type}:${t.url}`))
  process.exit(1)
}

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
