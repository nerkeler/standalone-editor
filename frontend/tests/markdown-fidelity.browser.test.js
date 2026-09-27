import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { marked } from 'marked'
import { startChrome as startChromeProcess } from './helpers/chrome-startup.js'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(frontendRoot, '..')
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'markdown-fidelity.md')
const fixture = await readFile(fixturePath, 'utf8')
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
let chromeProfile
let connection
let logs = ''

function appendLog(label, chunk) {
  logs += `\n[${label}] ${chunk}`
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
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}\n${logs}`)
}

class DevToolsConnection {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.networkRequests = []
    this.pausedFetchRequests = []
    this.pauseNextWorkspacePut = false
    this.acceptBeforeUnload = false
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString())
      if (!message.id) {
        if (message.method === 'Page.javascriptDialogOpening' &&
            message.params?.type === 'beforeunload' && this.acceptBeforeUnload) {
          this.send('Page.handleJavaScriptDialog', { accept: true }).catch(error => appendLog('beforeunload dialog', error.message))
        }
        if (message.method === 'Network.requestWillBeSent') {
          const request = message.params.request || {}
          this.networkRequests.push({ method: request.method, url: request.url, postData: request.postData || '' })
        }
        if (message.method === 'Fetch.requestPaused') {
          const paused = message.params
          const request = paused.request || {}
          if (this.pauseNextWorkspacePut && request.method === 'PUT' && request.url.includes('/api/workspace')) {
            this.pauseNextWorkspacePut = false
            this.pausedFetchRequests.push(paused)
          } else {
            this.send('Fetch.continueRequest', { requestId: paused.requestId }).catch(error => appendLog('fetch continue', error.message))
          }
        }
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
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for Chrome DevTools ${method}`))
      }, 15000)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value) },
        reject: error => { clearTimeout(timeout); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
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
  chromeProfile = path.join(tempRoot, 'chrome-profile')
  const started = await startChromeProcess({ chromePath: chrome, profileDir: chromeProfile })
  chromeProcess = started.child
  chromePort = started.port
  const response = await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: 'PUT' })
  assert.equal(response.ok, true, 'Chrome should create an isolated page target')
  const target = await response.json()
  connection = await DevToolsConnection.connect(target.webSocketDebuggerUrl)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')
  await connection.send('Network.enable')
  const realWorkspace = await realpath(workspace)
  const info = {
    workspace: realWorkspace,
    workspaceId: 'markdown-fidelity-test',
    workspaceVersion: 1,
  }
  await connection.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('editor_workspace_info', ${JSON.stringify(JSON.stringify(info))}); localStorage.setItem('editor_workspace', ${JSON.stringify(realWorkspace)});`,
  })
}

async function setupPage() {
  connection.acceptBeforeUnload = true
  try {
    await connection.send('Page.navigate', { url: `http://127.0.0.1:${frontendPort}/` })
  } finally {
    connection.acceptBeforeUnload = false
  }
  await waitUntil('editor application to mount', () => connection.evaluate(
    `Boolean(document.querySelector('.workspace-sidebar') && document.querySelector('.tree-scroll'))`,
  ))
}

async function openFile(fileName, expectedText = 'Markdown fidelity fixture') {
  await waitUntil(`${fileName} in file tree`, () => connection.evaluate(
    `Array.from(document.querySelectorAll('.ant-tree-title > div')).some(node => node.innerText.trim() === ${JSON.stringify(fileName)})`,
  ))
  await connection.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('.ant-tree-title > div')).find(item => item.innerText.trim() === ${JSON.stringify(fileName)});
    node?.click();
    return Boolean(node);
  })()`)
  await waitUntil(`${fileName} content`, () => connection.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString().includes(${JSON.stringify(expectedText)}) || document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(expectedText)})`,
  ))
}

async function appendToRichEditor(text) {
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
  await connection.send('Input.insertText', { text })
}

async function clickSave() {
  await connection.evaluate(`document.querySelector('[aria-label="保存当前文件"]')?.click()`)
}

async function waitForDiskMarker(fileName, marker) {
  return waitUntil('edited Markdown to reach the isolated workspace', async () => {
    const content = await readFile(path.join(workspace, fileName), 'utf8').catch(() => '')
    return content.includes(marker) ? content : null
  })
}

function workspacePutCount() {
  return connection.networkRequests.filter(request => request.method === 'PUT' && request.url.includes('/api/workspace')).length
}

async function clickRepairAction(label) {
  await waitUntil(`repair action “${label}”`, () => connection.evaluate(
    `Array.from(document.querySelectorAll('.markdown-repair-banner button')).some(button => button.innerText.trim() === ${JSON.stringify(label)} && !button.disabled)`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('.markdown-repair-banner button')).find(button => button.innerText.trim() === ${JSON.stringify(label)} && !button.disabled)?.click()`)
}

async function readWorkspaceHistory(fileName) {
  return connection.evaluate(`(async () => {
    const info = JSON.parse(localStorage.getItem('editor_workspace_info') || 'null');
    const url = new URL('/api/workspace/file/history', location.origin);
    url.searchParams.set('path', ${JSON.stringify(fileName)});
    const response = await fetch(url, { headers: {
      'X-Workspace-Id': info?.workspaceId || '',
      'X-Workspace-Version': String(info?.workspaceVersion ?? ''),
    }});
    return { status: response.status, data: await response.json() };
  })()`)
}

async function saveRepairScreenshot(fileName) {
  const outputDirectory = process.env.EDITOR_REPAIR_SCREENSHOT_DIR
  if (!outputDirectory) return
  await mkdir(outputDirectory, { recursive: true })
  const screenshot = await connection.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(path.join(outputDirectory, fileName), Buffer.from(screenshot.data, 'base64'))
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-markdown-test-'))
  workspace = path.join(tempRoot, 'notes')
  await mkdir(workspace, { recursive: true })
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
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/workspace/check`).catch(() => null)
    return response?.ok
  })
  await waitUntil('isolated frontend server', async () => {
    const response = await fetch(`http://127.0.0.1:${frontendPort}/`).catch(() => null)
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

test('complex Markdown opens in source mode and rich conversion requires explicit warning confirmation', async () => {
  const fileName = 'source-protected.md'
  await writeFile(path.join(workspace, fileName), fixture)
  await setupPage()
  await openFile(fileName)
  await waitUntil('complex Markdown source guard', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content') && document.body.innerText.includes('源码保护'))`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), fixture)
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.ProseMirror'))`), false, 'protected Markdown should not initialize the rich editor')
  await waitUntil('specific wavy source diagnostics', () => connection.evaluate(`document.querySelectorAll('.cm-protected-range').length >= 5`))
  assert.equal(await connection.evaluate(`document.querySelector('.source-fidelity-warning')?.innerText.includes('处内容需要源码保护')`), true)
  const protectedBox = await connection.evaluate(`(() => { const box = document.querySelector('.cm-protected-range')?.getBoundingClientRect(); return box && { x: box.x + 4, y: box.y + box.height / 2 } })()`)
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: protectedBox.x, y: protectedBox.y })
  await waitUntil('hover explains protected syntax', () => connection.evaluate(`Boolean(document.querySelector('.cm-tooltip-lint')?.innerText.includes('YAML'))`), 3000)

  await connection.evaluate(`document.querySelector('[aria-label="保存当前文件"]')?.click()`)
  await waitUntil('protected Markdown save action to settle', () => connection.evaluate(
    `!document.querySelector('[aria-label="保存当前文件"]')?.disabled`,
  ))
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), fixture, 'saving without editing must leave all source syntax byte-for-byte intact')

  await connection.evaluate(`document.querySelector('[aria-label="编辑"]')?.click()`)
  await waitUntil('explicit rich conversion warning', () => connection.evaluate(
    `document.body.innerText.includes('此文档包含源码模式保护内容') && document.body.innerText.includes('仍切换到富文本')`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('.ant-modal button')).find(button => button.innerText.trim() === '继续源码模式')?.click()`)
  await waitUntil('source mode remains active after dismissing warning', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content')) && !document.querySelector('.ProseMirror')`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), fixture)
})

test('ordinary nested model bullets open in rich mode and keep their hierarchy after editing', async () => {
  const fileName = 'nested-model-list.md'
  const source = [
    '### Ollama',
    '',
    '-   **端口**: `11434`',
    '    ',
    '-   **模型**:',
    '    ',
    '    -   qwen2.5:3b (1.9 GB) — 本地 LLM',
    '        ',
    '    -   nomic-embed-text (274 MB) — Embedding 模型',
    '        ',
    '',
    '### Open-WebUI',
    '',
  ].join('\n')
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  const initialPuts = workspacePutCount()
  await openFile(fileName, 'qwen2.5:3b')

  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.source-fidelity-warning'))`), false, 'ordinary nested list must open without source protection')
  await waitUntil('ordinary nested bullets to load in rich mode', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror ul li ul li'))`,
  ))
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.markdown-repair-banner'))`), false, 'valid nested Markdown needs no file repair')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), source, 'opening valid Markdown must not rewrite it')
  assert.equal(workspacePutCount(), initialPuts, 'opening valid Markdown must not send a repair save')
  await appendToRichEditor(' verified')
  await clickSave()
  const saved = await waitForDiskMarker(fileName, 'verified')
  const outer = marked.lexer(saved).find(token => token.type === 'list')
  const nested = outer?.items?.[1]?.tokens?.find(token => token.type === 'list')
  assert.equal(nested?.items?.length, 2, 'rich editing must keep both nested items under the model heading')
  assert.match(saved, /nomic-embed-text/)
  await setupPage()
  await openFile(fileName, 'verified')
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.ProseMirror') && !document.querySelector('.source-fidelity-warning'))`), true, 'saved nested list should reopen without source protection')
  await saveRepairScreenshot('nested-list-rich.png')
})

test('lossy quote, reference, and multiline HTML syntax stays byte-identical on a no-op save', async () => {
  const fileName = 'lossy-structure-regression.md'
  const source = [
    '> - outer',
    '>   - nested quote list',
    '>',
    '> | Left | Right |',
    '> | :-- | --: |',
    '> | a | b |',
    '>',
    '> ```js title=quote.js',
    '> const sample = "quoted";',
    '> ```',
    '',
    '[link',
    '][ref]',
    '',
    '[ref]:',
    '  https://example.com',
    '',
    '<img',
    '  src="photo.png"',
    '  data-custom="keep">',
    '',
  ].join('\n')
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  await openFile(fileName, 'nested quote list')

  await waitUntil('lossy Markdown source mode and diagnostics', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content') && document.querySelector('.source-fidelity-warning')?.innerText.includes('处内容需要源码保护') && document.querySelectorAll('.cm-protected-range').length >= 6)`,
  ))
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.ProseMirror'))`), false, 'lossy structures must not initialize the rich editor')
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), source)

  await clickSave()
  await waitUntil('no-op source save to settle', () => connection.evaluate(
    `!document.querySelector('[aria-label="保存当前文件"]')?.disabled`,
  ))
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), source, 'a no-op save must preserve every source byte')
})

test('a titled Markdown link stays in source mode so editing cannot discard its title', async () => {
  const fileName = 'titled-link.md'
  const source = '[guide](https://example.com "important title")\n'
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  await openFile(fileName, 'guide')
  await waitUntil('titled link to use the source editor', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content') && document.querySelector('.source-fidelity-warning'))`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), source)
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.markdown-repair-banner'))`), false)
  await clickSave()
  await waitUntil('titled link no-op save to settle', () => connection.evaluate(
    `document.querySelector('.save-status')?.innerText.includes('已保存')`,
  ))
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), source)
})

test('opening and canceling a repair proposal never writes or schedules an autosave', async () => {
  const fileName = 'safe-normalize-cancel.md'
  const original = '[guide][docs]\n\n[docs]: https://example.com\n'
  await writeFile(path.join(workspace, fileName), original)
  await setupPage()
  await openFile(fileName, 'guide')
  await waitUntil('repair proposal for a simple reference link', () => connection.evaluate(
    `Boolean(document.querySelector('.markdown-repair-banner')?.innerText.includes('确认修复并保存'))`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), original)
  const initialPuts = workspacePutCount()
  const before = await stat(path.join(workspace, fileName))
  await new Promise(resolve => setTimeout(resolve, 3300))
  assert.equal(workspacePutCount(), initialPuts, 'opening alone must not send a workspace PUT')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), original)
  assert.equal((await stat(path.join(workspace, fileName))).mtimeMs, before.mtimeMs)

  await clickRepairAction('暂不修复')
  await waitUntil('repair proposal to close after cancel', () => connection.evaluate(
    `!document.querySelector('.markdown-repair-banner')`,
  ))
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(workspacePutCount(), initialPuts, 'cancel must not send a workspace PUT')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), original)
  assert.equal((await stat(path.join(workspace, fileName))).mtimeMs, before.mtimeMs)
})

test('switching from a source-mode repair proposal to another file stays clean past autosave', async () => {
  const sourceName = 'source-switch-a.md'
  const targetName = 'source-switch-b.md'
  const sourceA = '[guide][docs]\n\n[docs]: https://example.com\n'
  const sourceB = 'Plain target document\n'
  await writeFile(path.join(workspace, sourceName), sourceA)
  await writeFile(path.join(workspace, targetName), sourceB)
  await setupPage()
  const initialPuts = workspacePutCount()

  await openFile(sourceName, 'guide')
  await waitUntil('source A repair proposal to be ready', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content') && document.querySelector('.markdown-repair-banner'))`,
  ))
  await openFile(targetName, 'Plain target document')
  await waitUntil('source B to be clean and active', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror')?.innerText.includes('Plain target document') && document.querySelector('.save-status')?.innerText.includes('已保存'))`,
  ))
  await new Promise(resolve => setTimeout(resolve, 3500))

  assert.equal(workspacePutCount(), initialPuts, 'switching away from an untouched source document must not send a PUT')
  assert.equal(await readFile(path.join(workspace, sourceName), 'utf8'), sourceA)
  assert.equal(await readFile(path.join(workspace, targetName), 'utf8'), sourceB)
  assert.equal(await connection.evaluate(`document.querySelector('.save-status')?.innerText.includes('已保存')`), true)
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.markdown-repair-banner'))`), false)
})

test('confirming a repair saves once through CAS, records history, and removes the proposal', async () => {
  const fileName = 'safe-normalize-confirm.md'
  const original = '[guide][docs]\n\n[docs]: https://example.com\n'
  const repaired = '[guide](https://example.com)\n'
  await writeFile(path.join(workspace, fileName), original)
  await writeFile(path.join(workspace, 'repair-switch.md'), 'Switch target')
  await setupPage()
  await openFile(fileName, 'guide')
  await waitUntil('repair preview to show a before and after', () => connection.evaluate(
    `Boolean(document.querySelector('.markdown-repair-example')?.innerText.includes('→') && document.querySelector('.markdown-repair-banner'))`,
  ))
  await saveRepairScreenshot('markdown-repair-proposal.png')
  const initialPuts = workspacePutCount()
  await clickRepairAction('确认修复并保存')
  await waitUntil('confirmed repair bytes and PUT request to reach disk', async () => (
    (await readFile(path.join(workspace, fileName), 'utf8')) === repaired && workspacePutCount() - initialPuts === 1
  ))
  assert.equal(workspacePutCount() - initialPuts, 1, 'confirm should perform exactly one immediate workspace PUT')
  const repairRequest = connection.networkRequests.filter(request => request.method === 'PUT' && request.url.includes('/api/workspace')).at(-1)
  const repairPayload = JSON.parse(repairRequest?.postData || '{}')
  assert.equal(repairPayload.path, fileName)
  assert.ok(repairPayload.expectedRevision, 'the save should carry the disk revision for compare-and-swap')
  const history = await readWorkspaceHistory(fileName)
  assert.equal(history.status, 200)
  assert.ok(history.data.history?.length, 'the pre-repair version should remain in file history')

  await openFile('repair-switch.md', 'Switch target')
  await openFile(fileName, 'guide')
  await waitUntil('saved repair to load in rich mode', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror')?.innerText.includes('guide') && !document.querySelector('.markdown-repair-banner'))`,
  ))
  await saveRepairScreenshot('markdown-repair-saved.png')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), repaired)
  assert.equal(workspacePutCount() - initialPuts, 1, 'reopening a repaired file must not save again')
})

test('a stale disk revision blocks repair and retains the confirmed candidate for conflict review', async () => {
  const fileName = 'safe-normalize-conflict.md'
  const original = '[guide][docs]\n\n[docs]: https://example.com\n'
  const external = 'External update\n'
  const repaired = '[guide](https://example.com)\n'
  await writeFile(path.join(workspace, fileName), original)
  await setupPage()
  await openFile(fileName, 'guide')
  await waitUntil('repair proposal to show before an external revision change', () => connection.evaluate(
    `Boolean(document.querySelector('.markdown-repair-banner'))`,
  ))
  await writeFile(path.join(workspace, fileName), external)
  const initialPuts = workspacePutCount()
  await clickRepairAction('确认修复并保存')
  await waitUntil('repair conflict to be reported', () => connection.evaluate(
    `Boolean(document.querySelector('.file-conflict-banner') && document.querySelector('.markdown-repair-result')?.innerText.includes('磁盘版本已变化'))`,
  ))
  assert.equal(workspacePutCount() - initialPuts, 1, 'the candidate must use one revision-checked save attempt')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), external, 'the concurrent disk version must remain intact')
  assert.equal(await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes('guide')`), true, 'the confirmed candidate should remain visible as the local draft')
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.markdown-repair-banner'))`), false)
})

test('closing during an immediate repair save waits for that save without issuing a duplicate PUT', async () => {
  const fileName = 'safe-normalize-close-in-flight.md'
  const original = '[guide][docs]\n\n[docs]: https://example.com\n'
  const repaired = '[guide](https://example.com)\n'
  await writeFile(path.join(workspace, fileName), original)
  await setupPage()
  await openFile(fileName, 'guide')
  await waitUntil('repair proposal before in-flight close', () => connection.evaluate(
    `Boolean(document.querySelector('.markdown-repair-banner'))`,
  ))

  await connection.send('Fetch.enable', { patterns: [{ urlPattern: '*api/workspace*', requestStage: 'Request' }] })
  connection.pauseNextWorkspacePut = true
  const initialPuts = workspacePutCount()
  await clickRepairAction('确认修复并保存')
  const pausedPut = await waitUntil('the immediate repair PUT to pause before reaching disk', () => (
    connection.pausedFetchRequests.find(item => item.request?.method === 'PUT' && item.request.url.includes('/api/workspace'))
  ))
  assert.equal(JSON.parse(pausedPut.request.postData || '{}').content, repaired)

  await connection.evaluate(`Array.from(document.querySelectorAll('.tab-close')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(`关闭 ${fileName}`)})?.click()`)
  assert.equal(await connection.evaluate(`Boolean(Array.from(document.querySelectorAll('.document-tab')).find(tab => tab.innerText.includes(${JSON.stringify(fileName)})))`), true, 'closing must wait while the confirmed save is in flight')
  await connection.send('Fetch.continueRequest', { requestId: pausedPut.requestId })

  await waitUntil('the tab to close after its repair save completes', () => connection.evaluate(
    `!Array.from(document.querySelectorAll('.document-tab')).some(tab => tab.innerText.includes(${JSON.stringify(fileName)}))`,
  ))
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), repaired)
  assert.equal(workspacePutCount() - initialPuts, 1, 'the close flush must not enqueue the already in-flight repair snapshot again')
  await connection.send('Fetch.disable')
})

test('ordinary delimiter-like text stays rich while angle autolinks get a repair diagnostic without writing', async () => {
  const plainName = 'colon-rule-text.md'
  const autolinkName = 'autolink-repair-smoke.md'
  const plainText = ':--- | plain text\n'
  const autolinkText = 'See <https://example.com>.\n'
  await writeFile(path.join(workspace, plainName), plainText)
  await writeFile(path.join(workspace, autolinkName), autolinkText)
  await setupPage()
  const initialPuts = workspacePutCount()

  await openFile(plainName, ':--- | plain text')
  await waitUntil('delimiter-like paragraph to remain in rich mode', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror')?.innerText.includes(':--- | plain text'))`,
  ))
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.source-fidelity-warning') || document.querySelector('.cm-protected-range'))`), false)

  await openFile(autolinkName, 'https://example.com')
  await waitUntil('angle autolink to be offered as a repair', () => connection.evaluate(
    `Boolean(document.querySelector('.markdown-repair-banner')?.innerText.includes('自动链接'))`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.markdown-repair-banner')?.innerText.includes('原始 HTML')`), false)
  await waitUntil('autolink diagnostic range to mount in the source editor', () => connection.evaluate(
    `Boolean(document.querySelector('.cm-protected-range'))`,
  ))
  const protectedBox = await connection.evaluate(`(() => { const box = document.querySelector('.cm-protected-range')?.getBoundingClientRect(); return box && { x: box.x + 4, y: box.y + box.height / 2 } })()`)
  assert.ok(protectedBox, 'the link source should have a focused diagnostic range')
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: protectedBox.x, y: protectedBox.y })
  await waitUntil('autolink tooltip to explain the repair', () => connection.evaluate(
    `Boolean(document.querySelector('.cm-tooltip-lint')?.innerText.includes('自动链接') && !document.querySelector('.cm-tooltip-lint')?.innerText.includes('原始 HTML'))`,
  ))

  const before = await stat(path.join(workspace, autolinkName))
  await new Promise(resolve => setTimeout(resolve, 3300))
  assert.equal(workspacePutCount(), initialPuts, 'opening an autolink repair proposal must not send a PUT')
  assert.equal(await readFile(path.join(workspace, plainName), 'utf8'), plainText)
  assert.equal(await readFile(path.join(workspace, autolinkName), 'utf8'), autolinkText)
  assert.equal((await stat(path.join(workspace, autolinkName))).mtimeMs, before.mtimeMs)
})

test('tab-indented unordered and nested ordered tasks are protected in source mode', async () => {
  const fileName = 'nested-tasks.md'
  const nestedTasks = '- Parent\n  1. [ ] Nested ordered task\n\t- [x] Tab-indented task\n'
  await writeFile(path.join(workspace, fileName), nestedTasks)
  await setupPage()
  await openFile(fileName, '- Parent')
  await waitUntil('nested task source protection', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content'))`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), nestedTasks)
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.ProseMirror'))`), false)
})

test('source-mode edits preserve the original Markdown bytes around the edit', async () => {
  const fileName = 'source-edit.md'
  await writeFile(path.join(workspace, fileName), fixture)
  await setupPage()
  await openFile(fileName)
  await waitUntil('Markdown source textarea', () => connection.evaluate(`Boolean(document.querySelector('.source-editor .cm-content'))`))

  const sourceBefore = await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`)
  assert.equal(sourceBefore, fixture, 'opening source mode should show the exact loaded Markdown')
  const marker = '\n\n<!-- SOURCE_EDIT_SENTINEL -->'
  await connection.evaluate(`(() => {
    const source = document.querySelector('.source-editor .cm-content');
    const view = source?.cmTile?.root?.view;
    view?.dispatch({ selection: { anchor: view.state.doc.length } });
    view?.focus();
    return Boolean(source);
  })()`)
  await connection.send('Input.insertText', { text: marker })
  await clickSave()
  const saved = await waitForDiskMarker(fileName, 'SOURCE_EDIT_SENTINEL')
  await waitUntil('source edit save acknowledgment before navigating to the next test', () => connection.evaluate(
    `document.querySelector('.save-status')?.innerText.includes('已保存') && !Array.from(document.querySelectorAll('.document-tab')).some(tab => tab.innerText.includes(${JSON.stringify(fileName)}) && tab.innerText.includes('未保存'))`,
  ))
  // Chrome's Input.insertText collapses one leading newline at the final
  // CodeMirror line. The loaded prefix must still remain byte-for-byte exact.
  assert.equal(saved.slice(0, fixture.length), fixture)
  assert.equal(saved.slice(fixture.length), '\n<!-- SOURCE_EDIT_SENTINEL -->')
})

test('nested Markdown images render through workspace media and stay relative through editing and upload', async () => {
  const fileName = 'docs/topic/relative-images.md'
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
  await mkdir(path.join(workspace, 'docs', 'topic'), { recursive: true })
  await mkdir(path.join(workspace, 'images'), { recursive: true })
  await mkdir(path.join(workspace, 'assets'), { recursive: true })
  await writeFile(path.join(workspace, 'images', '封 面.png'), imageBytes)
  await writeFile(path.join(workspace, 'assets', 'legacy.png'), imageBytes)
  const original = [
    '# MARKDOWN_IMAGE_FIXTURE',
    '',
    '![封面](../../images/封%20面.png "封面标题")',
    '',
    '![旧资源](/api/workspace/assets/legacy.png?workspaceId=old&workspaceVersion=2 "旧标题")',
    '',
    '![外链](https://example.com/external.png)',
    '',
    '![内嵌](data:image/png;base64,iVBORw0KGgo=)',
    '',
    '![越界](../../../outside.png "越界标题")',
    '',
    'Image fixture end.',
  ].join('\n')
  await writeFile(path.join(workspace, fileName), original)
  await setupPage()

  await waitUntil('docs folder in tree', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.ant-tree-title > div')).some(node => node.innerText.trim() === 'docs')`,
  ))
  await connection.evaluate(`document.querySelector('[aria-label="更多目录操作"]')?.click()`)
  await waitUntil('directory actions menu to open', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).some(node => node.innerText.trim() === '全部展开')`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(node => node.innerText.trim() === '全部展开')?.click()`)
  await waitUntil('nested Markdown file visible after expand all', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.ant-tree-title > div')).some(node => node.innerText.trim() === 'relative-images.md')`,
  ))
  await openFile('relative-images.md', 'MARKDOWN_IMAGE_FIXTURE')
  await waitUntil('relative image nodes in rich editor', () => connection.evaluate(
    `document.querySelectorAll('.ProseMirror img').length === 5`,
  ))
  const rendered = JSON.parse(await connection.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.ProseMirror img')).map(img => ({
    src: img.getAttribute('src'),
    markdownSrc: img.getAttribute('data-markdown-src'),
    title: img.getAttribute('data-markdown-title'),
  })))`))
  const activeWorkspace = JSON.parse(await connection.evaluate(`localStorage.getItem('editor_workspace_info')`))
  const identityQuery = `workspaceId=${encodeURIComponent(activeWorkspace.workspaceId)}&workspaceVersion=${activeWorkspace.workspaceVersion}`
  assert.equal(rendered[0].src, `/api/workspace/media/images/%E5%B0%81%20%E9%9D%A2.png?${identityQuery}`)
  assert.equal(rendered[0].markdownSrc, '../../images/%E5%B0%81%20%E9%9D%A2.png')
  assert.equal(rendered[0].title, '封面标题')
  assert.equal(rendered[1].src, `/api/workspace/media/assets/legacy.png?${identityQuery}`)
  assert.equal(rendered[1].markdownSrc, '../../assets/legacy.png')
  assert.equal(rendered[1].title, '旧标题')
  assert.equal(rendered[2].src, 'https://example.com/external.png')
  assert.equal(rendered[2].markdownSrc, null)
  assert.equal(rendered[3].src, 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(rendered[3].markdownSrc, null)
  assert.equal(rendered[4].src, 'about:blank')
  assert.equal(rendered[4].markdownSrc, '../../../outside.png')
  assert.equal(rendered[4].title, '越界标题')

  await connection.evaluate(`document.querySelector('[aria-label="源码"]')?.click()`)
  await waitUntil('nested source editor', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content'))`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), original)
  await connection.evaluate(`document.querySelector('[aria-label="编辑"]')?.click()`)
  await waitUntil('nested rich editor after source round trip', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror img[data-markdown-src="../../images/%E5%B0%81%20%E9%9D%A2.png"]'))`,
  ))

  const editMarker = ` IMAGE-EDIT-${Date.now()}`
  await appendToRichEditor(editMarker)
  await waitUntil('rich editor change to become dirty', () => connection.evaluate(
    `document.querySelector('.save-status')?.innerText.includes('修改待保存')`,
  ))
  await clickSave()
  try {
    await waitForDiskMarker(fileName, editMarker)
  } catch (error) {
    const editorState = await connection.evaluate(`JSON.stringify({
      source: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() || null,
      editorText: document.querySelector('.ProseMirror')?.innerText || null,
      saveStatus: document.querySelector('.save-status')?.innerText || null,
      saveButtonDisabled: document.querySelector('[aria-label="保存当前文件"]')?.disabled ?? null,
      activeTab: document.querySelector('.document-tabs .active')?.innerText || null,
    })`)
    const diskState = await readFile(path.join(workspace, fileName), 'utf8').catch(failure => `read failed: ${failure.message}`)
    throw new Error(`${error.message}\nEditor state: ${editorState}\nDisk state: ${diskState}`)
  }
  let saved = await readFile(path.join(workspace, fileName), 'utf8')
  assert.match(saved, /!\[封面\]\(\.\.\/\.\.\/images\/%E5%B0%81%20%E9%9D%A2\.png "封面标题"\)/)
  assert.match(saved, /!\[旧资源\]\(\.\.\/\.\.\/assets\/legacy\.png "旧标题"\)/)
  assert.match(saved, /!\[外链\]\(https:\/\/example\.com\/external\.png\)/)
  assert.match(saved, /!\[内嵌\]\(data:image\/png;base64,iVBORw0KGgo=\)/)
  assert.match(saved, /!\[越界\]\(\.\.\/\.\.\/\.\.\/outside\.png "越界标题"\)/)
  assert.doesNotMatch(saved, /\/api\/workspace\/(?:media|assets)\//)

  const uploadName = '新图片.png'
  const pickerTriggered = await connection.evaluate(`(() => {
    const input = document.querySelector('#img-up');
    input?.addEventListener('click', event => { event.preventDefault(); window.__imagePickerClicked = true }, { once: true });
    document.querySelector('.editor-toolbar [aria-label="上传图片"]')?.click();
    return Boolean(window.__imagePickerClicked);
  })()`)
  assert.equal(pickerTriggered, true, 'desktop image button must open the shared file input')
  await connection.evaluate(`(() => {
    const input = document.querySelector('#img-up');
    if (!input) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(${JSON.stringify([...imageBytes])})], ${JSON.stringify(uploadName)}, { type: 'image/png' }));
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  const imageInserted = await waitUntil('uploaded image inserted with a relative Markdown path', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror img[data-markdown-src="assets/%E6%96%B0%E5%9B%BE%E7%89%87.png"]'))`,
  ), 3000).catch(() => false)
  if (!imageInserted) {
    const uploadState = await connection.evaluate(`JSON.stringify({
      inputCount: document.querySelectorAll('#img-up').length,
      toast: document.querySelector('.ant-message')?.innerText || '',
      images: Array.from(document.querySelectorAll('.ProseMirror img')).map(img => img.getAttribute('data-markdown-src')),
    })`)
    const uploadedFiles = await readdir(path.join(workspace, 'docs', 'topic', 'assets')).catch(() => [])
    throw new Error(`Uploaded image was not inserted. UI: ${uploadState}; assets: ${uploadedFiles.join(', ')}`)
  }
  await waitUntil('uploaded image saved into the nested Markdown document', async () => {
    const content = await readFile(path.join(workspace, fileName), 'utf8').catch(() => '')
    return content.includes('assets/%E6%96%B0%E5%9B%BE%E7%89%87.png') ? content : null
  })
  saved = await readFile(path.join(workspace, fileName), 'utf8')
  assert.match(saved, /!\[[^\]]*\]\(assets\/%E6%96%B0%E5%9B%BE%E7%89%87\.png\)/)
  assert.deepEqual(await readFile(path.join(workspace, 'docs', 'topic', 'assets', uploadName)), imageBytes)
  assert.doesNotMatch(saved, /\/api\/workspace\/(?:media|assets)\//)

  await connection.evaluate(`document.querySelector('[aria-label="源码"]')?.click()`)
  await waitUntil('saved relative image Markdown in source mode', () => connection.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString().includes(${JSON.stringify('assets/%E6%96%B0%E5%9B%BE%E7%89%87.png')})`,
  ))
  const source = await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`)
  assert.match(source, /\.\.\/\.\.\/images\/%E5%B0%81%20%E9%9D%A2\.png "封面标题"/)
  assert.match(source, /\.\.\/\.\.\/assets\/legacy\.png "旧标题"/)
})

test('image width and alignment round-trip as adjacent portable metadata', async () => {
  const fileName = 'image-presentation.md'
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
  await mkdir(path.join(workspace, 'assets'), { recursive: true })
  await writeFile(path.join(workspace, 'assets', 'presentation.png'), bytes)
  await writeFile(path.join(workspace, fileName), '# Image presentation fixture\n\n![diagram](assets/presentation.png)<!-- se-image:width=50;align=center -->\n')
  await setupPage()
  await openFile(fileName, 'Image presentation fixture')
  await waitUntil('image presentation node', () => connection.evaluate(`Boolean(document.querySelector('.ProseMirror img'))`))
  const initial = await connection.evaluate(`(() => { const img = document.querySelector('.ProseMirror img'); return img && { width: img.getAttribute('data-image-width'), align: img.getAttribute('data-image-align'), style: img.getAttribute('style') } })()`)
  assert.equal(initial.width, '50')
  assert.equal(initial.align, 'center')
  assert.match(initial.style, /width:\s*50%/)
  assert.match(initial.style, /margin-left:\s*auto/)
  await connection.evaluate(`document.querySelector('.ProseMirror img')?.click()`)
  await waitUntil('image settings toolbar', () => connection.evaluate(`Boolean(document.querySelector('[aria-label="图片宽度 75%"]'))`))
  const handle = await waitUntil('image corner resize handle', () => connection.evaluate(`(() => { const box = document.querySelector('.image-resize-handle')?.getBoundingClientRect(); return box && { x: box.x + box.width / 2, y: box.y + box.height / 2 } })()`))
  await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 })
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + 40, y: handle.y, button: 'left', buttons: 1 })
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 40, y: handle.y, button: 'left', clickCount: 1 })
  await waitUntil('drag changes image width', () => connection.evaluate(`Number(document.querySelector('.ProseMirror img')?.getAttribute('data-image-width')) > 50`))
  await connection.evaluate(`document.querySelector('[aria-label="图片宽度 75%"]')?.click()`)
  await waitUntil('preset overrides drag width', () => connection.evaluate(`document.querySelector('.ProseMirror img')?.getAttribute('data-image-width') === '75'`))
  await clickSave()
  await waitForDiskMarker(fileName, '<!-- se-image:width=75;align=center -->')
  await waitUntil('image save acknowledgment', () => connection.evaluate(`document.querySelector('.save-status')?.innerText.includes('已保存')`))
  const saved = await readFile(path.join(workspace, fileName), 'utf8')
  assert.match(saved, /!\[diagram\]\(assets\/presentation\.png\)<!-- se-image:width=75;align=center -->/)
  await setupPage()
  await openFile(fileName, 'Image presentation fixture')
  await waitUntil('reopened image node', () => connection.evaluate(`Boolean(document.querySelector('.ProseMirror img'))`))
  const reopened = await connection.evaluate(`(() => { const img = document.querySelector('.ProseMirror img'); return img && { width: img.getAttribute('data-image-width'), align: img.getAttribute('data-image-align') } })()`)
  assert.deepEqual(reopened, { width: '75', align: 'center' }, `disk=${JSON.stringify(await readFile(path.join(workspace, fileName), 'utf8'))}`)
})

test('legacy zoom stays attached to the correct image even when paths repeat', async () => {
  const fileName = 'legacy-zoom.md'
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
  await mkdir(path.join(workspace, 'assets'), { recursive: true })
  await writeFile(path.join(workspace, 'assets', 'legacy.png'), bytes)
  await writeFile(path.join(workspace, fileName), '# Legacy zoom fixture\n\n![one](assets/legacy.png "title")<!-- zoom:175 --><!-- se-image:width=100;align=center -->\n\n![two](assets/legacy.png)\n')
  await setupPage()
  await openFile(fileName, 'Legacy zoom fixture')
  await waitUntil('legacy image nodes', () => connection.evaluate(`document.querySelectorAll('.ProseMirror img').length === 2`))
  const zooms = await connection.evaluate(`Array.from(document.querySelectorAll('.ProseMirror img')).map(img => img.getAttribute('data-legacy-zoom'))`)
  assert.deepEqual(zooms, ['175', null])
  assert.equal(await connection.evaluate(`document.querySelector('.ProseMirror img')?.getAttribute('data-image-align')`), 'center')
  await appendToRichEditor(' revised')
  await clickSave()
  await waitForDiskMarker(fileName, 'revised')
  const saved = await readFile(path.join(workspace, fileName), 'utf8')
  assert.match(saved, /!\[one\]\(assets\/legacy\.png "title"\)<!-- zoom:175 --><!-- se-image:width=100;align=center -->/)
  assert.match(saved, /!\[two\]\(assets\/legacy\.png\)/)
  assert.equal((saved.match(/<!-- zoom:175 -->/g) || []).length, 1)
})

test('table picker chooses dimensions and contextual tools add rows and columns', async () => {
  const fileName = 'table-controls.md'
  await writeFile(path.join(workspace, fileName), '# Table controls fixture\n')
  await setupPage()
  await openFile(fileName, 'Table controls fixture')
  await connection.evaluate(`document.querySelector('.editor-toolbar [aria-label="插入表格"]')?.click()`)
  await waitUntil('table dimensions grid', () => connection.evaluate(`Boolean(document.querySelector('[aria-label="4 行 5 列"]'))`))
  await connection.evaluate(`document.querySelector('[aria-label="4 行 5 列"]')?.click()`)
  await waitUntil('4 by 5 table', () => connection.evaluate(`document.querySelectorAll('.ProseMirror table tr').length === 4 && document.querySelectorAll('.ProseMirror table tr:first-child > *').length === 5`))
  await connection.evaluate(`document.querySelector('.ProseMirror table tr:nth-child(2) td')?.click()`)
  await waitUntil('table contextual toolbar', () => connection.evaluate(`Boolean(document.querySelector('[aria-label="下方增行"]'))`))
  await connection.evaluate(`document.querySelector('[aria-label="下方增行"]')?.click()`)
  await connection.evaluate(`document.querySelector('[aria-label="右侧增列"]')?.click()`)
  await waitUntil('expanded table', () => connection.evaluate(`document.querySelectorAll('.ProseMirror table tr').length === 5 && document.querySelectorAll('.ProseMirror table tr:first-child > *').length === 6`))
  await clickSave()
  await waitUntil('table Markdown persisted', async () => {
    const content = await readFile(path.join(workspace, fileName), 'utf8')
    return content.split('\n').filter(line => line.startsWith('|')).length === 6
  })
})

test('mobile directory keeps long nested filenames inside its frame', async () => {
  const folder = 'a-very-long-folder-name-that-needs-to-stay-inside-the-mobile-directory'
  const fileName = 'a-very-long-markdown-filename-that-should-not-escape-the-directory-panel.md'
  await mkdir(path.join(workspace, folder), { recursive: true })
  await writeFile(path.join(workspace, folder, fileName), '# Long mobile filename\n')
  await Promise.all(Array.from({ length: 24 }, (_, index) => writeFile(path.join(workspace, `zz-mobile-list-${index}.md`), '# Mobile list fixture\n')))
  await connection.send('Emulation.setDeviceMetricsOverride', { width: 1195, height: 751, deviceScaleFactor: 1, mobile: false })
  await setupPage()
  try {
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
    await waitUntil('mobile editor layout', () => connection.evaluate(`!document.querySelector('.workspace-sidebar') && Boolean(document.querySelector('.empty-editor [aria-label="打开目录"]'))`))
    await connection.evaluate(`document.querySelector('.empty-editor [aria-label="打开目录"]')?.click()`)
    await waitUntil('mobile directory panel', () => connection.evaluate(`Boolean(document.querySelector('.mobile-workspace-modal .ant-modal-body'))`))
    await waitUntil('long folder in mobile directory', () => connection.evaluate(`document.querySelector('.mobile-workspace-modal .ant-tree')?.innerText.includes(${JSON.stringify(folder)})`))
    await connection.evaluate(`document.querySelector('.mobile-workspace-modal [aria-label="全部展开"]')?.click()`)
    await waitUntil('nested mobile file row', () => connection.evaluate(`document.querySelector('.mobile-workspace-modal .ant-tree')?.innerText.includes(${JSON.stringify(fileName)})`))
    await new Promise(resolve => setTimeout(resolve, 300))
    const layout = await connection.evaluate(`(() => {
      const panel = document.querySelector('.mobile-workspace-modal .ant-modal-body');
      const tree = panel?.querySelector('.ant-tree');
      const rows = Array.from(tree?.querySelectorAll('.ant-tree-treenode') || []);
      const edge = panel.getBoundingClientRect().right;
      return {
        panelWidth: panel.clientWidth,
        panelRight: edge,
        treeScrollWidth: tree.scrollWidth,
        treeClientWidth: tree.clientWidth,
        treeScrollHeight: tree.scrollHeight,
        treeClientHeight: tree.clientHeight,
        maxRowRight: Math.max(...rows.map(row => row.getBoundingClientRect().right)),
      };
    })()`)
    if (process.env.EDITOR_MOBILE_OVERFLOW_DIR) {
      await mkdir(process.env.EDITOR_MOBILE_OVERFLOW_DIR, { recursive: true })
      const frame = await connection.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      await writeFile(path.join(process.env.EDITOR_MOBILE_OVERFLOW_DIR, 'mobile-directory-320.png'), Buffer.from(frame.data, 'base64'))
    }
    assert.ok(layout.maxRowRight <= layout.panelRight + 1, `directory rows must stay inside the mobile panel: ${JSON.stringify(layout)}`)
    assert.ok(layout.treeScrollWidth <= layout.treeClientWidth + 1, `tree content overflows: ${JSON.stringify(layout)}`)
    assert.ok(layout.treeScrollHeight > layout.treeClientHeight, 'long directory should scroll inside the modal')
  } finally {
    await connection.send('Emulation.setDeviceMetricsOverride', { width: 1195, height: 751, deviceScaleFactor: 1, mobile: false })
    await rm(path.join(workspace, folder), { recursive: true, force: true })
    await Promise.all(Array.from({ length: 24 }, (_, index) => rm(path.join(workspace, `zz-mobile-list-${index}.md`), { force: true })))
  }
})

test('mobile image action opens the same file input', async () => {
  const fileName = 'mobile-image.md'
  await writeFile(path.join(workspace, fileName), '# Mobile image fixture\n')
  await setupPage()
  await openFile(fileName, 'Mobile image fixture')
  await connection.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await waitUntil('mobile format menu', () => connection.evaluate(`Boolean(document.querySelector('[aria-label="更多格式"]'))`))
  await connection.evaluate(`(() => { document.querySelector('#img-up')?.addEventListener('click', event => { event.preventDefault(); window.__mobileImagePickerClicked = true }, { once: true }); document.querySelector('[aria-label="更多格式"]')?.click() })()`)
  await waitUntil('mobile upload item', () => connection.evaluate(`Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).some(item => item.innerText.includes('上传图片'))`))
  await connection.evaluate(`Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(item => item.innerText.includes('上传图片'))?.click()`)
  assert.equal(await connection.evaluate(`Boolean(window.__mobileImagePickerClicked)`), true)
})

test('visual review snapshots on isolated workspace', { skip: !process.env.EDITOR_REVIEW_DIR }, async () => {
  const fileName = 'visual-review.md'
  await writeFile(path.join(workspace, fileName), '# Quiet writing workspace\n\nA focused paragraph with **emphasis** and a [link](https://example.com).\n\n```js\nconst note = "A quiet place to think"\nconsole.log(note)\n```\n\n## Document structure\n\n- First idea\n- Second idea\n\n| Column | Detail |\n| --- | --- |\n| One | Two |\n')
  await mkdir(process.env.EDITOR_REVIEW_DIR, { recursive: true })
  await setupPage()
  await openFile(fileName, 'Quiet writing workspace')
  for (const [width, height, dark] of [[1440, 900, false], [1195, 751, true], [768, 900, false], [390, 844, true]]) {
    await connection.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 769 })
    await connection.evaluate(`(() => {
      const dark = ${dark};
      const label = dark ? '切换到深色模式' : '切换到浅色模式';
      document.querySelector('[aria-label="' + label + '"]')?.click();
    })()`)
    await new Promise(resolve => setTimeout(resolve, 200))
    const screenshot = await connection.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(path.join(process.env.EDITOR_REVIEW_DIR, `${width}-${dark ? 'dark' : 'light'}.png`), Buffer.from(screenshot.data, 'base64'))
  }
})

test('interactive visual review of source, table and image controls', { skip: !process.env.EDITOR_REVIEW_INTERACTION_DIR }, async () => {
  const directory = process.env.EDITOR_REVIEW_INTERACTION_DIR
  await mkdir(directory, { recursive: true })
  const screenshot = async name => {
    await new Promise(resolve => setTimeout(resolve, 180))
    const frame = await connection.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(path.join(directory, name), Buffer.from(frame.data, 'base64'))
  }

  await writeFile(path.join(workspace, 'review-source.md'), '---\ntitle: Review\n---\n\nSee [[Home]] and [guide][docs].\n\n[docs]: https://example.com\n')
  await setupPage()
  await openFile('review-source.md', 'title: Review')
  await waitUntil('source annotations', () => connection.evaluate(`document.querySelectorAll('.cm-protected-range').length >= 2`))
  await connection.evaluate(`document.querySelector('[aria-label="切换到深色模式"]')?.click()`)
  await screenshot('source-protection-dark.png')
  await connection.evaluate(`document.querySelector('[aria-label="跳转到下一个受保护位置"]')?.click()`)
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.source-editor .cm-content'))`), true)

  await writeFile(path.join(workspace, 'review-table.md'), '# Review table\n')
  await setupPage()
  await openFile('review-table.md', 'Review table')
  await connection.evaluate(`document.querySelector('[aria-label="切换到浅色模式"]')?.click()`)
  await connection.evaluate(`document.querySelector('.editor-toolbar [aria-label="插入表格"]')?.click()`)
  await waitUntil('table picker visible', () => connection.evaluate(`Boolean(document.querySelector('.table-insert-panel'))`))
  await screenshot('table-picker-light.png')

  await mkdir(path.join(workspace, 'assets'), { recursive: true })
  await writeFile(path.join(workspace, 'assets', 'review.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64'))
  await writeFile(path.join(workspace, 'review-image.md'), '# Review image\n\n![diagram](assets/review.png)<!-- se-image:width=75;align=center -->\n')
  await setupPage()
  await openFile('review-image.md', 'Review image')
  await connection.evaluate(`document.querySelector('[aria-label="切换到浅色模式"]')?.click()`)
  await waitUntil('image visible', () => connection.evaluate(`Boolean(document.querySelector('.ProseMirror img'))`))
  await connection.evaluate(`document.querySelector('.ProseMirror img')?.click()`)
  await waitUntil('image controls visible', () => connection.evaluate(`Boolean(document.querySelector('.image-context-tools'))`))
  await screenshot('image-controls-light.png')
  await connection.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  const positions = await waitUntil('mobile resize handle aligned with image corner', () => connection.evaluate(`(() => {
    const image = document.querySelector('.ProseMirror img')?.getBoundingClientRect();
    const handle = document.querySelector('.image-resize-handle')?.getBoundingClientRect();
    if (!image || !handle) return null;
    return Math.abs(image.right - handle.right) < 24 && Math.abs(image.bottom - handle.bottom) < 24;
  })()`))
  assert.equal(positions, true)
  await screenshot('image-controls-mobile.png')
})
