# 书脊视图按分类分组陈列（SPINE-GROUP）

书脊视图原本所有书脊挤作一排（单一 auto-fill 网格）。本功能改为按分类分区：
每个分类一个组，组头独占一行，组内书脊从左到右排列、一行放不下自动换行。

## 决策记录（2026-10-07 拍板）

实施当天发现桌面仓库已有并行实现的完整功能（`renderSpineShelves`，
未提交 WIP，与本会话几乎同时进行）。方向二选一拍板：**以桌面实现为底座，
移动补丁改出平板口径**（单一代码源，桌面后续改进零对账成本）。

四项交互决策（在不知桌面已有实现时拍板，最终以补丁形式落实到平板端）：

| 决策点 | 桌面实现 | 平板口径（拍板） |
|---|---|---|
| 分组粒度 | 直接分类各自成组（父前子后） | **归并到顶级分类**（子分类书并入父组） |
| 组头交互 | 纯展示 | **可点筛选**（复用 filter-cat，只看该分类） |
| 搜索时 | 保持分组 | **平铺**（查找与浏览场景分离） |
| 组头视觉 | 色点 + 名 + 胶囊徽标 | **轻量文字行**（隐色点、徽标退底，按压才反馈） |

## 规格

### 分组规则（mobile-web/js/mobile/spine-group.mjs，纯函数 `groupSpines`）
- 粒度：每本书沿 `parentId` 上溯到顶级分类，归入顶级组；组名 = 顶级分类名
- 组序：顶级分类在 `categories` 数组中的顺序（与侧栏一致）
- 「未分类」永远垫底；`categoryId` 为 null / 缺字段 / 悬空（指向已删分类，
  上溯不到顶级）三者同归未分类——与 `visibleDocs`/`categoryCounts` 的口径对齐
- 空分类不出组；组内保持传入顺序（入库序），不引入新排序
- **平铺（flat）两种情形**：搜索关键词非空；或分组后仅剩一组（如侧栏已筛到
  某分类、全库未分类）。flat 时全部书合成单组、不渲染组头——自动退化为
  原平铺陈列

### 布局（桌面 CSS 原样，`style.css` .spine-mode）
外层纵向分组流（flex column），每组 = `spine-group-head` + `spine-row`
（flex-wrap，行满自动换行）。书脊卡 56×200px，入场 stagger 跨组连续。

### 组头（可点 + 轻量视觉）
- `data-action="filter-cat" data-id="<顶级分类id|none>"`——复用侧栏筛选事件流，
  点击 = 只看该分类（书脊视图不切走，入场重播）；「未分类」组 id 为 `none`。
  点击后该分类子树单独成组 → 单组 → 自动平铺无头，侧栏「全部」返回
- mobile.css 覆盖：隐 `pile-dot`、`pile-badge` 退掉胶囊底（纯次要色文字）、
  `--muted` 小号分类名、`-webkit-tap-highlight-color: transparent` +
  `:active` 变 accent（按压才反馈，与全应用语言一致）

### 交互不变量（与桌面一致，未动）
点书脊直开预览（简介卡对书脊豁免保持——无 `.doc-cover-ops`）、拖拽归档、
封面懒加载（IntersectionObserver）、批量模式不在书脊提供。

## 实现落点

- `mobile-web/js/mobile/spine-group.mjs`——分组纯函数（单测直测）
- `mobile-web/js/mobile/spine-group.js`——注册 `window.__spineGroups`
  （mobile.js 先于 app.js 执行，钩子必然就位）
- app.js 移动补丁 ×2（sync-www.mjs，总数 40→42）：
  ① `renderSpineShelves` 分组计算段整段换钩子调用；② 组头模板加
  `filter-cat` 与 `spine.flat` 条件（平铺时组头整段不渲染）
- mobile.css——组头轻量样式（仅覆盖，桌面模板结构不动：色点由 CSS 隐藏，
  避免为视觉差异扩大补丁面）

## 测试

`test/spine-group.test.js`（8 例）：顶级归并（含孙级）/ 组序跟数组序 /
未分类垫底（null 与缺字段同口径）/ 悬空 id 归未分类 / 空分类不出组 /
搜索平铺保序 / 单组平铺 / 空库与空分类表。渲染管线（app.js 模板）按项目
惯例走真机验收，不做 DOM 替身加载。

## 真机检查单（2026-10-07 验收，vivo PA2353 横屏）

- [x] a. 切书脊视图：分组头出现，每组从新行起；行满换行由 `.spine-row`
      flex-wrap 保证（本库每组 ≤5 本未触发换行，computed `flex-wrap: wrap`
      + 桌面同源机制）
- [x] b. 组序 = 侧栏顺序（Ai → mathmatics → program），未分类垫底
      （data-id=none），空分类无组；**子分类归并实测**：临时建「验收临时
      子类」并移入一本 Ai 书 → 仍 4 组、子类组不出现、书留 Ai 组（桌面口径
      会出现第 5 组），测后复原
- [x] c. 真实点按组头（input tap，坐标 = css×2.5 + 顶偏 70px）→ 只看该
      分类（5 本、0 组头、入场重播）；侧栏「全部」恢复 4 组 16 本
- [x] d. 真实点按书脊卡 → 直开预览（`currentPreviewId` 就位、简介卡未弹，
      豁免保持）；返回键正常关闭
- [x] e. 拖拽归档：平板本无 HTML5 拖拽（既有口径，归档走编辑对话框/批量
      管理，与本功能无交互面）——N/A
- [x] f. 搜索「py」→ 2 本单组平铺无头；清空 → 4 组恢复
- [x] g. 快速滚动到底/回顶：16 张封面全部懒加载就位（0 张缺 src）
- [x] h. 书脊→书架→封面→书脊往返：spine-mode 类正确、4 组无重复无残留
- [x] i. 组头按压反馈：样式表 `:active` 变 accent 规则在位、
      `-webkit-tap-highlight-color: transparent` 生效（computed
      rgba(0,0,0,0)）、色点隐藏、徽标无边框——轻量文字行形态确认

## 验收记录

真机检查单 a–i 全过（2026-10-07，程序化断言 + input tap 真实点按 + 截图
视觉评审）。截图评审附带观察：长书名（尤其中英混排长英文题）竖排文字
贴边/截断——系 `.spine-name` 桌面既有样式（nowrap + overflow hidden，
本次未改动），非分组引入，可另立打磨项。npm test 136/136、补丁 42 处
锚点有效、APK 真机安装零崩溃。
