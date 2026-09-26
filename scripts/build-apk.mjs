// 调试 APK 构建入口：把 Gradle 需要的本机环境（JDK 21、E 盘 GradleHome、
// Android SDK）显式钉住，保证任何终端里跑都是同一套环境，且所有缓存与
// 下载都落在 E 盘、不写 C 盘用户目录。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const JAVA_HOME = 'E:/Android/Studio/jbr' // Android Studio 自带 JDK 21
const GRADLE_USER_HOME = 'E:/Android/GradleHome' // 依赖与发行版缓存（E 盘）
const ANDROID_HOME = process.env.ANDROID_HOME || 'E:/Android/Sdk'

for (const [name, p] of [['JAVA_HOME', JAVA_HOME], ['ANDROID_HOME', ANDROID_HOME]]) {
  if (!existsSync(p)) {
    console.error(`${name} 不存在：${p}`)
    process.exit(1)
  }
}

const task = process.argv.includes('--release') ? 'assembleRelease' : 'assembleDebug'

const r = spawnSync('cmd', ['/c', 'gradlew.bat', task, '--stacktrace'], {
  cwd: join(root, 'android'),
  stdio: 'inherit',
  env: {
    ...process.env,
    JAVA_HOME,
    GRADLE_USER_HOME,
    ANDROID_HOME,
    ANDROID_SDK_ROOT: ANDROID_HOME
  }
})

if (r.status !== 0) process.exit(r.status || 1)
console.log(`\nAPK 输出：android/app/build/outputs/apk/${task === 'assembleRelease' ? 'release' : 'debug'}/`)
