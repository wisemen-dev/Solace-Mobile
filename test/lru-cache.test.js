// LRU 缓存（mobile-web/js/mobile/lru-cache.mjs）单测：命中/未命中口径、
// 容量驱逐、重插刷新时序、假值不误判 miss（第四轮审查 Standards-5 抽取）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeLru } from '../mobile-web/js/mobile/lru-cache.mjs'

test('miss 返回 undefined，命中返回值（含空串假值）', () => {
  const lru = makeLru(3)
  assert.equal(lru.get('a'), undefined)
  lru.set('a', '')
  assert.equal(lru.get('a'), '')        // 空串是缓存值不是 miss
  assert.equal(lru.has('a'), true)
  assert.equal(lru.size, 1)
})

test('超容量驱逐最旧', () => {
  const lru = makeLru(2)
  lru.set('a', 1); lru.set('b', 2); lru.set('c', 3)
  assert.equal(lru.has('a'), false)
  assert.equal(lru.get('b'), 2)
  assert.equal(lru.get('c'), 3)
})

test('get 重插刷新使用时序：旧键被访问后不被驱逐', () => {
  const lru = makeLru(2)
  lru.set('a', 1); lru.set('b', 2)
  lru.get('a')                          // a 变为最近使用
  lru.set('c', 3)                       // 驱逐的应是 b
  assert.equal(lru.has('b'), false)
  assert.equal(lru.get('a'), 1)
})

test('set 已存在键 = 更新且刷新时序', () => {
  const lru = makeLru(2)
  lru.set('a', 1); lru.set('b', 2)
  lru.set('a', 9)                       // 更新并置为最近
  lru.set('c', 3)
  assert.equal(lru.get('a'), 9)
  assert.equal(lru.has('b'), false)
})
