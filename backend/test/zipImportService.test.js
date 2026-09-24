import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

  assert.deepEqual(result, { imported: 2, files: ['知识库/概览.md', '图像/照片.png'] })
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
