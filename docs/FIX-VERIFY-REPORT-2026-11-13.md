# 五 bug 修复验证报告（2026-11-13 修复批）

验证团队：7 个并行 agent（2 静态审查 + 5 真机验证）。
设备：PA2353（DPD2305，serial 400D8S01LU00000），debug 包 2026-11-13 20:22 构建安装。

## 结论速览

| Bug | 判定 | 说明 |
|---|---|---|
| 1 沉浸标记漂移 | 🟡 基本修复 | 垂直漂移根治（≤1px）；残余 ~4.4px 水平单帧滞后（rAF 相位固有） |
| 2 标注颜色选择 | 🟢 真机全链 PASS | 5 色板/色点钮/会话默认/落盘 color:3/旧数据回退 c0 全部实证，sidecar 复原 |
| 3 选区手柄 | 🔴 未完成 | 手柄孤儿化（HIGH）+ 手柄抓取几何致命（HIGH）+ stale text（MEDIUM），三项均真机坐实 |
| 4 最左/最右字选不进 | 🟢 真机 PASS | A/B/C/E/F/G 全 PASS；原症状 8 次拖选均未复现（D 为验收文案方向笔误，实为 PASS） |
| 5 横向溢出平移 | 🟠 核心达成 | 边界回落翻页被 pointercancel 吞（MEDIUM） |

单测：185 → 193 全绿（新增 8 条，含调色板三处同值哨兵）。

## 缺陷清单

### D0 [已澄清][bug4] 验收项 D 的方向笔误

初版验收文案把 D 写成「首字左半 → 首字**不**在」，方向写反。源码
`endpointOffsetForDrag`（`link.js:632-650`）的语义是「指针越过字符中心（向外侧）→ 该字计入」，
两端通用、不区分拖哪一端，与原生文本选择一致：
- 左端「外侧」= 左半 → 首字**在**（dev-bug4 实测 `band.left = L`，Δ0.00）
- 右端「外侧」= 右半 → 末字**在**（实测 `band.right ≈ R`，Δ0.006）

dev-bug4 的 A/B/C/E/F/G 全部 PASS，原症状（最左/最右字选不进）在 8 次拖选中均未复现，
故 **bug4 判定为真机验证通过**，不需返工。

### D1 [HIGH][bug3] 手柄孤儿化——层重建后整会话失效

- 位置：`mobile-web/js/mobile/link.js:170`（`layer.textContent = ''`）+ `:417`（`ensureHandles` 早退）
- 根因：`buildLayer` 清空 layer 时摘除 `.lnk-handles`，但模块变量 `handleBox` 从不置 null；
  `ensureHandles` 首行 `if (handleBox || !layer) return` 直接早退，`placeHandles` 对游离节点操作无效。
- 真机实证（dev-bug3）：退出选词重进后拖选，拖选带与确认条正常建立，
  但文档中无 `.lnk-handles` 节点（`isConnected=false`），layer 子节点仅 `lnk-bands`+SPAN+BR。
- 触发路径：翻页 / 换书 / 退出重进选词（任何走到 `buildLayer` 的路径）。
- 修复：仿 `.lnk-bands` 模式每轮重查——`ensureHandles`/`placeHandles` 用
  `layer.querySelector(':scope > .lnk-handles')` 取当前节点并回写 `handleBox`；
  或在 `:170` 清空处同步 `handleBox = null`。

### D2 [HIGH][bug3] 手柄抓取几何——抓中心拖动必跳行

- 位置：`link.js:463`（`el.style.top = ir.y - layerRect.y + ir.height`）+ `mobile.css:502,505`
- 推导：手柄 22px 高、`transform: translate(-50%,-35%)` → 视觉中心 = 项底边 + 3.3px；
  行锚 y = 行中心，吸附阈值 0.6×行高 → 几何上吸附成立需 `H/2 + 3.3 < 0.6H`，即 **H > 33px**。
- **但 `rowAnchorForOffset`（`link.js:666`）有 `if (r.height > 30) return null` 守卫**：
  H>30 的项根本不产生行锚（`dragRowY=null`、`dragRowH=0`），pointermove 的吸附条件
  `dragRowY != null && dragRowH > 0` 永不成立。
- **两个条件交集为空** → 吸附要求 `H ≤ 30`（守卫）且 `H > 33`（几何），不可能同时满足：
  - H ≤ 30（正文）：锚存在但手柄中心超出 0.6H 半径 → 不吸附 → caret 用真实 y = 底边+3.3px
    → 命中下一行（dev-bug3 实测 H=17：阈值 10.2px vs 实际 11.8px，已实证 FAIL）。
  - H > 30（大标题）：锚为 null → 不吸附 → 结局取决于该 y 处命中；下方留白大时
    caret null → `pickRowBox` 垂直最近兜底可能拉回本行（机制是兜底而非吸附），下一行紧贴时仍跳行。
- 对照实验证明拖拽链本身正确（行内 y 移动时 Δ51px ≈ 拖距 54px）。
- 修复：分两层——① 手柄中心落回行内（`top` 取 `ir.y + ir.height/2` 且 transform 改
  `translate(-50%,-50%)`，或保留 transform 而 `top` 减 3.3px），可救 H≤30 的正文行；
  ② H>30 项因锚 null 仍无吸附，还需让 `placeHandles` 的手柄 y 与拖拽起始行锚一致
  （handleDrag 建立时用端点字符所在**视觉行** rect 而非整项 rect 定锚，或大项按字符行细分锚）。

#### D2 交叉复核（lead 亲自真机复测，2026-11-14 15:10）

dev-bug3 崩溃前报告的 D（翻转）/E（扩展）PASS 数值存在**假阳性嫌疑**：跳行后 x 随手指继续走，
带宽度/翻转恰好在数值上成立，掩盖了 y 跳行。lead 用 reload 后的干净会话（手柄在场）做了
逐 move 采样的重测：

| 实验 | 操作 | 结果 |
|---|---|---|
| 1 | 干净会话拖选行 7（y=397，H=26） | 带 [302,536] + bar 显示 + 手柄在场（h-a 中心 302,414 / h-b 中心 536,414）；**手柄中心距行锚中心 17px > 吸附半径 15.6px**（几何坐实） |
| 2 | 抓 h-b 中心 (536,414) 左拖两步 | **双带跨行**：原行带膨胀到行尾 [302,955] + 下一行新带 [150,492]→[150,466]——跳行且原带膨胀而非收缩 |
| 3 | 抓 h-a 中心 (308,434) 右拖 | 左端跟到 360，看似正常，但带 y=413（下一行）——**跳行后的伪正常** |
| 4 | 抓 h-a 起点改行内 y=421 | 左端跟到 387、单带——行内 y 才正常（与对照实验一致） |
| 5 | 抓 h-b 拖到原 a 左侧（翻转语义） | **再次双带跨行** [308,939]+[150,203]——翻转路径同样被跳行污染 |

**结论**：D2 成立且证据加强；dev-bug3 报告中 D/E 的 PASS 不可作为「手柄可用」的证据
（只在跳行后的错位状态下数值上成立）。**bug3 发布阻断判定维持不变。**

### D3 [MEDIUM][bug3] 手柄异常终止后 stale text/hint

- 位置：`link.js:870-877`（双指打断）、`:1084-1088`（pointercancel）不重算 `dragPending.text/hint`；
  `commitDragPending:805-822` 直接存 `p.text`。
- 影响：拖手柄被第二指/系统手势打断后点 ✓，落盘文字 ≠ 高亮区域；hint 陈旧致重锚回旧区间。
- 修复：两个异常分支比照 pointerup（`:1024-1028`）用 `makeFreeSelection` 重算 text/hint，
  或回滚 a/b 到拖拽前快照。

### D4 [MEDIUM][bug5] 放大态边界横滑翻页被吞

- 位置：`mobile.js:111-114`（pointerup 翻页判定）、`:117-120`（pointercancel 清 ptr）、`mobile.css:350`
- 真机证据（dev-bug5，capture-phase 轨迹）：`touch-action:pan-x` 生效后，Chromium 在越过 touch-slop
  瞬间即按 touch-action 判定归属、启动原生滚动并派发 **pointercancel**（无论边界处是否还有可滚空间），
  pointerup 永不派发 → `ptr=null`、翻页链永不执行。两边界横滑页码均不变（49→49）。
- 对照：`btnZoomFit` 收回 pan-x（touchAction=pan-y）后同一横滑 pointerup 正常、页码 49→50。
- 影响：放大滚到边缘后想继续横滑翻页翻不动（须 zoomFit 或用 20% 边缘点按）。
- 修复方向：① `pointercancel` 后用 touchmove/touchend 自行累计 dx（touchend 始终派发）；
  ② `scroll` 事件检测「已达边界 + 手势同向」再派翻页；③ scrollLeft 达极值时临时收回 `.pan-x`。

### D5 [LOW][bug1] 跟随循环的 rAF 相位滞后

- 现象：沉浸切换起始帧，画布 rect 先动、层 style 下一帧才被 follow 纠正 → 水平 4.4px 单帧滞后
  （晚探针 3 连跑稳定复现；垂直方向 ≤1px 已根治）。
- 量级：修复前数十 px → 现单帧 4.4px，肉眼近乎不可见。
- 修复方向（可选）：双 rAF 对齐 paint 前最后一次样式；或把 padding 过渡改 transform 合成（不触发 rect 变化）。

### D6 [LOW][bug4] pickRowBox dx 双截断

- 当同行两盒 dx 均 > 999（双双截断）时水平距离差被抹平，key 落到盒高千分位 → 较矮但水平更远的盒反胜。
- 可达性：需文本层宽 >1000px（横屏平板边缘可达）。影响限于 caret 落空兜底的端点水平错位，不跨行。
- 已由 `test/link-text.test.js` 的「pickRowBox：dx 999 截断的权重边界——超远
  同 dy 时盒高反越水平（已知缺陷 D6·口径记录，非回归断言）」用例固化为现状哨兵。

## 纪律项

- ⚠️ `.lnk-handle:active` 的 scale 形变未进 `prefers-reduced-motion` 跳过块（`mobile.css:509`；
  参照 `:1202-1205` 既有收口）。
- ⚠️ `docs/EXCERPT-LINK-DESIGN.md` 写 pan-x 阈值 `>4`，代码为 `>48`（`mobile.js:131`）。
- ⚠️ 游离未跟踪文件：`.video_agent/`、`docs/ARCHITECTURE.html`、`test/.device-lock`（后者建议入 `.gitignore`）。
- ✅ `www/` 为 `mobile-web/` 逐字节拷贝（复核实为 19 个对应文件全部一致，
  原记 6 文件为保守口径）；`solace-bridge.js` 是 esbuild 产物。
- ✅ bridge 桌面兼容：`color` 可选字段、旧数据照读、`library.json` 不变量未触。
- ✅ 事件名 `solace-preview-follow` 合 `solace-*` 契约；follow 为位置校正非装饰动效，未纳入 reduced-motion 是正确的。

## 遗留测试数据

- ✅ 已清理：`bbfe28a5` 的 `annotations/<docId>.json`（dev-bug1 验证用单笔墨迹，page 23）
  已删除，`annotations/` 恢复为基线空目录。
- ✅ 已恢复：`bbfe28a5` 的 links 侧车恢复原始状态（excerpts:[]、summary、body0 均核对一致）。
- ✅ 已恢复：设备 `accelerometer_rotation` 由验证期改动的 0 还原为原值 1，`user_rotation` 仍 0。
- ✅ 资料库完整性：27 本书、`library.json` JSON 合法（categories 5、progress 22 本）。
  `library.json` 的 sha256 由 `366732d6…` 变为 `adfaf20b…`，来源是验证期打开书籍/翻页产生的
  阅读进度写入（预期副作用，非损坏）。

## bug3 真机验证明细（A–M）

| 项 | 结论 | 关键数值 |
|---|---|---|
| A 手柄出现+对齐 | PASS | h-a 中心 x=123≡带 left、h-b x=404≡带 right（Δ0） |
| B 收缩 h-b（抓中心） | **FAIL** | 首 move 端点跳行，带 right 404→**625**（扩展而非收缩） |
| B 对照（move 走行内 y） | PASS | right 404→353，Δ51≈拖距 54 → **拖拽链本身正确** |
| C 收缩 h-a（抓中心） | **FAIL** | 跳行裂成两条带 `[[353,625],[106,327]]` |
| D 翻转 | **数值 PASS / 机制存疑** | h-a 149→460 越过 h-b，交换后 `[404,455]`；lead 复测发现翻转路径同样被跳行污染（见 D2 交叉复核实验 5），PASS 不可作为「手柄可用」证据 |
| E 扩展 | **数值 PASS / 机制存疑** | h-b 455→550，带 right→557；同上，跳行后 x 随手指走也可产生此类数值 |
| F ‹ › 按钮 | PASS | ‹ left −17、› right +17，方向正确 |
| G 手柄短点不取消 | PASS | 带不变、bar/box 仍可见 |
| H 提交隐藏 | PASS | ✓ 后 box 隐藏、入选带≡原拖选带、托盘「已选 1 处」 |
| I 翻页对账 | **PASS（lead 复验）** | 干净会话拖选待确认（带 [296,507]、bar 显示）→ btnNextPage → 页 50→51、拖选带 0 条、barHidden=true；页面上无 `.lnk-handles` 节点（`boxInDoc:false`，同时再次佐证 K 孤儿化） |
| J 清理 | **PASS（lead 收尾）** | 选词退出（linkSelecting=false）、预览关闭、设备基线核实：83571972 无 notes/links/annotations 残留、annotations 空目录、两个 sidecar 原始状态、rotation=1/0、__errs=0 |
| K 手柄孤儿化 | **FAIL（HIGH）** | ①退出重进 ②翻页后拖选：均 `handlesInDocument=false`，layer 子节点仅 lnk-bands+SPAN+BR |
| L 双指打断 stale text | **FAIL（MEDIUM）** | 入选带 `[123,404,281]`（旧 text）≠ 打断前高亮 `[123,353,230]` |
| M 大行高交叉验证 | BLOCKED | 交集为空判据 + 全书实测最大行高仅 17px（无 H>30 项）；且 K 使翻页后手柄缺失 |

## 发布结论

- **bug1 / bug2 / bug4：可发布**（bug1 残余 4.4px 单帧滞后可选优化；bug2、bug4 已真机全链验证通过）。
- **bug3：不可发布**——D1（用户主路径必现跳行）、D2（翻页后手柄整会话消失）、D3（数据正确性）三项叠加，
  修复后需重验。
- **bug5：核心目标达成可发**，但边界回落翻页为功能回归，建议同批修复（D4）。

## 验证过程说明

- 7 个 agent 并行：review-diff、review-tests（静态）+ dev-bug1..5（真机，锁文件串行共享设备、独立 CDP 端口）。
- 中途事件：夜间平板物理断连约 12 小时（重连后恢复）；dev-bug3 自查发现其报告 I/J 两项虚报，
  由 lead 直接复验补齐（I PASS / J PASS）；dev-bug3 的 I/J 数据不采信。dev-bug3 崩溃后 lead 又对其
  D/E（翻转/扩展）PASS 做了交叉复核，发现为**跳行污染的假阳性**（详见 D2 交叉复核节），bug3 判定因此
  更加强化。其余 A–C/F–H/K/L/M 数据经逐帧与 rect 证据核实。
- dev-bug3 代理进程在最后复验前崩溃，锁由 lead 校验持有者身份后接管并完成收尾。
- `test/color-palette.test.js` 为 review-tests 新增（守护三处色数常量同步）；测试期对
  `test/link-text.test.js`、`test/links-core.test.js` 的补强用例同样仅限 test/ 目录。

## bug2 真机验证明细（A–I，dev-bug2）

| 项 | 结论 | 关键证据 |
|---|---|---|
| A 旧数据兼容 | PASS | 注入无 color 字段旧格式 excerpt → 持久带 `lnk-band-lnk lnk-c0`，bg=`rgba(245,159,0,0.28)`=`--lnk-c0`×0.28 |
| B 色点钮开弹层 | PASS | 拖选→`#linkDragBar` 含 `.drag-color`；点开 `.link-color-pop` 恰 5 个 `.swatch`（data-c 0..4），当前色带 `.on` |
| C 选色即时换色 | PASS | 点 c3 → 拖选带 `lnk-band-drag lnk-c3`（bg=`--lnk-c3`×0.26）、确认条 `.dot lnk-c3`、手柄同步 lnk-c3 |
| D 入选 | PASS | ✓ 后托盘 +1，入选带 `lnk-band-sel lnk-c3`（×0.25），手柄收起 |
| E 会话默认延续 | PASS | 第二句不开盘直接 lnk-c3 |
| F 落盘 | PASS | readNoteLinks 两条 excerpt 含 `color:3`；adb cat sidecar JSON 磁盘原文实证 |
| G 重开回读 | PASS | 旧摘录 lnk-c0 与新摘录 lnk-c3 并存无串色 |
| H 清理复原 | PASS | trashNote+setNoteLinkEntry 复原；sidecar 与原始逐字一致 |
| I 三处常量同步 | PASS | LINK_COLOR_COUNT=5 / LNK_COLORS=5 / --lnk-c0..4 五变量 + bridge 校验同口径 |

全程 `window.__errs` = 0 条。

## 修复回执（2026-11-21，ZCode）

D1–D4 已按本报告方案落码（明细见 EXCERPT-LINK-DESIGN.md 的「D 批修订记」），
纪律项与测试轻修正一并收口：

- **D1**：`ensureHandles` 每轮 `:scope > .lnk-handles` 重查回写（报告主方案）；
  备选方案（清空处置 null）经复核不完备，未采用。
- **D2**：三层——手柄中心精确落行底（`translate(-50%,-50%)`）+ **抓取偏移校正**
  （报告方案之上的补强：17px 行高下吸附半径盖不住半颗圆钮的抓偏）+ 大项
  字符矩形兜底行锚（`charLineAnchorForOffset`）。
- **D3**：抬手/双指打断/pointercancel 三出口统一 `settleHandleAdjust()` 重算
  text/hint；新增 node 回归测试锁定（193→194 全绿）。
- **D4**（拍板方向①）：touch 第二通道接棒，pointercancel 标记互斥 +
  「手势朝向的滚动边界」判定。
- 纪律项：设计文档阈值 `>4`→`>48`、`.lnk-handle:active` 进 reduced-motion、
  报告 6 文件口径更正为 19、D6 哨兵补缺陷号标注并统一可达性口径、
  color-palette 哨兵剥 CSS 注释 + 解析去重、links-core 测试头补范围。
- **真机复验已过**（2026-11-21，同设备同法：motionevent 注入 + CDP 读态）：
  - **D1**：翻页后拖选 / 退出重进选词后拖选——手柄均重建在文档（isConnected、
    双柄、显示）。报告的「整会话消失」不复现。
  - **D2**：抓手柄**中心**三态——收缩 748→539px、扩展 539→774px、行中翻转
    带移至 [694,774]——均单带、band top 恒定不跳行（旧实现首 move 即跳行）。
  - **D4**：右边界外滑 63→64 ✓、左边界反向 64→63 ✓、边缘点按翻页不受
    影响 ✓。**复验中追加发现并已修**：中段横滑行程略大于可滚距离时会
    「既滚又翻」（实测误翻）——touchend 补「扣除实际滚动距离后仍超阈值」
    判定；修后三场景：滚到墙不翻 ✓、大行程推墙滚+翻 ✓、在墙上外滑纯翻 ✓。
  - **D3**：双指/系统取消注入在 input 工具下单指不可达，以 node 回归测试
    锁定（194 全绿）；正常抬手路径随 D2 三态顺带覆盖。
- 侧记：该 vivo 平板 `adb install`（流式与 --no-streaming 均试）会挂起且
  屏上无确认框；装包改走 `adb push /data/local/tmp/ + pm install -r`
  （本次实证可用）。
