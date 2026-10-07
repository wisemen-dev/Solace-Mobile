// 橡皮局部擦拭（mobile-web/js/mobile/ink-erase.mjs）单测：
// 切割几何、字段继承、叠加笔宽命中、短段丢弃、压感三元组保形
//（四项拍板 2026-10-07：三档尺寸/叠加笔宽/局部切割/光圈另测渲染层）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitStroke } from '../mobile-web/js/mobile/ink-erase.mjs'

// 横线 10 点：x = 0,10,...,90，y = 50
const line = (pressure) => ({
  tool: 'pen', color: '#e03131', width: 2.5, pressure,
  pts: Array.from({ length: 10 }, (_, i) => pressure ? [i * 10, 50, 0.5] : [i * 10, 50]).flat()
})

test('未命中返回 null（原笔不动）', () => {
  assert.equal(splitStroke(line(0), 500, 500, 14), null)
})

test('中段切割成两段：继承字段、pts 按采样切片、区间正确', () => {
  const segs = splitStroke(line(0), 50, 50, 8) // 圆心在线中点 (50,50)，有效半径 8+1.25=9.25 → 命中 x=50
  assert.equal(segs.length, 2)
  for (const s of segs) {
    assert.equal(s.tool, 'pen'); assert.equal(s.color, '#e03131')
    assert.equal(s.width, 2.5); assert.equal(s.pressure, 0)
  }
  assert.deepEqual(segs[0].pts, [0, 50, 10, 50, 20, 50, 30, 50, 40, 50]) // 采样 0-4
  assert.deepEqual(segs[1].pts, [60, 50, 70, 50, 80, 50, 90, 50])         // 采样 6-9
})

test('端点切割：只剩一段（尾部被抹掉）', () => {
  const segs = splitStroke(line(0), 2, 50, 8) // 圆心压在起点附近，有效半径 9.25 → 抹掉 x=0,10
  assert.equal(segs.length, 1)
  assert.deepEqual(segs[0].pts[0], 20) // 从 x=20 起幸存
})

test('全覆盖返回 []：整笔擦净', () => {
  const big = splitStroke(line(0), 45, 50, 60)
  assert.deepEqual(big, [])
})

test('叠加笔宽：中心线偏出橡皮半径但在 r+width/2 内仍命中', () => {
  const hl = { tool: 'hl', color: '#fff00a', width: 18, pressure: 0, pts: [0, 50, 10, 50, 20, 50, 30, 50, 40, 50] }
  // 橡皮 r=8、笔宽 18 → 有效 17；圆心 (0, 33) 距线 17 → 恰好命中首点
  const segs = splitStroke(hl, 0, 33, 8)
  assert.ok(Array.isArray(segs))
  assert.ok(!segs.length || segs[0].pts[0] === 10) // 首点被抹，从第二点起幸存
  // 对照：不叠加笔宽（width=0）时同位置不命中
  const miss = splitStroke({ ...hl, width: 0 }, 0, 33, 8)
  assert.equal(miss, null)
})

test('孤立单点段丢弃：中间被隔离的单个幸存采样不产生碎段', () => {
  // 圆心 (50,50) r 巨大覆盖除 x=50 外全部……改为构造：三个圆依次无法表达，直接构造 pts
  // 用一个大圆抹掉两端 + 留中间一点：pts = [0,0, 100,100, 200,200]，圆心 (0,0) r 覆盖 0；圆心 (200,200) 覆盖 2
  const s = { tool: 'pen', color: '#000', width: 0, pressure: 0, pts: [0, 0, 100, 100, 200, 200] }
  const a = splitStroke(s, 0, 0, 1)
  assert.ok(Array.isArray(a) && a.length === 1 && a[0].pts.length === 4, '先抹首点剩两点段')
  const b = splitStroke(a[0], 200, 200, 1)
  assert.deepEqual(b, [], '再抹尾点：单点段丢弃 → 整笔擦净')
})

test('压感三元组：切割保 p 值与 stride 对齐', () => {
  const segs = splitStroke(line(1), 50, 50, 8)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].pressure, 1)
  assert.deepEqual(segs[0].pts.slice(-3), [40, 50, 0.5])
  assert.deepEqual(segs[1].pts.slice(0, 3), [60, 50, 0.5])
})

test('单点笔画整笔入圆 → []（点按擦除点）', () => {
  assert.deepEqual(splitStroke({ tool: 'pen', color: '#000', width: 2, pressure: 0, pts: [10, 10] }, 10, 10, 8), [])
})
