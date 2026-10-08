import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { LIB_ROOT, ANDROID_PKG } from '../bridge/constants.mjs'

const source = readFileSync(new URL('../scripts/push-library.mjs', import.meta.url), 'utf8').replace(/^import .+\r?\n/gm, '')
function runScript ({ wipe = false, stopFails = false } = {}) {
  const calls = []
  const context = {
    LIB_ROOT, ANDROID_PKG, join, homedir: () => 'desktop-user', existsSync: () => true,
    readdirSync: () => ['library.json'], statSync: () => ({ isDirectory: () => false }), // countLocal = 1
    console: { log () {}, error () {} },
    process: { argv: wipe ? ['node', 'push-library', '--wipe'] : ['node', 'push-library'], exit: () => { throw new Error('exit') } },
    // find 的 stdout 给 1：与 countLocal 对上，文件数校验通过放行后续替换
    spawnSync: (cmd, args) => { calls.push([cmd, ...args]); return { status: calls.length === 1 && stopFails ? 1 : 0, stdout: args.includes('find') ? '1' : '' } }
  }
  try { runInNewContext(source, context) } catch (e) { assert.equal(e.message, 'exit') }
  return calls
}

test('推库和 wipe 的任何写入之前先停止应用', () => {
  for (const wipe of [false, true]) {
    const calls = runScript({ wipe })
    assert.deepEqual(calls[0], ['adb', 'shell', 'am', 'force-stop', ANDROID_PKG])
    if (wipe) {
      // 原子换库序（全量审查 P2-6）：清残留 → 推临时目录 → 文件数校验 →
      // 校验通过才动旧库 → mv 换入。第 4 条 rm -rf DST 之前不允许触碰 DST
      assert.equal(calls[1][2], 'rm') // rm -rf .solace-incoming（清上次残留）
      assert.deepEqual(calls[2], ['adb', 'push', join('desktop-user', 'AppData/Roaming/solace/SolaceLibrary'), '/storage/emulated/0/Android/data/com.molly.solacemobile/files/.solace-incoming'])
      assert.equal(calls[3][2], 'find') // 临时目录文件数校验
      assert.deepEqual(calls[4], ['adb', 'shell', 'rm', '-rf', '/storage/emulated/0/Android/data/com.molly.solacemobile/files/SolaceLibrary'])
      assert.deepEqual(calls[5], ['adb', 'shell', 'mv', '/storage/emulated/0/Android/data/com.molly.solacemobile/files/.solace-incoming', '/storage/emulated/0/Android/data/com.molly.solacemobile/files/SolaceLibrary'])
    } else {
      assert.equal(calls[1][1], 'push') // 合并模式：停完直接推
    }
  }
})

test('停止应用失败时不得 wipe 或推送', () => {
  assert.equal(runScript({ wipe: true, stopFails: true }).length, 1)
})
