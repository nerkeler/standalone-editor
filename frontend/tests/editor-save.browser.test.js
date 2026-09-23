import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before, beforeEach } from 'node:test'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(frontendRoot, '..')
const backendEntry = path.join(repoRoot, 'backend', 'src', 'index.js')
const viteEntry = path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const firstFile = 'first.md'
const secondFile = 'second.md'
const firstSeed = 'First file seed'
const secondSeed = 'Second file seed'

let tempRoot
let workspace
let frontendPort
let backendPort
let frontendProcess
let backendProcess
let chromeProcess
let cdp
let targetId
let chromeProfile
let logs = ''

function appendLog(label, chunk) {
  logs += `\n[${label}] ${chunk}`
  if (logs.length > 12000) logs = logs.slice(-12000)
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
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}\n${logs}`)
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

class DevToolsConnection {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString())
      if (!message.id) {
        if (message.method === 'Runtime.exceptionThrown') {
          appendLog('browser exception', message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
        }
        if (message.method === 'Log.entryAdded') {
          appendLog('browser log', `${message.params.entry.level}: ${message.params.entry.text}`)
        }
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Chrome DevTools connection closed'))
      this.pending.clear()
    })
  }

  static async connect(url) {
    const socket = new globalThis.WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new DevToolsConnection(socket)
  }

  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
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

async function startChrome() {
  const chrome = await findChrome()
  chromeProfile = path.join(tempRoot, 'chrome-profile')
  chromeProcess = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--remote-debugging-port=0',
    `--user-data-dir=${chromeProfile}`, 'about:blank',
  ], { stdio: 'ignore' })
  const activePortFile = path.join(chromeProfile, 'DevToolsActivePort')
  const port = await waitUntil('Chrome DevTools endpoint', async () => {
    const contents = await readFile(activePortFile, 'utf8').catch(() => '')
    const value = Number(contents.split('\n')[0])
    return value > 0 ? value : null
  })
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  assert.equal(response.ok, true, 'Chrome should create an isolated page target')
  const target = await response.json()
  targetId = target.id
  cdp = await DevToolsConnection.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  const realWorkspace = await realpath(workspace)
  const info = {
    workspace: realWorkspace,
    workspaceId: createHash('sha256').update(realWorkspace).digest('hex').slice(0, 24),
    workspaceVersion: 1,
  }
  const serializedInfo = JSON.stringify(info)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('editor_workspace_info', ${JSON.stringify(serializedInfo)}); localStorage.setItem('editor_workspace', ${JSON.stringify(realWorkspace)});`,
  })
}

async function pageIsReady() {
  return cdp.evaluate(`Boolean(document.querySelector('.workspace-sidebar') && document.querySelector('.tree-scroll'))`)
}

async function openFile(fileName, expectedText) {
  await waitUntil(`${fileName} in file tree`, () => cdp.evaluate(`Array.from(document.querySelectorAll('.ant-tree-title > div')).some(node => node.innerText.trim() === ${JSON.stringify(fileName)})`))
  await cdp.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('.ant-tree-title > div')).find(item => item.innerText.trim() === ${JSON.stringify(fileName)});
    node?.click();
    return Boolean(node);
  })()`)
  await waitUntil(`${fileName} content`, () => cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(expectedText)})`))
}

async function insertAtDocumentEnd(text) {
  await cdp.evaluate(`(() => {
    const editor = document.querySelector('.ProseMirror');
    if (!editor) return false;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`)
  await cdp.send('Input.insertText', { text })
}

async function setupPage() {
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${frontendPort}/` })
  try {
    await waitUntil('editor application to mount', pageIsReady)
  } catch (error) {
    const state = await cdp.evaluate(`JSON.stringify({ url: location.href, title: document.title, body: document.body?.innerText, html: document.body?.innerHTML?.slice(0, 1000) })`).catch(err => `inspection failed: ${err.message}`)
    throw new Error(`${error.message}\nBrowser state: ${state}`)
  }
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-save-test-'))
  workspace = path.join(tempRoot, 'notes')
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, firstFile), firstSeed)
  await writeFile(path.join(workspace, secondFile), secondSeed)
  backendPort = await freePort()
  frontendPort = await freePort()

  const sharedEnv = { ...process.env }
  backendProcess = startProcess('backend', process.execPath, [backendEntry, '--workspace', workspace], {
    ...sharedEnv,
    PORT: String(backendPort),
    EDITOR_PORT: String(backendPort),
    FRONTEND_PORT: String(frontendPort),
    WORKSPACE_CONFIG_FILE: path.join(tempRoot, 'workspace-config.json'),
    EDITOR_DIRECTORY_ROOTS: tempRoot,
    ALLOW_ANY_WORKSPACE: '1',
    HOST: '127.0.0.1',
  })
  frontendProcess = startProcess('vite', process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], {
    ...sharedEnv,
    FRONTEND_PORT: String(frontendPort),
    EDITOR_PORT: String(backendPort),
  }, frontendRoot)

  await waitUntil('isolated backend health check', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/workspace/check`).catch(() => null)
    if (response && !response.ok) throw new Error(`backend returned ${response.status}: ${await response.text()}`)
    return response?.ok
  })
  await waitUntil('isolated frontend server', async () => {
    const response = await fetch(`http://127.0.0.1:${frontendPort}/`).catch(() => null)
    if (response && !response.ok) throw new Error(`frontend returned ${response.status}: ${await response.text()}`)
    return response?.ok
  })
  await startChrome()
})

beforeEach(async () => {
  await writeFile(path.join(workspace, firstFile), firstSeed)
  await writeFile(path.join(workspace, secondFile), secondSeed)
  await setupPage()
})

after(async () => {
  cdp?.close()
  for (const child of [chromeProcess, frontendProcess, backendProcess]) {
    if (!child || child.exitCode !== null) continue
    child.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1500)),
    ])
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

test('an edit is persisted by the three-second autosave', async () => {
  await openFile(firstFile, firstSeed)
  const token = `AUTO-SAVE-${Date.now()}`
  const editedAt = Date.now()
  await insertAtDocumentEnd(token)
  await waitUntil('edited text in the editor', () => cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(token)})`))

  await waitUntil('autosave to write the edited bytes', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content.includes(token) ? content : null
  }, 9000)
  assert.ok(Date.now() - editedAt >= 2700, 'the write should follow the three-second debounce')
  assert.equal((await readFile(path.join(workspace, secondFile), 'utf8')), secondSeed)
})

test('a pending edit stays bound to its file when the user switches tabs', async () => {
  await openFile(firstFile, firstSeed)
  const token = `SWITCH-PENDING-${Date.now()}`
  await insertAtDocumentEnd(token)
  await waitUntil('pending edit in the first editor', () => cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(token)})`))
  await openFile(secondFile, secondSeed)

  await waitUntil('pending edit to save to the original file', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content.includes(token) ? content : null
  }, 9000)
  assert.equal(await readFile(path.join(workspace, secondFile), 'utf8'), secondSeed)
})
