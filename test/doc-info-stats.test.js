// 简介卡统计聚合（mobile-web/js/mobile/doc-info-stats.mjs）单测：
// 摘录/总结分计数（兼有两类各计一次、文件数只计一次）、批注页数、
// 自由笔记 = .md 总数 − 有侧车条目的记录数、空/缺源容错
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { docStats } from '../mobile-web/js/mobile/doc-info-stats.mjs'

test('混合记录：摘录/总结各计数，兼有两类的文件不重复计入文件数', () => {
  const links = { records: {
    'a.md': { excerpts: [{ page: 1, text: 'x' }] },
    'b.md': { excerpts: [], summary: { page: 3, chapter: '第 1 章' } },
    'c.md': { excerpts: [{ page: 5, text: 'y' }], summary: { page: 9, chapter: '第 2 章' } },
    'd.md': { excerpts: [{ page: 7, text: 'z' }] }
  } }
  const notes = { notes: [{ file: 'a.md' }, { file: 'b.md' }, { file: 'c.md' }, { file: 'd.md' }, { file: 'free.md' }] }
  const st = docStats(links, { pages: { 1: {}, 2: {}, 9: {} } }, notes)
  assert.equal(st.excerpts, 3)
  assert.equal(st.summaries, 2)
  assert.equal(st.inkPages, 3)
  assert.equal(st.notes, 1) // free.md —— a/b/c/d 四个 .md 都有侧车条目
})

test('无侧车无标注：笔记数 = 全部 .md，其余为 0', () => {
  const st = docStats(undefined, undefined, { notes: [{ file: 'x.md' }, { file: 'y.md' }] })
  assert.deepEqual(st, { excerpts: 0, summaries: 0, inkPages: 0, notes: 2 })
})

test('孤儿条目（.md 已删但侧车还在）不计负数', () => {
  const links = { records: { 'gone.md': { excerpts: [{ page: 1, text: 'x' }] } } }
  const st = docStats(links, null, { notes: [] })
  assert.equal(st.notes, 0)
  assert.equal(st.excerpts, 1) // 侧车侧照计（展示口径与列表一致由剪除兜底）
})

test('脏数据容错：坏条目跳过、缺字段按 0', () => {
  const links = { records: { bad: null, empty: {}, ok: { summary: { page: 2, chapter: 'c' } } } }
  const st = docStats(links, {}, {})
  assert.equal(st.excerpts, 0)
  assert.equal(st.summaries, 1)
  assert.equal(st.inkPages, 0)
  assert.equal(st.notes, 0)
})
