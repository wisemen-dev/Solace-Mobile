# 方案书：预览手写标注（墨迹层）

> 状态：评审决策已记录（2026-10-02）——手写笔用户（防误触默认开启）；桌面端暂不需要此功能。待确认开工后开始写代码。
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
  │    detail: { docId, sessionId, token, page, total,
  │              kx, w, h, cssW, cssH, baseW, baseH }
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
- **压感省空间**（手写笔已确认，此路径将实际生效）：手指书写 pressure 恒 0.5，存了浪费一半空间（Saber v12 同样优化）；只有 `pointerType === 'pen'` 且压力值非恒定时置 1 存三元组。
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
- 点击进入标注模式：工具栏从底部滑入（墨迹层出现并加载本书墨迹），再点「完成」退出（冲刷保存，工具栏滑出，墨迹层保留淡显 0.5s 后隐藏——不退出也能看见批注）。
- 标注模式下顶栏按钮（目录/笔记/外部打开）保持可用；目录/笔记面板打开时自动暂挂绘制（面板关闭恢复），不强制互斥退出。

### 6.2 工具栏（动态创建，不占 index.html）

```
[笔] [荧光笔] [橡皮] | [撤销] [重做] | [色板▾] [粗细▾] | [清空本页] [完成]
```

- 色板默认 6 色（黑/红/蓝/绿/黄荧光/灰），点击展开（复用对话框样式体系）。
- 粗细三档（细/中/粗），映射页面单位 1.5 / 2.5 / 4.0。
- 工具与颜色/粗细独立记忆（笔和荧光笔各记一套），存 localStorage，不进 library.json。

### 6.3 手势仲裁（关键冲突处理）

标注模式下原有单指手势全部让位给绘制：

| 手势 | 阅读模式（现状） | 标注模式 |
|---|---|---|
| 单指横滑 | 翻页 | **画笔** |
| 单指快速点按（边缘 20%） | 翻页 | 画一个点（边缘热区禁用，防误翻页） |
| 单指纵滑 | 页面滚动 | 画笔 |
| 双指拖动 | 放弃手势（防误翻页） | **滚动页面**（手动调 previewBody.scrollTop） |
| 双指快速点按 | 放弃 | 放弃 |

实现：`mobile.js` 的指针手势段（59-97 行）加 `window.inkActive` 守卫——mobile-web 自有文件，直接改，不走补丁。墨迹 canvas `touch-action: none`。

**防手掌误触（默认开启，已确认使用手写笔）**：本会话内一旦收到 `pointerType === 'pen'` 的 pointerdown，后续 `pointerType === 'touch'` 的指针一概忽略——**绘制与双指滚动仲裁同时豁免**，写字时手掌搭屏既不出墨也不会带跑页面。笔尖离开屏幕后恢复 touch 生效（抬笔后手指仍可直接画）。

### 6.4 返回键语义（boot.mjs backButton 链插入）

标注模式激活时，返回键 = 退出标注模式（而不是关预览）。有未保存修改则先走未保存确认（复用笔记编辑器的 `solace-close-request` 拦截模式）。实现：ink.js 在激活时向 boot 的返回键链注册自身——boot.mjs 的 backButton 处理器在「对话框 → 预览」之间插入一级 `window.inkActive` 检查（boot.mjs 直接改，非补丁）。

## 7. 渲染管线

### 7.1 笔迹生成

- 采集：pointerdown 起笔 → pointermove 累点（rAF 批处理）→ pointerup 收笔提交。
- 每帧：`getStroke(points, { size, thinning, smoothing, ... })` 生成描边多边形 → `ctx.fill()`。perfect-freehand 的 size 参数乘当前 `kx × dpr`，笔宽随缩放同乘——**任何倍率下边缘锐利**。
- 活动 canvas 每帧只重画当前这一笔；提交后画入静态 canvas 并触发防抖保存。
- 撤销/重做/清页：静态 canvas 全量重绘（每页笔画数量级下 < 10ms，无感知）。

### 7.2 荧光笔的「不叠深、不盖字」

Saber 的做法照搬思路：荧光笔笔画先画进**离屏层**（不透明、无 alpha），再把离屏层以 `globalCompositeOperation = 'multiply'` 一次性合成到墨迹层。效果：同一笔反复划过颜色不变深，底下的 PDF 文字清晰透出（纸上荧光笔的物理行为）。

### 7.3 布局与缩放

当前预览无缩放（fitWidth 单档），布局变化只有两种：窗口 resize / 屏幕旋转。此时 preview.js 会重设 canvas 尺寸并重渲染——同一处代码 dispatch `solace-ink-layout`，ink.js 收到后：

1. 重设两层墨迹 canvas 尺寸（同 fitted 尺寸 × dpr 对齐）
2. 用存储的页面坐标 × 新 `kx` 全量重绘静态层

墨迹矢量存储的价值即在此：将来预览加捏合缩放（临时 CSS 缩放保流畅、松手重渲染），墨迹沿用同一事件同一管线，零额外设计。

### 7.4 会话守卫

`solace-ink-layout` 事件携带 docId；ink.js 以 `loadedDoc`（内存模型当前归属）
对账——事件到达时若与内存归属不符（换书/关后重开/激活早于首次 layout），
先冲刷旧书再弃内存重读，加载在途的旧结果按 docId 作废。与 token 校验等价
（docId 变化必经新 layout，而 dispatch 点在 preview.js 补丁锚点内、上游已有
双重 isCurrentSession 拦截，过期渲染无法走到 dispatch），且顺带覆盖
「同书重开」场景。

### 7.5 内存预算

新增两层 canvas ≈ 2 × (fitted.width × fitted.height × 4B)。典型平板 dpr=2、页面 1600×2200 CSS → 每层约 56MB 设备内存。可接受（WebView 堆预算内、仅预览打开期间存在），但列入风险监控项；若低端机吃紧，后续把活动层降为 dpr=1 或合并为单层 + 脏矩形重绘。

## 8. 保存管线

| 触发点 | 行为 |
|---|---|
| 每次提交/撤销/重做/清页 | 重置 1.5s 防抖计时器 |
| 防抖到期 | 原子写 `annotations/<docId>.json`（只写有墨迹的页；全书无墨迹则删文件） |
| 退出标注模式 / 关预览（`solace-ink-close`） | 立即冲刷（取消防抖直写） |
| `appStateChange` → 后台 | 冲刷（防进程被杀丢墨迹） |
| 换书（layout 事件 docId 变化） | 冲刷旧 doc 再加载新 doc |

写操作在 annotations-core 内用 promise 链串行化（同 notes-core 的 createChain 模式），冲刷与防抖写并发时只落最终状态。

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
| P3 交互 | 工具栏全套、笔/荧光笔/橡皮、撤销重做、手势仲裁、返回键 | ink.js 完整、mobile.js 守卫 | 浏览器 + 平板真机 |
| P4 收尾 | 防抖/冲刷、后台冲刷、清页确认、PORTING.md/CHANGELOG、push:library 提示 | 文档 + 全量回归 | npm test 全绿 + 真机全流程（画→关→重开→橡皮→卸载重装数据还在） |

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
3. **色板**：默认 6 色（黑/红/蓝/绿 + 黄荧光 + 灰），后续可随时调整。
4. **荧光笔色板独立于笔**（随工具切换，Saber 同款）。
