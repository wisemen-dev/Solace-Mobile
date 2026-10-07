# 摘录链接实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现「选句 → 链接 → 极简文本记录」的摘录链接功能：整句点选（跨页累积）、记录与词句双向可达（正文标记可点开 / 列表跳回）。

**Architecture:** 渲染侧新模块 `link.js`（文本层用 pdf.js 官方 `TextLayer` + 自有点选/标记层）；纯函数拆两个可单测模块（`link-md.mjs` 记录 md 生成/解析、`link-text.mjs` 页面文本/切分/重锚定）；桥接侧新增 `links/<docId>.json` 数据层（`links-core.mjs`，同 annotations-core 模式）；记录仍是 `notes/` 下的普通 .md。

**Tech Stack:** Capacitor 7 WebView；vendored pdf.js（**实测 4.10.38**，非计划初稿所写 v5——`TextLayer` 已导出、构造签名与计划一致，但 CSS 契约是 4.x 的 `--scale-factor`）；node:test + mem-fs 单测；CDP headless Chrome harness（temp）。

**Spec:** `docs/EXCERPT-LINK-DESIGN.md`（执行时两文对照；本计划从 spec 论证）

## Global Constraints

- 提交信息用中文、`feat|fix|docs|chore` 前缀；**每个任务末尾单独提交**，不 push
- 补丁只进 `scripts/sync-www.mjs`（锚点校验，漂移显式报错）；`bridge/`、`mobile-web/`、`test/` 直接改；补丁计数日志与 PORTING.md 同步
- `links/` JSON 用 `writeFileAtomicText` 原子写；docId 白名单正则 `/^[A-Za-z0-9-]{1,64}$/`；文件名校验同 notes-core（纯 basename、`.md` 结尾）
- 测试命令 `npm test`（新测试文件要加进 package.json 的 test 脚本）；**先 RED 后 GREEN** 取证
- harness 端口：桌面脚本用 9224/9226/9227/**9228**（link-test 用 9228）；**9222/9223 是真机 adb forward，勿用**；RED 取证期间不 sync www（server 现读磁盘）；harness 在 `C:\Users\Molly\AppData\Local\Temp\solace-ink-test\`（不随仓库提交）
- 与 spec 的两处接口微调（已论证）：① 记录 md 生成/解析放渲染侧 `mobile-web/js/mobile/link-md.mjs`（bridge 不能被 www 引用；纯函数需同时供渲染与单测）② 保存 = 渲染侧组合 `writeNote` + `setNoteLinkEntry`（bridge 不新增 writeNoteRecord，语义同 spec §8）
- 平台红线：`.md` 互通不变量——`notes/` 只放 .md，锚点一律进 `links/`；桌面端零感知

---

## 阶段 P1 · 数据层

### Task 1: `link-md.mjs` 记录 md 生成/解析（纯函数）

**Files:**
- Create: `mobile-web/js/mobile/link-md.mjs`
- Test: `test/link-md.test.js`
- Modify: `package.json`（test 脚本加 `test/link-md.test.js`）

**Interfaces:**
- Produces: `generateRecordMd(excerpts, body) -> string`；`parseRecordMd(text) -> { ok: boolean, body: string }`（`ok=false` = 格式不符，body=全文，调用方按普通笔记处理）

- [ ] **Step 1: 写失败测试** `test/link-md.test.js`

```js
// 记录 md 生成/解析（mobile-web/js/mobile/link-md.mjs）单测：往返一致、
// 降级（普通笔记/被手改）、空摘录、摘录文本归一化
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateRecordMd, parseRecordMd } from '../mobile-web/js/mobile/link-md.mjs'

test('generate→parse 往返：摘录与正文逐字一致', () => {
  const excerpts = [
    { page: 3, text: '第一句原文……', hint: { item: 12, char: 0 } },
    { page: 5, text: '第二句原文……' }
  ]
  const body = '我的想法。\n\n第二段。'
  const md = generateRecordMd(excerpts, body)
  assert.ok(md.startsWith('> 【摘录】第 3 页\n> 第一句原文……\n> 【摘录】第 5 页\n> 第二句原文……\n\n'))
  const r = parseRecordMd(md)
  assert.equal(r.ok, true)
  assert.equal(r.body, body)
})

test('generate：摘录文本空白归一化为单行', () => {
  const md = generateRecordMd([{ page: 1, text: '  两\n行  文本 ' }], '')
  assert.ok(md.includes('> 两 行 文本\n'))
})

test('generate：空摘录 = 纯正文（普通笔记形态）', () => {
  const md = generateRecordMd([], '只有正文')
  assert.equal(md, '只有正文')
  assert.equal(parseRecordMd(md).ok, false)
})

test('parse 降级：普通笔记（无摘录区）→ ok=false 且 body=全文', () => {
  const src = '# 《书》笔记\n\n- 创建：2026-10-03\n\n随手写的一段'
  const r = parseRecordMd(src)
  assert.equal(r.ok, false)
  assert.equal(r.body, src)
})

test('parse 降级：以引用开头的普通笔记（有 > 行但无【摘录】）→ ok=false', () => {
  const src = '> 用户自己写的引用\n\n正文'
  assert.equal(parseRecordMd(src).ok, false)
})

test('parse：正文保留内部空行与尾部换行', () => {
  const md = '> 【摘录】第 1 页\n> 句子\n\n\n正文第一行\n\n正文第三行\n'
  const r = parseRecordMd(md)
  assert.equal(r.ok, true)
  assert.equal(r.body, '正文第一行\n\n正文第三行\n')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/link-md.test.js`
Expected: FAIL（`link-md.mjs` 不存在）

- [ ] **Step 3: 实现** `mobile-web/js/mobile/link-md.mjs`

```js
// 摘录记录 .md 的生成与解析（纯函数，node 可单测）。
// 记录文件放 notes/<docId>/（.md 互通不变量）；摘录区由锚点数据重建，
// .md 是锚点的可读镜像——桌面 Typora 看到的即完整摘录+正文。
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

export function generateRecordMd (excerpts, body) {
  const lines = []
  for (const e of excerpts || []) {
    const page = Math.max(1, Math.floor(Number(e.page)) || 1)
    lines.push(`> 【摘录】第 ${page} 页`)
    lines.push('> ' + norm(e.text))
  }
  const head = lines.length ? lines.join('\n') + '\n\n' : ''
  return head + String(body ?? '')
}

// 解析：文件头部连续的 > 行为摘录区（`> 【摘录】第 N 页` 开新块）；
// 第一个非 > 非空行起为正文。没有【摘录】头 = 普通笔记/被手改 → 降级
// （ok=false，整份当正文，调用方不再重建摘录区；锚点仍有效）
export function parseRecordMd (text) {
  const src = String(text ?? '')
  const lines = src.split('\n')
  let i = 0
  let sawHeader = false
  let lastExcerpt = -1
  while (i < lines.length) {
    const ln = lines[i]
    if (/^> 【摘录】第 \d+ 页$/.test(ln)) { sawHeader = true; lastExcerpt = i; i++; continue }
    if (ln.startsWith('>')) { lastExcerpt = i; i++; continue }
    if (!ln.trim()) { i++; continue }
    break
  }
  if (!sawHeader) return { ok: false, body: src }
  let j = lastExcerpt + 1
  while (j < lines.length && !lines[j].trim()) j++
  return { ok: true, body: lines.slice(j).join('\n') }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/link-md.test.js`
Expected: 6 个用例全 PASS

- [ ] **Step 5: 加进 npm test 并全跑**

`package.json` 中 test 脚本改为：
`"test": "node --test test/annotations-core.test.js test/library-core.test.js test/link-md.test.js"`
Run: `npm test` → 44/44 PASS

- [ ] **Step 6: 提交**

```bash
git add mobile-web/js/mobile/link-md.mjs test/link-md.test.js package.json
git commit -m "feat: 摘录链接 P1——记录 md 生成/解析纯函数（含降级路径）"
```

### Task 2: `links-core.mjs` 锚点数据层

**Files:**
- Create: `bridge/links-core.mjs`
- Test: `test/links-core.test.js`
- Modify: `package.json`（test 脚本加 `test/links-core.test.js`）

**Interfaces:**
- Consumes: `fs`（fs-adapter 或 mem-fs；用到 `exists/readFileText/writeText/rename/rm/mkdirp/writeFileAtomicText`）
- Produces: `createLinks({ fs }) -> { read(docId, validFiles?), write(docId, data), setEntry(docId, file, entry|null), removeEntry(docId, file) }`；数据结构 `{ version: 1, records: { [file]: { excerpts: [{ page, text, hint? }] } } }`

- [ ] **Step 1: 写失败测试** `test/links-core.test.js`

```js
// 摘录链接数据层（bridge/links-core.mjs）单测：空读、setEntry/removeEntry
// 回环、孤儿剪除、损坏留档、白名单、文件名校验、并发写串行化、空表删文件
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLinks } from '../bridge/links-core.mjs'
import { createMemFs } from './mem-fs.mjs'

const ID = '00000000-0000-4000-8000-000000000001'
const FILE = '2026-10-03 10.00.00.md'
const ENTRY = { excerpts: [{ page: 3, text: '第一句原文……', hint: { item: 12, char: 0 } }] }

function harness () {
  const fs = createMemFs()
  return { fs, links: createLinks({ fs }) }
}

test('read：无文件返回空结构，不预建文件', async () => {
  const { fs, links } = harness()
  assert.deepEqual(await links.read(ID), { version: 1, records: {} })
  assert.equal(await fs.exists(`links/${ID}.json`), false)
})

test('setEntry→read 回环：条目逐字段一致', async () => {
  const { links } = harness()
  await links.setEntry(ID, FILE, ENTRY)
  assert.deepEqual((await links.read(ID)).records[FILE], ENTRY)
})

test('setEntry(null)：删条目；最后一条删除后文件被删', async () => {
  const { fs, links } = harness()
  await links.setEntry(ID, FILE, ENTRY)
  await links.setEntry(ID, FILE, null)
  assert.deepEqual((await links.read(ID)).records, {})
  assert.equal(await fs.exists(`links/${ID}.json`), false)
})

test('read(validFiles)：孤儿条目被剪除并写回', async () => {
  const { fs, links } = harness()
  await links.setEntry(ID, FILE, ENTRY)
  await links.setEntry(ID, 'gone.md', ENTRY)
  await links.read(ID, new Set([FILE]))
  const raw = JSON.parse(await fs.readFileText(`links/${ID}.json`))
  assert.deepEqual(Object.keys(raw.records), [FILE])
})

test('损坏：留档 corrupt-1 + 空回退 + notice', async () => {
  const { fs, links } = harness()
  await fs.mkdirp('links')
  await fs.writeText(`links/${ID}.json`, '{oops')
  const res = await links.read(ID)
  assert.deepEqual(res.records, {})
  assert.ok(res.notice && res.notice.includes('损坏'))
  assert.equal(await fs.exists(`links/${ID}.corrupt-1.json`), true)
  assert.equal(await fs.exists(`links/${ID}.json`), false)
})

test('setEntry 在损坏文件上：先留档再写新数据，不丢原文件', async () => {
  const { fs, links } = harness()
  await fs.mkdirp('links')
  await fs.writeText(`links/${ID}.json`, '{oops')
  await links.setEntry(ID, FILE, ENTRY)
  assert.equal(await fs.exists(`links/${ID}.corrupt-1.json`), true)
  assert.deepEqual((await links.read(ID)).records[FILE], ENTRY)
})

test('docId 白名单与文件名校验：非法一律拒绝', async () => {
  const { links } = harness()
  await assert.rejects(() => links.read('../evil'))
  await assert.rejects(() => links.setEntry(ID, 'a/b.md', ENTRY))
  await assert.rejects(() => links.setEntry(ID, 'note.txt', ENTRY))
  await assert.rejects(() => links.setEntry(ID, '', ENTRY))
})

test('entry 校验：空摘录/坏页码/坏 hint 拒绝', async () => {
  const { links } = harness()
  await assert.rejects(() => links.setEntry(ID, FILE, { excerpts: [] }))
  await assert.rejects(() => links.setEntry(ID, FILE, { excerpts: [{ page: 0, text: 'x' }] }))
  await assert.rejects(() => links.setEntry(ID, FILE, { excerpts: [{ page: 1, text: '   ' }] }))
  await assert.rejects(() => links.setEntry(ID, FILE, { excerpts: [{ page: 1, text: 'x', hint: { item: 1 } }] }))
})

test('并发 setEntry 串行化：两条都落盘', async () => {
  const { links } = harness()
  await Promise.all([
    links.setEntry(ID, 'a.md', ENTRY),
    links.setEntry(ID, 'b.md', ENTRY)
  ])
  const r = (await links.read(ID)).records
  assert.deepEqual(Object.keys(r).sort(), ['a.md', 'b.md'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/links-core.test.js` → FAIL（模块不存在）

- [ ] **Step 3: 实现** `bridge/links-core.mjs`

```js
// 摘录链接锚点数据层：links/<docId>.json（移动端专有；notes/ 的 .md 解耦，
// 桌面端不识别即忽略，同 annotations/ 模式）。
// records[file] = { excerpts: [{ page, text, hint? }] }；损坏留档同 annotations-core
export function createLinks ({ fs }) {
  function docFile (docId) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(String(docId || ''))) throw new Error('非法文档标识')
    return `links/${docId}.json`
  }
  // 记录文件名：纯 basename、.md 结尾（同 notes-core notePath 的形状约束）
  const FILE_RE = /^[^\\/:*?"<>|]{1,120}\.md$/

  function validateEntry (file, entry) {
    if (typeof file !== 'string' || !FILE_RE.test(file)) throw new Error('非法记录文件名')
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('非法锚点条目')
    if (!Array.isArray(entry.excerpts) || !entry.excerpts.length) throw new Error('锚点条目需至少一处摘录')
    for (const e of entry.excerpts) {
      if (!e || typeof e !== 'object') throw new Error('非法摘录')
      if (!Number.isInteger(e.page) || e.page < 1) throw new Error('非法摘录页码')
      if (typeof e.text !== 'string' || !e.text.trim()) throw new Error('非法摘录文本')
      if (e.hint != null &&
          (typeof e.hint !== 'object' || !Number.isInteger(e.hint.item) || !Number.isInteger(e.hint.char))) {
        throw new Error('非法定位提示')
      }
    }
  }

  function validate (data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('非法链接数据')
    if (data.version !== 1) throw new Error('不支持的链接数据版本')
    if (!data.records || typeof data.records !== 'object' || Array.isArray(data.records)) throw new Error('非法记录表')
    for (const [file, entry] of Object.entries(data.records)) validateEntry(file, entry)
  }

  const emptyData = () => ({ version: 1, records: {} })

  // 读+校验；损坏 → 留档（rename 顺延编号；失败用原文落副本兜底）→ 空+notice
  async function loadValidated (docId) {
    const p = docFile(docId)
    if (!await fs.exists(p)) return emptyData()
    const raw = await fs.readFileText(p)
    try {
      const d = JSON.parse(raw)
      validate(d)
      return d
    } catch {
      let n = 1
      while (await fs.exists(`links/${docId}.corrupt-${n}.json`)) n++
      const archive = `links/${docId}.corrupt-${n}.json`
      let archived = false
      try {
        await fs.rename(p, archive)
        archived = true
      } catch {
        try { await fs.writeText(archive, raw); archived = true; await fs.rm(p) } catch { /* notice 如实 */ }
      }
      return {
        ...emptyData(),
        notice: archived
          ? '这本书的摘录链接数据损坏，已重置；原文件保留为资料库内 links 下的 .corrupt 备份。'
          : '这本书的摘录链接数据损坏，已重置；原文件留档失败（文件可能被占用），再次写入将覆盖损坏文件。'
      }
    }
  }

  let writeChain = Promise.resolve()

  async function read (docId, validFiles) {
    await writeChain.catch(() => {})
    const data = await loadValidated(docId)
    if (validFiles instanceof Set) {
      let pruned = false
      for (const key of Object.keys(data.records)) {
        if (!validFiles.has(key)) { delete data.records[key]; pruned = true }
      }
      if (pruned) await write(docId, data)
    }
    return data
  }

  async function write (docId, data) {
    validate(data)
    const run = writeChain.then(() => writeLocked(docId, data))
    writeChain = run.then(() => {}, () => {})
    return run
  }

  async function writeLocked (docId, data) {
    const p = docFile(docId)
    const records = {}
    for (const [file, entry] of Object.entries(data.records)) {
      if (entry.excerpts.length) records[file] = entry
    }
    if (!Object.keys(records).length) {
      if (!await fs.rm(p)) throw new Error('删除链接文件失败（文件可能被占用）')
      return true
    }
    await fs.mkdirp('links')
    await fs.writeFileAtomicText(p, JSON.stringify({ version: 1, records }))
    return true
  }

  // 读改写串行化（同一写链内：损坏文件先留档再写新数据，不丢原文）
  function mutate (docId, fn) {
    const run = writeChain.then(async () => {
      const data = await loadValidated(docId)
      fn(data)
      return writeLocked(docId, data)
    })
    writeChain = run.then(() => {}, () => {})
    return run
  }

  function setEntry (docId, file, entry) {
    if (entry == null) return removeEntry(docId, file)
    validateEntry(file, entry)
    return mutate(docId, (d) => { d.records[file] = JSON.parse(JSON.stringify(entry)) })
  }

  function removeEntry (docId, file) {
    if (typeof file !== 'string' || !FILE_RE.test(file)) throw new Error('非法记录文件名')
    return mutate(docId, (d) => { delete d.records[file] })
  }

  return { read, write, setEntry, removeEntry }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/links-core.test.js` → 9 用例全 PASS

- [ ] **Step 5: 加进 npm test 并全跑**

test 脚本追加 `test/links-core.test.js`；`npm test` → 53/53 PASS

**实施偏差（2026-10-04，已征得同意）**

1. `setEntry` / `removeEntry` 由普通函数改为 **`async function`**。原写法在
   校验失败时同步抛错，而 Step 1 的测试用 `assert.rejects(() => links.setEntry(...))`
   ——实测 Node 的 `assert.rejects` 遇同步抛错会把错误**原样抛出**而非判定
   通过，「docId 白名单」与「entry 校验」两用例必然失败。改 async 后同步
   抛错即 Promise 拒绝，与 `annotations-core.write` 的既有约定一致（「async
   函数内同步抛错 = Promise 拒绝，调用方统一 try/catch」）；桥层 `gate()`
   本就是 async，渲染侧行为不变。
2. `FILE_RE` 换成 `checkFile()`，与 notes-core `notePath` 的约束逐条对齐：
   禁路径成分、**禁以 `.` 开头**、**禁首尾空白**、`.md` 结尾（判据用
   `toLowerCase()`，同 `notes.list` 的过滤）、长度 ≤120。原正则放行
   `.x.md` / ` x.md`，会存下 notes 侧永远匹配不上的孤儿条目。**内部空格
   必须放行**（notes-core 生成的文件名形如 `2026-10-03 10.00.00.md`）。
3. 用例数记账更正：本任务实为 **9** 个用例（原写 10），故 `npm test` 为
   **53/53**（原写 54/54）。测试里另补了 4 条文件名校验断言（`.hidden.md`
   / ` x.md` / `x.md ` / `removeEntry` 路径穿越）覆盖偏差 2。

已核实**不是**问题的一处：`removeEntry` 在 `links/<docId>.json` 不存在时会
走到 `writeLocked` 的空表分支调 `fs.rm`——mem-fs 与 fs-adapter 的 `rm` 对
不存在的文件都返回 `true`（「无可清理视为成功」），故删笔记联动清侧车对
没有摘录的书确实是无害操作。

- [ ] **Step 6: 提交**

```bash
git add bridge/links-core.mjs test/links-core.test.js package.json docs/EXCERPT-LINK-PLAN.md
git commit -m "feat: 摘录链接 P1——links-core 锚点数据层（原子写/串行化/损坏留档/孤儿剪除）"
```

### Task 3: boot.mjs 桥方法（读/写条目 + trashNote 扩展）

**Files:**
- Modify: `bridge/boot.mjs`（imports 与装配区、solace 方法区 ~226-242 行）

**Interfaces:**
- Consumes: `createLinks({ fs })`（Task 2）；既有 `notes`（notes-core）
- Produces（渲染层调用面）：`solace.readNoteLinks(docId) -> { version, records }`（含孤儿剪除）；`solace.setNoteLinkEntry(docId, file, entry|null) -> true`；`solace.trashNote(docId, file, sessionId)` 语义扩展为同时清侧车

- [ ] **Step 1: 装配**（在 `const annotations = ...` 附近）

```js
import { createLinks } from './links-core.mjs'
// 装配区：
const links = createLinks({ fs })
```

- [ ] **Step 2: solace 方法区改动**

```js
  // 摘录链接锚点（移动端专有；links/<docId>.json，与 notes/ 的 .md 解耦）
  readNoteLinks: gate(async (id) => {
    const { notes: files } = await notes.list(id)
    return links.read(id, new Set(files.map(f => f.file)))  // 顺带孤儿剪除
  }),
  setNoteLinkEntry: gate((id, file, entry) => links.setEntry(id, file, entry)), // entry=null → 删除
  // 删除笔记：同链清侧车条目（无条目时为无害操作）
  trashNote: gate(async (id, file) => {
    await notes.trash(id, file)
    await links.removeEntry(id, file)
  }),
```

（原 `trashNote: gate((id, file) => notes.trash(id, file)),` 整行替换。）

- [ ] **Step 3: 重建桥并冒烟**

Run: `node scripts/build-bridge.mjs`（无报错，bundle 生成）
Run: `npm test` → 54/54 PASS（boot 为装配层不直接单测，行为由 P2/P3 harness 覆盖）

- [ ] **Step 4: 提交**

```bash
git add bridge/boot.mjs
git commit -m "feat: 摘录链接 P1——boot 桥方法（readNoteLinks/setNoteLinkEntry/trashNote 联动）"
```

---

## 阶段 P2 · 文本层与选词

### Task 4: TextLayer API 小样验证（spike，产物留 harness 不提交）

**Files:**
- Create: `C:\Users\Molly\AppData\Local\Temp\solace-ink-test\tl-spike.mjs`（一次性脚本）

**Interfaces:**
- Produces: 确认的 TextLayer 调用形态与必需 CSS（写回 Task 6 实现）

- [ ] **Step 1: 写 spike 脚本**（CDP 样板照抄 p3-test.mjs 头部：Chrome 端口 **9228**、连 WS、evalJs。计划初稿写 9230，与 Global Constraints 的「link-test 用 9228」冲突，以约束为准）

核心 evaluate 片段（独立建一个 pdf.js 文档，不依赖 app 内部）：

```js
const out = await evalJs(`(async () => {
  const m = await import('/js/pdfjs.js')
  const lib = m.default
  const doc = await lib.getDocument({ url: '/test-text.pdf' }).promise
  const page = await doc.getPage(1)
  const viewport = page.getViewport({ scale: 1.5 })
  const tc = await page.getTextContent()
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:400px;overflow:hidden'
  document.body.appendChild(host)
  const tl = new lib.TextLayer({ textContentSource: tc, container: host, viewport })
  await tl.render()
  const spans = [...host.querySelectorAll('span')]
  const r0 = spans[0] && spans[0].getBoundingClientRect()
  return { spans: spans.length, sample: spans[0] && spans[0].textContent, rect: r0 && { x: r0.x, y: r0.y, w: r0.width, h: r0.height } }
})()`)
```

- [ ] **Step 2: 前置条件**：先生成文本版测试 PDF（Task 6 Step 1 的 `gen-text-pdf.mjs` 可提前跑）与 server 路由
- [ ] **Step 3: 运行并记录**

Run: `node tl-spike.mjs`（server 在跑）
预期：`spans > 0`、sample 为英文句子、rect 有合理尺寸。若构造签名/容器 CSS 不符（如需要 `--total-scale-factor` 或 `textContentSource` 要用 `page.streamTextContent()`），记录实际形态——**Task 6 以实测为准调整**；截图存档 `tl-spike.png`
- [ ] **Step 4: 无提交**（temp 脚本；结论落入 Task 6）

### Task 5: `link-text.mjs` 切分/映射/重锚定（纯函数）

**Files:**
- Create: `mobile-web/js/mobile/link-text.mjs`
- Test: `test/link-text.test.js`
- Modify: `package.json`（test 脚本追加）

**Interfaces:**
- Produces：
  - `buildPageText(items) -> { text, spans }`（spans[i]={start,end} 为第 i 个文本项的原文区间；hasEOL 在文本中插入 `\n`）
  - `offsetToItem(spans, off) -> { item, char }`
  - `splitSentences(text) -> [{ start, end }]`（连续分区，覆盖 [0,len)）
  - `sentenceAt(sentences, off) -> number`
  - `normalizeText(s) -> string`（空白折叠）
  - `buildSearchIndex(text) -> { norm, back }`（norm 第 i 字符 ↔ 原文 back[i]；back[norm.length]=原文长）
  - `findRangeByText(text, target, hintRaw?) -> { start, end } | null`

- [ ] **Step 1: 写失败测试** `test/link-text.test.js`

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPageText, offsetToItem, splitSentences, sentenceAt,
  normalizeText, buildSearchIndex, findRangeByText
} from '../mobile-web/js/mobile/link-text.mjs'

const items = [
  { str: 'Hello world. ', hasEOL: false },
  { str: 'Second one!', hasEOL: true },
  { str: 'Next line.', hasEOL: false }
]

test('buildPageText：hasEOL 插换行，spans 映射原文区间', () => {
  // 'Hello world. ' 是 13 字符（计划初稿按 14 记，连带 span 区间与原语义
  // 对应偏移整体错位一位；以真实长度为准）
  const { text, spans } = buildPageText(items)
  assert.equal(text, 'Hello world. Second one!\nNext line.')
  assert.deepEqual(spans[0], { start: 0, end: 13 })
  assert.deepEqual(spans[1], { start: 13, end: 24 })
  assert.deepEqual(spans[2], { start: 25, end: 35 })
})

test('offsetToItem：普通偏移与换行间隙（归前项末尾）', () => {
  const { spans } = buildPageText(items)
  assert.deepEqual(offsetToItem(spans, 0), { item: 0, char: 0 })
  assert.deepEqual(offsetToItem(spans, 12), { item: 0, char: 12 })
  assert.deepEqual(offsetToItem(spans, 24), { item: 1, char: 11 }) // 换行位置
  assert.deepEqual(offsetToItem(spans, 25), { item: 2, char: 0 })
  assert.deepEqual(offsetToItem(spans, 999), { item: 2, char: 10 })
})

test('splitSentences：中英混合断句', () => {
  const t = '第一句。第二句！第三段；完整。End of line. 结束'
  const s = splitSentences(t)
  assert.equal(s.map(r => t.slice(r.start, r.end)).join('|'),
    '第一句。|第二句！|第三段；|完整。|End of line. |结束')
})

test('splitSentences：小数点不断、句末点断、换行断', () => {
  const t = 'Version 3.14 is stable. Next line\n新行句子'
  const s = splitSentences(t)
  assert.equal(s.map(r => t.slice(r.start, r.end)).join('|'),
    'Version 3.14 is stable. |Next line\n|新行句子')
})

test('splitSentences：收尾引号/括号并入前句', () => {
  const t = '他说：『好。』然后走了'
  const s = splitSentences(t)
  assert.equal(s.map(r => t.slice(r.start, r.end)).join('|'), '他说：『好。』|然后走了')
})

test('splitSentences 分区连续覆盖', () => {
  const t = 'ab。cd'
  const s = splitSentences(t)
  assert.equal(s[0].start, 0)
  assert.equal(s[0].end, s[1].start)
  assert.equal(s[s.length - 1].end, t.length)
})

test('sentenceAt：任意偏移落回正确句', () => {
  const t = '第一句。第二句。'
  const s = splitSentences(t)
  assert.equal(sentenceAt(s, 0), 0)
  assert.equal(sentenceAt(s, 3), 0)
  assert.equal(sentenceAt(s, 4), 1)
})

test('normalizeText 与 buildSearchIndex 映射', () => {
  assert.equal(normalizeText('  a\n\nb '), 'a b')
  const { norm, back } = buildSearchIndex('a\n\nb')
  assert.equal(norm, 'a b')
  assert.deepEqual(back, [0, 1, 3, 4]) // norm[i] 的原文偏移 + 末尾哨兵
})

test('findRangeByText：唯一命中 / 多处命中按 hint 就近 / 未命中', () => {
  const t = 'alpha beta alpha gamma'
  assert.deepEqual(findRangeByText(t, 'gamma'), { start: 17, end: 22 })
  const r1 = findRangeByText(t, 'alpha', 0)
  assert.deepEqual(r1, { start: 0, end: 5 })
  const r2 = findRangeByText(t, 'alpha', 11)
  assert.deepEqual(r2, { start: 11, end: 16 })
  assert.equal(findRangeByText(t, 'delta'), null)
  assert.equal(findRangeByText(t, '   '), null)
})

test('findRangeByText：跨行目标（搜索侧归一化匹配）', () => {
  // 返回半开区间 [start,end)：end = back[pick+len] 落在匹配后的第一个原文
  // 字符上，不含尾随空白——与上一条 'alpha'→{0,5} 同一口径（计划初稿写 8，
  // 会把尾随空格算进去，与上一条自相矛盾）
  const t = 'one\ntwo three'
  assert.deepEqual(findRangeByText(t, 'one two'), { start: 0, end: 7 })
})
```

- [ ] **Step 2: 跑测试确认失败** → `node --test test/link-text.test.js` FAIL

- [ ] **Step 3: 实现** `mobile-web/js/mobile/link-text.mjs`

```js
// 页面文本构建 / 句子切分 / 偏移映射 / 重锚定查找（纯函数，node 可单测）。
// items = pdf.js getTextContent().items（[{ str, hasEOL }]）

export function buildPageText (items) {
  let text = ''
  const spans = []
  for (let i = 0; i < items.length; i++) {
    const s = String(items[i].str ?? '')
    const start = text.length
    text += s
    spans.push({ start, end: text.length })
    if (items[i].hasEOL) text += '\n'
  }
  return { text, spans }
}

export function offsetToItem (spans, off) {
  for (let i = 0; i < spans.length; i++) {
    if (off < spans[i].start) {
      return i > 0
        ? { item: i - 1, char: spans[i - 1].end - spans[i - 1].start }
        : { item: 0, char: 0 }
    }
    if (off < spans[i].end) return { item: i, char: off - spans[i].start }
  }
  const last = spans.length - 1
  return last >= 0 ? { item: last, char: spans[last].end - spans[last].start } : { item: 0, char: 0 }
}

const CLOSERS = '」』”’）】》»\')]'

export function splitSentences (text) {
  const out = []
  let start = 0
  const isEnd = (ch, next) => {
    if ('。！？；…!?;'.includes(ch)) return true
    if (ch === '\n') return true
    if (ch === '.' && (next === undefined || next === ' ' || next === '\n' || next === '\t')) return true
    return false
  }
  for (let i = 0; i < text.length; i++) {
    if (!isEnd(text[i], text[i + 1])) continue
    let end = i + 1
    while (end < text.length && CLOSERS.includes(text[end])) end++
    // 终止符后的空白归上一句：'.' 后跟空格才断句，那个空格属于本句；换行
    // 同理（'\n' 是终止符本身，已被包含）。不吸收会切出只含 '\n' 的垃圾句
    // ——归一化后为空，点上去毫无反应（计划初稿漏了这一段）
    while (end < text.length && /\s/.test(text[end])) end++
    out.push({ start, end })
    start = end
  }
  if (start < text.length) out.push({ start, end: text.length })
  return out
}

export function sentenceAt (sentences, off) {
  for (let i = 0; i < sentences.length; i++) if (off < sentences[i].end) return i
  return sentences.length - 1
}

export function normalizeText (s) { return String(s ?? '').replace(/\s+/g, ' ').trim() }

export function buildSearchIndex (text) {
  let norm = ''
  const back = []
  let pendingSpace = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (norm.length && !pendingSpace) { norm += ' '; back.push(i) }
      pendingSpace = true
      continue
    }
    pendingSpace = false
    norm += ch
    back.push(i)
  }
  if (norm.endsWith(' ')) { norm = norm.slice(0, -1); back.pop() }
  back.push(text.length)
  return { norm, back }
}

export function findRangeByText (text, target, hintRaw = null) {
  const t = normalizeText(target)
  if (!t) return null
  const { norm, back } = buildSearchIndex(text)
  const hits = []
  let idx = norm.indexOf(t)
  while (idx >= 0) { hits.push(idx); idx = norm.indexOf(t, idx + 1) }
  if (!hits.length) return null
  let pick = hits[0]
  if (hits.length > 1 && hintRaw != null) {
    let best = Infinity
    for (const h of hits) {
      const d = Math.abs(back[h] - hintRaw)
      if (d < best) { best = d; pick = h }
    }
  }
  return { start: back[pick], end: back[pick + t.length] }
}
```

- [ ] **Step 4: 跑测试确认通过** → 10 用例全 PASS；加入 npm test → 63/63 PASS

**实施偏差（2026-10-04，已核实）**

1. **用例 1/2 的期望整体错位一位**：夹具 `'Hello world. '` 实为 **13** 字符
   （原文按 14 记），连带 spans 应为 `{0,13} / {13,24} / {25,35}`、换行落在
   24。已按真实长度重算并保留原语义：换行位置归前项末尾 =
   `offsetToItem(spans, 24) = { item: 1, char: 11 }`，`{ item: 2, char: 0 }`
   对应偏移 25（原文写的 26、25 都是错位后的值）。
2. **用例 10 的 end 应为 7 而非 8**：`findRangeByText` 返回半开区间
   `[start, end)`，`end = back[pick + len]` 落在匹配后的第一个原文字符上，
   **不含尾随空白**——与用例 9 `'alpha' → {0,5}`（5 是空格下标、不含空格）
   同一口径。原文的 8 会把尾随空格算进去，与用例 9 自相矛盾。
3. **`splitSentences` 实现补「终止符后吸收空白串」**：原实现只吸收
   CLOSERS 集合，导致用例 3/4 期望的句尾空格（`'End of line. '`、
   `'stable. '`）落不进上一句——即原实现的输出与原文用例 3/4 自相矛盾。
   吸收空白串后 3/4 按原文期望通过，且与 `'\n'`（终止符本身，本就在句内）
   自洽；顺带修掉 `'a.\n\nb'` 会切出只含 `'\n'` 的垃圾句——归一化后为空、
   点上去毫无反应的问题。
4. 用例数记账：本任务实为 **10** 个用例（原写 11），`npm test` 为
   **63/63**（原写 65）。
- [ ] **Step 5: 提交**

```bash
git add mobile-web/js/mobile/link-text.mjs test/link-text.test.js package.json docs/EXCERPT-LINK-PLAN.md
git commit -m "feat: 摘录链接 P2——页面文本/句子切分/重锚定纯函数（中英文断句与映射）"
```

### Task 6: harness 基建（文本 PDF/mock/server）+ 补丁加宽 + 文本层核心

**Files:**
- Create: `C:\Users\Molly\AppData\Local\Temp\solace-ink-test\gen-text-pdf.mjs`、`link-test.mjs`
- Modify: `C:\Users\Molly\AppData\Local\Temp\solace-ink-test\server.mjs`、`mock-solace.js`
- Modify: `E:\Android\Projects\SolaceMobile\scripts\sync-www.mjs`（preview.js 补丁加宽）
- Create: `mobile-web/js/mobile/link.js`（文本层核心部分）
- Modify: `mobile-web/css/mobile.css`（文本层样式）、`mobile-web/js/mobile/mobile.js`（`import './link.js'`）

**Interfaces:**
- Consumes: layout 事件 detail 新增 `pageObj`（PDFPageProxy）+ `viewport`（Task 6 补丁）；`link-text.mjs`；`solace.readNoteLinks`
- Produces: `.ink-text-layer` DOM（懒建：本书有记录或选词模式中才建）；`window.linkSelecting`（初始 undefined）；link.js 内部 `linksCache: Map<docId, { records }>`

- [ ] **Step 1: 文本测试 PDF** `gen-text-pdf.mjs`（照 gen-pdf.mjs 的 xref 构建器；Helvetica 标准字体免嵌入）

```js
// 3 页英文文本测试 PDF（Helvetica 标准 14 字体，无嵌入）。页1 含重复句与
// 小数点；用于文本层/切分/重锚定 harness。
const pages = [
  ['Page one, sentence one is here.', 'This is the second sentence.', 'Version 3.14 stays whole.', 'Repeat me for hint tests.', 'Repeat me for hint tests.'],
  ['Page two opens here.', 'And ends here.'],
  ['Last page line one.', 'Last page line two.']
]
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
const body = (i) => 'BT /F1 16 Tf 72 ' + (760 - 0) + ' Td ' +
  pages[i].map(s => `(${esc(s)}) Tj 0 -30 Td`).join(' ') + ' ET'
const objects = []
objects.push('<< /Type /Catalog /Pages 2 0 R >>')
objects.push('<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>')
for (let i = 0; i < 3; i++) {
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 9 0 R >> >> /Contents ${6 + i} 0 R >>`)
}
for (let i = 0; i < 3; i++) {
  const s = body(i)
  objects.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`)
}
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
let out = '%PDF-1.4\n'
const offsets = [0]
for (let i = 0; i < objects.length; i++) {
  offsets.push(out.length)
  out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
}
const xref = out.length
out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
for (let i = 1; i <= objects.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
const { writeFileSync } = await import('node:fs')
writeFileSync(new URL('./test-text.pdf', import.meta.url), out, 'latin1')
console.log('test-text.pdf', out.length, 'bytes')
```

Run: `node gen-text-pdf.mjs`；如 pdf.js 打开空白：优先核对页对象 `/Resources` 与内容流 `/Length`（字段少字符=整页空白的经典症状）

- [ ] **Step 2: server 路由 + mock 扩展**

`server.mjs` 在 `/test.pdf` 分支后加同样一块 `/test-text.pdf` 路由。
`mock-solace.js` 追加（在 `base` 内）：
```js
    // 第三本书：文本 PDF（摘录链接场景）
    getDocUrl: async (id) => (id === DOC3.id ? '/test-text.pdf' : '/test.pdf'),
    // 笔记与锚点内存存储（localStorage 持久化）
    // 注意形状：必须与真桥一致（notes-core.list → { notes: [...] }）。
    // 返回裸数组会让 notespanel 的 `const { notes } = await ...` 解构出
    // undefined，列表渲染抛「Cannot read properties of undefined」
    listNotes: async (id) => ({ notes: Object.keys(loadNotes()[id] || {}).map(f => ({
      file: f, mtime: new Date().toISOString(), birth: new Date().toISOString(), size: (loadNotes()[id][f] || '').length
    })),
    openNote: async (id, file) => ({ inApp: true, title: '文本测试书', content: (loadNotes()[id] || {})[file] || '' }),
    readNote: async (id, file) => (loadNotes()[id] || {})[file] || '',
    writeNote: async (id, file, text) => {
      if (window.__failNotesWrites) throw new Error('mock: 笔记写失败')
      const s = loadNotes(); s[id] = s[id] || {}; s[id][file] = text
      localStorage.setItem('notes-mock', JSON.stringify(s)); return true
    },
    createNote: async (id, payload) => {
      const s = loadNotes(); s[id] = s[id] || {}
      let file = `2026-10-03 10.00.0${window.__noteSeq = (window.__noteSeq || 0) + 1}.md`
      s[id][file] = `# 《文本测试书》笔记\n\n`
      localStorage.setItem('notes-mock', JSON.stringify(s)); return { file }
    },
    trashNote: async (id, file) => {
      const s = loadNotes(); if (s[id]) delete s[id][file]
      localStorage.setItem('notes-mock', JSON.stringify(s))
      const l = loadLinks(); if (l[id] && l[id].records) delete l[id].records[file]
      localStorage.setItem('links-mock', JSON.stringify(l)); return true
    },
    readNoteLinks: async (id) => loadLinks()[id] || { version: 1, records: {} },
    setNoteLinkEntry: async (id, file, entry) => {
      if (window.__failLinksWrites) throw new Error('mock: 链接写失败')
      const l = loadLinks(); l[id] = l[id] || { version: 1, records: {} }
      if (entry == null) delete l[id].records[file]
      else l[id].records[file] = JSON.parse(JSON.stringify(entry))
      localStorage.setItem('links-mock', JSON.stringify(l)); return true
    },
```
顶部加 `const DOC3 = { id: '00000000-0000-4000-8000-000000000003', title: '文本测试书', fileName: 'test-text.pdf', ... }` 并入 LIB.documents；加 `const loadNotes = () => JSON.parse(localStorage.getItem('notes-mock') || '{}')` 与 `loadLinks`。**删除**既有 `getDocUrl: async () => '/test.pdf'` 行（被上面取代）。

- [ ] **Step 3: preview.js 补丁加宽**（`scripts/sync-www.mjs` 中既有 layout 补丁）

replacement 中 detail 尾部改为：
```js
      baseW: base.width, baseH: base.height,
      pageObj: page, viewport: fitted.viewport
    } }))
```
Run: `node scripts/sync-www.mjs`（34 处不变，无新补丁）；`grep -n "pageObj" www/js/preview.js` 确认落地

- [ ] **Step 4: 文本层核心** `mobile-web/js/mobile/link.js`（本任务范围）

```js
// 摘录链接（link.js）：选词/标记/记录编辑器。
// P2-T6：文本层核心（懒建 + 代数作废 + 按页缓存）；选词与标记见后续任务
import pdfjsLib from '../pdfjs.js'
import { esc } from '../util.js'
import { buildPageText } from './link-text.mjs'

let host = null            // #previewBody
let pdfCanvas = null
let layer = null           // .ink-text-layer（懒建）
let lastLayout = null      // 最近一次 layout detail（含 pageObj/viewport）
let buildSeq = 0
const textCache = new Map()          // page -> { tc, items, pageText, spans }
const linksCache = new Map()         // docId -> { records }
let selections = []                  // [{ page, text, hint }]（T7 用）
let pendingFlash = null              // { docId, file }（T8/T10 用）

window.linkSelecting = false

function ensureDom () {
  if (host) return
  host = document.getElementById('previewBody')
  pdfCanvas = document.getElementById('previewCanvas')
}

function shouldBuild () {
  const recs = lastLayout && linksCache.get(lastLayout.docId)
  return window.linkSelecting || !!(recs && Object.keys(recs.records).length)
}

async function loadLinks (docId) {
  if (!docId || linksCache.has(docId)) return linksCache.get(docId)
  let data = { records: {} }
  try { data = await window.solace.readNoteLinks(docId) } catch { /* 读失败按无记录 */ }
  if (data.notice) window.toast?.(data.notice)
  linksCache.set(docId, data)
  return data
}

function ensureLayer () {
  ensureDom()
  if (layer || !host) return
  layer = document.createElement('div')
  layer.className = 'ink-text-layer'
  layer.hidden = true
  host.insertBefore(layer, document.getElementById('previewError'))
  // 选词的点按/选择监听在 T7 接入：onLayerTap 本任务尚不存在，提前引用会让
  // layout 处理器抛 ReferenceError（L1 必挂）；且 ensureLayer 有 `if (layer)
  // return` 早退，注册放里面在二次进入时会绑不上——T7 在模块作用域绑定
}

function applyLayout (d) {
  if (!layer || !d) return
  layer.style.left = pdfCanvas.offsetLeft + 'px'
  layer.style.top = pdfCanvas.offsetTop + 'px'
  layer.style.width = d.cssW + 'px'
  layer.style.height = d.cssH + 'px'
  // span 的字号与定位是 calc(var(--scale-factor)*…)：必须给 CSS 尺度而非
  // 设备像素尺度（dpr=1 时两者相同，平板上差一倍、文字会大一圈且错位）
  layer.style.setProperty('--scale-factor', String(d.cssW / d.baseW))
}

async function buildLayer (d) {
  const seq = ++buildSeq
  await loadLinks(d.docId)
  if (seq !== buildSeq) return
  if (!shouldBuild()) { layer.textContent = ''; layer.hidden = true; return }
  const key = `${d.docId}:${d.page}` // 仅按 page 会在换书时串页
  let entry = textCache.get(key)
  if (!entry) {
    const tc = await d.pageObj.getTextContent()
    if (seq !== buildSeq) return
    const { text, spans } = buildPageText(tc.items)
    entry = { tc, items: tc.items, pageText: text, spans }
    textCache.set(key, entry)
  }
  // TextLayer 只往容器里 append：不清空会逐页/逐次累积
  layer.textContent = ''
  // T4 spike 实测（vendored 4.10.38）：容器必须设 --scale-factor，且 TextLayer
  // 视口要用 CSS 尺度重建（不是 layout detail 里的设备像素 fitted.viewport）
  const tl = new pdfjsLib.TextLayer({
    textContentSource: entry.tc,
    container: layer,
    viewport: d.pageObj.getViewport({ scale: d.cssW / d.baseW })
  })
  await tl.render()
  if (seq !== buildSeq) return
  // textDivs[i] 与 items[i] 一一对应（含 hasEOL 项；br 不在 textDivs 里）
  tl.textDivs.forEach((el, i) => { el.dataset.item = String(i) })
  layer.hidden = false
}
```

- [ ] **Step 5: CSS**（`mobile.css` 追加）

```css
/* 摘录链接：文本层（透明文字、仅标记可交互） */
.ink-text-layer {
  position: absolute;
  z-index: 1;
  overflow: hidden;
  line-height: 1;
  text-align: initial;
  text-size-adjust: none;
  transform-origin: 0 0;
  pointer-events: none;
}
/* 只作用于层的**直接子项**（文本项）。标记 span 是插在文本项**内部**的，
   用后代选择器会让标记也被绝对定位+透明——跑出行首、整体错位 */
.ink-text-layer > span, .ink-text-layer > br {
  color: transparent;
  position: absolute;
  white-space: pre;
  transform-origin: 0% 0%;
}
.ink-text-layer .lnk {
  pointer-events: auto;
  cursor: pointer;
  background: rgba(245, 159, 0, 0.28);
  border-bottom: 1px solid rgba(245, 159, 0, 0.75);
}
.lnk-flash { animation: lnk-flash 0.45s ease-in-out 2; }
@keyframes lnk-flash { 50% { background: rgba(245, 159, 0, 0.75); } }
```

- [ ] **Step 6: mobile.js 挂载**：`import './link.js'`（在 `import './ink.js'` 旁）

- [ ] **Step 7: layout/close 事件接线**（link.js 追加）

```js
window.addEventListener('solace-ink-layout', async (e) => {
  const d = e.detail
  if (!d || !d.docId || !d.pageObj) return
  ensureLayer()
  lastLayout = d
  applyLayout(d)
  await buildLayer(d)
})

window.addEventListener('solace-ink-close', () => {
  buildSeq++
  lastLayout = null
  layer && (layer.innerHTML = '', layer.hidden = true)
})
```

- [ ] **Step 8: harness 基建与 L1**（`link-test.mjs`，CDP 样板照抄 p3-test.mjs：端口 **9228**（计划初稿写 9230，以 Global Constraints 为准）、send/evalJs/waitUntil/sleep/mouse/shot）

```js
// link-test.mjs 头部 helper（样板同 p3-test.mjs，本套件自有部分如下）
const DOC = '00000000-0000-4000-8000-000000000001'
const DOC3 = '00000000-0000-4000-8000-000000000003'

// primeOrigin：先到 8931 让 localStorage 可写（首次场景在 about:blank 上会失败）
await send('Page.navigate', { url: 'http://localhost:8931/' })
await waitUntil(`document.readyState === 'complete'`, 'primed', 20000)

const clearStores = () => evalJs(
  `localStorage.removeItem('notes-mock'); localStorage.removeItem('links-mock'); localStorage.removeItem('ann-mock'); 'cleared'`)

async function seedLinks (id, records) {
  await evalJs(`(function () {
    const s = JSON.parse(localStorage.getItem('links-mock') || '{}')
    s['${id}'] = { version: 1, records: ${JSON.stringify(records)} }
    localStorage.setItem('links-mock', JSON.stringify(s))
    return 'seeded'
  })()`)
}

async function gotoBook (id) {
  await send('Page.navigate', { url: 'http://localhost:8931/' })
  await waitUntil(`!!document.querySelector('[data-action="preview-doc"]') || !!document.querySelector('[data-action="pile-open"]')`, '书架', 20000)
  if (!(await evalJs(`document.querySelectorAll('[data-action="preview-doc"]').length`))) {
    await evalJs(`document.querySelector('[data-action="pile-open"]').click()`)
    await waitUntil(`!!document.querySelector('[data-action="preview-doc"]')`, '书堆展开')
  }
  await evalJs(`document.querySelector('[data-action="preview-doc"][data-id="${id}"]').click()`)
  await waitUntil(`!document.getElementById('previewOverlay').hidden && document.getElementById('previewCanvas').width > 0`, '预览', 20000)
  await sleep(900)
}

async function clickSentence (i) {
  // 选词置位是同步的、建层是异步的（openSelection 内 await buildLayer）：
  // 不等 span 就点会点到空气；翻页后还要等本页文本到位，否则会点到上一页
  // 残留的 span（caret 偏移按旧页文本换算 → 串页）
  await waitUntil(`document.querySelectorAll('.ink-text-layer span').length > ${i}`, '待选句 span 就绪')
  const r = await evalJs(`(function () {
    const spans = [...document.querySelectorAll('.ink-text-layer span')]
    const b = spans[Math.min(${i}, spans.length - 1)].getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })()`)
  await mouse('mousePressed', r.x, r.y)
  await mouse('mouseReleased', r.x, r.y)
  await sleep(120)
}

async function clickMarker () {
  const r = await evalJs(`(function () {
    const b = document.querySelector('.ink-text-layer .lnk').getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })()`)
  await mouse('mousePressed', r.x, r.y)
  await mouse('mouseReleased', r.x, r.y)
  await sleep(150)
}

// 几何对齐：页 1 首行文本在 PDF 坐标 (72, 760)，页面 595×842（scale=1）。
// 横向是精确值（左 = 72/595 ≈ 0.1210，无字体度量成分）；纵向顶边由 pdf.js
// 按字体实测 ascent 定位（实测 ≈ 0.0823，T4 spike 的 style 也是 top: 8.23%），
// 故用带容忍的区间。真正的 dpr 判据是「字体物理尺寸不随 dpr 变」
const ALIGN_EXPR = `(function () {
  const l = document.querySelector('.ink-text-layer')
  const spans = [...l.querySelectorAll('span')]
  const b = spans[0].getBoundingClientRect()
  const c = document.getElementById('previewCanvas').getBoundingClientRect()
  return {
    n: spans.length, sample: spans[0].textContent,
    hasItem0: !!l.querySelector('[data-item="0"]'),
    dx: Math.abs(b.x - (c.x + c.width * (72 / 595))),
    topFrac: (b.y - c.y) / c.height,
    inside: b.x >= c.x - 2 && b.x + b.width <= c.right + 2 && b.y >= c.y - 2 && b.y + b.height <= c.bottom + 2,
    spanH: b.height, spanW: b.width,
    cssScale: getComputedStyle(l).getPropertyValue('--scale-factor').trim(),
    dpr: window.devicePixelRatio
  }
})()`
const checkAlign = (tag, r) => {
  if (r.n < 3) throw new Error(tag + ' 文本层 span 太少: ' + r.n)
  if (!r.hasItem0) throw new Error(tag + ' data-item 编号缺失（T7 的 caret 换算依赖它）')
  if (!r.inside) throw new Error(tag + ' span 溢出页面')
  if (r.dx > 5) throw new Error(tag + ' 文本层横向错位: dx=' + r.dx.toFixed(1))
  if (r.topFrac < 0.075 || r.topFrac > 0.095) throw new Error(tag + ' 文本层纵向错位: topFrac=' + r.topFrac.toFixed(4))
}

/* ---- L1 文本层：有记录的书建层 + 几何对齐；无记录的书不建 ---- */
await clearStores()
await seedLinks(DOC3, { '2026-10-03 10.00.00.md': { excerpts: [{ page: 1, text: 'This is the second sentence.' }] } })
await gotoBook(DOC3)
await waitUntil(`!!document.querySelector('.ink-text-layer:not([hidden])')`, '文本层建立', 15000)
const l1 = await evalJs(ALIGN_EXPR)
checkAlign('L1', l1)

// L1b：dpr=2 复验——文本层的物理尺寸（CSS px）不得随 dpr 变化。
// 若 --scale-factor 误用设备像素尺度（或 TextLayer 视口用设备像素尺度），
// 字号会翻倍：spanH 差出 ~40px
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 850, deviceScaleFactor: 2, mobile: false })
await gotoBook(DOC3)
await waitUntil(`!!document.querySelector('.ink-text-layer:not([hidden])')`, '文本层建立(dpr2)', 15000)
const l1b = await evalJs(ALIGN_EXPR)
checkAlign('L1b', l1b)
if (Math.abs(l1b.spanH - l1.spanH) > 2) throw new Error('L1b 字号随 dpr 变化（尺度用错）: spanH ' + l1.spanH + ' → ' + l1b.spanH)
if (Math.abs(l1b.spanW - l1.spanW) > 4) throw new Error('L1b 行宽随 dpr 变化')
await send('Emulation.clearDeviceMetricsOverride')

// 无记录的纯图形书（DOC）：不进选词且无记录 → 不建层
await clearStores()
await gotoBook(DOC)
await sleep(1200)
if (await evalJs(`!!document.querySelector('.ink-text-layer:not([hidden])')`)) throw new Error('L1 无记录书不应建层')
```

- [ ] **Step 9: 运行 L1**

Run: `node link-test.mjs`（server 在跑）
Expected: `L1 …` 全过；失败截图存 `link-fail.png`

- [ ] **Step 10: 提交**（仅仓库内变更）

```bash
git add mobile-web/js/mobile/link.js mobile-web/css/mobile.css mobile-web/js/mobile/mobile.js scripts/sync-www.mjs www/js/preview.js
git commit -m "feat: 摘录链接 P2——文本层核心（懒建/按页缓存/代数作废）+ layout 补丁加宽"
```

### Task 7: 选词模式（点选/托盘/跨页/互斥/返回键）

**Files:**
- Modify: `mobile-web/js/mobile/link.js`
- Modify: `mobile-web/css/mobile.css`（托盘样式）
- Modify: `mobile-web/js/mobile/mobile.js`（边缘点按守卫）
- Modify: `mobile-web/js/mobile/ink.js`（互斥）
- Modify: `bridge/boot.mjs`（返回键链一级）
- Modify: `scripts/sync-www.mjs`（index.html +1 按钮；计数 34→35）

**Interfaces:**
- Consumes: `link-text.mjs` 全部；`window.inkActive`；ink 的 `solace-ink-exit-request`
- Produces: `window.linkSelecting`（选词中 true）；`solace-link-cancel-request` 事件（取消=清空退出）；托盘 DOM `#linkTray`；`selections: [{ page, text, hint }]`；`openSelection()` / `closeSelection(clear)`

- [ ] **Step 1: index.html 补丁**（sync-www.mjs 在既有 btnInk 补丁**之后**追加）

```js
  // 摘录链接入口按钮（预览顶栏；link.js 由 mobile.js 静态 import 挂载）
  ['        <button id="btnInk" class="btn-ghost" title="手写标注">✏️ 标注</button>',
   '        <button id="btnInk" class="btn-ghost" title="手写标注">✏️ 标注</button>\n        <button id="btnLink" class="btn-ghost" title="摘录链接">🔗 链接</button>'],
```
计数日志改 `index.html×11`、`（共35）`。Run: `node scripts/sync-www.mjs`；`grep -n btnLink www/index.html`

- [ ] **Step 2: mobile.js 守卫生效**（pointerup 的快速点按分支内，热区判定之前）

```js
  if (dt < 300 && dist < 12) {
    if (window.linkSelecting) return // 选词模式：点按=选句，关边缘点按翻页（滑动翻页保留）
```

- [ ] **Step 3: ink.js 互斥**（btnInk 点击处理）

```js
document.getElementById('btnInk')?.addEventListener('click', () => {
  if (!active && window.linkSelecting) window.dispatchEvent(new CustomEvent('solace-link-cancel-request'))
  setActive(!active)
})
```

- [ ] **Step 4: boot.mjs 返回键链**（对话框分支之后、inkActive 检查之前插入）

```js
  // 摘录链接选词模式：返回键 = 取消选词（清空选集退出）
  if (window.linkSelecting) {
    window.dispatchEvent(new CustomEvent('solace-link-cancel-request'))
    lastBackAt = 0
    return
  }
```

- [ ] **Step 5: link.js 选词模式**（追加；顶部既有 `import { buildPageText } ...` 扩为下面这行）

```js
import { buildPageText, splitSentences, sentenceAt, normalizeText, offsetToItem } from './link-text.mjs'

let selections = []        // [{ page, text, hint }]
let tray = null

function ensureTray () {
  if (tray) return
  tray = document.createElement('div')
  tray.id = 'linkTray'
  tray.className = 'link-tray'
  tray.hidden = true
  tray.innerHTML = `
    <span id="linkTrayCount" class="link-tray-count"></span>
    <button id="btnLinkCancel" class="btn-ghost">取消</button>
    <button id="btnLinkDone" class="btn-primary" disabled>完成</button>`
  document.getElementById('previewOverlay').appendChild(tray)
  tray.querySelector('#btnLinkCancel').addEventListener('click', () => closeSelection(true))
  tray.querySelector('#btnLinkDone').addEventListener('click', () => openEditor({ mode: 'create' }))
}

function trayUpdate () {
  if (!tray) return
  const pages = new Set(selections.map(s => s.page))
  tray.querySelector('#linkTrayCount').textContent = `已选 ${selections.length} 处 · 跨 ${pages.size} 页`
  tray.querySelector('#btnLinkDone').disabled = selections.length === 0
}

async function openSelection () {
  ensureDom(); ensureLayer(); ensureTray()
  if (window.inkActive) window.dispatchEvent(new CustomEvent('solace-ink-exit-request'))
  window.linkSelecting = true
  selections = []
  trayUpdate()
  tray.hidden = false
  document.body.classList.add('link-selecting')
  if (lastLayout) await buildLayer(lastLayout)
}

function closeSelection (clear) {
  if (clear) selections = []
  window.linkSelecting = false
  document.body.classList.remove('link-selecting')
  if (tray) tray.hidden = true
  buildSeq++
  if (lastLayout) buildLayer(lastLayout).catch(() => {})
}
// （计划初稿这里还有一行 layer.classList.remove('lnk-selected-mode')——该项目
// 无此 class 定义，已删）

window.addEventListener('solace-link-cancel-request', () => { if (window.linkSelecting) closeSelection(true) })
document.getElementById('btnLink')?.addEventListener('click', () => openSelection())

// 选词模式点按：caret 命中 → 页面文本偏移 → 整句扩选/取消
function onLayerTap (e) {
  if (!window.linkSelecting || !lastLayout) return
  const caret = document.caretPositionFromPoint
    ? document.caretPositionFromPoint(e.clientX, e.clientY)
    : (document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null)
  if (!caret) return
  const node = caret.offsetNode || caret.startContainer
  const el = node && node.nodeType === 1 ? node : node && node.parentElement
  const itemEl = el && el.closest('[data-item]')
  if (!itemEl || !layer.contains(itemEl)) return
  const item = Number(itemEl.dataset.item)
  const charInNode = caret.offset !== undefined ? caret.offset : caret.startOffset
  const entry = textCache.get(lastLayout.page)
  if (!entry) return
  const off = entry.spans[item].start + Math.min(charInNode, entry.spans[item].end - entry.spans[item].start)
  const sentences = splitSentences(entry.pageText)
  const si = sentenceAt(sentences, off)
  const r = sentences[si]
  const text = normalizeText(entry.pageText.slice(r.start, r.end))
  if (!text) return
  const hint = offsetToItem(entry.spans, r.start)
  const idx = selections.findIndex(s => s.page === lastLayout.page && s.hint.item === hint.item && s.hint.char === hint.char)
  if (idx >= 0) selections.splice(idx, 1)
  else selections.push({ page: lastLayout.page, text, hint })
  trayUpdate()
  buildLayer(lastLayout)   // 重绘选中态（T8 标记渲染后合并进同一渲染）
}

// 占位：完整的记录编辑器在 T9 落地时替换本函数（保证中间提交不落破损态）
function openEditor () { window.toast?.('记录编辑器将在下一任务接入') }

// 点按监听绑在 #previewBody（静态 HTML，模块求值时已在）。文本层默认
// pointer-events:none，选词模式下由 CSS 放开，事件冒泡到 body 层最稳。
// 注意：**不能**把注册放进 ensureLayer——它开头就 `if (layer || !host) return`，
// 二次进入（换书/关开预览）时根本走不到那一行
document.getElementById('previewBody')?.addEventListener('pointerup', onLayerTap)
```

（`data-item` 需在文本层渲染时补：`buildLayer` 中 render 后 `[...layer.children].forEach((el, i) => { if (el.tagName !== 'BR') el.dataset.item = i })`——只对 span 编号，遇 br 需与 items 索引对齐：按 `layer.querySelectorAll('span')` 顺序编号更稳，实现时以 T4 实测的 DOM 结构为准。）

- [ ] **Step 6: CSS**（托盘 + 选中态）

```css
.link-tray {
  position: absolute; left: 50%; bottom: 86px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; z-index: 6;
  padding: 8px 12px; border-radius: 12px;
  background: rgba(18, 22, 27, 0.95); border: 1px solid rgba(255, 255, 255, 0.14);
  color: #e8edf2; font-size: 13px;
}
/* [hidden] 必须显式压回 display:none——设了 display:flex 后 hidden 属性的
   UA 规则会失效，托盘会常显（style.css 为 .preview-error 记过同一个坑） */
.link-tray[hidden] { display: none; }
.ink-text-layer .lnk-sel { background: rgba(103, 88, 255, 0.25); outline: 1px dashed rgba(103, 88, 255, 0.7); }
body.link-selecting .ink-text-layer { pointer-events: auto; user-select: none; }
```

- [ ] **Step 7: harness L2/L9/L10**（追加到 `link-test.mjs`；helper 已在 T6 定义）

```js
/* ---- L2 点选/取消/托盘 ---- */
await clearStores()
await gotoBook(DOC3)
await evalJs(`document.getElementById('btnLink').click()`)
await waitUntil(`window.linkSelecting === true && document.getElementById('linkTray').hidden === false`, '进选词')
await clickSentence(0)
await sleep(300)
if (!(await evalJs(`document.getElementById('linkTrayCount').textContent`)).includes('1 处')) throw new Error('L2 选 1 处失败')
await clickSentence(0)
await sleep(300)
if (!(await evalJs(`document.getElementById('linkTrayCount').textContent`)).includes('0 处')) throw new Error('L2 再点取消失败')

/* ---- L3a 跨页累积（完成→编辑器链路在 T9 接真后断言；这里只验托盘） ---- */
await clickSentence(0)
await evalJs(`document.getElementById('btnNextPage').click()`)
await waitUntil(`document.getElementById('pageJump').value === '2'`, '翻页')
// 等**第 2 页的文本**就位再点，不能只等页码变化 + 固定 sleep：
// 层里可能还是上一页残留的 span，caret 偏移会按旧页文本换算（串页）
await waitUntil(`(document.querySelector('.ink-text-layer span') || {}).textContent === 'Page two opens here.'`, '第 2 页文本层就绪')
await clickSentence(0)
await sleep(300)
const trayText = await evalJs(`document.getElementById('linkTrayCount').textContent`)
if (!trayText.includes('2 处') || !trayText.includes('2 页')) throw new Error('L3a 跨页累积失败: ' + trayText)

/* ---- L9 与墨水互斥 ---- */
await evalJs(`document.getElementById('btnInk').click(); 'ink'`)       // 选词中进墨水 → 选词退出
await waitUntil(`window.linkSelecting === false`, '选词退出')
if (!(await evalJs(`window.inkActive === true`))) throw new Error('L9 ink 未激活')
await evalJs(`document.getElementById('btnLink').click(); 'link'`)     // 墨水中进选词 → 墨水退出
await waitUntil(`window.linkSelecting === true`, '进选词')
if (await evalJs(`window.inkActive === true`)) throw new Error('L9 墨水未退出')
await evalJs(`document.getElementById('btnLinkCancel').click()`)

/* ---- L10 无文字页降级 ---- */
await clearStores()
await gotoBook(DOC)   // 纯图形书
await evalJs(`document.getElementById('btnLink').click()`)
await sleep(600)
// 建层后无文本 → 视为不可选：toast + 自动退出（Step 8 实现）
if (await evalJs(`window.linkSelecting === true`)) throw new Error('L10 无文字页未退出选词')
```

- [ ] **Step 8: L10 降级实现**（link.js：buildLayer 后无 span 时）

```js
  // buildLayer 末尾：
  const hasText = layer.querySelector('span') != null
  if (window.linkSelecting && !hasText) {
    window.toast?.('本页没有可选择的文字，翻到有文字的页面再试')
    closeSelection(true)
    return
  }
```
（无文字书不建层的懒建规则与选词强建冲突时以「强建一次、发现无字即退」处理。）

- [ ] **Step 9: 运行 L1-L10（含既有 L1 回归）**

Run: `node link-test.mjs` → 全过

**实施偏差（2026-10-04）**

1. **pointerup 注册落点**：T6 里 ensureLayer 的 `host.addEventListener(
   'pointerup', onLayerTap)` 已按计划推迟，T7 改为在**模块作用域**绑定
   `document.getElementById('previewBody')?.addEventListener('pointerup',
   onLayerTap)`——ensureLayer 有 `if (layer) return` 早退，把注册放在里面
   会导致二次进入（换书/关开预览）时绑不上。
2. **CSS 补 `.link-tray[hidden] { display: none; }`**：`.link-tray` 设了
   `display: flex`，会盖掉 `hidden` 属性的 UA 规则 → 托盘常显。仓库
   style.css 为 `.preview-error` 记过同一个坑。
3. `closeSelection` 里计划原文的 `layer.classList.remove('lnk-selected-mode')`
   已删——该 class 全项目无定义（遗留）。
4. L10 判据用 `tl.textDivs.length`（而非 `layer.querySelector('span')`），
   与 data-item 编号同源、少一次 DOM 查询。
5. harness：`clickSentence` 必须先等 span 就绪（选词置位是同步的、建层是
   异步的）；L3a 翻页后要等**第 2 页文本**到位，不能只等页码变化+固定
   sleep——否则会点到上一页残留的 span，caret 偏移按旧页文本换算导致串页。
6. 新增 **L2b**：选词模式下边缘点按不得翻页（覆盖 mobile.js 的
   `window.linkSelecting` 守卫；计划只写了代码没写测试），同时断言空白处
   点按不改选集。
7. 「完成」按钮在 T7 只弹占位 toast——记录编辑器 T9 接入（按计划）。
- [ ] **Step 10: 提交**

```bash
git add mobile-web/js/mobile/link.js mobile-web/css/mobile.css mobile-web/js/mobile/mobile.js mobile-web/js/mobile/ink.js bridge/boot.mjs scripts/sync-www.mjs www/
git commit -m "feat: 摘录链接 P2——选词模式（整句点选/托盘/跨页/墨水互斥/返回键）+ 入口按钮补丁"
```

---

## 阶段 P3 · 标记与编辑器

### Task 8: 标记渲染 + 重锚定 + 点标记

**Files:**
- Modify: `mobile-web/js/mobile/link.js`、`mobile-web/css/mobile.css`（选中态合并渲染）

**Interfaces:**
- Consumes: `findRangeByText`；`linksCache`
- Produces: `renderMarkers(d)`（当前页 .lnk span）；`pendingFlash`；标记点击 → `openEditor({ mode: 'edit', file })`（T9 实现）

- [ ] **Step 1: 标记渲染**（buildLayer render 之后调用）

```js
// 把页面文本区间 [start,end) 拆到它覆盖的各个文本项上（存项内相对偏移）
function rangesToItems (entry, start, end, file, cls, byItem) {
  for (let i = 0; i < entry.spans.length; i++) {
    const s = entry.spans[i]
    const a = Math.max(start, s.start)
    const b = Math.min(end, s.end)
    if (a >= b) continue
    const list = byItem.get(i) || []
    list.push({ from: a - s.start, to: b - s.start, file, cls })
    byItem.set(i, list)
  }
}

// 按区间把某项文本切成 文本节点 + 标记 span（一遍重建，重叠段取先登记者）
function paintItem (el, list) {
  const text = el.textContent
  const cuts = [...new Set([0, text.length, ...list.flatMap(r => [r.from, r.to])])]
    .filter(n => n >= 0 && n <= text.length).sort((a, b) => a - b)
  el.textContent = ''
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k]
    const b = cuts[k + 1]
    if (a >= b) continue
    const seg = text.slice(a, b)
    const hit = list.find(r => r.from <= a && b <= r.to)
    if (hit) {
      const mk = document.createElement('span')
      mk.className = hit.cls
      mk.dataset.file = hit.file
      mk.textContent = seg
      el.appendChild(mk)
    } else {
      el.appendChild(document.createTextNode(seg))
    }
  }
}

// 记录锚点（.lnk）+ 选词选中态（.lnk-sel）合并成**一遍**重建：分两遍时
// 后一遍会拿原文本重切，把前一遍的标记覆盖掉（计划初稿的 wrapRange 逐区间
// 改 DOM 就有这个问题）
function renderMarkers (d) {
  const entry = textCache.get(`${d.docId}:${d.page}`)
  if (!entry) return
  const byItem = new Map()
  const docLinks = linksCache.get(d.docId)
  for (const [file, rec] of Object.entries((docLinks && docLinks.records) || {})) {
    for (const ex of (rec && rec.excerpts) || []) {
      if (ex.page !== d.page) continue
      const hint = ex.hint != null && entry.spans[ex.hint.item]
        ? entry.spans[ex.hint.item].start + ex.hint.char
        : null
      const r = findRangeByText(entry.pageText, ex.text, hint)
      if (r) rangesToItems(entry, r.start, r.end, file, 'lnk', byItem)
    }
  }
  if (window.linkSelecting) {
    for (const sel of selections) {
      if (sel.page !== d.page) continue
      const hint = entry.spans[sel.hint.item] ? entry.spans[sel.hint.item].start + sel.hint.char : null
      const r = findRangeByText(entry.pageText, sel.text, hint)
      if (r) rangesToItems(entry, r.start, r.end, '__sel__', 'lnk-sel', byItem)
    }
  }
  for (const [i, list] of byItem) {
    const el = layer.querySelector(`[data-item="${i}"]`)
    if (el) paintItem(el, list)
  }
  // 跳回定位：目标页渲染完才闪（一次性消费）
  if (pendingFlash && pendingFlash.docId === d.docId) {
    const t = layer.querySelector(`.lnk[data-file="${CSS.escape(pendingFlash.file)}"]`)
    pendingFlash = null
    if (t) {
      t.scrollIntoView({ block: 'center' })
      t.classList.add('lnk-flash')
      setTimeout(() => t.classList.remove('lnk-flash'), 1100)
    }
  }
}
```
（选中态用 `cls='lnk-sel'` 与 `data-file='__sel__'` 区分；点按分流见 Step 2。
另外 `renderMarkers` 依赖的文本层基础样式必须是 `.ink-text-layer > span`
直接子选择器——标记 span 插在文本项**内部**，后代选择器会让它也被绝对
定位 + 透明，跑出行首。）

- [ ] **Step 2: 点按分流 + 渲染接线**

把 T7 的 `onLayerTap` 开头改为标记优先（标记在阅读模式也可点；T9 前 openEditor 为占位，点击只会 toast）：

```js
function onLayerTap (e) {
  if (!lastLayout) return
  const mk = e.target && e.target.closest && e.target.closest('.lnk')
  if (mk && mk.dataset.file !== '__sel__') {
    openEditor({ mode: 'edit', file: mk.dataset.file, docId: lastLayout.docId })
    return
  }
  if (!window.linkSelecting) return
  // ……原有选句逻辑不变，**但 caret 偏移必须改**：标记 span 把项文本切成了
  // 多个节点，`caret.offset`（相对所在光标节点）不再等于项内偏移。
  // 改用 Range 量出「相对整个文本项」的字符数：
  //   const range = document.createRange()
  //   range.selectNodeContents(itemEl)
  //   range.setEnd(node, charInNode)          // 可能抛，需 try/catch
  //   const charInItem = range.toString().length
  //   const off = span.start + Math.min(charInItem, span.end - span.start)
```

并在 `buildLayer` 的 `tl.render()` 之后调用 `renderMarkers(d)`；`renderMarkers` 末尾消费 `pendingFlash`（找 `.lnk[data-file]` → `scrollIntoView({ block: 'center' })` + `lnk-flash` 类 1s 后移除）

- [ ] **Step 3: harness L4**（seed 单条记录 → 标记出现且文本正确）

```js
/* ---- L4 标记：有记录的页出现 .lnk，文本与摘录一致 ---- */
await seedLinks(DOC3, { '2026-10-03 10.00.00.md': { excerpts: [{ page: 1, text: 'This is the second sentence.' }] } })
await resetAndOpen(DOC3)
await waitUntil(`!!document.querySelector('.ink-text-layer .lnk')`, '标记出现', 15000)
const mk = await evalJs(`document.querySelector('.ink-text-layer .lnk').textContent`)
if (mk !== 'This is the second sentence.') throw new Error('L4 标记文本不符: ' + mk)
// 未命中文本不产生标记 + 记录仍可打开（T9）
```
（点标记打开编辑器的断言放 T9 的 L5。）

- [ ] **Step 4: 运行并提交**

Run: `node link-test.mjs` → 全过
```bash
git add mobile-web/js/mobile/link.js mobile-web/css/mobile.css
git commit -m "feat: 摘录链接 P3——正文标记渲染与重锚定（hint 消歧/闪烁定位基础）"
```

**实施偏差（2026-10-04）**

1. **标记与选中态合并成一遍重建**：计划按区间逐个改 DOM（wrapRange），两遍
   时后一遍会拿原文本重切、把前一遍的标记覆盖掉（记录标记 + 选中态重叠时
   必然发生）。实现改为「按文本项聚合区间 → 每项一次重切」，重叠区间取
   先登记者（记录优先于选中态）。
2. **CSS 收窄为 `.ink-text-layer > span`**：标记 span 是插在文本项**内部**的，
   后代选择器会让它也被绝对定位 + 透明色，跑出行首、整体错位。
3. **caret 偏移改用 Range 量**：标记把项文本切成多个节点后，
   `caret.offset`（相对所在文本节点）不再等于项内偏移，直接相加会算错句子。
4. textCache 键统一为 `${docId}:${page}`（计划写裸 page，与 T6 已改的键不符）。
5. L4 三条计划外的强化断言：项内片段标记的 x 必须右移（内联定位的决定性
   判据，实测 offsetX=170.6px）、重复句的 hint 必须命中第 5 项（第二处）、
   标记纵向中心须落在所在文本行内。

### Task 9: 记录编辑器（创建/编辑/保存/失败重试/退化）

**Files:**
- Modify: `mobile-web/js/mobile/link.js`、`mobile-web/css/mobile.css`（编辑器 chips 样式）

**Interfaces:**
- Consumes: `solace.createNote / writeNote / setNoteLinkEntry`；`generateRecordMd / parseRecordMd`；`askConfirm`
- Produces: `openEditor({ mode, file?, docId? })`；保存成功派发 `solace-note-saved`

- [ ] **Step 1: 编辑器 DOM + 逻辑**（link.js 追加；**并替换 T7 的 `openEditor` 占位实现**）

```js
import { askConfirm } from '../dialog.js'
import { generateRecordMd, parseRecordMd } from './link-md.mjs'

let edDlg = null
let edCtx = null      // { mode, docId, file?, title, total, excerpts, degraded }
let edDirty = false
let edSaving = false

function ensureEditor () {
  if (edDlg) return
  const wrap = document.createElement('div')
  wrap.innerHTML = `
    <dialog id="linkRecordDialog" class="dialog note-editor-dialog">
      <div class="stats-head"><h3 id="linkRecordTitle">摘录记录</h3>
        <button id="btnLinkEdClose" class="btn-ghost">✕</button></div>
      <div id="linkChips" class="link-chips"></div>
      <textarea id="linkRecordText" class="note-editor-text" spellcheck="false" placeholder="写点什么…"></textarea>
      <div class="dialog-foot">
        <button id="btnLinkEdCancel" class="btn-ghost">取消</button>
        <button id="btnLinkEdSave" class="btn-primary">保存</button>
      </div>
    </dialog>`
  document.body.appendChild(wrap.firstElementChild)
  edDlg = document.getElementById('linkRecordDialog')
  edDlg.querySelector('#linkRecordText').addEventListener('input', () => { edDirty = true })
  edDlg.querySelector('#btnLinkEdSave').addEventListener('click', saveEditor)
  edDlg.querySelector('#btnLinkEdCancel').addEventListener('click', requestEditorClose)
  edDlg.querySelector('#btnLinkEdClose').addEventListener('click', requestEditorClose)
  edDlg.addEventListener('solace-close-request', (e) => { if (edDirty) { e.preventDefault(); requestEditorClose() } })
}

function renderChips () {
  const box = edDlg.querySelector('#linkChips')
  box.innerHTML = edCtx.degraded
    ? '<span class="link-chip-degraded">文件格式已被外部修改，将按普通笔记保存（锚点保留）</span>'
    : edCtx.excerpts.map((x, i) =>
        `<span class="link-chip"><b>第 ${x.page} 页</b> ${esc(x.text.slice(0, 40))}<button class="chip-x" data-i="${i}" title="移除">✕</button></span>`).join('')
  box.querySelectorAll('.chip-x').forEach(b => b.addEventListener('click', () => {
    edCtx.excerpts.splice(Number(b.dataset.i), 1); edDirty = true; renderChips()
  }))
}

async function openEditor (opts) {
  ensureEditor()
  if (opts.mode === 'edit') {
    const docLinks = linksCache.get(opts.docId)
    const rec = docLinks && docLinks.records[opts.file]
    if (!rec) { window.toast?.('记录已不存在'); return }
    let raw = ''
    try { raw = await window.solace.readNote(opts.docId, opts.file) } catch (err) { window.toast?.(`读取失败：${err.message || err}`); return }
    const parsed = parseRecordMd(raw)
    edCtx = { mode: 'edit', docId: opts.docId, file: opts.file, excerpts: rec.excerpts.map(x => ({ ...x })), degraded: !parsed.ok }
    edDlg.querySelector('#linkRecordText').value = parsed.body
  } else {
    edCtx = { mode: 'create', docId: lastLayout.docId,
      title: document.getElementById('previewTitle').textContent || '摘录',
      total: Number(document.getElementById('pageTotal').textContent) || 0,
      excerpts: selections.map(s => ({ ...s })), degraded: false }
    edDlg.querySelector('#linkRecordText').value = ''
  }
  edDirty = false
  renderChips()
  edDlg.querySelector('#linkRecordTitle').textContent = edCtx.mode === 'create' ? '新建摘录记录' : '摘录记录'
  edDlg.showModal()
  setTimeout(() => edDlg.querySelector('#linkRecordText').focus(), 60)
}

async function requestEditorClose () {
  if (edDirty) {
    const r = await askConfirm({ title: '放弃未保存的修改？', text: '关闭后这些内容将丢失。', okText: '放弃修改' })
    if (!r) return
  }
  edDirty = false
  edDlg.close()
  // 创建流取消：回选词模式且选集保留（spec §6.3）——无需动作，选集不受编辑器影响
}

async function saveEditor () {
  if (edSaving || !edCtx) return
  edSaving = true
  const btn = edDlg.querySelector('#btnLinkEdSave')
  btn.disabled = true
  try {
    if (edCtx.mode === 'create') {
      const { file } = await window.solace.createNote(edCtx.docId, { title: edCtx.title, page: edCtx.excerpts[0]?.page || 1, total: edCtx.total })
      edCtx.file = file
      edCtx.mode = 'edit'
    }
    const body = edDlg.querySelector('#linkRecordText').value
    const content = edCtx.degraded ? body : generateRecordMd(edCtx.excerpts, body)
    await window.solace.writeNote(edCtx.docId, edCtx.file, content)
    if (!edCtx.degraded) {
      await window.solace.setNoteLinkEntry(edCtx.docId, edCtx.file, edCtx.excerpts.length ? { excerpts: edCtx.excerpts } : null)
    }
    const { docId } = edCtx
    edDirty = false
    edDlg.close()
    window.toast?.('记录已保存')
    linksCache.delete(docId)
    await loadLinks(docId)
    if (lastLayout && lastLayout.docId === docId) await buildLayer(lastLayout)
    window.dispatchEvent(new CustomEvent('solace-note-saved', { detail: { docId } }))
    if (window.linkSelecting) closeSelection(true)   // 创建完成退出选词
  } catch (err) {
    window.toast?.(`保存失败：${err.message || err}`)   // 留在编辑器，重试幂等（同一 file）
  } finally {
    edSaving = false
    btn.disabled = false
  }
}
```

（`lastLayout.total` 当前 detail 没有——实现时从 `#pageTotal` 文本取或加补丁字段；取 DOM 更省补丁：`Number(document.getElementById('pageTotal').textContent) || 0`。）

- [ ] **Step 2: CSS chips**

```css
.link-chips { display: flex; flex-wrap: wrap; gap: 6px; max-height: 30vh; overflow: auto; padding: 4px 0; }
.link-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px;
  background: rgba(245, 159, 0, 0.14); border: 1px solid rgba(245, 159, 0, 0.4); font-size: 12px; max-width: 100%; }
.link-chip b { color: #b26a00; font-weight: 600; }
.chip-x { border: 0; background: transparent; cursor: pointer; color: inherit; padding: 0 2px; }
.link-chip-degraded { font-size: 12px; color: #8a94a0; }
```

- [ ] **Step 3: harness L3b/L5/L8/L12**（追加）

```js
/* ---- L3b 完成 → 编辑器 → 保存（跨页两处）→ 标记出现 ---- */
await clearStores()
await gotoBook(DOC3)
await evalJs(`document.getElementById('btnLink').click()`)
await waitUntil(`window.linkSelecting === true`, '进选词')
await clickSentence(0)
await evalJs(`document.getElementById('btnNextPage').click()`)
await waitUntil(`document.getElementById('pageJump').value === '2'`, '翻到2页')
await sleep(600)
await clickSentence(0)
await sleep(200)
await evalJs(`document.getElementById('btnLinkDone').click()`)
await waitUntil(`document.getElementById('linkRecordDialog').open === true`, '编辑器打开')
if ((await evalJs(`document.querySelectorAll('#linkChips .link-chip').length`)) !== 2) throw new Error('L3b chips 应为 2')
await evalJs(`(function () {
  const t = document.getElementById('linkRecordText')
  t.value = '这是记录正文。'
  t.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`)
await evalJs(`document.getElementById('btnLinkEdSave').click()`)
await waitUntil(`document.getElementById('linkRecordDialog').open === false`, '保存关闭')
await sleep(600)
const l3b = await evalJs(`(function () {
  const l = JSON.parse(localStorage.getItem('links-mock') || '{}')['${DOC3}']
  const n = JSON.parse(localStorage.getItem('notes-mock') || '{}')['${DOC3}']
  const file = Object.keys(l.records)[0]
  return { n: l.records[file].excerpts.length, content: n[file] || '' }
})()`)
if (l3b.n !== 2) throw new Error('L3b 锚点应为 2 处')
if (!l3b.content.includes('> 【摘录】第 1 页') || !l3b.content.includes('这是记录正文。')) throw new Error('L3b md 内容不符')
if (await evalJs(`window.linkSelecting === true || document.getElementById('linkTray').hidden === false`)) throw new Error('L3b 保存后未退出选词')
await waitUntil(`!!document.querySelector('.ink-text-layer .lnk')`, 'L3b 标记出现', 8000)

/* ---- L5 点标记 → 编辑器（正文回读一致）→ 改正文保存 ---- */
await clickMarker()
await waitUntil(`document.getElementById('linkRecordDialog').open === true`, 'L5 点标记开编辑器')
if ((await evalJs(`document.getElementById('linkRecordText').value`)) !== '这是记录正文。') throw new Error('L5 正文回读不一致')
await evalJs(`(function () { document.getElementById('linkRecordText').value = '改过的正文'; return 'ok' })()`)
await evalJs(`document.getElementById('btnLinkEdSave').click()`)
await waitUntil(`document.getElementById('linkRecordDialog').open === false`, 'L5 保存关闭')
await sleep(600)
if (!(await evalJs(`(function () {
  const n = JSON.parse(localStorage.getItem('notes-mock') || '{}')['${DOC3}']
  return Object.values(n).some(c => c.includes('改过的正文'))
})()`))) throw new Error('L5 md 未更新')

/* ---- L8 写失败两路径（留在编辑器 + 重试幂等） ---- */
await clickMarker()
await waitUntil(`document.getElementById('linkRecordDialog').open === true`, 'L8 编辑器')
await evalJs(`window.__failLinksWrites = true; 'on'`)
await evalJs(`document.getElementById('btnLinkEdSave').click()`)
await sleep(700)
if (!(await evalJs(`document.getElementById('linkRecordDialog').open === true`))) throw new Error('L8 链接写失败应留在编辑器')
await evalJs(`window.__failLinksWrites = false; 'off'`)
await evalJs(`document.getElementById('btnLinkEdSave').click()`)
await waitUntil(`document.getElementById('linkRecordDialog').open === false`, 'L8 重试成功')
await evalJs(`window.__failNotesWrites = true; 'on'`)
await clickMarker()
await waitUntil(`document.getElementById('linkRecordDialog').open === true`, 'L8b 编辑器')
await evalJs(`document.getElementById('btnLinkEdSave').click()`)
await sleep(700)
if (!(await evalJs(`document.getElementById('linkRecordDialog').open === true`))) throw new Error('L8b 笔记写失败应留在编辑器')
await evalJs(`window.__failNotesWrites = false; document.getElementById('btnLinkEdCancel').click(); 'clean'`)

/* ---- L12 全移除摘录 → 保存 → 条目删除 + md 无摘录区 ---- */
await clickMarker()
await waitUntil(`document.getElementById('linkRecordDialog').open === true`, 'L12 编辑器')
await evalJs(`document.getElementById('linkChips').querySelector('.chip-x').click(); 'r1'`)
await sleep(120)
await evalJs(`document.getElementById('linkChips').querySelector('.chip-x').click(); 'r2'`)
await sleep(120)
await evalJs(`document.getElementById('btnLinkEdSave').click()`)
await waitUntil(`document.getElementById('linkRecordDialog').open === false`, 'L12 保存关闭')
await sleep(600)
const l12 = await evalJs(`(function () {
  const l = JSON.parse(localStorage.getItem('links-mock') || '{}')['${DOC3}']
  const n = JSON.parse(localStorage.getItem('notes-mock') || '{}')['${DOC3}']
  const file = Object.keys(n)[0]
  return { entries: l && l.records ? Object.keys(l.records).length : 0, hasExcerpt: (n[file] || '').includes('【摘录】') }
})()`)
if (l12.entries !== 0 || l12.hasExcerpt) throw new Error('L12 全移除退化失败')
```

- [ ] **Step 4: 运行并提交**

Run: `node link-test.mjs` → 全过
```bash
git add mobile-web/js/mobile/link.js mobile-web/css/mobile.css
git commit -m "feat: 摘录链接 P3——记录编辑器（创建/编辑/保存/失败重试/全移除退化）"
```

### Task 10: 笔记列表整合（行钩子/新建钩子/跳回定位）

**Files:**
- Modify: `scripts/sync-www.mjs`（notespanel.js +2；计数 35→37）
- Modify: `mobile-web/js/mobile/link.js`（hooks + `jumpToExcerpt`）、`mobile-web/js/mobile/mobile.js`（openNoteEditor 钩子）、`mobile-web/css/mobile.css`（行样式）

**Interfaces:**
- Consumes: `closeNotes`（`../notespanel.js`）、`linksCache`、`pendingFlash`
- Produces: `window.__linkNoteRowExtra(file) -> html`；`window.__linkNewOverride(session) -> boolean`；`window.__linkRecordTap(docId, file) -> boolean`；`jumpToExcerpt(docId, file)`

- [ ] **Step 1: notespanel 两个补丁**（sync-www.mjs，notespanel 数组内追加）

```js
  // 摘录链接：记录行徽标+片段（link.js 提供钩子）
  [`        <div class="note-main">
          <span class="note-name">\${esc(displayName(n.file))}</span>
          <span class="note-when">\${esc(fmtRel(n.mtime))}修改</span>
        </div>`,
   `        <div class="note-main">
          <span class="note-name">\${esc(displayName(n.file))}</span>
          <span class="note-when">\${esc(fmtRel(n.mtime))}修改</span>
        </div>
        <div class="note-link-row">\${window.__linkNoteRowExtra?.(n.file) || ''}</div>`],
  // 摘录链接：「＋新建」改走选词模式（入口替换；旧笔记仍可读可改）
  [`btnNew.addEventListener('click', async () => {
  const session = captureSession()
  if (!session) return`,
   `btnNew.addEventListener('click', async () => {
  const session = captureSession()
  if (!session) return
  if (window.__linkNewOverride?.(session)) return`],
  // 摘录链接：删除记录后通知渲染侧清缓存并重绘标记（计划初稿漏了这条——
  // 没有它，「面板删记录 → 标记消失」要等下次保存/重开预览才成立）
  [`      try {
        await window.solace.trashNote(session.id, file, session.sessionId)
        if (!isCurrentSession(session)) return
        load(session)`,
   `      try {
        await window.solace.trashNote(session.id, file, session.sessionId)
        if (!isCurrentSession(session)) return
        window.__linkNoteDeleted?.(session.id, file)
        load(session)`],
  // 摘录链接：批量删除同样要通知（spec §5.4 明确「含批量删除路径」）
  [`  for (const file of files) noteSel.delete(file)
  updateNoteBar()
  load(session)`,
   `  for (const file of files) { noteSel.delete(file); window.__linkNoteDeleted?.(session.id, file) }
  updateNoteBar()
  load(session)`]
```
（注意：sync-www.mjs 是 .mjs 源文件，模板里的 `${...}` 在补丁字符串中按需求转义——既有 notespanel 补丁已用 `\${...}` 写法，照抄。）计数日志 `notespanel.js×7`、`（共39）`。Run: `node scripts/sync-www.mjs` + `grep -n "__linkNoteRowExtra" www/js/notespanel.js`

- [ ] **Step 2: link.js hooks + 跳回**

```js
import { closeNotes } from '../notespanel.js'

window.__linkNoteRowExtra = (file) => {
  const docId = lastLayout && lastLayout.docId
  const rec = docId && linksCache.get(docId) && linksCache.get(docId).records[file]
  if (!rec || !rec.excerpts.length) return ''
  const x = rec.excerpts[0]
  return `<span class="link-badge">🔗</span><span class="link-snip">第 ${x.page} 页 · ${esc(x.text.slice(0, 24))}</span>`
}

window.__linkNewOverride = (session) => {
  if (!session || !lastLayout || session.id !== lastLayout.docId) return false
  closeNotes()
  openSelection()
  return true
}

window.__linkRecordTap = (docId, file) => {
  const rec = linksCache.get(docId) && linksCache.get(docId).records[file]
  if (!rec || !rec.excerpts.length) return false
  jumpToExcerpt(docId, file)
  return true
}

function jumpToExcerpt (docId, file) {
  const rec = linksCache.get(docId) && linksCache.get(docId).records[file]
  if (!rec || !rec.excerpts.length) return false
  const input = document.getElementById('pageJump')
  if (!input) return false
  pendingFlash = { docId, file }
  input.value = String(rec.excerpts[0].page)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return true
}
```
（`pendingFlash` 在 renderMarkers 末尾消费：找 `.lnk[data-file=file]` → `scrollIntoView({ block: 'center' })` + flash。）

- [ ] **Step 3: mobile.js openNoteEditor 钩子**（函数体开头）

```js
window.openNoteEditor = function (docId, file, title, content) {
  if (window.__linkRecordTap?.(docId, file)) return // 记录项：跳回原文定位（link.js）
  ...原逻辑
```

- [ ] **Step 4: CSS 行样式**

```css
.note-link-row { display: flex; align-items: center; gap: 6px; padding: 2px 0 0; font-size: 12px; color: #8a94a0; }
.link-badge { color: #b26a00; }
.link-snip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 5: harness L6/L7**

```js
/* ---- L6 列表：记录行有 🔗+片段；点行跳回页1+闪烁 ---- */
// 打开预览 → btnNotes → 面板行出现 .link-badge；点改行 → pageJump==='1' 且
// 目标 .lnk 出现（闪烁类不强制断言，截图存档 link-jump.png）

/* ---- L7 删除：面板删记录 → 标记消失 + links-mock 条目清 ---- */
```

- [ ] **Step 6: 运行并提交**

Run: `node link-test.mjs` → 全过
```bash
git add mobile-web/js/mobile/link.js mobile-web/js/mobile/mobile.js mobile-web/css/mobile.css scripts/sync-www.mjs www/
git commit -m "feat: 摘录链接 P3——笔记列表整合（记录行徽标/新建钩子/点击跳回定位）+ 补丁 35→39"
```

**实施偏差（2026-10-04）**

1. **多了第 3、4 个 notespanel 补丁，计数 35→39 而非 35→37**：Step 5 的 L7
   要求「面板删记录 → 标记消失」，但删除路径没有任何地方通知渲染侧——不补
   钩子的话标记要等下次保存/重开预览才消失。新增单条删除回调与**批量删除
   回调**两个钩子（spec §5.4 明确「含批量删除路径」）。PORTING 补丁清单已
   同步（notespanel 7 处，共 39）。渲染侧对连续回调做了重绘合并（批量删除
   逐条回调，每个文件都重建文本层太浪费）。
2. `jumpToExcerpt` 顺手 `closeNotes()`：不收起面板的话跳过去也被面板挡着，
   看不见闪烁的目标。（`__linkNewOverride` 进选词前本来就要收面板，一致。）
3. **修 harness mock 的 bug**：计划给的 `listNotes` mock 返回**裸数组**，而
   真桥与 notespanel 的约定是 `{ notes: [...] }`——`const { notes } = await
   ...` 解构出 undefined，列表渲染抛「Cannot read properties of undefined
   (reading 'length')」。L6 是第一个用到笔记列表的场景，这个坑到此刻才暴露。
4. L6 的闪烁断言用 **class 属性的 MutationObserver**（`lnk-flash` 是给已存在
   元素加类，childList 观察不到）；L7 驱动删除确认对话框（`#confirmDialogOk`）。

---

## 阶段 P4 · 收尾

### Task 11: 文档 + 真机 + 全量回归

**Files:**
- Modify: `docs/PORTING.md`（补丁计数 39 与清单、新模块说明）
- Modify: `CHANGELOG.md`（新版本条目草稿）
- Modify: `docs/EXCERPT-LINK-DESIGN.md`（状态行改「已实现」，§12 补进度）

- [ ] **Step 1: PORTING.md**：补丁计数与清单（index×11 / notespanel×7 / preview 加宽说明 / 共 39）；新增「摘录链接」小节（link.js / links-core / link-md / link-text / 数据位置 links/）
- [ ] **Step 2: CHANGELOG.md**：条目（功能、入口替换说明、兼容性：旧 .md 不受影响）
- [ ] **Step 3: 全量回归**

Run: `npm test`（63/63）
Run 依次（server 在跑、串行、勿并发）：`node p3-test.mjs`、`node race-test.mjs`、`node ink-verify.mjs`、`node link-test.mjs` → 全绿
- [ ] **Step 4: 真机**（平板 80b6f44d，lshort 或文本 PDF 书）

流程：装包（`npm run apk` + `npm run install:device`）→ 触屏点选两句（跨页）→ 完成保存 → 关预览重开标记常在 → 点标记开编辑器改正文 → 列表跳回 → 删除记录 → 墨水互斥与返回键链（选词中按返回=取消）。CDP 注入按 device-verify 既有法（`Input.dispatchMouseEvent`，端口 9223 注意它是平板 forward）
- [ ] **Step 5: 提交**

```bash
git add docs/PORTING.md CHANGELOG.md docs/EXCERPT-LINK-DESIGN.md
git commit -m "docs: 摘录链接 P4——移植文档/CHANGELOG 与方案书进度更新"
```

---

## 验证矩阵（spec → 任务对照）

| spec 节 | 覆盖任务 |
|---|---|
| §5 数据设计（格式/解析/侧车/GC） | T1、T2、T3（GC 在 boot.readNoteLinks） |
| §6.1 入口/托盘/完成取消 | T7、T9 |
| §6.2 点选与手势仲裁 | T7（mobile.js 守卫/L9/L10） |
| §6.3 编辑器 | T9（失败/退化/取消保留选集） |
| §6.4 列表与定位 | T10（L6）/ T3（删除联动 L7） |
| §6.5 共存与返回键 | T7（L9 + boot 返回键链） |
| §7 文本层/切分/重锚定/降级 | T4、T5、T6（L1）、T8（L4）、T7（L10） |
| §8 保存管线 | T9（L3b/L5/L8/L12） |
| §9 桥接层 | T3（+两处接口微调见 Global Constraints） |
| §10 补丁 34→39 | T6（preview 加宽）、T7（index +1）、T10（notespanel +4——比设计多 2 处：单条与批量删除回调钩子） |
| §11 阶段 | P1=T1-3、P2=T4-7、P3=T8-10、P4=T11 |
| §12 已拍板 7 条 | 全节落实；有意的偏离仅两处接口微调（已注明） |

### §6.6 实施补记：长按触觉反馈（第四轮审查 Spec-b1 回填）

长按 ≥400ms 进入拖选时以 `navigator.vibrate?.(8)` 给 8ms 触觉确认（link.js，
try 吞无振动模块的异常）。设计书原无此条款，系实施期加入的真机手感增强——
零依赖（WebView 内建 API 可选链），审查时补记为既定行为。

### §6.6 实施修订：拖选/入选高亮按行统一带（2026-10-07 拍板）

**问题**：拖选实时高亮与入选态原为插在文本项内部的内联背景——pdf.js 给每个
文本项独立 font-size + transform:scale，背景高度随字体盒高低错落，跨字号
混排（标题+正文）观感差；父级缩放继承使纯 CSS 定高也不可统一。

**方案（三项拍板：按行统一带 / 拖选+入选一并 / 琥珀标记不动）**：
- 几何核心抽纯函数 `bands.mjs groupRectsToBands`：按 y 中心贪心聚类成行
  （容差 = max(片高)/2——基线对齐的大小字必同行、相邻等高行必分行），每行
  一条等高带，行高 = 该行最高片段 ×1.12、带中心对齐最高片段中心
- `link.js renderBands`：带 div 渲染进层首 `.lnk-bands` 容器（absolute、
  pointer-events:none）；与文本项同为绝对定位按 DOM 序绘制 → 天然垫在
  琥珀标记之下（链接态优先保持）；.lnk-sel/.lnk-drag 内联标记删除
- **坐标系坑（真机实测）**：Range.getClientRects 的高按未缩放行盒计算
  （pdf.js 大字号+transform 缩放下恒 ~39px 且不分字号），只有 X 字符级可靠
  ——X 取 Range、Y/高取元素 getBoundingClientRect 视觉盒（已含 transform）

**真机验证**：混排页（26/34px 行）拖选跨行 → 双带 29/38px 精确命中设计值、
垂直居中；整句点选带贴合全句；入选态紫带继承同几何；✓ 切换清零无残留。
**已知项（既有 §6.6 兜底残留，非本次引入）**：拖选起点压在行首左缘时锚点
命中兜底可偏置到相邻大字号多行项的行首（终点路径已在 3af43f2 修复），
起点居中无此象——待后续单独修。
**验收方法论**：CDP Input 域（cdp-touch.mjs）坐标是 **CSS 像素**（浏览器
视口系），与 adb input tap 的物理像素制式不同——误用 ×dpr 会把触摸甩到
页边触发原生滚动。
