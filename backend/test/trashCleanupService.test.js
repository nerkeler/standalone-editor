import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createTrashService } from '../src/trashService.js'
import { archiveFileHistory, listOrphanFileHistory, readFile, writeFile } from '../src/fileService.js'

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function fixture(t) {
  const outer = await tempDirectory(t, 'standalone-editor-trash-cleanup-')
  const workspace = path.join(outer, 'notes')
  const recovery = path.join(outer, 'recovery')
  await fs.mkdir(workspace)
  return { outer, workspace, recovery }
}

async function workspaceKey(workspace) {
  return createHash('sha256').update(await fs.realpath(workspace)).digest('hex')
}

test('expired entries are removed only by the explicit purge operation', async t => {
  const { workspace, recovery } = await fixture(t)
  await fs.writeFile(path.join(workspace, 'expired.md'), 'old recovery')
  const trash = createTrashService(workspace, { recoveryRoot: recovery })
  const { id } = await trash.trash('expired.md')
  const entryDirectory = path.join(recovery, 'trash', await workspaceKey(workspace), id)
  const manifestPath = path.join(entryDirectory, 'entry.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.expiresAt = '2000-01-01T00:00:00.000Z'
  await fs.writeFile(manifestPath, JSON.stringify(manifest))

  assert.equal((await trash.list()).length, 1)
  await fs.lstat(entryDirectory)
  const result = await trash.purgeExpired({ at: new Date('2001-01-01T00:00:00.000Z') })
  assert.equal(result.purged, 1)
  assert.ok(result.bytes > Buffer.byteLength('old recovery'))
  assert.deepEqual(await trash.list(), [])
  await assert.rejects(fs.lstat(entryDirectory), error => error.code === 'ENOENT')
})

test('permanent trash removal and expiry purge leave archived Markdown history intact', async t => {
  const { workspace, recovery } = await fixture(t)
  const trash = createTrashService(workspace, { recoveryRoot: recovery })
  for (const name of ['permanent.md', 'expired.md']) {
    await fs.writeFile(path.join(workspace, name), `${name} before`)
    const opened = await readFile(workspace, name)
    await writeFile(workspace, name, `${name} after`, opened.revision, { root: recovery })
  }

  const permanent = await trash.trash('permanent.md')
  await archiveFileHistory(workspace, 'permanent.md', {
    root: recovery, reason: 'trash', trashEntryId: permanent.id,
  })
  await trash.remove(permanent.id)

  const expired = await trash.trash('expired.md')
  await archiveFileHistory(workspace, 'expired.md', {
    root: recovery, reason: 'trash', trashEntryId: expired.id,
  })
  const entryDirectory = path.join(recovery, 'trash', await workspaceKey(workspace), expired.id)
  const manifestPath = path.join(entryDirectory, 'entry.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.expiresAt = '2000-01-01T00:00:00.000Z'
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  assert.equal((await trash.purgeExpired({ at: new Date('2001-01-01T00:00:00.000Z') })).purged, 1)

  const orphans = await listOrphanFileHistory(workspace, { root: recovery })
  assert.deepEqual(orphans.items.map(item => item.path).sort(), ['expired.md', 'permanent.md'])
  assert.ok(orphans.items.every(item => item.history.length === 1))
})

test('permanent removal requires a ready entry belonging to the selected workspace', async t => {
  const { outer, workspace, recovery } = await fixture(t)
  const otherWorkspace = path.join(outer, 'other-notes')
  await fs.mkdir(otherWorkspace)
  await fs.writeFile(path.join(workspace, 'selected.md'), 'selected content')
  const trash = createTrashService(workspace, { recoveryRoot: recovery })
  const { id } = await trash.trash('selected.md')

  await assert.rejects(trash.remove('not-an-id'), error => error.code === 'INVALID_TRASH_ENTRY')
  await assert.rejects(createTrashService(otherWorkspace, { recoveryRoot: recovery }).remove(id), error => error.code === 'ENOENT')
  assert.equal((await trash.list()).length, 1)

  const trashRoot = path.join(recovery, 'trash', await workspaceKey(workspace))
  const entryDirectory = path.join(trashRoot, id)
  const manifestPath = path.join(entryDirectory, 'entry.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.state = 'staging'
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(trash.remove(id), error => error.code === 'TRASH_ENTRY_NOT_READY')
  assert.equal((await trash.list()).length, 1)
})

test('permanent removal deletes selected storage without following nested symlinks', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const { outer, workspace, recovery } = await fixture(t)
  const outside = path.join(outer, 'outside-secret.md')
  await fs.writeFile(outside, 'must stay intact')
  await fs.mkdir(path.join(workspace, 'folder'))
  await fs.writeFile(path.join(workspace, 'folder', 'note.md'), 'recovery bytes')
  const trash = createTrashService(workspace, { recoveryRoot: recovery })
  const { id } = await trash.trash('folder')
  const workspaceId = await workspaceKey(workspace)
  const entryDirectory = path.join(recovery, 'trash', workspaceId, id)
  await fs.rm(path.join(entryDirectory, 'payload', 'note.md'))
  await fs.symlink(outside, path.join(entryDirectory, 'payload', 'external-link'))
  const manifestBytes = (await fs.stat(path.join(entryDirectory, 'entry.json'))).size

  const result = await trash.remove(id)
  assert.deepEqual(result, { success: true, id, bytes: manifestBytes })
  assert.equal(await fs.readFile(outside, 'utf8'), 'must stay intact')
  await assert.rejects(fs.lstat(entryDirectory), error => error.code === 'ENOENT')
})

test('permanent removal refuses an entry directory replaced by an external symlink', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const { outer, workspace, recovery } = await fixture(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'keep in recovery')
  const trash = createTrashService(workspace, { recoveryRoot: recovery })
  const { id } = await trash.trash('note.md')
  const entryDirectory = path.join(recovery, 'trash', await workspaceKey(workspace), id)
  const outsideEntry = path.join(outer, 'outside-entry')
  await fs.rename(entryDirectory, outsideEntry)
  await fs.symlink(outsideEntry, entryDirectory)

  await assert.rejects(trash.remove(id), error => error.code === 'ENOENT')
  assert.equal(await fs.readFile(path.join(outsideEntry, 'payload'), 'utf8'), 'keep in recovery')
  await fs.lstat(outsideEntry)
})
