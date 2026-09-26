// 安装到已连接的设备并启动：npm run install:device [-- --rebuild]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const adb = 'adb'
const apk = join(root, 'android/app/build/outputs/apk/debug/app-debug.apk')
const PKG = 'com.molly.solacemobile'

function run (cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    console.error(`命令失败：${cmd} ${args.join(' ')}`)
    process.exit(r.status || 1)
  }
}

if (process.argv.includes('--rebuild')) {
  run('node', [join(root, 'scripts/build-apk.mjs')])
}

if (!existsSync(apk)) {
  console.error('找不到 debug APK，先跑 npm run apk')
  process.exit(1)
}

run(adb, ['install', '-r', apk])
run(adb, ['shell', 'am', 'start', '-n', `${PKG}/.MainActivity`])
console.log('\n已安装并启动 Solace')
