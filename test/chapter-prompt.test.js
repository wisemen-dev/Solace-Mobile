// 章界与跨章判定（mobile-web/js/mobile/chapter-prompt.mjs）单测：
// 顶级章表构建、页→章归属、向前跨界检测、短章守卫（§5.1）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { topChapters, chapterIndexAt, chapterLongEnough, detectCross } from '../mobile-web/js/mobile/chapter-prompt.mjs'

const OUTLINE = [
  { title: '前言', page: 3, depth: 0 },
  { title: '第 1 章 基础', page: 10, depth: 0 },
  { title: '1.1 小节', page: 11, depth: 1 },
  { title: '1.2 小节', page: 14, depth: 1 },
  { title: '第 2 章 进阶', page: 40, depth: 0 },
  { title: '2.1 小节', page: 41, depth: 1 },
  { title: '第 3 章 实战', page: 90, depth: 0 }
]

test('topChapters：只取顶级、页码有效、标题非空，按页升序', () => {
  const ch = topChapters(OUTLINE)
  assert.deepEqual(ch.map(c => c.title), ['前言', '第 1 章 基础', '第 2 章 进阶', '第 3 章 实战'])
  assert.deepEqual(ch.map(c => c.page), [3, 10, 40, 90])
})

test('topChapters：剔除无效条目（非整数页/空标题/缺字段）并同页去重', () => {
  const ch = topChapters([
    { title: 'A', page: 5, depth: 0 },
    { title: 'B', page: 5, depth: 0 },      // 与 A 同页 → 去重保首个
    { title: '', page: 8, depth: 0 },        // 空标题
    { title: 'C', page: 1.5, depth: 0 },     // 非整数页
    { title: 'D', page: 12, depth: 0 },
    { title: 'E', page: 12 },                // 缺 depth → 非顶级
    null
  ])
  assert.deepEqual(ch.map(c => c.title), ['A', 'D'])
})

test('topChapters：标题空白归一化并截 40 字', () => {
  const ch = topChapters([{ title: '  两\n行  名 ', page: 2, depth: 0 }])
  assert.equal(ch[0].title, '两 行 名')
  assert.equal(topChapters([{ title: '长'.repeat(50), page: 2, depth: 0 }])[0].title.length, 40)
})

test('chapterIndexAt：章起页前 = -1（前言区/封面），边界页归本章', () => {
  const ch = topChapters(OUTLINE)
  assert.equal(chapterIndexAt(ch, 1), -1)   // 第 3 页「前言」之前
  assert.equal(chapterIndexAt(ch, 3), 0)
  assert.equal(chapterIndexAt(ch, 9), 0)
  assert.equal(chapterIndexAt(ch, 10), 1)   // 第 1 章起页
  assert.equal(chapterIndexAt(ch, 39), 1)
  assert.equal(chapterIndexAt(ch, 200), 3)  // 末章之后归末章
  assert.equal(chapterIndexAt(ch, null), -1)
})

test('detectCross：向前跨界返回被离开章；后退/同章/跨回不触发', () => {
  const ch = topChapters(OUTLINE)
  assert.equal(detectCross(ch, 35, 40), 1)   // 第 1 章末 → 第 2 章起：离开第 1 章
  assert.equal(detectCross(ch, 40, 35), -1)  // 后退不提示
  assert.equal(detectCross(ch, 11, 14), -1)  // 章内小节间移动
  assert.equal(detectCross(ch, 80, 95), 2)   // 跳多章：只提被离开的第 2 章
  assert.equal(detectCross(ch, 80, 90), 2)
})

test('detectCross：封面区（首个顶级条目之前）翻进前言不提示；前言→第 1 章提示前言', () => {
  const ch = topChapters(OUTLINE)
  assert.equal(detectCross(ch, 1, 5), -1)   // 页 1 在任何顶级条目之前 → 无被离开的章
  assert.equal(detectCross(ch, 5, 10), 0)   // 前言（顶级条目）被离开 → 提示它
})

test('chapterLongEnough：章长（下一章起页差）≥4 页才提示；末章恒足够', () => {
  const ch = [
    { title: 'A', page: 10 },
    { title: 'B', page: 13 },  // A 长 3 页 → 不够
    { title: 'C', page: 17 },  // B 长 4 页 → 够
    { title: 'D', page: 30 }
  ]
  assert.equal(chapterLongEnough(ch, 0), false)
  assert.equal(chapterLongEnough(ch, 1), true)
  assert.equal(chapterLongEnough(ch, 3), true)  // 末章无下界
  assert.equal(chapterLongEnough(ch, -1), false)
  assert.equal(chapterLongEnough([], 0), false)
})
