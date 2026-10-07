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
const directPathWithSpaces = '/srv/field notes  /drafts '

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
  serverWorkspace: selectedWorkspace,
  serverWorkspaceId: 'workspace-validation-test',
  serverWorkspaceVersion: 3,
  editorRequests: 0,
  editorRequestDetails: [],
  dirRequests: 0,
  dirPaths: [],
  dirFinishedPaths: [],
  directoryLocationMode: false,
  directoryScenario: 'posix',
  dirFailurePath: null,
  dirFailureStatus: 403,
  dirFailureMessage: '目录访问被拒绝，请选择其他目录。',
  dirDelayPath: null,
  dirDelayGate: null,
  dirDelayGates: new Map(),
  dirDelayStartedAt: null,
  setRequests: 0,
  setPaths: [],
  setDetails: [],
  checkDetails: [],
  setMode: 'reject',
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

function workspaceInfo(
  workspace = state.serverWorkspace,
  workspaceId = state.serverWorkspaceId,
  workspaceVersion = state.serverWorkspaceVersion,
) {
  return { workspace, workspaceId, workspaceVersion }
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
      if (state.checkMode === 'available') {
        const info = workspaceInfo()
        state.checkDetails.push(info)
        return sendJson(response, 200, info)
      }
      if (state.checkMode === 'mismatch') {
        const info = workspaceInfo(`${state.serverWorkspace}/unexpected`, 'mismatched-workspace', state.serverWorkspaceVersion + 1)
        state.checkDetails.push(info)
        return sendJson(response, 200, info)
      }
      state.checkDetails.push({ mode: state.checkMode, workspace: staleWorkspace })
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
      const delayGate = state.dirDelayGates?.get(requestedPath)
        || (requestedPath === state.dirDelayPath ? state.dirDelayGate : null)
      if (delayGate) {
        state.dirDelayStartedAt = Date.now()
        await delayGate
      }
      state.dirFinishedPaths.push(requestedPath)
      if (state.directoryLocationMode) {
        if (state.directoryScenario === 'direct-path') {
          if (requestedPath === state.dirFailurePath) {
            return sendJson(response, state.dirFailureStatus, { error: state.dirFailureMessage })
          }
          const currentPath = requestedPath || state.serverWorkspace
          return sendJson(response, 200, {
            path: currentPath,
            canSelect: Boolean(requestedPath) || currentPath === state.serverWorkspace,
            canGoUp: currentPath !== '/srv',
            parent: currentPath === '/srv' ? null : '/srv',
            separator: currentPath.includes('\\') ? '\\' : '/',
            roots: [{ path: '/srv', name: '/srv', canNavigate: true, canSelect: false }],
            locations: [{ path: state.serverWorkspace, name: '当前工作目录', canNavigate: true, canSelect: true }],
            breadcrumb: [{ name: currentPath, path: currentPath, canNavigate: true, canSelect: true }],
            entries: [
              { type: 'file', name: 'must-not-appear.md', path: `${currentPath}/must-not-appear.md`, canNavigate: false },
              { type: 'dir', name: 'Nested folder', path: `${currentPath}/Nested folder`, canNavigate: true, canSelect: false },
            ],
          })
        }
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
      state.requestOrder.push('set')
      if (state.setMode === 'success' || state.setMode === 'success-check-fails' || state.setMode === 'success-check-mismatches') {
        if (payload.path !== state.serverWorkspace) {
          state.serverWorkspace = payload.path
          state.serverWorkspaceId = `workspace-${state.setRequests}`
          state.serverWorkspaceVersion += 1
        }
        if (state.setMode === 'success-check-fails') state.checkMode = 'unavailable'
        if (state.setMode === 'success-check-mismatches') state.checkMode = 'mismatch'
        const info = workspaceInfo()
        state.setDetails.push({ payload, info })
        return sendJson(response, 200, info)
      }
      if (state.setMode === 'success-wrong-target') {
        state.serverWorkspace = `${payload.path}/server-canonicalized-elsewhere`
        state.serverWorkspaceId = `workspace-${state.setRequests}`
        state.serverWorkspaceVersion += 1
        state.checkMode = 'available'
        const info = workspaceInfo()
        state.setDetails.push({ payload, info })
        return sendJson(response, 200, info)
      }
      if (state.setMode === 'uncertain') {
        state.serverWorkspace = payload.path
        state.serverWorkspaceId = `workspace-${state.setRequests}`
        state.serverWorkspaceVersion += 1
        state.setDetails.push({ payload, info: workspaceInfo(), responseStatus: 503 })
        return sendJson(response, 503, { code: 'WORKSPACE_SET_RESULT_UNCERTAIN', error: '工作目录设置结果需要重新确认。' })
      }
      if (state.setMode === 'uncertain-no-change') {
        state.setDetails.push({ payload, info: workspaceInfo(), responseStatus: 503 })
        return sendJson(response, 503, { code: 'WORKSPACE_SET_RESULT_UNCERTAIN', error: '工作目录设置结果需要重新确认。' })
      }
      state.setDetails.push({ payload, responseStatus: 409 })
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

async function navigateWithLocalStorage({ editor = false } = {}) {
  const cached = JSON.stringify({ workspace: staleWorkspace, workspaceId: 'stale-workspace', workspaceVersion: 1 })
  await connection.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('editor_workspace_info', ${JSON.stringify(cached)}); localStorage.setItem('editor_workspace', ${JSON.stringify(staleWorkspace)}); localStorage.setItem('editor_theme', 'light');`,
  })
  await connection.send('Page.navigate', { url: `http://127.0.0.1:${frontendPort}/` })
  if (editor) {
    await waitUntil('verified fake workspace editor to appear', () => connection.evaluate(
      `Boolean(document.querySelector('.workspace-sidebar') && document.querySelector('.tree-scroll'))`,
    ))
  } else {
    await waitUntil('workspace selection screen to appear', () => connection.evaluate(
      `Array.from(document.querySelectorAll('button')).some(button => button.innerText.trim() === '选择工作目录')`,
    ))
  }
}

async function startFakeEditorScenario(setMode) {
  if (chromeTargetId) await closeBrowserTarget()
  await waitForEditorRequestsToSettle()
  Object.assign(state, {
    phase: `editor-picker-${setMode}`,
    checkMode: 'available',
    checkCount: 0,
    serverWorkspace: selectedWorkspace,
    serverWorkspaceId: 'workspace-validation-test',
    serverWorkspaceVersion: 3,
    editorRequests: 0,
    editorRequestDetails: [],
    dirRequests: 0,
    dirPaths: [],
    dirFinishedPaths: [],
    directoryLocationMode: true,
    directoryScenario: 'direct-path',
    dirFailurePath: null,
    dirFailureStatus: 403,
    dirFailureMessage: '目录访问被拒绝，请选择其他目录。',
    dirDelayPath: null,
    dirDelayGate: null,
    dirDelayStartedAt: null,
    setRequests: 0,
    setPaths: [],
    setDetails: [],
    checkDetails: [],
    setMode,
    requestOrder: [],
  })
  await openBrowserTarget()
  await navigateWithLocalStorage({ editor: true })
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

async function getPickerState() {
  return connection.evaluate(`(() => {
    const modal = document.querySelector('.workspace-picker-modal');
    if (!modal) return null;
    const input = modal.querySelector('input[aria-label="目录路径"]');
    const list = modal.querySelector('.workspace-picker-list');
    const confirm = modal.querySelector('button[aria-label="使用当前目录"]');
    const cancel = modal.querySelector('button[aria-label="取消选择工作目录"]');
    const statusText = modal.querySelector('.workspace-picker-status-text');
    return {
      path: modal.dataset.currentPath ?? null,
      inputValue: input?.value ?? null,
      inputWidth: input?.getBoundingClientRect().width ?? 0,
      inputScrollWidth: input?.scrollWidth ?? 0,
      busy: list?.getAttribute('aria-busy') === 'true',
      rows: Array.from(modal.querySelectorAll('.welcome-directory-entry')).map(row => ({ path: row.dataset.path, text: row.innerText.trim() })),
      shortcuts: Array.from(modal.querySelectorAll('.workspace-picker-shortcut')).map(button => button.dataset.path),
      confirmDisabled: confirm?.disabled ?? true,
      cancelDisabled: cancel?.disabled ?? true,
      statusText: statusText?.innerText ?? '',
      listText: list?.innerText ?? '',
    }
  })()`)
}

async function readPickerGeometry() {
  return connection.evaluate(`(() => {
    const rect = element => {
      const value = element?.getBoundingClientRect();
      return value && { x: value.x, y: value.y, width: value.width, height: value.height, top: value.top, right: value.right, bottom: value.bottom };
    };
    const modal = document.querySelector('.workspace-picker-modal');
    const body = modal?.querySelector('.ant-modal-body');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      modal: rect(modal?.querySelector('.ant-modal-content')),
      header: rect(modal?.querySelector('.ant-modal-header')),
      content: rect(body),
      addressRow: rect(modal?.querySelector('.workspace-picker-address-row')),
      input: rect(modal?.querySelector('input[aria-label="目录路径"]')),
      inputType: modal?.querySelector('input[aria-label="目录路径"]')?.type ?? null,
      inputFontSize: modal?.querySelector('input[aria-label="目录路径"]') ? getComputedStyle(modal.querySelector('input[aria-label="目录路径"]')).fontSize : null,
      footer: rect(modal?.querySelector('.ant-modal-footer')),
      list: rect(modal?.querySelector('.workspace-picker-list')),
      listScrollTop: modal?.querySelector('.workspace-picker-list')?.scrollTop ?? null,
      rowPaths: Array.from(modal?.querySelectorAll('.welcome-directory-entry') || []).map(row => row.dataset.path),
      busy: modal?.querySelector('.workspace-picker-list')?.getAttribute('aria-busy') === 'true',
      confirmDisabled: modal?.querySelector('button[aria-label="使用当前目录"]')?.disabled ?? true,
    };
  })()`)
}

async function readPickerErrorGeometry() {
  return connection.evaluate(`(() => {
    const rect = element => {
      const value = element?.getBoundingClientRect();
      return value && { x: value.x, y: value.y, width: value.width, height: value.height, top: value.top, right: value.right, bottom: value.bottom };
    };
    const root = document.querySelector('.workspace-picker-modal');
    const status = root?.querySelector('.workspace-picker-status');
    const text = status?.querySelector('.workspace-picker-status-text');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      panel: rect(root?.querySelector('.ant-modal-content')),
      footer: rect(root?.querySelector('.ant-modal-footer')),
      status: rect(status),
      statusRole: status?.getAttribute('role') ?? null,
      statusLive: status?.getAttribute('aria-live') ?? null,
      statusText: rect(text),
      statusTextContent: text?.innerText ?? '',
      statusTextDetails: text?.getAttribute('aria-label') ?? '',
      statusTextClientHeight: text?.clientHeight ?? 0,
      statusTextScrollHeight: text?.scrollHeight ?? 0,
      retry: rect(status?.querySelector('button')),
      list: rect(root?.querySelector('.workspace-picker-list')),
      firstFolderRow: rect(root?.querySelector('.workspace-picker-list .welcome-directory-entry')),
      confirmDisabled: root?.querySelector('button[aria-label="使用当前目录"]')?.disabled ?? true,
    };
  })()`)
}

async function isPickerOverlayClosed() {
  return connection.evaluate(`(() => {
    const root = document.querySelector('.workspace-picker-modal');
    const wrapper = root?.querySelector('.ant-modal-wrap');
    const panel = root?.querySelector('.ant-modal-content');
    const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const panelRect = panel?.getBoundingClientRect();
    const panelHidden = !panel || !wrapper
      || wrapperStyle.display === 'none' || wrapperStyle.visibility === 'hidden' || Number(wrapperStyle.opacity || 1) === 0
      || panelStyle.display === 'none' || panelStyle.visibility === 'hidden' || Number(panelStyle.opacity || 1) === 0
      || !panelRect?.width || !panelRect?.height;
    return !document.body.classList.contains('workspace-picker-open') && panelHidden;
  })()`)
}

async function typePickerPath(value) {
  const requestCountBeforeTyping = state.dirRequests
  await connection.evaluate(`(() => {
    const input = document.querySelector('.workspace-picker-modal input[aria-label="目录路径"]');
    if (!input) return false;
    input.focus();
    input.setSelectionRange(0, input.value.length);
    return true;
  })()`)
  await connection.send('Input.insertText', { text: value })
  const inputValue = await connection.evaluate(`document.querySelector('.workspace-picker-modal input[aria-label="目录路径"]')?.value ?? null`)
  assert.equal(inputValue, value, 'typing a server path must preserve every space and separator')
  assert.equal(state.dirRequests, requestCountBeforeTyping, 'typing a path must not request directories before Enter')
}

async function pressPickerPathEnter() {
  await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' })
  await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
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

async function clickAriaButton(label) {
  const clicked = await connection.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`)
  assert.equal(clicked, true, `Expected an enabled button with aria-label ${label}`)
}

async function waitForRejectedWorkspaceSelection(targetPath, previousSetRequests, orderStart) {
  await waitUntil(`rejected workspace selection for ${targetPath} to finish and unlock the picker`, async () => {
    const picker = await getPickerState()
    const response = state.setDetails.at(-1)
    return state.setRequests === previousSetRequests + 1
      && response?.payload.path === targetPath
      && response?.responseStatus === 409
      && state.requestOrder.slice(orderStart).join(',') === 'set'
      && picker
      && !picker.cancelDisabled
      && Boolean(picker.statusText)
  })
  assert.deepEqual(state.requestOrder.slice(orderStart), ['set'], 'a known rejected SET must not issue a follow-up CHECK')
}

async function cancelPickerAndWaitForCleanup() {
  await clickAriaButton('取消选择工作目录')
  await waitUntil('picker cleanup and theme control restoration', () => connection.evaluate(`
    !document.body.classList.contains('workspace-picker-open')
      && getComputedStyle(document.querySelector('.theme-toggle')).visibility === 'visible'
  `))
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-workspace-check-'))
  evidenceDir = process.env.WORKSPACE_PICKER_EVIDENCE_DIR || path.join(tempRoot, 'picker-evidence')
  await mkdir(evidenceDir, { recursive: true })
  frontendPort = await freePort()
  backendPort = await freePort()
  Object.assign(state, {
    phase: 'setup',
    checkMode: 'unavailable',
    checkCount: 0,
    serverWorkspace: selectedWorkspace,
    serverWorkspaceId: 'workspace-validation-test',
    serverWorkspaceVersion: 3,
    editorRequests: 0,
    editorRequestDetails: [],
    dirRequests: 0,
    dirPaths: [],
    dirFinishedPaths: [],
    directoryLocationMode: false,
    directoryScenario: 'posix',
    dirFailurePath: null,
    dirDelayPath: null,
    dirDelayGate: null,
    dirDelayStartedAt: null,
    setRequests: 0,
    setPaths: [],
    setDetails: [],
    checkDetails: [],
    setMode: 'reject',
    requestOrder: [],
  })

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
  state.setMode = 'reject'
  state.serverWorkspace = selectedWorkspace
  state.serverWorkspaceId = 'workspace-validation-test'
  state.serverWorkspaceVersion = 3
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
  await waitUntil('directory roots request despite missing active workspace', () => state.dirRequests > 0 && connection.evaluate(`Boolean(document.querySelector('.workspace-picker-modal'))`))
  await waitUntil('directory entry in picker', async () => (await getPickerState())?.rows.some(row => row.path === selectedWorkspace))
  assert.equal((await getPickerState()).path, '/tmp', 'a roots-only response should expose its server current path as canonical')
  assert.equal((await getPickerState()).inputValue, '/tmp', 'the current server path should be editable in the address field')
  assert.deepEqual(await connection.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('.workspace-picker-shortcut'));
    const current = buttons.find(button => button.dataset.path === '/tmp');
    return {
      paths: buttons.map(button => button.dataset.path),
      currentDisabled: current?.disabled ?? false,
      currentMarker: current?.getAttribute('aria-current') ?? null,
    };
  })()`), {
    paths: ['/tmp'],
    currentDisabled: true,
    currentMarker: 'location',
  }, 'the backend shortcut order should stay stable and mark the canonical current path as unavailable for re-navigation')
  const selectedFolderClicked = await connection.evaluate(`(() => {
    const entry = document.querySelector('.welcome-directory-entry[data-path="${selectedWorkspace}"]');
    entry?.click();
    return Boolean(entry);
  })()`)
  assert.equal(selectedFolderClicked, true, 'the fake backend folder should be navigable from the listing')
  await waitUntil('selected folder loaded', async () => (await getPickerState())?.path === selectedWorkspace && !(await getPickerState())?.busy)
  assert.equal((await getPickerState()).inputValue, selectedWorkspace, 'the address field should follow the exact server canonical path')
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-picker-shortcut[data-path="/tmp"]'))`), true, 'the parent root should remain available as a shortcut inside its child directory')
  const parentShortcutClicked = await connection.evaluate(`(() => {
    const button = document.querySelector('.workspace-picker-shortcut[data-path="/tmp"]');
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(parentShortcutClicked, true, 'the parent root shortcut should navigate using the backend path')
  await waitUntil('parent root shortcut to restore /tmp', async () => state.dirPaths.at(-1) === '/tmp' && (await getPickerState())?.path === '/tmp')
  const selectedFolderClickedAgain = await connection.evaluate(`(() => {
    const entry = document.querySelector('.welcome-directory-entry[data-path="${selectedWorkspace}"]');
    entry?.click();
    return Boolean(entry);
  })()`)
  assert.equal(selectedFolderClickedAgain, true)
  await waitUntil('selected folder to reopen after parent navigation', async () => state.dirPaths.at(-1) === selectedWorkspace && (await getPickerState())?.path === selectedWorkspace)
  await clickButton('使用此目录')
  await waitUntil('backend rejected invalid recovery location', () => state.setRequests === 1 && connection.evaluate(
    `Array.from(document.querySelectorAll('.workspace-picker-status-text[aria-label]')).some(item => item.getAttribute('aria-label').includes('恢复数据目录位于所选工作目录内部'))`,
  ))
  assert.equal(currentPageEditorRequests().length, 0, `a rejected workspace selection must never request the editor tree; requests: ${JSON.stringify(state.editorRequestDetails)}`)
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-sidebar'))`), false, 'a rejected workspace selection must keep Editor unmounted')
  await connection.evaluate(`document.querySelector('button[aria-label="取消选择工作目录"]')?.click()`)

  state.checkMode = 'available'
  await clickButton('重试')
  await waitUntil('valid backend check to enter the editor', () => currentPageEditorRequests().length > 0)
})

test('Editor directory picker opens in one step and commits only after matching workspace check', async () => {
  state.phase = 'closing-previous-page-for-editor-picker'
  await closeBrowserTarget()
  await waitForEditorRequestsToSettle()
  Object.assign(state, {
    checkMode: 'available',
    checkCount: 0,
    serverWorkspace: selectedWorkspace,
    serverWorkspaceId: 'workspace-validation-test',
    serverWorkspaceVersion: 3,
    editorRequests: 0,
    editorRequestDetails: [],
    dirRequests: 0,
    dirPaths: [],
    dirFinishedPaths: [],
    directoryLocationMode: true,
    directoryScenario: 'direct-path',
    dirFailurePath: null,
    dirDelayPath: null,
    dirDelayGate: null,
    dirDelayStartedAt: null,
    setRequests: 0,
    setPaths: [],
    setDetails: [],
    checkDetails: [],
    setMode: 'success',
    requestOrder: [],
    phase: 'editor-picker-transaction',
  })
  await openBrowserTarget()
  await navigateWithLocalStorage({ editor: true })
  assert.ok(currentPageEditorRequests().length > 0, 'the valid server workspace should mount the Editor only after /check')

  const initialEditorRequests = currentPageEditorRequests().length
  await connection.evaluate(`(() => {
    window.__pickerSidebarBefore = document.querySelector('.workspace-sidebar');
    window.__pickerTreeBefore = document.querySelector('.tree-scroll');
    window.__pickerWorkspaceInfoBefore = localStorage.getItem('editor_workspace_info');
  })()`)
  await clickAriaButton('更改目录')
  await waitUntil('Editor picker to open directly from the change-directory action', async () => Boolean(await getPickerState()) && state.dirPaths.length > 0)
  assert.equal(state.dirPaths.at(-1), selectedWorkspace, 'reopening the picker should re-read the authoritative current workspace path')
  assert.equal((await getPickerState()).path, selectedWorkspace)
  const setsBeforeCancel = state.setRequests
  await clickAriaButton('取消选择工作目录')
  await waitUntil('picker cancel to hide the overlay', isPickerOverlayClosed)
  const cancelState = await connection.evaluate(`({
    sameSidebar: window.__pickerSidebarBefore === document.querySelector('.workspace-sidebar'),
    sameTree: window.__pickerTreeBefore === document.querySelector('.tree-scroll'),
    sameWorkspaceInfo: window.__pickerWorkspaceInfoBefore === localStorage.getItem('editor_workspace_info'),
  })`)
  assert.deepEqual(cancelState, { sameSidebar: true, sameTree: true, sameWorkspaceInfo: true }, 'cancel should keep the same Editor context mounted')
  assert.equal(state.setRequests, setsBeforeCancel, 'cancel must never issue POST /api/workspace/set')
  assert.equal(currentPageEditorRequests().length, initialEditorRequests, 'cancel must not remount or reload the Editor tree')

  await clickAriaButton('更改目录')
  await waitUntil('current workspace picker to reopen', async () => (await getPickerState())?.path === selectedWorkspace && state.dirPaths.length >= 2)
  const samePathOrderStart = state.requestOrder.length
  await clickAriaButton('使用当前目录')
  await waitUntil('same canonical path to be checked after POST set', () => {
    const setIndex = state.requestOrder.lastIndexOf('set')
    const checkIndex = state.requestOrder.lastIndexOf('check')
    return state.setRequests === 1 && setIndex >= samePathOrderStart && checkIndex > setIndex
  })
  assert.deepEqual(state.requestOrder.slice(samePathOrderStart), ['set', 'check'], 'selection must use POST set, then GET check in that order')
  assert.equal(state.setPaths.at(-1), selectedWorkspace)
  assert.deepEqual(state.setDetails.at(-1).info, state.checkDetails.at(-1), 'path, workspace id, and version from POST and GET must match')
  assert.equal(state.setDetails.at(-1).info.workspaceVersion, 3, 'the backend should keep the version stable for the same canonical workspace')
  assert.equal(await connection.evaluate(`window.__pickerSidebarBefore === document.querySelector('.workspace-sidebar')`), true, 'same-path confirmation must preserve the mounted Editor')
  assert.equal(currentPageEditorRequests().length, initialEditorRequests, 'same-path confirmation must not remount the Editor tree')

  state.setMode = 'success-check-fails'
  await clickAriaButton('更改目录')
  await waitUntil('current workspace picker to reopen before a path change', async () => (await getPickerState())?.path === selectedWorkspace)
  const typedPath = '/srv/verified-new-workspace'
  const requestCountBeforeEnter = state.dirRequests
  await typePickerPath(typedPath)
  assert.equal(state.dirRequests, requestCountBeforeEnter, 'editing the new path must wait for Enter before GET')
  await pressPickerPathEnter()
  await waitUntil('new server path to be verified before selection', async () => state.dirPaths.at(-1) === typedPath && (await getPickerState())?.path === typedPath)
  const checkFailOrderStart = state.requestOrder.length
  const editorRequestsBeforeFailure = currentPageEditorRequests().length
  await clickAriaButton('使用当前目录')
  await waitUntil('failed post-selection workspace check to enter diagnostics', () => state.setRequests === 2 && connection.evaluate(
    `Boolean(document.querySelector('.workspace-diagnostic[role="alert"]')) && !document.querySelector('.workspace-sidebar')`,
  ))
  assert.deepEqual(state.requestOrder.slice(checkFailOrderStart), ['set', 'check'], 'a successful POST must be followed by the verification GET')
  assert.equal(state.setPaths.at(-1), typedPath)
  assert.equal(currentPageEditorRequests().length, editorRequestsBeforeFailure, 'the previous Editor must remain unmounted after verification fails')
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-diagnostic[role="alert"]'))`), true, 'the failed verification should leave a visible diagnostic state')
})

test('matching SET and CHECK for a different server path cannot commit another picker target', async () => {
  await startFakeEditorScenario('success-wrong-target')
  const editorRequestsBefore = currentPageEditorRequests().length
  await clickAriaButton('更改目录')
  await waitUntil('picker for a wrong-target transaction to load', async () => (await getPickerState())?.path === selectedWorkspace)
  const targetPath = '/srv/user-picked-directory'
  await typePickerPath(targetPath)
  await pressPickerPathEnter()
  await waitUntil('user-picked path to be checked', async () => (await getPickerState())?.path === targetPath && !(await getPickerState())?.busy)
  const orderStart = state.requestOrder.length
  await clickAriaButton('使用当前目录')
  await waitUntil('matching but wrong path result to enter diagnostics', () => state.setRequests === 1 && state.checkCount >= 2 && connection.evaluate(
    `Boolean(document.querySelector('.workspace-diagnostic[role="alert"]')) && !document.querySelector('.workspace-sidebar')`,
  ))
  assert.deepEqual(state.requestOrder.slice(orderStart), ['set', 'check'], 'the user selection must be checked after POST set')
  assert.equal(state.setDetails.at(-1).payload.path, targetPath)
  assert.notEqual(state.setDetails.at(-1).info.workspace, targetPath, 'the fake server should canonicalize to a different directory')
  assert.deepEqual(state.setDetails.at(-1).info, state.checkDetails.at(-1), 'POST and CHECK can agree with one another and still disagree with the user selection')
  assert.equal(currentPageEditorRequests().length, editorRequestsBefore, 'a mismatched server target must not mount or reload the previous Editor')
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-diagnostic[role="alert"]'))`), true)
})

test('an uncertain SET response keeps the Editor only when CHECK proves the old identity is still active', async () => {
  await startFakeEditorScenario('uncertain-no-change')
  const editorRequestsBeforeNoChange = currentPageEditorRequests().length
  const oldInfo = state.checkDetails.at(-1)
  await connection.evaluate(`(() => { window.__uncertainSidebar = document.querySelector('.workspace-sidebar'); return true; })()`)
  await clickAriaButton('更改目录')
  await waitUntil('picker before unchanged uncertain SET to open', async () => (await getPickerState())?.path === selectedWorkspace)
  await typePickerPath('/srv/selection-that-was-not-applied')
  await pressPickerPathEnter()
  await waitUntil('unapplied target to be verified', async () => (await getPickerState())?.path === '/srv/selection-that-was-not-applied')
  const unchangedOrderStart = state.requestOrder.length
  const unchangedCheckCountBefore = state.checkCount
  const unchangedCheckDetailsBefore = state.checkDetails.length
  await clickAriaButton('使用当前目录')
  await waitUntil('ambiguous SET to be resolved by CHECK of the old identity', async () => {
    const picker = await getPickerState()
    const followupOrder = state.requestOrder.slice(unchangedOrderStart)
    return state.setRequests === 1
      && state.checkCount > unchangedCheckCountBefore
      && state.checkDetails.length > unchangedCheckDetailsBefore
      && followupOrder.length === 2
      && followupOrder[0] === 'set'
      && followupOrder[1] === 'check'
      && picker
      && !picker.cancelDisabled
      && picker.statusText.includes('切换结果未确认')
  })
  assert.deepEqual(state.requestOrder.slice(unchangedOrderStart), ['set', 'check'])
  assert.deepEqual(state.checkDetails.at(-1), oldInfo, 'the follow-up check should prove the original path, id, and version remain active')
  assert.equal(currentPageEditorRequests().length, editorRequestsBeforeNoChange, 'an unchanged workspace identity should keep the old Editor mounted')
  assert.equal(await connection.evaluate(`window.__uncertainSidebar === document.querySelector('.workspace-sidebar')`), true)
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.workspace-diagnostic[role="alert"]'))`), false, 'the checked old workspace should remain a usable context')

  await startFakeEditorScenario('uncertain')
  const editorRequestsBeforeChanged = currentPageEditorRequests().length
  await clickAriaButton('更改目录')
  await waitUntil('picker before changed uncertain SET to open', async () => (await getPickerState())?.path === selectedWorkspace)
  await typePickerPath('/srv/selection-applied-before-response-loss')
  await pressPickerPathEnter()
  await waitUntil('changed uncertain target to be verified', async () => (await getPickerState())?.path === '/srv/selection-applied-before-response-loss')
  const changedOrderStart = state.requestOrder.length
  const changedCheckCountBefore = state.checkCount
  const changedCheckDetailsBefore = state.checkDetails.length
  await clickAriaButton('使用当前目录')
  await waitUntil('changed uncertain SET to enter safe diagnostics', () => state.setRequests === 1 && state.checkCount > changedCheckCountBefore && state.checkDetails.length > changedCheckDetailsBefore && connection.evaluate(
    `Boolean(document.querySelector('.workspace-diagnostic[role="alert"]')) && !document.querySelector('.workspace-sidebar')`,
  ))
  assert.deepEqual(state.requestOrder.slice(changedOrderStart), ['set', 'check'])
  assert.equal(state.serverWorkspace, '/srv/selection-applied-before-response-loss')
  assert.notDeepEqual(state.checkDetails.at(-1), state.checkDetails[0], 'the verified server identity changed after the uncertain response')
  assert.equal(currentPageEditorRequests().length, editorRequestsBeforeChanged, 'the prior Editor must not survive an unknown changed workspace')
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
  state.setMode = 'reject'
  state.serverWorkspace = selectedWorkspace
  state.serverWorkspaceId = 'workspace-validation-test'
  state.serverWorkspaceVersion = 3
  state.requestOrder = []
  state.phase = 'directory-locations'
  await openBrowserTarget()
  await navigateWithLocalStorage()
  await setBrowserViewport(1280, 900)

  state.dirDelayPath = ''
  let releaseInitialDirectory
  state.dirDelayGate = new Promise(resolve => { releaseInitialDirectory = resolve })
  const initialLoadingGeometry = {}
  try {
    await clickButton('选择工作目录')
    await waitUntil('initial directory request to stay pending', () => state.dirPaths.includes('') && connection.evaluate(`(() => {
      const list = document.querySelector('.workspace-picker-list');
      const confirm = document.querySelector('button[aria-label="使用当前目录"]');
      return list?.getAttribute('aria-busy') === 'true' && confirm?.disabled === true;
    })()`))
    await new Promise(resolve => setTimeout(resolve, 550))
    initialLoadingGeometry.loading = await readPickerGeometry()
  } finally {
    releaseInitialDirectory()
    state.dirDelayPath = null
    state.dirDelayGate = null
  }
  await waitUntil('initial directory request to finish', async () => (await getPickerState())?.path === '/' && !(await getPickerState())?.busy)
  initialLoadingGeometry.ready = await readPickerGeometry()
  assert.deepEqual(state.dirPaths, [''], 'the picker should start from the fake filesystem root')
  for (const selector of ['header', 'content', 'addressRow', 'input', 'footer', 'list']) {
    const loading = initialLoadingGeometry.loading[selector]
    const ready = initialLoadingGeometry.ready[selector]
    for (const dimension of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(loading[dimension] - ready[dimension]) <= 1, `initial loading should reserve stable ${selector} ${dimension}: ${JSON.stringify({ loading, ready })}`)
    }
  }

  await waitUntil('directory roots and locations to load', async () => state.dirRequests > 0 && (await getPickerState())?.shortcuts.includes('/home/alice'))
  assert.equal(await connection.evaluate(`Array.from(document.querySelectorAll('.workspace-picker-shortcut')).some(button => button.dataset.path === '/home/alice' && button.innerText.includes('/home/alice'))`), true, 'the home shortcut must show its backend path even though roots only contains /')
  assert.equal((await getPickerState()).path, '/', 'the canonical absolute path should be shown in the picker contract')
  assert.equal((await getPickerState()).inputValue, '/', 'the full current path should be in the single-line address input')
  assert.deepEqual((await getPickerState()).shortcuts, ['/', '/home/alice', '/mnt', '/media', '/tmp'], 'the complete backend location order should remain stable at the filesystem root')
  assert.deepEqual(await connection.evaluate(`(() => {
    const button = document.querySelector('.workspace-picker-shortcut[data-path="/"]');
    return { disabled: button?.disabled ?? false, current: button?.getAttribute('aria-current') ?? null };
  })()`), { disabled: true, current: 'location' }, 'the canonical current root should stay visible and disabled')

  const clicked = await connection.evaluate(`(() => {
    const button = document.querySelector('.workspace-picker-shortcut[data-path="/home/alice"]');
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(clicked, true)
  await waitUntil('home shortcut navigation request and listing', async () => state.dirPaths.includes('/home/alice') && (await getPickerState())?.path === '/home/alice' && (await getPickerState())?.rows.some(row => row.path === '/home/alice/Projects'))
  assert.equal(state.dirPaths.at(-1), '/home/alice')
  assert.equal((await getPickerState()).inputValue, '/home/alice')
  assert.equal((await getPickerState()).rows.some(row => row.path.endsWith('.md')), false, 'the picker list should expose folders only')
  assert.deepEqual(await connection.evaluate(`(() => {
    const button = document.querySelector('.workspace-picker-shortcut[data-path="/home/alice"]');
    return { disabled: button?.disabled ?? false, current: button?.getAttribute('aria-current') ?? null };
  })()`), { disabled: true, current: 'location' }, 'the canonical current location should stay in the same quick-access position and be marked current')
  const desktopShot = await saveBrowserScreenshot(`${evidenceDir}/desktop-light.png`)
  assert.ok((await readFile(desktopShot)).length > 1000, 'desktop light screenshot should be captured')

  await setBrowserViewport(390, 844, true)
  await waitUntil('coarse pointer emulation to apply', () => connection.evaluate(`matchMedia('(pointer: coarse)').matches`))
  const measureTouchTargets = () => connection.evaluate(`(() => {
    const rect = element => {
      const value = element?.getBoundingClientRect();
      return value && { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const shortcut = document.querySelector('.workspace-picker-shortcut[data-path="/"]');
    const shortcutStyle = shortcut ? getComputedStyle(shortcut) : null;
    return {
      up: rect(document.querySelector('.workspace-picker-up')),
      shortcutRoot: rect(shortcut),
      coarsePointer: matchMedia('(pointer: coarse)').matches,
      shortcutMinHeight: shortcutStyle?.minHeight ?? null,
      shortcutHeight: shortcutStyle?.height ?? null,
      shortcutTransition: shortcutStyle?.transition ?? null,
      shortcutTransitionDuration: shortcutStyle?.transitionDuration ?? null,
    };
  })()`)
  const touchTargetGeometry = { immediatelyAfterMediaSwitch: await measureTouchTargets() }
  await new Promise(resolve => setTimeout(resolve, 350))
  touchTargetGeometry.afterTransition = await measureTouchTargets()
  await writeFile(path.join(evidenceDir, 'linux-coarse-shortcut-geometry.json'), JSON.stringify(touchTargetGeometry, null, 2))
  assert.ok(touchTargetGeometry.afterTransition.up.width >= 44 && touchTargetGeometry.afterTransition.up.height >= 44, `up navigation target should be at least 44x44 after responsive styling settles: ${JSON.stringify(touchTargetGeometry)}`)
  assert.ok(touchTargetGeometry.afterTransition.shortcutRoot.width >= 44 && touchTargetGeometry.afterTransition.shortcutRoot.height >= 44, `root shortcut target should be at least 44x44 after responsive styling settles: ${JSON.stringify(touchTargetGeometry)}`)
  const rootShortcutClicked = await connection.evaluate(`(() => {
    const button = document.querySelector('.workspace-picker-shortcut[data-path="/"]');
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(rootShortcutClicked, true)
  await waitUntil('root shortcut to navigate using its backend path', async () => state.dirPaths.at(-1) === '/' && (await getPickerState())?.path === '/' && (await getPickerState())?.shortcuts.includes('/'))
  const homeShortcutClickedAgain = await connection.evaluate(`(() => {
    const button = document.querySelector('.workspace-picker-shortcut[data-path="/home/alice"]');
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(homeShortcutClickedAgain, true)
  await waitUntil('home shortcut to restore the current path', async () => state.dirPaths.at(-1) === '/home/alice' && (await getPickerState())?.path === '/home/alice')
  await setBrowserViewport(1280, 900)
  await waitUntil('fine pointer emulation to restore', () => connection.evaluate(`!matchMedia('(pointer: coarse)').matches`))
  await new Promise(resolve => setTimeout(resolve, 350))

  state.dirDelayPath = '/media'
  state.dirDelayStartedAt = null
  let releaseDelayedDirectory
  state.dirDelayGate = new Promise(resolve => { releaseDelayedDirectory = resolve })
  const delayedGeometry = {}
  try {
    delayedGeometry.before = await readPickerGeometry()
    const mediaShortcutClicked = await connection.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.workspace-picker-shortcut')).find(item => item.dataset.path === '/media');
      button?.click();
      return Boolean(button);
    })()`)
    assert.equal(mediaShortcutClicked, true)
    await waitUntil('delayed location request to be in flight', () => state.dirPaths.includes('/media') && connection.evaluate(`(() => {
      const modal = document.querySelector('.workspace-picker-modal');
      const confirm = modal?.querySelector('button[aria-label="使用当前目录"]');
      return modal?.querySelector('.workspace-picker-list')?.getAttribute('aria-busy') === 'true'
        && modal?.dataset.currentPath === '/home/alice'
        && modal?.querySelector('.workspace-picker-list')?.innerText.includes('Projects')
        && confirm?.disabled === true;
    })()`))
    await new Promise(resolve => setTimeout(resolve, 550))
    delayedGeometry.during = await readPickerGeometry()
    delayedGeometry.startedAt = state.dirDelayStartedAt
    delayedGeometry.screenshot = await saveBrowserScreenshot(`${evidenceDir}/desktop-light-delayed.png`)
    const busyState = await getPickerState()
    assert.equal(busyState.busy, true, 'the list should expose that the slow path request is pending')
    assert.equal(busyState.path, '/home/alice', 'the modal should retain the last successful canonical path while loading')
    assert.equal(busyState.inputValue, '/media', 'the address field should preserve the requested destination while loading')
    assert.ok(busyState.rows.some(row => row.path === '/home/alice/Projects'), 'the previous folder list should stay visible during a slow request')
    assert.equal(busyState.confirmDisabled, true, 'confirm must be disabled while a destination request is pending')
    assert.deepEqual(delayedGeometry.during.rowPaths, delayedGeometry.before.rowPaths, 'the previous folder rows should remain mounted throughout the request')
    const clickWhileBusy = await connection.evaluate(`(() => {
      const button = document.querySelector('.workspace-picker-modal button[aria-label="使用当前目录"]');
      button?.click();
      return button?.disabled ?? false;
    })()`)
    assert.equal(clickWhileBusy, true)
    assert.equal(state.setRequests, 0, 'a pending directory load must not submit the previous path')
  } finally {
    releaseDelayedDirectory()
    state.dirDelayPath = null
    state.dirDelayGate = null
  }
  await waitUntil('delayed media location response to load', async () => (await getPickerState())?.path === '/media' && !(await getPickerState())?.busy)
  delayedGeometry.after = await readPickerGeometry()
  await writeFile(`${evidenceDir}/delayed-geometry.json`, JSON.stringify({ initial: initialLoadingGeometry, navigation: delayedGeometry }, null, 2))
  assert.ok(Date.now() - delayedGeometry.startedAt >= 500, 'the delayed fake API request should remain pending for at least 500ms')
  for (const selector of ['header', 'content', 'footer', 'list', 'input']) {
    const before = delayedGeometry.before[selector]
    const during = delayedGeometry.during[selector]
    const after = delayedGeometry.after[selector]
    for (const dimension of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(before[dimension] - during[dimension]) <= 1, `${selector} ${dimension} should stay fixed while GET is pending: ${JSON.stringify({ before, during, after })}`)
      assert.ok(Math.abs(before[dimension] - after[dimension]) <= 1, `${selector} ${dimension} should stay fixed after GET completes: ${JSON.stringify({ before, during, after })}`)
    }
  }
  const homeShortcutClicked = await connection.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.workspace-picker-shortcut')).find(item => item.dataset.path === '/home/alice');
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(homeShortcutClicked, true)
  await waitUntil('home directory to reload after pending-state check', async () => (await getPickerState())?.path === '/home/alice' && (await getPickerState())?.rows.some(row => row.path === '/home/alice/Projects'))
  await clickButton('使用此目录')
  await waitUntil('backend rejected fake POSIX selection', () => state.setRequests === 1)
  assert.equal(state.setPaths.at(-1), '/home/alice', 'selection must submit the exact path from the loaded backend response')
  await connection.evaluate(`document.querySelector('button[aria-label="取消选择工作目录"]')?.click()`)
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
  state.directoryScenario = 'direct-path'
  state.dirFailurePath = null
  state.setRequests = 0
  state.setPaths = []
  state.setMode = 'reject'
  state.serverWorkspace = selectedWorkspace
  state.serverWorkspaceId = 'workspace-validation-test'
  state.serverWorkspaceVersion = 3
  state.requestOrder = []
  state.phase = 'directory-path-shapes'
  await openBrowserTarget()
  await navigateWithLocalStorage()
  await setBrowserViewport(390, 844, true)

  await connection.evaluate(`document.querySelector('.theme-toggle')?.click()`)
  await waitUntil('dark theme to apply', () => connection.evaluate(`document.documentElement.dataset.theme === 'dark'`))
  await clickButton('选择工作目录')
  await waitUntil('initial address path to load', async () => state.dirRequests > 0 && (await getPickerState())?.path === selectedWorkspace)
  assert.deepEqual(state.dirPaths, [''], 'opening from Welcome should let the server choose the default listing location')
  const beforeEnterCount = state.dirRequests
  await typePickerPath(longPickerPath)
  assert.equal(state.dirRequests, beforeEnterCount, 'typing a path alone must not navigate before Enter')
  await pressPickerPathEnter()
  await waitUntil('long directory path and folder-only listing to display', async () => state.dirPaths.at(-1) === longPickerPath && (await getPickerState())?.path === longPickerPath && !(await getPickerState())?.busy)
  assert.equal((await getPickerState()).inputValue, longPickerPath, 'the input must preserve the long path verbatim')
  assert.equal((await getPickerState()).rows.length, 1, 'only folders should appear in the listing')
  assert.equal((await getPickerState()).rows[0].path, `${longPickerPath}/Nested folder`)
  assert.equal((await getPickerState()).listText.includes('must-not-appear.md'), false, 'files must not appear in the picker list')
  assert.equal((await getPickerState()).confirmDisabled, false, 'the server-confirmed directory should be selectable')
  assert.equal(state.setRequests, 0, 'opening a path with Enter must perform only GET /api/dirs')
  const dimensions = await connection.evaluate(`(() => {
    const dialog = document.querySelector('.workspace-picker-modal .ant-modal-content')?.getBoundingClientRect();
    const body = document.querySelector('.workspace-picker-modal .ant-modal-body');
    const input = document.querySelector('.workspace-picker-modal input[aria-label="目录路径"]');
    const addressRow = document.querySelector('.workspace-picker-address-row')?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      dialogRight: dialog?.right,
      dialogBottom: dialog?.bottom,
      footerBottom: document.querySelector('.workspace-picker-modal .ant-modal-footer')?.getBoundingClientRect().bottom,
      bodyClientWidth: body?.clientWidth,
      bodyScrollWidth: body?.scrollWidth,
      addressWidth: addressRow?.width,
      inputWidth: input?.getBoundingClientRect().width,
      inputHeight: input?.getBoundingClientRect().height,
      inputScrollWidth: input?.scrollWidth,
      inputWhiteSpace: input ? getComputedStyle(input).whiteSpace : null,
      value: input?.value,
    };
  })()`)
  assert.equal(dimensions.viewportWidth, 390, 'the narrow viewport should use a 390px layout')
  assert.ok(dimensions.documentWidth <= dimensions.viewportWidth, `page should not overflow horizontally: ${JSON.stringify(dimensions)}`)
  assert.ok(dimensions.dialogRight <= dimensions.viewportWidth + 1, `picker should fit the viewport: ${JSON.stringify(dimensions)}`)
  assert.ok(dimensions.dialogBottom <= dimensions.viewportHeight + 1, `picker should fit the viewport height: ${JSON.stringify(dimensions)}`)
  assert.ok(dimensions.footerBottom <= dimensions.viewportHeight + 1, `confirmation footer should remain reachable: ${JSON.stringify(dimensions)}`)
  assert.ok(dimensions.bodyScrollWidth <= dimensions.bodyClientWidth + 1, `modal body should not overflow horizontally: ${JSON.stringify(dimensions)}`)
  assert.ok(dimensions.inputWidth > 0 && dimensions.inputHeight > 0, `single-line path input should remain visible: ${JSON.stringify(dimensions)}`)
  assert.equal(dimensions.value, longPickerPath)
  const pathSelection = await connection.evaluate(`(() => {
    const input = document.querySelector('.workspace-picker-modal input[aria-label="目录路径"]');
    if (!input) return null;
    input.select();
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd, height: input.getBoundingClientRect().height };
  })()`)
  assert.equal(pathSelection.value, longPickerPath)
  assert.equal(pathSelection.start, 0, 'the full mobile path should be selectable from its first character')
  assert.equal(pathSelection.end, longPickerPath.length, 'the full mobile path should be selectable through its last character')
  const mobileShot = await saveBrowserScreenshot(`${evidenceDir}/mobile-dark-longpath.png`)
  assert.ok((await readFile(mobileShot)).length > 1000, 'mobile dark screenshot should be captured')
  for (const [width, height] of [[390, 480], [640, 360]]) {
    await setBrowserViewport(width, height, true)
    const compact = await readPickerGeometry()
    assert.equal(compact.viewport.width, width)
    assert.equal(compact.viewport.height, height)
    assert.ok(compact.documentWidth <= width, `compact viewport ${width}x${height} should not scroll horizontally: ${JSON.stringify(compact)}`)
    assert.ok(compact.modal.right <= width + 1 && compact.modal.bottom <= height + 1, `dialog should fit compact viewport ${width}x${height}: ${JSON.stringify(compact.modal)}`)
    assert.ok(compact.footer.bottom <= height + 1, `confirmation footer should remain visible at ${width}x${height}: ${JSON.stringify(compact.footer)}`)
    assert.ok(compact.input.width > 0 && compact.input.width <= width, `single-line path input should fit at ${width}x${height}: ${JSON.stringify(compact.input)}`)
    assert.ok(compact.list.height >= 44, `folder list should show at least one full touch row at ${width}x${height}: ${JSON.stringify(compact.list)}`)
    assert.equal((await getPickerState()).inputValue, longPickerPath, 'resizing should not change the original path text')
    assert.ok(compact.input.height >= pathSelection.height && compact.input.height <= 44, `single-line path input should remain within a 44px touch target at ${width}x${height}: ${JSON.stringify(compact)}`)
    assert.equal(compact.inputType, 'text', `server paths should stay in a single-line text input at ${width}x${height}`)
    assert.ok(Number.parseFloat(compact.inputFontSize) >= 16, `mobile path input should retain readable text at ${width}x${height}: ${compact.inputFontSize}`)
  }

  const inaccessiblePath = '/srv/mobile-error-retry-layout'
  state.dirFailurePath = inaccessiblePath
  await typePickerPath(inaccessiblePath)
  await pressPickerPathEnter()
  await waitUntil('failed directory path to show its short error and retry action', () => connection.evaluate(`(() => {
    const status = document.querySelector('.workspace-picker-status');
    return status?.getAttribute('role') === 'alert'
      && Boolean(status?.querySelector('.workspace-picker-status-text')?.innerText)
      && Boolean(status?.querySelector('button'))
      && document.querySelector('.workspace-picker-list')?.getAttribute('aria-busy') === 'false';
  })()`))
  assert.equal((await getPickerState()).path, longPickerPath, 'a failed path should retain the last verified listing')
  assert.equal((await getPickerState()).inputValue, inaccessiblePath, 'the rejected path should remain visible for correction')
  assert.equal((await getPickerState()).confirmDisabled, true, 'a failed GET must keep confirmation disabled')
  const directoryError = await readPickerErrorGeometry()
  const accessibleBackendReason = state.dirFailureMessage.replace(/[。！？!?]+$/u, '')
  await writeFile(`${evidenceDir}/directory-error-before-layout.json`, JSON.stringify({ expectedBackendReason: state.dirFailureMessage, ...directoryError }, null, 2))
  assert.ok(directoryError.statusTextContent.includes('无权限读取此目录'), `the error summary should retain the actionable permission reason: ${directoryError.statusTextContent}`)
  assert.ok(directoryError.statusTextContent.includes('请选择其他目录'), `the summary should tell the user how to continue: ${directoryError.statusTextContent}`)
  assert.ok(directoryError.statusTextDetails.includes(accessibleBackendReason), `the complete backend reason should remain available in the accessible label: ${JSON.stringify({ expected: accessibleBackendReason, ...directoryError })}`)
  assert.ok(directoryError.statusTextDetails.includes(longPickerPath), 'the accessible error details should retain the exact path of the still-visible verified listing')
  assert.equal(state.setRequests, 0, 'a failed directory read must not submit a workspace change')

  const errorGeometryByViewport = []
  for (const [width, height] of [[390, 480], [640, 360]]) {
    await setBrowserViewport(width, height, true)
    await waitUntil(`error layout to resize to ${width}x${height}`, () => connection.evaluate(`window.innerWidth === ${width} && window.innerHeight === ${height}`))
    const geometry = await readPickerErrorGeometry()
    const screenshot = await saveBrowserScreenshot(`${evidenceDir}/mobile-error-retry-${width}x${height}.png`)
    geometry.screenshot = screenshot
    errorGeometryByViewport.push(geometry)
    assert.equal(geometry.viewport.width, width)
    assert.equal(geometry.viewport.height, height)
    assert.ok(geometry.documentWidth <= width, `error layout should not scroll horizontally at ${width}x${height}: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.panel.right <= width + 1 && geometry.panel.bottom <= height + 1, `error panel should fit at ${width}x${height}: ${JSON.stringify(geometry.panel)}`)
    assert.ok(geometry.footer.bottom <= height + 1, `confirmation footer should remain reachable at ${width}x${height}: ${JSON.stringify(geometry.footer)}`)
    assert.equal(geometry.statusRole, 'alert')
    assert.equal(geometry.statusLive, 'assertive')
    assert.ok(geometry.status.height >= 44, `coarse-pointer error row should retain its 44px target at ${width}x${height}: ${JSON.stringify(geometry.status)}`)
    assert.ok(geometry.retry.height >= 44, `retry target should retain at least 44px at ${width}x${height}: ${JSON.stringify(geometry.retry)}`)
    assert.ok(geometry.statusText.height > 0 && geometry.statusText.height <= 34, `the short error message should fit within two lines at ${width}x${height}: ${JSON.stringify(geometry.statusText)}`)
    assert.ok(geometry.statusTextScrollHeight <= geometry.statusTextClientHeight + 1, `the visible error message should not be clipped at ${width}x${height}: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.statusText.right + 4 <= geometry.retry.x, `error text and retry action should not overlap at ${width}x${height}: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.retry.bottom <= geometry.list.top + 1, `retry action should stay above the folder list at ${width}x${height}: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.list.height >= 44, `folder list should show at least one full touch row at ${width}x${height}: ${JSON.stringify(geometry.list)}`)
    assert.ok(geometry.firstFolderRow.height >= 44 && geometry.firstFolderRow.bottom <= geometry.list.bottom + 1, `the first folder should remain fully reachable in the list at ${width}x${height}: ${JSON.stringify({ list: geometry.list, row: geometry.firstFolderRow })}`)
    assert.ok(geometry.list.bottom <= geometry.footer.top + 1, `folder list should not be clipped by the footer at ${width}x${height}: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.statusTextContent.includes('无权限读取此目录'), `the short error summary should remain visible at ${width}x${height}`)
    assert.ok(geometry.statusTextDetails.includes(accessibleBackendReason), `the full backend cause should remain available to assistive technology at ${width}x${height}`)
    assert.ok(geometry.statusTextDetails.includes(longPickerPath), `the accessible error details should retain the still-visible path at ${width}x${height}`)
    assert.ok((await readFile(screenshot)).length > 1000, `error and retry screenshot should be captured at ${width}x${height}`)
  }
  await writeFile(`${evidenceDir}/mobile-error-retry-geometry.json`, JSON.stringify(errorGeometryByViewport, null, 2))

  const temporaryFailurePath = '/srv/service-error-summary'
  state.dirFailurePath = temporaryFailurePath
  state.dirFailureStatus = 503
  state.dirFailureMessage = '目录读取服务暂时失败，请稍后重试。'
  await typePickerPath(temporaryFailurePath)
  await pressPickerPathEnter()
  await waitUntil('generic server error to keep its body reason and retry action', () => connection.evaluate(`(() => {
    const status = document.querySelector('.workspace-picker-status');
    return status?.getAttribute('role') === 'alert'
      && Boolean(status?.querySelector('.workspace-picker-status-text')?.innerText)
      && Boolean(status?.querySelector('button'))
      && document.querySelector('.workspace-picker-list')?.getAttribute('aria-busy') === 'false';
  })()`))
  const serviceError = await readPickerErrorGeometry()
  assert.ok(serviceError.statusTextContent.includes('读取目录'), `generic HTTP errors should describe the failed directory read: ${serviceError.statusTextContent}`)
  assert.ok(serviceError.statusTextContent.includes('请稍后重试'), `generic HTTP errors should keep an actionable retry instruction: ${serviceError.statusTextContent}`)
  assert.equal(serviceError.statusTextContent.includes('无法连接后端'), false, 'an HTTP 503 response is not a network connection failure')
  assert.ok(serviceError.statusTextDetails.includes(state.dirFailureMessage.replace(/[。！？!?]+$/u, '')), 'the full HTTP error body should remain available in the accessible label')
  assert.ok(serviceError.statusTextDetails.includes(longPickerPath), 'generic HTTP error details should retain the still-visible verified path')
  assert.equal((await getPickerState()).confirmDisabled, true, 'a generic server failure must keep confirmation disabled')
  assert.equal(state.setRequests, 0, 'a generic directory server failure must not submit a workspace change')

  state.dirFailurePath = null
  state.dirFailureStatus = 403
  state.dirFailureMessage = '目录访问被拒绝，请选择其他目录。'
  await setBrowserViewport(390, 844, true)

  const requestsBeforeEdit = state.dirRequests
  await connection.evaluate(`(() => {
    const input = document.querySelector('.workspace-picker-modal input[aria-label="目录路径"]');
    input.focus();
    input.setSelectionRange(0, input.value.length);
  })()`)
  await connection.send('Input.insertText', { text: directPathWithSpaces })
  assert.equal(await connection.evaluate(`document.querySelector('.workspace-picker-modal input[aria-label="目录路径"]')?.value`), directPathWithSpaces, 'valid leading/trailing and repeated path spaces must not be trimmed')
  assert.equal(state.dirRequests, requestsBeforeEdit, 'editing the address should not request a directory before Enter')
  assert.equal((await getPickerState()).confirmDisabled, true, 'editing the canonical path must disable confirm until the server validates it')
  await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' })
  await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
  await waitUntil('path with repeated and trailing spaces to load unchanged', async () => state.dirPaths.at(-1) === directPathWithSpaces && (await getPickerState())?.path === directPathWithSpaces && !(await getPickerState())?.busy)
  assert.equal((await getPickerState()).inputValue, directPathWithSpaces)
  assert.equal(state.setRequests, 0, 'path verification should remain GET-only until explicit confirmation')
  const directOrderStart = state.requestOrder.length
  const directSetRequestsBefore = state.setRequests
  await clickButton('使用此目录')
  await waitForRejectedWorkspaceSelection(directPathWithSpaces, directSetRequestsBefore, directOrderStart)
  assert.equal(state.setPaths.at(-1), directPathWithSpaces, 'confirmation must preserve exact spaces in the server path')
  await cancelPickerAndWaitForCleanup()

  for (const [scenario, targetPath] of [
    ['Windows drive', driveNotes],
    ['UNC', uncTeam],
  ]) {
    state.dirRequests = 0
    state.dirPaths = []
    await clickButton('选择工作目录')
    await waitUntil(`${scenario} picker to open on the current server path`, async () => state.dirRequests > 0 && (await getPickerState())?.path === selectedWorkspace)
    const requestCountBeforeTyping = state.dirRequests
    await typePickerPath(targetPath)
    assert.equal(state.dirRequests, requestCountBeforeTyping, `${scenario} input should wait for Enter before navigating`)
    await pressPickerPathEnter()
    await waitUntil(`${scenario} path to load unchanged`, async () => state.dirPaths.at(-1) === targetPath && (await getPickerState())?.path === targetPath && !(await getPickerState())?.busy)
    assert.equal((await getPickerState()).inputValue, targetPath, `${scenario} address input should preserve its original separators`)
    const previousSetRequests = state.setRequests
    const orderStart = state.requestOrder.length
    await clickButton('使用此目录')
    await waitForRejectedWorkspaceSelection(targetPath, previousSetRequests, orderStart)
    assert.equal(state.setPaths.at(-1), targetPath, `${scenario} confirmation should preserve the exact backend path`)
    await cancelPickerAndWaitForCleanup()
  }
  state.directoryLocationMode = false
  state.directoryScenario = 'posix'
})

test('a delayed directory response after cancel cannot replace a reopened picker listing', async t => {
  state.phase = 'closing-previous-page-for-late-directory-response'
  await closeBrowserTarget()
  await waitForEditorRequestsToSettle()
  Object.assign(state, {
    checkMode: 'invalid',
    checkCount: 0,
    serverWorkspace: selectedWorkspace,
    serverWorkspaceId: 'workspace-validation-test',
    serverWorkspaceVersion: 3,
    editorRequests: 0,
    editorRequestDetails: [],
    dirRequests: 0,
    dirPaths: [],
    dirFinishedPaths: [],
    directoryLocationMode: true,
    directoryScenario: 'direct-path',
    dirFailurePath: null,
    dirDelayPath: '/srv/late-response-after-close',
    dirDelayStartedAt: null,
    setRequests: 0,
    setPaths: [],
    setDetails: [],
    checkDetails: [],
    setMode: 'reject',
    requestOrder: [],
    phase: 'late-directory-response',
  })
  let releaseDelayedDirectory
  state.dirDelayGate = new Promise(resolve => { releaseDelayedDirectory = resolve })
  state.dirDelayGates = new Map([[state.dirDelayPath, state.dirDelayGate]])
  t.after(() => releaseDelayedDirectory?.())

  await openBrowserTarget()
  await navigateWithLocalStorage()
  await clickButton('选择工作目录')
  await waitUntil('default directory to load before slow navigation', async () => (await getPickerState())?.path === selectedWorkspace && !(await getPickerState())?.busy)
  await typePickerPath(state.dirDelayPath)
  await pressPickerPathEnter()
  await waitUntil('late directory request to remain in flight', () => state.dirPaths.includes(state.dirDelayPath) && connection.evaluate(`(() => {
    const modal = document.querySelector('.workspace-picker-modal');
    return modal?.querySelector('.workspace-picker-list')?.getAttribute('aria-busy') === 'true'
      && modal?.querySelector('button[aria-label="使用当前目录"]')?.disabled === true;
  })()`))
  const slowRequestPath = state.dirDelayPath
  const requestsBeforeReopen = state.dirRequests
  await clickAriaButton('取消选择工作目录')
  await waitUntil('first picker to close and invalidate its request', isPickerOverlayClosed)

  let releaseFreshDirectory
  const freshDirectoryGate = new Promise(resolve => { releaseFreshDirectory = resolve })
  state.dirDelayGates.set('', freshDirectoryGate)
  await clickButton('选择工作目录')
  const reopenedFirstFrame = await connection.evaluate(`new Promise(resolve => requestAnimationFrame(() => {
    const modal = document.querySelector('.workspace-picker-modal');
    resolve({
      currentPath: modal?.dataset.currentPath ?? null,
      confirmDisabled: modal?.querySelector('button[aria-label="使用当前目录"]')?.disabled ?? null,
      bodyClass: document.body.classList.contains('workspace-picker-open'),
      busy: modal?.querySelector('.workspace-picker-list')?.getAttribute('aria-busy') === 'true',
    });
  }))`)
  assert.deepEqual(reopenedFirstFrame, { currentPath: null, confirmDisabled: true, bodyClass: true, busy: true }, 'a reopened picker must start unverified with confirmation disabled while its authoritative request is pending')
  releaseFreshDirectory()
  state.dirDelayGates.delete('')
  await waitUntil('reopened picker to load a fresh authoritative listing', async () => state.dirRequests >= requestsBeforeReopen + 1 && (await getPickerState())?.path === selectedWorkspace && !(await getPickerState())?.busy)
  const beforeLateResult = await getPickerState()
  releaseDelayedDirectory()
  state.dirDelayGate = null
  state.dirDelayPath = null
  state.dirDelayGates.clear()
  await waitUntil('abandoned backend request to finish after cancellation', () => state.dirFinishedPaths.includes(slowRequestPath))
  await new Promise(resolve => setTimeout(resolve, 550))
  const afterLateResult = await getPickerState()
  assert.equal(afterLateResult.path, selectedWorkspace, 'the late response must not replace the reopened current path')
  assert.deepEqual(afterLateResult.rows, beforeLateResult.rows, 'the late response must not replace the reopened folder listing')
  assert.equal(afterLateResult.inputValue, selectedWorkspace, 'the address field should keep the new picker session value')
  assert.equal(afterLateResult.busy, false)
  assert.equal(afterLateResult.confirmDisabled, false)
  assert.equal(state.setRequests, 0, 'cancel and stale GET completion must not submit a workspace change')
})
