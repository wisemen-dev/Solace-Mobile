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
    console: { log () {}, error () {} },
    process: { argv: wipe ? ['node', 'push-library', '--wipe'] : ['node', 'push-library'], exit: () => { throw new Error('exit') } },
    spawnSync: (cmd, args) => { calls.push([cmd, ...args]); return { status: calls.length === 1 && stopFails ? 1 : 0 } }
  }
  try { runInNewContext(source, context) } catch (e) { assert.equal(e.message, 'exit') }
  return calls
}

test('推库和 wipe 的任何写入之前先停止应用', () => {
  for (const wipe of [false, true]) {
    const calls = runScript({ wipe })
    assert.deepEqual(calls[0], ['adb', 'shell', 'am', 'force-stop', ANDROID_PKG])
    assert.equal(calls.at(-1)[1], 'push')
    if (wipe) assert.equal(calls[1][2], 'rm')
  }
})

test('停止应用失败时不得 wipe 或推送', () => {
  assert.equal(runScript({ wipe: true, stopFails: true }).length, 1)
})
