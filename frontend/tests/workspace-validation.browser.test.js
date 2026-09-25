import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(frontendRoot, '..')
const viteEntry = path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const staleWorkspace = '/Volumes/Notes that is offline'
const selectedWorkspace = '/tmp/standalone-editor-selected-notes'

let tempRoot
let frontendPort
let backendPort
let frontendProcess
let backendServer
let chromeProcess
let chromePort
let chromeProfile
let connection
let logs = ''
const state = {
  checkMode: 'unavailable',
  checkCount: 0,
  editorRequests: 0,
  dirRequests: 0,
  setRequests: 0,
  requestOrder: [],
}

function appendLog(label, chunk) {
  logs += `\n[${label}] ${chunk}`
  if (logs.length > 10000) logs = logs.slice(-10000)
}

function startProcess(label, command, args, env, cwd = repoRoot) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => appendLog(label, chunk.toString()))
  child.stderr.on('data', chunk => appendLog(label, chunk.toString()))
  return child
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function waitUntil(description, check, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}\n${logs}`)
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const finish = exited => {
      clearTimeout(timeout)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  child.kill('SIGTERM')
  if (await waitForProcessExit(child, 2500)) return

  child.kill('SIGKILL')
  if (!await waitForProcessExit(child, 1500)) {
    throw new Error(`Process ${child.pid} did not exit after SIGKILL`)
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  let text = ''
  for await (const chunk of request) text += chunk
  return text ? JSON.parse(text) : {}
}

function workspaceInfo(workspace = selectedWorkspace) {
  return { workspace, workspaceId: 'workspace-validation-test', workspaceVersion: 3 }
}

function createFakeBackend() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${backendPort}`)
    if (url.pathname === '/api/workspace/check' && request.method === 'GET') {
      state.checkCount += 1
      state.requestOrder.push('check')
      if (state.checkMode === 'available') return sendJson(response, 200, workspaceInfo())
      if (state.checkMode === 'invalid') {
        return sendJson(response, 503, {
          code: 'WORKSPACE_CONFIG_INVALID',
          error: '工作区配置文件格式无效。',
          configFile: '/tmp/standalone-editor-config.json',
        })
      }
      return sendJson(response, 503, {
        code: 'SAVED_WORKSPACE_UNAVAILABLE',
        error: '上次使用的工作区当前不可访问。',
        workspace: staleWorkspace,
      })
    }
    if (url.pathname === '/api/dirs' && request.method === 'GET') {
      state.dirRequests += 1
      if (url.searchParams.get('path') === selectedWorkspace) {
        return sendJson(response, 200, {
          path: selectedWorkspace,
          canSelect: true,
          canGoUp: true,
          parent: '/tmp',
          separator: '/',
          roots: [],
          breadcrumb: [{ name: 'tmp', path: '/tmp', canNavigate: true }, { name: 'Notes', path: selectedWorkspace, canNavigate: true }],
          entries: [],
        })
      }
      return sendJson(response, 200, {
        path: '/tmp',
        canSelect: false,
        canGoUp: true,
        parent: '/',
        separator: '/',
        roots: [{ path: '/tmp', name: '临时目录', canNavigate: true }],
        breadcrumb: [{ name: 'tmp', path: '/tmp', canNavigate: true }],
        entries: [{ type: 'dir', name: 'Notes', path: selectedWorkspace, canNavigate: true }],
      })
    }
    if (url.pathname === '/api/workspace/set' && request.method === 'POST') {
      state.setRequests += 1
      await readJson(request)
      return sendJson(response, 409, {
        code: 'RECOVERY_ROOT_INSIDE_WORKSPACE',
        error: '恢复数据目录位于所选工作区内部。',
      })
    }
    if (url.pathname === '/api/workspace' && request.method === 'GET') {
      state.editorRequests += 1
      state.requestOrder.push('editor-tree')
      return sendJson(response, 200, [])
    }
    if (url.pathname.startsWith('/api/workspace/')) return sendJson(response, 200, [])
    return sendJson(response, 404, { error: `Unexpected fake backend request: ${request.method} ${url.pathname}` })
  })
}

class DevToolsConnection {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString())
      if (!message.id) {
        if (message.method === 'Runtime.exceptionThrown') {
          const details = message.params.exceptionDetails
          appendLog('browser exception', details.exception?.description || details.text)
        }
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeoutId)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeoutId)
        pending.reject(new Error('Chrome DevTools connection closed'))
      }
      this.pending.clear()
    })
  }

  static async connect(url) {
    const socket = new globalThis.WebSocket(url)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DevTools connection timeout')), 10000)
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
      socket.addEventListener('error', error => { clearTimeout(timeout); reject(error) }, { once: true })
    })
    return new DevToolsConnection(socket)
  }

  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`Chrome DevTools command timed out: ${method}`))
      }, 10000)
      this.pending.set(id, { resolve, reject, timeoutId })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }

  close() { this.socket.close() }
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
    try { await access(candidate); return candidate } catch {}
  }
  throw new Error('Chrome or Chromium is required. Set CHROME_PATH to its executable.')
}

async function navigateWithLocalStorage() {
  const cached = JSON.stringify({ workspace: staleWorkspace, workspaceId: 'stale-workspace', workspaceVersion: 1 })
  await connection.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('editor_workspace_info', ${JSON.stringify(cached)}); localStorage.setItem('editor_workspace', ${JSON.stringify(staleWorkspace)});`,
  })
  await connection.send('Page.navigate', { url: `http://127.0.0.1:${frontendPort}/` })
  await waitUntil('workspace selection screen to appear', () => connection.evaluate(
    `Array.from(document.querySelectorAll('button')).some(button => button.innerText.trim() === '选择工作目录')`,
  ))
}

async function clickButton(label) {
  const result = await connection.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(item => item.innerText.replace(/\\s/g, '').trim() === ${JSON.stringify(label)});
    button?.click();
    return {
      clicked: Boolean(button),
      labels: Array.from(document.querySelectorAll('button')).map(item => item.innerText.trim()),
      body: document.body.innerText.slice(0, 1200),
      alert: document.querySelector('.ant-alert')?.outerHTML.slice(0, 1500) || '',
    };
  })()`)
  assert.equal(result.clicked, true, `Expected a button labeled ${label}; DOM: ${JSON.stringify(result)}`)
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-workspace-check-'))
  frontendPort = await freePort()
  backendPort = await freePort()
  Object.assign(state, { checkMode: 'unavailable', checkCount: 0, editorRequests: 0, dirRequests: 0, setRequests: 0, requestOrder: [] })

  backendServer = createFakeBackend()
  await new Promise((resolve, reject) => {
    backendServer.once('error', reject)
    backendServer.listen(backendPort, '127.0.0.1', resolve)
  })
  frontendProcess = startProcess('vite', process.execPath, [viteEntry, '--host', '127.0.0.1', '--strictPort'], {
    ...process.env,
    FRONTEND_PORT: String(frontendPort),
    EDITOR_PORT: String(backendPort),
  }, frontendRoot)

  await waitUntil('Vite to start', async () => {
    const response = await fetch(`http://127.0.0.1:${frontendPort}/`).catch(() => null)
    return response?.ok
  })

  const chrome = await findChrome()
  chromeProfile = path.join(tempRoot, 'chrome-profile')
  chromeProcess = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--remote-debugging-port=0',
    `--user-data-dir=${chromeProfile}`, 'about:blank',
  ], { stdio: 'ignore' })
  const activePortFile = path.join(chromeProfile, 'DevToolsActivePort')
  chromePort = await waitUntil('Chrome DevTools endpoint', async () => {
    const contents = await readFile(activePortFile, 'utf8').catch(() => '')
    const port = Number(contents.split('\n')[0])
    return port > 0 ? port : null
  })
  const response = await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: 'PUT' })
  assert.equal(response.ok, true)
  const target = await response.json()
  connection = await DevToolsConnection.connect(target.webSocketDebuggerUrl)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')
  await navigateWithLocalStorage()
})

after(async () => {
  connection?.close()
  const cleanupErrors = []
  for (const child of [chromeProcess, frontendProcess]) {
    try {
      await stopProcess(child)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (backendServer?.listening) {
    try {
      await new Promise((resolve, reject) => backendServer.close(error => error ? reject(error) : resolve()))
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (tempRoot) {
    try {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Browser test cleanup failed')
})

test('stale browser workspace is diagnostic only and retry enters editor only after /check succeeds', async () => {
  await waitUntil('offline path in diagnostic', () => connection.evaluate(
    `document.body.innerText.includes(${JSON.stringify(staleWorkspace)})`,
  ))
  assert.equal(await connection.evaluate(`localStorage.getItem('editor_workspace')`), null)
  assert.equal(await connection.evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.innerText.trim() === '打开当前目录')`), false)
  assert.equal(state.editorRequests, 0, 'failed /check must not mount Editor or request its tree')

  await clickButton('重试')
  await waitUntil('second failed check and retry affordance', () => state.checkCount >= 2 && connection.evaluate(
    `document.body.innerText.includes('上次记录的路径（当前未验证）') && Array.from(document.querySelectorAll('button')).some(button => button.innerText.trim() === '重试')`,
  ))
  assert.equal(state.editorRequests, 0, 'retry failure must also keep the editor closed')

  state.checkMode = 'available'
  await clickButton('重试')
  await waitUntil('editor tree request after successful /check', () => state.editorRequests > 0)
  const lastCheck = state.requestOrder.lastIndexOf('check')
  const editorRequest = state.requestOrder.indexOf('editor-tree')
  assert.ok(lastCheck >= 0 && editorRequest > lastCheck, 'Editor requests must happen after a successful workspace check')
})

test('invalid saved config still allows directory browsing and shows recovery-root selection errors', async () => {
  state.checkMode = 'invalid'
  state.checkCount = 0
  state.editorRequests = 0
  state.dirRequests = 0
  state.setRequests = 0
  state.requestOrder = []
  await navigateWithLocalStorage()
  await waitUntil('configuration diagnostic', () => connection.evaluate(
    `document.body.innerText.includes('工作区配置文件格式无效。') && document.body.innerText.includes('/tmp/standalone-editor-config.json')`,
  ))
  assert.equal(await connection.evaluate(`document.body.innerText.includes('上次记录的路径（当前未验证）')`), false, 'a client cache must not be presented as the server-saved path for a malformed config')

  await clickButton('选择工作目录')
  await waitUntil('directory roots request despite missing active workspace', () => state.dirRequests > 0)
  await waitUntil('directory entry in picker', () => connection.evaluate(`document.body.innerText.includes('Notes')`))
  await connection.evaluate(`(() => {
    const entry = Array.from(document.querySelectorAll('.ant-modal-body span')).find(item => item.innerText.trim() === 'Notes');
    entry?.click();
    return Boolean(entry);
  })()`)
  await waitUntil('selected folder loaded', () => connection.evaluate(`document.body.innerText.includes('确认选择') && document.querySelector('.ant-modal-body')?.innerText.includes('Notes')`))
  await clickButton('确认选择')
  await waitUntil('backend rejected invalid recovery location', () => state.setRequests === 1 && connection.evaluate(
    `Array.from(document.querySelectorAll('[role="alert"]')).some(item => item.innerText.includes('恢复数据目录位于所选工作区内部'))`,
  ))
  assert.equal(state.editorRequests, 0, 'a rejected workspace selection must never mount Editor')
  await clickButton('取消')

  state.checkMode = 'available'
  await clickButton('重试')
  await waitUntil('valid backend check to enter the editor', () => state.editorRequests > 0)
})
