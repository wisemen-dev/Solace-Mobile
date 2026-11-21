// 摘录标记调色板跨层一致性守护（审查 2026-11-13）：color 合法区间由
// bridge/constants.mjs 的 LINK_COLOR_COUNT 定义，数据层 links-core 校验上限、
// 渲染层 link.js 的 LNK_COLORS 色板槽位数、mobile.css 的 --lnk-c<digit> 通道
// 定义三处必须同值——源码注释已点名「跨层无法共享 import，改色数三处同步」，
// 但此前无测试钉住。任一处漏改都会静默放行/拒绝错误的色号区间或画出越界色。
// 纯文本扫描（readFileSync），与 push-library/mobile-regressions 同风格，不引运行时。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

// LINK_COLOR_COUNT 唯一事实源在 bridge/constants.mjs；两条用例共用解析
// （审查 2026-11-21 去重：两处各写一遍 match 会漂移）
const linkColorCount = () =>
  Number(read('bridge/constants.mjs').match(/export const LINK_COLOR_COUNT\s*=\s*(\d+)/)[1])

function countCssChannels () {
  // 先剥块注释再扫描（审查 2026-11-21 加固）：将来注释里出现 `--lnk-c5:`
  // 样例文字不得误计入。`.lnk-cN { --lnk-c: var(--lnk-cN) }` 映射行里被设置
  // 的是无数字的 --lnk-c、var() 内是 `--lnk-cN)` 而非 `--lnk-cN:`，均不计入
  const css = read('mobile-web/css/mobile.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const set = new Set()
  for (const m of css.matchAll(/--lnk-c(\d+)\s*:/g)) set.add(m[1])
  return set.size
}

test('调色板三处同值：LINK_COLOR_COUNT == LNK_COLORS == CSS --lnk-c 通道数', () => {
  const constants = Number(read('bridge/constants.mjs').match(/export const LINK_COLOR_COUNT\s*=\s*(\d+)/)[1])
  const linkColors = Number(read('mobile-web/js/mobile/link.js').match(/const LNK_COLORS\s*=\s*(\d+)/)[1])
  const cssChannels = countCssChannels()
  assert.ok(Number.isInteger(constants) && constants > 0, 'LINK_COLOR_COUNT 应为正整数')
  assert.equal(linkColors, constants, 'link.js LNK_COLORS 与 constants.LINK_COLOR_COUNT 脱同步')
  assert.equal(cssChannels, constants, 'mobile.css --lnk-c 通道数与 LINK_COLOR_COUNT 脱同步')
})

test('调色板基线值固定为 5（0..4，0=琥珀缺省）——扩色须同步改本条与三处源码', () => {
  const constants = Number(read('bridge/constants.mjs').match(/export const LINK_COLOR_COUNT\s*=\s*(\d+)/)[1])
  assert.equal(constants, 5)
  assert.equal(countCssChannels(), 5)
})
