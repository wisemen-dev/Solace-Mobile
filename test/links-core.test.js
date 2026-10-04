// 摘录链接数据层（bridge/links-core.mjs）单测：空读、setEntry/removeEntry
// 回环、孤儿剪除、损坏留档、白名单、文件名校验、并发写串行化、空表删文件
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLinks } from '../bridge/links-core.mjs'
import { createMemFs } from './mem-fs.mjs'

const ID = '00000000-0000-4000-8000-000000000001'
const FILE = '2026-10-03 10.00.00.md'
const ENTRY = { excerpts: [{ page: 3, text: '第一句原文……', hint: { item: 12, char: 0 } }] }

function harness () {
  const fs = createMemFs()
  return { fs, links: createLinks({ fs }) }
}

test('readPruned 保留损坏告示，剪除和读取不重复加载坏文件', async () => {
  const { fs, links } = harness()
  await fs.writeText(`links/${ID}.json`, '{bad')
  const data = await links.readPruned(ID, new Set([FILE]))
  assert.ok(data.notice?.includes('损坏'))
  assert.deepEqual(data.records, {})
  assert.ok(await fs.exists(`links/${ID}.corrupt-1.json`))
  assert.equal(await fs.exists(`links/${ID}.json`), false)
})

test('readPruned 返回剪除后的数据，只在有孤儿时写回', async () => {
  const { fs, links } = harness()
  await links.setEntry(ID, FILE, ENTRY)
  await links.setEntry(ID, 'orphan.md', ENTRY)
  const data = await links.readPruned(ID, new Set([FILE]))
  assert.deepEqual(Object.keys(data.records), [FILE])
  assert.deepEqual((await links.read(ID)).records, data.records)
  const write = fs.writeFileAtomicText
  let writes = 0
  fs.writeFileAtomicText = (...args) => { writes++; return write(...args) }
  await links.readPruned(ID, new Set([FILE]))
  assert.equal(writes, 0)
})

test('read：无文件返回空结构，不预建文件', async () => {
  const { fs, links } = harness()
  assert.deepEqual(await links.read(ID), { version: 1, records: {} })
  assert.equal(await fs.exists(`links/${ID}.json`), false)
})

test('setEntry→read 回环：条目逐字段一致', async () => {
  const { links } = harness()
  await links.setEntry(ID, FILE, ENTRY)
  assert.deepEqual((await links.read(ID)).records[FILE], ENTRY)
})

test('setEntry(null)：删条目；最后一条删除后文件被删', async () => {
  const { fs, links } = harness()
  await links.setEntry(ID, FILE, ENTRY)
  await links.setEntry(ID, FILE, null)
  assert.deepEqual((await links.read(ID)).records, {})
  assert.equal(await fs.exists(`links/${ID}.json`), false)
})

test('read 纯读不剪除；pruneOrphans 剪除孤儿并写回（无孤儿不写）', async () => {
  const { fs, links } = harness()
  await links.setEntry(ID, FILE, ENTRY)
  await links.setEntry(ID, 'gone.md', ENTRY)
  assert.equal(Object.keys((await links.read(ID)).records).length, 2, 'read 不应动盘')
  assert.equal(await links.pruneOrphans(ID, new Set([FILE])), true)
  const raw = JSON.parse(await fs.readFileText(`links/${ID}.json`))
  assert.deepEqual(Object.keys(raw.records), [FILE])
  assert.equal(await links.pruneOrphans(ID, new Set([FILE])), false, '无孤儿时不应写回')
})

test('损坏：留档 corrupt-1 + 空回退 + notice', async () => {
  const { fs, links } = harness()
  await fs.mkdirp('links')
  await fs.writeText(`links/${ID}.json`, '{oops')
  const res = await links.read(ID)
  assert.deepEqual(res.records, {})
  assert.ok(res.notice && res.notice.includes('损坏'))
  assert.equal(await fs.exists(`links/${ID}.corrupt-1.json`), true)
  assert.equal(await fs.exists(`links/${ID}.json`), false)
})

test('setEntry 在损坏文件上：先留档再写新数据，不丢原文件', async () => {
  const { fs, links } = harness()
  await fs.mkdirp('links')
  await fs.writeText(`links/${ID}.json`, '{oops')
  await links.setEntry(ID, FILE, ENTRY)
  assert.equal(await fs.exists(`links/${ID}.corrupt-1.json`), true)
  assert.deepEqual((await links.read(ID)).records[FILE], ENTRY)
})

test('docId 白名单与文件名校验：非法一律拒绝', async () => {
  const { links } = harness()
  await assert.rejects(() => links.read('../evil'))
  await assert.rejects(() => links.setEntry(ID, 'a/b.md', ENTRY))
  await assert.rejects(() => links.setEntry(ID, 'note.txt', ENTRY))
  await assert.rejects(() => links.setEntry(ID, '', ENTRY))
  // 与 notes-core notePath 的约束对齐：以 . 开头、首尾空白一律拒绝，
  // 否则会存下 notes 侧永远匹配不上的孤儿条目。内部空格必须放行
  // （notes-core 生成的文件名形如 `2026-10-03 10.00.00.md`）
  await assert.rejects(() => links.setEntry(ID, '.hidden.md', ENTRY))
  await assert.rejects(() => links.setEntry(ID, ' x.md', ENTRY))
  await assert.rejects(() => links.setEntry(ID, 'x.md ', ENTRY))
  await assert.rejects(() => links.removeEntry(ID, '../evil.md'))
})

test('entry 校验：空摘录/坏页码/坏 hint 拒绝', async () => {
  const { links } = harness()
  await assert.rejects(() => links.setEntry(ID, FILE, { excerpts: [] }))
  await assert.rejects(() => links.setEntry(ID, FILE, { excerpts: [{ page: 0, text: 'x' }] }))
  await assert.rejects(() => links.setEntry(ID, FILE, { excerpts: [{ page: 1, text: '   ' }] }))
  await assert.rejects(() => links.setEntry(ID, FILE, { excerpts: [{ page: 1, text: 'x', hint: { item: 1 } }] }))
})

test('并发 setEntry 串行化：两条都落盘', async () => {
  const { links } = harness()
  await Promise.all([
    links.setEntry(ID, 'a.md', ENTRY),
    links.setEntry(ID, 'b.md', ENTRY)
  ])
  const r = (await links.read(ID)).records
  assert.deepEqual(Object.keys(r).sort(), ['a.md', 'b.md'])
})
