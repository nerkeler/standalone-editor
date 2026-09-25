import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

test('workspace media route serves nested images safely and preserves the legacy asset route', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-media-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-media-recovery-')
  const nestedPath = path.join(workspace, '资料', '封 面.png')
  const rootAssetPath = path.join(workspace, 'assets', 'legacy.gif')
  const plainPath = path.join(workspace, '资料', 'readme.txt')
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff])
  await fs.mkdir(path.dirname(nestedPath), { recursive: true })
  await fs.mkdir(path.dirname(rootAssetPath), { recursive: true })
  await fs.writeFile(nestedPath, imageBytes)
  await fs.writeFile(rootAssetPath, Buffer.from('GIF89a'))
  await fs.writeFile(plainPath, 'not an image')
  const baseUrl = await startBackend(t, workspace, recovery)
  const check = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  const headers = {
    'X-Workspace-Id': check.workspaceId,
    'X-Workspace-Version': String(check.workspaceVersion),
  }

  const nested = await fetch(`${baseUrl}/api/workspace/media/%E8%B5%84%E6%96%99/%E5%B0%81%20%E9%9D%A2.png?workspaceId=${check.workspaceId}&workspaceVersion=${check.workspaceVersion}`)
  assert.equal(nested.status, 200)
  assert.match(nested.headers.get('content-type'), /image\/png/)
  assert.deepEqual(Buffer.from(await nested.arrayBuffer()), imageBytes)

  const legacy = await fetch(`${baseUrl}/api/workspace/assets/legacy.gif?workspaceId=${check.workspaceId}&workspaceVersion=${check.workspaceVersion}`)
  assert.equal(legacy.status, 200)
  assert.match(legacy.headers.get('content-type'), /image\/gif/)

  const noIdentity = await fetch(`${baseUrl}/api/workspace/media/%E8%B5%84%E6%96%99/%E5%B0%81%20%E9%9D%A2.png`)
  assert.equal(noIdentity.status, 409)
  const nonImage = await fetch(`${baseUrl}/api/workspace/media/%E8%B5%84%E6%96%99/readme.txt?workspaceId=${check.workspaceId}&workspaceVersion=${check.workspaceVersion}`)
  assert.equal(nonImage.status, 404)
  // Keep the slash encoded in a path segment so the HTTP URL parser cannot
  // normalize the traversal away before the backend validates it.
  const traversal = await fetch(`${baseUrl}/api/workspace/media/%2E%2E%2F..%2Foutside.png?workspaceId=${check.workspaceId}&workspaceVersion=${check.workspaceVersion}`)
  assert.equal(traversal.status, 404)
  assert.equal(await fs.readFile(path.join(path.dirname(workspace), 'outside.png')).catch(error => error.code), 'ENOENT')

  if (process.platform !== 'win32') {
    const outsideImage = path.join(path.dirname(workspace), 'linked.png')
    await fs.writeFile(outsideImage, imageBytes)
    await fs.symlink(outsideImage, path.join(workspace, 'linked.png'))
    const symlink = await fetch(`${baseUrl}/api/workspace/media/linked.png?workspaceId=${check.workspaceId}&workspaceVersion=${check.workspaceVersion}`)
    assert.equal(symlink.status, 404)
    await fs.rm(outsideImage)
  }

  const form = new FormData()
  form.append('file', new Blob([imageBytes]), '新图片.png')
  form.append('path', 'assets')
  const uploaded = await fetch(`${baseUrl}/api/workspace/upload`, { method: 'POST', headers, body: form })
  assert.equal(uploaded.status, 200)
  const uploadedBody = await uploaded.json()
  assert.equal(uploadedBody.filename, '新图片.png')
  assert.equal(uploadedBody.path, 'assets/新图片.png')
  assert.deepEqual(await fs.readFile(path.join(workspace, 'assets', '新图片.png')), imageBytes)
  const uploadedImage = await fetch(`${baseUrl}/api/workspace/media/assets/%E6%96%B0%E5%9B%BE%E7%89%87.png?workspaceId=${check.workspaceId}&workspaceVersion=${check.workspaceVersion}`)
  assert.equal(uploadedImage.status, 200)
  assert.deepEqual(Buffer.from(await uploadedImage.arrayBuffer()), imageBytes)
})
