// 侧车 JSON（annotations/links）的读取与损坏回退：文件不存在 = 空结构
// （不预建）；损坏/结构非法 = 顺延编号留档（<dir>/<docId>.corrupt-<n>.json；
// rename 失败用已读到的原文落副本兜底）后按空结构继续 + notice，不阻断阅读。
// 并发的第二次损坏读会因文件已被搬走而走「不存在」分支，最坏各自报一次 notice。
// 两个侧车此前各自维护近乎逐字相同的实现——统一到此处，行为逐字对齐。
export async function readSidecarJson ({ fs, path, dir, docId, label, empty, validate }) {
  if (!await fs.exists(path)) return empty()
  const raw = await fs.readFileText(path)
  try {
    const data = JSON.parse(raw)
    validate(data)
    return data
  } catch {
    let n = 1
    while (await fs.exists(`${dir}/${docId}.corrupt-${n}.json`)) n++
    const archive = `${dir}/${docId}.corrupt-${n}.json`
    let archived = false
    try {
      await fs.rename(path, archive)
      archived = true
    } catch {
      // rename 失败（被占用等）：用原文直接落副本兜底，再尽力清主路径——
      // 副本在，后续写回就不会丢掉唯一留档；都失败则 notice 如实说明
      try {
        await fs.writeText(archive, raw)
        archived = true
        await fs.rm(path)
      } catch { /* 留档失败：notice 如实说明，见下方 */ }
    }
    return {
      ...empty(),
      notice: archived
        ? `这本书的${label}数据损坏，已重置；原文件保留为资料库内 ${dir} 下的 .corrupt 备份。`
        : `这本书的${label}数据损坏，已重置；原文件留档失败（文件可能被占用），再次写入将覆盖损坏文件。`
    }
  }
}
