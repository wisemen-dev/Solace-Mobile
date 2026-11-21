// 跨模块共享的本机常量。Java（SolaceNativePlugin）与 JSON
// （capacitor.config.json）无法导入 JS，各自保留字面量；JS 侧统一从这里取。
export const LIB_ROOT = 'SolaceLibrary' // 资料库根目录名（应用专属外部目录下）
export const ANDROID_PKG = 'com.molly.solacemobile' // Android 包名
// 摘录标记调色板色数（2026-11-13）：links/<docId>.json 每条 excerpt 可选
// color 字段的合法区间是 0..LINK_COLOR_COUNT-1（缺省 0=琥珀）。色值定义在
// 渲染层 mobile-web/css/mobile.css（--lnk-c0..4），渲染层 link.js 的
// LNK_COLORS 与此处同值硬编码（跨层无法共享 import，改色数三处同步）
export const LINK_COLOR_COUNT = 5
