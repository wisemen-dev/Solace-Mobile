// CDP 连接引导（cdp-eval / cdp-touch 共用，第四轮审查抽出）：--serial /
// ANDROID_SERIAL 解析、按应用 PID 匹配 WebView devtools socket、adb forward、
// /json 页面目标获取。此前两脚本各持一份实现，cdp-eval 的修复（多设备、
// fetch 超时）没同步进 cdp-touch——两份实现必然漂移，收敛到这一份
import { spawnSync } from 'node:child_process'
import { ANDROID_PKG } from '../bridge/constants.mjs'

// 返回 { port, serialIdx }；任何一步失败直接打错误并退出（工具脚本的惯例）。
// port 供 cdpPage() 与调用方自行 fetch/debuggerUrl 使用
export function cdpBootstrap ({ argv = [] } = {}) {
  // --serial <s> 优先，其次 ANDROID_SERIAL；都没有则交给 adb 自己决定
  const serialIdx = argv.indexOf('--serial')
  const SERIAL = serialIdx >= 0 ? argv[serialIdx + 1] : process.env.ANDROID_SERIAL
  if (serialIdx >= 0 && !SERIAL) {
    console.error('--serial 需要跟一个设备序列号（adb devices 查看）')
    process.exit(1)
  }
  const adb = (...args) => spawnSync('adb', SERIAL ? ['-s', SERIAL, ...args] : args, { encoding: 'utf8' })
  // forward 单独一支：捕获输出（encoding）在本机会让 forward 失败，沿用
  // stdio:'ignore' 并以退出码判定
  const adbQuiet = (...args) => spawnSync('adb', SERIAL ? ['-s', SERIAL, ...args] : args, { stdio: 'ignore' })

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
  const pid = String(adb('shell', 'pidof', ANDROID_PKG).stdout || '').trim().split(/\s+/)[0]
  const sock = (pid && sockets.find(m => m[2] === pid)?.[1]) || sockets.at(-1)?.[1]
  if (!sock) {
    console.error('未找到 WebView devtools socket（adb 不可用，或应用未在前台运行）')
    process.exit(1)
  }
  const port = process.env.CDP_PORT || '9222'
  const fwd = adbQuiet('forward', `tcp:${port}`, `localabstract:${sock}`)
  if (fwd.status !== 0) {
    console.error(`adb forward 失败（${port} 端口可能被占用；可用 CDP_PORT 换端口）`)
    process.exit(1)
  }
  return { port, serialIdx }
}

// 取 WebView 页面目标（带超时）。fetch 带超时（全量审查 P2-7）：adb forward
// 口僵死时 fetch 无限挂起，进程假死
export async function cdpPage (port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(10_000) })).json()
  const page = list.find(t => t.type === 'page' && t.url.includes('localhost'))
  if (!page) {
    console.error('没有 WebView 页面目标：', list.map(t => `${t.type}:${t.url}`))
    process.exit(1)
  }
  return page
}
