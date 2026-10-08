import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { createTrashService } from '../src/trashService.js'

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function workspaceFixture(t) {
  const outer = await tempDirectory(t, 'standalone-editor-trash-test-')
  const workspace = path.join(outer, 'notes')
  const recovery = path.join(outer, 'app-recovery')
  await fs.mkdir(workspace)
  return { outer, workspace, recovery }
}

function fileIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    type: 'file',
    mode: Number(stat.mode & 0o777n),
  }
}

async function pendingFileFixture(t, { phase = 'quarantined', putInQuarantine = true, occupied = false } = {}) {
  const { workspace, recovery } = await workspaceFixture(t)
  const sourceDirectory = path.join(workspace, 'folder')
  const source = path.join(sourceDirectory, '.hidden-note.md')
  await fs.mkdir(sourceDirectory)
  await fs.writeFile(source, 'recover this exact hidden note', { mode: 0o600 })
  const sourceStat = await fs.lstat(source, { bigint: true })
  const content = await fs.readFile(source)
  const entry = {
    path: '',
    type: 'file',
    size: content.length,
    mode: Number(sourceStat.mode & 0o777n),
    sha256: createHash('sha256').update(content).digest('hex'),
  }
  const treeHash = createHash('sha256')
  treeHash.update(JSON.stringify([entry.path, entry.type, entry.size, entry.mode, entry.sha256]))
  treeHash.update('\n')

  const id = randomUUID()
  const workspaceId = createHash('sha256').update(await fs.realpath(workspace)).digest('hex')
  const trashDirectory = path.join(recovery, 'trash', workspaceId)
  const entryDirectory = path.join(trashDirectory, id)
  const payloadPath = path.join(entryDirectory, 'payload')
  const quarantinePath = path.join(sourceDirectory, `.trash-pending-${id}`)
  await fs.mkdir(entryDirectory, { recursive: true, mode: 0o700 })
  await fs.copyFile(source, payloadPath)
  await fs.chmod(payloadPath, Number(sourceStat.mode & 0o777n))
  const payloadStat = await fs.lstat(payloadPath, { bigint: true })
  if (putInQuarantine) await fs.rename(source, quarantinePath)
  if (occupied) await fs.writeFile(source, 'new user content')

  const manifest = {
    version: 1,
    id,
    workspaceId,
    originalPath: 'folder/.hidden-note.md',
    type: 'file',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    state: 'ready',
    sourceRemoval: {
      version: 1,
      phase,
      sourceQuarantinePath: `folder/.trash-pending-${id}`,
      sourceIdentity: fileIdentity(sourceStat),
      payloadIdentity: fileIdentity(payloadStat),
      treeFingerprint: { entries: 1, sha256: treeHash.digest('hex') },
    },
  }
  await fs.writeFile(path.join(entryDirectory, 'entry.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  return { workspace, recovery, source, quarantinePath, entryDirectory, payloadPath, manifest, id }
}

test('trash stages directories with hidden contents outside the workspace and restores them', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  const original = path.join(workspace, 'project')
  await fs.mkdir(path.join(original, '.obsidian'), { recursive: true })
  await fs.writeFile(path.join(original, 'readme.md'), '# notes')
  await fs.writeFile(path.join(original, '.obsidian', 'workspace.json'), '{"layout":true}')
  await fs.chmod(path.join(original, 'readme.md'), 0o600)

  const trash = createTrashService(workspace, { recoveryRoot: recovery })
  const result = await trash.trash('project')

  await assert.rejects(fs.lstat(original), error => error.code === 'ENOENT')
  const entries = await trash.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, result.id)
  assert.equal(entries[0].path, 'project')
  assert.equal(entries[0].type, 'directory')
  assert.ok(entries[0].expiresAt)
  const hash = (await fs.readdir(path.join(recovery, 'trash')))[0]
  const payloadPath = path.join(recovery, 'trash', hash, result.id, 'payload')
  assert.equal(await fs.readFile(path.join(payloadPath, '.obsidian', 'workspace.json'), 'utf8'), '{"layout":true}')
  assert.equal((await fs.stat(path.join(payloadPath, 'readme.md'))).mode & 0o777, process.platform === 'win32' ? (await fs.stat(path.join(payloadPath, 'readme.md'))).mode & 0o777 : 0o600)

  assert.deepEqual(await trash.restore(result.id), { success: true, path: 'project' })
  assert.equal(await fs.readFile(path.join(original, 'readme.md'), 'utf8'), '# notes')
  assert.equal(await fs.readFile(path.join(original, '.obsidian', 'workspace.json'), 'utf8'), '{"layout":true}')
  assert.deepEqual(await trash.list(), [])
})

test('restore refuses to overwrite an item created at the original path', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'original')
  const trash = createTrashService(workspace, { recoveryRoot: recovery })
  const { id } = await trash.trash('note.md')
  await fs.writeFile(path.join(workspace, 'note.md'), 'newer')

  await assert.rejects(trash.restore(id), error => error.code === 'CONFLICT')
  assert.equal(await fs.readFile(path.join(workspace, 'note.md'), 'utf8'), 'newer')
  assert.equal((await trash.list()).length, 1)
})

test('restore refuses a file created after parent validation', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'trashed')
  const normal = createTrashService(workspace, { recoveryRoot: recovery })
  const { id } = await normal.trash('note.md')
  const racing = createTrashService(workspace, {
    recoveryRoot: recovery,
    beforeRestoreCommit: async () => fs.writeFile(path.join(workspace, 'note.md'), 'newer'),
  })

  await assert.rejects(racing.restore(id), error => error.code === 'CONFLICT')
  assert.equal(await fs.readFile(path.join(workspace, 'note.md'), 'utf8'), 'newer')
  assert.equal((await normal.list()).length, 1)
})

test('file restore copies exclusively when hard links are unavailable', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'trashed')
  const normal = createTrashService(workspace, { recoveryRoot: recovery })
  const { id } = await normal.trash('note.md')
  const fallback = createTrashService(workspace, {
    recoveryRoot: recovery,
    async linkFile() {
      const error = new Error('hard links unavailable')
      error.code = 'EXDEV'
      throw error
    },
  })

  assert.deepEqual(await fallback.restore(id), { success: true, path: 'note.md' })
  assert.equal(await fs.readFile(path.join(workspace, 'note.md'), 'utf8'), 'trashed')
  assert.deepEqual(await normal.list(), [])
})

test('restore refuses a directory populated after parent validation', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  await fs.mkdir(path.join(workspace, 'folder'))
  await fs.writeFile(path.join(workspace, 'folder', 'old.md'), 'trashed')
  const normal = createTrashService(workspace, { recoveryRoot: recovery })
  const { id } = await normal.trash('folder')
  const racing = createTrashService(workspace, {
    recoveryRoot: recovery,
    async beforeRestoreCommit() {
      await fs.mkdir(path.join(workspace, 'folder'))
      await fs.writeFile(path.join(workspace, 'folder', 'new.md'), 'newer')
    },
  })

  await assert.rejects(racing.restore(id), error => error.code === 'CONFLICT')
  assert.equal(await fs.readFile(path.join(workspace, 'folder', 'new.md'), 'utf8'), 'newer')
  assert.equal((await normal.list()).length, 1)
})

test('restore rejects a parent replaced by a symlink after validation', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const { workspace, recovery } = await workspaceFixture(t)
  const outside = await tempDirectory(t, 'standalone-editor-trash-outside-')
  await fs.mkdir(path.join(workspace, 'folder'))
  await fs.writeFile(path.join(workspace, 'folder', 'note.md'), 'trashed')
  const normal = createTrashService(workspace, { recoveryRoot: recovery })
  const { id } = await normal.trash('folder/note.md')
  await fs.writeFile(path.join(outside, 'note.md'), 'outside value')
  const racing = createTrashService(workspace, {
    recoveryRoot: recovery,
    async beforeRestoreCommit() {
      await fs.rename(path.join(workspace, 'folder'), path.join(workspace, 'held'))
      await fs.symlink(outside, path.join(workspace, 'folder'))
    },
  })

  await assert.rejects(racing.restore(id), error => error.code === 'INVALID_PATH')
  assert.equal(await fs.readFile(path.join(outside, 'note.md'), 'utf8'), 'outside value')
  assert.equal((await normal.list()).length, 1)
})

test('trash rejects symlinks without moving the source', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const { workspace, recovery } = await workspaceFixture(t)
  const outside = path.join(path.dirname(workspace), 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.md'), 'secret')
  await fs.mkdir(path.join(workspace, 'linked-folder'))
  await fs.symlink(path.join(outside, 'secret.md'), path.join(workspace, 'linked-folder', 'secret-link'))
  const trash = createTrashService(workspace, { recoveryRoot: recovery })

  await assert.rejects(trash.trash('linked-folder'), error => error.code === 'INVALID_PATH')
  assert.equal(await fs.readFile(path.join(workspace, 'linked-folder', 'secret-link'), 'utf8'), 'secret')
  assert.deepEqual(await trash.list(), [])
})

test('EXDEV uses a verified copy before removing the original', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  await fs.mkdir(path.join(workspace, 'folder'))
  await fs.writeFile(path.join(workspace, 'folder', '.hidden'), 'kept')
  await fs.writeFile(path.join(workspace, 'folder', 'normal.md'), 'kept too')
  const source = await fs.realpath(path.join(workspace, 'folder'))
  let simulated = false
  const rename = async (from, to) => {
    if (!simulated && from === source && to.endsWith(`${path.sep}payload`)) {
      simulated = true
      const error = new Error('simulated device boundary')
      error.code = 'EXDEV'
      throw error
    }
    return fs.rename(from, to)
  }
  const trash = createTrashService(workspace, { recoveryRoot: recovery, rename })

  const result = await trash.trash('folder')
  assert.equal(simulated, true)
  await assert.rejects(fs.lstat(source), error => error.code === 'ENOENT')
  const entry = (await trash.list()).find(item => item.id === result.id)
  assert.ok(entry)
  assert.equal(entry.state, 'ready')
  assert.equal(await trash.restore(result.id).then(() => fs.readFile(path.join(source, '.hidden'), 'utf8')), 'kept')
  assert.equal(await fs.readFile(path.join(source, 'normal.md'), 'utf8'), 'kept too')
})

test('EXDEV preserves and restores a source changed after copy verification, then removes the staged entry', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  const sourcePath = path.join(workspace, 'folder')
  await fs.mkdir(sourcePath)
  const source = await fs.realpath(sourcePath)
  const note = path.join(source, 'note.md')
  await fs.writeFile(note, 'version copied to recovery')
  let simulatedExdev = false
  let concurrentEditApplied = false
  const rename = async (from, to) => {
    if (!simulatedExdev && from === source && to.endsWith(`${path.sep}payload`)) {
      simulatedExdev = true
      const error = new Error('simulated device boundary')
      error.code = 'EXDEV'
      throw error
    }
    if (
      simulatedExdev && !concurrentEditApplied && from === source &&
      path.basename(to).startsWith('.trash-pending-')
    ) {
      // This is after the source and recovery copy were verified, immediately
      // before the source is moved aside for the delete decision.
      concurrentEditApplied = true
      await fs.writeFile(note, 'external edit after copy verification')
    }
    return fs.rename(from, to)
  }
  const trash = createTrashService(workspace, { recoveryRoot: recovery, rename })

  await assert.rejects(trash.trash('folder'), error => error.code === 'FILE_CHANGED')
  assert.equal(simulatedExdev, true)
  assert.equal(concurrentEditApplied, true)
  assert.equal(await fs.readFile(note, 'utf8'), 'external edit after copy verification')
  assert.deepEqual(await fs.readdir(workspace), ['folder'])
  assert.deepEqual(await trash.list(), [], 'the stale staged payload and ready manifest must be rolled back')
})

test('EXDEV retains the verified recovery payload when source cleanup partially deletes then fails', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  const source = path.join(workspace, 'folder')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'first.md'), 'first original')
  await fs.writeFile(path.join(source, 'second.md'), 'second original')
  const realSource = await fs.realpath(source)
  let simulatedExdev = false
  const rename = async (from, to) => {
    if (!simulatedExdev && from === realSource && to.endsWith(`${path.sep}payload`)) {
      simulatedExdev = true
      const error = new Error('simulated device boundary')
      error.code = 'EXDEV'
      throw error
    }
    return fs.rename(from, to)
  }
  const trash = createTrashService(workspace, { recoveryRoot: recovery, rename })
  const originalRm = fs.rm
  let cleanupInjected = false
  fs.rm = async (target, options) => {
    if (path.basename(target).startsWith('.trash-pending-')) {
      cleanupInjected = true
      await fs.unlink(path.join(target, 'first.md'))
      const error = new Error('simulated partial recursive cleanup')
      error.code = 'EIO'
      throw error
    }
    return originalRm.call(fs, target, options)
  }

  let failure
  try {
    await assert.rejects(trash.trash('folder'), error => {
      failure = error
      return error.code === 'EIO' && error.details?.trashEntryId &&
        error.details.restoredSourcePath === 'folder' && error.details.recoveryCopyRetained === true
    })
  } finally {
    fs.rm = originalRm
  }

  assert.equal(simulatedExdev, true)
  assert.equal(cleanupInjected, true)
  assert.deepEqual(await fs.readdir(source), ['second.md'], 'the incomplete source is restored to its original path')
  assert.equal(await fs.readFile(path.join(source, 'second.md'), 'utf8'), 'second original')
  assert.deepEqual(await fs.readdir(workspace), ['folder'], 'the quarantine sibling is no longer left behind')
  const entries = await trash.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, failure.details.trashEntryId)
  assert.equal(entries[0].state, 'ready')

  const workspaceHash = (await fs.readdir(path.join(recovery, 'trash')))[0]
  const payload = path.join(recovery, 'trash', workspaceHash, failure.details.trashEntryId, 'payload')
  assert.deepEqual((await fs.readdir(payload)).sort(), ['first.md', 'second.md'])
  assert.equal(await fs.readFile(path.join(payload, 'first.md'), 'utf8'), 'first original')
  assert.equal(await fs.readFile(path.join(payload, 'second.md'), 'utf8'), 'second original')
})

test('a rebuilt service restores a fully verified pending quarantine and retains its recovery copy', async t => {
  const fixture = await pendingFileFixture(t)
  const restarted = createTrashService(fixture.workspace, { recoveryRoot: fixture.recovery })
  assert.equal((await restarted.list())[0].pendingRecovery, true)

  const result = await restarted.reconcilePending()

  assert.deepEqual(result, { restored: [{ id: fixture.id, path: 'folder/.hidden-note.md' }], completed: [], issues: [] })
  assert.equal(await fs.readFile(fixture.source, 'utf8'), 'recover this exact hidden note')
  await assert.rejects(fs.lstat(fixture.quarantinePath), error => error.code === 'ENOENT')
  assert.equal((await restarted.list()).length, 1, 'the complete recovery payload remains available')
  assert.equal((await restarted.list())[0].pendingRecovery, false)
  const manifest = JSON.parse(await fs.readFile(path.join(fixture.entryDirectory, 'entry.json'), 'utf8'))
  assert.equal(manifest.sourceRemoval, undefined)
})

test('pending quarantine does not overwrite a reused original path', async t => {
  const fixture = await pendingFileFixture(t, { occupied: true })
  const trash = createTrashService(fixture.workspace, { recoveryRoot: fixture.recovery })

  const result = await trash.reconcilePending()

  assert.equal(result.restored.length, 0)
  assert.equal(result.issues[0].code, 'RESTORE_PATH_OCCUPIED')
  assert.equal(await fs.readFile(fixture.source, 'utf8'), 'new user content')
  assert.equal(await fs.readFile(fixture.quarantinePath, 'utf8'), 'recover this exact hidden note')
  await assert.rejects(trash.restore(fixture.id), error => error.code === 'TRASH_OPERATION_PENDING')
  await assert.rejects(trash.remove(fixture.id), error => error.code === 'TRASH_OPERATION_PENDING')
  assert.equal((await trash.purgeExpired({ at: new Date('2100-01-01T00:00:00.000Z') })).purged, 0)
})

test('pending quarantine changed after interruption is preserved with its verified recovery copy', async t => {
  const fixture = await pendingFileFixture(t, { phase: 'cleanup' })
  await fs.writeFile(fixture.quarantinePath, 'external edit after interruption')
  const trash = createTrashService(fixture.workspace, { recoveryRoot: fixture.recovery })

  const result = await trash.reconcilePending()

  assert.equal(result.restored.length, 0)
  assert.equal(result.issues[0].code, 'QUARANTINE_CHANGED')
  assert.equal(await fs.readFile(fixture.quarantinePath, 'utf8'), 'external edit after interruption')
  assert.equal(await fs.readFile(fixture.payloadPath, 'utf8'), 'recover this exact hidden note')
})

test('pending identity checks preserve inode values above the JavaScript safe integer limit', async t => {
  const fixture = await pendingFileFixture(t)
  const manifestPath = path.join(fixture.entryDirectory, 'entry.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const largeDev = '9007199254740997'
  const largeIno = '9007199254741011'
  const realWorkspace = await fs.realpath(fixture.workspace)
  const realSource = path.join(realWorkspace, 'folder/.hidden-note.md')
  const realQuarantine = path.join(realWorkspace, 'folder', path.basename(fixture.quarantinePath))
  const realPayload = await fs.realpath(fixture.payloadPath)
  manifest.sourceRemoval.sourceIdentity.dev = largeDev
  manifest.sourceRemoval.sourceIdentity.ino = largeIno
  manifest.sourceRemoval.payloadIdentity.dev = largeDev
  manifest.sourceRemoval.payloadIdentity.ino = String(BigInt(largeIno) + 1n)
  await fs.writeFile(manifestPath, JSON.stringify(manifest))

  const originalLstat = fs.lstat
  const largeIdentity = (stat, dev, ino) => new Proxy(stat, {
    get(target, property) {
      if (property === 'dev') return BigInt(dev)
      if (property === 'ino') return BigInt(ino)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  fs.lstat = async (target, options) => {
    const stat = await originalLstat(target, options)
    if (!options?.bigint) return stat
    if (target === realQuarantine || target === realSource) {
      return largeIdentity(stat, largeDev, largeIno)
    }
    if (target === realPayload) {
      return largeIdentity(stat, largeDev, String(BigInt(largeIno) + 1n))
    }
    return stat
  }

  let result
  try {
    result = await createTrashService(fixture.workspace, { recoveryRoot: fixture.recovery }).reconcilePending()
  } finally {
    fs.lstat = originalLstat
  }
  assert.deepEqual(result, { restored: [{ id: fixture.id, path: 'folder/.hidden-note.md' }], completed: [], issues: [] })
  assert.equal(await fs.readFile(fixture.source, 'utf8'), 'recover this exact hidden note')
})

test('prepared phase with the original intact clears the intent without scanning hidden workspace entries', async t => {
  const fixture = await pendingFileFixture(t, { phase: 'prepared', putInQuarantine: false })
  const unrelated = path.join(fixture.workspace, `.trash-pending-${randomUUID()}`)
  await fs.writeFile(unrelated, 'untracked hidden item')
  const trash = createTrashService(fixture.workspace, { recoveryRoot: fixture.recovery })

  const result = await trash.reconcilePending()

  assert.equal(result.issues[0].code, 'SOURCE_UNCHANGED')
  assert.equal(await fs.readFile(fixture.source, 'utf8'), 'recover this exact hidden note')
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'untracked hidden item')
  const manifest = JSON.parse(await fs.readFile(path.join(fixture.entryDirectory, 'entry.json'), 'utf8'))
  assert.equal(manifest.sourceRemoval, undefined)
})

test('cleanup phase with a fully intact quarantine is restored, while a missing source is only committed in cleanup phase', async t => {
  const intact = await pendingFileFixture(t, { phase: 'cleanup' })
  const restored = await createTrashService(intact.workspace, { recoveryRoot: intact.recovery }).reconcilePending()
  assert.equal(restored.restored[0].id, intact.id)
  assert.equal(await fs.readFile(intact.source, 'utf8'), 'recover this exact hidden note')

  const alreadyRestored = await pendingFileFixture(t, { phase: 'quarantined' })
  await fs.rename(alreadyRestored.quarantinePath, alreadyRestored.source)
  const confirmedRestore = await createTrashService(alreadyRestored.workspace, { recoveryRoot: alreadyRestored.recovery }).reconcilePending()
  assert.deepEqual(confirmedRestore.restored, [{ id: alreadyRestored.id, path: 'folder/.hidden-note.md' }])

  const completed = await pendingFileFixture(t, { phase: 'cleanup' })
  await fs.rm(completed.quarantinePath)
  const result = await createTrashService(completed.workspace, { recoveryRoot: completed.recovery }).reconcilePending()
  assert.deepEqual(result.completed, [{ id: completed.id, path: 'folder/.hidden-note.md' }])
  assert.equal(await fs.readFile(completed.payloadPath, 'utf8'), 'recover this exact hidden note')
})

test('invalid journal paths and symlinked workspace parents are retained as issues', async t => {
  const invalid = await pendingFileFixture(t)
  const invalidManifestPath = path.join(invalid.entryDirectory, 'entry.json')
  const invalidManifest = JSON.parse(await fs.readFile(invalidManifestPath, 'utf8'))
  invalidManifest.sourceRemoval.sourceQuarantinePath = '../outside/.trash-pending-evil'
  await fs.writeFile(invalidManifestPath, JSON.stringify(invalidManifest))
  const invalidResult = await createTrashService(invalid.workspace, { recoveryRoot: invalid.recovery }).reconcilePending()
  assert.equal(invalidResult.issues[0].code, 'INVALID_TRASH_JOURNAL')
  assert.equal(await fs.readFile(invalid.quarantinePath, 'utf8'), 'recover this exact hidden note')

  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const linked = await pendingFileFixture(t)
  const outside = await tempDirectory(t, 'standalone-editor-trash-reconcile-outside-')
  const movedParent = path.join(linked.workspace, 'held-folder')
  await fs.rename(path.join(linked.workspace, 'folder'), movedParent)
  await fs.symlink(outside, path.join(linked.workspace, 'folder'))
  const linkedResult = await createTrashService(linked.workspace, { recoveryRoot: linked.recovery }).reconcilePending()
  assert.equal(linkedResult.issues[0].code, 'INVALID_PATH')
  assert.equal(await fs.readFile(path.join(movedParent, path.basename(linked.quarantinePath)), 'utf8'), 'recover this exact hidden note')
})

test('a quarantine without a matching recovery manifest is never discovered or removed', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  const pending = path.join(workspace, `.trash-pending-${randomUUID()}`)
  await fs.mkdir(pending)
  await fs.writeFile(path.join(pending, '.hidden'), 'must remain')
  const trash = createTrashService(workspace, { recoveryRoot: recovery })

  assert.deepEqual(await trash.reconcilePending(), { restored: [], completed: [], issues: [] })
  assert.equal(await fs.readFile(path.join(pending, '.hidden'), 'utf8'), 'must remain')
  await assert.rejects(fs.lstat(recovery), error => error.code === 'ENOENT', 'read-only reconciliation does not create recovery directories')
})

test('reconciliation reports recovery entry and manifest visibility errors instead of treating them as absent', async t => {
  for (const targetKind of ['entry directory', 'manifest']) {
    await t.test(targetKind, async t => {
      const fixture = await pendingFileFixture(t)
      const realEntryDirectory = await fs.realpath(fixture.entryDirectory)
      const inaccessiblePath = targetKind === 'entry directory'
        ? realEntryDirectory
        : path.join(realEntryDirectory, 'entry.json')
      const errorCode = targetKind === 'entry directory' ? 'EACCES' : 'EIO'
      const originalLstat = fs.lstat
      fs.lstat = async (target, options) => {
        if (target === inaccessiblePath) {
          const error = new Error('simulated recovery metadata visibility error')
          error.code = errorCode
          throw error
        }
        return originalLstat(target, options)
      }

      let result
      try {
        result = await createTrashService(fixture.workspace, { recoveryRoot: fixture.recovery }).reconcilePending()
      } finally {
        fs.lstat = originalLstat
      }
      assert.equal(result.restored.length, 0)
      assert.equal(result.issues.length, 1)
      assert.equal(result.issues[0].id, fixture.id)
      assert.equal(result.issues[0].code, errorCode)
      assert.equal(await fs.readFile(fixture.quarantinePath, 'utf8'), 'recover this exact hidden note')
      assert.equal(await fs.readFile(fixture.payloadPath, 'utf8'), 'recover this exact hidden note')
    })
  }
})

test('SIGKILL after a simulated EXDEV copy and real quarantine rename is recovered after service restart', async t => {
  const { outer, workspace, recovery } = await workspaceFixture(t)
  const source = path.join(workspace, 'folder')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, '.hidden-note.md'), 'preserve after worker termination')
  const realSource = await fs.realpath(source)
  const workerPath = path.join(outer, 'trash-crash-worker.mjs')
  const serviceUrl = new URL('../src/trashService.js', import.meta.url).href
  await fs.writeFile(workerPath, `
    import fs from 'node:fs/promises'
    import path from 'node:path'
    const { createTrashService } = await import(process.argv[2])
    const [serviceUrl, workspace, recovery, source] = process.argv.slice(2)
    let injectedExdev = false
    const rename = async (from, to) => {
      if (!injectedExdev && from === source && to.endsWith(path.sep + 'payload')) {
        injectedExdev = true
        const error = new Error('simulated device boundary')
        error.code = 'EXDEV'
        throw error
      }
      if (injectedExdev && from === source && path.basename(to).startsWith('.trash-pending-')) {
        await fs.rename(from, to)
        await new Promise(resolve => process.send({ quarantinePath: to }, resolve))
        setInterval(() => {}, 1000)
        await new Promise(() => {})
      }
      return fs.rename(from, to)
    }
    await createTrashService(workspace, { recoveryRoot: recovery, rename }).trash('folder')
  `)
  const child = fork(workerPath, [serviceUrl, workspace, recovery, realSource], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    execArgv: [],
  })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const exit = once(child, 'exit')
  const event = await Promise.race([
    once(child, 'message').then(([message]) => ({ type: 'message', message })),
    exit.then(([code, signal]) => ({ type: 'exit', code, signal })),
  ])
  assert.equal(event.type, 'message', `worker exited before quarantine rename (${event.code ?? event.signal})`)
  const message = event.message
  assert.equal(path.basename(message.quarantinePath).startsWith('.trash-pending-'), true)
  child.kill('SIGKILL')
  const [code, signal] = await exit
  assert.equal(code, null)
  assert.equal(signal, 'SIGKILL')

  const trashDirectory = path.join(recovery, 'trash', createHash('sha256').update(await fs.realpath(workspace)).digest('hex'))
  const [id] = await fs.readdir(trashDirectory)
  const restarted = createTrashService(workspace, { recoveryRoot: recovery })
  const result = await restarted.reconcilePending()

  assert.deepEqual(result.restored, [{ id, path: 'folder' }])
  assert.equal(await fs.readFile(path.join(source, '.hidden-note.md'), 'utf8'), 'preserve after worker termination')
  assert.equal((await restarted.list()).length, 1)
})

test('a failed EXDEV copy leaves the source untouched and creates no trash entry', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  const original = path.join(workspace, 'important.md')
  await fs.writeFile(original, 'must survive')
  const rename = async () => {
    const error = new Error('simulated device boundary')
    error.code = 'EXDEV'
    throw error
  }
  const copyFile = async () => { throw new Error('simulated recovery disk failure') }
  const trash = createTrashService(workspace, { recoveryRoot: recovery, rename, copyFile })

  await assert.rejects(trash.trash('important.md'), /recovery disk failure/)
  assert.equal(await fs.readFile(original, 'utf8'), 'must survive')
  assert.deepEqual(await trash.list(), [])
})

test('recovery storage inside the selected workspace is rejected', async t => {
  const { workspace } = await workspaceFixture(t)
  const trash = createTrashService(workspace, { recoveryRoot: path.join(workspace, '.app-recovery') })
  await fs.writeFile(path.join(workspace, 'note.md'), 'safe')

  await assert.rejects(trash.trash('note.md'), error => error.code === 'INVALID_RECOVERY_ROOT')
  assert.equal(await fs.readFile(path.join(workspace, 'note.md'), 'utf8'), 'safe')
})
