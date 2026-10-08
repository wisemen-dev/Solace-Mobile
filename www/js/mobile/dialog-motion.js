// 对话框进出场过渡（UI 优化 A1，2026-10-08；审查修复 2026-10-08）：进场
// 是纯 CSS——dialog[open] 的 animation 由 UA 摘挂 open 属性时自动触发，
// 零 JS。退场没有这份便利：原生 close() 立即摘 open，元素瞬间 display:none，
// 退场动画无处附着。故包装 HTMLDialogElement.prototype.close：先播退场
// （.dlg-leave 类），animationend 后再调原生 close。按钮 / Android 返回键
// （桥的对话框分支）/ 代码直调都汇入 close()，一处包装全局生效。
// **Esc 是漏网路径（代码审查发现）**：按 HTML 规范 Esc 走 requestClose →
// cancel 事件 → UA 内部关闭算法，不经过原型 close()。cancel 事件不冒泡，
// 在 document 捕获阶段拦截：preventDefault() 阻止 UA 瞬间关闭，改走
// 包装 close() 播退场——requestClose 的轻量确认流程不受影响（无确认
// 直接关的对话框行为不变）。
// 兜底与幂等：animationend 可能因元素重建而不来，160ms 定时器强制收尾
// （120ms 动画 + 裕量）；收尾对已关闭的 dialog 再调 close 是 no-op，双触发
// 无害。退场窗口内（120ms）若被再次 showModal 会抛 InvalidStateError
// ——doc-info 已有防重入先例，其余弹窗流程均先 close 后再开，窗口极小
// 可接受。reduced-motion：不安装包装（直接关），CSS 侧另有跳过块。
export function installDialogMotion () {
  if (typeof HTMLDialogElement === 'undefined') return // node 测试桩
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const orig = HTMLDialogElement.prototype.close
  if (orig.name === 'solaceWrappedClose') return // 防重复安装
  const wrapped = function (...args) {
    if (!this.open || this.dataset.leaving === '1') return orig.call(this, ...args)
    this.dataset.leaving = '1'
    this.classList.add('dlg-leave')
    let done = false
    const finish = () => {
      if (done) return
      done = true
      this.classList.remove('dlg-leave')
      delete this.dataset.leaving
      orig.call(this, ...args)
    }
    this.addEventListener('animationend', finish, { once: true })
    setTimeout(finish, 160)
  }
  // 具名便于上面的防重复安装判断（minifier 后仍稳定）
  Object.defineProperty(wrapped, 'name', { value: 'solaceWrappedClose' })
  HTMLDialogElement.prototype.close = wrapped
  // Esc/requestClose 路径：捕获相拦 cancel（不冒泡），交给包装 close 走退场
  document.addEventListener('cancel', (e) => {
    const dlg = e.target
    if (dlg instanceof HTMLDialogElement) {
      e.preventDefault()
      dlg.close()
    }
  }, true)
}

installDialogMotion()
