import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createZip } from './zipFixture.js'
import { MAX_EDITABLE_MARKDOWN_BYTES, MAX_MARKDOWN_PREVIEW_BYTES } from '../src/fileService.js'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function startBackend(t, workspace, recovery, envOverrides = {}) {
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
      ...envOverrides,
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

async function requestWithHost(baseUrl, pathname, { method, headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(pathname, baseUrl), { method, headers }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: response.statusCode, headers: response.headers, json: () => JSON.parse(text) })
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end(body)
  })
}

test('CORS accepts the proxy request host on any frontend address and rejects another origin', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-api-origin-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-api-origin-recovery-')
  const baseUrl = await startBackend(t, workspace, recovery, {
    CORS_ORIGINS: '', EDITOR_CORS_ORIGINS: '',
  })
  const host = 'notes.example.test:8742'
  const origin = `https://${host}`
  const preflight = await requestWithHost(baseUrl, '/api/workspace/set', {
    method: 'OPTIONS',
    headers: { Host: host, Origin: origin, 'Access-Control-Request-Method': 'POST' },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], origin)

  const selected = await requestWithHost(baseUrl, '/api/workspace/set', {
    method: 'POST',
    headers: { Host: host, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: workspace }),
  })
  assert.equal(selected.status, 200)
  assert.equal(selected.json().workspace, await fs.realpath(workspace))

  const foreign = await requestWithHost(baseUrl, '/api/workspace/set', {
    method: 'OPTIONS',
    headers: { Host: host, Origin: 'https://other.example.test:8742', 'Access-Control-Request-Method': 'POST' },
  })
  assert.equal(foreign.status, 403)
  assert.equal(foreign.json().code, 'ORIGIN_NOT_ALLOWED')
  assert.equal(foreign.headers['access-control-allow-origin'], undefined)

  const unrelatedLocalhost = await requestWithHost(baseUrl, '/api/workspace/set', {
    method: 'OPTIONS',
    headers: { Host: host, Origin: 'http://localhost:5558', 'Access-Control-Request-Method': 'POST' },
  })
  assert.equal(unrelatedLocalhost.status, 403)
})

test('CORS accepts an explicitly configured cross-origin frontend', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-api-cors-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-api-cors-recovery-')
  const origin = 'https://editor.example.test'
  const baseUrl = await startBackend(t, workspace, recovery, { CORS_ORIGINS: origin })
  const response = await requestWithHost(baseUrl, '/api/workspace/set', {
    method: 'OPTIONS',
    headers: {
      Host: 'api.example.test',
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
    },
  })
  assert.equal(response.status, 204)
  assert.equal(response.headers['access-control-allow-origin'], origin)
})

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

test('read-only directories remain selectable while unreadable listing and denied writes return permission errors', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    return t.skip('requires POSIX permission checks under a non-root backend account')
  }
  const workspace = await temporaryDirectory(t, 'standalone-editor-api-readonly-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-api-readonly-recovery-')
  const unreadable = path.join(workspace, 'unreadable')
  const notePath = path.join(workspace, 'note.md')
  await fs.mkdir(unreadable)
  await fs.writeFile(notePath, 'initial')
  const baseUrl = await startBackend(t, workspace, recovery)
  const check = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  const headers = {
    'Content-Type': 'application/json',
    'X-Workspace-Id': check.workspaceId,
    'X-Workspace-Version': String(check.workspaceVersion),
  }

  await fs.chmod(workspace, 0o555)
  await fs.chmod(unreadable, 0o000)
  t.after(async () => {
    await fs.chmod(unreadable, 0o755).catch(() => {})
    await fs.chmod(workspace, 0o755).catch(() => {})
    await fs.chmod(notePath, 0o644).catch(() => {})
  })

  const readableReadonlyListing = await fetch(`${baseUrl}/api/dirs?path=${encodeURIComponent(workspace)}`)
  assert.equal(readableReadonlyListing.status, 200)
  const listing = await readableReadonlyListing.json()
  assert.equal(listing.canSelect, true, 'selection checks read access, not write access')
  assert.equal(listing.entries.some(entry => entry.path === unreadable), false)

  const selectReadonly = await fetch(`${baseUrl}/api/workspace/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: workspace }),
  })
  assert.equal(selectReadonly.status, 200)

  const unreadableListing = await fetch(`${baseUrl}/api/dirs?path=${encodeURIComponent(unreadable)}`)
  assert.equal(unreadableListing.status, 403)
  const unreadableBody = await unreadableListing.json()
  assert.equal(unreadableBody.code, 'PERMISSION_DENIED')
  assert.equal(unreadableBody.error, '无权限访问或修改该路径')
  assert.equal(unreadableBody.systemCode, 'EACCES')

  const selectUnreadable = await fetch(`${baseUrl}/api/workspace/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: unreadable }),
  })
  assert.equal(selectUnreadable.status, 403)
  assert.equal((await selectUnreadable.json()).code, 'PERMISSION_DENIED')

  const currentFile = await fetch(`${baseUrl}/api/workspace/file?path=note.md`, { headers })
  assert.equal(currentFile.status, 200)
  const revision = (await currentFile.json()).revision
  const deniedSave = await fetch(`${baseUrl}/api/workspace`, {
    method: 'PUT', headers,
    body: JSON.stringify({ path: 'note.md', content: 'replacement', expectedRevision: revision }),
  })
  assert.equal(deniedSave.status, 403)
  const deniedBody = await deniedSave.json()
  assert.equal(deniedBody.code, 'PERMISSION_DENIED')
  assert.equal(deniedBody.error, '无权限访问或修改该路径')
  assert.equal(deniedBody.systemCode, 'EACCES')

  await fs.chmod(unreadable, 0o755)
  await fs.chmod(workspace, 0o755)
  assert.equal(await fs.readFile(notePath, 'utf8'), 'initial')

  // Atomic rename would otherwise replace a 0444 file when its directory is
  // writable. The API preserves the file's own effective W_OK requirement.
  await fs.chmod(notePath, 0o444)
  const readonlyFileSave = await fetch(`${baseUrl}/api/workspace`, {
    method: 'PUT', headers,
    body: JSON.stringify({ path: 'note.md', content: 'file replacement', expectedRevision: revision }),
  })
  assert.equal(readonlyFileSave.status, 403)
  const readonlyFileBody = await readonlyFileSave.json()
  assert.equal(readonlyFileBody.code, 'PERMISSION_DENIED')
  assert.equal(readonlyFileBody.error, '无权限访问或修改该路径')
  assert.equal(await fs.readFile(notePath, 'utf8'), 'initial')
  await fs.chmod(notePath, 0o644)
})

test('large Markdown stays read-only, restore and writes are blocked, and downloads stream unchanged bytes', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-api-large-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-api-large-recovery-')
  const previewBytes = Buffer.alloc(MAX_EDITABLE_MARKDOWN_BYTES + 1, 0x78)
  const downloadBytes = Buffer.alloc(MAX_MARKDOWN_PREVIEW_BYTES + 1, 0x79)
  await fs.writeFile(path.join(workspace, 'large.md'), previewBytes)
  await fs.writeFile(path.join(workspace, 'download-only.md'), downloadBytes)
  await fs.writeFile(path.join(workspace, 'empty.md'), Buffer.alloc(0))
  const baseUrl = await startBackend(t, workspace, recovery)
  const check = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  const headers = {
    'Content-Type': 'application/json',
    'X-Workspace-Id': check.workspaceId,
    'X-Workspace-Version': String(check.workspaceVersion),
  }

  const previewResponse = await fetch(`${baseUrl}/api/workspace/file?path=large.md`, { headers })
  assert.equal(previewResponse.status, 200)
  const preview = await previewResponse.json()
  assert.equal(preview.editable, false)
  assert.equal(preview.previewAvailable, true)
  assert.equal(Buffer.byteLength(preview.content), previewBytes.byteLength)

  const save = await fetch(`${baseUrl}/api/workspace`, {
    method: 'PUT', headers,
    body: JSON.stringify({ path: 'large.md', content: 'replacement', expectedRevision: preview.revision }),
  })
  assert.equal(save.status, 413)
  assert.equal((await save.json()).code, 'DOCUMENT_TOO_LARGE')

  const restore = await fetch(`${baseUrl}/api/workspace/file/restore`, {
    method: 'POST', headers,
    body: JSON.stringify({ path: 'large.md', historyId: '00000000-0000-4000-8000-000000000000', expectedRevision: preview.revision }),
  })
  assert.equal(restore.status, 413)
  assert.equal((await restore.json()).code, 'DOCUMENT_TOO_LARGE')

  // This valid 2 MiB Markdown value expands beyond the old 10 MiB JSON body
  // limit because each control character is escaped as six JSON bytes.
  const escapedMarkdown = '\u0001'.repeat(2 * 1024 * 1024)
  const escapedWrite = await fetch(`${baseUrl}/api/workspace`, {
    method: 'PUT', headers,
    body: JSON.stringify({ path: 'escaped-control.md', content: escapedMarkdown, expectedRevision: null }),
  })
  assert.equal(escapedWrite.status, 200)
  assert.equal((await fs.stat(path.join(workspace, 'escaped-control.md'))).size, Buffer.byteLength(escapedMarkdown))

  const downloadOnlyResponse = await fetch(`${baseUrl}/api/workspace/file?path=download-only.md`, { headers })
  const downloadOnly = await downloadOnlyResponse.json()
  assert.equal(downloadOnly.editable, false)
  assert.equal(downloadOnly.previewAvailable, false)
  assert.equal(downloadOnly.content, null)

  const exported = await fetch(`${baseUrl}/api/workspace/export?path=download-only.md`, { headers })
  assert.equal(exported.status, 200)
  assert.equal(Number(exported.headers.get('content-length')), downloadBytes.byteLength)
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()), downloadBytes)

  const emptyExport = await fetch(`${baseUrl}/api/workspace/export?path=empty.md`, { headers })
  assert.equal(emptyExport.status, 200)
  assert.equal(Number(emptyExport.headers.get('content-length')), 0)
  assert.equal((await emptyExport.arrayBuffer()).byteLength, 0)
})

test('file API confines text editing to valid Markdown and downloads attachment bytes unchanged', async t => {
  const workspace = await temporaryDirectory(t, 'standalone-editor-api-types-workspace-')
  const recovery = await temporaryDirectory(t, 'standalone-editor-api-types-recovery-')
  const attachmentBytes = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
  const invalidUtf8Bytes = Buffer.from([0x23, 0x20, 0xc3, 0x28])
  const nulTextBytes = Buffer.from('looks textual\0but is not')
  await fs.writeFile(path.join(workspace, 'readme.markdown'), '# searchable note')
  await fs.writeFile(path.join(workspace, 'archive.bin'), attachmentBytes)
  await fs.writeFile(path.join(workspace, 'empty.bin'), Buffer.alloc(0))
  await fs.writeFile(path.join(workspace, 'invalid.md'), invalidUtf8Bytes)
  await fs.writeFile(path.join(workspace, 'nul.markdown'), nulTextBytes)
  let fifoCreated = false
  if (process.platform !== 'win32') {
    try {
      execFileSync('mkfifo', [path.join(workspace, 'blocked.md')])
      fifoCreated = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  const baseUrl = await startBackend(t, workspace, recovery)
  const check = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  const headers = {
    'X-Workspace-Id': check.workspaceId,
    'X-Workspace-Version': String(check.workspaceVersion),
    'Content-Type': 'application/json',
  }
  const get = filePath => fetch(`${baseUrl}/api/workspace/file?path=${encodeURIComponent(filePath)}`, { headers })
  const download = filePath => fetch(`${baseUrl}/api/workspace/download?path=${encodeURIComponent(filePath)}`, { headers })

  const tree = await (await fetch(`${baseUrl}/api/workspace?recursive=1`, { headers })).json()
  assert.ok(tree.some(item => item.path === 'archive.bin'))
  assert.ok(tree.some(item => item.path === 'readme.markdown'))
  if (fifoCreated) assert.ok(!tree.some(item => item.path === 'blocked.md'))

  const markdown = await get('readme.markdown')
  assert.equal(markdown.status, 200)
  const markdownData = await markdown.json()
  assert.equal(markdownData.content, '# searchable note')
  const search = await fetch(`${baseUrl}/api/workspace/search?q=${encodeURIComponent('searchable')}`, { headers })
  assert.deepEqual((await search.json()).map(item => item.path), ['readme.markdown'])
  const markdownSave = await fetch(`${baseUrl}/api/workspace`, {
    method: 'PUT', headers,
    body: JSON.stringify({ path: 'readme.markdown', content: '# searchable note\nupdated', expectedRevision: markdownData.revision }),
  })
  assert.equal(markdownSave.status, 200)
  const savedMarkdown = await markdownSave.json()
  assert.equal(savedMarkdown.success, true)
  const secondMarkdownSave = await fetch(`${baseUrl}/api/workspace`, {
    method: 'PUT', headers,
    body: JSON.stringify({ path: 'readme.markdown', content: '# searchable note\nsecond update', expectedRevision: savedMarkdown.revision }),
  })
  assert.equal(secondMarkdownSave.status, 200)
  const savedAgain = await secondMarkdownSave.json()
  const markdownHistory = await fetch(`${baseUrl}/api/workspace/file/history?path=readme.markdown`, { headers })
  const history = await markdownHistory.json()
  assert.equal(markdownHistory.status, 200)
  assert.equal(history.history.length, 2)
  const restoredMarkdown = await fetch(`${baseUrl}/api/workspace/file/restore`, {
    method: 'POST', headers,
    body: JSON.stringify({ path: 'readme.markdown', historyId: history.history[0].id, expectedRevision: savedAgain.revision }),
  })
  assert.equal(restoredMarkdown.status, 200)
  assert.equal((await get('readme.markdown').then(response => response.json())).content, '# searchable note\nupdated')

  const unsupportedRead = await get('archive.bin')
  assert.equal(unsupportedRead.status, 400)
  assert.equal((await unsupportedRead.json()).code, 'UNSUPPORTED_FILE_TYPE')
  const invalidRead = await get('invalid.md')
  assert.equal(invalidRead.status, 400)
  assert.equal((await invalidRead.json()).code, 'INVALID_UTF8')
  const nulRead = await get('nul.markdown')
  assert.equal(nulRead.status, 400)
  assert.equal((await nulRead.json()).code, 'INVALID_TEXT_FILE')

  const badPut = await fetch(`${baseUrl}/api/workspace`, {
    method: 'PUT', headers,
    body: JSON.stringify({ path: 'archive.bin', content: 'replacement', expectedRevision: null }),
  })
  assert.equal(badPut.status, 400)
  assert.equal((await badPut.json()).code, 'UNSUPPORTED_FILE_TYPE')
  const overwriteInvalidMarkdown = await fetch(`${baseUrl}/api/workspace`, {
    method: 'PUT', headers,
    body: JSON.stringify({
      path: 'invalid.md', content: 'replacement',
      expectedRevision: createHash('sha256').update(invalidUtf8Bytes).digest('hex'),
    }),
  })
  assert.equal(overwriteInvalidMarkdown.status, 400)
  assert.equal((await overwriteInvalidMarkdown.json()).code, 'INVALID_UTF8')
  assert.deepEqual(await fs.readFile(path.join(workspace, 'invalid.md')), invalidUtf8Bytes)

  const invalidRestore = await fetch(`${baseUrl}/api/workspace/file/restore`, {
    method: 'POST', headers,
    body: JSON.stringify({ path: 'invalid.md', historyId: 'not-a-history', expectedRevision: createHash('sha256').update(invalidUtf8Bytes).digest('hex') }),
  })
  assert.equal(invalidRestore.status, 400)
  assert.equal((await invalidRestore.json()).code, 'INVALID_UTF8')
  const attachmentHistory = await fetch(`${baseUrl}/api/workspace/file/history?path=archive.bin`, { headers })
  assert.equal(attachmentHistory.status, 400)
  assert.equal((await attachmentHistory.json()).code, 'UNSUPPORTED_FILE_TYPE')

  const downloaded = await download('archive.bin')
  assert.equal(downloaded.status, 200)
  assert.match(downloaded.headers.get('content-disposition'), /archive\.bin/)
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), attachmentBytes)
  const emptyDownload = await download('empty.bin')
  assert.equal(emptyDownload.status, 200)
  assert.equal(Number(emptyDownload.headers.get('content-length')), 0)
  assert.equal((await emptyDownload.arrayBuffer()).byteLength, 0)
  const unguardedDownload = await fetch(`${baseUrl}/api/workspace/download?path=archive.bin`)
  assert.equal(unguardedDownload.status, 409)
  assert.equal((await unguardedDownload.json()).code, 'WORKSPACE_MISMATCH')
  const traversalDownload = await download('../outside.bin')
  assert.equal(traversalDownload.status, 400)
  if (process.platform !== 'win32') {
    const outsideAttachment = path.join(recovery, 'outside.bin')
    await fs.writeFile(outsideAttachment, Buffer.from('outside'))
    await fs.symlink(outsideAttachment, path.join(workspace, 'linked.bin'))
    const symlinkDownload = await download('linked.bin')
    assert.equal(symlinkDownload.status, 400)
  }
  const rawMarkdown = await download('invalid.md')
  assert.equal(rawMarkdown.status, 200)
  assert.deepEqual(Buffer.from(await rawMarkdown.arrayBuffer()), invalidUtf8Bytes)

  if (fifoCreated) {
    const fifoRead = await get('blocked.md')
    assert.equal(fifoRead.status, 400)
    assert.equal((await fifoRead.json()).code, 'UNSUPPORTED_FILE_TYPE')
    const fifoWrite = await fetch(`${baseUrl}/api/workspace`, {
      method: 'PUT', headers,
      body: JSON.stringify({ path: 'blocked.md', content: 'must not block', expectedRevision: null }),
    })
    assert.equal(fifoWrite.status, 400)
    assert.equal((await fifoWrite.json()).code, 'UNSUPPORTED_FILE_TYPE')
  }
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
  assert.deepEqual(await restored.json(), {
    success: true,
    path: '.project',
    historyReattached: 0,
    historyOrphaned: 0,
  })
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
