// 运行真实界面控制器，仅替换浏览器 DOM/计时器和外部依赖；不改写业务函数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createAnnotations } from '../bridge/annotations-core.mjs'
import { createMemFs } from './mem-fs.mjs'
import { generateRecordMd, parseRecordMd } from '../mobile-web/js/mobile/link-md.mjs'
import { splitStroke } from '../mobile-web/js/mobile/ink-erase.mjs'

const ID = '00000000-0000-4000-8000-000000000001'
const layout = { docId: ID, page: 1, w: 100, h: 100, cssW: 100, cssH: 100, baseW: 100, baseH: 100 }
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function uiHarness (name, expose, solace) {
  const elements = new Map()
  class Element {
    constructor (id = '') {
      this.id = id
      this.style = { setProperty () {} }
      this.dataset = {}
      this.value = ''
      this.hidden = false
      this.disabled = false
      this.open = false
      this.listeners = new Map()
      this.classList = { add () {}, remove () {}, toggle () {}, contains: () => false }
    }
    addEventListener (type, fn) {
      const list = this.listeners.get(type) || []
      list.push(fn)
      this.listeners.set(type, list)
    }
    dispatchEvent (event) {
      event.target ||= this
      for (const fn of this.listeners.get(event.type) || []) fn(event)
      return !event.defaultPrevented
    }
    querySelector (selector) { return selector.startsWith('#') ? element(selector.slice(1)) : null }
    querySelectorAll (selector) {
      if (selector === 'textarea, button') {
        const ids = this.id === 'linkRecordDialog'
          ? ['linkRecordText', 'btnLinkEdSave', 'btnLinkEdCancel', 'btnLinkEdClose', 'chipX']
          : ['noteEditorText', 'btnNoteEdSave', 'btnNoteEdCancel', 'btnNoteEdClose']
        return ids.map(element)
      }
      return []
    }
    append () {}
    appendChild (child) { return child }
    get firstElementChild () { return new Element() }
    getContext () { return new Proxy({}, { get: () => () => {} }) }
    getBoundingClientRect () { return { left: 0, top: 0, width: 100, height: 100 } }
    closest () { return null }
    contains () { return false }
    focus () {}
    showModal () { this.open = true }
    close () { this.open = false }
    input (text) {
      if (this.disabled) return
      this.value = text
      this.dispatchEvent({ type: 'input' })
    }
  }
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element(id))
    return elements.get(id)
  }
  const window = new Element()
  window.solace = solace
  window.toast = () => {}
  window.matchMedia = () => ({ matches: false, addEventListener () {} })
  const document = {
    body: new Element(), getElementById: element, createElement: () => new Element(), addEventListener () {},
    querySelector: selector => selector.startsWith('#') ? element(selector.slice(1)) : null
  }
  let timerSeq = 0
  const timers = new Map()
  const context = {
    window, document, console, generateRecordMd, parseRecordMd, splitStroke,
    getStroke: () => [], askConfirm: async () => true, jumpPage () {}, closeNotes () {},
    esc: text => String(text), localStorage: { getItem: () => null, setItem () {} },
    setTimeout: fn => { timers.set(++timerSeq, fn); return timerSeq },
    clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => fn(),
    cancelAnimationFrame: () => {},
    CustomEvent: class {
      constructor (type, options = {}) { this.type = type; Object.assign(this, options) }
      preventDefault () { this.defaultPrevented = true }
    }
  }
  const source = readFileSync(new URL(`../mobile-web/js/mobile/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .+\r?\n/gm, '')
  const api = runInNewContext(`${source}\n;(${expose})`, context)
  return { api, element, context }
}

function inkHarness (solace) {
  return uiHarness('ink', `({
    setup(d) {
      lastLayout = d; active = true;
      layer = document.createElement('div');
      pdfCanvas = staticCv = liveCv = document.createElement('canvas');
      toolbar = document.createElement('div');
      syncBookToDoc(d.docId);
    },
    draw() {
      const e = {pointerId:1, pointerType:'pen', button:0, clientX:10, clientY:10, pressure:0.5, preventDefault(){}};
      onDown(e); onUp(e);
    },
    down(e) { onDown(e) }, move(e) { onMove(e) }, up(e) { onUp(e) },
    pick(t) { setTool(t) },
    undo() { doUndo() }, redo() { doRedo() },
    stack() { return [undoStack.length, redoStack.length] },
    strokes(p = 1) { return ((book.pages[p] || {}).strokes || []) },
    turn(d) { lastLayout = d },
    flushSave, retry() {syncBookToDoc(lastLayout.docId)},
    state() { return {book, dirty, pendingWrite, loadedDoc} }
  })`, solace)
}

const oldStroke = { tool: 'pen', color: '#000000', width: 2, pressure: 0, pts: [1, 1] }
async function annotationStore () {
  const fs = createMemFs()
  const annotations = createAnnotations({ fs })
  await annotations.write(ID, { version: 1, pages: { 1: { w: 100, h: 100, strokes: [oldStroke] } } })
  return { fs, annotations }
}

test('慢读墨迹期间不落笔、不覆盖旧笔，读完后正常追加且不重复', async () => {
  const { annotations } = await annotationStore()
  const gate = deferred()
  let writes = 0
  const { api } = inkHarness({
    readAnnotations: async id => { await gate.promise; return annotations.read(id) },
    writeAnnotations: async (...args) => { writes++; return annotations.write(...args) }
  })
  api.setup(layout)
  await settle()
  api.draw()
  await api.flushSave()
  assert.equal(writes, 0)
  assert.equal((await annotations.read(ID)).pages[1].strokes.length, 1)
  gate.resolve()
  await settle()
  api.draw()
  await api.flushSave()
  const strokes = (await annotations.read(ID)).pages[1].strokes
  assert.equal(strokes.length, 2)
  assert.equal(strokes[0].color, '#000000')
  assert.equal(api.state().book.pages[1].strokes.length, 2)
  assert.equal(api.state().pendingWrite, null)
})

test('墨迹读失败后禁止覆盖，恢复读取并重试后保留旧笔迹', async () => {
  const { annotations } = await annotationStore()
  let fail = true, writes = 0
  const { api } = inkHarness({
    readAnnotations: id => { if (fail) throw new Error('EIO'); return annotations.read(id) },
    writeAnnotations: async (...args) => { writes++; return annotations.write(...args) }
  })
  api.setup(layout)
  await settle()
  api.draw()
  await settle()
  await api.flushSave()
  assert.equal(writes, 0)
  assert.equal((await annotations.read(ID)).pages[1].strokes[0].color, '#000000')
  fail = false
  api.retry()
  await settle()
  api.draw()
  await api.flushSave()
  assert.equal((await annotations.read(ID)).pages[1].strokes.length, 2)
})

test('落笔后未抬手翻页：该笔作废，不得把旧页坐标提交进新页', async () => {
  const { api } = inkHarness({
    readAnnotations: async () => ({ version: 1, pages: {} }),
    writeAnnotations: async () => {}
  })
  api.setup(layout)
  await settle()
  const pen = (x, y) => ({ pointerId: 1, pointerType: 'pen', button: 0, clientX: x, clientY: y, pressure: 0.5, preventDefault () {} })
  api.down(pen(10, 10))
  api.move(pen(15, 15))
  api.turn({ ...layout, page: 2 }) // 另指点底栏翻页：layout 已切新页
  api.move(pen(20, 20))            // 旧代码会把新页坐标混进旧页笔画
  api.up(pen(20, 20))              // 旧代码会把整笔提交进第 2 页
  const st = api.state()
  assert.ok(!st.book.pages[2] || st.book.pages[2].strokes.length === 0)
  assert.ok(!st.dirty) // 作废的笔画不触发保存
})

/* ---- 橡皮局部擦拭（矢量切割，拍板 2026-10-07） ---- */

// 页 1 放一条横线（x=0..150 步进 10，y=50，16 点）与一条不受影响的竖线（x=50, y=10..30）。
// 橡皮默认 14 + 笔宽 1 = 有效半径 15：一刀圆心在线上恰抹掉相邻 3 点
const lineStroke = { tool: 'pen', color: '#000000', width: 2, pressure: 0, pts: Array.from({ length: 16 }, (_, i) => [i * 10, 50]).flat() }
const crossStroke = { tool: 'pen', color: '#111111', width: 2, pressure: 0, pts: [50, 10, 50, 20, 50, 30] }
async function eraseStore () {
  const fs = createMemFs()
  const annotations = createAnnotations({ fs })
  await annotations.write(ID, { version: 1, pages: { 1: { w: 100, h: 100, strokes: [lineStroke, crossStroke] } } })
  return { fs, annotations }
}
const eraserEv = (x, y) => ({ pointerId: 2, pointerType: 'touch', button: 0, clientX: x, clientY: y, preventDefault () {} })

test('橡皮局部擦拭：中段切割成两段、邻笔不受影响、一次手势一条撤销、落盘段数正确', async () => {
  const { annotations } = await eraseStore()
  const { api } = inkHarness({
    readAnnotations: id => annotations.read(id),
    writeAnnotations: (...a) => annotations.write(...a)
  })
  api.setup(layout)
  await settle()
  api.pick('eraser')
  api.down(eraserEv(80, 50)) // 一刀抹掉 x=70/80/90
  api.move(eraserEv(80, 50))
  api.up(eraserEv(80, 50))
  const strokes = api.strokes()
  assert.equal(strokes.length, 3) // 横线切两段 + 竖线原样
  assert.deepEqual(strokes[0].pts, Array.from({ length: 7 }, (_, i) => [i * 10, 50]).flat())      // 0..60
  assert.deepEqual(strokes[1].pts, Array.from({ length: 6 }, (_, i) => [(i + 10) * 10, 50]).flat()) // 100..150
  assert.deepEqual(strokes[2].pts, crossStroke.pts)
  assert.equal(api.stack()[0], 1); assert.equal(api.stack()[1], 0)
  await api.flushSave()
  assert.equal((await annotations.read(ID)).pages[1].strokes.length, 3)
})

test('切割可撤销复原整笔、可重做恢复切割（modify op 引用定位）', async () => {
  const { annotations } = await eraseStore()
  const { api } = inkHarness({
    readAnnotations: id => annotations.read(id),
    writeAnnotations: (...a) => annotations.write(...a)
  })
  api.setup(layout)
  await settle()
  api.pick('eraser')
  api.down(eraserEv(80, 50))
  api.up(eraserEv(80, 50))
  assert.equal(api.strokes().length, 3)
  api.undo()
  const strokes = api.strokes()
  assert.equal(strokes.length, 2)
  assert.deepEqual(strokes[0].pts, lineStroke.pts) // 整笔按原采样复原
  assert.deepEqual(strokes[1].pts, crossStroke.pts)
  api.redo()
  assert.equal(api.strokes().length, 3)
})

test('一次手势多刀只记一条撤销；逐刀撤销回到上一刀结果', async () => {
  const { annotations } = await eraseStore()
  const { api } = inkHarness({
    readAnnotations: id => annotations.read(id),
    writeAnnotations: (...a) => annotations.write(...a)
  })
  api.setup(layout)
  await settle()
  api.pick('eraser')
  api.down(eraserEv(80, 50))  // 第一刀：横线 → 两段（0..60 / 100..150）
  api.move(eraserEv(30, 50))  // 第二刀切左段中部（抹 20/30/40）→ 左段再分两段（同一手势）
  api.up(eraserEv(30, 50))
  assert.equal(api.strokes().length, 4) // 横线三段 + 竖线
  assert.equal(api.stack()[0], 1); assert.equal(api.stack()[1], 0)
  api.undo()
  assert.equal(api.strokes().length, 2) // 整笔复原（一条撤销回到手势前）
})

test('擦除手势中途翻页：已切割保持并补齐记录，新页不再受擦', async () => {
  const { annotations } = await eraseStore()
  const { api } = inkHarness({
    readAnnotations: id => annotations.read(id),
    writeAnnotations: (...a) => annotations.write(...a)
  })
  api.setup(layout)
  await settle()
  api.pick('eraser')
  api.down(eraserEv(80, 50)) // 切了一刀
  api.turn({ ...layout, page: 2 })
  api.move(eraserEv(80, 50)) // 中途翻页：手势中止，已切保持
  api.up(eraserEv(80, 50))
  assert.equal(api.strokes(1).length, 3)
  assert.ok(!api.strokes(2).length)
  assert.equal(api.stack()[0], 1); assert.equal(api.stack()[1], 0) // 补齐一条记录
})

for (const kind of ['mobile', 'link']) {
  function editorHarness (solace) {
    const expose = kind === 'mobile'
      ? '({save:saveEditor,close:requestEditorClose,open(){window.openNoteEditor("doc","note.md","书","原正文")}})'
      : '({save:saveEditor,close:requestEditorClose,open(){ensureEditor();edCtx={mode:"edit",flow:"edit",docId:"doc",file:"note.md",excerpts:[],degraded:false};edDirty=true;edDlg.querySelector("#linkRecordText").value="原正文";edDlg.showModal()}})'
    const harness = uiHarness(kind, expose, solace)
    harness.api.open()
    return { ...harness,
      dlg: harness.element(kind === 'mobile' ? 'noteEditorDialog' : 'linkRecordDialog'),
      text: harness.element(kind === 'mobile' ? 'noteEditorText' : 'linkRecordText')
    }
  }

  test(`${kind} 编辑器保存等待时冻结输入，拦截关闭及重复保存`, async () => {
    const gate = deferred()
    let writes = 0, saved
    const { api, dlg, text } = editorHarness({
      writeNote: async (_id, _file, content) => { writes++; saved = content; await gate.promise },
      setNoteLinkEntry: async () => {}, readNoteLinks: async () => ({ version: 1, records: {} })
    })
    const saving = api.save()
    await settle()
    assert.equal(text.disabled, true)
    text.input('保存期间继续输入')
    assert.equal(text.value, '原正文')
    await api.close()
    assert.equal(dlg.open, true)
    for (const type of ['solace-close-request', 'cancel']) {
      const event = new uiEvent(type)
      assert.equal(dlg.dispatchEvent(event), false)
      assert.equal(dlg.open, true)
    }
    await api.save()
    assert.equal(writes, 1)
    gate.resolve()
    await saving
    assert.equal(saved, '原正文')
    assert.equal(dlg.open, false)
    assert.equal(text.disabled, false)
  })

  test(`${kind} 编辑器写失败保留文本并恢复编辑，可再次保存`, async () => {
    let fail = true, saved
    const { api, dlg, text } = editorHarness({
      writeNote: async (_id, _file, content) => { if (fail) throw new Error('EIO'); saved = content },
      setNoteLinkEntry: async () => {}, readNoteLinks: async () => ({ version: 1, records: {} })
    })
    await api.save()
    assert.equal(dlg.open, true)
    assert.equal(text.disabled, false)
    text.input('重试新正文')
    fail = false
    await api.save()
    assert.equal(saved, '重试新正文')
    assert.equal(dlg.open, false)
  })
}

class uiEvent {
  constructor (type) { this.type = type; this.defaultPrevented = false }
  preventDefault () { this.defaultPrevented = true }
}

/* ===== 摘录记录查看器 + 追加会话（§6.7）===== */

// 追加/查看 harness：直接驱动 link.js 的会话状态（lastLayout/appendTarget/
// selections），绕开选词手势——手势链已有真机验证，这里测数据与流程面
function linkFlowHarness (solace, toasts = []) {
  const harness = uiHarness('link', `({
    setup(d, file) {
      lastLayout = d
      appendTarget = file || null
      window.linkSelecting = true
      ensureTray(); tray.hidden = false
    },
    select(list) { selections = list; trayUpdate() },
    run() { return commitAppend() },
    open(file) { return openViewer(lastLayout.docId, file) },
    state() { return { appendTarget, selecting: window.linkSelecting, saving: appendSaving } }
  })`, solace)
  harness.context.window.toast = (m) => toasts.push(m)
  return harness
}

const OLD = { page: 2, text: '旧句一', hint: { item: 3, char: 0 } }

test('追加会话併入：查重合并 excerpts、重建 md 头、退出选词并重开查看器', async () => {
  const toasts = []
  const a = { page: 3, text: '新句甲', hint: { item: 5, char: 2 } }
  const b = { page: 4, text: '新句乙', hint: { item: 7, char: 1 } }
  let entry = null, wrote = null
  const { api, element } = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: { 'r.md': { excerpts: [OLD] } } }),
    readNote: async () => generateRecordMd([OLD], '原有批注'),
    writeNote: async (_id, _file, text) => { wrote = text },
    setNoteLinkEntry: async (_id, _file, e) => { entry = e }
  }, toasts)
  api.setup({ docId: 'doc', page: 1 }, 'r.md')
  api.select([a, b])
  await api.run()
  await settle()
  assert.equal(entry.excerpts.length, 3)
  assert.equal(entry.excerpts[1].page, a.page)
  assert.equal(entry.excerpts[1].text, a.text)
  assert.equal(entry.excerpts[1].hint.item, a.hint.item)
  assert.equal(entry.excerpts[2].text, b.text)
  assert.equal(wrote, generateRecordMd([OLD, a, b], '原有批注'))
  const st = api.state()
  assert.equal(st.appendTarget, null) // 会话结束
  assert.equal(st.selecting, false)
  assert.equal(element('linkViewDialog').open, true) // 併入后重开查看器
  assert.ok(toasts.some(t => t.includes('已追加 2 处')))
})

test('追加查重：相同选区（页+文字+起点）跳过；全重复不写盘且留在选词', async () => {
  const dup = { page: 2, text: '旧句一', hint: { item: 3, char: 0 } }
  const novo = { page: 9, text: '全新句', hint: { item: 1, char: 0 } }
  let wrote = 0, entry = null
  const { api } = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: { 'r.md': { excerpts: [OLD] } } }),
    readNote: async () => generateRecordMd([OLD], ''),
    writeNote: async () => { wrote++ },
    setNoteLinkEntry: async (_id, _file, e) => { entry = e }
  })
  api.setup({ docId: 'doc', page: 1 }, 'r.md')
  api.select([dup, novo])
  await api.run()
  assert.equal(entry.excerpts.length, 2) // 旧 + 仅新句（dup 跳过）
  assert.equal(wrote, 1)

  const toasts2 = []
  let wrote2 = 0, entry2 = null
  const h2 = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: { 'r.md': { excerpts: [OLD] } } }),
    readNote: async () => generateRecordMd([OLD], ''),
    writeNote: async () => { wrote2++ },
    setNoteLinkEntry: async (_id, _file, e) => { entry2 = e }
  }, toasts2)
  h2.api.setup({ docId: 'doc', page: 1 }, 'r.md')
  h2.api.select([dup])
  await h2.api.run()
  assert.equal(wrote2, 0)
  assert.equal(entry2, null)
  assert.equal(h2.api.state().appendTarget, 'r.md') // 留在选词可换选
  assert.ok(toasts2.some(t => t.includes('均已在该记录中')))
})

test('降级追加：md 被外部改过则原样不动，仅写侧车（新旧合并）', async () => {
  const novo = { page: 8, text: '降级新句', hint: { item: 2, char: 0 } }
  let wrote = 0, entry = null
  const { api } = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: { 'r.md': { excerpts: [OLD] } } }),
    readNote: async () => '# 被桌面手改的全文',
    writeNote: async () => { wrote++ },
    setNoteLinkEntry: async (_id, _file, e) => { entry = e }
  })
  api.setup({ docId: 'doc', page: 1 }, 'r.md')
  api.select([novo])
  await api.run()
  assert.equal(wrote, 0) // md 不重写
  assert.equal(entry.excerpts.length, 2) // 侧车仍合并
  assert.equal(entry.excerpts[1].text, novo.text)
  assert.equal(entry.excerpts[1].hint.item, novo.hint.item)
})

test('追加目标记录消失：不写盘、toast 说明并退出会话', async () => {
  const toasts = []
  let wrote = 0, entry = null
  const { api } = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: {} }),
    readNote: async () => '',
    writeNote: async () => { wrote++ },
    setNoteLinkEntry: async (_id, _file, e) => { entry = e }
  }, toasts)
  api.setup({ docId: 'doc', page: 1 }, 'r.md')
  api.select([{ page: 1, text: '句', hint: { item: 0, char: 0 } }])
  await api.run()
  assert.equal(wrote, 0)
  assert.equal(entry, null)
  assert.equal(api.state().appendTarget, null)
  assert.ok(toasts.some(t => t.includes('记录已不存在')))
})

test('追加保存等待期间托盘冻结；写失败留在选词，重试幂等成功', async () => {
  const gate = deferred()
  const toasts = []
  const novo = { page: 6, text: '失败重试句', hint: { item: 4, char: 0 } }
  let fail = true, entry = null
  const { api, element } = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: { 'r.md': { excerpts: [OLD] } } }),
    readNote: async () => generateRecordMd([OLD], ''),
    writeNote: async () => { if (fail) throw new Error('EIO'); await gate.promise },
    setNoteLinkEntry: async (_id, _file, e) => { entry = e }
  }, toasts)
  api.setup({ docId: 'doc', page: 1 }, 'r.md')
  api.select([novo])
  await api.run() // 首次：写失败
  assert.ok(toasts.some(t => t.includes('追加失败')))
  assert.equal(api.state().appendTarget, 'r.md') // 留在选词
  assert.equal(element('btnLinkDone').disabled, false) // 按钮已恢复（可重试）
  fail = false
  const ran = api.run() // 重试：writeNote 挂在 gate 上 → 冻结窗口打开
  await settle()
  assert.equal(element('btnLinkDone').disabled, true)
  assert.equal(element('btnLinkCancel').disabled, true)
  gate.resolve()
  await ran
  assert.equal(entry.excerpts.length, 2) // 重试合并成功
  assert.equal(api.state().appendTarget, null)
})

test('查看器：填标题/只读 chips/正文；降级显示提示与原文', async () => {
  const ex = [{ page: 3, text: '查看句一' }, { page: 5, text: '查看句二' }]
  const { api, element } = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: { 'v.md': { excerpts: ex } } }),
    readNote: async () => generateRecordMd(ex, '查看正文')
  })
  api.setup({ docId: 'doc', page: 1 })
  await api.open('v.md')
  assert.equal(element('linkViewDialog').open, true)
  assert.ok(element('linkViewTitle').textContent.includes('v'))
  assert.equal(element('linkViewBody').textContent, '查看正文')
  assert.ok(element('linkViewChips').innerHTML.includes('第 3 页'))
  assert.ok(element('linkViewChips').innerHTML.includes('查看句二'))

  const h2 = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: { 'v.md': { excerpts: ex } } }),
    readNote: async () => '# 手改过的全文'
  })
  h2.api.setup({ docId: 'doc', page: 1 })
  await h2.api.open('v.md')
  assert.equal(h2.element('linkViewBody').textContent, '# 手改过的全文')
  assert.ok(h2.element('linkViewChips').innerHTML.includes('已被外部修改'))
})

test('查看器打开期间记录被删（cache 刷新后无条目）：toast 不开窗', async () => {
  const toasts = []
  const { api, element } = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: {} }),
    readNote: async () => ''
  }, toasts)
  api.setup({ docId: 'doc', page: 1 })
  await api.open('gone.md')
  assert.equal(element('linkViewDialog').open, false)
  assert.ok(toasts.some(t => t.includes('记录已不存在')))
})

test('查看器删除：确认后 trashNote + 关窗 + toast（§6.7 生命线）', async () => {
  const ex = [{ page: 3, text: '待删句' }]
  const toasts = []
  let trashed = null
  const { api, element } = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: { 'r.md': { excerpts: ex } } }),
    readNote: async () => generateRecordMd(ex, '正文'),
    trashNote: async (id, file) => { trashed = { id, file } }
  }, toasts)
  api.setup({ docId: 'doc', page: 1 })
  await api.open('r.md')
  assert.equal(element('linkViewDialog').open, true)
  element('btnLinkViewDelete').dispatchEvent({ type: 'click' })
  await settle()
  assert.deepEqual(trashed, { id: 'doc', file: 'r.md' })
  assert.equal(element('linkViewDialog').open, false)
  assert.ok(toasts.some(t => t.includes('记录已删除')))
})

test('查看器删除：确认框取消则不动数据、查看器留在原地', async () => {
  const ex = [{ page: 3, text: '保留句' }]
  const { api, element, context } = linkFlowHarness({
    readNoteLinks: async () => ({ version: 1, records: { 'r.md': { excerpts: ex } } }),
    readNote: async () => generateRecordMd(ex, '正文'),
    trashNote: async () => { throw new Error('不应被调用') }
  })
  context.askConfirm = async () => null // 用户取消确认
  api.setup({ docId: 'doc', page: 1 })
  await api.open('r.md')
  element('btnLinkViewDelete').dispatchEvent({ type: 'click' })
  await settle()
  assert.equal(element('linkViewDialog').open, true)
  assert.equal(element('btnLinkViewDelete').disabled, false)
})
