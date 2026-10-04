// 把桌面端的真实资料库推到平板（整库迁移：元数据/副本/封面/索引/笔记）。
// 数据格式两端一致，推过去即可续读；进度、分类、笔记全部保留。
//
// 用法：npm run push:library [-- --wipe]
//   --wipe  先清掉平板上的 SolaceLibrary（否则 adb push 会往里合并）；
//           平板端专有的手写标注（annotations/）与摘录链接锚点（links/）
//           随之清掉，桌面端没有这两份数据，无从恢复
//
// 前提：平板已连 adb 且应用至少启动过一次（目录已建立）；
// 目标路径是应用专属外部目录（debug 包可被 adb 写入）：
//   /storage/emulated/0/Android/data/com.molly.solacemobile/files/SolaceLibrary
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { LIB_ROOT, ANDROID_PKG } from '../bridge/constants.mjs'

const SRC = join(homedir(), 'AppData/Roaming/solace/SolaceLibrary') // 桌面端默认资料库
const DST = `/storage/emulated/0/Android/data/${ANDROID_PKG}/files/${LIB_ROOT}`
const DST_PARENT = `/storage/emulated/0/Android/data/${ANDROID_PKG}/files`

function run (cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`命令失败：${cmd} ${args.join(' ')}`)
    process.exit(r.status || 1)
  }
}

if (!existsSync(join(SRC, 'library.json'))) {
  console.error(`桌面端资料库不存在：${SRC}\n（桌面端资料库若迁移过位置，请手动 adb push）`)
  process.exit(1)
}

if (process.argv.includes('--wipe')) {
  console.log('清空平板端资料库…')
  console.log('注意：--wipe 会同时清掉平板端手写标注（annotations/）与摘录链接锚点（links/），桌面端均无此数据，不可恢复')
  run('adb', ['shell', 'rm', '-rf', DST])
}

console.log(`推送：${SRC}\n  → ${DST}`)
run('adb', ['push', SRC, DST_PARENT + '/.'])
console.log('\n完成。平板上结束 Solace 后台后重新打开即生效。')
