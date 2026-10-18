// @ts-check
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { cleanupBrowserTest } from './helpers/browser-cleanup.js'
import { startChrome } from './helpers/chrome-startup.js'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(frontendRoot, '..')
const distIndex = path.join(frontendRoot, 'dist', 'index.html')
const backendEntry = path.join(repositoryRoot, 'backend', 'src', 'index.js')

class DevToolsConnection {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString())
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Chrome DevTools connection closed'))
      }
      this.pending.clear()
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome DevTools')), 10_000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', error => { clearTimeout(timer); reject(error) }, { once: true })
    })
    return new DevToolsConnection(socket)
  }

  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Chrome DevTools timed out: ${method}`))
      }, 10_000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    }
    return response.result?.value
  }

  close() {
    this.socket.close()
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function waitUntil(description, check, { timeoutMs = 20_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`)
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }
  throw new Error('Chrome or Chromium is required. Set CHROME_PATH to its executable.')
}

/** React-controlled password inputs: write with the native setter + input event. */
const SET_PASSWORD_JS = `
(function setPassword(value) {
  const input = document.querySelector('input[aria-label="访问密码"]')
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  return true
})
`

test('access password gates the editor, then unlocks after login and logout re-locks', { timeout: 90_000 }, async t => {
  await access(distIndex).catch(() => {
    throw new Error('Auth browser test requires frontend/dist/index.html; run `npm run build` in frontend first.')
  })

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-auth-gate-'))
  const workspace = path.join(tempRoot, 'notes')
  const backendPort = await freePort()
  let backendProcess
  let chromeProcess
  let chromePort
  let connection

  t.after(async () => {
    await cleanupBrowserTest({
      browser: { child: chromeProcess, port: chromePort },
      connections: [connection],
      children: [backendProcess],
      tempRoot,
    })
  })

  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, 'note.md'), '# Access gate\n\n已通过密码进入。\n')

  backendProcess = spawn(process.execPath, [backendEntry, '--workspace', workspace], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PORT: String(backendPort),
      HOST: '127.0.0.1',
      FRONTEND_PORT: '5558',
      WORKSPACE_CONFIG_FILE: path.join(tempRoot, 'workspace-config.json'),
      EDITOR_RECOVERY_DIR: path.join(tempRoot, 'recovery'),
      ALLOW_ANY_WORKSPACE: '1',
      EDITOR_PASSWORD: 'gate-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  backendProcess.stdout.setEncoding('utf8').on('data', chunk => { logs += chunk })
  backendProcess.stderr.setEncoding('utf8').on('data', chunk => { logs += chunk })

  const baseUrl = `http://127.0.0.1:${backendPort}`
  await waitUntil('backend with password protection', async () => {
    if (backendProcess.exitCode !== null) throw new Error(`Backend exited (${backendProcess.exitCode}): ${logs}`)
    const health = await fetch(`${baseUrl}/api/auth/session`).catch(() => null)
    return health?.status === 401
  })

  const chrome = await startChrome({ chromePath: await findChrome(), profileDir: path.join(tempRoot, 'chrome-profile') })
  chromeProcess = chrome.child
  chromePort = chrome.port
  const targetResponse = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: 'PUT' })
  const target = await targetResponse.json()
  connection = await DevToolsConnection.connect(target.webSocketDebuggerUrl)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')
  await connection.send('Log.enable')
  await connection.send('Page.navigate', { url: `${baseUrl}/` })

  // The gate appears without any pre-seeded workspace cache.
  await waitUntil('auth gate input', () => connection.evaluate(
    'Boolean(document.querySelector(\'input[aria-label="访问密码"]\'))',
  ), { timeoutMs: 25_000 })

  // A wrong password surfaces an error alert and keeps the gate.
  assert.equal(await connection.evaluate(`${SET_PASSWORD_JS}('wrong-password')`), true)
  await waitUntil('wrong password alert', () => connection.evaluate(
    'Boolean(document.querySelector(\'.auth-gate .ant-alert-error\'))',
  ))

  // The correct password leaves the gate and reaches the workspace UI whose
  // chrome exposes the logout action.
  assert.equal(await connection.evaluate(`${SET_PASSWORD_JS}('gate-password')`), true)
  await waitUntil('logout action after login', () => connection.evaluate(
    'Boolean(document.querySelector(\'button[aria-label="退出登录"]\'))',
  ), { timeoutMs: 25_000 })

  // Mark the mounted editor instance; it must survive lock and unlock.
  assert.equal(await connection.evaluate(
    "document.querySelector('.editor-statusbar').dataset.instance = 'kept', true",
  ), true)

  // Logging out locks the UI without unmounting the editor.
  await connection.evaluate(`document.querySelector('button[aria-label="退出登录"]').click()`)
  await waitUntil('gate after logout', () => connection.evaluate(
    'Boolean(document.querySelector(\'input[aria-label="访问密码"]\'))',
  ), { timeoutMs: 25_000 })
  assert.equal(await connection.evaluate(
    "document.querySelector('.editor-statusbar')?.dataset.instance === 'kept' && document.querySelector('.editor-statusbar').closest('[hidden]') !== null",
  ), true, 'editor should stay mounted behind a hidden wrapper while locked')

  // Signing in again reuses that same editor instance.
  assert.equal(await connection.evaluate(`${SET_PASSWORD_JS}('gate-password')`), true)
  await waitUntil('editor visible after re-login', () => connection.evaluate(
    "document.querySelector('.editor-statusbar')?.dataset.instance === 'kept' && !document.querySelector('.editor-statusbar').closest('[hidden]')",
  ), { timeoutMs: 25_000 })
})
