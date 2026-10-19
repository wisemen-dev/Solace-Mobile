// 跨平台测试入口：显式收集 test/*.test.js 后交给 node --test。
// 不用 `node --test`（无参）是因为它会把 test/ 下所有模块都当测试文件
// （mem-fs.mjs 这类辅助模块也会被计入）；也不依赖 shell 展开 glob——
// Windows cmd 与 POSIX shell 行为不一致，Node 20 对 glob 参数的支持也不统一。
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = fileURLToPath(new URL('../test/', import.meta.url))
const files = readdirSync(testDir)
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => join(testDir, name))

if (!files.length) {
  console.error(`未找到测试文件：${testDir}`)
  process.exit(1)
}

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(r.status ?? 1)
