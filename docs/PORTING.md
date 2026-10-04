# 移植文档：桌面端 → 平板端

记录 Solace 从 Electron（桌面）到 Capacitor（Android 平板）的移植决策、
补丁清单与平台差异。改桥接层或重新同步渲染层之前先读这里。

## 架构总览

```
桌面端                                    平板端
─────────────────────────                ─────────────────────────
渲染进程 src/renderer/          ──拷贝──▶  www/（原样 + 38 处补丁）
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
- 手写标注是平板端专有：`annotations/<docId>.json` 随整库搬运，桌面端
  不识别即静默忽略；`notes/<docId>/` 只放 .md、`listNotes` 只认 .md，
  两条路径永不相交（Typora 互通不变量零影响）。孤儿清扫只扫 `files/`、
  `covers/`，不碰 `annotations/`

## 渲染层补丁清单（scripts/sync-www.mjs）

同步时对拷贝文件施加的补丁。锚点校验失败 = 上游改了代码，需人工对照。
共 39 处；sync-www.mjs 末尾日志打印每文件计数，增删补丁时同步更新本清单。

### index.html（11 处）
1. 加 `<meta name="viewport" ...>`（Electron 不需要，WebView 必须）
2. 字体 CSS 路径 `../../node_modules/...` → `vendor/lxgw/...`（regular/bold 两处）
3. 挂载 `css/mobile.css`
4. 顶栏加 `#btnDrawer`（抽屉开关，窄屏显示）
5. 侧栏后加 `#drawerBackdrop`（抽屉背板；锚定 side-foot 收尾行防上游新增
   aside 时静默重复插入）
6. 底部加 `vendor/solace-bridge.js`（经典脚本，先于模块执行）
7. 底部加 `js/mobile/mobile.js`（模块，先于 app.js；与第 6 条同一锚点一次替换，
   合计 1 对）
8. `#setWatchFolder` 改只读（目录经 SAF 授权选择，不能手输 URI）
9. 设置追加「下载工具（Olib）」行：包名手输 + 检测按钮
10. 预览顶栏 `#btnNotes` 后加 `#btnInk`「✏️ 标注」按钮（手写标注入口，
    v0.4.0）
11. 预览顶栏 `#btnInk` 后加 `#btnLink`「🔗 链接」按钮（摘录链接入口）

### pdfjs.js（4 处）
pdf.js / worker / cmaps / standard_fonts 路径改指 `www/vendor/pdfjs/`。

### preview.js（3 处）
1. 预览 PDF 加载改 URL 直读：`getDocUrl`（`_capacitor_file_`，内容不过桥）
   优先、字节路径回落；会话守卫保留在异步解析之后（v0.3.0）
2. 页面布局尺寸设定后 dispatch `solace-ink-layout`（detail：docId/页码/
   设备像素 w·h/显示 cssW·cssH/存储坐标 baseW·baseH/pageObj/viewport）——
   手写标注层（mobile.js → ink.js）据此对齐墨迹画布并换算坐标，
   摘录链接层（link.js）另用 pageObj 取文本、用 viewport 的 CSS 尺度重建
   文本层视口（设备像素尺度会让文字大一倍，见下）（v0.4.0/v0.5.0）
3. `closePreview()` 开头 dispatch `solace-ink-close`——墨迹层冲刷保存并
   弃内存模型，重开从盘上重读（v0.4.0）

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

### notespanel.js（7 处）
1. `openOne`：桥返回 `{ inApp: true, content }` 时交给内置编辑器
2. 删除确认文案（回收站 → 直接删除）
3. `solace-note-saved` 监听：内置编辑器保存后刷新列表（v0.3.1）
4. 记录行追加 `.note-link-row`（`window.__linkNoteRowExtra` 钩子：摘录链接
   的 🔗 徽标与首条摘录片段）
5. 「＋新建」前插 `window.__linkNewOverride` 钩子：有摘录记录时改走选词模式
   （入口替换；旧笔记仍可读可改）
6. 单条删除成功后调 `window.__linkNoteDeleted` 钩子：渲染侧清缓存并重绘标记
   （否则正文标记要等下次保存/重开预览才消失）
7. 批量删除同样逐条调 `window.__linkNoteDeleted`（spec §5.4 明确「含批量
   删除路径」；渲染侧对连续回调做了重绘合并）

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
| 手写标注 | ❌ 不渲染（`annotations/` 静默共存） | ✅ 墨迹层（笔/荧光笔/橡皮） | 平板端手写笔场景专有 |
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

## 手写标注（墨迹层，0.4.0）

设计与数据格式的权威文档是 `docs/ANNOTATION-DESIGN.md`（§12 已拍板）；
这里只记移植落点与踩过的坑。代码在 `mobile-web/js/mobile/ink.js`（自有
资产，非补丁）+ `bridge/annotations-core.mjs`，补丁只 3 处。

- **三层画布**：`#previewCanvas`（pdf.js）+ `#inkStaticCanvas`（已提交
  墨迹）+ `#inkLiveCanvas`（正在画的这一笔），尺寸全等、绝对定位对齐。
- **荧光笔「不叠深、不盖字」要两层机制合起来**：同页荧光先画进不透明
  离屏层求并集（重叠处颜色恒定），再以 `globalCompositeOperation =
  'multiply'` 合成进墨迹层；而「PDF 文字透出」靠 `.ink-layer` 的 CSS
  `mix-blend-mode: multiply` 对整个下层元素相乘——画布内的 multiply 够
  不到 PDF（它只作用于同一 canvas 内部），少了 CSS 这一层就会盖住字。
- **坐标系**：存 `page.getViewport({ scale: 1 })` 空间（PDF 用户单位、
  左上原点、y 向下），渲染时乘 `kx = fitted.width / baseW` 一个系数——
  与 dpr、fitWidth、设备无关，任意倍率重绘不失真。将来加捏合缩放沿用
  同一事件同一管线。
- **事件契约**：`solace-ink-layout`（preview.js 布局尺寸设定后派发，
  detail 带 docId / 页码 / 设备像素 w·h / 显示 cssW·cssH / 存储坐标
  baseW·baseH）、`solace-ink-close`（closePreview 开头）为补丁派发；
  `solace-ink-exit-request`（返回键链）、`solace-ink-flush`（回后台）由
  boot.mjs 派发。ink.js 一律经 window 事件解耦，不 import 桥。
- **会话守卫**：`loadedDoc`（内存归属）+ `loadSeq`（模型代数）双重对账。
  同书快速关开会有两个在途 read，只比 docId 区分不开——旧结果合并会把
  同一批笔迹翻倍。
- **保存管线**：1.5s 防抖；退出标注 / 关预览 / 回后台 / 换书四处立即
  冲刷。写在 annotations-core 内 promise 链串行化，读排队于写链尾（否则
  「退出→立刻重进」会读回旧盘态覆盖内存）。冲刷失败 → `dirty` 复位由
  防抖重试；换书时失败 → 快照入队，重进该书时回灌内存并置脏补写（读盘
  会拿回缺笔迹的旧态，之后任何以内存为准的成功写都会把快照覆盖丢）。
- **回后台冲刷的实测边界**（2026-10-03，平板 80b6f44d）：`appStateChange`
  的 `!isActive` 分支派发 `solace-ink-flush`，ink.js 收到即 `flushSave()`。
  真机以页面侧时钟探针测得：事件约在收笔后 1782ms 才到（HOME 注入 +
  onPause + 过桥），而这台机器的 WebView 在后台仍继续跑 JS 定时器，1.5s
  防抖已在 1532ms 写完。所以**后台冲刷不是更快的那条路，而是独立于定时器
  的第二条保险**（OEM 冻结后台 JS 时定时器不响，原生事件仍会派发）。
  真机判据只能是「事件必达 + 笔迹不丢」，别断言「必须早于防抖」。
  另：计时必须取页面侧时钟——平板与本机时钟不同源，跨机相减无意义。
- **手势仲裁**：标注模式下单指横滑/纵滑从「翻页/滚动」改为「画笔」，
  `mobile.js` 指针段加 `window.inkActive` 守卫；双指拖动改为滚动页面。
  **防手掌误触默认开**：本会话内一旦收到 `pointerType === 'pen'` 的
  pointerdown，后续 touch 指针在绘制与双指滚动仲裁上一概忽略（抬笔恢复）。
- **返回键**：boot.mjs 的 backButton 链在「对话框 → 预览」之间插一级
  `window.inkActive` 检查，退出标注即冲刷保存、不弹确认。
- **内存**：两层 canvas ≈ 2 × fitted.w × fitted.h × 4B（dpr=2、
  1600×2200 CSS → 每层约 56MB），仅预览打开期间存在。低端机吃紧时的
  退路：活动层降 dpr=1，或合并单层 + 脏矩形重绘。

## 存储位置

`Directory.External`（应用专属外部目录
`/storage/emulated/0/Android/data/com.molly.solacemobile/files/`）下的
`SolaceLibrary/`：

- 免任何运行时权限
- debug 包可被 adb 读写（`npm run push:library` 依赖此）
- 卸载应用随之删除——重要资料库请保持桌面端为母本
- 手写标注（`annotations/`）没有桌面端母本：**卸载应用即永久丢失**，
  覆盖安装（`adb install -r`）/ 杀进程 / 重启设备都不丢

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
