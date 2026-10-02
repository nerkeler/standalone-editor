import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createBackend } from '../src/index.js'
import { createHttpServer } from '../src/httpServer.js'

async function temporaryDirectory(t, name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `standalone-editor-${name}-`))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test('backend instances keep workspace and recovery configuration isolated', async t => {
  const root = await temporaryDirectory(t, 'factory')
  const workspaceA = path.join(root, 'workspace-a')
  const workspaceB = path.join(root, 'workspace-b')
  const workspaceA2 = path.join(root, 'workspace-a2')
  const recoveryA = path.join(root, 'recovery-a')
  const recoveryB = path.join(root, 'recovery-b')
  await Promise.all([workspaceA, workspaceB, workspaceA2, recoveryA, recoveryB].map(directory => fs.mkdir(directory)))
  await Promise.all([
    fs.writeFile(path.join(workspaceA, 'note.md'), 'A version one'),
    fs.writeFile(path.join(workspaceB, 'note.md'), 'B version one'),
  ])

  const configA = path.join(root, 'workspace-a.json')
  const configB = path.join(root, 'workspace-b.json')
  const makeBackend = (workspace, recoveryRoot, configFile) => createBackend({
    env: { ...process.env, ALLOW_ANY_WORKSPACE: '1', CORS_ORIGINS: '*' },
    argv: [],
    workspace,
    defaultWorkspace: workspace,
    configFile,
    recoveryRoot,
    host: '127.0.0.1',
    port: 0,
  })
  const backendA = makeBackend(workspaceA, recoveryA, configA)
  const backendB = makeBackend(workspaceB, recoveryB, configB)
  const [realWorkspaceA, realWorkspaceB] = await Promise.all([fs.realpath(workspaceA), fs.realpath(workspaceB)])

  assert.notEqual(backendA.app, backendB.app)
  assert.notEqual(backendA.recoveryRoot, backendB.recoveryRoot)
  await assert.rejects(fs.stat(configA), error => error.code === 'ENOENT')
  await assert.rejects(fs.stat(configB), error => error.code === 'ENOENT')
  await Promise.all([backendA.initialize(), backendB.initialize()])

  const infoA = backendA.currentWorkspaceInfo()
  const infoB = backendB.currentWorkspaceInfo()
  assert.equal(infoA.workspace, realWorkspaceA)
  assert.equal(infoB.workspace, realWorkspaceB)
  assert.notEqual(infoA.workspaceId, infoB.workspaceId)
  assert.equal(JSON.parse(await fs.readFile(configA, 'utf8')).workspace, realWorkspaceA)
  assert.equal(JSON.parse(await fs.readFile(configB, 'utf8')).workspace, realWorkspaceB)

  const serverA = createHttpServer(backendA.app)
  const serverB = createHttpServer(backendB.app)
  for (const server of [serverA, serverB]) {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    t.after(() => new Promise(resolve => server.close(() => resolve())))
  }
  const urlA = `http://127.0.0.1:${serverA.address().port}`
  const urlB = `http://127.0.0.1:${serverB.address().port}`
  const request = (url, pathname, options = {}) => fetch(`${url}${pathname}`, options)
  const [httpInfoA, httpInfoB] = await Promise.all([
    request(urlA, '/api/workspace/check').then(response => response.json()),
    request(urlB, '/api/workspace/check').then(response => response.json()),
  ])
  const headersA = {
    'Content-Type': 'application/json',
    'X-Workspace-Id': httpInfoA.workspaceId,
    'X-Workspace-Version': String(httpInfoA.workspaceVersion),
  }
  const headersB = {
    'Content-Type': 'application/json',
    'X-Workspace-Id': httpInfoB.workspaceId,
    'X-Workspace-Version': String(httpInfoB.workspaceVersion),
  }

  const [savedA, savedB] = await Promise.all([
    request(urlA, '/api/workspace', {
      method: 'PUT', headers: headersA,
      body: JSON.stringify({ path: 'note.md', content: 'A version two', expectedRevision: createHash('sha256').update('A version one').digest('hex') }),
    }),
    request(urlB, '/api/workspace', {
      method: 'PUT', headers: headersB,
      body: JSON.stringify({ path: 'note.md', content: 'B version two', expectedRevision: createHash('sha256').update('B version one').digest('hex') }),
    }),
  ])
  assert.equal(savedA.status, 200)
  assert.equal(savedB.status, 200)
  const [historyA, historyB] = await Promise.all([
    request(urlA, '/api/workspace/file/history?path=note.md', { headers: headersA }).then(response => response.json()),
    request(urlB, '/api/workspace/file/history?path=note.md', { headers: headersB }).then(response => response.json()),
  ])
  assert.equal(historyA.history.length, 1)
  assert.equal(historyB.history.length, 1)
  assert.equal(historyA.history[0].revision, createHash('sha256').update('A version one').digest('hex'))
  assert.equal(historyB.history[0].revision, createHash('sha256').update('B version one').digest('hex'))

  const trashedA = await request(urlA, '/api/workspace?path=note.md', { method: 'DELETE', headers: headersA })
  assert.equal(trashedA.status, 200)
  const [trashA, trashB] = await Promise.all([
    request(urlA, '/api/workspace/trash', { headers: headersA }).then(response => response.json()),
    request(urlB, '/api/workspace/trash', { headers: headersB }).then(response => response.json()),
  ])
  assert.equal(trashA.items.length, 1)
  assert.equal(trashB.items.length, 0)
  assert.equal(await fs.readFile(path.join(workspaceB, 'note.md'), 'utf8'), 'B version two')

  const switched = await request(urlA, '/api/workspace/set', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: workspaceA2 }),
  })
  assert.equal(switched.status, 200)
  const currentA = await request(urlA, '/api/workspace/check').then(response => response.json())
  const currentB = await request(urlB, '/api/workspace/check').then(response => response.json())
  assert.equal(currentA.workspace, await fs.realpath(workspaceA2))
  assert.equal(currentB.workspace, realWorkspaceB)
  const staleIdentityWrite = await request(urlA, '/api/workspace', {
    method: 'PUT', headers: headersB,
    body: JSON.stringify({ path: 'note.md', content: 'must not cross workspaces', expectedRevision: null }),
  })
  assert.equal(staleIdentityWrite.status, 409)
  assert.equal((await staleIdentityWrite.json()).code, 'WORKSPACE_MISMATCH')
  await assert.rejects(fs.stat(path.join(workspaceA2, 'note.md')), error => error.code === 'ENOENT')
})

test('path and file-handle stats agree for a real workspace file', async t => {
  const workspace = await temporaryDirectory(t, 'path-handle-stat')
  const filePath = path.join(workspace, 'identity.md')
  await fs.writeFile(filePath, 'same file')
  const handle = await fs.open(filePath, 'r')

  try {
    const [pathStat, handleStat] = await Promise.all([fs.lstat(filePath), handle.stat()])
    assert.equal(pathStat.dev, handleStat.dev, `path st_dev=${pathStat.dev}; handle st_dev=${handleStat.dev}`)
    assert.equal(pathStat.ino, handleStat.ino, `path st_ino=${pathStat.ino}; handle st_ino=${handleStat.ino}`)
    assert.equal(pathStat.size, handleStat.size, `path size=${pathStat.size}; handle size=${handleStat.size}`)
  } finally {
    await handle.close()
  }
})
