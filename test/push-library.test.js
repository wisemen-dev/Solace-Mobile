import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { LIB_ROOT, ANDROID_PKG } from '../bridge/constants.mjs'

const DST = `/storage/emulated/0/Android/data/${ANDROID_PKG}/files/${LIB_ROOT}`
const source = readFileSync(new URL('../scripts/push-library.mjs', import.meta.url), 'utf8').replace(/^import .+\r?\n/gm, '')

// findOut：adb shell find 的回显（校验合并结果用）；findFails：find 退出非 0
//（adb 故障）；swapFails：wipe 换入那条 shell 串失败
function runScript ({ wipe = false, stopFails = false, findOut = '1', findFails = false, swapFails = false } = {}) {
  const calls = []
  const errors = []
  let exited = false
  const context = {
    LIB_ROOT, ANDROID_PKG, join, homedir: () => 'desktop-user', existsSync: () => true,
    readdirSync: () => ['library.json'], statSync: () => ({ isDirectory: () => false }), // listLocal = ['library.json']
    console: { log () {}, error: (...a) => errors.push(a.join(' ')) },
    process: { argv: wipe ? ['node', 'push-library', '--wipe'] : ['node', 'push-library'], exit: () => { exited = true; throw new Error('exit') } },
    spawnSync: (cmd, args) => {
      calls.push([cmd, ...args])
      // find 有两种形态：分参（wipe 校验 INCOMING 计数，回显一行带 UUID 数字
      // 的路径——防回归：旧 shellCount 会把路径数字拼进计数）与单串（合并
      // 校验，回显 findOut/findFails）；swap 恒为单串
      const a1 = String(args[1] || '')
      if (args.includes('find') && !a1.startsWith('find ')) return { status: 0, stdout: 'incoming/files/00000000-0000-4000-8000-000000000099.pdf\r\n' }
      if (a1.startsWith('find ')) {
        if (findFails) return { status: 1, stdout: '' }
        return { status: 0, stdout: findOut }
      }
      if (a1.startsWith('mv ')) return { status: swapFails ? 1 : 0, stdout: '' }
      return { status: calls.length === 1 && stopFails ? 1 : 0, stdout: '' }
    }
  }
  try { runInNewContext(source, context) } catch (e) { assert.equal(e.message, 'exit') }
  return { calls, errors, exited }
}

test('推库和 wipe 的任何写入之前先停止应用', () => {
  // 合并模式的 find 回显带上源相对路径，精确比对通过
  for (const wipe of [false, true]) {
    const { calls } = runScript({ wipe, findOut: `${DST}/library.json` })
    assert.deepEqual(calls[0], ['adb', 'shell', 'am', 'force-stop', ANDROID_PKG])
    if (wipe) {
      // 原子换库序（全量审查 P2-6 + 第四轮审查加固）：清残留 → 推临时目录 →
      // 文件数校验 → 旧库挪 -old → 换入 → 成功才清 -old。第 4 条换入命令
      // 之前不允许触碰 DST 本体（挪 -old 是 mv 不是 rm，失败可手工恢复）
      assert.equal(calls[1][2], 'rm') // rm -rf .solace-incoming（清上次残留）
      assert.deepEqual(calls[2], ['adb', 'push', join('desktop-user', 'AppData/Roaming/solace/SolaceLibrary'), '/storage/emulated/0/Android/data/com.molly.solacemobile/files/.solace-incoming'])
      assert.ok(String(calls[3][2]).startsWith('find '), '临时目录文件数校验（单串 find，行级计数）')
      assert.equal(calls[4][1], 'shell')
      assert.ok(calls[4][2].startsWith(`mv ${DST} ${DST}-old`), '先挪旧库再换入')
      assert.ok(calls[4][2].includes('.solace-incoming') && calls[4][2].includes('rm -rf'), '换入成功才清 -old')
    } else {
      assert.equal(calls[1][1], 'push') // 合并模式：停完直接推
      assert.ok(String(calls[2][2]).startsWith('find '), '推完按源相对路径精确校验（单串 find）')
    }
  }
})

test('停止应用失败时不得 wipe 或推送', () => {
  assert.equal(runScript({ wipe: true, stopFails: true }).calls.length, 1)
})

test('合并模式：源文件未到达平板时告警退出，不误报通过（第四轮审查）', () => {
  const { calls, errors, exited } = runScript({ findOut: `${DST}/无关文件.md` })
  assert.equal(calls[1][1], 'push')
  assert.ok(exited)
  assert.ok(errors.some(m => m.includes('未到达平板')), `应提示缺文件：${errors.join(' | ')}`)
  assert.ok(!errors.join(' ').includes('完成（源'), '不得打印完成')
})

test('合并模式：find 失败（adb 故障）按未验证告警退出，不得打印校验通过（第四轮审查）', () => {
  const { errors, exited } = runScript({ findFails: true })
  assert.ok(exited)
  assert.ok(errors.some(m => m.includes('无法枚举')), `应提示 adb 故障：${errors.join(' | ')}`)
  assert.ok(!errors.join(' ').includes('完成（源'), '不得打印完成')
})

test('wipe 换入失败：提示旧库在 -old 可恢复（第四轮审查）', () => {
  const { errors, exited } = runScript({ wipe: true, swapFails: true })
  assert.ok(exited)
  assert.ok(errors.some(m => m.includes('换入失败') && m.includes('-old')), `应提示恢复路径：${errors.join(' | ')}`)
})
