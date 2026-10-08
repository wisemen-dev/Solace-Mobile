// 对话框进出场过渡（UI 优化 A1，2026-10-08）：进场是纯 CSS——dialog[open]
// 的 animation 由 UA 摘挂 open 属性时自动触发，零 JS。退场没有这份便利：
// 原生 close() 立即摘 open，元素瞬间 display:none，退场动画无处附着。
// 故包装 HTMLDialogElement.prototype.close：先播退场（.dlg-leave 类），
// animationend 后再调原生 close。所有关闭路径（按钮 / Esc / Android 返回
// 键经桥的对话框分支 / 代码直调）都汇入 close()，一处包装全局生效。
// 兜底与幂等：animationend 可能因元素重建而不来，150ms 定时器强制收尾；
// 收尾对已关闭的 dialog 再调 close 是 no-op，双触发无害。退场窗口内
// （120ms）若被再次 showModal 会抛 InvalidStateError——doc-info 已有
// 防重入先例，其余弹窗流程均先 close 后再开，窗口极小可接受。
// reduced-motion：不安装包装（直接关），CSS 侧另有跳过块。
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
}

installDialogMotion()
