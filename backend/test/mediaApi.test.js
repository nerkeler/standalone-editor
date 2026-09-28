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
  const svgPath = path.join(workspace, 'unsafe.svg')
  const plainPath = path.join(workspace, '资料', 'readme.txt')
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff])
  await fs.mkdir(path.dirname(nestedPath), { recursive: true })
  await fs.mkdir(path.dirname(rootAssetPath), { recursive: true })
  await fs.writeFile(nestedPath, imageBytes)
  await fs.writeFile(rootAssetPath, Buffer.from('GIF89a'))
  const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="2" height="2"/></svg>')
  await fs.writeFile(svgPath, svgBytes)
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
  assert.equal(Number(nested.headers.get('content-length')), imageBytes.byteLength)
  assert.equal(nested.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(Buffer.from(await nested.arrayBuffer()), imageBytes)

  const legacy = await fetch(`${baseUrl}/api/workspace/assets/legacy.gif?workspaceId=${check.workspaceId}&workspaceVersion=${check.workspaceVersion}`)
  assert.equal(legacy.status, 200)
  assert.match(legacy.headers.get('content-type'), /image\/gif/)
  assert.equal(Number(legacy.headers.get('content-length')), Buffer.byteLength('GIF89a'))
  assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), Buffer.from('GIF89a'))

  const svg = await fetch(`${baseUrl}/api/workspace/media/unsafe.svg?workspaceId=${check.workspaceId}&workspaceVersion=${check.workspaceVersion}`)
  assert.equal(svg.status, 200)
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/)
  assert.match(svg.headers.get('content-security-policy'), /sandbox/)
  assert.deepEqual(Buffer.from(await svg.arrayBuffer()), svgBytes)

  // Preserve the old JSON shape for clients that still call /image. The
  // editor itself uses the identity-bound streaming /media URL.
  const legacyJson = await fetch(`${baseUrl}/api/workspace/image?path=${encodeURIComponent('资料/封 面.png')}`, { headers })
  assert.equal(legacyJson.status, 200)
  const legacyJsonBody = await legacyJson.json()
  assert.equal(legacyJsonBody.mime, 'image/png')
  assert.equal(legacyJsonBody.name, '封 面.png')
  assert.equal(legacyJsonBody.data, imageBytes.toString('base64'))

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

  await fs.writeFile(path.join(workspace, '资料', 'note.md'), '# note\n')
  const adjacentForm = () => {
    const form = new FormData()
    form.append('file', new Blob([imageBytes]), 'adjacent.png')
    form.append('documentPath', '资料/note.md')
    return form
  }
  const adjacent = await fetch(`${baseUrl}/api/workspace/upload`, { method: 'POST', headers, body: adjacentForm() })
  assert.equal(adjacent.status, 200)
  assert.equal((await adjacent.json()).path, '资料/assets/adjacent.png')
  assert.deepEqual(await fs.readFile(path.join(workspace, '资料', 'assets', 'adjacent.png')), imageBytes)
  const duplicate = await fetch(`${baseUrl}/api/workspace/upload`, { method: 'POST', headers, body: adjacentForm() })
  assert.equal(duplicate.status, 409)
  const missingForm = new FormData()
  missingForm.append('file', new Blob([imageBytes]), 'missing.png')
  missingForm.append('documentPath', '资料/missing.md')
  const missing = await fetch(`${baseUrl}/api/workspace/upload`, { method: 'POST', headers, body: missingForm })
  assert.notEqual(missing.status, 200)
  if (process.platform !== 'win32') {
    await fs.mkdir(path.join(workspace, 'linked'))
    await fs.writeFile(path.join(workspace, 'linked', 'note.md'), '# linked\n')
    const outside = await temporaryDirectory(t, 'standalone-editor-outside-assets-')
    await fs.symlink(outside, path.join(workspace, 'linked', 'assets'))
    const unsafeForm = new FormData()
    unsafeForm.append('file', new Blob([imageBytes]), 'escaped.png')
    unsafeForm.append('documentPath', 'linked/note.md')
    const unsafe = await fetch(`${baseUrl}/api/workspace/upload`, { method: 'POST', headers, body: unsafeForm })
    assert.notEqual(unsafe.status, 200)
    assert.equal(await fs.access(path.join(outside, 'escaped.png')).then(() => true, () => false), false)
  }
})

test('upload limits reject abusive multipart fields and allow the full editor form', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-upload-limits-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-upload-limits-recovery-')
  const baseUrl = await startBackend(t, workspace, recovery)
  const check = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  const headers = {
    'X-Workspace-Id': check.workspaceId,
    'X-Workspace-Version': String(check.workspaceVersion),
  }
  const upload = form => fetch(`${baseUrl}/api/workspace/upload`, { method: 'POST', headers, body: form })
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47])

  const indexedFields = new FormData()
  indexedFields.append('items[4294967294]', 'x')
  indexedFields.append('items[label]', 'y')
  indexedFields.append('file', new Blob([image]), 'blocked.png')
  const indexedResponse = await upload(indexedFields)
  assert.equal(indexedResponse.status, 413)
  assert.equal((await indexedResponse.json()).code, 'LIMIT_FIELD_NESTING')

  const oversizedField = new FormData()
  oversizedField.append('path', 'a'.repeat(8 * 1024 + 1))
  oversizedField.append('file', new Blob([image]), 'blocked.png')
  const oversizedResponse = await upload(oversizedField)
  assert.equal(oversizedResponse.status, 413)
  assert.equal((await oversizedResponse.json()).code, 'LIMIT_FIELD_VALUE')

  const extraFields = new FormData()
  extraFields.append('path', 'assets')
  extraFields.append('documentPath', '')
  extraFields.append('extra', 'unused')
  extraFields.append('file', new Blob([image]), 'blocked.png')
  const extraResponse = await upload(extraFields)
  assert.equal(extraResponse.status, 413)
  assert.match((await extraResponse.json()).code, /^LIMIT_(FIELD_COUNT|PART_COUNT)$/)
  assert.equal(await fs.access(path.join(workspace, 'assets', 'blocked.png')).then(() => true, () => false), false)

  const validForm = new FormData()
  validForm.append('file', new Blob([image]), 'valid.png')
  validForm.append('path', 'assets')
  validForm.append('documentPath', '')
  const validResponse = await upload(validForm)
  assert.equal(validResponse.status, 200)
  assert.deepEqual(await fs.readFile(path.join(workspace, 'assets', 'valid.png')), image)

  const legacyForm = new FormData()
  legacyForm.append('file', new Blob([image]), 'legacy.png')
  const legacyResponse = await fetch(`${baseUrl}/api/upload/assets`, { method: 'POST', headers, body: legacyForm })
  assert.equal(legacyResponse.status, 200)
  assert.deepEqual(await fs.readFile(path.join(workspace, 'assets', 'legacy.png')), image)
})

test('same-level asset upload returns the normalized permission error for a read-only directory', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    return t.skip('requires POSIX permission checks under a non-root backend account')
  }
  const workspace = await temporaryDirectory(t, 'standalone-editor-media-readonly-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-media-readonly-recovery-')
  const documentDirectory = path.join(workspace, 'locked')
  await fs.mkdir(documentDirectory)
  await fs.writeFile(path.join(documentDirectory, 'note.md'), '# note\n')
  const baseUrl = await startBackend(t, workspace, recovery)
  const check = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  const headers = {
    'X-Workspace-Id': check.workspaceId,
    'X-Workspace-Version': String(check.workspaceVersion),
  }

  await fs.chmod(documentDirectory, 0o555)
  try {
    const form = new FormData()
    form.append('file', new Blob([Buffer.from('image bytes')]), 'asset.png')
    form.append('documentPath', 'locked/note.md')
    const response = await fetch(`${baseUrl}/api/workspace/upload`, { method: 'POST', headers, body: form })

    assert.equal(response.status, 403)
    const body = await response.json()
    assert.equal(body.code, 'PERMISSION_DENIED')
    assert.equal(body.error, '无权限访问或修改该路径')
    assert.equal(await fs.access(path.join(documentDirectory, 'assets')).then(() => true, () => false), false)
  } finally {
    // Restore write permission before temporaryDirectory's recursive cleanup,
    // even when the API assertion fails.
    await fs.chmod(documentDirectory, 0o755).catch(() => {})
  }
})
