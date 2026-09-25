import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { archiveFileHistory, writeFile } from '../src/fileService.js'
import { createTrashService } from '../src/trashService.js'
import { getRecoveryStats } from '../src/recoveryStatsService.js'

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function regularFileBytes(target) {
  let bytes = 0
  const stat = await fs.lstat(target)
  if (stat.isSymbolicLink()) return 0
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0
  for (const name of await fs.readdir(target)) bytes += await regularFileBytes(path.join(target, name))
  return bytes
}

test('recovery statistics count serialized storage bytes and isolate each workspace', async t => {
  const outer = await tempDirectory(t, 'standalone-editor-recovery-stats-')
  const workspace = path.join(outer, 'notes')
  const otherWorkspace = path.join(outer, 'other-notes')
  const recovery = path.join(outer, 'recovery')
  await Promise.all([fs.mkdir(workspace), fs.mkdir(otherWorkspace), fs.mkdir(recovery)])
  const realWorkspace = await fs.realpath(workspace)

  const note = path.join(workspace, 'note.md')
  await fs.writeFile(note, 'before edit')
  await writeFile(workspace, 'note.md', 'after edit', hash('before edit'), { root: recovery })
  await fs.writeFile(path.join(workspace, 'discard.md'), 'discard this')
  await createTrashService(workspace, { recoveryRoot: recovery }).trash('discard.md')

  await fs.writeFile(path.join(otherWorkspace, 'note.md'), 'other before')
  await writeFile(otherWorkspace, 'note.md', 'other after', hash('other before'), { root: recovery })
  await fs.writeFile(path.join(otherWorkspace, 'discard.md'), 'other discard')
  await createTrashService(otherWorkspace, { recoveryRoot: recovery }).trash('discard.md')

  const historyDirectory = path.join(recovery, 'history', hash(realWorkspace))
  const trashDirectory = path.join(recovery, 'trash', hash(realWorkspace))
  const stats = await getRecoveryStats(workspace, { recoveryRoot: recovery })

  assert.equal(stats.history.items, 1)
  assert.equal(stats.trash.items, 1)
  assert.equal(stats.history.bytes, await regularFileBytes(historyDirectory))
  assert.equal(stats.trash.bytes, await regularFileBytes(trashDirectory))
  assert.ok(stats.history.bytes > Buffer.byteLength('before edit'))
  assert.equal(stats.total.items, 2)
  assert.equal(stats.total.bytes, stats.history.bytes + stats.trash.bytes)
  assert.match(stats.generatedAt, /^\d{4}-\d\d-\d\dT/)
})

test('recovery statistics count archived history records without mixing workspace archives', async t => {
  const outer = await tempDirectory(t, 'standalone-editor-recovery-orphan-stats-')
  const workspace = path.join(outer, 'notes')
  const otherWorkspace = path.join(outer, 'other-notes')
  const recovery = path.join(outer, 'recovery')
  await Promise.all([fs.mkdir(workspace), fs.mkdir(otherWorkspace), fs.mkdir(recovery)])
  const notePath = path.join(workspace, 'note.md')
  await fs.writeFile(notePath, 'before archive')
  const opened = { revision: hash('before archive') }
  await writeFile(workspace, 'note.md', 'after archive', opened.revision, { root: recovery })
  await fs.rename(notePath, path.join(outer, 'trashed-note.md'))
  await archiveFileHistory(workspace, 'note.md', {
    root: recovery,
    reason: 'trash',
    trashEntryId: '11111111-1111-4111-8111-111111111111',
  })

  const workspaceKey = hash(await fs.realpath(workspace))
  const historyRoot = path.join(recovery, 'history', workspaceKey)
  const stats = await getRecoveryStats(workspace, { recoveryRoot: recovery })
  assert.equal(stats.history.items, 1)
  assert.equal(stats.history.bytes, await regularFileBytes(historyRoot))

  const otherStats = await getRecoveryStats(otherWorkspace, { recoveryRoot: recovery })
  assert.deepEqual(otherStats.history, { items: 0, bytes: 0 })
})

test('recovery statistics skip symlink targets when measuring bytes', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const outer = await tempDirectory(t, 'standalone-editor-recovery-symlink-')
  const workspace = path.join(outer, 'notes')
  const recovery = path.join(outer, 'recovery')
  const outside = path.join(outer, 'outside-secret')
  await fs.mkdir(workspace)
  await fs.mkdir(recovery)
  await fs.writeFile(outside, 'outside data that must not be counted')

  await fs.writeFile(path.join(workspace, 'note.md'), 'before')
  await writeFile(workspace, 'note.md', 'after', hash('before'), { root: recovery })
  const workspaceKey = hash(await fs.realpath(workspace))
  const bucket = path.join(recovery, 'history', workspaceKey, hash('note.md'))
  await fs.symlink(outside, path.join(bucket, 'external-link'))

  await fs.writeFile(path.join(workspace, 'discard.md'), 'trash me')
  const { id } = await createTrashService(workspace, { recoveryRoot: recovery }).trash('discard.md')
  const entry = path.join(recovery, 'trash', workspaceKey, id)
  await fs.rm(path.join(entry, 'payload'))
  await fs.symlink(outside, path.join(entry, 'payload'))

  const stats = await getRecoveryStats(workspace, { recoveryRoot: recovery })
  assert.equal(stats.history.bytes, await regularFileBytes(path.join(recovery, 'history', workspaceKey)))
  assert.equal(stats.trash.bytes, await regularFileBytes(path.join(recovery, 'trash', workspaceKey)))
  assert.equal(stats.history.items, 1)
  assert.equal(stats.trash.items, 0)
  assert.ok(stats.history.bytes < (await fs.stat(outside)).size + await regularFileBytes(path.join(recovery, 'history', workspaceKey)))
})

test('missing recovery storage has zero counts without creating directories', async t => {
  const outer = await tempDirectory(t, 'standalone-editor-recovery-empty-')
  const workspace = path.join(outer, 'notes')
  const recovery = path.join(outer, 'not-created')
  await fs.mkdir(workspace)

  const stats = await getRecoveryStats(workspace, { recoveryRoot: recovery })
  assert.deepEqual(stats.history, { items: 0, bytes: 0 })
  assert.deepEqual(stats.trash, { items: 0, bytes: 0 })
  await assert.rejects(fs.lstat(recovery), error => error.code === 'ENOENT')
})

test('missing root components stay in path order and cannot redirect the scan', async t => {
  const outer = await tempDirectory(t, 'standalone-editor-recovery-projection-')
  const workspace = path.join(outer, 'notes')
  await fs.mkdir(workspace)
  const workspaceKey = hash(await fs.realpath(workspace))
  const configuredRoot = path.join(outer, 'missing-a', 'missing-b', 'missing-c')
  const reversedProjection = path.join(outer, 'missing-c', 'missing-b', 'missing-a')
  const unrelatedWorkspaceStorage = path.join(reversedProjection, 'history', workspaceKey)
  await fs.mkdir(unrelatedWorkspaceStorage, { recursive: true })
  await fs.writeFile(path.join(unrelatedWorkspaceStorage, 'unrelated.json'), 'must not be scanned')

  const stats = await getRecoveryStats(workspace, { recoveryRoot: configuredRoot })
  assert.deepEqual(stats.history, { items: 0, bytes: 0 })
  assert.deepEqual(stats.trash, { items: 0, bytes: 0 })
  await assert.rejects(fs.lstat(configuredRoot), error => error.code === 'ENOENT')
})

test('multi-level missing recovery paths inside the workspace are rejected', async t => {
  const outer = await tempDirectory(t, 'standalone-editor-recovery-inside-')
  const workspace = path.join(outer, 'notes')
  await fs.mkdir(workspace)

  await assert.rejects(
    getRecoveryStats(workspace, { recoveryRoot: path.join(workspace, 'missing-a', 'missing-b', 'recovery') }),
    error => error.code === 'RECOVERY_STORAGE_ERROR',
  )
})

test('a configured storage-root symlink is canonicalized while nested symlinks remain untraversed', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const outer = await tempDirectory(t, 'standalone-editor-recovery-root-link-')
  const workspace = path.join(outer, 'notes')
  const actualRecovery = path.join(outer, 'actual-recovery')
  const configuredRecovery = path.join(outer, 'configured-recovery')
  await fs.mkdir(workspace)
  await fs.mkdir(actualRecovery)
  await fs.symlink(actualRecovery, configuredRecovery)
  await fs.writeFile(path.join(workspace, 'discard.md'), 'stored through configured root')
  await createTrashService(workspace, { recoveryRoot: configuredRecovery }).trash('discard.md')

  const stats = await getRecoveryStats(workspace, { recoveryRoot: configuredRecovery })
  assert.equal(stats.trash.items, 1)
  assert.ok(stats.trash.bytes > Buffer.byteLength('stored through configured root'))
})
