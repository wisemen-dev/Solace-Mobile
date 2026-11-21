import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPageText, offsetToItem, splitSentences, sentenceAt,
  normalizeText, buildSearchIndex, findRangeByText,
  makeFreeSelection, stepEndpoint, pickRowBox
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

/* ---- pickRowBox（2026-11-13 bug4）：拖选 caret 落空时的行感知兜底 ---- */

// 一行两盒（A 长 B 短）+ 下一行一盒：旧版「同垂直距离取最矮盒」会把行首/
// 行尾空白处的指针命中到短盒 B 的起/终点，端点整段错位
const ROW1 = [
  { item: 0, top: 100, bottom: 130, left: 40, right: 400 },  // A：长盒
  { item: 1, top: 100, bottom: 130, left: 420, right: 460 }   // B：短盒
]
const ROW2 = [{ item: 2, top: 150, bottom: 180, left: 40, right: 300 }]

test('pickRowBox：行内取水平最近盒——行首/行尾空白不再命中短盒', () => {
  // x 在行首空白（A 左侧 20px）：A 近（dx=20）远胜 B（dx=440），端点 = start
  assert.deepEqual(pickRowBox([...ROW1, ...ROW2], 20, 115), { item: 0, edge: 'start' })
  // x 在行尾空白（B 右侧 30px）：命中 B 的 end（短盒是水平最近者，胜者即正确）
  assert.deepEqual(pickRowBox([...ROW1, ...ROW2], 490, 115), { item: 1, edge: 'end' })
  // x 在两盒之间的行间隙（410）：A 右缘距 10、B 左缘距 10——水平打平，
  // 盒高同分，先登记者胜；任一盒的端点都比旧版「全场最矮盒」更贴近指针
  const mid = pickRowBox([...ROW1, ...ROW2], 410, 115)
  assert.ok(mid.item === 0 || mid.item === 1, '间隙命中应留在本行两盒之一')
})

test('pickRowBox：垂直优先锁行，盒内按中线取端，多行大盒不越权', () => {
  // y 在行 2：即便 x 落在行 1 某盒正下方延长线（对行 1 盒 dx=0），垂直距离
  // 50 胜出锁行 2；行 2 盒中线 = 170，x 过中线取 end、未过取 start
  assert.deepEqual(pickRowBox([...ROW1, ...ROW2], 100, 165), { item: 2, edge: 'start' })
  assert.deepEqual(pickRowBox([...ROW1, ...ROW2], 200, 160), { item: 2, edge: 'end' })
  assert.deepEqual(pickRowBox([...ROW1, ...ROW2], 50, 160), { item: 2, edge: 'start' })
  // 多行大盒（垂直罩住两行）：y 在其范围内时它是 dy=0 候选，但矮盒同 dy
  // 时按千分位盒高次优选矮盒（行级更精确）
  const tall = { item: 9, top: 95, bottom: 185, left: 500, right: 700 }
  assert.equal(pickRowBox([...ROW1, ...ROW2, tall], 100, 115).item, 0)
  // 空表安全
  assert.equal(pickRowBox([], 10, 10), null)
})

/* ---- pickRowBox 补充（审查 2026-11-13）：key 权重与边界口径 ---- */

test('pickRowBox：同 dy 同 dx 全同分——末位盒高千分位决胜，矮盒（行级更精确）胜', () => {
  // 既有「多行大盒」用例实际靠 dx 分差取胜（tall dx=400 vs A dx=60），并未
  // 真正走到 key 末位；本条构造 dy、dx 严格打平，逼出 min(h,200)/1000 决胜。
  // 两盒同 top（y 在其上方 → dy 同）、同 left/right（dx 同），仅 bottom 不同
  const box1 = { item: 0, top: 100, bottom: 130, left: 50, right: 300 }   // h=30
  const box2 = { item: 9, top: 100, bottom: 200, left: 50, right: 300 }   // h=100
  // (350,90)：dy 同 10、dx 同 50 → key 仅差 0.070（盒高项），矮盒必须胜。
  // 登记顺序无关：先矮后高 / 先高后矮结果一致（胜因是 key 而非登记序）
  assert.equal(pickRowBox([box1, box2], 350, 90).item, 0)
  assert.equal(pickRowBox([box2, box1], 350, 90).item, 0)
  // 盒高 ≥200 被 min(h,200) 截断：h=200 与 h=300 的大盒全同分——先登记者胜
  // （口径记录：此分支固化的是任意现状而非正确行为，同 D6 哨兵的标注纪律；
  // 若改为稳定决胜（如登记序无关的次级键），本断言需同步更新）。
  // 口径记录：盒高项只在 0..0.2 内决胜，超过 200px 的盒之间不再区分高矮
  const huge1 = { item: 7, top: 100, bottom: 300, left: 50, right: 300 }  // h=200
  const huge2 = { item: 8, top: 100, bottom: 400, left: 50, right: 300 }  // h=300
  assert.equal(pickRowBox([huge1, huge2], 350, 90).item, 7)
  assert.equal(pickRowBox([huge2, huge1], 350, 90).item, 8)
})

test('pickRowBox：行间隙垂直最近——dy 每 1px 压过 dx 999px，先锁行再比水平', () => {
  // y=135 离行 1（bottom=130）dy=5、离行 2（top=150）dy=15；x=290 对行 1 盒 A
  // [40,400] 与行 2 盒 [40,300] 的 dx 均为 0（都在水平范围内）→ 纯垂直距离
  // 决胜，锁行 1。x=290 过 A 中线 220 → end
  assert.deepEqual(pickRowBox([...ROW1, ...ROW2], 290, 135), { item: 0, edge: 'end' })
  // y=145 反转：离行 2 dy=5、离行 1 dy=15 → 锁行 2；x=290 过行 2 中线 170 → end
  assert.deepEqual(pickRowBox([...ROW1, ...ROW2], 290, 145), { item: 2, edge: 'end' })
  // 权重口径的极限断言：nearRow 垂直近 1px 但水平远（dx 被截到 999），farRow
  // 垂直远 1px 但水平正中（dx=0）——dy*1000 的 1000 单位仍压过 dx 上限 999，
  // 垂直更近者胜。这是「垂直 1px ≈ 水平 1000px」最锋利的反例
  const nearRow = { item: 10, top: 100, bottom: 110, left: 0, right: 10 }
  const farRow = { item: 11, top: 113, bottom: 123, left: 1900, right: 2100 }
  // (2000,111)：nearRow dy=1、dx=1990→截 999 → key 1999.010；
  //            farRow  dy=2、dx=0          → key 2000.010。nearRow 胜
  assert.deepEqual(pickRowBox([nearRow, farRow], 2000, 111), { item: 10, edge: 'end' })
  assert.deepEqual(pickRowBox([farRow, nearRow], 2000, 111), { item: 10, edge: 'end' })
})

test('pickRowBox：盒缘/中线精确落点——压线即命中（dy/dx=0），中线本身归 start', () => {
  const boxes = [...ROW1, ...ROW2]
  // 指针恰在盒边界：距离按 0 计，边缘属于盒
  assert.deepEqual(pickRowBox(boxes, 40, 100), { item: 0, edge: 'start' })   // 左上角
  assert.deepEqual(pickRowBox(boxes, 400, 130), { item: 0, edge: 'end' })    // 右下角
  // 恰在中线：x > mid 为 false → start（口径记录：中线本身归 start，非 end）
  assert.deepEqual(pickRowBox(boxes, 220, 115), { item: 0, edge: 'start' })
  assert.deepEqual(pickRowBox(boxes, 221, 115), { item: 0, edge: 'end' })
  // 零高盒（bottom===top，退化数据）：h 取 (bottom-top)||1 → 1，不产生
  // NaN/Infinity key，按普通盒参与竞争（x=110>中线105 → end）
  const zero = { item: 5, top: 200, bottom: 200, left: 100, right: 110 }
  assert.deepEqual(pickRowBox([zero], 110, 200), { item: 5, edge: 'end' })
})

test('pickRowBox：dx 999 截断的权重边界——超远同 dy 时盒高反越水平（已知缺陷 D6·口径记录，非回归断言）', () => {
  // 两盒 dy 同为 0（y 落在各自垂直范围内）。截断前（dx<999）水平最近者恒胜，
  // 与盒高无关；截断后（dx>999 双双封顶 999）水平差被抹平，key 落到盒高千分
  // 位——较矮但水平更远的盒反胜。「两盒同时 dx>999」需文本层宽 >1000px，
  // 横屏平板边缘可达（验证报告 D6 口径）。修复 D6（改 min(dx,999) 截断或
  // 盒高权重）必过本条，届时连同名称与断言一并更新
  const nearTall = { item: 0, top: 100, bottom: 220, left: 0, right: 50 }    // h=120
  const farShort = { item: 1, top: 100, bottom: 190, left: 5000, right: 5050 } // h=90
  // 截断区（x=2000）：nearTall dx=1950→999 key=999.120；farShort dx=3000→999
  // key=999.090 → farShort（较矮）胜，尽管它水平更远
  assert.equal(pickRowBox([nearTall, farShort], 2000, 150).item, 1)
  // 未截断区：把 farShort 拉近到 left=400（dx=200<999），nearTall 改为 dx=0
  // （x 落其盒内）——水平最近者（nearTall，虽 h=120 更高）胜，盒高不参与
  const nearTallIn = { item: 0, top: 100, bottom: 220, left: 0, right: 250 } // x=200 在内 dx=0
  const farShortNear = { item: 1, top: 100, bottom: 190, left: 400, right: 450 } // dx=200
  assert.equal(pickRowBox([nearTallIn, farShortNear], 200, 150).item, 0)
  assert.equal(pickRowBox([farShortNear, nearTallIn], 200, 150).item, 0)
})
