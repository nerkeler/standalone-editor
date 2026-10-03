import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { importZip } from '../src/zipImportService.js'
import { createZip } from './zipFixture.js'

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test('imports UTF-8 stored and deflated Markdown and image entries byte for byte', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-workspace-')
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80, 0x0a])
  const archive = createZip([
    { name: '知识库/概览.md', data: '# 中文标题', method: 0 },
    { name: '图像/照片.png', data: image, method: 8 },
    { name: '.private/hidden.md', data: 'skip me', method: 8 },
    { name: '__MACOSX/._概览.md', data: 'skip me too', method: 0 },
  ])

  const result = await importZip(workspace, archive)

  assert.deepEqual(result, { imported: 2, files: ['知识库/概览.md', '图像/照片.png'], cleanupWarnings: [] })
  assert.equal(await fs.readFile(path.join(workspace, '知识库', '概览.md'), 'utf8'), '# 中文标题')
  assert.deepEqual(await fs.readFile(path.join(workspace, '图像', '照片.png')), image)
  await assert.rejects(fs.lstat(path.join(workspace, '.private')), error => error.code === 'ENOENT')
  await assert.rejects(fs.lstat(path.join(workspace, '__MACOSX')), error => error.code === 'ENOENT')
})

test('rejects traversal and Windows-invalid archive names before writing files', async t => {
  for (const name of ['../escaped.md', 'folder\\escaped.md', 'CON.md']) {
    const workspace = await temporaryDirectory(t, 'standalone-editor-zip-malicious-')
    await assert.rejects(importZip(workspace, createZip([{ name, data: 'unsafe' }])), error => error.code === 'INVALID_ARCHIVE')
    assert.deepEqual(await fs.readdir(workspace), [])
  }
})

test('rejects paths that normalize to the same destination', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-duplicate-')
  const archive = createZip([
    { name: './notes.md', data: 'first' },
    { name: 'notes.md', data: 'second' },
  ])

  await assert.rejects(importZip(workspace, archive), error => error.code === 'CONFLICT')
  assert.deepEqual(await fs.readdir(workspace), [])
})

test('detects corrupted stored-entry CRC before publishing any file', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-crc-')
  const name = 'broken.md'
  const archive = Buffer.from(createZip([{ name, data: 'the payload CRC must match' }]))
  archive[30 + Buffer.byteLength(name)] ^= 0x01

  await assert.rejects(importZip(workspace, archive), error =>
    error.code === 'INVALID_ARCHIVE' && /CRC/.test(error.message))
  assert.deepEqual(await fs.readdir(workspace), [])
})

test('rejects high compression ratios before decompressing a ZIP bomb entry', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-ratio-')
  const archive = createZip([{ name: 'repetitive.md', data: Buffer.alloc(1024 * 1024, 0x41), method: 8 }])

  await assert.rejects(importZip(workspace, archive), error => error.code === 'ZIP_LIMIT')
  assert.deepEqual(await fs.readdir(workspace), [])
})

test('preflights existing targets before creating any imported files or directories', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-conflict-')
  await fs.writeFile(path.join(workspace, 'existing.md'), 'keep')
  const archive = createZip([
    { name: 'new-folder/new.md', data: 'must not be written' },
    { name: 'existing.md', data: 'must not replace' },
  ])

  await assert.rejects(importZip(workspace, archive), error => error.code === 'CONFLICT')
  assert.equal(await fs.readFile(path.join(workspace, 'existing.md'), 'utf8'), 'keep')
  assert.deepEqual(await fs.readdir(workspace), ['existing.md'])
})

test('rejects unsupported general-purpose flags and compression methods', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-flags-')
  for (const flags of [0x0801, 0x0820, 0x2000]) {
    await assert.rejects(importZip(workspace, createZip([{ name: 'flagged.md', data: 'x', flags }])),
      error => error.code === 'INVALID_ARCHIVE')
  }
  await assert.rejects(importZip(workspace, createZip([{ name: 'method.md', data: 'x', method: 12 }])),
    error => error.code === 'INVALID_ARCHIVE' && /12/.test(error.message))

  const validDeflateFlags = createZip([{
    name: 'compressed.md', data: 'deflate level flags are supported', method: 8, flags: 0x0802,
  }])
  const imported = await importZip(workspace, validDeflateFlags)
  assert.deepEqual(imported.files, ['compressed.md'])
  assert.equal(await fs.readFile(path.join(workspace, 'compressed.md'), 'utf8'), 'deflate level flags are supported')
})

test('applies caller-supplied archive, entry, and expanded-size limits', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-limits-')
  const twoEntries = createZip([
    { name: 'one.md', data: '1' },
    { name: 'two.md', data: '2' },
  ])

  await assert.rejects(importZip(workspace, twoEntries, { maxEntries: 1 }), error => error.code === 'ZIP_LIMIT')
  await assert.rejects(importZip(workspace, twoEntries, { maxExpandedBytes: 1 }), error => error.code === 'ZIP_LIMIT')
  await assert.rejects(importZip(workspace, twoEntries, { maxArchiveBytes: twoEntries.length - 1 }), error => error.code === 'ZIP_LIMIT')
  assert.deepEqual(await fs.readdir(workspace), [])
})

test('rolls back an earlier committed file and created directories after a later commit failure', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-rollback-')
  const archive = createZip([
    { name: 'nested/first.md', data: 'first' },
    { name: 'nested/second.md', data: 'second' },
  ])

  await assert.rejects(importZip(workspace, archive, {
    async beforeCommitFile(name) {
      if (name === 'nested/second.md') {
        assert.equal(await fs.readFile(path.join(workspace, 'nested', 'first.md'), 'utf8'), 'first')
        throw new Error('simulated commit failure')
      }
    },
  }), /simulated commit failure/)

  assert.deepEqual(await fs.readdir(workspace), [])
})

test('rollback leaves a concurrent replacement at a committed path untouched', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-rollback-replaced-')
  const archive = createZip([
    { name: 'nested/first.md', data: 'imported' },
    { name: 'nested/second.md', data: 'second' },
  ])

  await assert.rejects(importZip(workspace, archive, {
    async beforeCommitFile(name) {
      if (name === 'nested/second.md') {
        await fs.unlink(path.join(workspace, 'nested', 'first.md'))
        await fs.writeFile(path.join(workspace, 'nested', 'first.md'), 'concurrent replacement')
        throw new Error('injected later failure')
      }
    },
  }), /injected later failure/)

  assert.equal(await fs.readFile(path.join(workspace, 'nested', 'first.md'), 'utf8'), 'concurrent replacement')
})

test('rollback preserves a same-length in-place modification', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-rollback-same-size-')
  const archive = createZip([
    { name: 'first.md', data: 'original' },
    { name: 'second.md', data: 'second' },
  ])

  await assert.rejects(importZip(workspace, archive, {
    async beforeCommitFile(name) {
      if (name === 'second.md') {
        await fs.writeFile(path.join(workspace, 'first.md'), 'modified')
        throw new Error('injected later failure')
      }
    },
  }), /injected later failure/)

  assert.equal(await fs.readFile(path.join(workspace, 'first.md'), 'utf8'), 'modified')
})

test('rollback leaves an identical-content replacement untouched while the anchor pins the original inode', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-rollback-identical-')
  const original = 'same content'
  const archive = createZip([
    { name: 'first.md', data: original },
    { name: 'second.md', data: 'second' },
  ])
  let identityPinned = false

  await assert.rejects(importZip(workspace, archive, {
    async beforeCommitFile(name) {
      if (name === 'second.md') {
        const stagingName = (await fs.readdir(workspace)).find(item => item.endsWith('.staging'))
        assert.ok(stagingName)
        const stagingPath = path.join(workspace, stagingName)
        const anchorName = (await fs.readdir(stagingPath)).find(item => item.startsWith('.rollback-'))
        assert.ok(anchorName)
        const anchorStat = await fs.lstat(path.join(stagingPath, anchorName), { bigint: true })
        await fs.unlink(path.join(workspace, 'first.md'))
        await fs.writeFile(path.join(workspace, 'first.md'), original)
        const replacementStat = await fs.lstat(path.join(workspace, 'first.md'), { bigint: true })
        identityPinned = anchorStat.dev === replacementStat.dev && anchorStat.ino !== replacementStat.ino
        throw new Error('injected later failure')
      }
    },
  }), /injected later failure/)

  assert.equal(identityPinned, true)
  assert.equal(await fs.readFile(path.join(workspace, 'first.md'), 'utf8'), original)
})

test('captures and rolls back the actual partial contents when a write fails', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-rollback-partial-')
  const archive = createZip([{ name: 'partial.md', data: 'complete expected payload' }])

  await assert.rejects(importZip(workspace, archive, {
    async writeFileForTest(handle, content) {
      await handle.write(content.subarray(0, 7), 0, 7, 0)
      throw new Error('injected partial write failure')
    },
  }), /injected partial write failure/)

  assert.deepEqual(await fs.readdir(workspace), [])
})

test('hard-link unavailability does not block a successful import', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-rollback-no-link-success-')
  const archive = createZip([{ name: 'one.md', data: 'one' }])

  const result = await importZip(workspace, archive, {
    async linkForRollbackForTest() {
      const error = new Error('hard links unsupported')
      error.code = 'ENOTSUP'
      throw error
    },
  })

  assert.deepEqual(result, { imported: 1, files: ['one.md'], cleanupWarnings: [] })
  assert.deepEqual(await fs.readdir(workspace), ['one.md'])
})

test('a successful import returns retained staging paths when cleanup cannot unlink them', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-cleanup-warning-')
  const archive = createZip([{ name: '资料/cleanup.md', data: '# 已导入' }])
  const serviceUrl = new URL('../src/zipImportService.js', import.meta.url).href
  const childSource = `
import fs from 'node:fs/promises'
import path from 'node:path'
const workspace = ${JSON.stringify(workspace)}
const realWorkspace = await fs.realpath(workspace)
let injected = false
const originalUnlink = fs.unlink.bind(fs)
fs.unlink = async target => {
  const candidate = String(target)
  if (!injected && candidate.startsWith(realWorkspace + path.sep) && candidate.includes('.staging')) {
    injected = true
    const error = new Error('simulated staging cleanup permission error')
    error.code = 'EACCES'
    throw error
  }
  return originalUnlink(target)
}
const { importZip } = await import(${JSON.stringify(serviceUrl)})
const result = await importZip(workspace, Buffer.from(${JSON.stringify(archive.toString('base64'))}, 'base64'))
console.log(JSON.stringify({ result, injected }))
`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    encoding: 'utf8',
    timeout: 15_000,
  })

  assert.equal(child.status, 0, child.stderr || child.error?.message)
  const output = JSON.parse(child.stdout.trim())
  assert.equal(output.injected, true, 'the isolated cleanup failure should occur in the temporary workspace')
  assert.equal(output.result.imported, 1)
  assert.deepEqual(output.result.files, ['资料/cleanup.md'])
  assert.ok(output.result.cleanupWarnings.length > 0)
  assert.equal(new Set(output.result.cleanupWarnings).size, output.result.cleanupWarnings.length)
  assert.ok(output.result.cleanupWarnings.every(item => !path.isAbsolute(item) && !item.includes('\\')))
  assert.ok(output.result.cleanupWarnings.every(item => item.startsWith('.standalone-editor-import-')))
  for (const warningPath of output.result.cleanupWarnings) {
    await fs.lstat(path.join(workspace, ...warningPath.split('/')))
  }
  assert.equal(await fs.readFile(path.join(workspace, '资料', 'cleanup.md'), 'utf8'), '# 已导入')
})

test('preserves and diagnoses unanchored files when a later commit fails', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-rollback-no-link-failure-')
  const archive = createZip([
    { name: 'first.md', data: 'first' },
    { name: 'second.md', data: 'second' },
  ])

  await assert.rejects(importZip(workspace, archive, {
    async linkForRollbackForTest() {
      const error = new Error('hard links unsupported')
      error.code = 'EPERM'
      throw error
    },
    async beforeCommitFile(name) {
      if (name === 'second.md') throw new Error('injected later failure')
    },
  }), error => {
    assert.match(error.message, /injected later failure/)
    assert.deepEqual(error.rollbackWarnings, ['first.md'])
    assert.match(error.message, /回滚保留了无法确认身份的路径/)
    return true
  })

  assert.equal(await fs.readFile(path.join(workspace, 'first.md'), 'utf8'), 'first')
  await assert.rejects(fs.lstat(path.join(workspace, 'second.md')), error => error.code === 'ENOENT')
  assert.deepEqual((await fs.readdir(workspace)).sort(), ['first.md'])
})

test('staging cleanup preserves unknown concurrent content instead of recursing into it', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-rollback-staging-unknown-')
  const archive = createZip([{ name: 'one.md', data: 'one' }])
  let unexpectedPath

  await assert.rejects(importZip(workspace, archive, {
    async beforeCommitFile() {
      const stagingName = (await fs.readdir(workspace)).find(item => item.endsWith('.staging'))
      unexpectedPath = path.join(workspace, stagingName, 'concurrent.txt')
      await fs.writeFile(unexpectedPath, 'keep concurrent staging content')
    },
  }), /导入目录在操作期间发生变化/)

  assert.equal(await fs.readFile(unexpectedPath, 'utf8'), 'keep concurrent staging content')
  await assert.rejects(fs.lstat(path.join(workspace, 'one.md')), error => error.code === 'ENOENT')
})

test('rollback leaves a replaced import directory untouched', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-directory-replaced-')
  const archive = createZip([
    { name: 'nested/first.md', data: 'imported' },
    { name: 'nested/second.md', data: 'second' },
  ])

  await assert.rejects(importZip(workspace, archive, {
    async beforeCommitFile(name) {
      if (name === 'nested/second.md') {
        await fs.unlink(path.join(workspace, 'nested', 'first.md'))
        await fs.rmdir(path.join(workspace, 'nested'))
        await fs.mkdir(path.join(workspace, 'nested'))
        await fs.writeFile(path.join(workspace, 'nested', 'sentinel.md'), 'concurrent directory')
        throw new Error('injected later failure')
      }
    },
  }), /injected later failure/)

  assert.equal(await fs.readFile(path.join(workspace, 'nested', 'sentinel.md'), 'utf8'), 'concurrent directory')
})

test('import rejects a parent replaced by a symlink before the next commit and avoids unsafe rollback', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-parent-')
  const outside = await temporaryDirectory(t, 'standalone-editor-zip-outside-')
  await fs.writeFile(path.join(outside, 'second.md'), 'outside value')
  const archive = createZip([
    { name: 'folder/first.md', data: 'first' },
    { name: 'folder/second.md', data: 'second' },
  ])

  await assert.rejects(importZip(workspace, archive, {
    async beforeCommitFile(name) {
      if (name === 'folder/second.md') {
        await fs.rename(path.join(workspace, 'folder'), path.join(workspace, 'held'))
        await fs.symlink(outside, path.join(workspace, 'folder'))
      }
    },
  }), error => error.code === 'INVALID_ARCHIVE')

  assert.equal(await fs.readFile(path.join(outside, 'second.md'), 'utf8'), 'outside value')
  assert.equal(await fs.readFile(path.join(workspace, 'held', 'first.md'), 'utf8'), 'first')
})

test('a replaced parent does not stop rollback of independent files or hide the original failure', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const workspace = await temporaryDirectory(t, 'standalone-editor-zip-rollback-parent-isolation-')
  const outside = await temporaryDirectory(t, 'standalone-editor-zip-rollback-parent-outside-')
  const archive = createZip([
    { name: 'folder/first.md', data: 'first' },
    { name: 'safe.md', data: 'safe' },
    { name: 'folder/third.md', data: 'third' },
  ])

  await assert.rejects(importZip(workspace, archive, {
    async beforeCommitFile(name) {
      if (name === 'folder/third.md') {
        await fs.rename(path.join(workspace, 'folder'), path.join(workspace, 'held'))
        await fs.symlink(outside, path.join(workspace, 'folder'))
        throw new Error('original injected failure')
      }
    },
  }), error => {
    assert.match(error.message, /original injected failure/)
    assert.deepEqual(error.rollbackWarnings, ['folder'])
    return true
  })

  assert.equal(await fs.readFile(path.join(workspace, 'held', 'first.md'), 'utf8'), 'first')
  await assert.rejects(fs.lstat(path.join(workspace, 'safe.md')), error => error.code === 'ENOENT')
  assert.deepEqual((await fs.readdir(workspace)).sort(), ['folder', 'held'])
})
