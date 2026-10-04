// 原生操作故障与“不存在”必须区分，不能把权限/磁盘异常当成空库。
export function isNotFoundError (err) {
  if (err?.code) return err.code === 'OS-PLUG-FILE-0008' || err.code === 'ENOENT'
  return /does not exist|ENOENT|no such/i.test(String(err?.message || err || ''))
}
