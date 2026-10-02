// 手写标注数据层（bridge/annotations-core.mjs）单测：内存 fs，验证
// 读空回环、docId 白名单、损坏留档回退、结构校验、空墨迹删文件与并发串行化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAnnotations } from '../bridge/annotations-core.mjs'
import { createMemFs } from './mem-fs.mjs'

const ID = '00000000-0000-4000-8000-000000000001'

function harness () {
  const fs = createMemFs()
  const ann = createAnnotations({ fs })
  return { fs, ann }
}

const payload = (over = {}) => ({
  version: 1,
  pages: {
    '3': {
      w: 595.28, h: 841.89,
      strokes: [
        { tool: 'pen', color: '#e03131', width: 2.5, pressure: 1, pts: [120.5, 88, 0.5, 121.1, 92.3, 0.5] },
        { tool: 'hl', color: '#fff00a', width: 12, pressure: 0, pts: [10, 20, 30, 40] }
      ]
    }
  },
  ...over
})

/* ---- 读取：默认空结构 ---- */

test('read：无墨迹文件返回空结构，不预建文件', async () => {
  const { fs, ann } = harness()
  const res = await ann.read(ID)
  assert.deepEqual(res, { version: 1, pages: {} })
  assert.equal(await fs.exists(`annotations/${ID}.json`), false)
})

/* ---- 写读回环 ---- */

test('write→read 回环：墨迹数据逐字段一致', async () => {
  const { ann } = harness()
  await ann.write(ID, payload())
  assert.deepEqual(await ann.read(ID), payload())
})

test('write：structure 深拷贝落盘，写后改入参不影响读回', async () => {
  const { ann } = harness()
  const p = payload()
  await ann.write(ID, p)
  p.pages['3'].strokes[0].color = '#000000'
  p.pages['9'] = p.pages['3']
  assert.equal((await ann.read(ID)).pages['3'].strokes[0].color, '#e03131')
  assert.equal((await ann.read(ID)).pages['9'], undefined)
})

/* ---- docId 白名单 ---- */

test('docId 白名单：路径穿越与非 UUID 形状一律拒绝', async () => {
  const { ann } = harness()
  for (const bad of ['../evil', 'a/b', '', 'x'.repeat(65), 'a b', '.hidden', 'notes.json']) {
    await assert.rejects(() => ann.read(bad))
    await assert.rejects(() => ann.write(bad, payload()))
  }
})

/* ---- 损坏回退 ---- */

test('损坏回退：坏 JSON 留档为 corrupt-1 并返回空墨迹与 notice', async () => {
  const { fs, ann } = harness()
  await fs.mkdirp('annotations')
  await fs.writeText(`annotations/${ID}.json`, '{oops')
  const res = await ann.read(ID)
  assert.deepEqual({ version: res.version, pages: res.pages }, { version: 1, pages: {} })
  assert.ok(res.notice && res.notice.includes('损坏'))
  assert.equal(await fs.exists(`annotations/${ID}.corrupt-1.json`), true)
  assert.equal(await fs.exists(`annotations/${ID}.json`), false)
})

test('损坏留档顺延编号：第二次损坏不覆盖第一次', async () => {
  const { fs, ann } = harness()
  await fs.mkdirp('annotations')
  await fs.writeText(`annotations/${ID}.json`, '{bad-1')
  await ann.read(ID)
  await fs.writeText(`annotations/${ID}.json`, '{bad-2')
  await ann.read(ID)
  assert.equal(await fs.exists(`annotations/${ID}.corrupt-1.json`), true)
  assert.equal(await fs.exists(`annotations/${ID}.corrupt-2.json`), true)
})

test('损坏后写回不覆盖留档：主文件恢复、留档仍在', async () => {
  const { fs, ann } = harness()
  await fs.mkdirp('annotations')
  await fs.writeText(`annotations/${ID}.json`, '{bad')
  await ann.read(ID)
  await ann.write(ID, payload())
  assert.deepEqual(await ann.read(ID), payload())
  assert.equal(await fs.exists(`annotations/${ID}.corrupt-1.json`), true)
})

/* ---- 结构校验 ---- */

test('结构校验：非法 payload 拒绝写盘且不落任何文件', async () => {
  const { fs, ann } = harness()
  const bad = [
    { version: 2, pages: {} },
    { version: 1, pages: [] },
    { version: 1, pages: { '3': { w: 595, h: 841, strokes: 'x' } } },
    { version: 1, pages: { '3': { w: -1, h: 841, strokes: [] } } },
    { version: 1, pages: { 'page3': { w: 595, h: 841, strokes: [] } } },
    { version: 1, pages: { '0': { w: 595, h: 841, strokes: [] } } },
    { version: 1, pages: { '3': { w: 595, h: 841, strokes: [{ tool: 'laser', color: '#000', width: 2, pressure: 0, pts: [] }] } } },
    { version: 1, pages: { '3': { w: 595, h: 841, strokes: [{ tool: 'pen', color: 5, width: 2, pressure: 0, pts: [] }] } } },
    { version: 1, pages: { '3': { w: 595, h: 841, strokes: [{ tool: 'pen', color: '#000', width: 0, pressure: 0, pts: [] }] } } },
    { version: 1, pages: { '3': { w: 595, h: 841, strokes: [{ tool: 'pen', color: '#000', width: 2, pressure: 2, pts: [] }] } } },
    { version: 1, pages: { '3': { w: 595, h: 841, strokes: [{ tool: 'pen', color: '#000', width: 2, pressure: 0, pts: '1,2' }] } } },
    null,
    'x'
  ]
  for (const p of bad) await assert.rejects(() => ann.write(ID, p))
  assert.equal(await fs.exists(`annotations/${ID}.json`), false)
})

/* ---- 空墨迹删除的失败路径 ---- */

test('空墨迹删除失败必须拒绝：rm 返回 false 不吞，防旧墨迹「复活」', async () => {
  const { ann } = harness()
  await ann.write(ID, payload())
  // rm 失败的 fs（其余委托内存实现）
  const fsFail = { ...createMemFs(), rm: async () => false }
  const annFail = createAnnotations({ fs: fsFail })
  await assert.rejects(() => annFail.write(ID, { version: 1, pages: {} }))
})

/* ---- 读错误传播 ---- */

test('读失败（文件存在但读不出）向上抛：瞬时 IO 错误不冒充「没画过」', async () => {
  const { fs, ann } = harness()
  await ann.write(ID, payload())
  const fsFail = { ...fs, readFileText: async () => { throw new Error('EIO: 瞬时错误') } }
  const annFail = createAnnotations({ fs: fsFail })
  await assert.rejects(() => annFail.read(ID))
})

test('读不存在仍返回空结构（exists 探测，不触发读）', async () => {
  const { fs, ann } = harness()
  let readCalled = false
  const fsProbe = { ...fs, readFileText: async (p) => { readCalled = true; return fs.readFileText(p) } }
  const annProbe = createAnnotations({ fs: fsProbe })
  const res = await annProbe.read(ID)
  assert.deepEqual({ version: res.version, pages: res.pages }, { version: 1, pages: {} })
  assert.equal(readCalled, false)
})

/* ---- 空墨迹删除 ---- */

test('空墨迹写回即删除文件', async () => {
  const { fs, ann } = harness()
  await ann.write(ID, payload())
  assert.equal(await fs.exists(`annotations/${ID}.json`), true)
  await ann.write(ID, { version: 1, pages: {} })
  assert.equal(await fs.exists(`annotations/${ID}.json`), false)
  // strokes 全空的页同样视为无墨迹
  await ann.write(ID, { version: 1, pages: { '1': { w: 595, h: 841, strokes: [] } } })
  assert.equal(await fs.exists(`annotations/${ID}.json`), false)
})

/* ---- 并发串行化 ---- */

test('并发写串行化：全部完成且最终落盘为最后一次调用', async () => {
  const { ann } = harness()
  const p1 = { version: 1, pages: { '1': { w: 595, h: 841, strokes: [{ tool: 'pen', color: '#111111', width: 2, pressure: 0, pts: [1, 2] }] } } }
  const p2 = { version: 1, pages: { '2': { w: 595, h: 841, strokes: [{ tool: 'pen', color: '#222222', width: 2, pressure: 0, pts: [3, 4] }] } } }
  const p3 = payload()
  await Promise.all([ann.write(ID, p1), ann.write(ID, p2), ann.write(ID, p3)])
  assert.deepEqual(await ann.read(ID), p3)
})
