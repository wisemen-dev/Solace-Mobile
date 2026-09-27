# 更新日志

本文件记录 Solace Mobile（平板端）的全部变更。桌面端的变更见桌面仓库
`Solace_Rust/CHANGELOG.md`。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本。

## [0.3.2] - 2026-09-27

同步桌面端渲染层（含其异步生命周期加固），并重锚 6 处因上游漂移而失效的
适配补丁。

### 修复

- 同步桌面批量归档修复：归档完成后清空选中，上一批勾选不再残留进下一批
  分类（与桌面 v0.15.3 后的未发布修复一致）
- sync-www 补丁锚点对齐桌面新代码：preview/covers/textindex 的会话化
  PDF 加载（task/loadingTask/generation 模型，getDocUrl 快路径上保留
  会话与 generation 校验）、封面/索引队列让路循环、app open-doc 会话
  参数、settings 监视文件夹浏览的会话守卫、notespanel 打开笔记的新签名
- open-doc 桌面回落分支补齐 sessionId 参数（平板上不可达，消除补丁
  替换段与锚点的不一致）

### 其他

- 同步新增 www/js/pdfcanvas.js（桌面端画布尺寸限制模块）
- 修正 sync-www 补丁计数日志（index.html 实为 9 处，共 30 处）

## [0.3.1] - 2026-09-26

第一轮代码审查修复（11 项，按优先级）。

### 修复（高优先级）
- 笔记编辑器保存后列表不刷新：`solace-note-saved` 事件此前无监听者，
  notespanel 增加监听（面板开着且同一本书时重载）
- 未保存的笔记被静默丢弃：编辑器增加脏状态跟踪，取消/✕/点背景/
  返回键四个出口统一走「放弃未保存的修改？」确认；保存后不再触发
- 返回键一次即退出应用：改为「再按一次退出」（2 秒窗口 + toast 提示）
- 设置面板 Olib 包名回填用 setAttribute('value')（只设默认值）：
  改为 .value 赋值，重开面板显示已存值而非用户脏输入
- 资料库初始化失败变成不报错的空壳界面：桥层增加全屏错误页兜底

### 修复（中优先级）
- 返回键关对话框的选择器改为「打开顺序栈」（原型挂钩 showModal +
  捕获阶段 close 事件），不再依赖 DOM 顺序碰巧正确；关闭前派发
  `solace-close-request` 可拦截事件（笔记编辑器借此接住返回键）
- 导入的哈希/复制竞态（TOCTOU）：合并为原生 `copyAndHash`——复制与
  SHA-256 同一次读取完成，登记哈希与副本内容严格同源；数据层新增
  暂存管线 `importVia`（files/.incoming-<id>.pdf 暂存，查重通过后原子
  转正；崩溃残留由启动清扫回收，点前缀命名不会误删用户文件）
- 旧桌面库（0.9.x 前）hash 回填改走原生 `hashLibraryPath`（流式），
  不再经 base64 过桥的 JS 慢路径
- 回前台补扫节流 15s → 120s（SAF 全量枚举有真实成本）；扫描时清理
  watch-state.json 里已离开目录的陈旧条目与失效失败记录
- pickPdfs 的 MIME 过滤收紧为仅 application/pdf（octet-stream 会让
  选择器显示无关二进制文件）
- Picker 回调里的 ContentResolver 查询（文档名/大小/持久化授权）挪到
  io 线程，不再占主线程

### 验证（真机）
- 双击退出：首次返回出 toast 不退出，快速二次返回退出 ✓
- 笔记编辑器：新建→修改→取消弹确认→放弃关闭→重开→保存落盘且
  列表即时刷新 ✓
- importVia 端到端：新 PDF 落入监视目录 → 补扫 → 暂存转正入库，
  哈希与原生直调一致 ✓
- 单测 15/15

## [0.3.0] - 2026-09-26

性能专项：文件内容全面脱离 JS 桥。修复批量导入大文件与首次打开预览的
明显卡顿——实测（真机 PA2353，30.8MB 的《Deep Learning 花书》）：

| 环节 | 0.2.x | 0.3.0 | 说明 |
|---|---|---|---|
| 读取整本（预览/封面/索引的取文件） | 2641ms，含 1.25s 整帧冻结 | **216~302ms，零掉帧**（最大帧间隔 17ms） | URL 直读 |
| 预览打开（点击 → 首页渲染完，738 页） | >3s 且界面冻结 | **512ms** | 端到端 |
| 导入单本（哈希+复制） | ~3.4s 主线程冻结（纯 JS base64） | **336ms 全原生，零冻结**（哈希 278ms + 复制 58ms） | 原生管线 |

### 变更
- **读取路径**：库内 PDF 改经 Capacitor 内置资源服务器直读
  （`https://localhost/_capacitor_file_<路径>` 由 WebViewLocalServer 原生
  拦截、FileInputStream 流式返回）——pdf.js 以 URL 加载，内容不再以
  base64 过桥、不再有主线程 JS 解码。preview / covers / textindex 三处
  加载点统一替换（桌面端同步渲染层时自动回落字节路径）
- **导入管线**：SolaceNativePlugin 新增 `pickPdfs`（SAF 多选）、
  `hashUri`（原生流式 SHA-256）、`copyUri`（原生流式复制进库）；导入
  内核重构为 `importWith(meta, performCopy)`（哈希与复制由调用方注入），
  主线程零文件参与。WebView 文件选择器保留为兜底（JS 字节路径）
- **自动入库**：Olib 监视目录的导入同样改走原生管线（内容不过 JS）
- **预览优先**：预览打开期间封面生成与全文索引队列自动让路（读书时
  不与后台任务争 CPU）
- 单测 +1（importWith 注入式内核）

### 根因记录（docs/PORTING.md 有完整分析）
- 纯 JS base64 编解码 10MB≈1.1s 且全程阻塞主线程（10MB 原生哈希仅
  29ms，快 37 倍）——这是导入卡顿的全部来源
- 30.8MB 内容以 base64（41MB 字符串）过桥：JSON 序列化 + JNI 拷贝 +
  JS 解码，多份全尺寸拷贝——这是预览首开卡顿的来源
- 与平板硬件无关（天玑 9300 余量充足）

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
