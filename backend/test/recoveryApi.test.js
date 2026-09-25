import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function startBackend(t, workspace, recovery) {
  const source = `import { server } from './src/index.js'; server.once('listening', () => process.send({ port: server.address().port }));`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: backendRoot,
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      EDITOR_DEFAULT_WORKSPACE: workspace,
      EDITOR_RECOVERY_DIR: recovery,
      WORKSPACE_CONFIG_FILE: path.join(recovery, 'test-workspace.json'),
      ALLOW_ANY_WORKSPACE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend did not start: ${output}`)), 5000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`backend exited (${code}): ${output}`)) })
    child.on('message', message => {
      if (message?.port) { clearTimeout(timer); resolve(message.port) }
    })
  })

  t.after(async () => {
    child.kill('SIGTERM')
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', resolve)
      setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1000)
    })
  })
  return `http://127.0.0.1:${port}`
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

test('recovery API is workspace-guarded, reports stored bytes, and cleans only on explicit requests', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-recovery-api-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-recovery-api-data-')
  await fs.writeFile(path.join(workspace, 'note.md'), 'before')
  await fs.writeFile(path.join(workspace, 'expired.md'), 'trash until purged')
  const baseUrl = await startBackend(t, workspace, recovery)

  const workspaceInfo = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  const headers = {
    'X-Workspace-Id': workspaceInfo.workspaceId,
    'X-Workspace-Version': String(workspaceInfo.workspaceVersion),
  }
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' }

  const unguardedStats = await fetch(`${baseUrl}/api/workspace/recovery/stats`)
  assert.equal(unguardedStats.status, 409)
  assert.equal((await unguardedStats.json()).code, 'WORKSPACE_MISMATCH')

  const emptyStats = await (await fetch(`${baseUrl}/api/workspace/recovery/stats`, { headers })).json()
  assert.deepEqual(emptyStats.history, { items: 0, bytes: 0 })
  assert.deepEqual(emptyStats.trash, { items: 0, bytes: 0 })

  const opened = await (await fetch(`${baseUrl}/api/workspace/file?path=note.md`, { headers })).json()
  const saved = await fetch(`${baseUrl}/api/workspace`, {
    method: 'PUT', headers: jsonHeaders,
    body: JSON.stringify({ path: 'note.md', content: 'edited', expectedRevision: opened.revision }),
  })
  assert.equal(saved.status, 200)
  const history = await (await fetch(`${baseUrl}/api/workspace/file/history?path=note.md`, { headers })).json()
  assert.equal(history.history.length, 1)
  const historyId = history.history[0].id
  const workspaceKey = hash(await fs.realpath(workspace))
  const historyStorage = path.join(recovery, 'history', workspaceKey)

  const withHistory = await (await fetch(`${baseUrl}/api/workspace/recovery/stats`, { headers })).json()
  assert.equal(withHistory.history.items, 1)
  assert.equal(withHistory.history.bytes, await regularFileBytes(historyStorage))
  assert.ok(withHistory.history.bytes > Buffer.byteLength('before'))

  const wrongWorkspaceHistoryDelete = await fetch(
    `${baseUrl}/api/workspace/file/history?path=note.md&id=${encodeURIComponent(historyId)}`,
    { method: 'DELETE', headers: { ...headers, 'X-Workspace-Id': 'wrong-workspace' } },
  )
  assert.equal(wrongWorkspaceHistoryDelete.status, 409)
  assert.equal((await wrongWorkspaceHistoryDelete.json()).code, 'WORKSPACE_MISMATCH')

  const missingHistoryDelete = await fetch(
    `${baseUrl}/api/workspace/file/history?path=note.md&id=${encodeURIComponent('11111111-1111-4111-8111-111111111111')}`,
    { method: 'DELETE', headers },
  )
  assert.equal(missingHistoryDelete.status, 404)
  assert.equal((await missingHistoryDelete.json()).code, 'HISTORY_NOT_FOUND')

  const removedHistory = await fetch(
    `${baseUrl}/api/workspace/file/history?path=note.md&id=${encodeURIComponent(historyId)}`,
    { method: 'DELETE', headers },
  )
  assert.equal(removedHistory.status, 200)
  const removedHistoryBody = await removedHistory.json()
  assert.equal(removedHistoryBody.success, true)
  assert.equal(removedHistoryBody.deletedHistoryId, historyId)
  assert.equal(removedHistoryBody.stats.history.items, 0)
  assert.equal((await (await fetch(`${baseUrl}/api/workspace/file?path=note.md`, { headers })).json()).content, 'edited')

  const duplicateHistoryDelete = await fetch(
    `${baseUrl}/api/workspace/file/history?path=note.md&id=${encodeURIComponent(historyId)}`,
    { method: 'DELETE', headers },
  )
  assert.equal(duplicateHistoryDelete.status, 404)
  assert.equal((await duplicateHistoryDelete.json()).code, 'HISTORY_NOT_FOUND')

  const trashedResponse = await fetch(`${baseUrl}/api/workspace?path=expired.md`, { method: 'DELETE', headers })
  assert.equal(trashedResponse.status, 200)
  const trashed = await trashedResponse.json()
  const trashStorage = path.join(recovery, 'trash', workspaceKey)
  const withTrash = await (await fetch(`${baseUrl}/api/workspace/recovery/stats`, { headers })).json()
  assert.equal(withTrash.trash.items, 1)
  assert.equal(withTrash.trash.bytes, await regularFileBytes(trashStorage))

  const entryDirectory = path.join(trashStorage, trashed.id)
  const manifestPath = path.join(entryDirectory, 'entry.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.expiresAt = '2000-01-01T00:00:00.000Z'
  await fs.writeFile(manifestPath, JSON.stringify(manifest))

  const stillPresent = await (await fetch(`${baseUrl}/api/workspace/recovery/stats`, { headers })).json()
  assert.equal(stillPresent.trash.items, 1)
  await fs.lstat(entryDirectory)

  const unguardedPurge = await fetch(`${baseUrl}/api/workspace/trash/purge-expired`, { method: 'POST' })
  assert.equal(unguardedPurge.status, 409)
  const purgedResponse = await fetch(`${baseUrl}/api/workspace/trash/purge-expired`, { method: 'POST', headers })
  assert.equal(purgedResponse.status, 200)
  const purged = await purgedResponse.json()
  assert.equal(purged.purged, 1)
  assert.equal(purged.stats.trash.items, 0)
  await assert.rejects(fs.lstat(entryDirectory), error => error.code === 'ENOENT')

  await fs.writeFile(path.join(workspace, 'selected.md'), 'permanent delete')
  const selectedTrashResponse = await fetch(`${baseUrl}/api/workspace?path=selected.md`, { method: 'DELETE', headers })
  const selected = await selectedTrashResponse.json()
  const wrongWorkspaceRemove = await fetch(`${baseUrl}/api/workspace/trash?id=${encodeURIComponent(selected.id)}`, {
    method: 'DELETE', headers: { ...headers, 'X-Workspace-Id': 'wrong-workspace' },
  })
  assert.equal(wrongWorkspaceRemove.status, 409)
  assert.equal((await (await fetch(`${baseUrl}/api/workspace/trash`, { headers })).json()).items.length, 1)

  const removedTrashResponse = await fetch(`${baseUrl}/api/workspace/trash?id=${encodeURIComponent(selected.id)}`, {
    method: 'DELETE', headers,
  })
  assert.equal(removedTrashResponse.status, 200)
  const removedTrash = await removedTrashResponse.json()
  assert.equal(removedTrash.success, true)
  assert.equal(removedTrash.id, selected.id)
  assert.equal(removedTrash.stats.trash.items, 0)

  const duplicateTrashRemove = await fetch(`${baseUrl}/api/workspace/trash?id=${encodeURIComponent(selected.id)}`, {
    method: 'DELETE', headers,
  })
  assert.equal(duplicateTrashRemove.status, 404)
})
