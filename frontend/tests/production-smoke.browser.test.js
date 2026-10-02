import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
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
    this.requests = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString())
      if (!message.id) {
        if (message.method === 'Network.requestWillBeSent') {
          const request = message.params.request || {}
          this.requests.push({ method: request.method, url: request.url })
        }
        return
      }
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

async function waitUntil(description, check, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
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

test('production build opens, autosaves, serves relative images, and downloads original attachment bytes', { timeout: 90_000 }, async t => {
  await access(distIndex).catch(() => {
    throw new Error('Production smoke requires frontend/dist/index.html; run `npm run build` in frontend first.')
  })

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-production-smoke-'))
  const workspace = path.join(tempRoot, 'notes')
  const backendPort = await freePort()
  const attachmentBytes = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42])
  const pixelBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmf0AAAAASUVORK5CYII=', 'base64')
  const noteName = 'production-smoke.md'
  let backendProcess
  let chromeProcess
  let chromePort
  let connection
  let logs = ''

  t.after(async () => {
    await cleanupBrowserTest({
      browser: { child: chromeProcess, port: chromePort },
      connections: [connection],
      children: [backendProcess],
      tempRoot,
    })
  })

  await mkdir(path.join(workspace, 'assets'), { recursive: true })
  await writeFile(path.join(workspace, noteName), '# Production smoke\n\nBody seed.\n\n![Pixel](assets/pixel.png)\n\nEnd.\n')
  await writeFile(path.join(workspace, 'assets', 'pixel.png'), pixelBytes)
  await writeFile(path.join(workspace, 'archive.sqlite'), attachmentBytes)

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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backendProcess.stdout.setEncoding('utf8').on('data', chunk => { logs += chunk })
  backendProcess.stderr.setEncoding('utf8').on('data', chunk => { logs += chunk })

  const baseUrl = `http://127.0.0.1:${backendPort}`
  await waitUntil('production backend health and static index', async () => {
    if (backendProcess.exitCode !== null) throw new Error(`Backend exited (${backendProcess.exitCode}): ${logs}`)
    const [health, index] = await Promise.all([
      fetch(`${baseUrl}/api/health`).catch(() => null),
      fetch(`${baseUrl}/`).catch(() => null),
    ])
    if (!health?.ok || !index?.ok) return false
    const html = await index.text()
    if (!html.includes('<div id="root">')) throw new Error('Backend did not serve the built frontend entry document')
    return true
  }, { timeoutMs: 12_000 })

  const realWorkspace = await realpath(workspace)
  const workspaceId = createHash('sha256').update(realWorkspace).digest('hex').slice(0, 24)
  const chromePath = await findChrome()
  const chrome = await startChrome({ chromePath, profileDir: path.join(tempRoot, 'chrome-profile') })
  chromeProcess = chrome.child
  chromePort = chrome.port
  const targetResponse = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: 'PUT' })
  assert.equal(targetResponse.ok, true, 'Chrome should create the isolated smoke page')
  const target = await targetResponse.json()
  connection = await DevToolsConnection.connect(target.webSocketDebuggerUrl)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')
  await connection.send('Network.enable')
  const workspaceInfo = JSON.stringify({ workspace: realWorkspace, workspaceId, workspaceVersion: 1 })
  await connection.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('editor_workspace_info', ${JSON.stringify(workspaceInfo)}); localStorage.setItem('editor_workspace', ${JSON.stringify(realWorkspace)});`,
  })
  await connection.send('Page.navigate', { url: `${baseUrl}/` })

  await waitUntil('the editor to mount from the production dist build', () => connection.evaluate(
    `Boolean(document.querySelector('.workspace-sidebar') && document.querySelector('.tree-scroll'))`,
  ), { timeoutMs: 20_000 })
  await waitUntil('the note in the production file tree', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.ant-tree-title > div')).some(node => node.innerText.trim() === ${JSON.stringify(noteName)})`,
  ))
  await connection.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('.ant-tree-title > div')).find(item => item.innerText.trim() === ${JSON.stringify(noteName)});
    node?.click();
    return Boolean(node);
  })()`)
  await waitUntil('the note content to open in the editor', () => connection.evaluate(
    `document.querySelector('.ProseMirror[contenteditable="true"]')?.innerText.includes('Body seed.')`,
  ))

  await waitUntil('the relative image to load from the production media endpoint', () => connection.evaluate(
    `(() => { const image = document.querySelector('.ProseMirror img'); return Boolean(image && image.complete && image.naturalWidth === 1); })()`,
  ))
  const imageResponse = await connection.evaluate(`(async () => {
    const image = document.querySelector('.ProseMirror img');
    const response = await fetch(image.src);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      path: new URL(image.src).pathname,
      status: response.status,
      bytes: Array.from(bytes).map(value => value.toString(16).padStart(2, '0')).join(''),
    };
  })()`)
  assert.equal(imageResponse.path, '/api/workspace/media/assets/pixel.png')
  assert.equal(imageResponse.status, 200)
  assert.equal(imageResponse.bytes, pixelBytes.toString('hex'))

  const token = `PRODUCTION-AUTOSAVE-${Date.now()}`
  const editedAt = Date.now()
  await connection.evaluate(`(() => {
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
  await connection.send('Input.insertText', { text: token })
  await waitUntil('the three-second save to persist the edit in the workspace', async () => {
    const content = await readFile(path.join(workspace, noteName), 'utf8')
    return content.includes(token) ? content : null
  }, { timeoutMs: 12_000 })
  assert.ok(Date.now() - editedAt >= 2_700, 'production autosave should follow the three-second debounce')

  await waitUntil('the attachment to appear in the production file tree', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.ant-tree-title > div')).some(node => node.innerText.trim() === 'archive.sqlite')`,
  ))
  await connection.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('.ant-tree-title > div')).find(item => item.innerText.trim() === 'archive.sqlite');
    node?.click();
    return Boolean(node);
  })()`)
  await waitUntil('the attachment read-only view to open', () => connection.evaluate(
    `Boolean(document.querySelector('[aria-label="附件只读查看"]'))`,
  ))
  const downloadRequestStart = connection.requests.length
  await connection.evaluate(`document.querySelector('button[aria-label="下载附件"]')?.click()`)
  await waitUntil('the attachment UI to call the binary download endpoint', () => connection.requests
    .slice(downloadRequestStart)
    .some(request => request.method === 'GET' && new URL(request.url).pathname === '/api/workspace/download'),
  )
  const downloaded = await connection.evaluate(`(async () => {
    const info = JSON.parse(localStorage.getItem('editor_workspace_info') || 'null');
    const response = await fetch('/api/workspace/download?path=archive.sqlite', { headers: {
      'X-Workspace-Id': info?.workspaceId || '',
      'X-Workspace-Version': String(info?.workspaceVersion ?? ''),
    }});
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, bytes: Array.from(bytes).map(value => value.toString(16).padStart(2, '0')).join('') };
  })()`)
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.bytes, attachmentBytes.toString('hex'))
})
