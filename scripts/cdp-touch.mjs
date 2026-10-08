// 临时验证工具：CDP Input.dispatchTouchEvent 注入真实级触摸序列（浏览器执行
// 完整默认行为——pan/长按语义，与 dispatchEvent 合成事件不同）。用法：
//   node scripts/cdp-touch.mjs '<JSON 指令数组>'
// 指令：{t:'start'|'move'|'end', x, y, wait?:ms} 或 {t:'eval', expr, save?:key}
// 末尾自动求值 __result 并回显。
import { spawnSync } from 'node:child_process'

const out = spawnSync('adb', ['shell', 'cat /proc/net/unix'], { encoding: 'utf8' })
if (out.error || out.status !== 0) { console.error('adb 不可用'); process.exit(1) }
const sock = String(out.stdout || '').match(/@(webview_devtools_remote_\d+)/)?.[1]
if (!sock) { console.error('未找到 WebView devtools socket'); process.exit(1) }
const fwd = spawnSync('adb', ['forward', 'tcp:9222', `localabstract:${sock}`], { stdio: 'ignore' })
if (fwd.status !== 0) { console.error('adb forward 失败'); process.exit(1) }

const list = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = list.find(t => t.type === 'page' && t.url.includes('localhost'))
if (!page) { console.error('没有 WebView 页面目标'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })

let seq = 0
const pending = new Map()
// 全量审查 P2-7：每条 CDP 指令 20s 兜底超时——设备断连/应用被注入触摸杀死
// 时回复永不到来，无超时的进程会永久挂起（曾实际拖垮过 adb 会话）
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, resolve)
  const timer = setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id)
      reject(new Error(`CDP 超时（20s 无回复）：${method}——设备可能已断连`))
    }
  }, 20_000)
  const wrapped = pending.get(id)
  pending.set(id, (v) => { clearTimeout(timer); wrapped(v) })
  ws.send(JSON.stringify({ id, method, params }))
})
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const cmds = JSON.parse(process.argv[2] || '[]')
const saved = {}
try {
  for (const c of cmds) {
    if (c.t === 'start' || c.t === 'move' || c.t === 'end') {
      await send('Input.dispatchTouchEvent', { type: c.t === 'start' ? 'touchStart' : c.t === 'move' ? 'touchMove' : 'touchEnd', touchPoints: (c.t === 'end') ? [] : [{ x: c.x, y: c.y }] })
    } else if (c.t === 'eval') {
      const r = await send('Runtime.evaluate', { expression: `(async () => (${c.expr}))()`, awaitPromise: true, returnByValue: true })
      if (c.save) saved[c.save] = r.result?.value
      else console.log(JSON.stringify(r.result?.value ?? r, null, 1))
    }
    if (c.wait) await sleep(c.wait)
  }
} catch (err) {
  console.error(String(err?.message || err))
  process.exit(1)
}
console.log('__saved__', JSON.stringify(saved))
ws.close()
process.exit(0)
