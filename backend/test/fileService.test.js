import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  listAll,
  hasWorkspaceFiles,
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
  openBinaryFile,
  restoreFileHistory,
  uploadFile,
  MAX_EDITABLE_MARKDOWN_BYTES,
  MAX_MARKDOWN_PREVIEW_BYTES,
} from '../src/fileService.js'
import { getRecoveryStats } from '../src/recoveryStatsService.js'

async function temporaryWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-editor-test-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  return workspace
}

async function temporaryUploadWorkspace(t, name) {
  const root = process.env.N03_UPLOAD_TEST_ROOT || os.tmpdir()
  await fs.mkdir(root, { recursive: true })
  const container = await fs.mkdtemp(path.join(root, `${name}-`))
  const workspace = path.join(container, 'workspace')
  await fs.mkdir(workspace)
  t.after(() => fs.rm(container, { recursive: true, force: true }))
  return workspace
}

function revision(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function historyBucketFor(workspace, recovery, relative = 'note.md') {
  return path.join(
    await fs.realpath(recovery),
    'history',
    createHash('sha256').update(await fs.realpath(workspace)).digest('hex'),
    createHash('sha256').update(relative).digest('hex'),
  )
}

function setHighInode(stat, index, options = {}) {
  const device = 9_007_199_254_740_992n
  const inode = device + BigInt(index)
  stat.dev = options.bigint ? device : Number(device)
  stat.ino = options.bigint ? inode : Number(inode)
  return stat
}

async function replaceFileWithSameBytes(filePath, bytes) {
  const replacement = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.replacement`
  await fs.writeFile(replacement, bytes, { flag: 'wx', mode: 0o600 })
  await fs.unlink(filePath)
  await fs.rename(replacement, filePath)
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

test('atomic writes honor a read-only file even when its parent directory is writable', async t => {
  if (process.getuid?.() === 0) return t.skip('root bypasses POSIX file permission bits')
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const filePath = path.join(workspace, 'read-only.md')
  await fs.writeFile(filePath, 'original')
  t.after(() => fs.chmod(filePath, 0o600).catch(() => {}))
  await fs.chmod(filePath, 0o444)

  await assert.rejects(
    writeFile(workspace, 'read-only.md', 'replacement', revision('original'), { root: recovery }),
    error => ['EACCES', 'EPERM'].includes(error.code),
  )
  assert.equal(await fs.readFile(filePath, 'utf8'), 'original')
})

test('new atomic writes default to owner-only permissions', async t => {
  const workspace = await temporaryWorkspace(t)

  await writeFile(workspace, 'new.md', 'draft', null)

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(workspace, 'new.md'))).mode & 0o777, 0o600)
  }
})

test('write, sync, rename, and link failures preserve the old file and remove only owned temporaries', async t => {
  const cases = [
    { name: 'stat', operation: 'stat', existing: true },
    { name: 'write', operation: 'write', existing: true },
    { name: 'sync', operation: 'sync', existing: true },
    { name: 'rename', operation: 'rename', existing: true },
    { name: 'link', operation: 'link', existing: false },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async t => {
      const workspace = await temporaryWorkspace(t)
      const recovery = await temporaryRecovery(t)
      const target = path.join(workspace, 'note.md')
      if (scenario.existing) await fs.writeFile(target, 'original', { mode: 0o640 })
      const expectedRevision = scenario.existing ? revision('original') : null
      const injected = Object.assign(new Error(`injected ${scenario.name} failure`), { code: 'EIO' })
      let temporaryHandleClosed = false
      const fileSystem = {
        open: async (...args) => {
          const handle = await fs.open(...args)
          return {
            stat: (...statArgs) => scenario.operation === 'stat'
              ? Promise.reject(injected)
              : handle.stat(...statArgs),
            writeFile: (...writeArgs) => scenario.operation === 'write'
              ? Promise.reject(injected)
              : handle.writeFile(...writeArgs),
            chmod: (...chmodArgs) => handle.chmod(...chmodArgs),
            sync: () => scenario.operation === 'sync' ? Promise.reject(injected) : handle.sync(),
            close: async () => {
              await handle.close()
              temporaryHandleClosed = true
            },
          }
        },
        rename: (...args) => scenario.operation === 'rename' ? Promise.reject(injected) : fs.rename(...args),
        link: (...args) => scenario.operation === 'link' ? Promise.reject(injected) : fs.link(...args),
        unlink: (...args) => fs.unlink(...args),
      }

      let failure
      await assert.rejects(
        writeFile(workspace, 'note.md', 'replacement', expectedRevision, { root: recovery, fileSystem }),
        error => {
          failure = error
          return error === injected
        },
      )
      if (scenario.operation === 'stat') {
        assert.equal(temporaryHandleClosed, true, 'the opened temporary file descriptor must close when fstat fails')
        assert.equal(failure.details.temporaryCleanupError.code, 'TEMPORARY_IDENTITY_UNAVAILABLE')
      }
      if (scenario.existing) {
        assert.equal(await fs.readFile(target, 'utf8'), 'original')
        const history = await listFileHistory(workspace, 'note.md', { root: recovery })
        assert.deepEqual(history.history, [], 'a failed replacement must not add an unnecessary copy of the still-current file')
        if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
      } else {
        await assert.rejects(fs.lstat(target), error => error.code === 'ENOENT')
      }
      const temporaryNames = (await fs.readdir(workspace)).filter(name => name.endsWith('.tmp'))
      if (scenario.operation === 'stat') {
        // Without a verified inode identity cleanup cannot safely distinguish
        // our temp pathname from a concurrent replacement, so retain it.
        assert.equal(temporaryNames.length, 1)
        assert.equal((await fs.stat(path.join(workspace, temporaryNames[0]))).size, 0)
      } else {
        assert.deepEqual(temporaryNames, [])
      }
    })
  }
})

test('failed saves at the 50-entry limit keep every recovery point and do not duplicate the current version', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const target = path.join(workspace, 'note.md')
  await fs.writeFile(target, 'version-0')
  let current = await readFile(workspace, 'note.md')
  for (let version = 1; version <= 51; version += 1) {
    const saved = await writeFile(workspace, 'note.md', `version-${version}`, current.revision, { root: recovery })
    current = { revision: saved.revision }
  }

  const before = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.equal(before.history.length, 50)
  assert.ok(before.history.some(entry => entry.revision === revision('version-1')))
  const beforeIds = new Set(before.history.map(entry => entry.id))
  const injected = Object.assign(new Error('injected temporary sync failure'), { code: 'EIO' })
  const fileSystem = {
    open: async (...args) => {
      const handle = await fs.open(...args)
      return {
        stat: (...rest) => handle.stat(...rest),
        writeFile: (...rest) => handle.writeFile(...rest),
        chmod: (...rest) => handle.chmod(...rest),
        sync: async () => { throw injected },
        close: () => handle.close(),
      }
    },
    rename: (...args) => fs.rename(...args),
    link: (...args) => fs.link(...args),
    unlink: (...args) => fs.unlink(...args),
  }

  await assert.rejects(
    writeFile(workspace, 'note.md', 'sync-failed', current.revision, { root: recovery, fileSystem }),
    error => error === injected,
  )
  assert.equal(await fs.readFile(target, 'utf8'), 'version-51')
  assert.deepEqual(new Set((await listFileHistory(workspace, 'note.md', { root: recovery })).history.map(entry => entry.id)), beforeIds)

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await fs.chmod(workspace, 0o555)
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(
          writeFile(workspace, 'note.md', `permission-failed-${attempt}`, current.revision, { root: recovery }),
          error => error.code === 'EACCES',
        )
      }
    } finally {
      await fs.chmod(workspace, 0o755)
    }
  } else {
    t.diagnostic(process.platform === 'win32'
      ? 'Skipped chmod-based EACCES checks because POSIX directory permission bits do not apply on Windows'
      : 'Skipped chmod-based EACCES checks because root bypasses POSIX directory permissions')
  }

  const after = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.equal(after.history.length, 50)
  assert.deepEqual(new Set(after.history.map(entry => entry.id)), beforeIds)
  assert.equal(after.history.filter(entry => entry.revision === current.revision).length, 0)
  assert.equal((await readFile(workspace, 'note.md')).content, 'version-51')
})

test('failed retries leave prior history intact when the unchanged current bytes appeared earlier', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const target = path.join(workspace, 'note.md')
  await fs.writeFile(target, 'version A')
  const first = await readFile(workspace, 'note.md')
  const second = await writeFile(workspace, 'note.md', 'version B', first.revision, { root: recovery })
  const third = await writeFile(workspace, 'note.md', 'version A', second.revision, { root: recovery })
  const before = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.equal(before.history.filter(entry => entry.revision === first.revision).length, 1)
  const beforeIds = new Set(before.history.map(entry => entry.id))
  const injected = Object.assign(new Error('injected temporary sync failure'), { code: 'EIO' })
  const fileSystem = {
    open: async (...args) => {
      const handle = await fs.open(...args)
      return {
        stat: (...rest) => handle.stat(...rest),
        writeFile: (...rest) => handle.writeFile(...rest),
        chmod: (...rest) => handle.chmod(...rest),
        sync: async () => { throw injected },
        close: () => handle.close(),
      }
    },
    rename: (...args) => fs.rename(...args),
    link: (...args) => fs.link(...args),
    unlink: (...args) => fs.unlink(...args),
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      writeFile(workspace, 'note.md', `failed-${attempt}`, third.revision, { root: recovery, fileSystem }),
      error => error === injected,
    )
  }
  const after = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.deepEqual(new Set(after.history.map(entry => entry.id)), beforeIds)
  assert.equal(after.history.filter(entry => entry.revision === first.revision).length, 1)
  assert.equal((await readFile(workspace, 'note.md')).content, 'version A')
})

test('a failed history cleanup leaves one reusable newest snapshot for subsequent retries', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const target = path.join(workspace, 'note.md')
  await fs.writeFile(target, 'original')
  const opened = await readFile(workspace, 'note.md')
  const injectedSync = Object.assign(new Error('injected temporary sync failure'), { code: 'EIO' })
  const fileSystem = {
    open: async (...args) => {
      const handle = await fs.open(...args)
      return {
        stat: (...rest) => handle.stat(...rest),
        writeFile: (...rest) => handle.writeFile(...rest),
        chmod: (...rest) => handle.chmod(...rest),
        sync: async () => { throw injectedSync },
        close: () => handle.close(),
      }
    },
    rename: (...args) => fs.rename(...args),
    link: (...args) => fs.link(...args),
    unlink: (...args) => fs.unlink(...args),
  }

  const originalUnlink = fs.unlink.bind(fs)
  let cleanupFailureInjected = false
  fs.unlink = async targetPath => {
    if (!cleanupFailureInjected && /^[0-9a-f-]{36}\.json$/.test(path.basename(String(targetPath)))) {
      cleanupFailureInjected = true
      throw Object.assign(new Error('injected recovery record cleanup failure'), { code: 'EACCES' })
    }
    return originalUnlink(targetPath)
  }
  try {
    await assert.rejects(
      writeFile(workspace, 'note.md', 'replacement-0', opened.revision, { root: recovery, fileSystem }),
      error => error === injectedSync,
    )
  } finally {
    fs.unlink = originalUnlink
  }
  assert.equal(cleanupFailureInjected, true)
  const retained = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.equal(retained.history.length, 1)
  assert.equal(retained.history[0].revision, opened.revision)
  const retainedId = retained.history[0].id

  for (let attempt = 1; attempt < 3; attempt += 1) {
    await assert.rejects(
      writeFile(workspace, 'note.md', `replacement-${attempt}`, opened.revision, { root: recovery, fileSystem }),
      error => error === injectedSync,
    )
  }
  const after = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.deepEqual(after.history.map(entry => entry.id), [retainedId])
  assert.equal(await fs.readFile(target, 'utf8'), 'original')
})

test('failed-write snapshot discard preserves a same-byte replacement with an adjacent high inode', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const target = path.join(workspace, 'note.md')
  await fs.writeFile(target, 'original')
  const opened = await readFile(workspace, 'note.md')
  const injected = Object.assign(new Error('injected temporary sync failure'), { code: 'EIO' })
  const fileSystem = {
    open: async (...args) => {
      const handle = await fs.open(...args)
      return {
        stat: (...rest) => handle.stat(...rest),
        writeFile: (...rest) => handle.writeFile(...rest),
        chmod: (...rest) => handle.chmod(...rest),
        sync: async () => { throw injected },
        close: () => handle.close(),
      }
    },
    rename: (...args) => fs.rename(...args),
    link: (...args) => fs.link(...args),
    unlink: (...args) => fs.unlink(...args),
  }

  const bucket = await historyBucketFor(workspace, recovery)
  const nativeLstat = fs.lstat.bind(fs)
  const nativeReadFile = fs.readFile.bind(fs)
  let recordPath
  let identityReads = 0
  let replacementDone = false
  let preservedRecordBytes
  const warnings = []
  fs.lstat = async (...args) => {
    const stat = await nativeLstat(...args)
    if (
      args[1]?.bigint && path.dirname(path.resolve(String(args[0]))) === bucket &&
      String(args[0]).endsWith('.json')
    ) {
      recordPath = path.resolve(String(args[0]))
      identityReads += 1
      setHighInode(stat, identityReads - 1, args[1])
    }
    return stat
  }
  fs.readFile = async (...args) => {
    const bytes = await nativeReadFile(...args)
    if (recordPath && path.resolve(String(args[0])) === recordPath && !replacementDone) {
      replacementDone = true
      preservedRecordBytes = Buffer.from(bytes)
      await replaceFileWithSameBytes(recordPath, bytes)
    }
    return bytes
  }
  try {
    await assert.rejects(
      writeFile(workspace, 'note.md', 'replacement', opened.revision, {
        root: recovery,
        fileSystem,
        logger: { warn: entry => warnings.push(entry) },
      }),
      error => {
        assert.equal(error, injected)
        assert.equal(error.details.recoveryCleanupWarning.code, 'RECOVERY_RECORD_CHANGED')
        return true
      },
    )
  } finally {
    fs.lstat = nativeLstat
    fs.readFile = nativeReadFile
  }

  assert.equal(replacementDone, true)
  assert.equal(identityReads, 2)
  assert.deepEqual(warnings, [{ event: 'recovery_history_cleanup_failed', path: 'note.md', code: 'RECOVERY_RECORD_CHANGED' }])
  assert.equal(await fs.readFile(target, 'utf8'), 'original')
  const history = (await listFileHistory(workspace, 'note.md', { root: recovery })).history
  assert.equal(history.length, 1)
  assert.equal(history[0].revision, opened.revision)
  assert.deepEqual(await fs.readFile(recordPath), preservedRecordBytes)
})

test('a post-commit prune failure warns without failing the save and a later save prunes retained history', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const target = path.join(workspace, 'note.md')
  await fs.writeFile(target, 'version-0')
  let current = await readFile(workspace, 'note.md')
  for (let version = 1; version <= 50; version += 1) {
    current = await writeFile(workspace, 'note.md', `version-${version}`, current.revision, { root: recovery })
  }

  const before = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.equal(before.history.length, 50)
  const oldest = before.history.at(-1)
  const bucket = await historyBucketFor(workspace, recovery)
  const oldestPath = path.join(bucket, `${oldest.id}.json`)
  const oldestEntry = JSON.parse(await fs.readFile(oldestPath, 'utf8'))
  oldestEntry.savedAt = '2000-01-01T00:00:00.000Z'
  await fs.writeFile(oldestPath, JSON.stringify(oldestEntry))
  const retainedBytes = await fs.readFile(oldestPath)

  const originalUnlink = fs.unlink.bind(fs)
  const logEntries = []
  let pruneFailureInjected = false
  fs.unlink = async targetPath => {
    if (!pruneFailureInjected && path.resolve(String(targetPath)) === oldestPath) {
      pruneFailureInjected = true
      throw Object.assign(new Error('injected recovery prune failure'), { code: 'EACCES' })
    }
    return originalUnlink(targetPath)
  }
  let saved
  try {
    saved = await writeFile(workspace, 'note.md', 'version-51', current.revision, {
      root: recovery,
      logger: {
        warn(entry) {
          logEntries.push(entry)
          throw new Error('injected logger failure')
        },
      },
    })
  } finally {
    fs.unlink = originalUnlink
  }

  assert.equal(pruneFailureInjected, true)
  assert.equal(saved.success, true)
  assert.equal(saved.recoveryCleanupWarning.code, 'EACCES')
  assert.match(saved.recoveryCleanupWarning.message, /当前保存已成功/)
  assert.deepEqual(logEntries, [{ event: 'recovery_history_cleanup_failed', path: 'note.md', code: 'EACCES' }])
  assert.equal(await fs.readFile(target, 'utf8'), 'version-51')
  assert.deepEqual(await fs.readFile(oldestPath), retainedBytes)
  const retained = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.equal(retained.history.length, 51)
  assert.ok(retained.history.some(entry => entry.id === oldest.id))

  const retried = await writeFile(workspace, 'note.md', 'version-52', saved.revision, { root: recovery })
  assert.equal(retried.success, true)
  assert.equal('recoveryCleanupWarning' in retried, false)
  const cleaned = await listFileHistory(workspace, 'note.md', { root: recovery })
  assert.equal(cleaned.history.length, 50)
  assert.ok(!cleaned.history.some(entry => entry.id === oldest.id))
  assert.equal((await readFile(workspace, 'note.md')).content, 'version-52')
})

test('a malformed single history record stops pruning and is reported without failing the save', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'version one')
  const first = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'version two', first.revision, { root: recovery })
  const second = await readFile(workspace, 'note.md')
  const existingRecord = (await listFileHistory(workspace, 'note.md', { root: recovery })).history[0]
  const brokenPath = path.join(await historyBucketFor(workspace, recovery), `${existingRecord.id}.json`)
  const brokenBytes = Buffer.from('{broken history record')
  await fs.writeFile(brokenPath, brokenBytes)
  const logEntries = []

  const saved = await writeFile(workspace, 'note.md', 'version three', second.revision, {
    root: recovery,
    logger: { warn: entry => logEntries.push(entry) },
  })

  assert.equal(saved.success, true)
  assert.equal(saved.recoveryCleanupWarning.code, 'RECOVERY_HISTORY_RECORD_INVALID')
  assert.deepEqual(logEntries, [{
    event: 'recovery_history_cleanup_failed',
    path: 'note.md',
    code: 'RECOVERY_HISTORY_RECORD_INVALID',
  }])
  assert.deepEqual(await fs.readFile(brokenPath), brokenBytes)
  assert.equal((await readFile(workspace, 'note.md')).content, 'version three')
  assert.equal((await listFileHistory(workspace, 'note.md', { root: recovery })).history.length, 1)
})

test('history pruning keeps a same-byte replacement with an adjacent high inode', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'version-0')
  let current = await readFile(workspace, 'note.md')
  for (let version = 1; version <= 50; version += 1) {
    current = await writeFile(workspace, 'note.md', `version-${version}`, current.revision, { root: recovery })
  }

  const oldest = (await listFileHistory(workspace, 'note.md', { root: recovery })).history.at(-1)
  const bucket = await historyBucketFor(workspace, recovery)
  const oldestPath = path.join(bucket, `${oldest.id}.json`)
  const oldestEntry = JSON.parse(await fs.readFile(oldestPath, 'utf8'))
  oldestEntry.savedAt = '2000-01-01T00:00:00.000Z'
  await fs.writeFile(oldestPath, JSON.stringify(oldestEntry))
  const originalBytes = await fs.readFile(oldestPath)
  const nativeLstat = fs.lstat.bind(fs)
  const nativeReadFile = fs.readFile.bind(fs)
  let identityReads = 0
  let replacementDone = false
  fs.lstat = async (...args) => {
    const stat = await nativeLstat(...args)
    if (path.resolve(String(args[0])) === oldestPath && args[1]?.bigint) {
      identityReads += 1
      setHighInode(stat, identityReads - 1, args[1])
    }
    return stat
  }
  fs.readFile = async (...args) => {
    const bytes = await nativeReadFile(...args)
    if (path.resolve(String(args[0])) === oldestPath && identityReads > 0 && !replacementDone) {
      replacementDone = true
      await replaceFileWithSameBytes(oldestPath, bytes)
    }
    return bytes
  }
  let saved
  try {
    saved = await writeFile(workspace, 'note.md', 'version-51', current.revision, {
      root: recovery,
      logger: { warn: () => {} },
    })
  } finally {
    fs.lstat = nativeLstat
    fs.readFile = nativeReadFile
  }

  assert.equal(replacementDone, true)
  assert.equal(identityReads, 2)
  assert.equal(saved.success, true)
  assert.equal(saved.recoveryCleanupWarning.code, 'RECOVERY_RECORD_CHANGED')
  assert.deepEqual(await fs.readFile(oldestPath), originalBytes)
  assert.ok((await listFileHistory(workspace, 'note.md', { root: recovery })).history.some(entry => entry.id === oldest.id))
  assert.equal((await readFile(workspace, 'note.md')).content, 'version-51')
})

test('a later A-to-C save records a fresh recent A snapshot after A-to-B-to-A', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'version A')
  const first = await readFile(workspace, 'note.md')
  const second = await writeFile(workspace, 'note.md', 'version B', first.revision, { root: recovery })
  const firstA = (await listFileHistory(workspace, 'note.md', { root: recovery })).history[0]
  assert.equal(firstA.revision, first.revision)

  const third = await writeFile(workspace, 'note.md', 'version A', second.revision, { root: recovery })
  await new Promise(resolve => setTimeout(resolve, 10))
  await writeFile(workspace, 'note.md', 'version C', third.revision, { root: recovery })

  const history = (await listFileHistory(workspace, 'note.md', { root: recovery })).history
  const aSnapshots = history.filter(entry => entry.revision === first.revision)
  assert.equal(history.length, 3)
  assert.equal(aSnapshots.length, 2)
  assert.notEqual(aSnapshots[0].id, aSnapshots[1].id)
  assert.equal(history[0].revision, first.revision)
  assert.notEqual(history[0].id, firstA.id)
  assert.ok(Date.parse(history[0].savedAt) > Date.parse(firstA.savedAt))
})

test('failed cleanup reports the error and leaves a replacement inode untouched', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const target = path.join(workspace, 'note.md')
  await fs.writeFile(target, 'original')
  const injected = Object.assign(new Error('injected rename failure'), { code: 'EIO' })
  let foreignTempPath
  const fileSystem = {
    open: (...args) => fs.open(...args),
    rename: async temporary => {
      foreignTempPath = `${temporary}.owned-moved-aside`
      await fs.rename(temporary, foreignTempPath)
      await fs.writeFile(temporary, 'foreign inode')
      throw injected
    },
    link: (...args) => fs.link(...args),
    unlink: (...args) => fs.unlink(...args),
  }

  await assert.rejects(
    writeFile(workspace, 'note.md', 'replacement', revision('original'), { root: recovery, fileSystem }),
    error => error === injected && Boolean(error.details?.temporaryCleanupError?.message),
  )
  assert.equal(await fs.readFile(target, 'utf8'), 'original')
  assert.equal(await fs.readFile(path.join(workspace, path.basename(foreignTempPath).replace('.owned-moved-aside', '')), 'utf8'), 'foreign inode')
  assert.equal(await fs.readFile(foreignTempPath, 'utf8'), 'replacement')
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

test('failed uploads keep partial bytes hidden, preserve the error, and allow same-name retries', async t => {
  for (const operation of ['write', 'sync', 'close', 'link', 'commit']) {
    await t.test(operation, async t => {
      const workspace = await temporaryUploadWorkspace(t, `failure-${operation}`)
      const injected = Object.assign(new Error(`injected ${operation} failure`), { code: 'EIO' })
      const fileSystem = {
        open: async (...args) => {
          const handle = await fs.open(...args)
          if (!String(args[0]).endsWith('.upload.tmp')) return handle
          return {
            stat: (...statArgs) => handle.stat(...statArgs),
            read: (...readArgs) => handle.read(...readArgs),
            writeFile: async bytes => {
              if (operation === 'write') {
                await handle.write(Buffer.from(bytes).subarray(0, 3))
                throw injected
              }
              return handle.writeFile(bytes)
            },
            sync: () => operation === 'sync' ? Promise.reject(injected) : handle.sync(),
            close: async () => {
              await handle.close()
              if (operation === 'close') throw injected
            },
          }
        },
        link: async (...args) => {
          if (operation === 'link') throw injected
          await fs.link(...args)
          if (operation === 'commit') throw injected
        },
        unlink: (...args) => fs.unlink(...args),
      }

      await assert.rejects(
        uploadFile(workspace, '', { originalname: 'attachment.bin', buffer: Buffer.from('0123456789') }, { fileSystem }),
        error => error === injected,
      )
      await assert.rejects(fs.lstat(path.join(workspace, 'attachment.bin')), error => error.code === 'ENOENT')
      assert.deepEqual((await fs.readdir(workspace)).filter(name => name.endsWith('.upload.tmp')), [])

      await uploadFile(workspace, '', { originalname: 'attachment.bin', buffer: Buffer.from('0123456789') })
      assert.equal(await fs.readFile(path.join(workspace, 'attachment.bin'), 'utf8'), '0123456789')
    })
  }
})

test('failed upload cleanup leaves only a hidden residual and reports its error', async t => {
  const workspace = await temporaryUploadWorkspace(t, 'cleanup-failure')
  const writeError = Object.assign(new Error('injected partial upload write failure'), { code: 'EIO' })
  const cleanupError = Object.assign(new Error('injected temporary cleanup failure'), { code: 'EACCES' })
  const fileSystem = {
    open: async (...args) => {
      const handle = await fs.open(...args)
      if (!String(args[0]).endsWith('.upload.tmp')) return handle
      return {
        stat: (...statArgs) => handle.stat(...statArgs),
        read: (...readArgs) => handle.read(...readArgs),
        writeFile: async bytes => {
          await handle.write(Buffer.from(bytes).subarray(0, 3))
          throw writeError
        },
        sync: (...syncArgs) => handle.sync(...syncArgs),
        close: (...closeArgs) => handle.close(...closeArgs),
      }
    },
    link: (...args) => fs.link(...args),
    unlink: (...args) => String(args[0]).endsWith('.upload.tmp')
      ? Promise.reject(cleanupError)
      : fs.unlink(...args),
  }

  await assert.rejects(
    uploadFile(workspace, '', { originalname: 'attachment.bin', buffer: Buffer.from('0123456789') }, { fileSystem }),
    error => error === writeError && error.details?.temporaryCleanupError?.code === 'EACCES',
  )
  await assert.rejects(fs.lstat(path.join(workspace, 'attachment.bin')), error => error.code === 'ENOENT')
  const residuals = (await fs.readdir(workspace)).filter(name => name.endsWith('.upload.tmp'))
  assert.equal(residuals.length, 1)
  assert.equal((await fs.readFile(path.join(workspace, residuals[0]), 'utf8')), '012')
})

test('upload cleanup leaves a replaced temporary pathname untouched', async t => {
  const workspace = await temporaryUploadWorkspace(t, 'replaced-temporary')
  const writeError = Object.assign(new Error('injected partial upload write failure'), { code: 'EIO' })
  const fileSystem = {
    open: async (...args) => {
      const handle = await fs.open(...args)
      if (!String(args[0]).endsWith('.upload.tmp')) return handle
      return {
        stat: (...statArgs) => handle.stat(...statArgs),
        read: (...readArgs) => handle.read(...readArgs),
        writeFile: async bytes => {
          await handle.write(Buffer.from(bytes).subarray(0, 3))
          const temporary = String(args[0])
          await fs.rename(temporary, `${temporary}.moved-by-actor`)
          await fs.writeFile(temporary, 'foreign temporary replacement', { flag: 'wx' })
          throw writeError
        },
        sync: (...syncArgs) => handle.sync(...syncArgs),
        close: (...closeArgs) => handle.close(...closeArgs),
      }
    },
    link: (...args) => fs.link(...args),
    unlink: (...args) => fs.unlink(...args),
  }

  await assert.rejects(
    uploadFile(workspace, '', { originalname: 'attachment.bin', buffer: Buffer.from('0123456789') }, { fileSystem }),
    error => error === writeError && error.details?.temporaryCleanupError?.code === 'INVALID_PATH',
  )
  await assert.rejects(fs.lstat(path.join(workspace, 'attachment.bin')), error => error.code === 'ENOENT')
  const residual = (await fs.readdir(workspace)).find(name => name.endsWith('.upload.tmp'))
  assert.ok(residual)
  assert.equal(await fs.readFile(path.join(workspace, residual), 'utf8'), 'foreign temporary replacement')
})

test('a concurrent upload winner is preserved when exclusive publication conflicts', async t => {
  const workspace = await temporaryUploadWorkspace(t, 'concurrent-winner')
  const fileSystem = {
    open: (...args) => fs.open(...args),
    link: async (temporary, destination) => {
      await fs.writeFile(destination, 'concurrent winner', { flag: 'wx' })
      return fs.link(temporary, destination)
    },
    unlink: (...args) => fs.unlink(...args),
  }

  await assert.rejects(
    uploadFile(workspace, '', { originalname: 'attachment.bin', buffer: Buffer.from('upload') }, { fileSystem }),
    error => error.code === 'CONFLICT',
  )
  assert.equal(await fs.readFile(path.join(workspace, 'attachment.bin'), 'utf8'), 'concurrent winner')
  assert.deepEqual((await fs.readdir(workspace)).filter(name => name.endsWith('.upload.tmp')), [])
})

test('a successful link followed by an external rewrite cannot report upload success', async t => {
  const workspace = await temporaryUploadWorkspace(t, 'published-external-rewrite')
  const uploaded = Buffer.from('0123456789')
  const external = Buffer.from('ABCDEFGHIJ')
  const fileSystem = {
    open: (...args) => fs.open(...args),
    link: async (temporary, destination) => {
      await fs.link(temporary, destination)
      await fs.writeFile(destination, external)
    },
    unlink: (...args) => fs.unlink(...args),
  }

  await assert.rejects(
    uploadFile(workspace, '', { originalname: 'attachment.bin', buffer: uploaded }, { fileSystem }),
    error => error.code === 'UPLOAD_VERIFY_FAILED' && Boolean(error.details?.publishedFileCleanupError),
  )
  assert.deepEqual(await fs.readFile(path.join(workspace, 'attachment.bin')), external)
})

test('an ambiguous link error preserves a same-length external rewrite', async t => {
  const workspace = await temporaryUploadWorkspace(t, 'same-length-rewrite')
  const injected = Object.assign(new Error('injected post-link commit error'), { code: 'EIO' })
  const uploaded = Buffer.from('0123456789')
  const external = Buffer.from('ABCDEFGHIJ')
  const fileSystem = {
    open: (...args) => fs.open(...args),
    link: async (temporary, destination) => {
      await fs.link(temporary, destination)
      await fs.writeFile(destination, external)
      throw injected
    },
    unlink: (...args) => fs.unlink(...args),
  }

  await assert.rejects(
    uploadFile(workspace, '', { originalname: 'attachment.bin', buffer: uploaded }, { fileSystem }),
    error => error === injected &&
      error.details?.publishedFileCleanupError?.code === 'UPLOAD_VERIFY_FAILED' &&
      error.details?.temporaryCleanupError?.code === 'UPLOAD_VERIFY_FAILED',
  )
  assert.deepEqual(await fs.readFile(path.join(workspace, 'attachment.bin')), external)
  const residual = (await fs.readdir(workspace)).find(name => name.endsWith('.upload.tmp'))
  assert.ok(residual)
  assert.deepEqual(await fs.readFile(path.join(workspace, residual)), external)
})

test('a concurrent symlink target survives exclusive publication conflict', async t => {
  if (process.platform === 'win32') return t.skip('requires symlink creation permission')
  const workspace = await temporaryUploadWorkspace(t, 'concurrent-symlink')
  const outside = path.join(path.dirname(workspace), 'outside.bin')
  await fs.writeFile(outside, 'outside original')
  const fileSystem = {
    open: (...args) => fs.open(...args),
    link: async (temporary, destination) => {
      await fs.symlink(outside, destination)
      return fs.link(temporary, destination)
    },
    unlink: (...args) => fs.unlink(...args),
  }

  await assert.rejects(
    uploadFile(workspace, '', { originalname: 'attachment.bin', buffer: Buffer.from('upload') }, { fileSystem }),
    error => error.code === 'CONFLICT',
  )
  assert.equal((await fs.lstat(path.join(workspace, 'attachment.bin'))).isSymbolicLink(), true)
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside original')
  assert.deepEqual((await fs.readdir(workspace)).filter(name => name.endsWith('.upload.tmp')), [])
})

test('a replaced destination parent stops publication and leaves only the displaced hidden temporary', async t => {
  const root = process.env.N03_UPLOAD_TEST_ROOT || os.tmpdir()
  await fs.mkdir(root, { recursive: true })
  const container = await fs.mkdtemp(path.join(root, 'replaced-parent-'))
  const workspace = path.join(container, 'workspace')
  const displaced = path.join(container, 'workspace-displaced')
  await fs.mkdir(workspace)
  t.after(() => fs.rm(container, { recursive: true, force: true }))
  let parentReplaced = false
  const fileSystem = {
    open: async (...args) => {
      const handle = await fs.open(...args)
      if (!parentReplaced && String(args[0]).endsWith('.upload.tmp')) {
        parentReplaced = true
        await fs.rename(workspace, displaced)
        await fs.mkdir(workspace)
      }
      return handle
    },
    link: (...args) => fs.link(...args),
    unlink: (...args) => fs.unlink(...args),
  }

  await assert.rejects(
    uploadFile(workspace, '', { originalname: 'attachment.bin', buffer: Buffer.from('upload') }, { fileSystem }),
    error => error.code === 'INVALID_PATH' && Boolean(error.details?.temporaryCleanupError),
  )
  assert.deepEqual(await fs.readdir(workspace), [])
  assert.equal((await fs.readdir(displaced)).filter(name => name.endsWith('.upload.tmp')).length, 1)
})

test('uploads fail clearly when hard-link publication is unsupported', async t => {
  const workspace = await temporaryUploadWorkspace(t, 'unsupported-link')
  const unsupported = Object.assign(new Error('hard links are unavailable'), { code: 'EOPNOTSUPP' })
  const fileSystem = {
    open: (...args) => fs.open(...args),
    link: () => Promise.reject(unsupported),
    unlink: (...args) => fs.unlink(...args),
  }

  await assert.rejects(
    uploadFile(workspace, '', { originalname: 'attachment.bin', buffer: Buffer.from('upload') }, { fileSystem }),
    error => error.code === 'UNSUPPORTED_UPLOAD_FILESYSTEM' && error.details?.causeCode === 'EOPNOTSUPP' && error.cause === unsupported,
  )
  await assert.rejects(fs.lstat(path.join(workspace, 'attachment.bin')), error => error.code === 'ENOENT')
  assert.deepEqual((await fs.readdir(workspace)).filter(name => name.endsWith('.upload.tmp')), [])
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

test('workspace file presence checks ignore hidden, symlink, and empty directory entries', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.mkdir(path.join(workspace, 'empty-folder'))
  await fs.mkdir(path.join(workspace, '.hidden'))
  await fs.writeFile(path.join(workspace, '.hidden', 'secret.md'), 'hidden')
  assert.equal(await hasWorkspaceFiles(workspace), false)

  await fs.mkdir(path.join(workspace, 'visible-folder'))
  await fs.writeFile(path.join(workspace, 'visible-folder', 'note.md'), 'visible')
  assert.equal(await hasWorkspaceFiles(workspace), true)
})

test('recursive tree keeps readable siblings when one child directory is unreadable', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('permission bits are not enforced here')
  const workspace = await temporaryWorkspace(t)
  const unreadable = path.join(workspace, 'restricted')
  await fs.mkdir(unreadable)
  await fs.writeFile(path.join(unreadable, 'hidden.md'), 'private')
  await fs.mkdir(path.join(workspace, 'readable'))
  await fs.writeFile(path.join(workspace, 'readable', 'visible.md'), 'visible')
  await fs.chmod(unreadable, 0o000)
  try {
    const tree = await listTree(workspace)
    assert.ok(tree.some(item => item.path === 'readable/visible.md'))
    assert.ok(tree.some(item => item.path === 'restricted' && item.type === 'dir'))
    assert.ok(!tree.some(item => item.path === 'restricted/hidden.md'))
  } finally {
    await fs.chmod(unreadable, 0o700)
  }
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

test('history deletion keeps a same-byte replacement when adjacent inode values exceed Number precision', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const notePath = path.join(workspace, 'note.md')
  await fs.writeFile(notePath, 'version one')
  const first = await readFile(workspace, 'note.md')
  await writeFile(workspace, 'note.md', 'version two', first.revision, { root: recovery })
  const record = (await listFileHistory(workspace, 'note.md', { root: recovery })).history[0]
  const entryPath = path.join(await historyBucketFor(workspace, recovery), `${record.id}.json`)
  const originalRecordBytes = await fs.readFile(entryPath)
  const nativeLstat = fs.lstat.bind(fs)
  const nativeReadFile = fs.readFile.bind(fs)
  let identityReads = 0
  let replacementDone = false
  fs.lstat = async (...args) => {
    const stat = await nativeLstat(...args)
    if (path.resolve(String(args[0])) === entryPath) {
      identityReads += 1
      setHighInode(stat, identityReads - 1, args[1] || {})
    }
    return stat
  }
  fs.readFile = async (...args) => {
    const bytes = await nativeReadFile(...args)
    if (path.resolve(String(args[0])) === entryPath && !replacementDone) {
      replacementDone = true
      await replaceFileWithSameBytes(entryPath, bytes)
    }
    return bytes
  }
  try {
    await assert.rejects(
      deleteFileHistory(workspace, 'note.md', record.id, { root: recovery }),
      error => error.code === 'HISTORY_NOT_FOUND',
    )
  } finally {
    fs.lstat = nativeLstat
    fs.readFile = nativeReadFile
  }

  assert.equal(replacementDone, true)
  assert.equal(identityReads, 2)
  assert.deepEqual(await fs.readFile(entryPath), originalRecordBytes)
  assert.equal(JSON.parse(await fs.readFile(entryPath, 'utf8')).id, record.id)
  assert.equal((await readFile(workspace, 'note.md')).content, 'version two')
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

test('move refuses a destination created after its initial collision check', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.writeFile(path.join(workspace, 'source.md'), 'source')
  await fs.writeFile(path.join(workspace, 'target.md'), 'old occupant')
  const old = await readFile(workspace, 'target.md')
  await writeFile(workspace, 'target.md', 'old updated', old.revision, { root: recovery })
  await fs.unlink(path.join(workspace, 'target.md'))
  let injected = false

  await assert.rejects(moveItem(workspace, 'source.md', 'target.md', {
    root: recovery,
    async moveHistoryBucket(from, to) {
      injected = true
      await fs.writeFile(path.join(workspace, 'target.md'), 'concurrent occupant')
      await fs.rename(from, to)
    },
  }), error => error.code === 'CONFLICT')

  assert.equal(injected, true)
  assert.equal(await fs.readFile(path.join(workspace, 'source.md'), 'utf8'), 'source')
  assert.equal(await fs.readFile(path.join(workspace, 'target.md'), 'utf8'), 'concurrent occupant')
})

test('file move uses an exclusive verified copy when hard links are unavailable', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.writeFile(path.join(workspace, 'source.md'), 'copy fallback', { mode: 0o640 })
  const unavailableLink = async () => {
    const error = new Error('hard links unavailable')
    error.code = 'ENOTSUP'
    throw error
  }

  await moveItem(workspace, 'source.md', 'target.md', { linkFile: unavailableLink })

  await assert.rejects(fs.lstat(path.join(workspace, 'source.md')), error => error.code === 'ENOENT')
  assert.equal(await fs.readFile(path.join(workspace, 'target.md'), 'utf8'), 'copy fallback')
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(workspace, 'target.md'))).mode & 0o777, 0o640)
})

test('file move copy fallback preserves a same-inode same-size source modification', async t => {
  const workspace = await temporaryWorkspace(t)
  const sourcePath = path.join(workspace, 'source.md')
  const original = 'same-length-original'
  const replacement = 'same-length-changed!'
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement))
  await fs.writeFile(sourcePath, original)
  const originalStat = await fs.stat(sourcePath, { bigint: true })
  const unavailableLink = async () => {
    await fs.writeFile(sourcePath, replacement)
    await fs.utimes(sourcePath, originalStat.atime, new Date('2000-01-01T00:00:00Z'))
    const error = new Error('hard links unavailable')
    error.code = 'ENOTSUP'
    throw error
  }

  await assert.rejects(moveItem(workspace, 'source.md', 'target.md', { linkFile: unavailableLink }), error =>
    error.code === 'INVALID_PATH' && error.message === '文件在复制前发生变化')

  assert.equal(await fs.readFile(sourcePath, 'utf8'), replacement)
  await assert.rejects(fs.lstat(path.join(workspace, 'target.md')), error => error.code === 'ENOENT')
})

test('file move copy fallback does not replace a concurrent destination or remove its source', async t => {
  const workspace = await temporaryWorkspace(t)
  const sourcePath = path.join(workspace, 'source.md')
  const targetPath = path.join(workspace, 'target.md')
  await fs.writeFile(sourcePath, 'source remains')
  const unavailableLink = async (_source, destination) => {
    await fs.writeFile(destination, 'concurrent target')
    const error = new Error('hard links unavailable')
    error.code = 'ENOTSUP'
    throw error
  }

  await assert.rejects(moveItem(workspace, 'source.md', 'target.md', { linkFile: unavailableLink }), error =>
    error.code === 'CONFLICT')

  assert.equal(await fs.readFile(sourcePath, 'utf8'), 'source remains')
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'concurrent target')
})

test('directory move refuses a populated destination created after its initial check', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.mkdir(path.join(workspace, 'source'))
  await fs.writeFile(path.join(workspace, 'source', 'child.md'), 'source')
  await fs.mkdir(path.join(workspace, 'target'))
  await fs.writeFile(path.join(workspace, 'target', 'old.md'), 'old')
  const old = await readFile(workspace, 'target/old.md')
  await writeFile(workspace, 'target/old.md', 'old updated', old.revision, { root: recovery })
  await fs.rm(path.join(workspace, 'target'), { recursive: true })
  let injected = false

  await assert.rejects(moveItem(workspace, 'source', 'target', {
    root: recovery,
    async moveHistoryBucket(from, to) {
      injected = true
      await fs.mkdir(path.join(workspace, 'target'))
      await fs.writeFile(path.join(workspace, 'target', 'concurrent.md'), 'concurrent')
      await fs.rename(from, to)
    },
  }), error => error.code === 'HISTORY_ARCHIVE_ROLLBACK_FAILED' && error.cause?.code === 'CONFLICT')

  assert.equal(injected, true)
  assert.equal(await fs.readFile(path.join(workspace, 'source', 'child.md'), 'utf8'), 'source')
  assert.equal(await fs.readFile(path.join(workspace, 'target', 'concurrent.md'), 'utf8'), 'concurrent')
})

test('move rejects a source parent replaced by a symlink during history archiving', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const workspace = await temporaryWorkspace(t)
  const outside = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  await fs.mkdir(path.join(workspace, 'folder'))
  await fs.writeFile(path.join(workspace, 'folder', 'source.md'), 'source')
  await fs.writeFile(path.join(workspace, 'target.md'), 'old occupant')
  const old = await readFile(workspace, 'target.md')
  await writeFile(workspace, 'target.md', 'old updated', old.revision, { root: recovery })
  await fs.unlink(path.join(workspace, 'target.md'))
  await fs.writeFile(path.join(outside, 'source.md'), 'outside value')
  let swapped = false

  await assert.rejects(moveItem(workspace, 'folder/source.md', 'target.md', {
    root: recovery,
    async moveHistoryBucket(from, to) {
      if (!swapped) {
        swapped = true
        await fs.rename(path.join(workspace, 'folder'), path.join(workspace, 'held'))
        await fs.symlink(outside, path.join(workspace, 'folder'))
      }
      await fs.rename(from, to)
    },
  }), error => error.code === 'HISTORY_ARCHIVE_ROLLBACK_FAILED' && error.cause?.code === 'INVALID_PATH')

  assert.equal(await fs.readFile(path.join(outside, 'source.md'), 'utf8'), 'outside value')
  assert.equal(await fs.readFile(path.join(workspace, 'held', 'source.md'), 'utf8'), 'source')
  await assert.rejects(fs.lstat(path.join(workspace, 'target.md')), error => error.code === 'ENOENT')
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

test('Markdown previews become read-only above 5 MiB and stop reading above 10 MiB', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const previewPath = path.join(workspace, 'large.md')
  const exact = 'x'.repeat(MAX_EDITABLE_MARKDOWN_BYTES)
  const accepted = await writeFile(workspace, 'exact-limit.md', exact, null, { root: recovery })
  assert.equal(accepted.success, true)
  assert.equal((await fs.stat(path.join(workspace, 'exact-limit.md'))).size, MAX_EDITABLE_MARKDOWN_BYTES)

  const oversizedBytes = Buffer.alloc(MAX_EDITABLE_MARKDOWN_BYTES + 1, 0x78)
  await fs.writeFile(previewPath, oversizedBytes)

  const preview = await readFile(workspace, 'large.md')
  assert.equal(preview.editable, false)
  assert.equal(preview.previewAvailable, true)
  assert.equal(preview.size, oversizedBytes.byteLength)
  assert.equal(preview.content.length, oversizedBytes.byteLength)
  assert.match(preview.revision, /^[a-f0-9]{64}$/)

  const tooLargePath = path.join(workspace, 'download-only.md')
  await fs.writeFile(tooLargePath, '')
  await fs.truncate(tooLargePath, MAX_MARKDOWN_PREVIEW_BYTES + 1)
  const downloadOnly = await readFile(workspace, 'download-only.md')
  assert.equal(downloadOnly.editable, false)
  assert.equal(downloadOnly.previewAvailable, false)
  assert.equal(downloadOnly.content, null)
  assert.equal(downloadOnly.revision, null)
  assert.equal(downloadOnly.size, MAX_MARKDOWN_PREVIEW_BYTES + 1)

  await assert.rejects(
    writeFile(workspace, 'new.md', '界'.repeat(Math.floor(MAX_EDITABLE_MARKDOWN_BYTES / 3)) + 'xxx', null, { root: recovery }),
    error => error.code === 'DOCUMENT_TOO_LARGE' && error.details.size > MAX_EDITABLE_MARKDOWN_BYTES,
  )
  await assert.rejects(
    writeFile(workspace, 'large.md', 'replacement', preview.revision, { root: recovery }),
    error => error.code === 'DOCUMENT_TOO_LARGE',
  )
  await assert.rejects(
    restoreFileHistory(workspace, 'large.md', '00000000-0000-4000-8000-000000000000', preview.revision, { root: recovery }),
    error => error.code === 'DOCUMENT_TOO_LARGE',
  )
  assert.equal((await fs.stat(previewPath)).size, oversizedBytes.byteLength)
})

test('history restore bounds Base64 before decoding even when legacy size metadata is missing', async t => {
  const workspace = await temporaryWorkspace(t)
  const recovery = await temporaryRecovery(t)
  const target = path.join(workspace, 'note.md')
  await fs.writeFile(target, 'before')
  const opened = await readFile(workspace, 'note.md')
  const current = await writeFile(workspace, 'note.md', 'current', opened.revision, { root: recovery })
  const [historyEntry] = (await listFileHistory(workspace, 'note.md', { root: recovery })).history
  const bucket = path.join(
    recovery,
    'history',
    createHash('sha256').update(await fs.realpath(workspace)).digest('hex'),
    createHash('sha256').update('note.md').digest('hex'),
  )
  const entryPath = path.join(bucket, `${historyEntry.id}.json`)
  const entry = JSON.parse(await fs.readFile(entryPath, 'utf8'))
  delete entry.size

  // The first payload exceeds the predecode encoded-length bound. The second
  // is within that bound but decodes to one byte over the editable limit.
  entry.contentBase64 = Buffer.alloc(MAX_EDITABLE_MARKDOWN_BYTES + 2).toString('base64')
  await fs.writeFile(entryPath, JSON.stringify(entry))
  await assert.rejects(
    restoreFileHistory(workspace, 'note.md', historyEntry.id, current.revision, { root: recovery }),
    error => error.code === 'DOCUMENT_TOO_LARGE' && error.details.size > MAX_EDITABLE_MARKDOWN_BYTES,
  )

  entry.contentBase64 = Buffer.alloc(MAX_EDITABLE_MARKDOWN_BYTES + 1).toString('base64')
  await fs.writeFile(entryPath, JSON.stringify(entry))
  await assert.rejects(
    restoreFileHistory(workspace, 'note.md', historyEntry.id, current.revision, { root: recovery }),
    error => error.code === 'DOCUMENT_TOO_LARGE' && error.details.size === MAX_EDITABLE_MARKDOWN_BYTES + 1,
  )
  assert.equal(await fs.readFile(target, 'utf8'), 'current')
})

test('binary streams enforce image types and close the opened handle on cancellation', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.writeFile(path.join(workspace, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const opened = await openBinaryFile(workspace, 'pixel.png', { imagesOnly: true })
  assert.equal(opened.mime, 'image/png')
  assert.equal(opened.size, 4)
  const closed = new Promise(resolve => opened.stream.once('close', resolve))
  opened.stream.destroy()
  await closed

  await assert.rejects(openBinaryFile(workspace, 'missing.txt', { imagesOnly: true }), error => error.code === 'UNSUPPORTED_FILE_TYPE' || error.code === 'ENOENT')
})

test('binary streams stay within the opened size for concurrent append and empty files', async t => {
  const workspace = await temporaryWorkspace(t)
  const target = path.join(workspace, 'attachment.bin')
  await fs.writeFile(target, Buffer.from('before'))
  const opened = await openBinaryFile(workspace, 'attachment.bin')
  await fs.appendFile(target, Buffer.from('-after'))
  const chunks = []
  for await (const chunk of opened.stream) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), Buffer.from('before'))
  assert.equal(opened.size, Buffer.byteLength('before'))

  const emptyPath = path.join(workspace, 'empty.bin')
  await fs.writeFile(emptyPath, Buffer.alloc(0))
  const empty = await openBinaryFile(workspace, 'empty.bin')
  await fs.writeFile(emptyPath, Buffer.from('appended after open'))
  const emptyChunks = []
  for await (const chunk of empty.stream) emptyChunks.push(chunk)
  assert.equal(empty.size, 0)
  assert.equal(Buffer.concat(emptyChunks).byteLength, 0)
})
