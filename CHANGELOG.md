# 更新日志

本文件记录 Solace Mobile（平板端）的全部变更。桌面端的变更见桌面仓库
`Solace_Rust/CHANGELOG.md`。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本。

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
