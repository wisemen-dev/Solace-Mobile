// promise 串行队列：任务按调用顺序排队执行（队列内不并发），读改写/写串行
// 场景防交错；链自身吞错（一个失败不卡死后续任务），失败经 run 返回的
// Promise 向调用方传播。
export function createSerialQueue () {
  let tail = Promise.resolve()
  return {
    run (fn) {
      const p = tail.then(fn)
      tail = p.then(() => {}, () => {})
      return p
    },
    // 队列当前尾部（错误已吞）：await settled() = 等全部在途任务结算。
    // 读排队于写链尾（不读旧态）的场景用它
    settled () {
      return tail
    }
  }
}
