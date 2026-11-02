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
// 原子性（全量审查 P2-6 修正 + 第四轮审查加固）：--wipe 推到同卷临时目录
// .solace-incoming → 文件数校验 → 旧库挪 -old → 换入 → 成功才清 -old——
// 换入失败旧库仍在 -old 可手工恢复，中断时残留临时目录由下次运行自清。
// 合并模式推送后按「源相对路径集合」精确比对（旧实现拿平板全库计数与源数
// 比大小，合并下恒真形同虚设、adb 故障还打「校验通过」），缺文件提示重跑。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { LIB_ROOT, ANDROID_PKG } from '../bridge/constants.mjs'

const SRC = join(homedir(), 'AppData/Roaming/solace/SolaceLibrary') // 桌面端默认资料库
const DST = `/storage/emulated/0/Android/data/${ANDROID_PKG}/files/${LIB_ROOT}`
const DST_PARENT = `/storage/emulated/0/Android/data/${ANDROID_PKG}/files`
const INCOMING = `${DST_PARENT}/.solace-incoming`
const DST_OLD = `${DST}-old`

function run (cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`命令失败：${cmd} ${args.join(' ')}`)
    process.exit(r.status || 1)
  }
}

// 行列表版（计数与集合校验都用行级）；失败返回 null。注意不能用「剥掉非数字
// 拼计数」的旧解法——find 输出是路径，files/<uuid>.pdf 的 UUID 数字会被拼进
// 计数（第四轮真机验证实测：2 文件被数成 4e19，wipe 校验必假）
function shellList (args) {
  const r = spawnSync('adb', args, { encoding: 'utf8' })
  if (r.status !== 0) return null
  return String(r.stdout || '').split('\n').map(s => s.replace(/\r$/, '')).filter(Boolean)
}

// 源库全部文件的相对路径（POSIX 分隔，与 adb shell find 的输出可比）
function listLocal (dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (statSync(p).isDirectory()) out.push(...listLocal(p, rel))
    else out.push(rel)
  }
  return out
}

if (!existsSync(join(SRC, 'library.json'))) {
  console.error(`桌面端资料库不存在：${SRC}\n（桌面端资料库若迁移过位置，请手动 adb push）`)
  process.exit(1)
}

// 先停止应用，防止旧内存的进度/封面/监视写入覆盖正在推送的资料库。
// run 会在停止失败时结束脚本，目标目录尚未发生任何修改。
console.log('停止平板端 Solace…')
run('adb', ['shell', 'am', 'force-stop', ANDROID_PKG])

const srcRel = listLocal(SRC)
const srcFiles = srcRel.length

if (process.argv.includes('--wipe')) {
  console.log(`整库替换模式（源 ${srcFiles} 个文件）：先推临时目录并校验，通过后才替换旧库——中断不会破坏旧库`)
  console.log('注意：旧库中的手写标注（annotations/）与摘录链接锚点（links/）将随替换移除，桌面端均无此数据，不可恢复')
  run('adb', ['shell', 'rm', '-rf', INCOMING]) // 清理上次中断的残留
  run('adb', ['push', SRC, INCOMING])
  const gotLines = shellList(['shell', `find ${INCOMING} -type f`])
  if (!gotLines) {
    console.error('推送后无法统计平板端文件数（adb 故障？）——为保护旧库不做替换；可重跑本命令')
    process.exit(1)
  }
  if (gotLines.length !== srcFiles) {
    console.error(`文件数校验不符：源 ${srcFiles}、平板 ${gotLines.length}（推送中断/部分失败）——旧库未动，请重跑本命令`)
    process.exit(1)
  }
  // 换入（第四轮审查）：旧实现 rm 旧库后再 mv——mv 失败即留下不可恢复的空
  // 窗。改为先把旧库挪到 -old 再换入：换入失败时旧库在 -old、新库在
  // INCOMING，均完整可手工恢复；成功才清 -old（一条 shell 串保证顺序）
  const swap = spawnSync('adb',
    ['shell', `mv ${DST} ${DST_OLD} 2>/dev/null; mv ${INCOMING} ${DST} && rm -rf ${DST_OLD}`],
    { stdio: 'inherit' })
  if (swap.status !== 0) {
    console.error(`\n换入失败：旧库（若存在）已挪至 ${DST_OLD}、新库在 ${INCOMING}，两者均完整——排除故障后重跑本命令`)
    process.exit(swap.status || 1)
  }
  console.log(`\n完成（${srcFiles} 个文件校验通过，旧库已替换并清理）。重新打开平板端 Solace 即生效。`)
} else {
  console.log(`合并模式（源 ${srcFiles} 个文件）：${SRC}\n  → ${DST}`)
  run('adb', ['push', SRC, DST_PARENT + '/.'])
  // 校验（第四轮审查）：按源相对路径精确比对平板库文件集合——旧实现拿全库
  // 计数与源数比大小（合并下恒真）且 adb 故障也打「校验通过」
  const dstLines = shellList(['shell', `find ${DST} -type f`])
  if (!dstLines) {
    console.error('\n推送后无法枚举平板端文件（adb 故障？）——合并结果未验证，可重跑本命令确认（覆盖推送幂等）')
    process.exit(1)
  }
  const dstSet = new Set(dstLines.map(p => p.slice(DST.length + 1)))
  const missing = srcRel.filter(p => !dstSet.has(p))
  if (missing.length) {
    console.error(`\n警告：${missing.length} 个文件未到达平板（推送疑似中断），如 ${missing.slice(0, 3).join('、')}——覆盖推送幂等，请重跑本命令`)
    process.exit(1)
  }
  console.log(`\n完成（源 ${srcFiles} 个文件全部就位，校验通过）。重新打开平板端 Solace 即生效。`)
}
