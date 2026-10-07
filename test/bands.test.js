// 高亮带行聚类（mobile-web/js/mobile/bands.mjs）单测：行聚类容差、
// 混排取高、多行分片、零宽过滤、边距与垂直居中（拍板 2026-10-07 按行统一带）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupRectsToBands } from '../mobile-web/js/mobile/bands.mjs'

test('空列表与全零宽片段 → 无带', () => {
  assert.deepEqual(groupRectsToBands([]), [])
  assert.deepEqual(groupRectsToBands([{ x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0, w: 10, h: 0 }]), [])
})

test('同行多片段聚一带：x/w 取 min-max，h = 最高片段 ×1.12', () => {
  const bands = groupRectsToBands([
    { x: 10, y: 100, w: 30, h: 20 },
    { x: 60, y: 100, w: 40, h: 20 }
  ])
  assert.equal(bands.length, 1)
  assert.equal(bands[0].x, 10)
  assert.equal(bands[0].w, 90) // 到最右片段的右缘
  assert.equal(Math.round(bands[0].h * 100) / 100, 22.4) // 20×1.12
})

test('基线对齐的大小字同行必聚一带（中心差 =(h大-h小)/2 < h大/2），带高取大字', () => {
  // 大字 h=30 顶点 y=100（cy=115），小字 h=10 基线对齐 y=120（cy=125）→ 差 10 < 15
  const bands = groupRectsToBands([
    { x: 0, y: 100, w: 50, h: 30 },
    { x: 60, y: 120, w: 30, h: 10 }
  ])
  assert.equal(bands.length, 1)
  assert.equal(bands[0].h, 33.6) // 30×1.12
  assert.equal(bands[0].y, 115 - 33.6 / 2) // 带中心对齐最高片段中心
})

test('相邻等高两行必分带（中心差 = 行距 > h/2）', () => {
  const bands = groupRectsToBands([
    { x: 0, y: 0, w: 100, h: 20 },   // cy=10
    { x: 0, y: 22, w: 100, h: 20 }   // cy=32，差 22 > 10
  ])
  assert.equal(bands.length, 2)
  assert.deepEqual(bands.map(b => Math.round(b.y)), [-1, 21])
})

test('多行文本项的逐行分片各自成带', () => {
  const bands = groupRectsToBands([
    { x: 0, y: 0, w: 80, h: 16 },
    { x: 0, y: 18, w: 60, h: 16 },
    { x: 0, y: 36, w: 70, h: 16 }
  ])
  assert.equal(bands.length, 3)
})

test('自定义 pad 生效', () => {
  const [band] = groupRectsToBands([{ x: 0, y: 0, w: 10, h: 10 }], 0.4)
  assert.equal(band.h, 14)
})
