// docId 白名单：notes/<id>/、annotations/<id>.json、links/<id>.json 三处
// 数据层拼路径前的共同守卫（防路径穿越）；入库 id 由 library-core 按严格
// UUID 校验，这里只放宽到路径安全允许的字符集（桌面端同规则）。
export function checkDocId (docId) {
  const s = String(docId || '')
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s)) throw new Error('非法文档标识')
  return s
}
