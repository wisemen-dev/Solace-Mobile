// 记录 md 生成/解析（mobile-web/js/mobile/link-md.mjs）单测：往返一致、
// 降级（普通笔记/被手改）、空摘录、摘录文本归一化、章总结【总结】头（v2）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateRecordMd, generateSummaryMd, parseRecordMd } from '../mobile-web/js/mobile/link-md.mjs'

test('generate→parse 往返：摘录与正文逐字一致', () => {
  const excerpts = [
    { page: 3, text: '第一句原文……', hint: { item: 12, char: 0 } },
    { page: 5, text: '第二句原文……' }
  ]
  const body = '我的想法。\n\n第二段。'
  const md = generateRecordMd(excerpts, body)
  assert.ok(md.startsWith('> 【摘录】第 3 页\n> 第一句原文……\n> 【摘录】第 5 页\n> 第二句原文……\n\n'))
  const r = parseRecordMd(md)
  assert.equal(r.ok, true)
  assert.equal(r.body, body)
})

test('generate：摘录文本空白归一化为单行', () => {
  const md = generateRecordMd([{ page: 1, text: '  两\n行  文本 ' }], '')
  assert.ok(md.includes('> 两 行 文本\n'))
})

test('generate：空摘录 = 纯正文（普通笔记形态）', () => {
  const md = generateRecordMd([], '只有正文')
  assert.equal(md, '只有正文')
  assert.equal(parseRecordMd(md).ok, false)
})

test('parse 降级：普通笔记（无摘录区）→ ok=false 且 body=全文', () => {
  const src = '# 《书》笔记\n\n- 创建：2026-10-03\n\n随手写的一段'
  const r = parseRecordMd(src)
  assert.equal(r.ok, false)
  assert.equal(r.body, src)
})

test('parse 降级：以引用开头的普通笔记（有 > 行但无【摘录】）→ ok=false', () => {
  const src = '> 用户自己写的引用\n\n正文'
  assert.equal(parseRecordMd(src).ok, false)
})

test('parse：正文保留内部空行与尾部换行', () => {
  const md = '> 【摘录】第 1 页\n> 句子\n\n\n正文第一行\n\n正文第三行\n'
  const r = parseRecordMd(md)
  assert.equal(r.ok, true)
  assert.equal(r.body, '\n正文第一行\n\n正文第三行\n')
})

test('摘录与正文分隔后不吞引用，保留正文开头空行', () => {
  for (const body of ['> 我的引用\n\n继续正文', '> 全文是引用\n> 第二行', '\n\n> 引用\n', '']) {
    const parsed = parseRecordMd(generateRecordMd([{ page: 1, text: '原文。' }], body))
    assert.equal(parsed.ok, true)
    assert.equal(parsed.body, body)
  }
})

test('parse：CRLF 行尾（桌面 Typora 保存）不误判降级', () => {
  const md = '> 【摘录】第 3 页\r\n> 原文句子。\r\n\r\n正文第一行\r\n'
  const r = parseRecordMd(md)
  assert.equal(r.ok, true)
  assert.equal(r.body, '正文第一行\r\n')
})

/* ---- 章总结（READING-RECORDS-DESIGN §7.1）---- */

test('总结 generate→parse 往返：kind=summary 且正文逐字一致', () => {
  const md = generateSummaryMd({ page: 45, chapter: '第 3 章 · 检索增强生成' }, '本章的主线是……\n\n第二段')
  assert.equal(md, '> 【总结】第 45 页\n> 第 3 章 · 检索增强生成\n\n本章的主线是……\n\n第二段')
  const r = parseRecordMd(md)
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'summary')
  assert.equal(r.body, '本章的主线是……\n\n第二段')
})

test('总结 generate：章名空白归一化、超长截 60、页码下取整兜底', () => {
  const md = generateSummaryMd({ page: '45.7', chapter: '  两\n行  章 名 ' + '长'.repeat(80) }, '正文')
  assert.ok(md.startsWith('> 【总结】第 45 页\n> 两 行 章 名 '))
  assert.ok(md.split('\n')[1].length <= 62) // 「> 」+ 章名 60
  assert.equal(parseRecordMd(generateSummaryMd({ page: 1, chapter: 'x' }, '')).kind, 'summary')
})

test('总结 parse：CRLF 行尾不误判降级', () => {
  const md = '> 【总结】第 3 页\r\n> 第 3 章\r\n\r\n总结正文\r\n'
  const r = parseRecordMd(md)
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'summary')
  assert.equal(r.body, '总结正文\r\n')
})

test('parse kind 区分：摘录记录 → excerpt，旧断言（ok/body）不受影响', () => {
  const r = parseRecordMd(generateRecordMd([{ page: 2, text: '原文' }], '批注'))
  assert.equal(r.kind, 'excerpt')
  assert.equal(parseRecordMd('普通笔记').kind, undefined)
})

test('总结正文含引用行：头区后首个非 > 行起为正文（不吞内部空行）', () => {
  const md = generateSummaryMd({ page: 9, chapter: '第 9 章' }, '\n> 总结里引用的句子\n收尾')
  const r = parseRecordMd(md)
  assert.equal(r.ok, true)
  assert.equal(r.body, '\n> 总结里引用的句子\n收尾')
})
