import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  listAll,
  listDir,
  listTree,
  listFileHistory,
  deleteFileHistory,
  archiveFileHistory,
  listOrphanFileHistory,
  deleteOrphanFileHistory,
  readOrphanFileHistory,
  restoreOrphanFileHistory,
  reattachTrashFileHistory,
  createItem,
  moveItem,
  searchWorkspace,
  writeFile,
  readFile,
  restoreFileHistory,
  uploadFile,
} from '../src/fileService.js'
import { getRecoveryStats } from '../src/recoveryStatsService.js'

async function temporaryWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-editor-test-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  return workspace
}

function revision(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function temporaryRecovery(t) {
  const recovery = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-editor-recovery-'))
  t.after(() => fs.rm(recovery, { recursive: true, force: true }))
  return recovery
}

test('atomic writes preserve private file permissions', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'private.md'), 'old', { mode: 0o600 })
  await fs.chmod(path.join(workspace, 'private.md'), 0o600)

  await writeFile(workspace, 'private.md', 'new', revision('old'), { root: recovery })

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(workspace, 'private.md'))).mode & 0o777, 0o600)
  }
  assert.equal(await fs.readFile(path.join(workspace, 'private.md'), 'utf8'), 'new')
})

test('new atomic writes default to owner-only permissions', async t => {
  const workspace = await temporaryWorkspace(t)

  await writeFile(workspace, 'new.md', 'draft', null)

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(workspace, 'new.md'))).mode & 0o777, 0o600)
  }
})

test('uploads keep binary bytes and refuse replacement', async t => {
  const workspace = await temporaryWorkspace(t)
  const bytes = Buffer.from([0x00, 0x89, 0xff, 0x10, 0x00])

  await uploadFile(workspace, '', { originalname: 'asset.bin', buffer: bytes })
  assert.deepEqual(await fs.readFile(path.join(workspace, 'asset.bin')), bytes)
  await assert.rejects(
    uploadFile(workspace, '', { originalname: 'asset.bin', buffer: Buffer.from('changed') }),
    error => error.code === 'CONFLICT',
  )
  assert.deepEqual(await fs.readFile(path.join(workspace, 'asset.bin')), bytes)
})

test('Markdown uploads detach stale path history before creating the new file', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const target = path.join(workspace, 'note.md')
  await fs.writeFile(target, 'generation A')
  const opened = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'generation A current', opened.revision, { root: recovery })
  const oldHistory = (await listFileHistory(workspace, 'note.md', { root: recovery })).history
  assert.equal(oldHistory.length, 1)

  // Simulate an external deletion, which leaves the path-keyed bucket behind.
  await fs.unlink(target)
  await uploadFile(workspace, '', {
    originalname: 'note.md',
    buffer: Buffer.from('generation B'),
  }, { root: recovery })

  assert.equal(await fs.readFile(target, 'utf8'), 'generation B')
  assert.deepEqual((await listFileHistory(workspace, 'note.md', { root: recovery })).history, [])
  const orphan = (await listOrphanFileHistory(workspace, { root: recovery })).items[0]
  assert.equal(orphan.path, 'note.md')
  assert.equal(orphan.reason, 'path-reused')
  assert.equal(orphan.history[0].id, oldHistory[0].id)
})

test('trees expose regular attachments but omit special files and Markdown search includes .markdown', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.mkdir(path.join(workspace, 'docs'))
  await fs.writeFile(path.join(workspace, 'docs', 'guide.markdown'), 'body has an extended-format needle')
  await fs.writeFile(path.join(workspace, 'archive.sqlite'), Buffer.from([0x00, 0xff, 0x01]))

  let fifoCreated = false
  if (process.platform !== 'win32') {
    try {
      execFileSync('mkfifo', [path.join(workspace, 'blocked.md')])
      fifoCreated = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  const rootEntries = await listDir(workspace)
  assert.ok(rootEntries.some(item => item.path === 'archive.sqlite' && item.type === 'file'))
  const recursiveEntries = await listTree(workspace)
  assert.ok(recursiveEntries.some(item => item.path === 'docs/guide.markdown'))
  if (fifoCreated) {
    assert.ok(!rootEntries.some(item => item.path === 'blocked.md'))
    assert.ok(!recursiveEntries.some(item => item.path === 'blocked.md'))
    await assert.rejects(readFile(workspace, 'blocked.md'), error => error.code === 'UNSUPPORTED_FILE_TYPE')
  }

  const results = await searchWorkspace(workspace, 'extended-format')
  assert.equal(results.find(item => item.path === 'docs/guide.markdown')?.preview, 'body has an extended-format needle')
  await assert.rejects(
    writeFile(workspace, 'archive.sqlite', 'text replacement', null),
    error => error.code === 'UNSUPPORTED_FILE_TYPE',
  )
  await assert.rejects(
    writeFile(workspace, 'new.md', String.fromCharCode(0xd800), null),
    error => error.code === 'INVALID_UTF8',
  )
})

test('recursive tree uses the workspace-relative shape and omits hidden and symlink entries', async t => {
  const workspace = await temporaryWorkspace(t)
  const outside = await temporaryWorkspace(t)
  await fs.mkdir(path.join(workspace, 'notes'))
  await fs.mkdir(path.join(workspace, '.private'))
  await fs.writeFile(path.join(workspace, 'notes', 'one.md'), 'inside')
  await fs.writeFile(path.join(workspace, '.hidden.md'), 'hidden')
  await fs.writeFile(path.join(workspace, '.private', 'secret.md'), 'hidden')
  await fs.writeFile(path.join(outside, 'outside.md'), 'outside')

  if (process.platform !== 'win32') {
    await fs.symlink(path.join(outside, 'outside.md'), path.join(workspace, 'linked.md'))
    await fs.symlink(outside, path.join(workspace, 'linked-dir'))
  }

  const tree = await listTree(workspace)
  assert.deepEqual(tree, [
    { name: 'notes', type: 'dir', path: 'notes' },
    { name: 'one.md', type: 'file', path: 'notes/one.md' },
  ])
})

test('recursive tree handles a large flat and nested workspace', async t => {
  const workspace = await temporaryWorkspace(t)
  const expected = []
  for (let directory = 0; directory < 80; directory += 1) {
    const name = `dir-${directory}`
    await fs.mkdir(path.join(workspace, name))
    expected.push({ name, type: 'dir', path: name })
    const files = Array.from({ length: 12 }, (_, file) => {
      const fileName = `note-${file}.md`
      expected.push({ name: fileName, type: 'file', path: `${name}/${fileName}` })
      return fs.writeFile(path.join(workspace, name, fileName), 'content')
    })
    await Promise.all(files)
  }

  const tree = await listTree(workspace)
  assert.equal(tree.length, expected.length)
  assert.deepEqual(new Set(tree.map(item => `${item.type}:${item.path}`)), new Set(expected.map(item => `${item.type}:${item.path}`)))
})

test('workspace search keeps name and Markdown matching, previews and tree order', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.mkdir(path.join(workspace, 'nested'))
  await fs.writeFile(path.join(workspace, 'first.md'), 'before NEEDLE after')
  await fs.writeFile(path.join(workspace, 'Needle-by-name.md'), 'no body match')
  await fs.writeFile(path.join(workspace, 'plain.txt'), 'needle in a non-Markdown file')
  await fs.writeFile(path.join(workspace, 'nested', 'third.MD'), 'another needle here')
  await fs.mkdir(path.join(workspace, '.hidden'))
  await fs.writeFile(path.join(workspace, '.hidden', 'secret.md'), 'needle must stay hidden')

  const expectedOrder = []
  for (const item of await listAll(workspace)) {
    if (item.name.toLowerCase().includes('needle')) {
      expectedOrder.push(item.path)
    } else if (
      /\.(?:md|markdown)$/i.test(item.name) &&
      (await fs.readFile(path.join(workspace, item.path), 'utf8')).toLowerCase().includes('needle')
    ) {
      expectedOrder.push(item.path)
    }
  }
  const results = await searchWorkspace(workspace, ' needle ')

  assert.deepEqual(results.map(item => item.path), expectedOrder)
  assert.equal(results.find(item => item.path === 'Needle-by-name.md').preview, undefined)
  assert.equal(results.find(item => item.path === 'first.md').preview, 'before NEEDLE after')
  assert.equal(results.find(item => item.path === 'nested/third.MD').preview, 'another needle here')
})

test('workspace search omits external symlink content and caps results at 100', async t => {
  const workspace = await temporaryWorkspace(t)
  const outside = await temporaryWorkspace(t)
  await fs.writeFile(path.join(outside, 'outside.md'), 'symlink-secret')
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(outside, 'outside.md'), path.join(workspace, 'linked.md'))
  }

  for (let index = 0; index < 105; index += 1) {
    await fs.writeFile(path.join(workspace, `target-${String(index).padStart(3, '0')}.md`), 'body does not match')
  }
  const expected = (await listAll(workspace))
    .filter(item => item.name.startsWith('target-'))
    .slice(0, 100)
    .map(item => item.path)

  const matches = await searchWorkspace(workspace, 'target-')
  assert.equal(matches.length, 100)
  assert.deepEqual(matches.map(item => item.path), expected)
  assert.ok(matches.every(item => item.preview === undefined))
  assert.deepEqual(await searchWorkspace(workspace, 'symlink-secret'), [])
})

test('versioned writes reject a stale client and preserve the current disk revision', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'initial')

  const clientA = await readFile(workspace, 'note.md')
  const clientB = await readFile(workspace, 'note.md')
  const savedByB = await writeFile(workspace, 'note.md', 'B edit', clientB.revision, { root: recovery })
  await assert.rejects(
    writeFile(workspace, 'note.md', 'A stale edit', clientA.revision, { root: recovery }),
    error => error.code === 'FILE_CONFLICT' &&
      error.details.currentRevision === savedByB.revision &&
      error.details.currentContent === 'B edit',
  )
  assert.equal((await fs.readFile(path.join(workspace, 'note.md'), 'utf8')), 'B edit')
  const history = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.equal(history.history.length, 1)
  assert.equal(history.history[0].revision, clientA.revision)
})

test('repeated versioned writes with identical bytes preserve history, mtime, and permissions', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const notePath = path.join(workspace, 'note.md')
  await fs.writeFile(notePath, 'initial', { mode: 0o640 })
  if (process.platform !== 'win32') await fs.chmod(notePath, 0o640)

  const original = await readFile(workspace, 'note.md')
  const firstSave = await writeFile(workspace, 'note.md', 'updated', original.revision, { root: recovery })
  const firstHistory = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.equal(firstHistory.history.length, 1)

  // Pin the timestamp so the assertion catches an atomic replacement even on
  // filesystems whose clock has coarse resolution.
  await fs.utimes(notePath, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
  const beforeNoop = await fs.stat(notePath, { bigint: true })
  const repeatedSave = await writeFile(workspace, 'note.md', 'updated', firstSave.revision, { root: recovery })
  const afterNoop = await fs.stat(notePath, { bigint: true })

  assert.deepEqual(repeatedSave, { success: true, path: 'note.md', revision: firstSave.revision })
  assert.equal(afterNoop.mtimeNs, beforeNoop.mtimeNs)
  if (process.platform !== 'win32') assert.equal(afterNoop.mode & 0o777n, beforeNoop.mode & 0o777n)
  assert.equal((await listFileHistory(workspace, 'note.md', { root: recovery })).history.length, 1)

  await assert.rejects(
    writeFile(workspace, 'note.md', 'updated', original.revision, { root: recovery }),
    error => error.code === 'FILE_CONFLICT' && error.details.currentRevision === firstSave.revision,
  )
  assert.equal((await listFileHistory(workspace, 'note.md', { root: recovery })).history.length, 1)
  assert.equal((await fs.stat(notePath, { bigint: true })).mtimeNs, beforeNoop.mtimeNs)
})

test('versioned writes reject external changes and require an explicit revision', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'before external edit')
  const opened = await readFile(workspace, 'note.md')
  await fs.writeFile(path.join(workspace, 'note.md'), 'external edit')

  await assert.rejects(
    writeFile(workspace, 'note.md', 'stale client write', opened.revision, { root: recovery }),
    error => error.code === 'FILE_CONFLICT' && error.details.currentContent === 'external edit',
  )
  await assert.rejects(
    writeFile(workspace, 'note.md', 'unversioned write', undefined, { root: recovery }),
    error => error.code === 'REVISION_REQUIRED',
  )
  assert.equal(await fs.readFile(path.join(workspace, 'note.md'), 'utf8'), 'external edit')
  assert.deepEqual((await listFileHistory(workspace, 'note.md', { root: recovery })).history, [])
})

test('null revision creates only absent files; restore uses the same current-revision guard', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const created = await writeFile(workspace, 'note.md', 'version one', null, { root: recovery })
  await assert.rejects(
    writeFile(workspace, 'note.md', 'must not replace', null, { root: recovery }),
    error => error.code === 'FILE_CONFLICT' && error.details.currentRevision === created.revision,
  )
  const saved = await writeFile(workspace, 'note.md', 'version two', created.revision, { root: recovery })
  const history = await listFileHistory(workspace, 'note.md', { root: recovery })
  const restored = await restoreFileHistory(workspace, 'note.md', history.history[0].id, saved.revision, { root: recovery })
  assert.equal(restored.revision, created.revision)
  assert.equal(await fs.readFile(path.join(workspace, 'note.md'), 'utf8'), 'version one')
  await assert.rejects(
    restoreFileHistory(workspace, 'note.md', history.history[0].id, saved.revision, { root: recovery }),
    error => error.code === 'FILE_CONFLICT',
  )
})

test('restoring a history entry that matches current bytes succeeds without adding history', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const notePath = path.join(workspace, 'note.md')
  await fs.writeFile(notePath, 'version one')

  const first = await readFile(workspace, 'note.md')
  const second = await writeFile(workspace, 'note.md', 'version two', first.revision, { root: recovery })
  const current = await writeFile(workspace, 'note.md', 'version one', second.revision, { root: recovery })
  const history = await listFileHistory(workspace, 'note.md', { root: recovery })
  const matchingEntry = history.history.find(entry => entry.revision === current.revision)
  assert.ok(matchingEntry)

  await fs.utimes(notePath, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'))
  const beforeRestore = await fs.stat(notePath, { bigint: true })
  const restored = await restoreFileHistory(
    workspace,
    'note.md',
    matchingEntry.id,
    current.revision,
    { root: recovery },
  )

  assert.equal(restored.revision, current.revision)
  assert.equal(restored.previousRevision, current.revision)
  assert.equal(restored.restoredHistoryId, matchingEntry.id)
  assert.equal((await fs.stat(notePath, { bigint: true })).mtimeNs, beforeRestore.mtimeNs)
  assert.equal((await listFileHistory(workspace, 'note.md', { root: recovery })).history.length, 2)
})

test('deleting one history record preserves the current file and returns not found when repeated', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const notePath = path.join(workspace, 'note.md')
  await fs.writeFile(notePath, 'version one')
  const first = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'version two', first.revision, { root: recovery })
  const history = await listFileHistory(workspace, 'note.md', { root: recovery })
  const record = history.history[0]
  const current = await readFile(workspace, 'note.md')

  assert.deepEqual(
    await deleteFileHistory(workspace, 'note.md', record.id, { root: recovery }),
    { success: true, path: 'note.md', deletedHistoryId: record.id },
  )
  assert.deepEqual((await listFileHistory(workspace, 'note.md', { root: recovery })).history, [])
  assert.deepEqual(await readFile(workspace, 'note.md'), current)
  await assert.rejects(
    deleteFileHistory(workspace, 'note.md', record.id, { root: recovery }),
    error => error.code === 'HISTORY_NOT_FOUND',
  )
})

test('history deletion rejects invalid paths and IDs and cannot cross file or workspace buckets', async t => {
  const workspace = await temporaryWorkspace(t)
  const otherWorkspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'old')
  await fs.writeFile(path.join(workspace, 'other.md'), 'other old')
  await fs.writeFile(path.join(otherWorkspace, 'note.md'), 'other workspace old')
  const opened = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'new', opened.revision, { root: recovery })
  const record = (await listFileHistory(workspace, 'note.md', { root: recovery })).history[0]

  await assert.rejects(
    deleteFileHistory(workspace, 'note.md', 'not-a-uuid', { root: recovery }),
    error => error.code === 'INVALID_HISTORY_ID',
  )
  await assert.rejects(
    deleteFileHistory(workspace, '../note.md', record.id, { root: recovery }),
    error => error.code === 'INVALID_PATH',
  )
  await assert.rejects(
    deleteFileHistory(workspace, 'other.md', record.id, { root: recovery }),
    error => error.code === 'HISTORY_NOT_FOUND',
  )
  await assert.rejects(
    deleteFileHistory(otherWorkspace, 'note.md', record.id, { root: recovery }),
    error => error.code === 'HISTORY_NOT_FOUND',
  )
  assert.equal((await listFileHistory(workspace, 'note.md', { root: recovery })).history.length, 1)
})

test('history deletion rejects corrupt records and symlinks without removing another record', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const notePath = path.join(workspace, 'note.md')
  await fs.writeFile(notePath, 'version one')
  const first = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'version two', first.revision, { root: recovery })
  const second = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'version three', second.revision, { root: recovery })
  const history = await listFileHistory(workspace, 'note.md', { root: recovery })
  const bucket = path.join(
    recovery,
    'history',
    createHash('sha256').update(await fs.realpath(workspace)).digest('hex'),
    createHash('sha256').update('note.md').digest('hex'),
  )
  const [newest, older] = history.history
  const corruptPath = path.join(bucket, `${newest.id}.json`)
  await fs.writeFile(corruptPath, '{broken json')
  await assert.rejects(
    deleteFileHistory(workspace, 'note.md', newest.id, { root: recovery }),
    error => error.code === 'HISTORY_CORRUPT',
  )
  assert.equal(await fs.readFile(corruptPath, 'utf8'), '{broken json')

  if (process.platform !== 'win32') {
    const olderPath = path.join(bucket, `${older.id}.json`)
    await fs.unlink(corruptPath)
    await fs.symlink(olderPath, corruptPath)
    await assert.rejects(
      deleteFileHistory(workspace, 'note.md', newest.id, { root: recovery }),
      error => error.code === 'HISTORY_NOT_FOUND',
    )
    assert.equal((await fs.lstat(corruptPath)).isSymbolicLink(), true)
    assert.equal(JSON.parse(await fs.readFile(olderPath, 'utf8')).id, older.id)
  }
})

test('history is private, preserves file mode, and a history storage failure aborts replacement', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'private.md'), 'old', { mode: 0o600 })
  await fs.chmod(path.join(workspace, 'private.md'), 0o600)
  const old = await readFile(workspace, 'private.md')
  await writeFile(workspace, 'private.md', 'new', old.revision, { root: recovery })

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(workspace, 'private.md'))).mode & 0o777, 0o600)
    const historyEntry = (await listFileHistory(workspace, 'private.md', { root: recovery })).history[0]
    const bucket = path.join(recovery, 'history', createHash('sha256').update(await fs.realpath(workspace)).digest('hex'), createHash('sha256').update('private.md').digest('hex'))
    assert.equal((await fs.stat(recovery)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(bucket)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(path.join(bucket, `${historyEntry.id}.json`))).mode & 0o777, 0o600)
  }

  const recoveryBlocker = path.join(await temporaryWorkspace(t), 'not-a-directory')
  await fs.writeFile(recoveryBlocker, 'block')
  await assert.rejects(
    writeFile(workspace, 'private.md', 'must not replace', revision('new'), { root: recoveryBlocker }),
    error => error.code === 'RECOVERY_STORAGE_ERROR',
  )
  assert.equal(await fs.readFile(path.join(workspace, 'private.md'), 'utf8'), 'new')
})

test('recovery storage cannot resolve inside the workspace, including through a symlink', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'old')
  const opened = await readFile(workspace, 'note.md')
  await assert.rejects(
    writeFile(workspace, 'note.md', 'new', opened.revision, { root: path.join(workspace, '.recovery') }),
    error => error.code === 'RECOVERY_STORAGE_ERROR',
  )

  if (process.platform !== 'win32') {
    const outside = await temporaryWorkspace(t)
    const alias = path.join(outside, 'recovery-link')
    await fs.symlink(workspace, alias)
    await assert.rejects(
      writeFile(workspace, 'note.md', 'new', opened.revision, { root: alias }),
      error => error.code === 'RECOVERY_STORAGE_ERROR',
    )
  }
  assert.equal(await fs.readFile(path.join(workspace, 'note.md'), 'utf8'), 'old')
})

test('missing recovery-root components stay ordered for history writes and statistics', async t => {
  const outer = await temporaryWorkspace(t)
  const workspace = path.join(outer, 'notes')
  await fs.mkdir(workspace)
  const recovery = path.join(outer, 'missing-a', 'missing-b', 'recovery')
  await fs.writeFile(path.join(workspace, 'note.md'), 'before')

  const opened = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'after', opened.revision, { root: recovery })

  const workspaceKey = createHash('sha256').update(await fs.realpath(workspace)).digest('hex')
  const fileKey = createHash('sha256').update('note.md').digest('hex')
  const bucket = path.join(recovery, 'history', workspaceKey, fileKey)
  const history = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.equal(history.history.length, 1)

  const recordPath = path.join(bucket, `${history.history[0].id}.json`)
  assert.equal(JSON.parse(await fs.readFile(recordPath, 'utf8')).contentBase64, Buffer.from('before').toString('base64'))
  const expectedBytes = (await fs.stat(recordPath)).size
  const stats = await getRecoveryStats(workspace, { recoveryRoot: recovery })
  assert.equal(stats.history.items, 1)
  assert.equal(stats.history.bytes, expectedBytes)

  const wronglyReversedRoot = path.join(outer, 'recovery', 'missing-b', 'missing-a')
  await assert.rejects(fs.lstat(wronglyReversedRoot), error => error.code === 'ENOENT')
})

test('multi-level missing recovery roots inside the workspace are rejected on write', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = path.join(workspace, 'missing-a', 'missing-b', 'recovery')
  const notePath = path.join(workspace, 'note.md')
  await fs.writeFile(notePath, 'before')
  const opened = await readFile(workspace, 'note.md')

  await assert.rejects(
    writeFile(workspace, 'note.md', 'after', opened.revision, { root: recovery }),
    error => error.code === 'RECOVERY_STORAGE_ERROR',
  )
  assert.equal(await fs.readFile(notePath, 'utf8'), 'before')
  await assert.rejects(fs.lstat(recovery), error => error.code === 'ENOENT')
})

test('file moves migrate source history and preserve old destination history as an orphan', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.mkdir(path.join(workspace, 'folder'))
  await fs.writeFile(path.join(workspace, 'folder', 'one.md'), 'one')
  await fs.writeFile(path.join(workspace, 'folder', 'two.md'), 'two')
  const one = await readFile(workspace, 'folder/one.md')
  const two = await readFile(workspace, 'folder/two.md')
  await writeFile(workspace, 'folder/one.md', 'one updated', one.revision, { root: recovery })
  await writeFile(workspace, 'folder/two.md', 'two updated', two.revision, { root: recovery })

  await assert.rejects(
    moveItem(workspace, 'folder/one.md', 'moved.md', { root: recovery, moveHistoryBucket: () => { throw new Error('injected metadata move failure') } }),
    /injected metadata move failure/,
  )
  assert.equal(await fs.readFile(path.join(workspace, 'folder', 'one.md'), 'utf8'), 'one updated')
  assert.equal((await listFileHistory(workspace, 'folder/one.md', { root: recovery })).history.length, 1)
  assert.deepEqual((await listFileHistory(workspace, 'moved.md', { root: recovery })).history, [])

  // A previous occupant's history is detached from the reusable path. It no
  // longer blocks a different file from moving there or becomes its history.
  await fs.writeFile(path.join(workspace, 'moved.md'), 'previous occupant')
  const occupant = await readFile(workspace, 'moved.md')
  await writeFile(workspace, 'moved.md', 'replaced occupant', occupant.revision, { root: recovery })
  await fs.unlink(path.join(workspace, 'moved.md'))
  await moveItem(workspace, 'folder/one.md', 'moved.md', { root: recovery })
  assert.equal(await fs.readFile(path.join(workspace, 'moved.md'), 'utf8'), 'one updated')
  const movedHistory = (await listFileHistory(workspace, 'moved.md', { root: recovery })).history
  assert.equal(movedHistory.length, 1)
  assert.equal(movedHistory[0].sourcePath, 'folder/one.md')
  const oldOccupantHistory = await listOrphanFileHistory(workspace, { root: recovery })
  assert.equal(oldOccupantHistory.items.length, 1)
  assert.equal(oldOccupantHistory.items[0].path, 'moved.md')
  assert.equal(oldOccupantHistory.items[0].history.length, 1)

  await moveItem(workspace, 'folder', 'renamed', { root: recovery })
  const migrated = await listFileHistory(workspace, 'renamed/two.md', { root: recovery })
  assert.equal(migrated.history.length, 1)
  assert.equal(migrated.history[0].sourcePath, 'folder/two.md')
  const now = await readFile(workspace, 'renamed/two.md')
  const restored = await restoreFileHistory(workspace, 'renamed/two.md', migrated.history[0].id, now.revision, { root: recovery })
  assert.equal(restored.revision, two.revision)
  assert.equal(await fs.readFile(path.join(workspace, 'renamed', 'two.md'), 'utf8'), 'two')
})

test('trash history is separated from same-path files and remains restorable after path reuse', async t => {
  const workspace = await temporaryWorkspace(t)
  const otherWorkspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const note = path.join(workspace, 'note.md')
  await fs.writeFile(note, 'generation A')
  const firstRevision = (await readFile(workspace, 'note.md')).revision
  await writeFile(workspace, 'note.md', 'generation A current', firstRevision, { root: recovery })
  const firstHistory = (await listFileHistory(workspace, 'note.md', { root: recovery })).history
  assert.equal(firstHistory.length, 1)

  const trashId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const payload = path.join(recovery, 'trash-payload')
  await fs.rename(note, payload)
  await archiveFileHistory(workspace, 'note.md', { root: recovery, reason: 'trash', trashEntryId: trashId })
  assert.deepEqual((await listFileHistory(workspace, 'note.md', { root: recovery })).history, [])
  let orphans = await listOrphanFileHistory(workspace, { root: recovery })
  assert.equal(orphans.items.length, 1)
  assert.equal(orphans.items[0].trashEntryId, trashId)
  assert.equal(orphans.items[0].history[0].revision, firstRevision)

  // A new document starts a fresh active chain even though the old history is
  // still available in the orphan manager.
  await createItem(workspace, '', 'file', 'note.md', { root: recovery })
  const empty = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'generation B', empty.revision, { root: recovery })
  const secondHistory = (await listFileHistory(workspace, 'note.md', { root: recovery })).history
  assert.equal(secondHistory.length, 1)
  assert.equal(secondHistory[0].revision, empty.revision)
  assert.notEqual(secondHistory[0].revision, firstRevision)

  // Moving the new file away clears the path; another historical file can
  // then move into it without inheriting either older generation.
  await moveItem(workspace, 'note.md', 'generation-b.md', { root: recovery })
  await fs.writeFile(path.join(workspace, 'source.md'), 'generation C')
  const sourceRevision = (await readFile(workspace, 'source.md')).revision
  await writeFile(workspace, 'source.md', 'generation C current', sourceRevision, { root: recovery })
  await moveItem(workspace, 'source.md', 'note.md', { root: recovery })
  const thirdHistory = (await listFileHistory(workspace, 'note.md', { root: recovery })).history
  assert.equal(thirdHistory.length, 1)
  assert.equal(thirdHistory[0].revision, sourceRevision)
  assert.equal((await listOrphanFileHistory(workspace, { root: recovery })).items.length, 1)

  await fs.rm(payload)
  orphans = await listOrphanFileHistory(workspace, { root: recovery })
  assert.equal(orphans.items.length, 1)
  assert.equal((await listOrphanFileHistory(otherWorkspace, { root: recovery })).items.length, 0)
})

test('directory trash archives each Markdown history and trash restore reattaches only conflict-free paths', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const folder = path.join(workspace, 'folder')
  await fs.mkdir(folder)
  await fs.writeFile(path.join(folder, 'one.md'), 'one before')
  await fs.writeFile(path.join(folder, 'two.markdown'), 'two before')
  for (const relative of ['folder/one.md', 'folder/two.markdown']) {
    const opened = await readFile(workspace, relative)
    await writeFile(workspace, relative, `${relative} current`, opened.revision, { root: recovery })
  }
  const trashId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const payload = path.join(recovery, 'folder-payload')
  await fs.rename(folder, payload)
  await archiveFileHistory(workspace, 'folder', {
    root: recovery,
    reason: 'trash',
    trashEntryId: trashId,
    includeDescendants: true,
  })
  let orphans = await listOrphanFileHistory(workspace, { root: recovery })
  assert.deepEqual(orphans.items.map(item => item.path).sort(), ['folder/one.md', 'folder/two.markdown'])
  assert.deepEqual((await reattachTrashFileHistory(workspace, trashId, { root: recovery })), { reattached: 0, retained: 2 })

  await fs.rename(payload, folder)
  const reattached = await reattachTrashFileHistory(workspace, trashId, { root: recovery })
  assert.deepEqual(reattached, { reattached: 2, retained: 0 })
  assert.equal((await listFileHistory(workspace, 'folder/one.md', { root: recovery })).history.length, 1)
  assert.equal((await listFileHistory(workspace, 'folder/two.markdown', { root: recovery })).history.length, 1)
  assert.deepEqual((await listOrphanFileHistory(workspace, { root: recovery })).items, [])
})

test('deleting the final history record removes the empty active bucket', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'before')
  const opened = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'after', opened.revision, { root: recovery })
  const history = (await listFileHistory(workspace, 'note.md', { root: recovery })).history
  const workspaceKey = createHash('sha256').update(await fs.realpath(workspace)).digest('hex')
  const fileKey = createHash('sha256').update('note.md').digest('hex')
  const bucket = path.join(recovery, 'history', workspaceKey, fileKey)
  await fs.access(bucket)

  await deleteFileHistory(workspace, 'note.md', history[0].id, { root: recovery })
  await assert.rejects(fs.lstat(bucket), error => error.code === 'ENOENT')
  assert.deepEqual((await listFileHistory(workspace, 'note.md', { root: recovery })).history, [])
})

test('orphan histories preview as strict UTF-8, restore with revisions, and delete within one workspace', async t => {
  const workspace = await temporaryWorkspace(t)
  const otherWorkspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'recover this text')
  const opened = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'current text', opened.revision, { root: recovery })
  const historyId = (await listFileHistory(workspace, 'note.md', { root: recovery })).history[0].id
  const trashId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  await archiveFileHistory(workspace, 'note.md', { root: recovery, reason: 'trash', trashEntryId: trashId })
  const orphanId = (await listOrphanFileHistory(workspace, { root: recovery })).items[0].id

  const preview = await readOrphanFileHistory(workspace, orphanId, historyId, { root: recovery })
  assert.equal(preview.content, 'recover this text')
  assert.equal(preview.entry.revision, opened.revision)
  await assert.rejects(
    readOrphanFileHistory(otherWorkspace, orphanId, historyId, { root: recovery }),
    error => error.code === 'HISTORY_NOT_FOUND',
  )

  const restored = await restoreOrphanFileHistory(
    workspace, orphanId, historyId, 'restored.md', null, { root: recovery },
  )
  assert.equal(restored.revision, opened.revision)
  assert.equal(await fs.readFile(path.join(workspace, 'restored.md'), 'utf8'), 'recover this text')
  await assert.rejects(
    restoreOrphanFileHistory(workspace, orphanId, historyId, 'restored.md', null, { root: recovery }),
    error => error.code === 'FILE_CONFLICT',
  )
  assert.equal((await listOrphanFileHistory(workspace, { root: recovery })).items.length, 1)
  const removed = await deleteOrphanFileHistory(workspace, orphanId, { root: recovery })
  assert.equal(removed.deletedHistory, 1)
  assert.deepEqual((await listOrphanFileHistory(workspace, { root: recovery })).items, [])
})

test('failed history archive leaves active records intact for the caller to roll back', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'before')
  const opened = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'after', opened.revision, { root: recovery })

  await assert.rejects(
    archiveFileHistory(workspace, 'note.md', {
      root: recovery,
      reason: 'trash',
      trashEntryId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      moveHistoryBucket: async () => { throw new Error('injected archive rename failure') },
    }),
    error => error.code === 'RECOVERY_STORAGE_ERROR',
  )
  assert.equal((await listFileHistory(workspace, 'note.md', { root: recovery })).history.length, 1)
  assert.deepEqual((await listOrphanFileHistory(workspace, { root: recovery })).items, [])
})
