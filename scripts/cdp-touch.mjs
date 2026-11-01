// 临时验证工具：CDP Input.dispatchTouchEvent 注入真实级触摸序列（浏览器执行
// 完整默认行为——pan/长按语义，与 dispatchEvent 合成事件不同）。用法：
//   node scripts/cdp-touch.mjs '<JSON 指令数组>' [--serial <设备序列号>]
// 指令：{t:'start'|'move'|'end', x, y, wait?:ms} 或 {t:'eval', expr, save?:key}
// 末尾自动求值 __result 并回显。
import { cdpBootstrap, cdpPage } from './cdp-conn.mjs'

// 连接引导（--serial/ANDROID_SERIAL、PID 匹配 socket、fetch 超时）抽到
// cdp-conn.mjs 与 cdp-eval 共用（第四轮审查）：本脚本曾漏多设备与超时两项
// 修复——两份实现必然漂移
const argv = process.argv.slice(2)
const { port, serialIdx } = cdpBootstrap({ argv })
const page = await cdpPage(port)

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

const cmds = JSON.parse(argv.filter((a, i) => a !== '--serial' && i !== serialIdx + 1)[0] || '[]')
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
