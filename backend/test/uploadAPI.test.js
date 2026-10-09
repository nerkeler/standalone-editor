import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isolatedTestRoot = process.env.N03_UPLOAD_TEST_ROOT || os.tmpdir()

async function temporaryDirectory(t, prefix) {
  await fs.mkdir(isolatedTestRoot, { recursive: true })
  const directory = await fs.mkdtemp(path.join(isolatedTestRoot, `${prefix}-`))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function startBackendWithUploadFailure(t, workspace, recovery, failureCode, failureStage = 'write') {
  const source = `
    import fs from 'node:fs/promises'
    const realOpen = fs.open
    if (process.env.UPLOAD_INJECT_STAGE === 'write') {
      fs.open = async (...args) => {
        const handle = await realOpen(...args)
        if (!String(args[0]).endsWith('.upload.tmp')) return handle
        return {
          stat: (...statArgs) => handle.stat(...statArgs),
          read: (...readArgs) => handle.read(...readArgs),
          writeFile: async bytes => {
            await handle.write(Buffer.from(bytes).subarray(0, 3))
            throw Object.assign(new Error('injected multipart upload storage failure'), { code: process.env.UPLOAD_INJECT_FAILURE })
          },
          sync: (...syncArgs) => handle.sync(...syncArgs),
          close: (...closeArgs) => handle.close(...closeArgs),
        }
      }
    }
    if (process.env.UPLOAD_INJECT_STAGE === 'link') {
      const realLink = fs.link
      fs.link = async (source, destination) => {
        if (String(source).endsWith('.upload.tmp')) {
          throw Object.assign(new Error('injected unsupported upload publication'), { code: process.env.UPLOAD_INJECT_FAILURE })
        }
        return realLink(source, destination)
      }
    }
    const { createBackend } = await import('./src/index.js')
    const { createHttpServer } = await import('./src/httpServer.js')
    const backend = createBackend()
    await backend.initialize()
    const server = createHttpServer(backend.app)
    server.once('listening', () => process.send({ port: server.address().port }))
    server.once('error', error => process.send({ error: { code: error.code, message: error.message } }))
    server.listen(0, '127.0.0.1')
  `
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
      UPLOAD_INJECT_FAILURE: failureCode,
      UPLOAD_INJECT_STAGE: failureStage,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', resolve)
      setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1000)
    })
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend did not start: ${output}`)), 5000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`backend exited (${code}): ${output}`)) })
    child.on('message', message => {
      if (message?.port) { clearTimeout(timer); resolve(message.port) }
      if (message?.error) { clearTimeout(timer); reject(new Error(`backend listen failed (${message.error.code}): ${message.error.message}`)) }
    })
  })
  return `http://127.0.0.1:${port}`
}

test('multipart documentPath uploads return server storage errors and never expose partial attachments', async t => {
  for (const [failureCode, expectedStatus, failureStage, expectedBodyCode] of [
    ['EIO', 500, 'write', 'EIO'],
    ['ENOSPC', 507, 'write', 'ENOSPC'],
    ['EOPNOTSUPP', 500, 'link', 'UNSUPPORTED_UPLOAD_FILESYSTEM'],
  ]) {
    await t.test(expectedBodyCode, async t => {
      const root = await temporaryDirectory(t, `api-${failureCode}`)
      const workspace = path.join(root, 'workspace')
      const recovery = path.join(root, 'recovery')
      await fs.mkdir(path.join(workspace, 'docs'), { recursive: true })
      await fs.mkdir(recovery)
      await fs.writeFile(path.join(workspace, 'docs', 'note.md'), '# note\n')
      const baseUrl = await startBackendWithUploadFailure(t, workspace, recovery, failureCode, failureStage)
      const check = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
      const form = new FormData()
      form.append('file', new Blob([Buffer.from('0123456789')]), 'attachment.png')
      form.append('documentPath', 'docs/note.md')
      const response = await fetch(`${baseUrl}/api/workspace/upload`, {
        method: 'POST',
        headers: {
          'X-Workspace-Id': check.workspaceId,
          'X-Workspace-Version': String(check.workspaceVersion),
        },
        body: form,
      })

      assert.equal(response.status, expectedStatus)
      const body = await response.json()
      assert.equal(body.code, expectedBodyCode)
      if (expectedBodyCode === 'UNSUPPORTED_UPLOAD_FILESYSTEM') assert.equal(body.causeCode, 'EOPNOTSUPP')
      const assets = path.join(workspace, 'docs', 'assets')
      await assert.rejects(fs.lstat(path.join(assets, 'attachment.png')), error => error.code === 'ENOENT')
      assert.deepEqual((await fs.readdir(assets)).filter(name => name.endsWith('.upload.tmp')), [])
    })
  }
})
