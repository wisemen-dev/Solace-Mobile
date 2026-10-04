// 笔记数据层（bridge/notes-core.mjs）单测：list 的空态与故障语义。
// 关键不变量：list 是摘录锚点「.md 真不在」的唯一判据（boot.readNoteLinks
// 把结果交给 links 的孤儿剪除）——读目录失败必须上抛，绝不能谎报空列表，
// 否则一次瞬时 IO 失败会把整本书的侧车锚点剪光
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotes } from '../bridge/notes-core.mjs'
import { createMemFs } from './mem-fs.mjs'

const ID = '00000000-0000-4000-8000-000000000001'
const DIR = `notes/${ID}`

function harness () {
  const fs = createMemFs()
  return { fs, notes: createNotes({ fs }) }
}

test('list：目录不存在 → 空列表（正常空态，目录由 createNote 懒建）', async () => {
  const { notes } = harness()
  assert.deepEqual(await notes.list(ID), { notes: [] })
})

test('list：目录存在但为空 → 空列表', async () => {
  const { fs, notes } = harness()
  await fs.mkdirp(DIR)
  assert.deepEqual(await notes.list(ID), { notes: [] })
})

test('list：只列 .md、按 mtime 倒序，子目录与非 md 被排除', async () => {
  const { fs, notes } = harness()
  await fs.mkdirp(DIR)
  fs.files.set(`${DIR}/old.md`, { data: Buffer.from('a'), mtime: 1000 })
  fs.files.set(`${DIR}/new.md`, { data: Buffer.from('b'), mtime: 2000 })
  fs.files.set(`${DIR}/note.txt`, { data: Buffer.from('c'), mtime: 3000 })
  fs.files.set(`${DIR}/sub`, { isDir: true, mtime: 4000 })
  const r = await notes.list(ID)
  assert.deepEqual(r.notes.map(n => n.file), ['new.md', 'old.md'])
})

test('list：读目录失败（非「不存在」）必须上抛，不能谎报空列表', async () => {
  const inner = createMemFs()
  await inner.mkdirp(DIR)
  const fs = { ...inner, async readdir () { throw new Error('EIO: 模拟瞬时读失败') } }
  const notes = createNotes({ fs })
  await assert.rejects(() => notes.list(ID))
})

test('list：读目录报「不存在」→ 空列表（对齐本机 IONFILE DoesNotExist 文案）', async () => {
  const inner = createMemFs()
  const fs = {
    ...inner,
    async readdir () { throw new Error(`'readdir' failed because file at 'SolaceLibrary/${DIR}' does not exist.`) }
  }
  const notes = createNotes({ fs })
  assert.deepEqual(await notes.list(ID), { notes: [] })
})

test('list：单文件 stat 失败仍进列表（漏出会被孤儿剪除误删锚点）', async () => {
  const inner = createMemFs()
  await inner.mkdirp(DIR)
  inner.files.set(`${DIR}/ok.md`, { data: Buffer.from('a'), mtime: 1000 })
  inner.files.set(`${DIR}/flaky.md`, { data: Buffer.from('b'), mtime: 2000 })
  const fs = {
    ...inner,
    async stat (p) {
      if (p.endsWith('flaky.md')) throw new Error('EIO: 模拟 stat 失败')
      return inner.stat(p)
    }
  }
  const notes = createNotes({ fs })
  const r = await notes.list(ID)
  const flaky = r.notes.find(n => n.file === 'flaky.md')
  assert.ok(flaky, 'stat 失败的文件被漏出列表：它对应的锚点会被孤儿剪除误删')
  assert.equal(flaky.mtime, null)
  assert.equal(flaky.size, 0)
})
