# 方案书：阅读工具簇（标注 / 笔记 / 链接收拢圆钮）

> 状态：**待评审**。交互三决策已由用户拍板（2026-10-05）：
> ① 展开后触发器三条杠形变为 ✕；② 展开项为纯图标圆钮（无文字标签）；
> ③ 保留模式激活光环。拟随 v0.5.2 落地。
> 设计参照：apple-design（WWDC《Designing Fluid Interfaces》原则集）、
> motion-web（动效 token / 状态矩阵 / 判据思维）。

## 1. 目标与非目标

**目标**

- 预览顶栏只保留「目录」「工具簇」「✕」三个控件：标注、笔记、链接三个
  功能收进一个三条杠圆钮，点击向下展开三个纯图标圆钮
- 展开动效自然：步进长出、同路径镜像收回、半途反点可打断顺滑逆转
- 功能行为零改动：三个按钮 ID 与事件绑定不变，`preview.js` / `ink.js` /
  `link.js` 一行不动，桌面端同步零影响
- 补丁总数不变（38 处）：工具簇替换原两条按钮注入补丁的同一锚点

**非目标（本期不做）**

- 目录收拢（用户明确保留目录为独立按钮）
- 长按快捷、功能自定义排序
- 触觉反馈（Capacitor Haptics 未安装，不为此加依赖）
- 顶栏其他 emoji 图标（🌓 等）的统一化改造

## 2. 关键决策一览

| # | 决策 | 选择 | 依据（原则 → 落点） |
|---|---|---|---|
| 1 | 触发器形态 | 36px 圆钮 + 三条短杠（CSS 绘制，非文字符号） | 汉堡语法是移动端最强识别符（affordance：能点 = 看得出能点）；圆钮与展开项同语言 |
| 2 | 展开后触发器 | 三杠形变为 ✕（上杠顺旋 45°、中杠缩没、下杠逆旋 45°，纯 transform） | 用户决策①；明示"再点即收"，闭合回路（§Agency：随时可逆） |
| 3 | 展开项形态 | 44px 纯图标圆钮 ×3，无文字标签 | 用户决策②；44pt 触达标准；图标走统一线宽 SVG（1.7px stroke、圆帽），三主题下着色可控 |
| 4 | 展开项排序 | 上→下：标注、链接、笔记 | 两个平板原生创作工具在前（近期使用重心），桌面继承的笔记浏览殿后；两个覆盖型模式（标注/选词）相邻成组 |
| 5 | 出场动效 | 从触发器身后步进长出：`opacity 0→1` + `scale 0.4→1` + 轻微下移，步进 40ms | 菜单类出场用临界阻尼、不弹跳（apple-design §4：overshoot 属于带惯性的手势，不属于"刚淡入的菜单"）；锚定源头的生长方向即路径暗示（§8） |
| 6 | 收回动效 | 同路径镜像逆放：远端先收、加速曲线、更短时长 | 空间一致性（§7：从哪来回哪去）；仓内惯例 exit 更快（--dur-exit 130ms < --dur 220ms） |
| 7 | 打断性 | CSS transition（非 keyframes）：类切换天然从**当前呈现值**起算 | §3 可打断：半途反点立即逆转、无跳帧；不引动画库 |
| 8 | 模式光环 | 标注/选词模式激活时触发器亮 `--accent` 描边 + `--accent-soft` 光圈 | 用户决策③；合起后仍可见"有模式在跑"，防迷失（wayfinding） |
| 9 | 材质 | `var(--panel)` 底 + `var(--line)` 描边 + `0 12px 32px rgba(0,0,0,0.5)` 阴影，圆角 12px | 与 `toc-panel` 同一浮面材质语言（§12：材质重量编码层级）；随三主题走 |
| 10 | 动效 token | 复用仓内 `--ease-out-expo` / `--ease-in-expo`，新增局部 `--tools-dur: 300ms` / 收回 200ms | 出/入用互逆控制点（§7 镜像缓动）；expo-out 快起缓收 ≈ 临界阻尼的感知特征 |

## 3. 不变量与约束（不可破）

1. **ID 不变**：`btnNotes` / `btnInk` / `btnLink` 三 ID 保持——`preview.js`
   （笔记面板开合）、`ink.js`（标注模式）、`link.js`（选词模式）的绑定与
   逻辑零改动。
2. **补丁锚点不变**：仍锚 `#btnNotes` 行（桌面仓库 `index.html` 原文），
   1 对替换，补丁总数 38 不变；锚点漂移显式报错机制照旧。
3. **桌面端零感知**：改动全部落在 `mobile-web/` 自有资产 + 补丁注入 +
   `bridge/boot.mjs`（自有文件），桌面仓库不动。
4. **返回键链只插一档**：对话框 > **工具簇展开** > 选词模式 > 标注模式 >
   关预览 > 退出。既有各档语义不变。
5. **不吞点击**：簇外点按收簇时不得 `preventDefault`/`stopPropagation`
   ——用户点「目录」时目录照常打开，簇只是同时收起。

## 4. 静态设计（两态静帧）

> **修订（真机评审二轮，2026-10-06）**：顶栏三控件分层——目录升为主操作
> （accent 色调胶囊 + 书签图标，图标经 CSS mask 注入、无 DOM 补丁）、
> 工具簇触发器保持中性圆钮、关闭弱化为无边框纯文字 ✕；间距 8→12px。
> 另去除 WebView 默认点击高亮（tap highlight 方块，罩到触发器外扩命中区
> 后呈大方框），`#btnToc[hidden]` 显式压回 `display:none` 防 id 选择器
 > 覆盖 UA 隐藏规则。均落 mobile.css。
>
> **修订（真机评审三轮，2026-10-07）**：① 阅读浮层与创作模式互斥让位
> （§6 新路径 11）——进标注/链接先收目录/笔记面板（面板 z6 悬在墨迹
> 层 z2、文本层 z1 之上，同屏时拦截左侧 ~300px 的落笔/拖选）；开面板
> 先退出标注/选词。双向都在 tools.js。② 菜单改气泡语言消解割裂感：
> 上边 10px 旋转小箭锚定触发器、下探 8px、内距/行距 8/6、展开项去
> 描边去底色（双层镶边是割裂感主源）。

### 4.1 收起态

```
.preview-head（54px，var(--panel) 底）
┌──────────────────────────────────────────────────────────┐
│ 《书名……………………》        [目录]  ╭───╮  ╭───╮          │
│                                  │ ≡ │  │ ✕ │          │
│                                  ╰───╯  ╰───╯          │
└──────────────────────────────────────────────────────────┘
                                   ↑ #btnTools：36px 圆钮，
                                     三条 12×1.8px 短杠居中
```

- 触发器：36px 圆，`--panel` 加深底（`--card`）、`--line` 描边；
  按下 `:active` 即时 `scale(0.94)`（按下即反馈，不等抬手）
- hover / `:focus-visible`：描边转 `--accent`
- 光环态（`.tools-active`）：描边 `--accent` +
  `box-shadow: 0 0 0 3px var(--accent-soft)`

### 4.2 展开态

```
        [目录]  ╭ ✕ ╮ ← 触发器形变完成，层级最高（z:8）
                ╰─┬─╯
              ┌───┴────────┐
              │ ╭───╮       │ ← #toolsMenu：竖列，右对齐触发器，
              │ │ ✎ │ 标注  │   下探 10px；panel 底 + line 描边 +
              │ ╰───╯       │   阴影，圆角 12px，z:7
              │ ╭───╮       │
              │ │ ⛓ │ 链接  │ ← 图标仅示意（见 §4.3 规格），
              │ ╰───╯       │   无文字标签
              │ ╭───╮       │
              │ │ ▤ │ 笔记  │
              │ ╰───╯       │
              └─────────────┘
```

- 展开项：44px 圆钮，`--card` 底、`--line` 描边；图标 20px、色 `--text`
- 按下：`scale(0.92)` + 底色微亮（`--card-hover`），即时响应
- hover / focus：描边与图标转 `--accent`
- 命中区：slot 高 48px（钮 44px + 上下余量），≥ Apple 44pt 触达标准；
  触发器视觉 36px、命中区 `::after` 外扩至 44px
- 层级：菜单 z:7（高于 toc/notes 面板的 6、ink 工具栏的 4）；
  触发器 z:8（菜单从其身后长出，收回时没入其后）

### 4.3 图标规格（SVG，viewBox 0 0 20 20，stroke 1.7、圆帽圆角、无填充）

| 功能 | 隐喻 | 路径 |
|---|---|---|
| 标注 `#btnInk` | 铅笔 | `M13.2 3.4l3.4 3.4L7.4 16H4v-3.4z` + 笔尖分隔线 `M11.4 5.2l3.4 3.4` |
| 链接 `#btnLink` | 断开的链环 | `M10 7l1.4-1.4a2.1 2.1 0 0 1 3 3L13 10` / `M10 13l-1.4 1.4a2.1 2.1 0 0 1-3-3L7 10` / 环轴 `M8.6 11.4l2.8-2.8` |
| 笔记 `#btnNotes` | 带折角的纸页 | 页形 `M11.5 2.5H6A1.5 1.5 0 0 0 4.5 4v12A1.5 1.5 0 0 0 6 17.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5z` + 折角 `M11.5 2.5v4h4` + 文本行 `M7.5 10.5h5M7.5 13.5h5` |

纯图标无文字，`title` + `aria-label` 必备（§7 可访问性）。

## 5. 动效规格

### 5.1 展开（点触发器，收起 → 展开）

| 项 | 值 |
|---|---|
| 单钮位移 | `translateY(-10px) → 0`（自上而下入位，暗示从触发器方向来） |
| 单钮缩放 | `scale(0.4) → 1`，`transform-origin: 50% 0`（顶边锚定，向上生长感） |
| 单钮透明度 | `0 → 1` |
| 时长/缓动 | 300ms `var(--ease-out-expo)`（快起缓收，无过冲） |
| 步进 | 40ms/钮，近触发者先出：标注 0ms → 链接 40ms → 笔记 80ms |
| 实现槽位 | 每钮一个 `.tools-slot`（`--tools-i: 0..2`），`transition-delay: calc(var(--tools-i) * 40ms)` |

### 5.2 收回（展开 → 收起，任一收起路径触发）

| 项 | 值 |
|---|---|
| 路径 | 与展开完全同轴镜像：`0 → translateY(-10px) scale(0.4)`、`1 → 0` 透明 |
| 时长/缓动 | 200ms `var(--ease-in-expo)`（互逆控制点 = 镜像缓动；退出更快是仓内惯例） |
| 步进 | 反序：远端（笔记）0ms 先收 → 标注最后没入触发器身后（`delay: calc((2 - var(--tools-i)) * 30ms)`） |

### 5.3 触发器三杠 → ✕（与展开同帧开始）

| 杠 | 收起态 | 展开态 |
|---|---|---|
| 上 | 0° | `translateY(4.8px) rotate(45deg)` |
| 中 | 0° | `scaleX(0.2)` + `opacity: 0` |
| 下 | 0° | `translateY(-4.8px) rotate(-45deg)` |

200ms `var(--ease-out-expo)`，双向同曲线（就地小形变，非位移类动作，
双向同曲线不破坏镜像原则）。

### 5.4 光环（模式激活指示）

- 触发 `.tools-active`：`border-color → var(--accent)` +
  `box-shadow: 0 0 0 3px var(--accent-soft)`，160ms（`--dur-fast`）
- 纯颜色过渡，无位移无弹跳（非动量动作不加过冲）
- 数据源：`window.inkActive`（标注模式）｜`body.link-selecting`（选词
  模式）；tools.js 用 MutationObserver 监听 body 类变化 + 自定义事件兜底

### 5.5 打断与逆转

- 类切换式 CSS transition 天然从**当前呈现值**起算：展开进行到一半时
  再点触发器，各钮立即从当前位置转入收回曲线，无跳帧、无等待完成
- 已知小瑕疵：逆转瞬间各钮先服满新的 `transition-delay` 再动——读起来是
  "重新步进收回"，语义自洽，真机验收项（§10 检查单 b）
- 连点限速不需要：transition 重定向本身就是幂等的

### 5.6 降级（prefers-reduced-motion: reduce）

- 展开项：仅 `opacity 150ms` 淡入淡出，去位移/缩放/步进延迟
  （`transition: opacity 150ms; transition-delay: 0ms`）
- 触发器三杠 → ✕：保留（12px 图标就地旋转，非前庭类大幅运动），
  若实测不适再降为透明度切换

## 6. 交互状态机与完整生命周期

状态只有一个开关位：`#toolsCluster.open`（CSS 类）。无独立 opening/closing
状态——过渡由 CSS 承接，JS 只切类与同步光环。

**全部开合路径（生命周期收口，一条不漏）：**

| # | 触发 | 行为 | 落点 |
|---|---|---|---|
| 1 | 点触发器（收起态） | 展开 | tools.js 切类 + `aria-expanded` |
| 2 | 点触发器（展开态） | 收回（镜像逆放） | 同上 |
| 3 | 点三功能钮任一 | 原功能照常触发（绑定不动）**并**收回 | tools.js 在钮上追加监听（不占用/不替换原监听） |
| 4 | 点簇外任意处（正文、目录钮、顶栏其他钮、✕…） | 收回；被点元素的事件**照常透传** | tools.js `document` 捕获相 pointerdown：不在 `#toolsCluster` 内即收，不 preventDefault |
| 5 | Esc（预览开着、无对话框） | 先收簇；**不**关预览 | tools.js 捕获相 keydown：`stopPropagation()` 拦在 app.js 全局 Esc 之前 |
| 6 | Android 返回键（簇展开） | 先收簇 | boot.mjs 返回键链插档：对话框 > **簇** > 选词 > 标注 > 关预览（DOM 查询 `#toolsCluster.open`，无新耦合） |
| 7 | 关预览（簇还开着） | 瞬时复位收起态（无动画），重开预览不残留 | tools.js MutationObserver 监听 `#previewOverlay[hidden]` |
| 8 | 进标注/选词模式（经簇或经返回链退出后） | 簇已在路径 3/6 收起；触发器亮/灭光环 | 路径 3 + §5.4 |
| 9 | 旋转/分屏/resize | 菜单绝对锚定触发器（`#toolsCluster { position: relative }` + 菜单 `top: calc(100% + 10px); right: 0`），自动跟随 | 纯 CSS，无 JS |
| 10 | 目录/笔记面板开着时点触发器 | 照常展开簇（两面板互斥逻辑在 preview.js，簇不参与）；空白点按已有收面板语义不变 | 无新增处理 |

**与既有手势层的关系**：簇在 `preview-head`，`previewBody` 的滑动翻页/
边缘点按/拖选手势管辖范围不含顶栏，零冲突。

## 7. 可访问性

- `#btnTools`：`aria-expanded`、`aria-haspopup="true"`、`aria-controls="toolsMenu"`、`aria-label="阅读工具"`
- `#toolsMenu`：`role="menu"` + `aria-label="阅读工具"`；三钮 `role="menuitem"`
- 纯图标钮必须有 `aria-label`（笔记/标注/链接）——图标对读屏不可读
- `:focus-visible` 与 hover 同款描边反馈（键盘/开关控制可达）
- 图标用 `currentColor`，对比度随主题 token 走，不另造色
- 命中区 ≥ 44px（§4.2）；`touch-action: manipulation` 沿用全局规则

## 8. 技术方案

### 8.1 DOM（sync-www.mjs 补丁注入，替换原 btnInk/btnLink 注入对）

```html
<div id="toolsCluster" class="tools-cluster">
  <div id="toolsMenu" class="tools-menu" role="menu" aria-label="阅读工具">
    <div class="tools-slot" style="--tools-i: 0">
      <button id="btnInk" class="tools-circle" role="menuitem" title="手写标注" aria-label="标注">
        <svg …铅笔…/>
      </button>
    </div>
    <div class="tools-slot" style="--tools-i: 1"><!-- #btnLink 链环 --></div>
    <div class="tools-slot" style="--tools-i: 2"><!-- #btnNotes 纸页 --></div>
  </div>
  <button id="btnTools" class="tools-trigger" aria-expanded="false" aria-haspopup="true"
          aria-controls="toolsMenu" aria-label="阅读工具" title="标注 / 笔记 / 链接">
    <span class="tools-bar"></span><span class="tools-bar"></span><span class="tools-bar"></span>
  </button>
</div>
```

注意顺序：DOM 上菜单在触发器**之前**（后者 z:8 盖住菜单长出的根部，
"从身后长出"才是真的身后）；`--tools-i` 的 0/1/2 = 标注/链接/笔记（§2 决策 4）。

### 8.2 文件改动清单

| 文件 | 改动 | 规模 |
|---|---|---|
| `scripts/sync-www.mjs` | 原「#btnNotes 后注入两按钮」补丁对改为注入 §8.1 DOM；仍 1 对，总数 38 不变 | ~30 行 |
| `mobile-web/js/mobile/tools.js` | **新增**：切类、`aria-expanded`、路径 3/4/5/7 监听、光环同步（MutationObserver body 类 + ink 事件兜底） | ~90 行 |
| `mobile-web/js/mobile/mobile.js` | `import './tools.js'` | +1 行 |
| `mobile-web/css/mobile.css` | `.tools-*` 全部样式 + 过渡 + 降级（§4/§5 全量） | ~130 行 |
| `bridge/boot.mjs` | 返回键链插"簇展开"档（§6 路径 6） | +5 行 |
| `mobile-web/js/mobile/ink.js` | `setActive` 与 `solace-ink-close` 直排处共 +2 行：维护 `body.ink-active` 类 | +2 行 |
| `docs/PORTING.md` | 补丁清单第 10/11 条合并重写为工具簇条目 | 文案 |
| `CHANGELOG.md` | v0.5.2 条目 | 文案 |

**不动**：`www/js/preview.js`、`link.js`、`app.js`、桌面仓库全部（`ink.js`
仅上述 +2 行类维护——实施时发现 §8.3 原设想的"ink 既有事件"不存在，
`window.inkActive` 是纯 getter 无变更通知，故按 link.js 的 `link-selecting`
同构模式补类维护，为此设计书与实现同步记入本条）。

### 8.3 tools.js 状态同步（光环数据源）

```
标注模式：window.inkActive（ink.js 维护）——tools.js 轮询不可取，
  用 body 类变化观察 + ink 进入/退出时 dispatch 的既有事件兜底
选词模式：body.link-selecting（link.js 维护类，MutationObserver 直接可观察）
```

监听合并：任一为真 → `#btnTools.classList.add('tools-active')`。

## 9. 实施阶段

1. **S1 结构与静态样式**：补丁注入 + mobile.css 静态两态（无动效）——
   真机先看静帧（motion-web：静帧是交付物的一半，先过静帧再谈动效）
2. **S2 状态机**：tools.js 全部路径（§6 十条）+ boot.mjs 返回键档
3. **S3 动效**：过渡、步进、形变、光环、降级
4. **S4 文档与收尾**：PORTING.md / CHANGELOG / README 结构图

每阶段可独立真机验证；S1 静帧不满意只改 CSS，不动结构。

## 10. 验证与判据

**自动化**

- `npm run www` 重建成功（补丁锚点校验通过）
- `npm test` 全绿（回归桩不依赖此 DOM；可选：mobile-regressions 增
  tools.js 开合状态机 1–2 用例——DOM 替身下断言切类与 aria-expanded）

**真机检查单（动效判据，逐条过）**

| # | 检查 | 通过标准 |
|---|---|---|
| a | 展开自然度 | 三钮步进清晰（~40ms 间隔可感知不拖沓）、从触发器方向长出、无弹跳/无回弹 |
| b | 半途反点 | 展开进行中再点触发器：从当前位置顺滑转入收回，无跳帧、无瞬移 |
| c | 返回键链 | 簇开 → 返回键只收簇；再按走原链（选词 > 标注 > 关预览）；关闭其他浮层后 2 秒内按返回不误退（lastBackAt 清零逻辑未受扰） |
| d | Esc | 簇开 → Esc 只收簇不关预览；簇合 → Esc 关预览（原语义不变） |
| e | 光环 | 进标注/选词即亮、退出即灭；三主题下均清晰 |
| f | 透传 | 簇开 → 点目录：目录面板开 + 簇收，两者都发生 |
| g | 生命周期 | 簇开 → ✕ 关预览 → 重开预览：簇是收起态 |
| h | 降级 | 系统减弱动效下：淡入淡出无位移；三杠→✕ 仍可辨 |
| i | 布局 | 竖屏/横屏/分屏、书名超长省略号、目录钮隐藏（无大纲 PDF）三种顶栏组合均不溢出 |

## 11. 风险与开放问题

| # | 风险 | 应对 |
|---|---|---|
| 1 | 老 WebView 对 `transition-delay` 反向切换的呈现差异（逆转瞬间延迟重新计时） | S3 真机验 §10-b；不合格则收回改 0ms 步进（同动同收，损失步进感保顺滑） |
| 2 | 纯图标的首次可识别性（链接图标准度低于文字钮） | 用户已决策接受；`title` 补充；如真机试用发现误触率高，最小回退＝加回 11px 小字标签（结构预留 slot，不动逻辑） |
| 3 | `backdrop-filter` 材质增强在部分 WebView 不可用 | 仅作 `@supports` 渐进增强，默认实底 `var(--panel)`，不参与验收 |
| 4 | emoji（✏️/🔗）→ SVG 后与顶栏残留 emoji 钮（🌓）风格不完全统一 | 本期收口在工具簇；顶栏全面图标化为后续独立事项 |
| 5 | 标注模式下顶栏仍可点（误触触发器展开菜单覆盖绘图区顶部） | 菜单 z:7 < 绘图层手势主权：菜单出现不拦截 ink 层 pointer 事件（菜单只在 head 下探 ~180px，实测影响极小）；真机验标注中开簇无功能冲突 |
