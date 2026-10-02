// esbuild 打包桥接层：bridge/boot.mjs（连同 @capacitor/core 与
// @capacitor/filesystem）→ www/vendor/solace-bridge.js（IIFE 经典脚本）。
// bundle 而非裸引 node_modules 的原因：插件的 ESM 构建里是
// '@capacitor/core' 裸说明符，WebView 的 file 内相对 URL 解析不了。
import { build } from 'esbuild'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'www/vendor'), { recursive: true })

const outfile = join(root, 'www/vendor/solace-bridge.js')
await build({
  entryPoints: [join(root, 'bridge/boot.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile,
  legalComments: 'none',
  minify: false, // 保留可读性，便于平板上 remote debug
  sourcemap: false,
  logLevel: 'info'
})

// write:true（默认）时 esbuild 不返回 outputFiles，体积直接从产物读
console.log(`solace-bridge.js ${(statSync(outfile).size / 1024).toFixed(1)} KB`)

// perfect-freehand（MIT）单独打包成 ESM：ink.js 经相对路径 import，不进
// 桥 bundle（桥是 IIFE 经典脚本，全局 window.solace；墨迹库保持模块化）
const pfOut = join(root, 'www/vendor/perfect-freehand.js')
await build({
  entryPoints: [join(root, 'node_modules/perfect-freehand/dist/esm/index.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: pfOut,
  legalComments: 'none',
  minify: true,
  sourcemap: false,
  logLevel: 'info'
})
console.log(`perfect-freehand.js ${(statSync(pfOut).size / 1024).toFixed(1)} KB`)
