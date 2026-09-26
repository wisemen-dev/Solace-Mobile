# 更新日志

本文件记录 Solace Mobile（平板端）的全部变更。桌面端的变更见桌面仓库
`Solace_Rust/CHANGELOG.md`。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本。

## [0.2.0] - 2026-09-26

Olib 集成：桌面端「打开外部工具 + 监视文件夹自动入库」的平板等价实现。

### 新增
- **拉起 Olib**（`SolaceNativePlugin.java`）：命令面板「打开外部工具」
  经 `getLaunchIntentForPackage` 拉起 Olib；包名可配置（设置 → 资料库 →
  下载工具），缺省按多关键字（olib/open_library/openlibrary）自动检测，
  检测到多个时列出选择
- **自动入库（扫描式）**（`bridge/olib-watch.mjs`）：Android 无目录变更
  通知，改为 SAF 授权目录 + 时机触发补扫——应用启动、回到前台（从 Olib
  切回的主路径）、设置里启用/换目录时。语义与桌面端 watcher.js 对齐：
  稳定判定（两次枚举对比 size/mtime，下载写一半的跳过）、内容级去重
  静默挡、失败记录（mtime 未变不重试）、800ms 通知聚合（渲染层 toast
  与刷新逻辑零改动）
- **SAF 目录授权**：设置 → 资料库 → 监视文件夹「浏览…」走系统目录
  选择器（ACTION_OPEN_DOCUMENT_TREE + 持久化读权限，重启免重授权）
- **性能优化（相对桌面端）**：`watch-state.json` 记录已处理文件
  （size+mtime），未变化的文件补扫直接跳过——桌面端每次重启全量重算
  哈希，平板补扫频率是「每次回前台」，必须短路
- 设置白名单新增 `watchTreeUri` / `watchFolderName` / `externalToolPackage`
  （桌面端 save() 全量回写 settings，未知键不丢，两端互搬安全）

### 修复（开发过程中发现）
- AndroidManifest 声明 `<queries>`（MAIN+LAUNCHER）：Android 11+ 包可见性
  过滤下不声明则 `queryIntentActivities` / `getLaunchIntentForPackage`
  都看不到其他应用（拉起 Olib 与自动检测全失效）
- Olib 包名 `com.open_library.app` 不含连续子串 "olib"，单一关键字检测
  漏检 → 多关键字检索按包名去重

### 验证（真机 PA2353）
- 命令面板拉起 Olib（自动检测包名，零配置）✓
- SAF 授权 Download/olib-books → 推入 PDF 自动入库（封面正常生成）✓
- 回前台补扫：新落盘 PDF 在切回 Solace 后自动入库 ✓
- CDP 远程求值辅助验证（scripts/cdp-eval.mjs，调试基建保留）

## [0.1.0] - 2026-09-26

首个可用版本：桌面端 Solace v0.15.3 的 Capacitor 移植。

### 新增
- **桥接层**（`bridge/`）：`window.solace` 全套方法（与桌面端 preload.js
  签名一一对应），数据层 `library.js`/`notes.js` 异步移植；
  `library.json`/副本/封面/索引分片/笔记格式与桌面端完全一致，整库
  可在两端互搬（SHA-256 与 UUID 两端同值，去重与关联不破）
- **渲染层搬运**（`scripts/sync-www.mjs`）：桌面端 `src/renderer/` 原样
  拷贝 + 18 处锚点补丁；pdf.js 与霞鹜文楷收拢进 `www/vendor/`
- **触屏适配**（`mobile-web/`）：竖屏/窄屏抽屉侧栏、悬停操作改常显、
  预览滑动翻页与边缘点按翻页（`touch-action: pan-y` + Pointer Events）、
  内置 Markdown 笔记编辑器、Android 返回键语义（对话框 → 预览 → 抽屉 → 退出）
- **导入**：系统文件选择器多选 PDF，内容级去重与桌面端同规则
- **工程化**：npm 缓存（`.npmrc`）与 Gradle Home 钉在 E 盘；构建/安装/
  推库脚本（`build-apk` / `install:device` / `push:library`）；
  数据层内存 fs 单测 13 例

### 差异（相对桌面端）
- 无监视文件夹自动入库（Android 无目录变更通知）
- 无资料库位置迁移（固定应用专属外部目录）
- 无外部阅读器 / 外部工具 / Typora（预览与笔记编辑内置）
- 删除笔记为永久删除（系统无回收站，界面文案已如实标注）

### 已知问题
- vivo Pad3 Pro（Android 14）WebView 启动时 logcat 出现两次
  `Uncaught TypeError: ... 'triggerEvent'`——Capacitor 原生桥注入脚本的
  已知噪声，实测不影响任何功能（IPC/插件/返回键均正常），暂不处理
- vivo 的 adb 安装交互确认需手动关闭系统校验（见 README）

### 验证（真机 PA2353 / Android 14 / arm64）
- 整库迁移：桌面测试库（3 本书）推入即用 ✓
- 封面生成（pdf.js 渲染首页 → 落盘 → 回填）✓
- 预览：打开 / 进度恢复 / 滑动翻页 / 边缘点按 / 进度环 ✓
- 全文索引后台构建 + 全文搜索（命中页直达标记）✓
- 返回键关闭预览不退出应用 ✓
