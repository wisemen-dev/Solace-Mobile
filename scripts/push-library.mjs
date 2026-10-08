// 把桌面端的真实资料库推到平板（整库迁移：元数据/副本/封面/索引/笔记）。
// 数据格式两端一致，推过去即可续读；进度、分类、笔记全部保留。
//
// 用法：npm run push:library [-- --wipe]
//   --wipe  整库替换（默认 adb push 只往里合并）；平板端专有的手写标注
//           （annotations/）与摘录链接锚点（links/）随旧库一并移除，桌面端
//           没有这两份数据，无从恢复
//
// 前提：平板已连 adb 且应用至少启动过一次（目录已建立）；
// 目标路径是应用专属外部目录（debug 包可被 adb 写入）：
//   /storage/emulated/0/Android/data/com.molly.solacemobile/files/SolaceLibrary
//
// 原子性（全量审查 P2-6 修正）：--wipe 的旧实现「先 rm 再 push」，推送中断
// （拔线/adb 抖动）会留下不可恢复的空库或半库。现改为推到同卷临时目录
// .solace-incoming → 文件数校验 → 校验过了才 rm 旧库 + mv 换入（同卷
// rename 原子）——中断时旧库完整无损，残留的临时目录由下次运行自清。
// 默认合并模式推完校验文件数，缺文件提示重跑（覆盖推送幂等）。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { LIB_ROOT, ANDROID_PKG } from '../bridge/constants.mjs'

const SRC = join(homedir(), 'AppData/Roaming/solace/SolaceLibrary') // 桌面端默认资料库
const DST = `/storage/emulated/0/Android/data/${ANDROID_PKG}/files/${LIB_ROOT}`
const DST_PARENT = `/storage/emulated/0/Android/data/${ANDROID_PKG}/files`
const INCOMING = `${DST_PARENT}/.solace-incoming`

function run (cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`命令失败：${cmd} ${args.join(' ')}`)
    process.exit(r.status || 1)
  }
}

// 换行返回值（adb shell 输出带 \r\n）剥成纯数字；失败返回 null
function shellCount (args) {
  const r = spawnSync('adb', args, { encoding: 'utf8' })
  const n = r.status === 0 ? Number(String(r.stdout || '').replace(/\D/g, '')) : NaN
  return Number.isFinite(n) ? n : null
}

function countLocal (dir) {
  let files = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files += countLocal(p)
    else files++
  }
  return files
}

if (!existsSync(join(SRC, 'library.json'))) {
  console.error(`桌面端资料库不存在：${SRC}\n（桌面端资料库若迁移过位置，请手动 adb push）`)
  process.exit(1)
}

// 先停止应用，防止旧内存的进度/封面/监视写入覆盖正在推送的资料库。
// run 会在停止失败时结束脚本，目标目录尚未发生任何修改。
console.log('停止平板端 Solace…')
run('adb', ['shell', 'am', 'force-stop', ANDROID_PKG])

const srcFiles = countLocal(SRC)

if (process.argv.includes('--wipe')) {
  console.log(`整库替换模式（源 ${srcFiles} 个文件）：先推临时目录并校验，通过后才替换旧库——中断不会破坏旧库`)
  console.log('注意：旧库中的手写标注（annotations/）与摘录链接锚点（links/）将随替换移除，桌面端均无此数据，不可恢复')
  run('adb', ['shell', 'rm', '-rf', INCOMING]) // 清理上次中断的残留
  run('adb', ['push', SRC, INCOMING])
  const got = shellCount(['shell', 'find', INCOMING, '-type', 'f'])
  if (got === null) {
    console.error('推送后无法统计平板端文件数（adb 故障？）——为保护旧库不做替换；可重跑本命令')
    process.exit(1)
  }
  if (got !== srcFiles) {
    console.error(`文件数校验不符：源 ${srcFiles}、平板 ${got}（推送中断/部分失败）——旧库未动，请重跑本命令`)
    process.exit(1)
  }
  run('adb', ['shell', 'rm', '-rf', DST])
  run('adb', ['shell', 'mv', INCOMING, DST])
  console.log(`\n完成（${srcFiles} 个文件校验通过，旧库已原子替换）。重新打开平板端 Solace 即生效。`)
} else {
  console.log(`合并模式（源 ${srcFiles} 个文件）：${SRC}\n  → ${DST}`)
  run('adb', ['push', SRC, DST_PARENT + '/.'])
  const got = shellCount(['shell', 'find', DST, '-type', 'f'])
  if (got !== null && got < srcFiles) {
    console.error(`\n警告：平板端文件数 ${got} 少于源 ${srcFiles}——推送疑似中断，覆盖推送幂等，请重跑本命令确认`)
    process.exit(1)
  }
  console.log(`\n完成（${got === null ? '文件数' : got + ' 个文件'}校验通过）。重新打开平板端 Solace 即生效。`)
}
