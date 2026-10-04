// 借预览页码输入框回车跳页：preview.js 在 #pageJump 的 keydown 里做
// jumpTo（同页早退、触发重渲染）。合成事件 = 复用既有跳页链路，
// ink 的「撤销目标页非当前页时跳过去」与摘录的「列表跳回定位」共用。
export function jumpPage (page) {
  const input = document.getElementById('pageJump')
  if (!input) return false
  input.value = String(page)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return true
}
