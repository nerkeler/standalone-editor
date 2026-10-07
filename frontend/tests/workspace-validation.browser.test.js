import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { startChrome as startChromeProcess } from './helpers/chrome-startup.js'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(frontendRoot, '..')
const viteEntry = path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js')
let evidenceDir
const staleWorkspace = '/Volumes/Notes that is offline'
const selectedWorkspace = '/tmp/standalone-editor-selected-notes'
const longPickerPath = `/srv/archive/field-notes  ${'archive-'.repeat(9)}final`
const longPathSegments = longPickerPath.split('/').filter(Boolean)
const longPathPrefixes = longPathSegments.map((_, index) => `/${longPathSegments.slice(0, index + 1).join('/')}`)
const longPathBreadcrumb = [
  { name: '/', path: '/', canNavigate: true, canSelect: false },
  ...longPathSegments.map((name, index) => ({
    name,
    path: longPathPrefixes[index],
    canNavigate: true,
    canSelect: index === longPathSegments.length - 1,
  })),
]
const longEntryName = `meeting-notes-${'with-a-very-long-name-'.repeat(5)}2026.md`
const driveRoot = 'E:\\'
const driveNotes = 'E:\\Notes'
const uncRoot = '\\\\nas\\shared'
const uncTeam = '\\\\nas\\shared\\Team Notes'

let tempRoot
let frontendPort
let backendPort
let frontendProcess
let backendServer
let chromeProcess
let chromePort
let chromeProfile
let chromeTargetId
let connection
let logs = ''
const state = {
  phase: 'setup',
  checkMode: 'unavailable',
  checkCount: 0,
  editorRequests: 0,
  editorRequestDetails: [],
  dirRequests: 0,
  dirPaths: [],
  directoryLocationMode: false,
  directoryScenario: 'posix',
  dirDelayPath: null,
  dirDelayGate: null,
  setRequests: 0,
  setPaths: [],
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

async function waitForEditorRequestsToSettle(quietMs = 500, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let previousCount = state.editorRequests
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    if (state.editorRequests !== previousCount) {
      previousCount = state.editorRequests
      quietSince = Date.now()
    }
    if (Date.now() - quietSince >= quietMs) return
  }
  throw new Error(`Timed out waiting for old editor requests to settle: ${JSON.stringify(state.editorRequestDetails)}`)
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
    if (url.pathname === '/api/proxy-origin-check' && request.method === 'POST') {
      return sendJson(response, 200, {
        host: request.headers.host,
        origin: request.headers.origin,
      })
    }
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
      const requestedPath = url.searchParams.get('path') || ''
      state.dirPaths.push(requestedPath)
      if (requestedPath === state.dirDelayPath && state.dirDelayGate) await state.dirDelayGate
      if (state.directoryLocationMode) {
        if (state.directoryScenario === 'longpath') {
          const pathIndex = longPathPrefixes.indexOf(requestedPath)
          const currentPath = pathIndex >= 0 ? longPathPrefixes[pathIndex] : '/'
          const inArchive = currentPath === longPickerPath
          return sendJson(response, 200, {
            path: currentPath,
            canSelect: inArchive,
            canGoUp: currentPath !== '/',
            parent: currentPath === '/' ? null : pathIndex === 0 ? '/' : longPathPrefixes[pathIndex - 1],
            separator: '/',
            roots: [{ path: '/', name: '/', canNavigate: true, canSelect: false }],
            locations: [
              { path: '/', name: '/', canNavigate: true, canSelect: false },
              { path: longPickerPath, name: '项目归档', canNavigate: true, canSelect: true },
            ],
            breadcrumb: longPathBreadcrumb.slice(0, pathIndex + 2),
            entries: inArchive
              ? [{ type: 'file', name: longEntryName, path: `${longPickerPath}/${longEntryName}`, canNavigate: false }]
              : pathIndex < longPathPrefixes.length - 1
                ? [{ type: 'dir', name: longPathSegments[pathIndex + 1], path: longPathPrefixes[pathIndex + 1], canNavigate: true, canSelect: false }]
                : [],
          })
        }

        if (state.directoryScenario === 'windows-drive') {
          const inNotes = requestedPath === driveNotes
          return sendJson(response, 200, {
            path: inNotes ? driveNotes : driveRoot,
            canSelect: inNotes,
            canGoUp: inNotes,
            parent: inNotes ? driveRoot : null,
            separator: '\\',
            roots: [{ path: driveRoot, name: driveRoot, canNavigate: true, canSelect: false }],
            locations: [
              { path: driveRoot, name: driveRoot, canNavigate: true, canSelect: false },
              { path: driveNotes, name: 'Notes', canNavigate: true, canSelect: true },
            ],
            breadcrumb: inNotes
              ? [
                { name: driveRoot, path: driveRoot, canNavigate: true, canSelect: false },
                { name: 'Notes', path: driveNotes, canNavigate: true, canSelect: true },
              ]
              : [{ name: driveRoot, path: driveRoot, canNavigate: true, canSelect: false }],
            entries: inNotes ? [] : [{ type: 'dir', name: 'Notes', path: driveNotes, canNavigate: true, canSelect: true }],
          })
        }

        if (state.directoryScenario === 'unc') {
          const inTeam = requestedPath === uncTeam
          return sendJson(response, 200, {
            path: inTeam ? uncTeam : uncRoot,
            canSelect: inTeam,
            canGoUp: inTeam,
            parent: inTeam ? uncRoot : null,
            separator: '\\',
            roots: [{ path: uncRoot, name: uncRoot, canNavigate: true, canSelect: false }],
            locations: [
              { path: uncRoot, name: uncRoot, canNavigate: true, canSelect: false },
              { path: uncTeam, name: 'Team Notes', canNavigate: true, canSelect: true },
            ],
            breadcrumb: inTeam
              ? [
                { name: uncRoot, path: uncRoot, canNavigate: true, canSelect: false },
                { name: 'Team Notes', path: uncTeam, canNavigate: true, canSelect: true },
              ]
              : [{ name: uncRoot, path: uncRoot, canNavigate: true, canSelect: false }],
            entries: inTeam ? [] : [{ type: 'dir', name: 'Team Notes', path: uncTeam, canNavigate: true, canSelect: true }],
          })
        }

        const knownPath = new Map([
          ['/', '/'],
          ['/home', '/home'],
          ['/home/alice', '/home/alice'],
          ['/mnt', '/mnt'],
          ['/media', '/media'],
          ['/tmp', '/tmp'],
        ])
        const currentPath = knownPath.get(requestedPath) || '/'
        const inHome = currentPath === '/home/alice'
        const currentShortcut = [
          { name: 'alice', path: '/home/alice' },
          { name: 'mnt', path: '/mnt' },
          { name: 'media', path: '/media' },
          { name: 'tmp', path: '/tmp' },
        ].find(location => location.path === currentPath)
        return sendJson(response, 200, {
          path: currentPath,
          canSelect: inHome,
          canGoUp: currentPath !== '/',
          parent: currentPath !== '/' ? '/' : null,
          separator: '/',
          roots: [{ path: '/', name: '/', canNavigate: true, canSelect: false }],
          locations: [
            { path: '/', name: '/', canNavigate: true, canSelect: false },
            { path: '/home/alice', name: 'alice', canNavigate: true, canSelect: true },
            { path: '/mnt', name: 'mnt', canNavigate: true, canSelect: false },
            { path: '/media', name: 'media', canNavigate: true, canSelect: false },
            { path: '/tmp', name: 'tmp', canNavigate: true, canSelect: false },
          ],
          breadcrumb: inHome
            ? [
              { name: '/', path: '/', canNavigate: true, canSelect: false },
              { name: 'home', path: '/home', canNavigate: true, canSelect: false },
              { name: 'alice', path: '/home/alice', canNavigate: true, canSelect: true },
            ]
            : currentPath === '/home'
              ? [
                { name: '/', path: '/', canNavigate: true, canSelect: false },
                { name: 'home', path: '/home', canNavigate: true, canSelect: false },
              ]
            : currentShortcut
              ? [
                { name: '/', path: '/', canNavigate: true, canSelect: false },
                { name: currentShortcut.name, path: currentShortcut.path, canNavigate: true, canSelect: false },
              ]
            : [{ name: '/', path: '/', canNavigate: true, canSelect: false }],
          entries: inHome
            ? [{ type: 'dir', name: 'Projects', path: '/home/alice/Projects', canNavigate: true, canSelect: true }]
            : [],
        })
      }
      if (url.searchParams.get('path') === selectedWorkspace) {
        return sendJson(response, 200, {
          path: selectedWorkspace,
          canSelect: true,
          canGoUp: true,
          parent: '/tmp',
          separator: '/',
          roots: [{ path: '/tmp', name: '临时目录', canNavigate: true, canSelect: false }],
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
      const payload = await readJson(request)
      state.setPaths.push(payload.path)
      return sendJson(response, 409, {
        code: 'RECOVERY_ROOT_INSIDE_WORKSPACE',
        error: '恢复数据目录位于所选工作区内部。',
      })
    }
    if (url.pathname === '/api/workspace' && request.method === 'GET') {
      state.editorRequests += 1
      state.requestOrder.push('editor-tree')
      state.editorRequestDetails.push({
        phase: state.phase,
        pageId: request.headers['x-test-page-target'] || null,
        workspaceId: request.headers['x-workspace-id'] || null,
        workspaceVersion: request.headers['x-workspace-version'] || null,
        referer: request.headers.referer || null,
        receivedAt: Date.now(),
      })
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
    source: `localStorage.setItem('editor_workspace_info', ${JSON.stringify(cached)}); localStorage.setItem('editor_workspace', ${JSON.stringify(staleWorkspace)}); localStorage.setItem('editor_theme', 'light');`,
  })
  await connection.send('Page.navigate', { url: `http://127.0.0.1:${frontendPort}/` })
  await waitUntil('workspace selection screen to appear', () => connection.evaluate(
    `Array.from(document.querySelectorAll('button')).some(button => button.innerText.trim() === '选择工作目录')`,
  ))
}

async function setBrowserViewport(width, height, mobile = false) {
  await connection.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  })
  await connection.send('Emulation.setTouchEmulationEnabled', mobile
    ? { enabled: true, maxTouchPoints: 1 }
    : { enabled: false })
}

async function saveBrowserScreenshot(filePath) {
  await new Promise(resolve => setTimeout(resolve, 350))
  const captured = await connection.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  await writeFile(filePath, Buffer.from(captured.data, 'base64'))
  return filePath
}

async function openBrowserTarget() {
  const response = await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: 'PUT' })
  assert.equal(response.ok, true, 'Chrome should create an isolated page target')
  const target = await response.json()
  chromeTargetId = target.id
  connection = await DevToolsConnection.connect(target.webSocketDebuggerUrl)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')
  await connection.send('Network.enable')
  await connection.send('Network.setExtraHTTPHeaders', {
    headers: { 'X-Test-Page-Target': chromeTargetId },
  })
}

function currentPageEditorRequests() {
  return state.editorRequestDetails.filter(request => request.pageId === chromeTargetId)
}

async function closeBrowserTarget() {
  const targetId = chromeTargetId
  const targetConnection = connection
  chromeTargetId = null
  connection = null
  if (!targetId) return
  try {
    const response = await fetch(`http://127.0.0.1:${chromePort}/json/close/${targetId}`)
    assert.equal(response.ok, true, 'Chrome should close the previous test page')
  } finally {
    targetConnection?.close()
  }
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
  evidenceDir = process.env.WORKSPACE_PICKER_EVIDENCE_DIR || path.join(tempRoot, 'evidence')
  await mkdir(evidenceDir, { recursive: true })
  frontendPort = await freePort()
  backendPort = await freePort()
  Object.assign(state, { phase: 'setup', checkMode: 'unavailable', checkCount: 0, editorRequests: 0, editorRequestDetails: [], dirRequests: 0, dirPaths: [], directoryLocationMode: false, directoryScenario: 'posix', dirDelayPath: null, dirDelayGate: null, setRequests: 0, setPaths: [], requestOrder: [] })

  backendServer = createFakeBackend()
  await new Promise((resolve, reject) => {
    backendServer.once('error', reject)
    backendServer.listen(backendPort, '127.0.0.1', resolve)
  })
  frontendProcess = startProcess('vite', process.execPath, [viteEntry, '--host', '127.0.0.1', '--strictPort'], {
    ...process.env,
    FRONTEND_PORT: String(frontendPort),
    EDITOR_PORT: String(backendPort),
    FRONTEND_ALLOWED_HOSTS: 'notes.example.test',
  }, frontendRoot)

  await waitUntil('Vite to start', async () => {
    const response = await fetch(`http://127.0.0.1:${frontendPort}/`).catch(() => null)
    return response?.ok
  })

  const chrome = await findChrome()
  chromeProfile = path.join(tempRoot, 'chrome-profile')
  const started = await startChromeProcess({ chromePath: chrome, profileDir: chromeProfile })
  chromeProcess = started.child
  chromePort = started.port
  await openBrowserTarget()
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

test('Vite preserves the browser-facing Host and Origin for the backend', async () => {
  const host = `127.0.0.1:${frontendPort}`
  const origin = `http://${host}`
  const response = await fetch(`${origin}/api/proxy-origin-check`, {
    method: 'POST',
    headers: { Origin: origin },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { host, origin })

  const domainHost = `notes.example.test:${frontendPort}`
  const domainOrigin = `https://${domainHost}`
  const forwarded = await new Promise((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:${frontendPort}/api/proxy-origin-check`, {
      method: 'POST',
      headers: { Host: domainHost, Origin: domainOrigin },
    }, incoming => {
      let body = ''
      incoming.setEncoding('utf8').on('data', chunk => { body += chunk })
      incoming.on('end', () => resolve({ status: incoming.statusCode, body }))
      incoming.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
  assert.equal(forwarded.status, 200)
  assert.deepEqual(JSON.parse(forwarded.body), { host: domainHost, origin: domainOrigin })
})

test('stale browser workspace is diagnostic only and retry enters editor only after /check succeeds', async () => {
  state.phase = 'stale-workspace'
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
  assert.ok(currentPageEditorRequests().length > 0, `the current test page should issue its editor tree request; requests: ${JSON.stringify(state.editorRequestDetails)}`)
  const lastCheck = state.requestOrder.lastIndexOf('check')
  const editorRequest = state.requestOrder.indexOf('editor-tree')
  assert.ok(lastCheck >= 0 && editorRequest > lastCheck, 'Editor requests must happen after a successful workspace check')
})

test('invalid saved config still allows directory browsing and shows recovery-root selection errors', async () => {
  state.phase = 'closing-previous-page'
  await closeBrowserTarget()
  await waitForEditorRequestsToSettle()
  state.checkMode = 'invalid'
  state.checkCount = 0
  state.editorRequests = 0
  state.dirRequests = 0
  state.dirPaths = []
  state.directoryLocationMode = false
  state.dirDelayPath = null
  state.dirDelayGate = null
  state.setRequests = 0
  state.setPaths = []
  state.requestOrder = []
  state.phase = 'invalid-config'
  await openBrowserTarget()
  await navigateWithLocalStorage()
  await waitUntil('configuration diagnostic', () => connection.evaluate(
    `document.body.innerText.includes('工作区配置文件格式无效。') && document.body.innerText.includes('/tmp/standalone-editor-config.json')`,
  ))
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-sidebar'))`), false, 'invalid configuration must keep Editor unmounted')
  assert.equal(currentPageEditorRequests().length, 0, `invalid configuration page must not request the editor tree; requests: ${JSON.stringify(state.editorRequestDetails)}`)
  assert.equal(await connection.evaluate(`document.body.innerText.includes('上次记录的路径（当前未验证）')`), false, 'a client cache must not be presented as the server-saved path for a malformed config')

  await clickButton('选择工作目录')
  await waitUntil('directory roots request despite missing active workspace', () => state.dirRequests > 0)
  await waitUntil('directory entry in picker', () => connection.evaluate(`document.body.innerText.includes('Notes')`))
  assert.equal(await connection.evaluate(`document.querySelector('.workspace-picker-current-path')?.innerText`), '/tmp', 'a roots-only response should show its server current path as the primary location')
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-picker-shortcut[data-path="/tmp"]'))`), false, 'the current root-only path should not be repeated as a shortcut')
  const selectedFolderClicked = await connection.evaluate(`(() => {
    const entry = document.querySelector('.welcome-directory-entry[data-path="${selectedWorkspace}"]');
    entry?.click();
    return Boolean(entry);
  })()`)
  assert.equal(selectedFolderClicked, true, 'the fake backend folder should be navigable from the listing')
  await waitUntil('selected folder loaded', () => connection.evaluate(
    `document.querySelector('.workspace-picker-current-path')?.innerText === ${JSON.stringify(selectedWorkspace)}`,
  ))
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-picker-shortcut[data-path="/tmp"]'))`), true, 'the parent root should remain available as a shortcut inside its child directory')
  const parentShortcutClicked = await connection.evaluate(`(() => {
    const button = document.querySelector('.workspace-picker-shortcut[data-path="/tmp"]');
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(parentShortcutClicked, true, 'the parent root shortcut should navigate using the backend path')
  await waitUntil('parent root shortcut to restore /tmp', () => state.dirPaths.at(-1) === '/tmp' && connection.evaluate(
    `document.querySelector('.workspace-picker-current-path')?.innerText === '/tmp'`,
  ))
  const selectedFolderClickedAgain = await connection.evaluate(`(() => {
    const entry = document.querySelector('.welcome-directory-entry[data-path="${selectedWorkspace}"]');
    entry?.click();
    return Boolean(entry);
  })()`)
  assert.equal(selectedFolderClickedAgain, true)
  await waitUntil('selected folder to reopen after parent navigation', () => state.dirPaths.at(-1) === selectedWorkspace && connection.evaluate(
    `document.querySelector('.workspace-picker-current-path')?.innerText === ${JSON.stringify(selectedWorkspace)}`,
  ))
  await clickButton('确认选择')
  await waitUntil('backend rejected invalid recovery location', () => state.setRequests === 1 && connection.evaluate(
    `Array.from(document.querySelectorAll('[role="alert"]')).some(item => item.innerText.includes('恢复数据目录位于所选工作区内部'))`,
  ))
  assert.equal(currentPageEditorRequests().length, 0, `a rejected workspace selection must never request the editor tree; requests: ${JSON.stringify(state.editorRequestDetails)}`)
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-sidebar'))`), false, 'a rejected workspace selection must keep Editor unmounted')
  await clickButton('取消')

  state.checkMode = 'available'
  await clickButton('重试')
  await waitUntil('valid backend check to enter the editor', () => currentPageEditorRequests().length > 0)
})

test('directory picker shows and follows Linux locations alongside roots', async () => {
  state.phase = 'closing-previous-page-for-locations'
  await closeBrowserTarget()
  await waitForEditorRequestsToSettle()
  state.checkMode = 'invalid'
  state.checkCount = 0
  state.editorRequests = 0
  state.dirRequests = 0
  state.dirPaths = []
  state.directoryLocationMode = true
  state.directoryScenario = 'posix'
  state.setRequests = 0
  state.setPaths = []
  state.requestOrder = []
  state.phase = 'directory-locations'
  await openBrowserTarget()
  await navigateWithLocalStorage()
  await setBrowserViewport(1280, 900)

  await clickButton('选择工作目录')
  await waitUntil('directory roots and locations to load', () => state.dirRequests > 0 && connection.evaluate(
    `Boolean(document.querySelector('button[data-path="/home/alice"]'))`,
  ))
  assert.deepEqual(state.dirPaths, [''], 'the picker should start from the fake filesystem root')
  assert.equal(
    await connection.evaluate(`Array.from(document.querySelectorAll('button[data-path]')).some(button => button.dataset.path === '/home/alice' && button.innerText.includes('/home/alice'))`),
    true,
    'the home shortcut must show its backend path even though roots only contains /',
  )
  assert.equal(await connection.evaluate(`document.querySelector('.workspace-picker-current-path')?.innerText`), '/', 'the current absolute path should be shown in full')
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-picker-shortcut[data-path="/"]'))`), false, 'the root current path should not be repeated in quick access')
  assert.equal(await connection.evaluate(`document.querySelectorAll('.workspace-picker-shortcut').length`), 4, 'quick access should only show other backend locations')

  const clicked = await connection.evaluate(`(() => {
    const button = document.querySelector('button[data-path="/home/alice"]');
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(clicked, true)
  await waitUntil('home shortcut navigation request and listing', () =>
    state.dirPaths.includes('/home/alice') && connection.evaluate(
      `document.querySelector('.ant-modal-body')?.innerText.includes('Projects')`,
    ),
  )
  assert.equal(state.dirPaths.at(-1), '/home/alice')
  assert.equal(await connection.evaluate(`document.querySelector('.workspace-picker-current-path')?.innerText`), '/home/alice')
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-picker-shortcut[data-path="/home/alice"]'))`), false, 'the current path should not be duplicated in quick access')
  const desktopShot = await saveBrowserScreenshot(`${evidenceDir}/desktop-light.png`)
  assert.ok((await readFile(desktopShot)).length > 1000, 'desktop light screenshot should be captured')

  await setBrowserViewport(390, 844, true)
  await waitUntil('coarse pointer emulation to apply', () => connection.evaluate(`matchMedia('(pointer: coarse)').matches`))
  const touchTargetGeometry = await connection.evaluate(`(() => {
    const rect = element => {
      const value = element?.getBoundingClientRect();
      return value && { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    return {
      up: rect(document.querySelector('.workspace-picker-up')),
      shortcutRoot: rect(document.querySelector('.workspace-picker-shortcut[data-path="/"]')),
    };
  })()`)
  assert.ok(touchTargetGeometry.up.width >= 44 && touchTargetGeometry.up.height >= 44, `up navigation target should be at least 44x44: ${JSON.stringify(touchTargetGeometry)}`)
  assert.ok(touchTargetGeometry.shortcutRoot.width >= 44 && touchTargetGeometry.shortcutRoot.height >= 44, `root shortcut target should be at least 44x44: ${JSON.stringify(touchTargetGeometry)}`)
  const rootShortcutClicked = await connection.evaluate(`(() => {
    const button = document.querySelector('.workspace-picker-shortcut[data-path="/"]');
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(rootShortcutClicked, true)
  await waitUntil('root shortcut to navigate using its backend path', () => state.dirPaths.at(-1) === '/' && connection.evaluate(
    `document.querySelector('.workspace-picker-current-path')?.innerText === '/' && !document.querySelector('.workspace-picker-shortcut[data-path="/"]')`,
  ))
  const homeShortcutClickedAgain = await connection.evaluate(`(() => {
    const button = document.querySelector('.workspace-picker-shortcut[data-path="/home/alice"]');
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(homeShortcutClickedAgain, true)
  await waitUntil('home shortcut to restore the current path', () => state.dirPaths.at(-1) === '/home/alice' && connection.evaluate(
    `document.querySelector('.workspace-picker-current-path')?.innerText === '/home/alice'`,
  ))
  await setBrowserViewport(1280, 900)

  state.dirDelayPath = '/media'
  let releaseDelayedDirectory
  state.dirDelayGate = new Promise(resolve => { releaseDelayedDirectory = resolve })
  try {
    const mediaShortcutClicked = await connection.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.workspace-picker-shortcut')).find(item => item.dataset.path === '/media');
      button?.click();
      return Boolean(button);
    })()`)
    assert.equal(mediaShortcutClicked, true)
    await waitUntil('delayed location request to be in flight', () => state.dirPaths.includes('/media') && connection.evaluate(`(() => {
      const confirm = document.querySelector('.ant-modal-footer .ant-btn-primary');
      return document.querySelector('.workspace-picker-list')?.getAttribute('aria-busy') === 'true'
        && !document.querySelector('.workspace-picker-current-path')
        && confirm?.disabled === true;
    })()`))
    await clickButton('确认选择')
    assert.equal(state.setRequests, 0, 'a pending directory load must not submit the previous path')
  } finally {
    releaseDelayedDirectory()
    state.dirDelayPath = null
    state.dirDelayGate = null
  }
  await waitUntil('delayed media location response to load', () => connection.evaluate(`document.querySelector('.workspace-picker-current-path')?.innerText === '/media'`))
  const homeShortcutClicked = await connection.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.workspace-picker-shortcut')).find(item => item.dataset.path === '/home/alice');
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(homeShortcutClicked, true)
  await waitUntil('home directory to reload after pending-state check', () => connection.evaluate(
    `document.querySelector('.workspace-picker-current-path')?.innerText === '/home/alice' && document.body.innerText.includes('Projects')`,
  ))
  await clickButton('确认选择')
  await waitUntil('backend rejected fake POSIX selection', () => state.setRequests === 1)
  assert.equal(state.setPaths.at(-1), '/home/alice', 'selection must submit the exact path from the loaded backend response')
  await clickButton('取消')
})

test('directory picker keeps long paths readable on mobile and preserves Windows and UNC paths', async () => {
  state.phase = 'closing-previous-page-for-path-shapes'
  await closeBrowserTarget()
  await waitForEditorRequestsToSettle()
  state.checkMode = 'invalid'
  state.checkCount = 0
  state.editorRequests = 0
  state.dirRequests = 0
  state.dirPaths = []
  state.directoryLocationMode = true
  state.dirDelayPath = null
  state.dirDelayGate = null
  state.directoryScenario = 'longpath'
  state.setRequests = 0
  state.setPaths = []
  state.requestOrder = []
  state.phase = 'directory-path-shapes'
  await openBrowserTarget()
  await navigateWithLocalStorage()
  await setBrowserViewport(390, 844, true)

  await connection.evaluate(`document.querySelector('.theme-toggle')?.click()`)
  await waitUntil('dark theme to apply', () => connection.evaluate(`document.documentElement.dataset.theme === 'dark'`))
  await clickButton('选择工作目录')
  await waitUntil('long path shortcuts to load', () => state.dirRequests > 0 && connection.evaluate(
    `Array.from(document.querySelectorAll('.workspace-picker-shortcut')).some(button => button.dataset.path === ${JSON.stringify(longPickerPath)})`,
  ))
  const openLongPath = await connection.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.workspace-picker-shortcut')).find(item => item.dataset.path === ${JSON.stringify(longPickerPath)});
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(openLongPath, true)
  await waitUntil('long directory path and entry to display', () => state.dirPaths.includes(longPickerPath) && connection.evaluate(
    `document.querySelector('.workspace-picker-current-path')?.textContent === ${JSON.stringify(longPickerPath)} && document.body.innerText.includes(${JSON.stringify(longEntryName)})`,
  ))
  assert.equal(await connection.evaluate(`getComputedStyle(document.querySelector('.workspace-picker-current-path')).whiteSpace`), 'break-spaces', 'repeated spaces in the server path should remain visible')
  assert.equal(await connection.evaluate(`document.querySelector('.workspace-picker-current-path')?.innerText`), longPickerPath, 'the displayed path text should preserve consecutive spaces verbatim')
  assert.equal(await connection.evaluate(`Array.from(document.querySelectorAll('.workspace-picker-shortcut')).some(button => button.dataset.path === ${JSON.stringify(longPickerPath)})`), false, 'the long current path should not be repeated in the shortcut row')
  const dimensions = await connection.evaluate(`(() => {
    const dialog = document.querySelector('.workspace-picker-modal')?.getBoundingClientRect();
    const body = document.querySelector('.workspace-picker-modal .ant-modal-body');
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      dialogRight: dialog?.right,
      dialogBottom: dialog?.bottom,
      footerBottom: document.querySelector('.workspace-picker-modal .ant-modal-footer')?.getBoundingClientRect().bottom,
      bodyClientWidth: body?.clientWidth,
      bodyScrollWidth: body?.scrollWidth,
    };
  })()`)
  assert.equal(dimensions.viewportWidth, 390, 'the narrow viewport should use a 390px layout')
  assert.ok(dimensions.documentWidth <= dimensions.viewportWidth, `page should not overflow horizontally: ${JSON.stringify(dimensions)}`)
  assert.ok(dimensions.dialogRight <= dimensions.viewportWidth + 1, `picker should fit the viewport: ${JSON.stringify(dimensions)}`)
  assert.ok(dimensions.dialogBottom <= dimensions.viewportHeight + 1, `picker should fit the viewport height: ${JSON.stringify(dimensions)}`)
  assert.ok(dimensions.footerBottom <= dimensions.viewportHeight + 1, `confirmation footer should remain reachable: ${JSON.stringify(dimensions)}`)
  assert.ok(dimensions.bodyScrollWidth <= dimensions.bodyClientWidth + 1, `modal body should not overflow horizontally: ${JSON.stringify(dimensions)}`)
  const mobileShot = await saveBrowserScreenshot(`${evidenceDir}/mobile-dark-longpath.png`)
  assert.ok((await readFile(mobileShot)).length > 1000, 'mobile dark screenshot should be captured')

  await clickButton('确认选择')
  await waitUntil('long path selection request to reach backend', () => state.setRequests === 1)
  assert.equal(state.setPaths.at(-1), longPickerPath, 'confirmation must stay bound to the exact loaded long path')
  await clickButton('取消')
  await waitUntil('picker cleanup and theme control restoration', () => connection.evaluate(`
    !document.body.classList.contains('workspace-picker-open')
      && getComputedStyle(document.querySelector('.theme-toggle')).visibility === 'visible'
  `))

  for (const [scenario, targetPath, expectedRoot] of [
    ['windows-drive', driveNotes, driveRoot],
    ['unc', uncTeam, uncRoot],
  ]) {
    state.directoryScenario = scenario
    state.dirRequests = 0
    state.dirPaths = []
    await clickButton('选择工作目录')
    await waitUntil(`${scenario} root to load`, () => state.dirRequests > 0 && connection.evaluate(
      `document.querySelector('.workspace-picker-current-path')?.innerText === ${JSON.stringify(expectedRoot)}`,
    ))
    const clicked = await connection.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.workspace-picker-shortcut')).find(item => item.dataset.path === ${JSON.stringify(targetPath)});
      button?.click();
      return Boolean(button);
    })()`)
    assert.equal(clicked, true, `${scenario} shortcut should be available by its original backend path`)
    await waitUntil(`${scenario} path to load`, () => state.dirPaths.includes(targetPath) && connection.evaluate(
      `document.querySelector('.workspace-picker-current-path')?.innerText === ${JSON.stringify(targetPath)}`,
    ))
    assert.equal(state.dirPaths.at(-1), targetPath, `${scenario} path should reach /api/dirs unchanged`)
    const previousSetRequests = state.setRequests
    await clickButton('确认选择')
    await waitUntil(`${scenario} selection to reach the server`, () => state.setRequests === previousSetRequests + 1)
    assert.equal(state.setPaths.at(-1), targetPath, `${scenario} confirmation should preserve the exact backend path`)
    await clickButton('取消')
  }
  state.directoryLocationMode = false
  state.directoryScenario = 'posix'
})
