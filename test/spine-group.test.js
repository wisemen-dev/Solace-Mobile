// 书脊分组（mobile-web/js/mobile/spine-group.mjs）单测：
// 顶级归并、组序=顶级分类序、未分类垫底、悬空 id 口径、空组跳过、
// 搜索/单组平铺、组内保序（四项拍板 2026-10-07）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupSpines } from '../mobile-web/js/mobile/spine-group.mjs'

// 分类树：B 在数组中排最前（验证组序跟数组、不跟 id 字母序），
// A 有子分类 A1、孙分类 A11（验证多级归并到顶级）
const CATS = [
  { id: 'b', name: '物理', parentId: null },
  { id: 'a', name: '数学', parentId: null },
  { id: 'a1', name: '分析', parentId: 'a' },
  { id: 'a11', name: '实分析', parentId: 'a1' },
  { id: 'z', name: '空分类', parentId: null }
]

const doc = (id, categoryId) => ({ id, categoryId })

test('顶级归并：子/孙分类的书并入顶级父组，组序=顶级分类数组序', () => {
  const docs = [doc('d1', 'a11'), doc('d2', 'b'), doc('d3', 'a'), doc('d4', 'a1')]
  const { flat, groups } = groupSpines(docs, CATS, '')
  assert.equal(flat, false)
  assert.deepEqual(groups.map(g => g.name), ['物理', '数学'])
  assert.deepEqual(groups.map(g => g.key), ['b', 'a'])
  assert.deepEqual(groups[1].docs.map(d => d.id), ['d1', 'd3', 'd4']) // 组内保持传入顺序
})

test('空分类不出组（z 无书，groups 无 z）', () => {
  const { groups } = groupSpines([doc('d1', 'a')], CATS, '')
  assert.ok(!groups.some(g => g.key === 'z'))
})

test('未分类垫底：null 与缺字段（undefined）同口径，组名「未分类」', () => {
  const docs = [doc('u1', null), doc('u2', undefined), doc('d1', 'a')]
  const { flat, groups } = groupSpines(docs, CATS, '')
  assert.equal(flat, false)
  const last = groups[groups.length - 1]
  assert.equal(last.key, null)
  assert.equal(last.name, '未分类')
  assert.deepEqual(last.docs.map(d => d.id), ['u1', 'u2'])
})

test('悬空 categoryId（指向已删分类）归入未分类', () => {
  const { groups } = groupSpines([doc('d1', 'ghost'), doc('d2', 'a')], CATS, '')
  const last = groups[groups.length - 1]
  assert.equal(last.key, null)
  assert.deepEqual(last.docs.map(d => d.id), ['d1'])
})

test('搜索关键词：平铺——全部书合成单组、保序、flat=true', () => {
  const docs = [doc('d1', 'a'), doc('d2', 'b'), doc('u1', null)]
  const { flat, groups } = groupSpines(docs, CATS, '电磁')
  assert.equal(flat, true)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, '')
  assert.deepEqual(groups[0].docs.map(d => d.id), ['d1', 'd2', 'u1'])
})

test('仅一组（如侧栏已筛到某分类）：平铺不渲染组头', () => {
  const docs = [doc('d1', 'a'), doc('d2', 'a11')]
  const { flat, groups } = groupSpines(docs, CATS, '')
  assert.equal(flat, true)
  assert.deepEqual(groups[0].docs.map(d => d.id), ['d1', 'd2'])
})

test('全库未分类 / 分类表为空：同样平铺', () => {
  assert.equal(groupSpines([doc('u1', null)], CATS, '').flat, true)
  assert.equal(groupSpines([doc('u1', null)], [], '').flat, true)
})

test('空书单：平铺且单组为空（renderDocList 对空库走 empty 态，不进此处）', () => {
  const { flat, groups } = groupSpines([], CATS, '')
  assert.equal(flat, true)
  assert.deepEqual(groups[0].docs, [])
})
