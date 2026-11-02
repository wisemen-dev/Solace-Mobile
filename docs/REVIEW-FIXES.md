# 2026-10-04 审查问题修复记录

本次修复上一轮全量审查的 9 项问题。版本号保持 0.5.1，变更记入 CHANGELOG 的 Unreleased；资料库格式不变，无迁移。已有未提交的补丁计数订正已保留。

| 审查项 | 修复行为 | 本地验证 |
|---|---|---|
| S1 · 存储故障被当作缺失 | exists 仅对明确缺失返回 false；其他故障上抛。rm 不再把 stat 故障报为成功，mkdirp 仅忽略已存在 | fs-adapter：磁盘、权限、缺失分类；初始化失败无覆盖写；删除和建目录错误 |
| S2 · 停用监视不取消旧扫描 | 停用使旧扫描代数失效，每个导入检查当前配置；已排队导入在原生复制前再核对 | olib-watch：稳定等待期间停用、已排队导入停用后不复制 |
| S3 · 删除失败污染后续保存 | 资料库变更串行，写库失败回滚；删书先提交，再尽力清缓存/文件，清理失败报告残留 | library-core：失败后改设置并重启仍保留书与 PDF；索引清理故障不误报逻辑删除失败 |
| S4 · 并发保存重新登记失败导入 | 所有资料库变更共用队列；界面只读取已提交状态，设置/进度不再读取导入中间态 | library-core：JS/原生暂存导入失败与设置保存并发；提交前不暴露条目 |
| S5 · 推库时旧应用覆盖新库 | 推送或 wipe 前先停止应用；停止失败立即中止 | push-library：替身执行真实脚本，核对停止在全部写入之前、失败不再执行后续命令 |
| F1 · 墨迹读取中或失败后覆盖旧笔迹 | 墨迹模型加载成功前禁止落笔与覆盖保存；失败可重试；修正 pendingWrite 清理 | mobile-regressions：真实墨迹控制器 + 真实数据层，慢读、EIO、重试、旧笔保留、新笔不重复 |
| F2 · 引用正文被解析器吞掉 | 头部首个空行终止摘录区，只移除生成器插入的一个分隔空行 | link-md：引用开头、全引用、正文开头空行及尾部换行往返保真 |
| F3 · 保存等待期间的新修改丢失 | 两类编辑器在保存期间冻结输入、摘录移除、关闭和重复保存；返回键/Esc 同样拦截；失败后恢复编辑 | mobile-regressions：两类真实控制器的等待保护、关闭拦截、重复保存和故障重试 |
| F4 · 损坏告示被剪除流程丢弃 | readPruned 一次读取、剪除并返回同一份数据，保留 notice | links-core：坏文件留档、notice 返回、剪除结果及无孤儿时不写盘 |

## 已完成验证

- `npm test`：91/91 通过，新增 22 项。
- 界面替身测试对修复前 HEAD 的只读对照：慢读覆盖、读取失败覆盖、两类编辑器等待保护四项失败；修复后六项全部通过。
- `npm run apk`：桥接层重新打包、Capacitor 同步及 Android debug 构建成功。
- 38 个源码模块语法检查通过；7 个自有网页资源与 `www` 副本一致。
- APK 内 4 个修改后的界面模块与桥接包均与当前 `www` 逐字节一致。
- 调试安装包：`android/app/build/outputs/apk/debug/app-debug.apk`。

界面测试使用 DOM 和原生接口替身，推库测试只记录命令，不连接设备。未执行真机、Android 模拟器或设备资料库操作；真实 SAF、触笔与系统返回键交互仍需后续设备验证。

## 第三轮（全量复审，2026-10-04）

五个并行分片全文精读 bridge / mobile-web / scripts / 原生插件 / 测试质量，关键发现经二次复核。修复按 P1 → P2 → 可验证 P3 分批执行，每批跑全量单测。

| 级别 | 发现 | 修复 | 验证 |
|---|---|---|---|
| P1 | index.json 读故障被当「不存在」返回空表，下一次落库整表覆盖（索引元数据静默清空） | readTextIndexMeta 按 isNotFoundError 分流，故障照抛（走启动错误页兜底） | library-core：EIO 下 init 照抛、恢复后条目仍在（对照 RED） |
| P1 | 旧索引搬迁的 exists 故障 reject 被永久缓存在 legacyMigration，索引功能整会话瘫痪 | 迁移失败即清缓存，下次调用重试 | library-core：首次 rejects、恢复后成功（对照 RED） |
| P1 | 墨迹 drawing 不记页码：画到一半翻页，旧页坐标整笔提交进新页且中途采点混入新页坐标 | 落笔记页，onMove/commitStroke 页码对账（与橡皮对称），变了即作废 | mobile-regressions：翻页后 move+up 不落新页、不置脏（对照 RED） |
| P2 | 分片读故障被当损坏，搜索删除该书 meta 条目并写盘 | readShardPages 分流：缺失→自愈，I/O 故障→上抛；搜索循环跳过不动 meta | library-core：EIO 下搜索返回空且条目保留、恢复后命中 |
| P2 | readNoteLinks 的笔记快照在 links 写队列外取，交错下误剪刚保存的锚点 | readPruned 接受 provider，快照在写队列任务内取实时集合（保存恒先 md 后锚点，结构性消除窗口） | links-core：provider 在队列内取实时集合不误剪 |
| P2 | 文本层缓存无淘汰，长会话逐页翻书内存只增不减 | 按页 LRU 封顶 24 页（get 重插、set 驱逐最旧） | 代码走查（纯缓存策略，无行为分支） |
| P2 | openEditor 的 await readNote 窗口内连点第二个标记 → 二次 showModal 抛 InvalidStateError | edOpening 防重入标志（try/finally 复位） | 代码走查 + 语法检查 |
| P2 | sync-www 无条件先删 www 再拷贝，--src 打错即清空产物 | 先校验桌面仓库渲染层/node_modules 存在再动手；--src 缺参显式报错 | 手工验证两种错误输入均拦截、www 未动 |
| P3 | 摘录 md 头正则不容忍 CRLF（Typora 保存误降级） | 正则加 \r? | link-md：CRLF 头解析 ok 且正文保真 |
| P3 | 删书不清 annotations/links 侧车，孤儿永久积留 | removeDoc 清理列表补两项（尽力清，失败报残留） | 代码走查（与既有清理同链） |
| P3 | 新建笔记模板非原子写；标注侧车入队后不复验不拷贝；封面非原子直写 | create 改原子写；write 入队前深拷贝快照（对齐 links setEntry）；新增 writeFileAtomicB64 | 全量单测回归 |
| P3 | 节流盲窗：t0 扫描被跳过 + 窗口内下载完成 + 用户不再离开应用 → 新书无限期缺席；lastScanAt 在枚举前置位烧窗 | 节流命中安排 30s 后一次性补扫；lastScanAt 移到扫描结束更新；scanning 防并发 | 全量单测回归（olib-watch 既有用例） |
| P3 | 原生 relPath 无包含性校验（../ 越界）；pickFolder 只取不放逼近授权上限；FileProvider 映射整个外部存储根 | libraryFile 规范路径校验；换目录释放旧持久化授权；删除无调用方的 FileProvider 与 file_paths.xml | gradle 构建通过（首次编译暴露 lambda 检查异常问题，改抛 IllegalStateException 后通过） |
| P3 | pickDirectory 异常上抛致渲染层 unhandled rejection；连按返回叠开确认框；工具栏 z-index 盖过面板；npm test 枚举漏新文件；--rebuild 链不含 mobile-web 副本；cdp-eval adb 失败报误导信息 | boot 层按取消返回+提示；requestEditorClose 防重入；z-index 7→4；test 改 glob；build-bridge 顺带刷新副本；adb status 显式检查 | 代码走查 + npm test（glob 模式 97/97） |

### 第三轮验证记录

- `npm test`：97/97 通过（本轮新增 6 项；其中索引读故障 ×3 与墨迹翻页 ×1 对修复前版本对照运行确认为 RED）。
- `npm run apk`：桥重建（含 mobile-web 副本刷新）、cap sync、gradle debug 构建成功。
- 未修（需真机/设备验证，留待后续）：下载停滞 >1.5s 的半截文件稳定判据（与桌面端同语义）、鼠标拖出预览的指针残留（触屏为主场景）、textDivs 与 items 一一对应假设（pdf.js 实测行为）。
- 真机与模拟器验证尚未执行。

## 第三轮真机验证（2026-10-04，小米平板）

- 安装启动零崩溃；首页 DOM 健康（书卡渲染、无错误浮层）。
- 索引正常路径：getTextIndexStatus / searchTextIndex（'latex' 命中第 1 页），迁移函数改动无回归。
- readNoteLinks（provider 快照版）：结构正常返回。
- **原生越界首版引入进程崩溃（真机抓到）**：libraryFile 的 IllegalStateException 从 copyAndHash/hashLibraryPath 的 lambda try 块外抛出，io 线程未捕获异常杀死进程（Java 层无单测、RuntimeException 编译不报，仅真机暴露）。已把 libraryFile 调用纳入 try 并对 dest 判空；修复后越界路径返回 error 响应（含「路径越出资料库」），应用存活，正常路径 64 位哈希返回。
- 预览打开（lshort 139 页）；标注模式工具栏 computed z-index=4，目录面板 6——遮挡关系修复生效。
- 墨迹翻页对账（P1）：第 22 页落笔画到一半，真实点击「下一页」翻至 23 页后抬手——两页笔画数 0→0 / 5→5，作废笔未落盘（修复前将作为新笔混入第 23 页）。
- 验证后退标注/预览复位；logcat 全程 FATAL 计数 0。
- 人工体验项留待日常使用：双指手势冲突、SAF 换目录授权释放、下载自动入库补扫节律。

## 第四轮（全量审查，2026-11-01）

双轴并行（规范轴 ×3 分片 + Spec 轴 ×3 分片）精读 bridge / mobile-web / scripts / 原生插件 / 测试质量，关键发现二次源码复核后修复。代码本体无 P1；历轮修复逐处核对零回退、同步一致性 18/18、测试起点 162/162 全绿。修复按严重程度分批执行，每批跑全量测试。

| 级别 | 发现 | 修复 | 验证 |
|---|---|---|---|
| P2 | searchTextIndex 桥层参数错位：渲染层实调三参 (kw, sessionId, seq)，桥只收 (kw, token)——seq 被丢、sessionId 被误当 token 且本端数据层无此字段恒 undefined，检查点中止机制在真机从未生效（单测直调 lib 掩盖） | boot.mjs 改 `(kw, _sessionId, seq)`；注释记载非数字会话号陷阱 | 桥/渲染层签名对照；真机冒烟待验 |
| P2 | dragSel 无页码/书对账（ink 同型 P1 第三轮已修、此处漏）：拖选中另一手点底栏翻页钮或目录跳页 → 旧页偏移画进新页、抬手混出跨页选区 | dragSel 补 {page, docId}；buildLayer 同步前缀 / pointermove / pointerup 三处对账作废 | mobile-regressions：翻页重建作废、页码不符 move 作废、换书 up 不落 dragPending |
| P2 | saveEditor 两段写仍「先 md 后侧车」，与 0.6.0 P2-5 定向的 commitAppend 相反：侧车失败留剪不掉的摘录头、edDirty 语义错乱 | 统一先侧车后 md；PORTING 保存管线段回填 | mobile-regressions：断言 createNote→setNoteLinkEntry→writeNote 顺序 |
| P2 | loadLinks 读失败回空表被当「无记录」：查看器误报已不存在、併入作废选集、章总结绕过幂等匹配新建同章第二份总结 | loadLinks 失败返回 null 严格分流；三处调用方中止并 toast 真实原因 | mobile-regressions：查看器/併入/章总结三条 IO 失败路径 |
| P2 | push-library 合并校验恒假（全库计数 vs 源数恒真；adb 故障也打通过）；wipe 换入 rm+mv 有空窗 | 合并改按源相对路径集合精确比对；wipe 改「旧库挪 -old → 换入 → 成功才清」单串 shell 保序 | push-library：未到达/无法枚举/换入失败三条失败路径断言 |
| P2 | sync-www 换入 rm+rename 非原子间隙（Windows 占用时半删态） | 先挪 .www-old 再换入，失败回滚，任何路径 www 完整无损 | 代码走查（Windows rename 语义） |
| P2 | spine-group topOf 无成环防护：损坏库的分类环渲染挂死（桌面同型已加 seen） | seen 集合，撞环归未分类 | spine-group：成环用例不挂死且归未分类 |
| P2 | olib-watch force 绕过 scanning 防重入：重叠扫描互相 ++scanSeq 作废、掐断导入批次 | force 等 scanningSettled 结算后再进（等待后重读设置） | olib-watch：在途未结算前 force 不进枚举、listFiles 峰值 1 |
| P2 | 旧索引迁移把瞬时 I/O 故障当损坏：一次 EIO 即 .corrupt 永不重试、整批索引被弃 | 仅 SyntaxError 才隔离；I/O 上抛走既有「失败不缓存」重试链 | library-core：EIO 照抛且不改名、恢复后迁移成功；真损坏仍隔离 |
| P2 | 迟到写防御两缺口：createNote 无守卫（复活 notes/<uuid>/ 孤儿目录）；查活在入队时非任务内 | isAlive 注入三数据核、查活下沉队列任务内；createNote 拒绝转译显式错误 | notes/links/annotations：isAlive=false 时 create/write/setEntry 拒绝且无文件 |
| P2 | takePersistableUriPermission 只 catch SecurityException：ROM 其他 RuntimeException 杀进程（第三轮真机 P1 同型未覆盖全入口） | 扩为 catch(Exception)，统一按「未持久化」处理 | gradle 构建；ROM 异常路径待真机 |
| P2 | cdp-touch 漂移：多设备/超时修复未同步（cdp-eval 已修）——Duplicated Code 的直接恶果 | 抽公共 scripts/cdp-conn.mjs，两脚本共用连接引导 | 语法/参数对照；多设备实测待真机 |
| P3 | reduced-motion 漏覆盖（章节小条/简介卡两钮/目录胶囊按压缩放、胶囊让位淡出、抽屉滑入）；.tools-bar 死 transition | 文末补跳过块（同特异性按源码序压过定义处）；死规则删除 | 规范轴对照 |
| P3 | 琥珀摘录色 8 处散落无令牌；--ink-red 未挂 .ink-dot；浮层注释与实现矛盾 | --lnk-amber/--lnk-drag/--lnk-picked/--lnk-amber-deep 令牌化；.ink-dot 用 var(--ink-red)；注释改写 | 规范轴对照 |
| P3 | linksCache 无淘汰（textCache 已 LRU24，此处漏网） | 换 makeLru(16)；lru-cache 补 delete | lru-cache：delete 不占驱逐名额 |
| P3 | ink onMove/onUp 缺退出/暂挂复查：退出标注后 pointer capture 仍采点并 commitStroke | drawing/erasing 分支复查 active/suspendDrawing，作废或结算 | 代码走查（vm 桩无 capture 语义，真机手势待验） |
| P3 | 章节小条在显时被直接覆盖；简介卡「总结 N」缺单位 | 已显示不触发守卫；「📝 总结 N 章」 | 代码走查 |
| P3 | mem-fs 原子写桩无 tmp 形态（*.tmp 清扫零覆盖）；build-bridge 覆盖刷新不清理目标 | 两桩补 tmp+rename 形态；www/js/mobile 先清再拷 | library-core：.tmp 残留随 init 清掉 |
| P2·真机 | **push-library wipe 校验的 shellCount 把 find 输出里路径中的 UUID 数字拼进计数**（`\D` 删除法）：真机 2 文件被数成 4e19，wipe 校验必假、永远中止——第三轮引入时 vm 测试回显纯数字掩盖，真机从未跑过 wipe（2026-11-02 真机验证抓到；中止保护本身生效，旧库未动） | wipe 校验改用 shellList 行级计数（合并模式已是行级无此问题）；vm 测试 find 回显改为带 UUID 数字的路径行 | npm test 179/179；真机 wipe 重跑「2 个文件校验通过，旧库已替换并清理」 |
| 文档 | Spec 轴文档滞后成片：併入写序/等高带/互斥让位/工具簇两项拍板/书脊计数等实现已演进、设计书未回填 | 七份设计书 + PLAN + PORTING 各追加修订记（见各文档文末） | 逐条代码依据核对 |

### 未修（本轮明示不动）

- `library-shared.cjs` getOpenStats 就地修改注入时钟（纯度违规）与 notes/links 文件名校验上移共享层——桌面仓库是唯一事实源，需在桌面修后 `npm run www` 搬运，本轮范围外
- importWith/importVia 四段同形（判断项 Duplicated Code）：导入内核是最重战损区，提核收益小于回归风险，维持现状
- ROM 特定 RuntimeException 的异常分支（Java catch 扩面）：无法程序化触发，仅验证正常路径零回归 + 与 copyAndHash 同款纪律的代码对照

### 第四轮真机验证（2026-11-02，vivo 平板 PA2353 / 400D8S01LU00000）

- **搜索令牌**：桥层并发双搜索（token 1 被 2 顶掉）→ 旧搜索检查点作废返回 0 命中、新搜索 15 命中；UI 真实链路（textindex.js 三参实调 → 桥 → 数据层）过滤结果一致。
- **拖选对账（cdp-touch 真触摸注入）**：正向对照——长按 520ms + 拖动 → 确认小条 + 蓝带出现（功能无回归）；翻页对照——拖选中点「下一页」→ `linkDragging` 翻页瞬间即被作废，旧指针后续 move×2 + 抬手零产出（无小条、无带、无待确认选区）。
- **推库（危险项零风险方案：真库 mv 旁路 + E 盘全库备份双保险）**：合并模式真跑「源 2 个文件全部就位，校验通过」（源相对路径集合比对）；wipe 真跑暴露 shellCount UUID 拼接 bug（见上表）→ 修复后重跑「旧库已替换并清理」、无 -old/-incoming 残留；真库 90 文件 mv 原样回归、27 本 + links/notes 完好。
- **SAF 授权（uiautomator 驱动系统选择器全程）**：pickDirectory → 选 Download/Olib → `persisted: true`、uri/name 正确——takePersistableUriPermission 正常路径在改动后的 Java 上零回归。
- **cdp 工具链**：`--serial` 与无参数默认路径均通。本机注意：宿主 9222 被 ZCode 自身 DevTools 占用、9223 被残留 node 占用——CDP 验证需 `CDP_PORT=9333`。
- 全程 logcat FATAL/AndroidRuntime 计数 0；恢复后启动 27 本、DOM 健康、无错误浮层。

### 第四轮验证记录

- `npm test`：**179/179** 通过（162 + 新增 17：搜索令牌对照之外的全部修复项均有锁定用例）。
- `npm run apk`：桥重建（www/js/mobile 先清再拷）、cap sync、gradle debug 构建通过。
- 同步一致性：www 副本 vs mobile-web 源逐字节 diff 一致。
- 真机全项见上节（2026-11-02）。
