# 移植文档：桌面端 → 平板端

记录 Solace 从 Electron（桌面）到 Capacitor（Android 平板）的移植决策、
补丁清单与平台差异。改桥接层或重新同步渲染层之前先读这里。

## 架构总览

```
桌面端                                    平板端
─────────────────────────                ─────────────────────────
渲染进程 src/renderer/          ──拷贝──▶  www/（原样 + 18 处补丁）
    │ window.solace.*                      │ window.solace.*
    │ (contextBridge)                      │ (esbuild bundle)
preload.js                      ──替换──▶  bridge/boot.mjs
    │ ipcRenderer.invoke                   │ Capacitor Filesystem/App
main.js (Electron 主进程)       ──移植──▶  bridge/library-core.mjs
library.js / notes.js (纯 Node)           bridge/notes-core.mjs
    │ fs/crypto                            │ fs-adapter.mjs（异步）
```

渲染层的全部能力收敛在 `window.solace.*` 约 35 个 Promise 方法上（桌面端
preload 暴露、平板端 bridge/boot.mjs 组装），渲染代码零感知平台差异。

## 数据兼容（最重要的不变量）

- `library.json` 结构逐字段一致；写入仍是「临时文件 + 原子重命名」
- 副本/封面按严格 UUID 命名；孤儿清扫只认 UUID 形状、库为空不清扫
- SHA-256（crypto.subtle ↔ Node crypto）与 UUID 两端同值 → 去重与文档
  关联跨端成立
- 全文索引分片结构一致（textindex/index.json + <id>.json），桌面端 0.15.x
  的单文件索引在平板端会自动搬迁
- 笔记是普通 .md 文件，桌面端 Typora 与平板端内置编辑器编辑同一份文件

## 渲染层补丁清单（scripts/sync-www.mjs）

同步时对拷贝文件施加的补丁。锚点校验失败 = 上游改了代码，需人工对照。

### index.html（7 处）
1. 加 `<meta name="viewport" ...>`（Electron 不需要，WebView 必须）
2. 字体 CSS 路径 `../../node_modules/...` → `vendor/lxgw/...`
3. 挂载 `css/mobile.css`
4. 顶栏加 `#btnDrawer`（抽屉开关，窄屏显示）
5. 加 `#drawerBackdrop`（抽屉背板）
6. 底部加 `vendor/solace-bridge.js`（经典脚本，先于模块执行）
7. 底部加 `js/mobile/mobile.js`（模块，先于 app.js）

### pdfjs.js（4 处）
pdf.js / worker / cmaps / standard_fonts 路径改指 `www/vendor/pdfjs/`。

### app.js（5 处）
1. `open-doc` 动作：平板端直接开内置预览（无外部阅读器）
2. `drop` 导入：平板端直接 return（无拖拽）
3. 单删笔记确认文案：回收站 → 直接删除
4. 批删笔记确认文案：同上
5. 删除结果 toast：回收站字样改为平板端表述

### notespanel.js（2 处）
1. `openOne`：桥返回 `{ inApp: true, content }` 时交给内置编辑器
2. 删除确认文案（回收站 → 直接删除）

## 平台差异与取舍

| 能力 | 桌面端 | 平板端 | 原因 |
|---|---|---|---|
| 同步 fs | ✅ | ❌（全异步） | WebView 无同步 IO |
| 导入来源 | 文件路径 | 文件内容（File.arrayBuffer） | SAF 无路径概念 |
| originalPath | 真实路径 | 恒 null | 同上（字段保留，形状一致） |
| 回收站删除 | shell.trashItem | 永久删除 | 无系统回收站 API |
| 监视文件夹 | fs.watch | 无 | Android 无目录变更通知 |
| relocate | 指针文件 | 固定位置 | 应用专属目录即一切 |
| Typora/外部程序 | spawn | 内置编辑器 | 沙箱无外部程序 |
| Ctrl+K | 键盘 | ⌘K 按钮 | 无键盘（按钮本就存在） |

## 手势实现要点（曾踩的坑）

- **滑动翻页**：监听挂 `#previewBody`（`overflow:auto` 滚动容器）。
  用 Touch Events 时横向滑动被原生滚动手势接管、以 touchcancel 结束，
  touchend 收不到 → 翻页失灵。解法：CSS `touch-action: pan-y`（纵向归
  原生、横向归页面）+ Pointer Events（`pointerup`/`pointercancel`）。
- **边缘点按翻页**：快速点按（<300ms、位移 <12px）落在容器左右 20%
  热区时点 `#btnPrevPage/#btnNextPage`（复用按钮链路，进度/足迹逻辑不变）。

## 存储位置

`Directory.External`（应用专属外部目录
`/storage/emulated/0/Android/data/com.molly.solacemobile/files/`）下的
`SolaceLibrary/`：

- 免任何运行时权限
- debug 包可被 adb 读写（`npm run push:library` 依赖此）
- 卸载应用随之删除——重要资料库请保持桌面端为母本

注意：不要用 `Directory.Documents`——那是公共目录，Android 11+ 作用域
存储下应用只能访问自己创建的文件，行为不可靠。

## 已知问题

- **triggerEvent TypeError（噪声）**：vivo Pad3 Pro WebView 启动时 logcat
  两次 `Uncaught TypeError: Cannot read properties of undefined (reading
  'triggerEvent')`，来自 Capacitor 原生注入脚本。实测 IPC、插件调用、
  返回键全部正常，纯噪声，升级 Capacitor 版本时可以再验证是否消失。
- Git Bash 下 adb 的 `/storage/...` 参数会被 MSYS 转成 Windows 路径；
  涉及设备路径的命令需 `MSYS_NO_PATHCONV=1` 且本地路径用 Windows 形式。

## 上游同步流程

```bash
# 桌面端改了渲染层之后：
npm run www        # 重新拷贝 + 补丁（锚点漂移会显式报错）
npm run sync       # 重新打包桥 + cap sync
npm run apk        # 出包
npm run install:device
```

桥接层（`bridge/`）不来自桌面仓库，是本仓库自有代码；桌面端
`library.js`/`notes.js` 有行为变更时，对照移植进 `library-core.mjs`/
`notes-core.mjs` 并同步 `test/` 用例。
