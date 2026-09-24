import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createZip } from './zipFixture.js'

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

test('file API requires revisions, returns structured conflicts, and restores guarded history', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-api-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-api-recovery-')
  await fs.writeFile(path.join(workspace, 'note.md'), 'initial')
  const baseUrl = await startBackend(t, workspace, recovery)

  const checkResponse = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(checkResponse.status, 200)
  const workspaceInfo = await checkResponse.json()
  const headers = {
    'Content-Type': 'application/json',
    'X-Workspace-Id': workspaceInfo.workspaceId,
    'X-Workspace-Version': String(workspaceInfo.workspaceVersion),
  }
  const get = pathValue => fetch(`${baseUrl}/api/workspace/file?path=${encodeURIComponent(pathValue)}`, { headers })
  const put = body => fetch(`${baseUrl}/api/workspace`, { method: 'PUT', headers, body: JSON.stringify(body) })

  const initialResponse = await get('note.md')
  assert.equal(initialResponse.status, 200)
  const initial = await initialResponse.json()
  assert.equal(initial.content, 'initial')
  assert.match(initial.revision, /^[a-f0-9]{64}$/)

  const missingRevision = await put({ path: 'note.md', content: 'unversioned' })
  assert.equal(missingRevision.status, 428)
  assert.equal((await missingRevision.json()).code, 'REVISION_REQUIRED')

  const saved = await put({ path: 'note.md', content: 'saved by client B', expectedRevision: initial.revision })
  assert.equal(saved.status, 200)
  const savedBody = await saved.json()
  assert.match(savedBody.revision, /^[a-f0-9]{64}$/)

  const stale = await put({ path: 'note.md', content: 'stale client A', expectedRevision: initial.revision })
  assert.equal(stale.status, 409)
  const conflict = await stale.json()
  assert.equal(conflict.code, 'FILE_CONFLICT')
  assert.equal(conflict.currentRevision, savedBody.revision)
  assert.equal(conflict.currentContent, 'saved by client B')

  const historyResponse = await fetch(`${baseUrl}/api/workspace/file/history?path=note.md`, { headers })
  assert.equal(historyResponse.status, 200)
  const history = await historyResponse.json()
  assert.equal(history.history.length, 1)
  assert.equal(history.history[0].revision, initial.revision)

  const missingRestoreRevision = await fetch(`${baseUrl}/api/workspace/file/restore`, {
    method: 'POST', headers, body: JSON.stringify({ path: 'note.md', historyId: history.history[0].id }),
  })
  assert.equal(missingRestoreRevision.status, 428)

  const restored = await fetch(`${baseUrl}/api/workspace/file/restore`, {
    method: 'POST', headers,
    body: JSON.stringify({ path: 'note.md', historyId: history.history[0].id, expectedRevision: savedBody.revision }),
  })
  assert.equal(restored.status, 200)
  assert.equal((await restored.json()).revision, initial.revision)
  assert.equal((await (await get('note.md')).json()).content, 'initial')

  const created = await put({ path: 'new.md', content: 'new', expectedRevision: null })
  assert.equal(created.status, 200)
  const duplicateCreate = await put({ path: 'new.md', content: 'replacement', expectedRevision: null })
  assert.equal(duplicateCreate.status, 409)
  assert.equal((await duplicateCreate.json()).code, 'FILE_CONFLICT')
})

test('trash and ZIP routes honor workspace identity, preserve hidden files, and handle collisions and limits', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-api-trash-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-api-trash-recovery-')
  const hiddenDirectory = path.join(workspace, '.project')
  await fs.mkdir(hiddenDirectory)
  await fs.writeFile(path.join(hiddenDirectory, '.private-state'), 'kept')
  await fs.writeFile(path.join(hiddenDirectory, 'note.md'), '# kept')
  const baseUrl = await startBackend(t, workspace, recovery)
  const check = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  const headers = {
    'X-Workspace-Id': check.workspaceId,
    'X-Workspace-Version': String(check.workspaceVersion),
  }
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' }

  const unguardedTrash = await fetch(`${baseUrl}/api/workspace/trash`)
  assert.equal(unguardedTrash.status, 409)
  assert.equal((await unguardedTrash.json()).code, 'WORKSPACE_MISMATCH')

  const deleted = await fetch(`${baseUrl}/api/workspace?path=${encodeURIComponent('.project')}`, {
    method: 'DELETE', headers,
  })
  assert.equal(deleted.status, 200)
  const trashEntry = await deleted.json()
  assert.match(trashEntry.id, /^[0-9a-f-]{36}$/i)
  assert.equal(trashEntry.path, '.project')
  assert.equal(trashEntry.type, 'directory')
  await assert.rejects(fs.lstat(hiddenDirectory), error => error.code === 'ENOENT')

  const listingResponse = await fetch(`${baseUrl}/api/workspace/trash`, { headers })
  assert.equal(listingResponse.status, 200)
  const listing = await listingResponse.json()
  assert.equal(listing.items.length, 1)
  assert.equal(listing.items[0].id, trashEntry.id)
  assert.equal(listing.items[0].path, '.project')

  await fs.mkdir(hiddenDirectory)
  await fs.writeFile(path.join(hiddenDirectory, 'newer.md'), 'keep the replacement')
  const collision = await fetch(`${baseUrl}/api/workspace/trash/restore`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ id: trashEntry.id }),
  })
  assert.equal(collision.status, 409)
  assert.equal((await collision.json()).code, 'CONFLICT')
  assert.equal(await fs.readFile(path.join(hiddenDirectory, 'newer.md'), 'utf8'), 'keep the replacement')
  assert.equal((await (await fetch(`${baseUrl}/api/workspace/trash`, { headers })).json()).items.length, 1)

  await fs.rm(hiddenDirectory, { recursive: true })
  const restored = await fetch(`${baseUrl}/api/workspace/trash/restore`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ id: trashEntry.id }),
  })
  assert.equal(restored.status, 200)
  assert.deepEqual(await restored.json(), { success: true, path: '.project' })
  assert.equal(await fs.readFile(path.join(hiddenDirectory, '.private-state'), 'utf8'), 'kept')
  assert.equal(await fs.readFile(path.join(hiddenDirectory, 'note.md'), 'utf8'), '# kept')
  assert.deepEqual((await (await fetch(`${baseUrl}/api/workspace/trash`, { headers })).json()).items, [])

  async function uploadZip(archive, filename = 'notes.zip') {
    const form = new FormData()
    form.append('file', new Blob([archive]), filename)
    return fetch(`${baseUrl}/api/workspace/import`, { method: 'POST', headers, body: form })
  }

  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00])
  const validArchive = createZip([
    { name: '资料/复习.md', data: '# UTF-8 stored', method: 0 },
    { name: '图片/像素.png', data: image, method: 8 },
  ])
  const importResponse = await uploadZip(validArchive)
  assert.equal(importResponse.status, 200)
  const importBody = await importResponse.json()
  assert.equal(importBody.imported, 2)
  assert.deepEqual(importBody.files, ['资料/复习.md', '图片/像素.png'])
  assert.equal(await fs.readFile(path.join(workspace, '资料', '复习.md'), 'utf8'), '# UTF-8 stored')
  assert.deepEqual(await fs.readFile(path.join(workspace, '图片', '像素.png')), image)

  const malicious = await uploadZip(createZip([{ name: '../outside.md', data: 'unsafe' }]))
  assert.equal(malicious.status, 400)
  assert.equal((await malicious.json()).code, 'INVALID_ARCHIVE')
  await assert.rejects(fs.lstat(path.join(path.dirname(workspace), 'outside.md')), error => error.code === 'ENOENT')

  const tooManyEntries = createZip(Array.from({ length: 5001 }, (_, index) => ({
    name: `batch/note-${index}.md`, data: '',
  })))
  const limited = await uploadZip(tooManyEntries)
  assert.equal(limited.status, 413)
  assert.equal((await limited.json()).code, 'ZIP_LIMIT')
  assert.deepEqual(await fs.readdir(path.join(workspace, 'batch')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), [])
})
