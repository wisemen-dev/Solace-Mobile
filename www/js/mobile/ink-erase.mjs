/* 橡皮局部擦拭（矢量切割）——纯函数，可单测。
 *
 * 擦除圆覆盖的采样点剔出，幸存连续段重组为新 stroke（继承
 * tool/color/width/pressure 与 pts 形态：二元组或压感三元组原样切片）。
 * schema 不变、文件不膨胀：不足 2 个采样的孤立短段（单点残端/被隔离的
 * 单点）直接丢弃。命中半径叠加笔宽一半（拍板 2026-10-07）：有效半径
 * = r + stroke.width / 2——轻碰粗荧光笔边缘即可切断，细笔几乎不放大。
 *
 * 返回约定：null = 未命中（原笔不动）；[] = 整笔擦净；否则为幸存段数组。
 */
export function splitStroke (s, cx, cy, r) {
  const stride = s.pressure ? 3 : 2
  const rEff = r + (s.width || 0) / 2
  const r2 = rEff * rEff
  const P = s.pts
  const n = Math.floor(P.length / stride)
  const segs = []
  let erasedAny = false
  let start = -1 // 当前幸存段的首采样下标（采样序 = pts 下标 / stride）

  const pushSeg = (a, b) => { // 幸存区间 [a, b)
    if (b - a < 2) return // 孤立单点/单点残端：丢弃
    segs.push({
      tool: s.tool,
      color: s.color,
      width: s.width,
      pressure: s.pressure,
      pts: P.slice(a * stride, b * stride)
    })
  }
  for (let k = 0; k < n; k++) {
    const x = P[k * stride]
    const y = P[k * stride + 1]
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) {
      erasedAny = true
      if (start >= 0) { pushSeg(start, k); start = -1 }
    } else if (start < 0) start = k
  }
  if (start >= 0) pushSeg(start, n)
  return erasedAny ? segs : null
}
