# 方案书：摘录链接（预览词句链接批注）

> 状态：**已实现**（2026-10-04：P1–P4 全部完成并验证；拍板项见 §12，
> 实施偏差与进度见 §12 末注）。
> 前置核实：vendored pdf.js 导出表已含 `TextLayer` 类，可叠文本层做选词与标记。
> **版本实测更正（2026-10-04）**：vendored 构建实为 **4.10.38**（非本文档原先所写
> 的 v5）。`TextLayer` 构造签名 `{ textContentSource, container, viewport }` 与
> 设计一致，但 CSS 契约是 4.x 的 `--scale-factor`（**不是** v5 的
> `--total-scale-factor`），详见 §7.1。
> 现有笔记链路（`notes/<docId>/*.md` + 内置编辑器）与预览事件流（preview.js）见 README 与 §4。

## 1. 目标与非目标

**目标**

- 阅读时点「🔗 链接」进入选词模式：**整句点选**、可**跨页多次累积**
- 选完进极简记录编辑器（纯文本），保存后记录与所选词句**双向链接**：正文常显标记可点开（文→记录）；列表可跳回定位（记录→文）
- 平板端新建笔记**入口替换**为此流程（自由新建退役；旧 .md 笔记照常可读可改）
- 记录仍是普通 `.md`（Typora 互通不变量零破坏）；锚点走移动端专有侧车 `links/`，桌面静默忽略——沿用 `annotations/` 的既有模式

**非目标（本期不做）**

- 桌面端渲染标记/跳转（schema 向前兼容，日后可加）
- 富文本记录（高亮/加粗等）；记录导出
- 一句多链（v1 归属独占）；自由拖选/原生选择手柄（v1 整句点选）
- 扫描件 OCR（无文字层页不可选，如实提示）

## 2. 关键决策一览

| # | 决策 | 选择 | 依据 |
|---|---|---|---|
| 1 | 选词交互 | **整句点选**（标点断句；可跨页累积） | 触屏省力；评审拍板 |
| 2 | 文本层实现 | pdf.js 官方 `TextLayer` 类 + 自有点选/标记层 | 几何/旋转/缩放由官方实现保障；实测导出表已含 TextLayer（4.10.38） |
| 3 | 记录存储 | 仍是 `notes/<docId>/*.md`（摘录引用块 + 正文） | Typora 互通不变量 |
| 4 | 锚点存储 | `links/<docId>.json`（移动端专有，桌面忽略） | 同 `annotations/` 模式；`notes/` 不进非 .md |
| 5 | 重锚定 | 页面文本归一化搜索 + hint 消歧 | 不依赖布局/缩放/重排 |
| 6 | 归属规则 | 一句只属一条记录 | 标记天然不重叠；无「点开哪条」歧义 |
| 7 | 与笔记关系 | 入口替换（自由新建退役） | 评审拍板 |
| 8 | 与墨水关系 | 互斥（进一个先退另一个） | 两层都需指针仲裁，共存复杂度不值 |

## 3. 不变量与约束（不可破）

1. **`.md` 互通不变量扩展**：`notes/<docId>/` 仍只放 .md；记录文件同样是普通 .md。锚点一律进 `links/`，两条路径永不相交。
2. **跨端搬运**：`SolaceLibrary/` 整目录 `adb push/pull` 继续成立；`links/` 随库走，桌面不识别即忽略。
3. **补丁体系**：`www/index.html`、`www/js/preview.js`、`www/js/notespanel.js` 是桌面仓库搬运物，改动只进 `scripts/sync-www.mjs` 补丁锚点；`mobile-web/`、`bridge/` 是自有资产，直接改。
4. **原子写**：`links/` JSON 沿用 `writeFileAtomicText`；损坏回退沿用 annotations-core 模式（留档副本 + 如实 notice）。
5. **docId 白名单**：`links/<docId>.json` 与 `notes/` 同一 UUID 形状校验，防路径穿越。
6. **渲染代数**：文本层/标记的异步构建按 layout 代数作废（同 ink.js 的 loadSeq 模式），防快速翻页/换书竞态。

## 4. 总体架构

```
www/index.html（补丁 +1）
  └─ #btnLink「🔗 链接」按钮（插在 #btnInk 后，锚点稳定）

www/js/preview.js（既有补丁加宽，+0）
  └─ 'solace-ink-layout' 的 detail 增补 pageObj + viewport（文本层重建所需；ink.js 忽略多余字段）

www/js/notespanel.js（补丁 +4）
  ├─ render()：行尾注入 .note-link-row（记录徽标与摘录片段，window 钩子，link.js 提供）
  ├─ btnNew 顶部：新建钩子（→ 收起面板进选词模式）
  └─ 删除成功后回调钩子（单条与批量两条路径，→ 渲染侧清缓存并重绘标记）

mobile-web/js/mobile/link.js（新增，~500 行，sync 原样拷入）
  ├─ 文本层（官方 TextLayer 实例 + 句子切分映射 + getTextContent 按页缓存）
  ├─ 选词模式（点选/取消/跨页选集/托盘）
  ├─ 标记渲染 + 重锚定 + 点标记开记录编辑器
  └─ 记录编辑器对话框（摘录 chips + 纯文本 textarea）

mobile-web/js/mobile/mobile.js（直接改）
  ├─ window.linkSelecting 守卫：选词模式下关「边缘点按翻页热区」（滑动翻页保留）
  └─ openNoteEditor 前置钩子：记录项点击改走「跳回定位」（判定由 link.js 提供）

mobile-web/js/mobile/ink.js（直接改，~10 行）
  └─ 激活墨水前若选词中先请求退出选词（互斥）；进入选词时派发既有
     'solace-ink-exit-request' 退出墨水

bridge/links-core.mjs（新增，~100 行）
  └─ read / write / removeEntry（原子写 + 串行链 + 损坏留档）

mobile-web/js/mobile/link-md.mjs（新增，纯函数；原计划在 bridge/，实施微调见 §9）
  └─ 记录 .md 的生成与解析（含降级），node 可单测

bridge/boot.mjs（直接改）
  ├─ readNoteLinks / setNoteLinkEntry 桥方法（保存 = 渲染侧组合 writeNote + setNoteLinkEntry）
  └─ trashNote 扩展：同链清侧车条目
```

运行时（创建流程）：`btnLink/＋新建 → link.js 点选（文本层）→ 托盘 → 编辑器 → boot 桥 → notes/ .md + links/ JSON → 标记刷新`

## 5. 数据设计

### 5.1 记录文件（.md）格式

```md
> 【摘录】第 3 页
> 第一句原文……
> 【摘录】第 5 页
> 第二句原文……

（正文从这里开始，随便写）
```

- 文件名沿用 `createNote` 的「日期 时间（含秒）」规则与并发串行化（同秒顺延 `(2)`）
- 记录必有 ≥1 处摘录；编辑器里全部移除 → 按普通笔记保存（同时删侧车条目）

### 5.2 解析与生成规则

- **解析**：文件头部连续的 `> ` 行为摘录区；`> 【摘录】第 N 页` 开新块，其后 `> ` 行为该块原文；第一个非 `> ` 行起为正文
- **降级**：文件被桌面端手改、不符合格式 → 正文 = 全文、不再重建摘录区；锚点仍有效（标记/跳转照常）
- **生成**：保存时由锚点（权威）重建摘录区 + 编辑后的正文；摘录文本空白归一化为单行

### 5.3 锚点侧车 `links/<docId>.json`

```json
{
  "version": 1,
  "records": {
    "2026-10-03 22.30.05.md": {
      "excerpts": [
        { "page": 3, "text": "第一句原文……", "hint": { "item": 12, "char": 0 } },
        { "page": 5, "text": "第二句原文……", "hint": { "item": 40, "char": 8 } }
      ]
    }
  }
}
```

- `text` = 重锚定权威（页面文本归一化后搜索定位）；`hint`（文本项序号 + 项内字符偏移）= 同页重复文本的就近消歧
- 重锚定未命中 → 该处标记跳过；记录仍可从列表打开

### 5.4 清理与孤儿容忍

- 删除记录：`trashNote` 同链清侧车条目（含批量删除路径）
- 孤儿 GC：面板加载时用文件列表交叉，.md 真不在 → 剪除条目写回（仅在发现孤儿时写）
- 侧车损坏：留档副本（`links/<docId>.corrupt-<n>.json`，**顺延编号**，与
  `annotations-core` 的损坏回退同一套路：rename 失败时用原文落副本兜底，
  都失败则 notice 如实说明）+ 空回退 + notice；记录退化为普通笔记，不丢文件
- 侧车丢失：记录照常显示为普通笔记（无标记、无跳转）

## 6. 交互设计

### 6.1 入口与选词模式

- 入口两处、同一流程：预览顶栏「🔗 链接」；笔记面板「＋新建」（收起面板进选词）
- 托盘浮动条：「已选 N 处 · 跨 N 页 · [取消] [完成]」；0 处时 [完成] 置灰
- [完成] → 记录编辑器；[取消]/返回键 = 清空退出

### 6.2 点选与手势仲裁

- 命中：`caretPositionFromPoint` → 页面文本偏移 → 扩到整句 → 选中/再点取消
- 点按判定：<300ms、位移 <12px（与既有翻页判定同风格）
- 横向滑动 = 翻页（跨页累积靠它，保留）；双指 = 滚动；原生拖滚不拦截（`user-select:none` 关掉原生选择）
- `window.linkSelecting` 生效时，mobile.js 关闭「边缘点按翻页热区」
- 已链接句子：点击 = 打开已有记录（不可选）；想改归属 → 打开旧记录移除该摘录即释放

### 6.3 记录编辑器

- 结构：摘录 chips（「第 N 页 + 文字」，✕ 可移除；全移除退化为普通笔记）+ 纯文本 textarea + [取消] [保存]
- 未保存关闭 → 放弃确认（复用 askConfirm 模式）
- 保存失败（.md 或侧车）→ 留在编辑器、内容不丢、可重试（幂等）
- [取消] → 回选词模式且**选集保留**（防误丢）；再 [取消] 才退出清空

### 6.4 列表与定位

- 列表行 = 🔗 + 时间戳 + 首处摘录片段（旧笔记显示不变）
- 点记录项 → 翻到第一处摘录页 + 滚动到位置 + 标记闪烁 ~1s（定位语义，不弹编辑器）
- 打开记录文本：点正文标记（文→记录）；删除走既有批量链

### 6.5 模式共存与返回键

- ink ↔ 选词互斥：进选词派发 `solace-ink-exit-request`；激活 ink 前先退出选词
- 对话框打开期间不可进模式；进选词自动收起目录/笔记面板
- 返回键链：对话框 → 选词（= 取消清空）→ 标注（ink）→ 预览关闭；两者互斥不会同时命中

## 7. 文本层与句子切分（渲染管线）

### 7.1 文本层生命周期

- **懒建规则**：进入选词模式或本书存在记录时，为当前页构建；否则不建（省无记录书的开销）
- 用官方 `TextLayer`（`textContentSource` + `container` + **CSS 尺度的 viewport**），随翻页/缩放/旋转重建，复用 `solace-ink-layout` 事件（detail 加宽携带 pageObj/viewport）
- **尺度契约（T4 spike 实测，dpr 陷阱）**：span 的字号与定位是 `calc(var(--scale-factor)*…)`，容器**必须**设 `--scale-factor`，且取值必须是 **CSS 尺度**（`cssW / baseW`）——容器也需要用同一 CSS 尺度重建视口。误用设备像素尺度（`fitted.viewport`，dpr=2 时差一倍）会让文字大一圈且整体错位；headless（dpr=1）恰好蒙对，**必须用 dpr=1/2 双跑同一几何断言**才能钉住
- `data-item` 编号按 `tl.textDivs` 赋（实测与 items 一一对应，`br` 不在其中）；重建前先清空容器（TextLayer 只 append，不清会逐页累积）
- 层序：canvas → 文本层 → 墨迹层；文本层基础 CSS 取 pdf.js 官方 text-layer 样式子集进 `mobile.css`（Apache-2.0，许可已随 vendor 分发）。**基础样式必须用直接子选择器 `.ink-text-layer > span`**——标记 span 是插在文本项**内部**的，后代选择器会把标记也绝对定位+透明
- `getTextContent` 按 **`${docId}:${page}`** 缓存（Map；仅按 page 会在换书时串页）

### 7.2 句子切分（纯函数，可单测）

- 文本项按序拼「页面文本串」（hasEOL 插换行）→ 断句字符：`。！？；…!?;` + 换行；英文 `.` 仅在「后随空白/结尾」时断（`3.14` 不断；`Mr.` 类缩写会误断——已知限制）
- 维护「字符偏移 ↔（文本项序号，项内偏移）」映射；跨行整句自然覆盖
- v1 限制：句子不跨页合并；无标点长段退化为换行切分

### 7.3 点选命中

- 命中取整句（页面内字符区间）；已链接句按 §6.2 处理

### 7.4 标记渲染与重锚定

- 当前页摘录 → 归一化搜索 + hint 就近 → 包 `<span class="lnk">`：**琥珀淡底纹 + 细下划线**（底纹半透明，画布文字透出）
- 选中态（本次待提交）：**蓝紫虚线底纹**，与已链接态区分
- 阅读模式文本层 `pointer-events:none`、仅 `.lnk` 可点；选词模式整层接管点按
- 因归属独占，同页标记天然互不重叠

### 7.5 性能与降级

- 无文字页：进入选词时探测当前页，无文本 → toast「没有可选择的文字」不进入（不做按钮置灰——书级预判不可靠）
- 只处理当前页；异步构建按代数作废（§3.6）
- API 细节（TextLayer 构造函数/渲染签名）**已由 P2/T4 小样实测**（vendored 构建实为
  4.10.38，非本文档原写的 v5）：构造签名 `{ textContentSource, container, viewport }`
  与设计一致；容器须设 `--scale-factor`（CSS 尺度）——结论见 §7.1 与 PORTING.md

## 8. 保存管线

| 动作 | 链路（实施值） |
|---|---|
| 创建 | [完成]→编辑器→[保存]→`createNote`（取时间戳名）→ `writeNote`（`generateRecordMd` 重建 md）→ `setNoteLinkEntry`（写侧车）→ 刷新标记/列表（派发 `solace-note-saved`）→ 退出选词 |
| 编辑 | 点标记 → 读 md（`parseRecordMd` 解析）+ 侧车 → 编辑器 → [保存] → `writeNote` + `setNoteLinkEntry`（重写两者，幂等） |
| 删除 | 面板删除 → `trashNote`（扩展清侧车）+ notespanel 删除回调钩子 → 渲染侧清缓存并重绘标记 |
| 全移除摘录 | [保存] → `setNoteLinkEntry(…, null)` 删条目 → md 同步退化成普通笔记（正文保留） |
| 失败 | 任一步失败 → 报错、留在编辑器可重试；重试幂等（create 成功后即转 edit 态，不重复建文件） |

- 无防抖需求：记录保存是显式动作（按钮）；写入顺序 .md 先、侧车后；侧车失败 → 抛错（md 已更新，重试重写两者）

## 9. 桥接层改动

```js
// boot.mjs 新增（实施签名）
readNoteLinks:    gate(async (id) => {           // → { version, records }（含孤儿剪除）
  const { notes: files } = await notes.list(id)
  return links.read(id, new Set(files.map(f => f.file)))
}),
setNoteLinkEntry: gate((id, file, entry) => links.setEntry(id, file, entry)), // entry=null → 删除
// 修改
trashNote: 扩展为 notes.trash + links.removeEntry（同链）
```

- `links-core.mjs`：docId 白名单（同 notes-core 正则）、read（不存在→空；损坏→留档+空+notice）、write（串行链 + 原子写）、setEntry / removeEntry（读改写同链）
- **接口微调（相对本文档 v1，实施时定案）**：原设计的 `writeNoteLinks` /
  `writeNoteRecord` **未采用**——① 记录 md 的生成/解析放渲染侧
  `mobile-web/js/mobile/link-md.mjs`（bridge 不能被 www 引用，纯函数需同时供
  渲染与单测）② 保存 = 渲染侧组合 `writeNote` + `setNoteLinkEntry`，bridge
  不新增 writeNoteRecord（语义等价，见 §8）

## 10. 补丁清单增量（sync-www.mjs）

| 文件 | 增量 | 锚点 |
|---|---|---|
| index.html | +1 | `#btnInk` 按钮行后插「🔗 链接」按钮 |
| preview.js | +0（加宽） | 既有 layout 补丁的 detail 增补 `pageObj`/`viewport` 字段 |
| notespanel.js | +4 | `render()` 行尾钩子；`btnNew` 顶部新建钩子；单条删除回调；批量删除回调 |

补丁总数 34 → **39**（实施值，2026-10-04：比设计时多 2 处——单条/批量删除
回调钩子是 P3 才发现的必需项，spec §5.4 要求「含批量删除路径」，见实施计划
Task 10 偏差）；同步更新 PORTING.md 补丁清单与 sync-www 末尾计数日志。

## 11. 实施阶段

| 阶段 | 内容 | 交付物 | 自测 |
|---|---|---|---|
| P1 数据层 | links-core + record-md + boot 桥方法 + trashNote 扩展 | bridge/ 3 文件 | test：读写回环、损坏留档、孤儿剪除、白名单、生成↔解析往返 + 降级 |
| P2 文本层与选词 | TextLayer API 小样、切分映射、点选模式、托盘、layout detail 加宽 | link.js 骨架、补丁 | 单测切分/映射；harness：点选/取消/跨页/托盘/无文字页降级 |
| P3 标记与编辑器 | 标记渲染/重锚定/点开、记录编辑器、列表整合（行钩子/跳回/闪烁）、删除联动、互斥与返回键 | link.js 完整、notespanel 补丁 | harness：标记出现/点开/跳回/删除/互斥/写失败两路径 |
| P4 收尾 | 真机（触屏点选手感、笔）、PORTING.md/CHANGELOG、全量回归 | 文档 | npm test + p3/race/ink 套件全绿 + 真机全流程 |

工作量估算：新增 ~900 行（link.js 500 / core+纯函数 120 / 测试 200 / css 80）；改动 ~40 行（preview 补丁加宽、mobile.js、ink.js、boot.mjs、notespanel 补丁、sync-www 计数）。

## 12. 风险与开放问题

**风险**

| 风险 | 缓解 |
|---|---|
| TextLayer API 细节与 min 构建形态 | P2 开头 30 行小样先验证（构建/摆位/命中） |
| 句子切分误断（英文缩写、无标点长段、双栏/竖排） | 纯函数用例覆盖 + 已知限制入册；双栏按文本项自然序接受 |
| 点选命中偏差（旋转页/缩放） | 命中走 TextLayer DOM（官方几何）；harness 用图形页断言 |
| 翻页频繁重建文本层开销 | 懒建规则（§7.1）+ 按页缓存 + 代数作废 |
| preview.js 上游漂移 | 锚点校验机制（既有）；加宽锚点选稳定行 |
| 桌面改/删记录文件 | 孤儿 GC + 降级路径（§5.2/§5.4） |

**已拍板（2026-10-03 评审）**

1. **入口替换**：平板端新建笔记走摘录链接流程；旧自由笔记可读可改（不再新建）
2. **整句点选**（非原生拖选）；**可跨页累积**；选中句再点取消
3. **双向链接**：正文常显标记可点开（文→记录）；列表跳回定位（记录→文）
4. **文本层方案 A**：官方 TextLayer + 自有点选/标记层
5. **存储**：记录 = `.md`（Typora 可读）+ 锚点 = `links/` 侧车（桌面忽略）
6. **归属独占**：一句只属一条记录（点已链接句 = 打开记录；移除摘录即释放）
7. **记录编辑器 = 纯文本**（无富文本）；全移除摘录 = 退化为普通笔记

**实施进度（2026-10-04）**

- P1–P4 全部完成：P1 数据层 93d8d5d/fcc2fdd/0af8df0；P2 文本层与选词
  49f11ef/86f0a71/4170c63；P3 标记/编辑器/列表 4aee8c4/3d32f3e/d4622b2；
  P4 文档 + 真机 + 全量回归（本条目所在提交）。实施偏差两处接口微调（§9）
  与补丁实际 39 处（§10）均已回填实施计划对应任务。
- 验证全绿：单测 63/63；harness（摘录链接 16 场景 / P3 专测 11 / 竞态 6 /
  墨迹目视 6）；真机（平板 80b6f44d）全流程通过（跨页点选 → 保存 → 重载
  标记常在 → 点标记编辑 → 列表跳回 → 删除 → 互斥 → 返回键链）。
- 版本状态：CHANGELOG 已记 `[0.5.0] - 未发布（草稿）`；package.json /
  APK versionName 未升，待定版时统一处理。
