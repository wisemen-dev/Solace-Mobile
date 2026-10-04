// 跨模块共享的本机常量。Java（SolaceNativePlugin）与 JSON
// （capacitor.config.json）无法导入 JS，各自保留字面量；JS 侧统一从这里取。
export const LIB_ROOT = 'SolaceLibrary' // 资料库根目录名（应用专属外部目录下）
export const ANDROID_PKG = 'com.molly.solacemobile' // Android 包名
