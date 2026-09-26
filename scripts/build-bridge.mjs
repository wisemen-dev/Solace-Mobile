// esbuild 打包桥接层：bridge/boot.mjs（连同 @capacitor/core 与
// @capacitor/filesystem）→ www/vendor/solace-bridge.js（IIFE 经典脚本）。
// bundle 而非裸引 node_modules 的原因：插件的 ESM 构建里是
// '@capacitor/core' 裸说明符，WebView 的 file 内相对 URL 解析不了。
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'www/vendor'), { recursive: true })

const result = await build({
  entryPoints: [join(root, 'bridge/boot.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: join(root, 'www/vendor/solace-bridge.js'),
  legalComments: 'none',
  minify: false, // 保留可读性，便于平板上 remote debug
  sourcemap: false,
  logLevel: 'info',
  metafile: true
})

const bytes = Object.values(result.outputFiles || {}).reduce((s, f) => s + f.contents.length, 0)
console.log(`solace-bridge.js ${(bytes / 1024).toFixed(1)} KB`)
