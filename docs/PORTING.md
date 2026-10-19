# 移植文档：桌面端 → 平板端

记录 Solace 从 Electron（桌面）到 Capacitor（Android 平板）的移植决策、
补丁清单与平台差异。改桥接层或重新同步渲染层之前先读这里。

## 架构总览

```
桌面端                                    平板端
─────────────────────────                ─────────────────────────
渲染进程 src/renderer/          ──拷贝──▶  www/（原样 + 14 处补丁）
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

## 共享纯函数层（library-shared.cjs，2026-10-14 C3）

数据层的「双份维护同源逻辑」是历次 bug 漂移的根因（0 字节入库、损坏备份
命名、settings 守卫三例均一端修了另一端漏）。共享层把其中**纯函数部分**
收敛为单实现：桌面 `src/main/library-shared.cjs` 是唯一事实源，sync-www
搬运到平板 `bridge/library-shared.cjs`（git 跟踪源码，非 www 产物）。

- **首批成员**：normalizeKeyword、dayKey/countOpenDay/getOpenStats
  （阅读足迹口径）、APP_FILE_RE/APP_TMP_RE（孤儿清扫正则）、
  applySettingsPatch（设置白名单归一，键集两端并集）、assertMoveCategory
  （分类移动防环校验）。
- **提取纪律**（写在文件头，违反即回退）：只收纯函数与常量（时钟注入）；
  数据经参数传入不捕获外层状态；禁止平台分支；两端实现有差异时取语义
  更强者统一。
- **模块格式 CJS**：桌面 require 直用；平板 ESM `import shared from
  './library-shared.cjs'`（Node 默认导出 interop + esbuild 打包双兼容）。
- 平台专有逻辑（如 APP_STAGING_RE）不入共享层，留各端本地。
- 增量搬运：后续发现新的同源纯函数按同纪律上移；桌面是唯一事实源，
  平板侧不直接改 bridge/library-shared.cjs。

## 数据兼容（最重要的不变量）

- `library.json` 结构逐字段一致；写入仍是「临时文件 + 原子重命名」
- 全部资料库变更共用异步事务队列，读取只暴露已提交状态；写库失败回滚内存，删书在提交成功后才清文件与可重建索引
- 存储适配器仅将明确的「文件不存在」当缺失；I/O/权限故障上抛，不能用空库/空墨迹覆盖现存数据。删除遇真故障返回失败，建目录只忽略「已存在」
- 副本/封面按严格 UUID 命名；孤儿清扫只认 UUID 形状、库为空不清扫
- SHA-256（crypto.subtle ↔ Node crypto）与 UUID 两端同值 → 去重与文档
  关联跨端成立
- 全文索引分片结构一致（textindex/index.json + <id>.json），桌面端 0.15.x
  的单文件索引在平板端会自动搬迁
- 笔记是普通 .md 文件，桌面端 Typora 与平板端内置编辑器编辑同一份文件
- 手写标注是平板端专有：`annotations/<docId>.json` 随整库搬运，桌面端
  不识别即静默忽略；`notes/<docId>/` 只放 .md、`listNotes` 只认 .md，
  两条路径永不相交（Typora 互通不变量零影响）。孤儿清扫只扫 `files/`、
  `covers/`，不碰 `annotations/`、`links/`
- 摘录链接（0.5.0）同模式：记录仍是 `notes/` 下的普通 .md，锚点在
  `links/<docId>.json` 侧车——平板专有、随整库搬运、桌面端静默忽略

## 渲染层补丁清单（scripts/sync-www.mjs）

同步时对拷贝文件施加的补丁。锚点校验失败 = 上游改了代码，需人工对照。
**共 14 处**（2026-10-14 补丁上游化前为 44 处：preview/covers/textindex/
theme/app/settings/notespanel 七个 JS 文件的全部 30 处补丁已上游化——
平台差异改为桌面源码内的运行时分支（`window.solace.isMobile` 桌面为
undefined 走原路径）、可选钩子（`window.__link*` / `__spineGroups` 可选
调用，无定义短路）与事件派发（`solace-ink-layout` / `solace-ink-close` /
`solace-outline`，桌面无监听者 no-op——node 测试桩无 CustomEvent 由
fireWin 守卫）。上游化写法：凡平台差异优先写进桌面源码的分支/钩子，
sync 补丁仅保留「桌面源码确实无法容纳」的部分——路径差异（vendor/）、
平板专有 DOM（抽屉/工具簇/Olib 行）、平板专有样式挂载）。
sync-www.mjs 末尾日志**动态统计**每文件补丁数，增删补丁时同步更新本清单。

### index.html（10 处）
1. 加 `<meta name="viewport" ...>`（Electron 不需要，WebView 必须）。
   另：命令面板入口的去键盘语（⌘K → 🔍）已上游化为 app.js 的 isMobile
   运行时改写，不再占补丁
2. 字体 CSS 路径 `../../node_modules/...` → `vendor/lxgw/...`（regular/bold 两处）
3. 挂载 `css/mobile.css`
4. 顶栏加 `#btnDrawer`（抽屉开关，窄屏显示）
5. 侧栏后加 `#drawerBackdrop`（抽屉背板；锚定 shelfList 收尾结构防上游新增
   aside 时静默重复插入。2026-10-08 前锚 side-foot 收尾行，上游删除该尾注
   后改锚——含唯一 id 的 ul 整体串匹配，唯一性不变）
6. 底部加 `vendor/solace-bridge.js`（经典脚本，先于模块执行）
7. 底部加 `js/mobile/mobile.js`（模块，先于 app.js；与第 6 条同一锚点一次
   替换，合计 1 对）
8. `#setWatchFolder` 改只读（目录经 SAF 授权选择，不能手输 URI；显示名/
   启用判据/浏览分支/change 短路均已上游化为 settings.js isMobile 分支）
9. 设置追加「下载工具（Olib）」行：包名手输 + 检测按钮（检测逻辑已上游化
    为 settings.js 可选链绑定——桌面无此 DOM 静默跳过；此处仅注入 DOM）
10. 预览顶栏 `#btnNotes` 行整替为阅读工具簇 `#toolsCluster`（v0.5.2，设计书
    `docs/TOOLS-CLUSTER-DESIGN.md`）：标注/链接/笔记三钮收进一条三条杠圆钮，
    点开向下展开三个纯图标圆钮。三钮 ID 不变，preview.js/ink.js/link.js
    的绑定照旧生效

### js/pdfjs.js（4 处）
路径差异（node_modules → vendor/）：pdf.min.mjs / worker / cmaps /
standard_fonts。

### 已上游化的历史补丁（2026-10-14 C2）
preview.js / covers.js / textindex.js / app.js / theme.js / settings.js /
notespanel.js 的 30 处补丁已全部写进桌面源码，改由 `isMobile` 运行时分支、
可选钩子（`window.__spineGroups` 等）与事件派发承载，不再是 sync 补丁；
逐项清单与收益见 CHANGELOG 的 C2 条目。

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
| 封面交互 | 点封面 = 直接预览；悬停浮现三小钮 | 点封面 = 图书简介卡（先看后开），三动作（打开/编辑/删除）收进卡内、封面三小钮隐藏 | 触屏误触即开书 + 小钮不显眼；简介卡动作程序化点击卡内隐藏原钮复用本文件全部业务流（doc-info.js，零补丁，DOC-INFO-DESIGN） |
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

## 动效规范（2026-10-08 成文，A5）

事实标准自现有实现归纳；新增动效一律按此对齐，防止散化。

- **时长三档**：微 ~100ms（按压反馈、scale 微缩）｜标准 160–200ms
  （过渡、淡入、对话框进出 180/120）｜场景 ~300ms（编排：工具簇生长、
  开场 rise-in）。不出现 400ms 以上的**交互响应**动画；两类豁免：
  开场编排的 stagger 总时长、**氛围性宣告动画**（呼吸光 ink-breathe
  600ms——一次性、非交互阻塞、终态透明）与存量闪烁 lnk-flash
  0.45s×2（摘录跳回定位，既有行为）。
- **缓动**：进场一律 `--ease-out-expo`（快速起步、丝滑收尾），收场
  `--ease-in-expo`；不用 linear 与弹性 overshoot。
- **错峰步进**：列表/卡片入场编排 35ms/项（card-in 已有），工具簇
  40ms/钮——同屏不超过 13 项步进（card-in 已 `min(--i, 12)` 封顶）。
- **进出对称**：对话框进场 180ms scale 0.96→1 + 淡入，退场 120ms
  反向（dialog-motion.js 包装 close() 挂类）；主题切换走
  `startViewTransition` 整页交叉淡入（theme.js 已有）。
- **reduced-motion 全覆盖**：每个新动效必须进 mobile.css 的
  `@media (prefers-reduced-motion: reduce)` 跳过块；JS 侧
  （dialog-motion）安装前检测。降级保留布局性 transform（如工具簇
  菜单的 translateY(-40%) 是定位不是动画）。
- **一次性宣告动画**（模式切换等）：类挂上自动播、keyframes 终态
  forwards 透明停留、类摘除即消失——参考标注呼吸光
  （`body.ink-active #previewOverlay::after`）。

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
- **首次加载保护**：墨迹读成功前暂不允许落笔或覆盖保存；读失败显示提示，可重新进入标注或点按页面重试。加载期间的关闭/换书由代数作废，不写空模型
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

## 摘录链接（词句链接批注，0.5.0）

设计与数据格式的权威文档是 `docs/EXCERPT-LINK-DESIGN.md`（§12 已拍板）；
实施明细（含偏差回填）见 `docs/EXCERPT-LINK-PLAN.md`。代码：
`mobile-web/js/mobile/link.js`（自有资产，非补丁）+ `link-md.mjs` /
`link-text.mjs`（纯函数，随单测）+ `bridge/links-core.mjs`。以下补丁计数
为 **0.5.0 当时口径（历史）**，后续版本有增补——权威数字以上方清单为准
（0.5.2 起 notespanel.js 共 8 处、preview.js 新增大纲派发等）：
index.html +1（`#btnLink`「🔗 链接」）、notespanel.js +4（行徽标钩子 /
＋新建钩子 / 单条与批量删除回调钩子）、preview.js 既有 layout 补丁加宽
（detail 增补 `pageObj`/`viewport`，条数不变）。

- **记录与锚点**：记录仍是 `notes/<docId>/*.md`（头部【摘录】引用块 +
  正文，Typora 可读）；锚点侧车 `links/<docId>.json`（平板专有，随整库
  搬运，桌面端静默忽略）。记录被桌面手改致头部不符合格式 → 整份当正文
  解析（锚点仍有效）；侧车损坏留档 `.corrupt-<n>.json`（顺延编号）后
  空回退加 notice。
- **删除联动**：删除记录（含批量路径）经 `trashNote` 与 notespanel 回调
  钩子清侧车并重绘标记；渲染侧对连续回调做 30ms 重绘合并。
- **文本层（dpr 陷阱）**：pdf.js 4.10.38 官方 `TextLayer`，构造签名
  `{ textContentSource, container, viewport }`；容器必须设
  `--scale-factor` 且必须是 **CSS 尺度**（cssW/baseW，不是设备像素）——
  dpr=2 平板用设备尺度文字大一倍（headless dpr=1 会蒙对，须双跑断言）。
  重建前必须清空容器（TextLayer 只 append）；`getTextContent` 按
  `${docId}:${page}` 缓存；异步构建按代数作废。
- **标记**：标记 span 插在文本项**内部**——文本层基础样式必须用
  `.ink-text-layer > span` 直接子选择器（后代选择器会把 `.lnk` 标记也
  绝对定位到行首）；caret 偏移用 Range 相对整个文本项量。重锚定 =
  归一化搜索 + hint（文本项序号 + 项内偏移）就近消歧，未命中跳过该处。
- **入口替换**：预览中「＋新建」一律改走选词流程（`__linkNewOverride`
  钩子对本书预览无条件接管）；旧自由 .md 照常可读可改、不再新建。
- **保存管线**：显式动作无防抖；`.md` 先、侧车后（渲染侧组合 `writeNote`
  + `setNoteLinkEntry`，bridge 无 writeNoteRecord）；任一步失败留在编辑器
  可重试、幂等。
- **编辑器等待保护**：普通笔记和摘录记录在保存完成前冻结输入、摘录移除和关闭（含返回键/Esc）；失败保留内容并恢复编辑
- **侧车读取**：`links.read` 保持纯读；桥接 `readNoteLinks` 调用 `readPruned`，一次加载后剪除并返回同份数据，保留损坏告示

## 存储位置

`Directory.External`（应用专属外部目录
`/storage/emulated/0/Android/data/com.molly.solacemobile/files/`）下的
`SolaceLibrary/`：

- 免任何运行时权限
- debug 包可被 adb 读写（`npm run push:library` 依赖此）
- 卸载应用随之删除——重要资料库请保持桌面端为母本
- 手写标注（`annotations/`）与摘录链接锚点（`links/`）没有桌面端母本：
  **卸载应用即永久丢失**，覆盖安装（`adb install -r`）/ 杀进程 / 重启
  设备都不丢

注意：不要用 `Directory.Documents`——那是公共目录，Android 11+ 作用域
存储下应用只能访问自己创建的文件，行为不可靠。

## 已知问题

- **triggerEvent TypeError（噪声）**：vivo Pad3 Pro WebView 启动时 logcat
  两次 `Uncaught TypeError: Cannot read properties of undefined (reading
  'triggerEvent')`，来自 Capacitor 原生注入脚本。实测 IPC、插件调用、
  返回键全部正常，纯噪声，升级 Capacitor 版本时可以再验证是否消失。
- **debug 构建的原生桥控制台日志（噪声）**：Capacitor debug 构建会把每个
  原生插件调用结果打回页面控制台（native-bridge `logFromNative`，仅
  `isLoggingEnabled` 时），预期失败——mkdir 目录已存在 / stat 文件不存在
  等存在性检查——以 `console.error(对象)` 出现；logcat 侧显示为
  `I/Capacitor/Console ... Msg: undefined`。真机控制台取证按「栈帧是否含
  页面文件 URL」区分页面错误与此类噪声（后者栈帧 URL 为空），别按条数判失败。
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
