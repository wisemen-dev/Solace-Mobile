// 数据层移植版的回归测试：注入内存 fs，验证与桌面端对齐的关键行为。
// 对应桌面端 test/library.test.js 的核心用例子集 + 移植特有差异点。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLibrary } from '../bridge/library-core.mjs'
import { createNotes } from '../bridge/notes-core.mjs'
import { bytesToBase64, base64ToBytes } from '../bridge/base64.mjs'
import { createMemFs } from './mem-fs.mjs'

// 与 bridge/sha256.mjs 同实现（Node 24 的 webcrypto）
const realSha = async (bytes) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', arr)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
let uuidSeq = 0
const nextUuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`

// 可控时钟：按天立账的统计需要确定的时间
function createHarness ({ time = new Date('2026-09-26T10:00:00'), fs } = {}) {
  const store = fs || createMemFs()
  let tick = time.getTime()
  const lib = createLibrary({ fs: store, sha256: realSha, randomUUID: nextUuid, now: () => new Date(tick) })
  return {
    fs: store, lib,
    advanceDays (d) { tick += d * 86400000 }
  }
}

const PDF_A = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]) // %PDF..

/* ---- 生命周期与导入 ---- */

test('init 首次运行建立空库并落盘 library.json', async () => {
  const { fs, lib } = createHarness()
  await lib.init()
  const data = lib.getData()
  assert.equal(data.documents.length, 0)
  assert.ok(await fs.exists('library.json'))
  assert.ok(await fs.exists('files'))
  assert.ok(await fs.exists('covers'))
  assert.ok(await fs.exists('textindex'))
  assert.equal(data.settings.theme, 'auto')
})

test('importWith：注入原生式复制（内容不过 JS）的去重、落库与串行化', async () => {
  const { lib } = createHarness()
  await lib.init()
  const hash = await realSha(PDF_A)
  const copies = []
  const perform = async (dest) => { copies.push(dest) }
  const doc = await lib.importWith({ fileName: '原生导入.pdf', size: PDF_A.length, hash }, perform)
  assert.equal(copies.length, 1)
  assert.equal(copies[0], `files/${doc.id}.pdf`, '复制目标必须是预分配的库内路径')
  assert.equal(doc.hash, hash)
  // 同内容再导入：命中去重，performCopy 不应被调用
  await assert.rejects(
    () => lib.importWith({ fileName: '再来.pdf', size: PDF_A.length, hash }, perform),
    (err) => err.duplicate && err.duplicate.docId === doc.id
  )
  assert.equal(copies.length, 1)
  // 非法输入拒绝
  await assert.rejects(() => lib.importWith({ fileName: 'a.pdf', size: 1 }, perform), /哈希/)
  await assert.rejects(() => lib.importWith({ fileName: 'a.txt', size: 1, hash }, perform), /仅支持 PDF/)
})

test('importVia：暂存管线——哈希与复制同源、去重删暂存、转正为正式副本', async () => {
  const { fs, lib } = createHarness()
  await lib.init()
  const B = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
  const hashOf = async (bytes) => {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', arr)
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  }
  const simulate = async (staging, bytes) => {
    await fs.writeB64(staging, bytesToBase64(bytes))
    return { hash: await hashOf(bytes), size: bytes.length }
  }
  const doc = await lib.importVia({ fileName: '暂存.pdf' }, (staging) => simulate(staging, B))
  assert.ok(await fs.exists(`files/${doc.id}.pdf`), '暂存已转正为正式副本')
  assert.equal(doc.hash, await hashOf(B))
  assert.equal(doc.size, B.length)
  // 同内容再导入：暂存被删除，库内无残留
  await assert.rejects(
    () => lib.importVia({ fileName: '重复.pdf' }, (staging) => simulate(staging, B)),
    (err) => !!err.duplicate
  )
  let left = (await fs.readdir('files')).filter(e => APP_STAGING_NAME(e.name))
  assert.equal(left.length, 0, '去重路径不应留下暂存文件')
  // 崩溃残留的暂存副本由启动清扫回收（点前缀命名，用户文件不可能撞上）
  await fs.writeB64('files/.incoming-00000000-0000-4000-8000-000000000abc.pdf', 'AAAA')
  const lib2 = createLibrary({ fs, sha256: realSha, randomUUID: nextUuid, now: () => new Date() })
  await lib2.init()
  left = (await fs.readdir('files')).filter(e => APP_STAGING_NAME(e.name))
  assert.equal(left.length, 0, '启动清扫应清掉 .incoming- 残留')
})

function APP_STAGING_NAME (name) {
  return /^\.incoming-[0-9a-f-]{36}\.pdf$/i.test(name)
}

test('导入落库失败：条目回滚、副本清除，不留半截状态给清扫', async () => {
  const base = createMemFs()
  let failLibraryWrites = false
  const fs = {
    ...base,
    async writeFileAtomicText (p, text) {
      if (failLibraryWrites && p === 'library.json') throw new Error('磁盘写入失败（模拟）')
      return base.writeFileAtomicText(p, text)
    }
  }
  const lib = createLibrary({ fs, sha256: realSha, randomUUID: nextUuid, now: () => new Date('2026-09-26T10:00:00') })
  await lib.init()
  failLibraryWrites = true
  await assert.rejects(
    () => lib.importFile({ fileName: '失败.pdf', size: PDF_A.length, bytes: PDF_A }),
    /磁盘写入失败/
  )
  assert.equal(lib.getData().documents.length, 0, '失败条目不得留在内存库')
  assert.equal((await base.readdir('files')).length, 0, '副本必须清掉（与桌面 importPdfLocked 同法）')
  failLibraryWrites = false
  const doc = await lib.importFile({ fileName: '重试.pdf', size: PDF_A.length, bytes: PDF_A })
  assert.ok(doc.id, '故障排除后可正常导入')
})

test('importFile 入库、去重、写副本；removeDoc 连带清理', async () => {
  const { fs, lib } = createHarness()
  await lib.init()
  const doc = await lib.importFile({ fileName: 'Rust 程序设计.pdf', size: PDF_A.length, bytes: PDF_A })
  assert.equal(doc.title, 'Rust 程序设计')
  assert.equal(doc.originalPath, null)
  assert.ok(await fs.exists(`files/${doc.id}.pdf`))

  // 内容重复被拒，duplicate 信息齐全
  await assert.rejects(
    () => lib.importFile({ fileName: '另一本.pdf', size: PDF_A.length, bytes: PDF_A }),
    (err) => err.duplicate && err.duplicate.docId === doc.id
  )
  // 内容不同才算两本书
  const doc2 = await lib.importFile({ fileName: '别的书.pdf', size: 7, bytes: new Uint8Array([9, 9, 9, 9, 9, 9, 9]) })
  assert.equal(lib.getData().documents.length, 2)

  const out = await lib.removeDoc(doc2.id)
  assert.equal(out.title, '别的书')
  assert.deepEqual(out.leftovers, [])
  assert.equal(lib.getData().documents.length, 1)
  assert.equal(await fs.exists(`files/${doc2.id}.pdf`), false)
})

test('旧库条目缺 hash：导入同内容文件时现算回填并判重', async () => {
  const { fs, lib } = createHarness()
  await lib.init()
  // 先正常导入一本，再手工抹掉 hash 模拟桌面端 0.9.x 旧库
  const doc = await lib.importFile({ fileName: '旧书.pdf', size: PDF_A.length, bytes: PDF_A })
  const raw = JSON.parse(await fs.readFileText('library.json'))
  delete raw.documents[0].hash
  await fs.writeFileAtomicText('library.json', JSON.stringify(raw))

  const lib2 = createLibrary({ fs, sha256: realSha, randomUUID: nextUuid, now: () => new Date() })
  await lib2.init()
  await assert.rejects(
    () => lib2.importFile({ fileName: '重导.pdf', size: PDF_A.length, bytes: PDF_A }),
    (err) => !!err.duplicate
  )
  // 回填后的 hash 已落库
  assert.ok(lib2.getData().documents[0].hash)
})

test('library.json 损坏：改名留档重建空库，files/ 副本不被清扫', async () => {
  const fs = createMemFs()
  const make = (t) => createLibrary({ fs, sha256: realSha, randomUUID: nextUuid, now: () => t })
  const lib = make(new Date('2026-09-26T10:00:00'))
  await lib.init()
  const doc = await lib.importFile({ fileName: '书.pdf', size: PDF_A.length, bytes: PDF_A })
  // 写一份缺 documents 集合的「合法 JSON 坏库」
  await fs.writeFileAtomicText('library.json', JSON.stringify({ version: 1, tags: [] }))

  const second = make(new Date('2026-09-26T11:00:00'))
  await second.init()
  assert.equal(second.getData().documents.length, 0)
  assert.ok(second.getStartupNotice(), '应给出损坏告示')
  assert.ok(await fs.exists('library.json.corrupt'), '坏文件留档')
  assert.ok(await fs.exists(`files/${doc.id}.pdf`), '孤儿清扫被跳过，副本保留')
})

test('文档条目缺 id：按损坏处理，files/ 副本不被清扫', async () => {
  const fs = createMemFs()
  const make = (t) => createLibrary({ fs, sha256: realSha, randomUUID: nextUuid, now: () => t })
  const lib = make(new Date('2026-09-26T10:00:00'))
  await lib.init()
  const doc = await lib.importFile({ fileName: '书.pdf', size: PDF_A.length, bytes: PDF_A })
  // 手工抹掉条目 id（模拟人工编辑 / 半还原的备份）：合法 JSON 但清扫失去比对基准
  const raw = JSON.parse(await fs.readFileText('library.json'))
  delete raw.documents[0].id
  await fs.writeFileAtomicText('library.json', JSON.stringify(raw))

  const second = make(new Date('2026-09-26T11:00:00'))
  await second.init()
  assert.ok(second.getStartupNotice(), '缺 id 必须判为损坏（否则清扫会把副本全删）')
  assert.ok(await fs.exists('library.json.corrupt'), '坏库留档')
  assert.ok(await fs.exists(`files/${doc.id}.pdf`), '清扫被跳过，副本保留')
})

test('损坏备份重名自动编号：第二次损坏不覆盖上一份', async () => {
  const fs = createMemFs()
  const make = () => createLibrary({ fs, sha256: realSha, randomUUID: nextUuid, now: () => new Date('2026-09-26T10:00:00') })
  await make().init()
  await fs.writeFileAtomicText('library.json', '{ 坏一次')
  await make().init()
  await fs.writeFileAtomicText('library.json', '{ 坏两次')
  await make().init()
  assert.ok(await fs.exists('library.json.corrupt'))
  assert.ok(await fs.exists('library.json.corrupt.1'), '重名时应顺延编号')
})

test('library.json 读取失败（瞬时错误）：init 上抛，不误判损坏', async () => {
  const base = createMemFs()
  await base.writeText('library.json', JSON.stringify({ version: 1, documents: [], categories: [], tags: [] }))
  const fs = {
    ...base,
    async readFileText (p) {
      if (p === 'library.json') throw new Error('EIO: 读取失败（模拟磁盘/权限异常）')
      return base.readFileText(p)
    }
  }
  const lib = createLibrary({ fs, sha256: realSha, randomUUID: nextUuid, now: () => new Date() })
  await assert.rejects(() => lib.init(), /EIO/)
  assert.ok(await base.exists('library.json'), '完好库文件不得被改名')
  assert.equal(await base.exists('library.json.corrupt'), false)
})

/* ---- 分类树 ---- */

test('分类树：建子分类、换父成环拦截、删除上移', async () => {
  const { lib } = createHarness()
  await lib.init()
  const a = await lib.addCategory('A')
  const b = await lib.addCategory('B')
  const a1 = await lib.addCategory('A1', a.id)
  await assert.rejects(() => lib.moveCategory(a.id, a1.id), /子分类/)
  await lib.moveCategory(b.id, a.id)
  assert.equal(lib.getData().categories.find(c => c.id === b.id).parentId, a.id)
  // 删除 A：A1 与 B 上移到顶级
  await lib.removeCategory(a.id)
  const data = lib.getData()
  assert.equal(data.categories.length, 2)
  for (const c of data.categories) assert.equal(c.parentId, null)
})

/* ---- 足迹与进度 ---- */

test('markOpened 按天立账，getOpenStats 窗口统计正确', async () => {
  const { lib, advanceDays } = createHarness()
  await lib.init()
  const doc = await lib.importFile({ fileName: '统计.pdf', size: PDF_A.length, bytes: PDF_A })
  await lib.markOpened(doc.id)
  await lib.markOpened(doc.id, 'read')
  advanceDays(3)
  await lib.markOpened(doc.id)
  advanceDays(10)
  await lib.markOpened(doc.id)
  const s = lib.getOpenStats()
  assert.equal(s.opens7d, 1)
  assert.equal(s.opens30d, 4) // +0d×2、+3d×1、+13d×1 全部落在 30 天窗口内
  const d = lib.getData().documents[0]
  assert.equal(d.openCount, 4)
  assert.ok(lib.getData().history.some(h => h.type === 'read'))
})

test('setProgress 记录并夹取越界页码', async () => {
  const { lib } = createHarness()
  await lib.init()
  const doc = await lib.importFile({ fileName: '进度.pdf', size: PDF_A.length, bytes: PDF_A })
  await lib.setProgress(doc.id, 5, 100)
  await lib.setProgress(doc.id, 999, 100)
  assert.equal(lib.getData().documents[0].progress.page, 100)
  await lib.setProgress(doc.id, 0, 100)
  assert.equal(lib.getData().documents[0].progress.page, 100, '非法页码不覆盖已有进度')
})

/* ---- 封面与全文索引 ---- */

test('封面：setCover 落盘、getCoverDataUrl 读回、非图片数据拒绝', async () => {
  const { lib } = createHarness()
  await lib.init()
  const doc = await lib.importFile({ fileName: '封面.pdf', size: PDF_A.length, bytes: PDF_A })
  const b64 = bytesToBase64(new Uint8Array([1, 2, 3, 4]))
  await lib.setCover(doc.id, `data:image/jpeg;base64,${b64}`)
  assert.ok(lib.getData().documents[0].hasCover)
  assert.equal(await lib.getCoverDataUrl(doc.id), `data:image/jpeg;base64,${b64}`)
  await assert.rejects(() => lib.setCover(doc.id, 'not-a-dataurl'), /无效的封面/)
})

test('全文索引：setTextIndex/searchTextIndex 命中首个页码；删书清 meta', async () => {
  const { lib } = createHarness()
  await lib.init()
  const doc = await lib.importFile({ fileName: '全文.pdf', size: PDF_A.length, bytes: PDF_A })
  await lib.setTextIndex(doc.id, {
    pages: ['目录', '第一章 rust 所有权', '第二章 生命周期'],
    ver: 2
  })
  const status = await lib.getTextIndexStatus()
  assert.equal(status[doc.id].ver, 2)
  const hits = await lib.searchTextIndex('生命周期')
  assert.equal(hits[doc.id], 3)
  // 归一化：带空格与大小写的关键词同样命中
  assert.equal((await lib.searchTextIndex('Rust  '))[doc.id], 2)
  await lib.removeDoc(doc.id)
  assert.equal((await lib.getTextIndexStatus())[doc.id], undefined)
})

test('桌面端旧版单文件索引自动搬迁为分片', async () => {
  const { fs, lib } = createHarness()
  await lib.init()
  const doc = await lib.importFile({ fileName: '旧索引.pdf', size: PDF_A.length, bytes: PDF_A })
  // 模拟 0.15.x 桌面端的 textindex.json
  await fs.writeText('textindex.json', JSON.stringify({
    [doc.id]: { pages: ['老正文'], ver: 1, at: '2025-01-01T00:00:00Z' }
  }))
  const lib2 = createLibrary({ fs, sha256: realSha, randomUUID: nextUuid, now: () => new Date() })
  await lib2.init()
  const status = await lib2.getTextIndexStatus()
  assert.equal(status[doc.id].ver, 1)
  const hits = await lib2.searchTextIndex('老正文')
  assert.equal(hits[doc.id], 1)
  assert.equal(await fs.exists('textindex.json'), false)
  assert.ok(await fs.exists('textindex.json.migrated'))
})

test('旧版单文件索引搬迁：非法 id 键跳过，不写出库外路径', async () => {
  const { fs, lib } = createHarness()
  await lib.init()
  const doc = await lib.importFile({ fileName: '合法.pdf', size: PDF_A.length, bytes: PDF_A })
  await fs.writeText('textindex.json', JSON.stringify({
    [doc.id]: { pages: ['正文'], ver: 1 },
    '../../evil': { pages: ['注入'] }
  }))
  const lib2 = createLibrary({ fs, sha256: realSha, randomUUID: nextUuid, now: () => new Date() })
  await lib2.init()
  const status = await lib2.getTextIndexStatus()
  assert.equal(Object.keys(status).length, 1, '非法 id 键应被跳过')
  assert.ok(status[doc.id])
  assert.equal([...fs.files.keys()].some(k => k.includes('..')), false, '不得通过 id 写出库外路径')
})

/* ---- 设置白名单 ---- */

test('updateSettings 白名单收敛：非法枚举拒绝、数值下界卡住', async () => {
  const { lib } = createHarness()
  await lib.init()
  const s = await lib.updateSettings({ theme: 'pink', viewMode: 'spine', dormantDays: 0, indexPageLimit: 300 })
  assert.equal(s.theme, 'auto', '非法枚举被拒，保留原值')
  assert.equal(s.viewMode, 'spine')
  assert.equal(s.dormantDays, undefined, '低于下界被拒')
  assert.equal(s.indexPageLimit, 300)
  // 库文件里同样没有非法值
  assert.equal(lib.getData().settings.viewMode, 'spine')
  assert.equal('theme' in lib.getData().settings && lib.getData().settings.theme, 'auto')
  // 平板端新增键（SAF 目录与 Olib 包名）按字符串白名单收纳入库
  const s2 = await lib.updateSettings({ watchTreeUri: 'content://tree/xyz', watchFolderName: 'olib', externalToolPackage: 'com.open_library.app' })
  assert.equal(s2.watchTreeUri, 'content://tree/xyz')
  assert.equal(s2.externalToolPackage, 'com.open_library.app')
})

/* ---- 笔记 ---- */

test('笔记：create 模板/list 排序/write 读回/trash 删除与路径防御', async () => {
  const fs = createMemFs()
  const notes = createNotes({ fs, now: () => new Date('2026-09-26T09:08:07') })
  const id = '00000000-0000-4000-8000-000000000001'
  await notes.create(id, { title: '书名', page: 12, total: 300 })
  await new Promise(r => setTimeout(r, 5)) // 文件名含秒，隔 5ms 保证不撞名
  await notes.create(id, { title: '书名' })
  const { notes: list } = await notes.list(id)
  assert.equal(list.length, 2)
  assert.match(list[0].file, /\.md$/)
  const content = await notes.read(id, list[0].file)
  assert.match(content, /# 《书名》笔记/)
  assert.match(content, /第 12 \/ 300 页/)
  await notes.write(id, list[0].file, content + '\n追加')
  assert.match(await notes.read(id, list[0].file), /追加/)
  await notes.trash(id, list[0].file)
  assert.equal((await notes.list(id)).notes.length, 1)
  // 路径穿越防御
  await assert.rejects(() => notes.read(id, '../library.json'), /非法/)
  await assert.rejects(() => notes.list('bad/id'), /非法/)
})

test('笔记并发新建（同秒双击）：文件名顺延，不互相覆盖', async () => {
  const fs = createMemFs()
  const notes = createNotes({ fs, now: () => new Date('2026-09-26T09:08:07') }) // 固定时钟：两次同秒
  const id = '00000000-0000-4000-8000-000000000001'
  const [a, b] = await Promise.all([notes.create(id, { title: '书' }), notes.create(id, { title: '书' })])
  assert.notEqual(a.file, b.file, '同秒并发必须得到两个不同文件名')
  assert.equal((await notes.list(id)).notes.length, 2)
})

/* ---- base64 往返（桥内自实现，两端一致性关键） ---- */

test('base64：随机字节往返无损（与 WebView/native 传输链路同构）', async () => {
  const lens = [0, 1, 2, 3, 4, 5, 255, 4096, 65536]
  for (const len of lens) {
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256)
    const round = base64ToBytes(bytesToBase64(bytes))
    assert.equal(round.length, len)
    for (let i = 0; i < len; i++) assert.equal(round[i], bytes[i])
  }
})
