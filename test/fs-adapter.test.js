import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFsAdapter } from '../bridge/fs-adapter.mjs'
import { createLibrary } from '../bridge/library-core.mjs'
import { createAnnotations } from '../bridge/annotations-core.mjs'

const missing = Object.assign(new Error('does not exist'), { code: 'OS-PLUG-FILE-0008' })
const ioError = Object.assign(new Error('I/O error'), { code: 'OS-PLUG-FILE-0013' })
const ID = '00000000-0000-4000-8000-000000000001'

test('exists 只把明确不存在当 false；磁盘和权限错误必须上抛', async () => {
  for (const err of [missing, ioError, Object.assign(new Error('denied'), { code: 'OS-PLUG-FILE-0007' })]) {
    const fs = createFsAdapter({ filesystem: { stat: async () => { throw err } } })
    if (err === missing) assert.equal(await fs.exists('library.json'), false)
    else await assert.rejects(fs.exists('library.json'), e => e === err)
  }
})

test('stat 失败不得让资料库初始化覆写现有文件', async () => {
  let writes = 0
  const fs = createFsAdapter({ filesystem: {
    mkdir: async () => {},
    stat: async () => { throw ioError },
    writeFile: async () => { writes++ }
  } })
  const lib = createLibrary({ fs })
  await assert.rejects(lib.init(), e => e === ioError)
  assert.equal(writes, 0)
  await assert.rejects(createAnnotations({ fs }).read(ID), e => e === ioError)
})

test('rm 的 stat 故障报告失败，缺失才等价于删除成功', async () => {
  let deletes = 0
  for (const err of [ioError, missing]) {
    const fs = createFsAdapter({ filesystem: {
      stat: async () => { throw err },
      deleteFile: async () => { deletes++ }
    } })
    assert.equal(await fs.rm('annotations/book.json'), err === missing)
  }
  assert.equal(deletes, 0)
})

test('mkdirp 只忽略已存在，写入目录的真故障必须上抛', async () => {
  for (const err of [Object.assign(new Error('exists'), { code: 'OS-PLUG-FILE-0010' }), ioError]) {
    const fs = createFsAdapter({ filesystem: { mkdir: async () => { throw err } } })
    if (err === ioError) await assert.rejects(fs.mkdirp('files'), e => e === err)
    else await fs.mkdirp('files')
  }
})
