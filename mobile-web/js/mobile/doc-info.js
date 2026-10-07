// 图书简介卡（设计书 docs/DOC-INFO-DESIGN.md）：点封面/书名 = 安全的一瞥
// （先看后开），点卡内「打开读本」才进阅读；封面三小钮在移动端隐藏
// （CSS），三个动作收进简介卡——动作按钮程序化点击卡内隐藏的原生按钮，
// 打开（含全文命中跳页）/编辑/删除全部复用 app.js 既有业务流，零补丁。
import pdfjsLib from '../pdfjs.js'
import { esc } from '../util.js'
import { docStats } from './doc-info-stats.mjs'
import { makeLru } from './lru-cache.mjs'

const grid = document.getElementById('docGrid')

let dlg = null
let seq = 0                 // 打开序号：异步装载的代数作废（关卡/换书即弃）
let openCard = null         // 当前简介对应的卡元素（动作复用时校验仍在 DOM）
const authorCache = makeLru(12) // docId -> 作者串（''=无/失败；undefined=未缓存）

/* ---- 拦截：捕获相先于 body 委托（冒泡相），stopPropagation 即截断 ---- */
if (grid) {
  grid.addEventListener('click', (e) => {
    // 自家「打开」按钮的程序化点击：放行一次（app.js 的 preview-doc 分支
    // 处理打开与全文命中跳页），避免把简介卡的打开拦回简介卡
    if (window.__docInfoBypass) { window.__docInfoBypass = false; return }
    // 取**最近的** data-action 祖先（与 app.js 委托同纪律）：简介卡的
    // 编辑/删除走程序化点击卡内隐藏原钮，那类点击的最近 action 是
    // edit-doc/del-doc 而非外层封面的 preview-doc——不得误拦（误拦会
    // 杀掉动作点击并把简介卡重开，真机实测定位）
    const nearest = e.target.closest('[data-action]')
    if (!nearest || nearest.dataset.action !== 'preview-doc') return
    const card = nearest.closest('.doc-card')
    if (!card || card.classList.contains('pile-card')) return        // 书堆卡不拦
    if (grid.classList.contains('batch-mode')) return                // 批量：点卡=勾选
    if (!card.querySelector('.doc-cover-ops')) return                // 书脊视图无原钮：保持直开
    e.stopPropagation()
    openInfo(card.dataset.id, card).catch(() => {})
  }, true)
}

/* ---- 简介卡 DOM（懒建一次，内容随开随填） ---- */
function ensureDlg () {
  if (dlg) return
  const wrap = document.createElement('div')
  wrap.innerHTML = `
    <dialog id="docInfoDialog" class="dialog note-editor-dialog doc-info-dialog">
      <div class="doc-info-head">
        <img id="docInfoCover" class="doc-info-cover" alt="" />
        <div class="doc-info-heading">
          <h3 id="docInfoTitle"></h3>
          <div id="docInfoAuthor" class="doc-info-author"></div>
          <div id="docInfoBase" class="doc-info-base"></div>
        </div>
        <button id="btnDocInfoClose" class="btn-ghost" title="关闭">✕</button>
      </div>
      <div id="docInfoMeta" class="doc-info-meta"></div>
      <div id="docInfoStats" class="doc-info-stats"></div>
      <div class="dialog-foot doc-info-foot">
        <button id="btnDocInfoOpen" class="btn-primary doc-info-open">📖 打开读本</button>
        <button id="btnDocInfoEdit" class="doc-info-ico" title="编辑书名/分类/标签" aria-label="编辑">✎</button>
        <button id="btnDocInfoDel" class="doc-info-ico doc-info-del" title="删除本书" aria-label="删除">🗑</button>
      </div>
    </dialog>`
  document.body.appendChild(wrap.firstElementChild)
  dlg = document.getElementById('docInfoDialog')
  dlg.querySelector('#btnDocInfoClose').addEventListener('click', () => dlg.close())
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })
  dlg.querySelector('#btnDocInfoOpen').addEventListener('click', () => act('[data-action="preview-doc"]'))
  dlg.querySelector('#btnDocInfoEdit').addEventListener('click', () => act('[data-action="edit-doc"]'))
  dlg.querySelector('#btnDocInfoDel').addEventListener('click', () => act('[data-action="del-doc"]'))
}

// 动作复用（§2 决策 2/9）：先关卡，再 bypass/直点卡内原钮——编辑对话框、
// 删除确认（含笔记处理勾选）、打开与命中跳页全部走 app.js 原路径
function act (selector) {
  const card = openCard
  dlg.close()
  if (!card || !card.isConnected || !card.querySelector(selector)) {
    window.toast?.('书目已变化，请重试')
    return
  }
  if (selector === '[data-action="preview-doc"]') window.__docInfoBypass = true
  card.querySelector(selector).click()
}

/* ---- 数据装载（库内字段现成；统计三源并行；作者惰性读） ---- */
function fmtSize (bytes) {
  const mb = Number(bytes) / 1048576
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(Number(bytes) / 1024))} KB`
}

function progressText (doc) {
  const pr = doc.progress
  if (!pr || !pr.totalPages || !(pr.page > 1)) return null
  const pct = Math.round((pr.page / pr.totalPages) * 100)
  return pct >= 100 ? '已读完 ✓' : `读到 ${pr.page}/${pr.totalPages} 页（${pct}%）`
}

async function authorOf (docId) {
  const hit = authorCache.get(docId) // ''=已缓存的无/失败，undefined=未缓存
  if (hit !== undefined) return hit
  try {
    const url = await window.solace.getDocUrl(docId)
    const task = pdfjsLib.getDocument({ url })
    const pdf = await task.promise
    // getMetadata 只解析文档信息区（交叉表已随 getDocument 解析），百毫秒级
    const md = await pdf.getMetadata().catch(() => null)
    await pdf.destroy()
    const a = md && md.info && md.info.Author ? String(md.info.Author).trim().slice(0, 60) : ''
    authorCache.set(docId, a)
    return a
  } catch {
    authorCache.set(docId, '') // 失败也缓存：同会话不重试（下一会话再试）
    return ''
  }
}

async function openInfo (docId, card) {
  const mySeq = ++seq
  openCard = card
  ensureDlg()

  const lib = await window.solace.getLibrary()
  if (mySeq !== seq) return
  const doc = lib.documents.find(d => d.id === docId)
  if (!doc) { window.toast?.('书目已变化'); return }

  // 封面缩略直接复用卡上已加载位图（§2 决策 8，零额外 IO）
  const img = card.querySelector('.doc-cover-img')
  dlg.querySelector('#docInfoCover').src = img ? img.src : ''

  dlg.querySelector('#docInfoTitle').textContent = doc.title
  const authorRow = dlg.querySelector('#docInfoAuthor')
  authorRow.textContent = '…' // 在途占位，读到后替换；无/失败则整行隐藏
  // 页数：库内 doc 不存 pages 字段，用进度 totalPages 兜底（读过即有）
  dlg.querySelector('#docInfoBase').textContent =
    `${doc.pages || (doc.progress && doc.progress.totalPages) || '?'} 页 · ${doc.size ? fmtSize(doc.size) : '?'}`
  const catName = (lib.categories || []).find(c => c.id === doc.categoryId)?.name
  const tagName = Object.fromEntries((lib.tags || []).map(t => [t.id, t.name]))
  const tags = (doc.tagIds || []).map(id => tagName[id]).filter(Boolean)
  const pr = progressText(doc)
  dlg.querySelector('#docInfoMeta').innerHTML = [
    `<span class="doc-info-chip">${esc(catName || '未分类')}</span>` +
      tags.map(t => `<span class="doc-info-chip doc-info-tag"># ${esc(t)}</span>`).join(''),
    `添加于 ${esc(String(doc.addedAt || '').slice(0, 10))}` +
      (doc.openCount ? ` · 翻开 ${doc.openCount} 次` : '') +
      (pr ? ` · ${esc(pr)}` : '')
  ].map(s => `<div>${s}</div>`).join('')

  // 统计行先占位（三源并行装载，任一失败按 0 容错）
  dlg.querySelector('#docInfoStats').innerHTML =
    '<span class="doc-info-chip doc-info-num">…</span>'
  // 防重入：openInfo 在途时用户关了再点等交错下 dialog 可能已开，
  // showModal 对已开 dialog 抛 InvalidStateError 会中断内容填充
  if (!dlg.open) dlg.showModal()

  // 全文命中态：主按钮变「打开 · 第 N 页」（页码从命中徽标 title 解析，
  // 解析不到退普通打开——app.js 的 jump 逻辑始终兜底）
  const hitTitle = (card.querySelector('.doc-hit')?.getAttribute('title')) || ''
  const hitPage = Number(hitTitle.match(/第 (\d+) 页/)?.[1]) || 0
  dlg.querySelector('#btnDocInfoOpen').textContent =
    hitPage ? `📖 打开 · 第 ${hitPage} 页` : '📖 打开读本'

  const [links, annos, notes] = await Promise.allSettled([
    window.solace.readNoteLinks(docId),
    window.solace.readAnnotations(docId),
    window.solace.listNotes(docId)
  ])
  // 故障不吞（审查四轮 Standards-6）：装饰性统计降级按 0 显示，但必须留痕——
  // 否则 I/O 故障与「没有记录」在界面上不可区分
  for (const r of [links, annos, notes]) {
    if (r.status === 'rejected') console.warn('doc-info 统计源读取失败：', r.reason)
  }
  if (mySeq !== seq) return
  const st = docStats(links.value, annos.value, notes.value)
  dlg.querySelector('#docInfoStats').innerHTML =
    `<span class="doc-info-chip doc-info-num">🔗 摘录 ${st.excerpts}</span>` +
    `<span class="doc-info-chip doc-info-num">📝 总结 ${st.summaries}</span>` +
    `<span class="doc-info-chip doc-info-num">✎ 批注 ${st.inkPages} 页</span>` +
    `<span class="doc-info-chip doc-info-num">📄 笔记 ${st.notes}</span>`

  const author = await authorOf(docId)
  if (mySeq !== seq) return
  if (author) authorRow.textContent = author
  else authorRow.textContent = ''
}
