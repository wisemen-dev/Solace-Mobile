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

test('force 补扫不与在途扫描并发：等它结算后再进（第四轮审查）', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settings = { watchTreeUri: 'content://tree', watchEnabled: true }
  let listCalls = 0
  let inList = 0
  let maxInList = 0
  const watch = createWatch({
    fs: createMemFs(), getSettings: () => settings,
    listFiles: async () => {
      listCalls++
      inList++
      maxInList = Math.max(maxInList, inList)
      await settle()
      inList--
      return [file]
    },
    lib: { importVia: async () => {} }
  })
  const first = watch.scan({ force: true })
  await settle() // 首轮已枚举完，正等 1.5s 稳定窗（在途未结算）
  assert.equal(listCalls, 1)
  const second = watch.scan({ force: true }) // 旧实现：force 直接放行，与在途并发
  await settle()
  assert.equal(listCalls, 1, 'force 不得在在途扫描结算前进入枚举')
  t.mock.timers.tick(1500)
  await settle()
  await Promise.all([first, second])
  assert.ok(listCalls >= 2, '结算后第二轮照常执行')
  assert.ok(maxInList <= 1, `listFiles 不得并发重入（实测峰值 ${maxInList}）——并发会互相 ++scanSeq 作废对方、掐断导入批次`)
})
