import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createBackend } from '../src/index.js'
import { createHttpServer } from '../src/httpServer.js'

const hash = value => createHash('sha256').update(value).digest('hex')

async function fixture(t, { beforeInitialize } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-recovery-maintenance-api-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'notes')
  const recoveryRoot = path.join(root, 'recovery')
  await fs.mkdir(workspace)
  await beforeInitialize?.({ root, workspace, recoveryRoot })
  const backend = createBackend({
    argv: [], workspace, configFile: path.join(root, 'workspace.json'), recoveryRoot,
    host: '127.0.0.1', port: 0,
    env: { ...process.env, ALLOW_ANY_WORKSPACE: '1', CORS_ORIGINS: '*' },
  })
  await backend.initialize()
  const server = createHttpServer(backend.app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}`
  const info = backend.currentWorkspaceInfo()
  const headers = {
    'X-Workspace-Id': info.workspaceId, 'X-Workspace-Version': String(info.workspaceVersion),
    'Content-Type': 'application/json',
  }
  return { root, workspace: info.workspace, recoveryRoot, url, headers, backend }
}

async function seedPendingFile(workspace, recoveryRoot, { occupied = false } = {}) {
  const originalPath = 'note.md'
  const source = path.join(workspace, originalPath)
  const content = 'recover this exact note'
  await fs.writeFile(source, content, { mode: 0o600 })
  const sourceStat = await fs.lstat(source, { bigint: true })
  const contentHash = hash(content)
  const mode = Number(sourceStat.mode & 0o777n)
  const treeHash = hash(`${JSON.stringify(['', 'file', Buffer.byteLength(content), mode, contentHash])}\n`)
  const id = randomUUID()
  const realWorkspace = await fs.realpath(workspace)
  const workspaceId = hash(realWorkspace)
  const entryDirectory = path.join(recoveryRoot, 'trash', workspaceId, id)
  const payload = path.join(entryDirectory, 'payload')
  const quarantine = path.join(workspace, `.trash-pending-${id}`)
  await fs.mkdir(entryDirectory, { recursive: true, mode: 0o700 })
  await fs.copyFile(source, payload)
  await fs.chmod(payload, mode)
  const payloadStat = await fs.lstat(payload, { bigint: true })
  const identity = stat => ({
    dev: String(stat.dev), ino: String(stat.ino), type: 'file', mode: Number(stat.mode & 0o777n),
  })
  await fs.rename(source, quarantine)
  if (occupied) await fs.writeFile(source, 'newer user content')
  const created = new Date()
  await fs.writeFile(path.join(entryDirectory, 'entry.json'), JSON.stringify({
    version: 1,
    id,
    workspaceId,
    originalPath,
    type: 'file',
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    state: 'ready',
    sourceRemoval: {
      version: 1,
      phase: 'quarantined',
      sourceQuarantinePath: `.trash-pending-${id}`,
      sourceIdentity: identity(sourceStat),
      payloadIdentity: identity(payloadStat),
      treeFingerprint: { entries: 1, sha256: treeHash },
    },
  }, null, 2), { mode: 0o600 })
  return { id, source, quarantine, entryDirectory, payload, content }
}

test('history cleanup warnings stay separate from successful saves and remain visible until a real retry', async t => {
  const { workspace, recoveryRoot, url, headers } = await fixture(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'one')
  const save = async (content, expectedRevision) => {
    const response = await fetch(`${url}/api/workspace`, {
      method: 'PUT', headers, body: JSON.stringify({ path: 'note.md', content, expectedRevision }),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  await save('two', hash('one'))
  const bucket = path.join(recoveryRoot, 'history', hash(workspace), hash('note.md'))
  const invalidRecord = path.join(bucket, `${randomUUID()}.json`)
  await fs.writeFile(invalidRecord, 'invalid JSON')
  const saved = await save('three', hash('two'))
  assert.equal(saved.success, true)
  assert.ok(saved.recoveryCleanupWarning)
  assert.equal(await fs.readFile(path.join(workspace, 'note.md'), 'utf8'), 'three')
  const stats = () => fetch(`${url}/api/workspace/recovery/stats`, { headers }).then(response => response.json())
  assert.equal((await stats()).maintenance.historyCleanupWarnings[0].path, 'note.md')
  await save('three', hash('three'))
  assert.equal((await stats()).maintenance.historyCleanupWarnings.length, 1, 'an unchanged save cannot clear a warning')
  await fs.unlink(invalidRecord)
  const retried = await save('four', hash('three'))
  assert.equal(retried.recoveryCleanupWarning, undefined)
  assert.equal((await stats()).maintenance.historyCleanupWarnings.length, 0)
})

test('startup reconciliation leaves unused recovery storage absent and its retry is workspace guarded', async t => {
  const { recoveryRoot, url, headers, backend } = await fixture(t)
  await assert.rejects(fs.stat(recoveryRoot), error => error.code === 'ENOENT')
  assert.deepEqual(backend.currentWorkspaceInfo().recoveryMaintenance, { restored: [], completed: [], issues: [] })
  const unguarded = await fetch(`${url}/api/workspace/recovery/reconcile`, { method: 'POST' })
  assert.equal(unguarded.status, 409)
  const response = await fetch(`${url}/api/workspace/recovery/reconcile`, { method: 'POST', headers })
  assert.equal(response.status, 200)
  const report = await response.json()
  assert.deepEqual(report.restored, [])
  assert.deepEqual(report.issues, [])
  await assert.rejects(fs.stat(recoveryRoot), error => error.code === 'ENOENT')
})

test('startup reconciliation restores a free pending original and keeps the ready trash payload', async t => {
  let seeded
  const { workspace, recoveryRoot, url, headers, backend } = await fixture(t, {
    beforeInitialize: async ({ workspace, recoveryRoot }) => {
      seeded = await seedPendingFile(workspace, recoveryRoot)
    },
  })

  assert.deepEqual(backend.currentWorkspaceInfo().recoveryMaintenance, {
    restored: [{ id: seeded.id, path: 'note.md' }], completed: [], issues: [],
  })
  assert.equal(await fs.readFile(seeded.source, 'utf8'), seeded.content)
  await assert.rejects(fs.lstat(seeded.quarantine), error => error.code === 'ENOENT')
  assert.equal(await fs.readFile(seeded.payload, 'utf8'), seeded.content)

  const trashResponse = await fetch(`${url}/api/workspace/trash`, { headers })
  assert.equal(trashResponse.status, 200)
  const items = (await trashResponse.json()).items
  assert.equal(items.length, 1)
  assert.equal(items[0].id, seeded.id)
  assert.equal(items[0].pendingRecovery, false)
  const statsResponse = await fetch(`${url}/api/workspace/recovery/stats`, { headers })
  const stats = await statsResponse.json()
  assert.equal(stats.trash.items, 1)
  assert.deepEqual(stats.maintenance.trash.restored, [{ id: seeded.id, path: 'note.md' }])
})

test('occupied pending original remains guarded until explicit reconcile and refreshes recovery stats', async t => {
  let seeded
  const { workspace, recoveryRoot, url, headers } = await fixture(t, {
    beforeInitialize: async ({ workspace, recoveryRoot }) => {
      seeded = await seedPendingFile(workspace, recoveryRoot, { occupied: true })
    },
  })

  const startupResponse = await fetch(`${url}/api/workspace/recovery/stats`, { headers })
  const startupStats = await startupResponse.json()
  assert.equal(startupStats.maintenance.trash.issues[0].code, 'RESTORE_PATH_OCCUPIED')
  assert.equal(await fs.readFile(seeded.source, 'utf8'), 'newer user content')
  assert.equal(await fs.readFile(seeded.quarantine, 'utf8'), seeded.content)

  const trashResponse = await fetch(`${url}/api/workspace/trash`, { headers })
  const items = (await trashResponse.json()).items
  assert.equal(items.length, 1)
  assert.equal(items[0].pendingRecovery, true)
  const removeResponse = await fetch(`${url}/api/workspace/trash?id=${encodeURIComponent(seeded.id)}`, {
    method: 'DELETE', headers,
  })
  assert.equal(removeResponse.status, 409)
  assert.equal((await removeResponse.json()).code, 'TRASH_OPERATION_PENDING')
  assert.equal(await fs.readFile(seeded.payload, 'utf8'), seeded.content)

  await fs.unlink(seeded.source)
  const reconcileResponse = await fetch(`${url}/api/workspace/recovery/reconcile`, { method: 'POST', headers })
  assert.equal(reconcileResponse.status, 200)
  const reconciled = await reconcileResponse.json()
  assert.deepEqual(reconciled.restored, [{ id: seeded.id, path: 'note.md' }])
  assert.deepEqual(reconciled.issues, [])
  assert.equal(reconciled.stats.trash.items, 1)
  assert.deepEqual(reconciled.stats.maintenance.trash.restored, [{ id: seeded.id, path: 'note.md' }])
  assert.equal(await fs.readFile(seeded.source, 'utf8'), seeded.content)
  assert.equal(await fs.readFile(seeded.payload, 'utf8'), seeded.content)
  await assert.rejects(fs.lstat(seeded.quarantine), error => error.code === 'ENOENT')

  const refreshedTrash = await fetch(`${url}/api/workspace/trash`, { headers })
  assert.equal((await refreshedTrash.json()).items[0].pendingRecovery, false)
})
