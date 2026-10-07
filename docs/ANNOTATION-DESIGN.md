# 方案书：预览手写标注（墨迹层）

> 状态：P1 数据层、P2 渲染核心、P3 交互、P4 收尾全部完成并真机验证
> （2026-10-03）。评审决策见 §12。
> 前置调研：Saber（github.com/saber-notes/saber）实现方式总结见会话记录
> （2026-10-02）；本方案借鉴其思路，不引用其 GPL-3.0 代码。

## 1. 目标与非目标

**目标**

- 在内置预览里直接用手写笔/手指在 PDF 页面上批注：笔、荧光笔、橡皮、撤销/重做
- 墨迹为矢量数据，任意倍率重绘不失真（存页面坐标，不存屏幕像素）
- 墨迹数据独立落盘，与 `notes/<docId>/*.md` 完全解耦——桌面端 Typora 互通不变量零影响
- 全部在 WebView 内实现，原生层零改动；渲染层改动尽量收敛到 mobile-web 自有文件，补丁体系只增 3 处

**非目标（本期不做）**

- 桌面端渲染墨迹（已确认桌面端暂不需要此功能：文件静默共存，桌面端照常工作）
- 形状笔、套索、文字工具、激光笔
- 墨迹导出回 PDF 注释层（PDF 注释对象 / 嵌入页面）
- 图片/截图插入

## 2. 关键决策一览

| # | 决策 | 选择 | 依据 |
|---|---|---|---|
| 1 | 数据形态 | 点坐标数组（矢量），JSON 落盘 | 缩放不失真是硬需求；Saber/Excalidraw 同构 |
| 2 | 坐标系 | **scale=1 视口坐标**（PDF 用户单位，左上原点） | 渲染变换 = 乘一个系数；与 dpr、fitWidth、设备无关 |
| 3 | 存储位置 | `SolaceLibrary/annotations/<docId>.json` | 与 `notes/` 平行；已验证两端孤儿清扫只扫 `files/`、`covers/`（library-core.mjs:690），新目录绝对安全 |
| 4 | 笔迹平滑 | perfect-freehand（npm，**MIT**）1.2.3 | Saber 用的是它的 Dart 移植版；JS 原版可直接进 WebView |
| 5 | 渲染载体 | 双 canvas 叠层（静态已提交墨迹 + 活动笔画），不用 SVG | 与 pdf.js 现有 canvas 同一坐标系对齐；几百节点 SVG 在移动 WebView 合成开销反而更大 |
| 6 | 许可合规 | 只读 Saber 源码理解思路，逐行实现 | Saber 是 GPL-3.0，本项目 MIT |
| 7 | 原生层 | 零改动 | Capacitor Filesystem 足够（墨迹 JSON 很小，不过性能关键路径） |

## 3. 不变量与约束（不可破）

1. **`.md` 互通不变量**：`notes/<docId>/` 只放 .md；`listNotes` 只认 `.md`。墨迹一律进 `annotations/`，两条路径永不相交。
2. **数据格式跨端搬运**：`SolaceLibrary/` 整目录 `adb push/pull` 必须继续成立。`annotations/` 作为普通子目录自然随库走；桌面端不识别即忽略。
3. **补丁体系**：`www/js/preview.js`、`www/index.html` 是桌面仓库搬运物，改动只能进 `scripts/sync-www.mjs` 补丁锚点；`mobile-web/` 下文件是自有资产，直接改。
4. **原子写**：落盘沿用 `writeFileAtomicText`（临时文件 + rename），与 library.json 同一套路。
5. **docId 白名单**：`annotations/<docId>.json` 的 docId 走与 notes-core 相同的 UUID 形状校验，防路径穿越。

## 4. 总体架构

```
www/index.html（补丁 +1）
  └─ #btnInk「标注」按钮（插在 #btnNotes 后，锚点稳定）

www/js/preview.js（补丁 +2）
  ├─ 页面布局尺寸设定后 dispatch 'solace-ink-layout'
  │    detail: { docId, page, w, h, cssW, cssH, baseW, baseH }
  └─ closePreview() 内 dispatch 'solace-ink-close'（冲刷保存）

mobile-web/js/mobile/ink.js（新增，~450 行，sync 原样拷入）
  ├─ 墨迹层 DOM（container + 静态 canvas + 活动 canvas，动态创建）
  ├─ 工具栏 DOM（笔/荧光笔/橡皮/颜色/粗细/撤销/重做/清页/完成，动态创建）
  ├─ 指针事件 → 点采集（rAF 节流）→ perfect-freehand → canvas 绘制
  ├─ 撤销/重做操作栈
  └─ 防抖保存（1.5s）+ 退出/关预览/回后台冲刷

bridge/annotations-core.mjs（新增，~120 行）
  └─ read / write（原子写 + in-flight 串行化 + 损坏回退）

bridge/boot.mjs（直接改）
  └─ solace.readAnnotations / writeAnnotations

mobile-web/css/mobile.css（直接改，~120 行）
  └─ 墨迹层、工具栏、颜色板样式

vendor：perfect-freehand 经 esbuild 打包为
  www/vendor/perfect-freehand.js（build-bridge.mjs 增一个 entry，
  sync-www.mjs 收尾时与 solace-bridge.js 一同重建）
```

**三层画布**（同一 `#previewBody` 内，逐层叠放，尺寸全等）：

```
#previewCanvas      ← pdf.js 光栅化（现有，不动）
#inkStaticCanvas    ← 已提交墨迹；仅提交/撤销/翻页/布局变化时重绘
#inkLiveCanvas      ← 正在画的这一笔；pointermove 每 rAF 清空重画（只画一笔，开销可忽略）
```

墨迹容器绝对定位对齐 `#previewCanvas` 的 `offsetLeft/Top`（`previewBody` 由 ink.js 运行时设为 `position:relative`——自有层做的事，桌面端不受影响）。

## 5. 数据设计

### 5.1 文件与路径

```
SolaceLibrary/
├── library.json
├── files/ covers/ textindex/ notes/     ← 现有，不动
└── annotations/
    └── <docId>.json                     ← 每本书一个墨迹文件
```

- 一本书一个文件（而非每页一个）：读写各一次原子操作，省碎片；按页为键、按需取页。
- 文件不存在 = 这本书没画过，不预建空文件（零成本默认路径）。

### 5.2 JSON Schema（version 1）

```jsonc
{
  "version": 1,
  "pages": {
    "12": {                          // 页码（1 起）字符串键；只存画过的页
      "w": 595.28,                   // 该页 scale=1 视口宽（校验/换算锚点）
      "h": 841.89,
      "strokes": [
        {
          "tool": "pen",             // "pen" | "hl"（荧光笔）
          "color": "#e03131",
          "width": 2.5,              // 基准笔宽，页面坐标单位
          "pressure": 0,             // 0=无压感（pts 是 [x,y] 对）；1=有（[x,y,p] 三元组）
          "pts": [120.5, 88.0, 121.1, 92.3]   // 扁平数组，页面坐标系
        }
      ]
    }
  }
}
```

要点：

- **坐标系**：`page.getViewport({ scale: 1 })` 输出空间——左上原点、y 向下、单位为 PDF 用户单位。渲染时只需乘 `kx = fittedViewport.width / baseW` 一个系数，天然与 dpr、fitWidth、设备无关。
- **压感省空间**（手写笔已确认，此路径将实际生效）：手指书写 pressure 恒 0.5，存了浪费一半空间（Saber v12 同样优化）；只有 `pointerType === 'pen'` 且压力值不全为 0.5（无压感默认值）时置 1 存三元组——恒定非 0.5 的笔也照存，保证重绘保真。
- **点抽稀**：入栈前过滤距上一点 < 1.0（页面单位）的采样，2 秒笔画约 120 点 → 60-80 点。
- **体积估算**：一本画满 200 页、每页 30 笔的书 ≈ 6k 笔 ≈ 1.5MB JSON，远小于其 PDF 本体；一次性读入内存无压力。

### 5.3 损坏处理

解析失败/结构非法时不阻断阅读：文件改名留档 `annotations/<docId>.corrupt-<n>.json`（沿用 library.json 损坏回退的顺延编号思路），本次按空墨迹继续，toast 告知。写回时不覆盖留档。

### 5.4 与两端运维的交互（已核实）

- **平板端孤儿清扫**（library-core.mjs:673-698）：只碰 `files/`、`covers/` 与各处 `*.tmp`——`annotations/` 不在扫描范围，安全。
- **`npm run push:library -- --wipe`**：`rm -rf` 整个 SolaceLibrary，平板端墨迹会随之清掉。这是"整库替换"语义的正确行为（桌面端无墨迹），但要在脚本执行输出里加一行提示（「--wipe 会同时清掉平板端手写标注」），并写进本方案的运维注意。

## 6. 交互设计

### 6.1 入口与模式切换

- 预览顶栏 `#btnNotes` 旁新增「✏️ 标注」按钮（index.html 补丁 +1，锚点 `#btnNotes` 行，稳定）。
- 点击进入标注模式：工具栏从底部滑入（墨迹层出现并加载本书墨迹），再点「完成」退出（立即冲刷保存，工具栏滑出）。
- 退出后墨迹**常显**于页面（阅读模式可见批注；2026-10-03 真机测试后拍板，原「淡显后隐藏」废弃）——有墨迹的页显示墨迹层（`ink-passive`：pointer-events 关闭，滚动/翻页手势穿透），无墨迹的页不占交互；关预览才隐藏。
- 标注模式下顶栏按钮（目录/笔记/外部打开）保持可用；目录/笔记面板打开时自动暂挂绘制（面板关闭恢复），不强制互斥退出。

### 6.2 工具栏（动态创建，不占 index.html）

```
[笔] [荧光笔] [橡皮] | [撤销] [重做] | [色板] [粗细] | [清空本页] [完成]
```

- 色板按工具独立：笔 5 色（黑/红/蓝/绿/灰），荧光笔独立 1 色（黄 #fff00a）；
  点击展开小弹层，选中态高亮。橡皮无颜色/粗细，对应按钮置灰。
- 粗细三档（细/中/粗）：笔映射 1.5 / 2.5 / 4.0，荧光笔 8 / 12 / 18（页面单位）。
- 工具与颜色/粗细独立记忆（笔和荧光笔各记一套，当前工具也记住），存
  localStorage（`solace.ink.tools`），不进 library.json。
- 清空本页带确认（复用 askConfirm），可经「撤销」恢复。
- 笔画参数在 pointerdown 时捕获：画到一半切换工具/颜色不影响进行中的笔画。

### 6.3 手势仲裁（关键冲突处理）

标注模式下原有单指手势全部让位给绘制：

| 手势 | 阅读模式（现状） | 标注模式 |
|---|---|---|
| 单指横滑 | 翻页 | **画笔** |
| 单指快速点按（边缘 20%） | 翻页 | 画一个点（边缘热区禁用，防误翻页） |
| 单指纵滑 | 页面滚动 | 画笔 |
| 双指拖动 | 放弃手势（防误翻页） | **滚动页面**（手动调 previewBody.scrollTop） |
| 双指快速点按 | 放弃 | 放弃 |

实现：`mobile.js` 的指针手势段（59-97 行）加 `window.inkActive` 守卫——mobile-web 自有文件，直接改，不走补丁。墨迹 canvas `touch-action: none`。双指滚动在 ink.js 层内实现（两指中点位移 → `previewBody.scrollTop`，自然方向）；第二指落下时作废进行中的笔画、该手势整体转为滚动。目录/笔记面板打开期间不起新笔（关闭恢复）。

**防手掌误触（默认开启，已确认使用手写笔）**：本会话内一旦收到 `pointerType === 'pen'` 的 pointerdown，后续 `pointerType === 'touch'` 的指针一概忽略——**绘制与双指滚动仲裁同时豁免**，写字时手掌搭屏既不出墨也不会带跑页面。笔尖离开屏幕后恢复 touch 生效（抬笔后手指仍可直接画）。

### 6.4 返回键语义（boot.mjs backButton 链插入）

标注模式激活时，返回键 = 退出标注模式（而不是关预览），退出即冲刷保存——不弹确认（2026-10-03 真机拍板；写失败已有 toast + 重试 + 保留模型兜底；原「未保存确认」设计随「退出即冲刷」语义废止）。实现：boot.mjs 的 backButton 处理器在「对话框 → 预览」之间插入一级 `window.inkActive` 检查，派发 `solace-ink-exit-request` 事件；ink.js 监听后退出标注（boot.mjs 直接改，非补丁）。

## 7. 渲染管线

### 7.1 笔迹生成

- 采集：pointerdown 起笔 → pointermove 累点（rAF 批处理）→ pointerup 收笔提交。
- 每帧：`getStroke(points, { size, thinning, smoothing, ... })` 生成描边多边形 → `ctx.fill()`。perfect-freehand 的 size 参数乘当前 `kx × dpr`，笔宽随缩放同乘——**任何倍率下边缘锐利**。
- 活动 canvas 每帧只重画当前这一笔；提交后画入静态 canvas 并触发防抖保存。
- 撤销/重做/清页：静态 canvas 全量重绘（每页笔画数量级下 < 10ms，无感知）。

### 7.2 荧光笔的「不叠深、不盖字」

Saber 的做法照搬思路：荧光笔笔画先画进**离屏层**（不透明、无 alpha），再把离屏层以 `globalCompositeOperation = 'multiply'` 一次性合成到墨迹层。效果：同一笔反复划过颜色不变深，底下的 PDF 文字清晰透出（纸上荧光笔的物理行为）。

实现补充（2026-10-03）：画布内 multiply 够不到下层元素里的 PDF——「文字透出」由墨迹容器 `.ink-layer` 的 CSS `mix-blend-mode: multiply` 对整层补上（层内两层 canvas 先以普通叠加自合成，不互相变深）。离屏并集 + 层合成合起来即「不叠深、不盖字」，浏览器截图像素断言（黑线在荧光下保持深色）已覆盖。

### 7.3 布局与缩放

当前预览无缩放（fitWidth 单档），布局变化只有两种：窗口 resize / 屏幕旋转。此时 preview.js 会重设 canvas 尺寸并重渲染——同一处代码 dispatch `solace-ink-layout`，ink.js 收到后：

1. 重设两层墨迹 canvas 尺寸（同 fitted 尺寸 × dpr 对齐）
2. 用存储的页面坐标 × 新 `kx` 全量重绘静态层

墨迹矢量存储的价值即在此：将来预览加捏合缩放（临时 CSS 缩放保流畅、松手重渲染），墨迹沿用同一事件同一管线，零额外设计。

### 7.4 会话守卫

首次读取使用 loading / ready / error 状态：读取成功前暂不允许落笔或覆盖保存；读取失败显示提示，重新进入标注或点按页面可重试，磁盘上的已有墨迹保持不动。加载中关预览/换书仍由代数作废，不能把空模型写回。

`solace-ink-layout` 事件携带 docId；ink.js 以 `loadedDoc`（内存模型当前归属）
+ `loadSeq`（模型代数）双重对账——归位/关闭时代数 +1，在途读取按代数作废
（同书快速关开会有两个在途读取，仅比 docId 区分不开，旧结果合并会把同一批
笔迹翻倍）。事件到达时若与内存归属不符（换书/关后重开/激活早于首次
layout），先冲刷旧书再弃内存重读。冲刷挂入结算链（含在途写）：读前先等链结算，写失败入快照队列、重进该书时回灌内存并置脏补写——否则盘上旧态会被当基准读回，快照里的笔迹在下一次以内存为准的写入时被覆盖丢；数据层 read 也排队于写链，二者互为兜底。dispatch 点在 preview.js 补丁锚点内、
上游已有双重 isCurrentSession 拦截，过期渲染无法走到 dispatch。

### 7.5 内存预算

新增两层 canvas ≈ 2 × (fitted.width × fitted.height × 4B)。典型平板 dpr=2、页面 1600×2200 CSS → 每层约 56MB 设备内存。可接受（WebView 堆预算内、仅预览打开期间存在），但列入风险监控项；若低端机吃紧，后续把活动层降为 dpr=1 或合并为单层 + 脏矩形重绘。

## 8. 保存管线

| 触发点 | 行为 |
|---|---|
| 每次提交/撤销/重做/清页 | 重置 1.5s 防抖计时器 |
| 防抖到期 | 原子写 `annotations/<docId>.json`（只写有墨迹的页；全书无墨迹则删文件） |
| 退出标注模式 / 关预览（`solace-ink-close`） | 立即冲刷（取消防抖直写） |
| `appStateChange` → 后台 | 冲刷（防进程被杀丢墨迹） |
| 换书（layout 事件 docId 变化） | 冲刷旧 doc 再加载新 doc（挂结算链；写失败快照在重进时回灌） |

写操作在 annotations-core 内用 promise 链串行化（同 notes-core 的 createChain 模式），冲刷与防抖写并发时只落最终状态；读排队于写链尾，不返回在途写结算前的旧态。

回后台冲刷的真机实测边界（2026-10-03，详见 PORTING.md「手写标注」章）：
`solace-ink-flush` 约在收笔后 1.8s 才到页面（HOME 注入 + onPause + 过桥），
而本机 WebView 在后台仍继续跑 JS 定时器，1.5s 防抖通常已先写完。因此后台
冲刷是**独立于定时器的第二条保险**（OEM 冻结后台 JS 时定时器不响、原生
事件仍派发），不是更快的那条路；真机判据取「事件必达 + 笔迹不丢」。

## 9. 桥接层改动

```js
// boot.mjs 新增（签名示例）
readAnnotations:  gate((id) => annotations.read(id)),    // → { version, pages } 或 { version:1, pages:{} }
writeAnnotations: gate((id, data) => annotations.write(id, data)),  // 校验+原子写，返回 true
```

annotations-core.mjs：docId 白名单（同 notes-core 的正则）、read（不存在→空对象；损坏→留档+空对象+notice）、write（结构浅校验后原子写）。

## 10. 补丁清单增量（sync-www.mjs）

| 文件 | 增量 | 锚点 |
|---|---|---|
| index.html | +1 | `#btnNotes` 按钮行后插「✏️ 标注」按钮 |
| preview.js | +1 | 尺寸设定段（canvas.style.height 之后）dispatch `solace-ink-layout` |
| preview.js | +1 | `closePreview()` 内 dispatch `solace-ink-close` |

补丁总数 31 → **34**，同步更新 PORTING.md 补丁清单与 sync-www 末尾计数日志。preview.js 两处补丁刻意选在「结构稳定」的行（尺寸四行赋值、closePreview 开头），上游漂移风险低；锚点校验机制保证漂移时显式报错。

## 11. 实施阶段

| 阶段 | 内容 | 交付物 | 自测 |
|---|---|---|---|
| P1 数据层 | annotations-core + boot 桥方法 + 损坏回退 | bridge/ 两文件 | test/annotations-core.test.js（读写回环、路径穿越拒绝、损坏回退、并发写串行化） |
| P2 渲染核心 | perfect-freehand vendor 产物、墨迹双 canvas、layout/close 事件补丁、静态层重绘 | ink.js 骨架、补丁 3 处 | 浏览器：画一笔→翻页回来还在；旋转屏幕不错位 |
| P3 交互 | 工具栏全套、笔/荧光笔/橡皮、撤销重做、手势仲裁、返回键、清页确认 | ink.js 完整、mobile.js 守卫 | 浏览器 + 平板真机 |
| P4 收尾 | 防抖/冲刷复核、后台冲刷、PORTING.md/CHANGELOG、push:library 提示 | 文档 + 全量回归 | npm test 全绿 + 真机全流程（画→关→重开→橡皮→**覆盖安装**后数据还在） |

> P4 自测口径修正（2026-10-03）：原写「卸载重装数据还在」不成立——资料库
> 在应用专属外部目录 `Android/data/<pkg>/files/`，Android 卸载应用时必然
> 删除该目录（真卸载会连带毁掉平板上的真实资料库与全部标注）。改为验证
> **覆盖安装**（`adb install -r`）后标注仍在，即数据不落在会被清的 cache
> 目录；「卸载即丢失」已作为存储告警写进 PORTING.md。

进度（2026-10-03）：P1、P2、P3、P4 全部完成并真机验证。

P4 交付明细：① 补齐 §8 缺失的「`appStateChange` → 后台冲刷」（boot.mjs
派发 `solace-ink-flush`、ink.js 收到即 `flushSave()`，不设 active 守卫——
阅读模式下模型仍可能带脏）；② 六个触发点逐条复核（提交/撤销/重做/清页
重置防抖、防抖到期原子写、退出标注、关预览、回后台、换书挂结算链）；
③ PORTING.md 新增「手写标注（墨迹层，0.4.0）」章 + 数据兼容与存储位置
补 `annotations/` 不变量与卸载告警；④ CHANGELOG 新增 `[0.4.0] - 2026-10-03` 并定版（package.json 0.4.0、
versionCode 400）；⑤ push-library `--wipe` 提示；⑥ 回归：单测 38/38、
浏览器 harness 竞态 6（新增回后台冲刷场景，先 RED 后 GREEN）+ P3 专测 11
+ 目视 6、真机全流程 + 覆盖安装持久性（173 笔逐字节完好）。

工作量估算：新增 ~950 行（ink.js 450 / core 120 / 测试 200 / css 120 / 补丁+杂项 60），改动 ~60 行（boot.mjs、mobile.js、sync-www.mjs、push-library.mjs）。

## 12. 风险与开放问题

**风险**

| 风险 | 缓解 |
|---|---|
| 墨迹层内存（2×canvas） | 仅预览期存在；后续可降 dpr 或单层脏矩形 |
| 手指书写时 perfect-freehand 细节观感需调参 | thinning/smoothing 参数真机调优（P3 预留） |
| preview.js 上游改动漂移 | 锚点校验显式报错（现有机制），锚点选在稳定结构行 |
| 每页数百笔后橡皮命中测试变慢 | MVP 点距遍历（O(点数)，数万点内无感）；超限再做空间索引 |

**已拍板（2026-10-02 评审）**

1. **手写笔：确认使用**——防手掌误触默认开启（见 6.3），压感存储路径将实际生效。
2. **桌面端：暂不需要此功能**——schema 保持最小，不加 `createdBy` 等跨端字段；`annotations/` 在桌面端静默共存。将来若桌面端要渲染，加字段读取即可，格式向前兼容。
3. **色板**：默认 6 色（黑/红/蓝/绿 + 黄荧光 + 灰），后续可随时调整（2026-10-03 落定：笔 5 色 黑/红/蓝/绿/灰 + 荧光笔独立 1 色 黄 #fff00a，见 §6.2；**2026-10-07 扩充：荧光笔 5 色** 黄 #fff00a（默认）/红 #ff6b6b/绿 #51cf66/蓝 #4dabf7/紫 #b197fc——渲染零改动：离屏并集层逐笔填色，异色重叠「后画覆盖」不互相叠深，色值真机调色）。
4. **荧光笔色板独立于笔**（随工具切换，Saber 同款）。
5. **橡皮语义**（2026-10-03 拍板「笔画级」；**2026-10-07 二次拍板升级为局部擦拭**）——划过按擦拭圆局部切割（矢量切割见 §13），一次擦除手势 = 一条撤销记录（语义保持）；手势中途被中止（第二指落下转滚动、同书翻页）时已切割保持并同样补记。
6. **撤销/重做：会话级内存栈**（2026-10-03 补拍）——覆盖「提交/擦除/清空本页」；换书、关预览清空；撤销到非当前页的操作时自动跳回目标页（例外：关预览冲刷失败、模型保留待重试时，操作栈随模型保留至下次会话边界）。

## 13. 局部擦拭与荧光多色（2026-10-07 拍板）

**四项决策**：①橡皮尺寸三档 8/14/22 页面单位（默认 14，粗细弹层解禁为尺寸弹层、跨会话记忆）；②擦除命中半径叠加笔宽一半（有效半径 = r + width/2，轻碰粗荧光边缘即切断）；③局部擦拭 = **矢量切割**（ink-erase.mjs 纯函数 `splitStroke`：擦除圆覆盖的采样点剔出，幸存连续段 ≥2 采样重组为新 stroke、继承 tool/color/width/pressure 与 pts 形态，孤立单点段丢弃——schema 零改动、文件不膨胀）；④橡皮光圈（`.ink-cursor` 细描边圆环随指针，直径 = 2r×cssW/baseW，改尺寸/布局即时重算）。

**撤销体系增量**：新 op 类型 `{type:'modify', page, mods:[{before, after[], index}]}`——一次手势内同笔多刀只记一条（`origins` 记原笔与首切下标、`segOrigin` 记段归属，settle 时收集最终段集）；applyOp 按引用优先定位、下标兜底，undo 把段列换回原笔、redo 反向。会话级栈、清栈边界、跨页跳转语义全部沿用拍板 6。

**测试**：test/ink-erase.test.js 8 例（切割几何/字段继承/叠加笔宽/短段丢弃/压感保形）+ mobile-regressions 4 例（切割落盘/撤销重做/多刀一条/中途翻页补记，inkHarness 扩 pick/undo/redo/stack/strokes 暴露——橡皮路径首次进 node 回归）。

**真机检查单**（2026-10-07 验收全过，vivo PA2353）：
- [x] a. 荧光五色可选、默认黄 #fff00a、混色同页共存（数据落盘四色 + 画布像素
      逐条比对色值精确一致；视觉截屏评审三色可见、绿条系评审模型漏检由像素
      证实；通透/不叠深由既有 multiply 机制保证、未改动）
- [x] b. 橡皮三档 8/14/22 可调（圆点档位）、默认 14、光圈直径随档变
      （实测 28/50/78px）；跨会话记忆经 **force-stop 重启** 验证存活
      （tool/pen/hl/eraser 全套 + 档位选中态恢复）
- [x] c. 细笔中段划过断两截（13 采样 → [6,6]）、端点切割变短（13→11）、
      反复扫抹整线消失（段数归零、碎段无残留）
- [x] d. 粗荧光（宽 12）中心线上方 17 页面单位（< r+width/2=20）轻碰即断；
      偏移 22（> 20）不命中的反向对照通过；撤销复原整条
- [x] e. 单刀：撤销一键复原整笔（[6,6]→[13]）、重做恢复切割；一次手势
      两刀（中点+四分之一处）三段 [2,3,6] 仍只记一条撤销、一键复原
- [x] f. 退出标注重进 8 条保持；翻页往返 30→31→30 后重绘 8 条保持；
      关预览重开墨迹常显（像素验证）+ 侧车数据一致
- [x] g. 光圈随指针移动（left/top 实时更新）、随档位/布局变径；
      退出标注随墨迹层隐藏不残留
- [x] h. 关预览重开撤销栈清空（undo 钮 disabled 实证）
- [x] i. 旧版标注文件兼容：schema/validate 零改动，关预览重开即从盘重读
      渲染（读写回环验证）；旧格式与新格式同构

## 验收记录（2026-10-07）

真机检查单 a–i 全过（合成 PointerEvent 驱动 + 画布像素哈希/采样断言 +
`solace-ink-flush` 强制冲刷后读侧车 + force-stop 重启记忆验证 + 截图视觉评审）。
**真机抓到并修复一处 bug**：色板弹层构建 `buildPops` 无条件读 `TOOLS[tool].colors`，
橡皮无 colors 时 `for...of undefined` 抛异常——尺寸段不重建、弹层残留上一工具
内容（现象：橡皮档位显示荧光的 8/12/18）。修复：橡皮时清空并跳过色板段。
**验收方法论**：侧车读取必须等 1.5s 防抖落盘或先派发 `solace-ink-flush`
强制冲刷，否则读到旧盘态产生假阴性（首轮三项「失败」皆此假象）。

### §13 增补：橡皮尺寸四档（2026-10-07 二次拍板）

尺寸三档 8/14/22 → **四档 4/8/14/22**（默认仍 14，localStorage 旧值天然
兼容）。最小档 4 页面单位 = 屏上 ≈14px，恰等于最粗笔画（4.0 档）的宽度
——「笔尖级」精确橡皮；调研锚点：GoodNotes 6 专门新增 Precision Eraser
（只擦圆内）、Notability 用滑杆提供更细粒度、GoodNotes 5 三档被用户长期
抱怨最小档太大（feedback 论坛 #39179956）。真机实测：4 档对 12 单位采样
间距的细笔线一刀恰好豁掉 1 个采样点（[8,8]），叠加笔宽机制下粗荧光仍整
段可断。
