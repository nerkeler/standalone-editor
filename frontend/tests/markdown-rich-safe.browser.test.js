import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(frontendRoot, '..')
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'markdown-rich-safe.md')
const backendEntry = path.join(repoRoot, 'backend', 'src', 'index.js')
const viteEntry = path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js')

let tempRoot
let workspace
let frontendPort
let backendPort
let frontendProcess
let backendProcess
let chromeProcess
let chromePort
let connection
let logs = ''

function appendLog(label, chunk) {
  logs += '\n[' + label + '] ' + chunk
  if (logs.length > 9000) logs = logs.slice(-9000)
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
  throw new Error('Timed out waiting for ' + description + (lastError ? ': ' + lastError.message : '') + '\n' + logs)
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
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
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

async function startChrome() {
  const chrome = await findChrome()
  const chromeProfile = path.join(tempRoot, 'chrome-profile')
  chromeProcess = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--remote-debugging-port=0',
    '--user-data-dir=' + chromeProfile, 'about:blank',
  ], { stdio: 'ignore' })
  const activePortFile = path.join(chromeProfile, 'DevToolsActivePort')
  chromePort = await waitUntil('isolated Chrome DevTools endpoint', async () => {
    const contents = await readFile(activePortFile, 'utf8').catch(() => '')
    const port = Number(contents.split('\n')[0])
    return port > 0 ? port : null
  })
  const response = await fetch('http://127.0.0.1:' + chromePort + '/json/new?about:blank', { method: 'PUT' })
  assert.equal(response.ok, true, 'Chrome should create an isolated page target')
  const target = await response.json()
  connection = await DevToolsConnection.connect(target.webSocketDebuggerUrl)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')
  const realWorkspace = await realpath(workspace)
  const info = { workspace: realWorkspace, workspaceId: 'markdown-rich-safe-test', workspaceVersion: 1 }
  await connection.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'localStorage.setItem("editor_workspace_info", ' + JSON.stringify(JSON.stringify(info)) + '); localStorage.setItem("editor_workspace", ' + JSON.stringify(realWorkspace) + ');',
  })
}

async function openFixture() {
  await connection.send('Page.navigate', { url: 'http://127.0.0.1:' + frontendPort + '/' })
  await waitUntil('editor application to mount', () => connection.evaluate(
    'Boolean(document.querySelector(".workspace-sidebar") && document.querySelector(".tree-scroll"))',
  ))
  await waitUntil('rich-safe fixture to appear in file tree', () => connection.evaluate(
    'Array.from(document.querySelectorAll(".ant-tree-title > div")).some(node => node.innerText.trim() === "rich-safe.md")',
  ))
  await connection.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('.ant-tree-title > div')).find(item => item.innerText.trim() === 'rich-safe.md');
    node?.click();
    return Boolean(node);
  })()`)
  await waitUntil('rich-safe Markdown to open in the rich editor', () => connection.evaluate(
    'Boolean(document.querySelector(".ProseMirror") && !document.querySelector("textarea[aria-label=\\"Markdown 源文本\\"]"))',
  ))
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-rich-safe-'))
  workspace = path.join(tempRoot, 'notes')
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, 'rich-safe.md'), await readFile(fixturePath, 'utf8'))
  frontendPort = await freePort()
  backendPort = await freePort()

  const sharedEnv = { ...process.env }
  backendProcess = startProcess('backend', process.execPath, [backendEntry, '--workspace', workspace], {
    ...sharedEnv,
    PORT: String(backendPort),
    EDITOR_PORT: String(backendPort),
    FRONTEND_PORT: String(frontendPort),
    WORKSPACE_CONFIG_FILE: path.join(tempRoot, 'workspace-config.json'),
    EDITOR_RECOVERY_DIR: path.join(tempRoot, 'recovery'),
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
    const response = await fetch('http://127.0.0.1:' + backendPort + '/api/workspace/check').catch(() => null)
    return response?.ok
  })
  await waitUntil('isolated frontend server', async () => {
    const response = await fetch('http://127.0.0.1:' + frontendPort + '/').catch(() => null)
    return response?.ok
  })
  await startChrome()
})

after(async () => {
  connection?.close()
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

test('rich-safe Markdown opens rich, accepts an edit, and saves through the conversion chain', async () => {
  await openFixture()
  await connection.evaluate(`(() => {
    const editor = document.querySelector('.ProseMirror');
    const paragraph = editor?.querySelector('p');
    if (!paragraph) return false;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`)
  await connection.send('Input.insertText', { text: ' [browser saved marker]' })
  await connection.evaluate('document.querySelector("[aria-label=\\"保存当前文件\\"]")?.click()')

  const saved = await waitUntil('edited rich Markdown to reach the isolated workspace', async () => {
    const content = await readFile(path.join(workspace, 'rich-safe.md'), 'utf8').catch(() => '')
    return content.includes('browser saved marker') ? content : null
  })
  assert.match(saved, /# Rich-safe Markdown/)
  assert.match(saved, /\*\*bold\*\*/)
  assert.match(saved, /~~strike~~/)
  assert.match(saved, /\| Name \| Details \|/)
  assert.match(saved, /```ts/)
})
