import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { startChrome } from './helpers/chrome-startup.js'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(frontendRoot, 'dist')
const distAssets = path.join(distRoot, 'assets')
const distIndex = path.join(distRoot, 'index.html')

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
      throw new Error(response.result?.exception?.description || response.exceptionDetails.text)
    }
    return response.result?.value
  }

  close() {
    this.socket.close()
  }
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

async function waitUntil(description, check, timeoutMs = 20_000) {
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
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 2_000)),
  ])
  if (stopped) return
  child.kill('SIGKILL')
  await new Promise(resolve => child.once('exit', resolve))
}

test('a real lazy Editor chunk 404 renders the reload error boundary', { timeout: 90_000 }, async t => {
  await access(distIndex).catch(() => {
    throw new Error('Lazy chunk browser test requires frontend/dist/index.html; run `npm run build` first.')
  })
  const chunks = (await readdir(distAssets)).filter(file => /^Editor-[^/]+\.js$/.test(file))
  assert.equal(chunks.length, 1, `Expected one lazy Editor JavaScript chunk in ${distAssets}`)
  const editorChunkPath = `/assets/${chunks[0]}`
  assert.ok((await readFile(distIndex, 'utf8')).includes('/assets/'), 'Production index should load built assets')

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-lazy-error-'))
  let chromeProcess
  let connection
  let server
  let editorChunk404Count = 0

  t.after(async () => {
    connection?.close()
    await stopChild(chromeProcess)
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    await rm(tempRoot, { recursive: true, force: true })
  })

  server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
    if (requestUrl.pathname === '/api/workspace/check') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({
        workspace: '/test-workspace',
        workspaceId: 'lazy-error-workspace',
        workspaceVersion: 1,
        empty: false,
      }))
      return
    }
    if (requestUrl.pathname === editorChunkPath) {
      editorChunk404Count += 1
      response.writeHead(404, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end('/* intentional test-only lazy Editor chunk failure */')
      return
    }

    const relativePath = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.slice(1)
    const absolutePath = path.resolve(distRoot, decodeURIComponent(relativePath))
    if (absolutePath !== distRoot && !absolutePath.startsWith(`${distRoot}${path.sep}`)) {
      response.writeHead(400).end()
      return
    }
    try {
      const body = await readFile(absolutePath)
      const extension = path.extname(absolutePath).toLowerCase()
      const contentType = extension === '.html' ? 'text/html; charset=utf-8'
        : extension === '.js' ? 'text/javascript; charset=utf-8'
          : extension === '.css' ? 'text/css; charset=utf-8'
            : extension === '.svg' ? 'image/svg+xml'
              : extension === '.woff2' ? 'font/woff2'
                : 'application/octet-stream'
      response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const chromePath = await findChrome()
  const chrome = await startChrome({ chromePath, profileDir: path.join(tempRoot, 'chrome-profile') })
  chromeProcess = chrome.child
  const targetResponse = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: 'PUT' })
  assert.equal(targetResponse.ok, true, 'Chrome should create an isolated browser target')
  const target = await targetResponse.json()
  connection = await DevToolsConnection.connect(target.webSocketDebuggerUrl)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')
  await connection.send('Page.navigate', { url: baseUrl })

  const fallback = await waitUntil('the editor load error boundary', async () => connection.evaluate(`(() => {
    const alert = document.querySelector('[role="alert"]')
    if (!alert) return null
    return {
      text: alert.innerText,
      reloadButton: alert.querySelector('button')?.innerText || '',
      editorMounted: Boolean(document.querySelector('.workspace-sidebar')),
    }
  })()`))
  assert.ok(fallback.text.includes('编辑器加载失败'))
  assert.ok(fallback.text.includes('资源可能已过期'))
  assert.equal(fallback.reloadButton, '重新加载页面')
  assert.equal(fallback.editorMounted, false, 'The failed lazy component must not mount partially')
  assert.ok(editorChunk404Count > 0, 'The built Editor JavaScript chunk must receive an actual HTTP 404')
})
