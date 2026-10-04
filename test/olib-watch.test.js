import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWatch } from '../bridge/olib-watch.mjs'
import { createMemFs } from './mem-fs.mjs'

const file = { uri: 'content://book', name: 'book.pdf', size: 1, mtime: 1 }
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

test('停用监视使稳定等待中的旧扫描失效', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settings = { watchTreeUri: 'content://tree', watchEnabled: true }
  let imports = 0
  const watch = createWatch({
    fs: createMemFs(), getSettings: () => settings,
    listFiles: async () => [file],
    lib: { importVia: async () => { imports++ } }
  })
  const scan = watch.scan({ force: true })
  await settle()
  settings = { ...settings, watchEnabled: false }
  await watch.scan({ force: true })
  t.mock.timers.tick(1500)
  await scan
  assert.equal(imports, 0)
})

test('已排队的导入在复制开始前再核对停用，不复制且不报失败', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settings = { watchTreeUri: 'content://tree', watchEnabled: true }
  let copy, copies = 0, errors = 0
  let release
  const wait = new Promise(r => { release = r })
  const watch = createWatch({
    fs: createMemFs(), getSettings: () => settings,
    listFiles: async () => [file], copyFileAndHash: async () => { copies++ },
    lib: { importVia: async (_meta, performCopy) => { copy = performCopy; await wait; return copy('staging') } }
  })
  watch.init({ onError: () => { errors++ } })
  const scan = watch.scan({ force: true })
  await settle()
  t.mock.timers.tick(1500)
  await settle()
  assert.equal(typeof copy, 'function')
  settings = { ...settings, watchEnabled: false }
  await watch.scan({ force: true })
  release()
  await scan
  assert.equal(copies, 0)
  assert.equal(errors, 0)
})
