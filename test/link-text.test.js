import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPageText, offsetToItem, splitSentences, sentenceAt,
  normalizeText, buildSearchIndex, findRangeByText,
  makeFreeSelection, stepEndpoint
} from '../mobile-web/js/mobile/link-text.mjs'

const items = [
  { str: 'Hello world. ', hasEOL: false },
  { str: 'Second one!', hasEOL: true },
  { str: 'Next line.', hasEOL: false }
]

test('buildPageText：hasEOL 插换行，spans 映射原文区间', () => {
  // 'Hello world. ' 是 13 字符（计划原文按 14 记，连带 span 区间整体错位一位）
  const { text, spans } = buildPageText(items)
  assert.equal(text, 'Hello world. Second one!\nNext line.')
  assert.deepEqual(spans[0], { start: 0, end: 13 })
  assert.deepEqual(spans[1], { start: 13, end: 24 })
  assert.deepEqual(spans[2], { start: 25, end: 35 })
})

test('offsetToItem：普通偏移与换行间隙（归前项末尾）', () => {
  const { spans } = buildPageText(items)
  assert.deepEqual(offsetToItem(spans, 0), { item: 0, char: 0 })
  assert.deepEqual(offsetToItem(spans, 12), { item: 0, char: 12 })
  assert.deepEqual(offsetToItem(spans, 24), { item: 1, char: 11 }) // 换行位置
  assert.deepEqual(offsetToItem(spans, 25), { item: 2, char: 0 })
  assert.deepEqual(offsetToItem(spans, 999), { item: 2, char: 10 })
})

test('splitSentences：中英混合断句', () => {
  const t = '第一句。第二句！第三段；完整。End of line. 结束'
  const s = splitSentences(t)
  assert.equal(s.map(r => t.slice(r.start, r.end)).join('|'),
    '第一句。|第二句！|第三段；|完整。|End of line. |结束')
})

test('splitSentences：小数点不断、句末点断、换行断', () => {
  const t = 'Version 3.14 is stable. Next line\n新行句子'
  const s = splitSentences(t)
  assert.equal(s.map(r => t.slice(r.start, r.end)).join('|'),
    'Version 3.14 is stable. |Next line\n|新行句子')
})

test('splitSentences：收尾引号/括号并入前句', () => {
  const t = '他说：『好。』然后走了'
  const s = splitSentences(t)
  assert.equal(s.map(r => t.slice(r.start, r.end)).join('|'), '他说：『好。』|然后走了')
})

test('splitSentences 分区连续覆盖', () => {
  const t = 'ab。cd'
  const s = splitSentences(t)
  assert.equal(s[0].start, 0)
  assert.equal(s[0].end, s[1].start)
  assert.equal(s[s.length - 1].end, t.length)
})

test('sentenceAt：任意偏移落回正确句', () => {
  const t = '第一句。第二句。'
  const s = splitSentences(t)
  assert.equal(sentenceAt(s, 0), 0)
  assert.equal(sentenceAt(s, 3), 0)
  assert.equal(sentenceAt(s, 4), 1)
})

test('normalizeText 与 buildSearchIndex 映射', () => {
  assert.equal(normalizeText('  a\n\nb '), 'a b')
  const { norm, back } = buildSearchIndex('a\n\nb')
  assert.equal(norm, 'a b')
  assert.deepEqual(back, [0, 1, 3, 4]) // norm[i] 的原文偏移 + 末尾哨兵
})

test('findRangeByText：唯一命中 / 多处命中按 hint 就近 / 未命中', () => {
  const t = 'alpha beta alpha gamma'
  assert.deepEqual(findRangeByText(t, 'gamma'), { start: 17, end: 22 })
  const r1 = findRangeByText(t, 'alpha', 0)
  assert.deepEqual(r1, { start: 0, end: 5 })
  const r2 = findRangeByText(t, 'alpha', 11)
  assert.deepEqual(r2, { start: 11, end: 16 })
  assert.equal(findRangeByText(t, 'delta'), null)
  assert.equal(findRangeByText(t, '   '), null)
})

test('findRangeByText：跨行目标（搜索侧归一化匹配）', () => {
  // 范围是原文半开区间 [start,end)：end=back[pick+len] 落在匹配后的
  // 第一个原文字符上，故不含尾随空白——与上一条 'alpha'→{0,5} 同一口径
  const t = 'one\ntwo three'
  assert.deepEqual(findRangeByText(t, 'one two'), { start: 0, end: 7 })
})

/* ---- 自由选区（§6.6）：makeFreeSelection / stepEndpoint / 任意范围重锚定 ---- */

test('makeFreeSelection：方向无关、空白归一、hint 取起点；空选区返回 null', () => {
  const items = [{ str: '第一句。' }, { str: '第二句 words', hasEOL: true }, { str: '第三行' }]
  const { text, spans } = buildPageText(items)
  // item0 [0,4) item1 [4,14)+\n item2 [15,18)
  const s = makeFreeSelection(text, spans, 4, 11) // 顺向：'第二句 wor'
  assert.equal(s.text, '第二句 wor')
  assert.deepEqual(s.hint, { item: 1, char: 0 })
  const r = makeFreeSelection(text, spans, 11, 4) // 逆向同范围
  assert.equal(r.text, s.text)
  assert.deepEqual(r.hint, s.hint)
  const cross = makeFreeSelection(text, spans, 2, 17) // 跨三个 item，含 \n
  assert.equal(cross.text, '句。第二句 words 第三行')
  assert.equal(makeFreeSelection(text, spans, 9, 9), null) // 空
  assert.equal(makeFreeSelection(text, spans, 13, 14), null) // 仅一个换行符（索引 13 是 \n）
  const clamped = makeFreeSelection(text, spans, -5, 999) // 越界 clamp
  assert.ok(clamped.text.startsWith('第一句'))
})

test('makeFreeSelection → findRangeByText 往返：任意子串能重锚定回同一范围', () => {
  const items = [{ str: 'alpha beta' }, { str: 'gamma', hasEOL: true }, { str: 'delta end' }]
  const { text, spans } = buildPageText(items)
  for (const [a, b] of [[0, 10], [6, 15], [2, 20], [11, 16]]) {
    const sel = makeFreeSelection(text, spans, a, b)
    const hint = spans[sel.hint.item].start + sel.hint.char
    const r = findRangeByText(text, sel.text, hint)
    assert.ok(r, `range ${a}-${b} 应能重锚定`)
    assert.equal(text.slice(r.start, r.end).replace(/\s+/g, ' ').trim(), sel.text)
  }
})

test('stepEndpoint：向外步进一字并跳过空白，边界 clamp', () => {
  const t = 'abc  def\nghi'
  assert.equal(stepEndpoint(t, 5, -1), 2)  // 'd' 前有双空格：跳过后再纳入 'c'
  assert.equal(stepEndpoint(t, 0, -1), 0)  // 左边界
  assert.equal(stepEndpoint(t, 8, 1), 10)  // 换行后第一个实字 'g' 被纳入
  assert.equal(stepEndpoint(t, 12, 1), 12) // 右边界
})
