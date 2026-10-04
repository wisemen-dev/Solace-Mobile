// 运行真实界面控制器，仅替换浏览器 DOM/计时器和外部依赖；不改写业务函数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createAnnotations } from '../bridge/annotations-core.mjs'
import { createMemFs } from './mem-fs.mjs'
import { generateRecordMd, parseRecordMd } from '../mobile-web/js/mobile/link-md.mjs'

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
    window, document, console, generateRecordMd, parseRecordMd,
    getStroke: () => [], askConfirm: async () => true, jumpPage () {}, closeNotes () {},
    esc: text => String(text), localStorage: { getItem: () => null, setItem () {} },
    setTimeout: fn => { timers.set(++timerSeq, fn); return timerSeq },
    clearTimeout: id => timers.delete(id), requestAnimationFrame: fn => fn(),
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
