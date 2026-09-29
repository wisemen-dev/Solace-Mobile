# 移植文档：桌面端 → 平板端

记录 Solace 从 Electron（桌面）到 Capacitor（Android 平板）的移植决策、
补丁清单与平台差异。改桥接层或重新同步渲染层之前先读这里。

## 架构总览

```
桌面端                                    平板端
─────────────────────────                ─────────────────────────
渲染进程 src/renderer/          ──拷贝──▶  www/（原样 + 31 处补丁）
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
共 31 处；sync-www.mjs 末尾日志打印每文件计数，增删补丁时同步更新本清单。

### index.html（9 处）
1. 加 `<meta name="viewport" ...>`（Electron 不需要，WebView 必须）
2. 字体 CSS 路径 `../../node_modules/...` → `vendor/lxgw/...`（regular/bold 两处）
3. 挂载 `css/mobile.css`
4. 顶栏加 `#btnDrawer`（抽屉开关，窄屏显示）
5. 侧栏后加 `#drawerBackdrop`（抽屉背板；锚定 side-foot 收尾行防上游新增
   aside 时静默重复插入）
6. 底部加 `vendor/solace-bridge.js`（经典脚本，先于模块执行）
7. 底部加 `js/mobile/mobile.js`（模块，先于 app.js）
8. `#setWatchFolder` 改只读（目录经 SAF 授权选择，不能手输 URI）
9. 设置追加「下载工具（Olib）」行：包名手输 + 检测按钮

### pdfjs.js（4 处）
pdf.js / worker / cmaps / standard_fonts 路径改指 `www/vendor/pdfjs/`。

### preview.js（1 处，v0.3.0）
预览 PDF 加载改 URL 直读：`getDocUrl`（`_capacitor_file_`，内容不过桥）
优先、字节路径回落；会话守卫保留在异步解析之后。

### covers.js（2 处，v0.3.0）
1. 封面生成的 PDF 加载同上 URL 直读
2. 预览打开时封面队列让路（读书优先，400ms 轮询）

### textindex.js（2 处，v0.3.0）
1. 索引提取的 PDF 加载同上 URL 直读
2. 预览打开时索引队列让路（同上，500ms 轮询）

### app.js（5 处）
1. `open-doc` 动作：平板端直接开内置预览（无外部阅读器）
2. `drop` 导入：平板端直接 return（无拖拽）
3. 单删笔记确认文案：回收站 → 直接删除
4. 批删笔记确认文案：同上
5. 删除结果 toast：回收站字样改为平板端表述

### settings.js（5 处）
1. 监视文件夹显示名：平板端显示 SAF 目录名（watchFolderName）
2. 启用开关状态判据：平板端看 watchTreeUri（watchFolder 恒不存在，否则
   勾选框永远显示「关」而自动入库实际在跑，且无法从界面停用）
3. 「浏览…」走 SAF 目录选择器，返回 { uri, name } 落 watchTreeUri
4. 监视文件夹输入框 change 短路（只读，用户不会触发）
5. Olib 包名保存与「检测…」自动发现（多结果走选择框）

### notespanel.js（3 处）
1. `openOne`：桥返回 `{ inApp: true, content }` 时交给内置编辑器
2. 删除确认文案（回收站 → 直接删除）
3. `solace-note-saved` 监听：内置编辑器保存后刷新列表（v0.3.1）

## 平台差异与取舍

| 能力 | 桌面端 | 平板端 | 原因 |
|---|---|---|---|
| 同步 fs | ✅ | ❌（全异步） | WebView 无同步 IO |
| 导入来源 | 文件路径 | 文件内容（File.arrayBuffer） | SAF 无路径概念 |
| originalPath | 真实路径 | 恒 null | 同上（字段保留，形状一致） |
| 回收站删除 | shell.trashItem | 永久删除 | 无系统回收站 API |
| 监视文件夹 | fs.watch 事件驱动 | SAF 授权 + 补扫（启动/回前台/启用时） | Android 无目录变更通知 |
| 监视补扫成本 | 每次重启全量重算哈希 | watch-state.json 短路未变文件 | 平板补扫频率是「每次回前台」 |
| 拉起外部工具 | spawn(exe) | getLaunchIntentForPackage | 平板无外部程序概念，有应用 |
| relocate | 指针文件 | 固定位置 | 应用专属目录即一切 |
| Typora/外部程序 | spawn | 内置编辑器 | 沙箱无外部程序 |
| Ctrl+K | 键盘 | ⌘K 按钮 | 无键盘（按钮本就存在） |

## 性能架构（0.3.0，重要）

**原则：文件内容永远不过 JS 桥。** WebView 桥以 base64 字符串传输大文件，
两侧各有一次全尺寸编解码 + JSON 序列化 + JNI 拷贝，且 JS 侧编解码在主线程
——实测纯 JS base64 编码 10MB≈1.1s（原生 SHA-256 同为 10MB 仅 29ms，
差 37 倍）。0.2.x 的卡顿全部源于此，与平板硬件无关。

三条原生通道（android/.../SolaceNativePlugin.java）：

1. **读取**：Capacitor 内置资源服务器原生支持
   `https://localhost/_capacitor_file_<绝对路径>`（WebViewLocalServer 拦截
   该前缀、直接 FileInputStream 流式返回）。`fs-adapter.fileUrl(relPath)`
   经 `Filesystem.getUri` 把库内相对路径换算成该 URL；preview / covers /
   textindex 的 pdf.js 加载统一 `getDocument({ url })`（pdf.js 在自己的
   worker 里 fetch，主线程不碰字节）。服务端不支持 Range → pdf.js 自动
   整取，仍是全速（30.8MB≈220ms）。
2. **导入（哈希 + 复制一次完成）**：`copyAndHash(uri, destPath)` 一次读取
   同时做流式 SHA-256 与复制（30.8MB≈280ms），哈希与副本内容严格同源；
   失败自动清掉半截文件。
3. **库内文件哈希**：`hashLibraryPath(relPath)` 原生流式 SHA-256，旧库
   条目回填 hash 用（不走 base64 过桥的 JS 慢路径）。

导入内核 `library-core.importWith(meta, performCopy)`：meta 携带
{ fileName, size, hash }，performCopy(destRelPath) 由调用方注入原生实现
（真机）或 JS 实现（Node 单测 / WebView 选择器兜底）。查重 → 复制 → 落库
的顺序与桌面端一致，串行化链不变。

**预览优先**：预览打开期间（`window.currentPreviewId` 非空）封面与索引
队列 sleep 让路——pdf.js 解析虽在 worker，仍与翻页争 CPU。

## Olib 集成要点（0.2.0）

- **包可见性（坑）**：Android 11+ 起 `queryIntentActivities` /
  `getLaunchIntentForPackage` 受包可见性过滤，必须在 AndroidManifest 声明
  `<queries><intent>`（MAIN+LAUNCHER）才能看到其他应用——不声明时
  检测与拉起全部静默失败（返回空/null），且无任何报错日志。
- **Olib 包名** `com.open_library.app`，label「Olib」。注意包名不含连续
  子串 "olib"（open 与 library 之间是下划线），按单一关键字检测会漏检，
  `findOlibCandidates` 用多关键字（olib / open_library / openlibrary /
  open library）检索并按包名去重。
- **SAF 目录授权**：ACTION_OPEN_DOCUMENT_TREE +
  FLAG_GRANT_PERSISTABLE_URI_PERMISSION，回调里 takePersistableUriPermission
  持久化（重启、覆盖安装后仍有效）。tree URI 形如
  `content://com.android.externalstorage.documents/tree/primary%3ADownload%2Folib-books`。
- **扫描语义**（bridge/olib-watch.mjs ↔ 桌面端 watcher.js）：
  - 稳定判定：候选文件隔 1.5s 两次枚举对比 size/mtime（桌面端是事件
    防抖 + 两次 stat，扫描式等价物）
  - 内容去重：importFile 的 SHA-256 挡下（两端同值）
  - 失败记录：mtime 未变不重试（会话内）
  - 通知聚合：800ms（渲染层 onWatchEvent 逻辑零改动）
- **watch-state.json**：uri → { size, mtime } 的已处理记录，与资料库同
  目录存放。删掉无副作用（重扫撞去重）。
- **Java 插件**（android/.../SolaceNativePlugin.java）：文件 IO 走单线程
  执行器——插件方法默认主线程执行，枚举/读大文件必须让出；
  call.resolve 线程安全。
- **调试基建**：`scripts/cdp-eval.mjs` 连 WebView DevTools 直接在页面里
  求值（Runtime.evaluate 不支持顶层 await，表达式要自带 async IIFE）。
  配合 `adb shell uiautomator dump` 驱动原生 UI（SAF 选择器）。

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
