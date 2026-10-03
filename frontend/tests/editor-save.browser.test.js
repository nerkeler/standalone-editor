import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { after, afterEach, before, beforeEach } from 'node:test'
import { cleanupBrowserTest } from './helpers/browser-cleanup.js'
import { startChrome as startChromeProcess } from './helpers/chrome-startup.js'
import { createZip } from '../../backend/test/zipFixture.js'

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
let workspaceB
let frontendPort
let backendPort
let frontendProcess
let backendProcess
let chromeProcess
let cdp
let chromeDebugPort
const cdpConnections = new Set()
const transientTargets = new Map()
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
    this.networkRequests = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data.toString())
      if (!message.id) {
        if (message.method === 'Network.requestWillBeSent') {
          const request = message.params.request || {}
          this.networkRequests.push({ method: request.method, url: request.url, postData: request.postData || '' })
        }
        if (message.method === 'Runtime.exceptionThrown') {
          appendLog('browser exception', message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
        }
        if (message.method === 'Log.entryAdded') {
          appendLog('browser log', `${message.params.entry.level}: ${message.params.entry.text}`)
        }
        if (message.method === 'Page.javascriptDialogOpening' && message.params.type === 'beforeunload') {
          this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
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
      const timeoutId = setTimeout(() => {
        socket.close()
        reject(new Error('Timed out connecting to Chrome DevTools WebSocket'))
      }, 10000)
      const onOpen = () => {
        clearTimeout(timeoutId)
        socket.removeEventListener('error', onError)
        resolve()
      }
      const onError = event => {
        clearTimeout(timeoutId)
        socket.removeEventListener('open', onOpen)
        reject(event)
      }
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
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
  const started = await startChromeProcess({ chromePath: chrome, profileDir: chromeProfile })
  chromeProcess = started.child
  chromeDebugPort = started.port
  const response = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/new?about:blank`, { method: 'PUT' })
  assert.equal(response.ok, true, 'Chrome should create an isolated page target')
  const target = await response.json()
  targetId = target.id
  cdp = await DevToolsConnection.connect(target.webSocketDebuggerUrl)
  cdpConnections.add(cdp)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Network.enable')
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

async function pageIsReady(connection = cdp) {
  return connection.evaluate(`Boolean(document.querySelector('.workspace-sidebar') && document.querySelector('.tree-scroll'))`)
}

async function openFile(fileName, expectedText, connection = cdp) {
  await waitUntil(`${fileName} in file tree`, () => connection.evaluate(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(node => node.innerText.trim() === ${JSON.stringify(fileName)})`))
  await connection.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(fileName)});
    node?.click();
    return Boolean(node);
  })()`)
  await waitUntil(`${fileName} content`, () => connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString().includes(${JSON.stringify(expectedText)}) || document.querySelector('.ProseMirror[contenteditable="true"]')?.innerText.includes(${JSON.stringify(expectedText)})`))
}

async function insertAtDocumentEnd(text, connection = cdp) {
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

async function insertAtSourceEnd(text, connection = cdp) {
  await connection.evaluate(`document.querySelector('[aria-label="切换到源码编辑"]')?.click()`)
  await waitUntil('Markdown source textarea to open', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content'))`,
  ))
  await connection.evaluate(`(() => {
    const source = document.querySelector('.source-editor .cm-content');
    const view = source?.cmTile?.root?.view;
    view?.dispatch({ selection: { anchor: view.state.doc.length } });
    view?.focus();
    return Boolean(source);
  })()`)
  await connection.send('Input.insertText', { text })
  await waitUntil('Markdown source edit to reach the textarea', () => connection.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString().includes(${JSON.stringify(text)})`,
  ))
}

async function clickVisibleButton(text, connection = cdp) {
  await waitUntil(`button “${text}”`, () => connection.evaluate(
    `Array.from(document.querySelectorAll('button')).some(button => button.innerText.trim() === ${JSON.stringify(text)} && !button.disabled && button.getBoundingClientRect().width > 0)`,
  ))
  await connection.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(item => item.innerText.trim() === ${JSON.stringify(text)} && !item.disabled && item.getBoundingClientRect().width > 0);
    button?.click();
    return Boolean(button);
  })()`)
}

async function clickAriaButton(label, connection = cdp) {
  await waitUntil(`button with aria-label “${label}”`, () => connection.evaluate(
    `Boolean(document.querySelector('button[aria-label="${label}"]') && document.querySelector('button[aria-label="${label}"]').getBoundingClientRect().width > 0)`,
  ))
  await connection.evaluate(`document.querySelector('button[aria-label="${label}"]')?.click()`)
}

async function clickExactAriaButton(label, connection = cdp) {
  await waitUntil(`button with aria-label “${label}”`, () => connection.evaluate(
    `Array.from(document.querySelectorAll('button')).some(button => button.getAttribute('aria-label') === ${JSON.stringify(label)} && button.getBoundingClientRect().width > 0)`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)} && button.getBoundingClientRect().width > 0)?.click()`)
}

async function cancelVisibleConfirmation(connection = cdp) {
  await waitUntil('confirmation cancel action', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.ant-modal-confirm')).some(dialog => {
      const style = getComputedStyle(dialog);
      return dialog.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && Array.from(dialog.querySelectorAll('.ant-modal-confirm-btns button')).some(button => !button.classList.contains('ant-btn-primary'));
    })`,
  ))
  await connection.evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('.ant-modal-confirm')).filter(dialog => {
      const style = getComputedStyle(dialog);
      return dialog.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
    });
    const dialog = dialogs[dialogs.length - 1];
    const cancel = Array.from(dialog?.querySelectorAll('.ant-modal-confirm-btns button') || []).find(button => !button.classList.contains('ant-btn-primary'));
    cancel?.click();
    return Boolean(cancel);
  })()`)
}

async function hasVisibleConfirmation(connection = cdp) {
  return connection.evaluate(`Array.from(document.querySelectorAll('.ant-modal-confirm')).some(dialog => {
    const style = getComputedStyle(dialog);
    return dialog.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
  })`)
}

async function clickConfirmButton(text, connection = cdp) {
  await waitUntil(`confirmation button “${text}”`, () => connection.evaluate(`Array.from(document.querySelectorAll('.ant-modal-confirm')).some(dialog => {
    const style = getComputedStyle(dialog);
    return dialog.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && Array.from(dialog.querySelectorAll('button')).some(button => button.innerText.trim() === ${JSON.stringify(text)} && !button.disabled);
  })`))
  await connection.evaluate(`(() => {
    const dialogs = Array.from(document.querySelectorAll('.ant-modal-confirm')).filter(dialog => {
      const style = getComputedStyle(dialog);
      return dialog.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
    });
    const dialog = dialogs[dialogs.length - 1];
    const button = Array.from(dialog?.querySelectorAll('button') || []).find(item => item.innerText.trim() === ${JSON.stringify(text)} && !item.disabled);
    button?.click();
    return Boolean(button);
  })()`)
}

async function clickMenuItem(text, connection = cdp) {
  await waitUntil(`menu item “${text}”`, () => connection.evaluate(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).some(item => item.innerText.includes(${JSON.stringify(text)}))`,
  ))
  await connection.evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(node => node.innerText.includes(${JSON.stringify(text)}));
    item?.click();
    return Boolean(item);
  })()`)
}

async function openImportDialog(connection = cdp) {
  await clickAriaButton('更多目录操作', connection)
  await clickMenuItem('导入文件', connection)
  await waitForImportDialogSettled(connection)
}

async function waitForImportDialogSettled(connection = cdp) {
  await waitUntil('ZIP import dialog to become visible and settled', () => connection.evaluate(`(() => {
    const content = document.querySelector('.import-modal-content');
    const wrap = content?.closest('.ant-modal-wrap');
    const modal = content?.closest('.ant-modal');
    if (!content || !wrap || !modal) return false;
    const wrapStyle = getComputedStyle(wrap);
    const modalStyle = getComputedStyle(modal);
    const runningAnimations = wrap.getAnimations({ subtree: true }).some(animation => animation.playState === 'running' || animation.pending);
    const modalRect = modal.getBoundingClientRect();
    return modalRect.width > 0 && modalRect.height > 0 && wrapStyle.display !== 'none' && wrapStyle.visibility !== 'hidden' &&
      Number(wrapStyle.opacity || 1) >= 0.99 && Number(modalStyle.opacity || 1) >= 0.99 && !runningAnimations;
  })()`))
}

async function chooseImportArchive(fileName, archive, connection = cdp) {
  await connection.evaluate(`(() => {
    const input = document.querySelector('.import-modal-content #import-zip-input');
    if (!input) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(${JSON.stringify([...archive])})], ${JSON.stringify(fileName)}, { type: 'application/zip' }));
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
}

async function moveFileToTrash(fileName, connection = cdp) {
  await waitUntil(`${fileName} in the file tree before trashing`, () => connection.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(fileName)})`,
  ))
  await connection.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(fileName)});
    node?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    return Boolean(node);
  })()`)
  await waitUntil(`${fileName} context menu to open`, () => connection.evaluate(`Array.from(document.querySelectorAll('.editor-context-menu [role="menuitem"]')).some(item => item.innerText.includes('移入回收站'))`))
  await connection.evaluate(`(() => {
    const action = Array.from(document.querySelectorAll('.editor-context-menu [role="menuitem"]')).find(item => item.innerText.trim() === '移入回收站' && item.getBoundingClientRect().width > 0);
    action?.click();
    return Boolean(action);
  })()`)
  await clickVisibleButton('移入回收站', connection)
  await waitUntil(`${fileName} to leave the workspace tree`, () => connection.evaluate(
    `!Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(fileName)})`,
  ))
  await waitUntil(`${fileName} move confirmation to close`, async () => !await hasVisibleConfirmation(connection))
}

async function readWorkspaceHistory(fileName, connection = cdp) {
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

async function readWorkspaceRecoveryStats(connection = cdp) {
  return connection.evaluate(`(async () => {
    const info = JSON.parse(localStorage.getItem('editor_workspace_info') || 'null');
    const response = await fetch('/api/workspace/recovery/stats', { headers: {
      'X-Workspace-Id': info?.workspaceId || '',
      'X-Workspace-Version': String(info?.workspaceVersion ?? ''),
    }});
    return { status: response.status, data: await response.json() };
  })()`)
}

async function openTrash(connection = cdp) {
  await clickAriaButton('更多目录操作', connection)
  await clickMenuItem('回收站', connection)
  await waitUntil('trash modal to open', () => connection.evaluate(`Boolean(document.querySelector('.ant-modal')?.innerText.includes('回收站'))`))
}

function formatDisplayedBytes(value) {
  const bytes = Number(value)
  if (bytes < 1024) return `${bytes.toLocaleString()} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = bytes
  let unitIndex = -1
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024
    unitIndex += 1
  }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unitIndex]}`
}

async function switchWorkspace(targetDirectoryName) {
  await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === '更改目录' && item.getBoundingClientRect().width > 0);
    button?.click();
  })()`)
  await clickVisibleButton('选择工作目录')
  await waitUntil('directory picker to open', () => cdp.evaluate(`Boolean(document.querySelector('.ant-modal-body'))`))
  const pickerState = await cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes('选择工作目录'));
    const body = modal?.querySelector('.ant-modal-body');
    const target = ${JSON.stringify(targetDirectoryName)};
    const listed = Array.from(body?.querySelectorAll('.welcome-directory-entry') || []).some(item => item.innerText.trim() === target);
    const rootButton = Array.from(body?.querySelectorAll('button[title]') || []).find(button => !button.classList.contains('welcome-directory-entry') && button.innerText.trim() === target);
    const back = Array.from(body?.querySelectorAll('button') || []).find(button => button.innerText.trim() === '返回');
    const currentName = Array.from(body?.querySelectorAll('.ant-breadcrumb-link') || []).at(-1)?.innerText.trim() || '';
    return { listed, rootButton: Boolean(rootButton), currentName, canGoUp: Boolean(back && !back.disabled) };
  })()`)
  let selectedRoot = pickerState.currentName === targetDirectoryName
  if (!pickerState.listed && pickerState.rootButton) {
    await cdp.evaluate(`(() => {
      const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes('选择工作目录'));
      const body = modal?.querySelector('.ant-modal-body');
      const button = Array.from(body?.querySelectorAll('button[title]') || []).find(item => item.innerText.trim() === ${JSON.stringify(targetDirectoryName)});
      button?.click();
      return Boolean(button);
    })()`)
    selectedRoot = true
    await waitUntil(`${targetDirectoryName} root to open in picker`, () => cdp.evaluate(
      `document.querySelector('.ant-modal .ant-breadcrumb')?.innerText.includes(${JSON.stringify(targetDirectoryName)})`,
    ))
  } else if (!pickerState.listed && pickerState.canGoUp) {
    await clickVisibleButton('返回')
  }
  if (!selectedRoot) {
    await waitUntil(`${targetDirectoryName} directory in picker`, () => cdp.evaluate(
      `Array.from(document.querySelectorAll('.workspace-picker-modal .welcome-directory-entry')).some(item => item.innerText.trim() === ${JSON.stringify(targetDirectoryName)})`,
    ))
    await cdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.workspace-picker-modal .welcome-directory-entry')).find(item => item.innerText.trim() === ${JSON.stringify(targetDirectoryName)});
      row?.click();
      return Boolean(row);
    })()`)
    await waitUntil(`${targetDirectoryName} selected in picker`, () => cdp.evaluate(
      `document.querySelector('.ant-breadcrumb')?.innerText.includes(${JSON.stringify(targetDirectoryName)}) && !Array.from(document.querySelectorAll('button')).find(item => item.innerText.trim() === '确认选择')?.disabled`,
    ))
  }
  await clickVisibleButton('确认选择')
  await waitUntil(`${targetDirectoryName} workspace to load`, () => cdp.evaluate(`(() => {
    const info = JSON.parse(localStorage.getItem('editor_workspace_info') || 'null');
    const currentName = String(info?.workspace || '').replace(/\\\\/g, '/').split('/').pop();
    return currentName === ${JSON.stringify(targetDirectoryName)} && Boolean(document.querySelector('.workspace-sidebar') && document.querySelector('.tree-scroll'));
  })()`), 12000)
}

async function setupPage(connection = cdp) {
  const url = `http://127.0.0.1:${frontendPort}/`
  const currentURL = await connection.evaluate('location.href').catch(() => '')
  if (currentURL !== url) await connection.send('Page.navigate', { url })
  try {
    await waitUntil('editor application to mount', () => pageIsReady(connection))
  } catch (error) {
    const state = await connection.evaluate(`JSON.stringify({ url: location.href, title: document.title, body: document.body?.innerText, html: document.body?.innerHTML?.slice(0, 1000) })`).catch(err => `inspection failed: ${err.message}`)
    throw new Error(`${error.message}\nBrowser state: ${state}`)
  }
}

async function createPageTarget({ sessionId, drafts = {}, freshStorage = false } = {}) {
  const response = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/new?about:blank`, { method: 'PUT' })
  assert.equal(response.ok, true, 'Chrome should create another isolated page target')
  const target = await response.json()
  const connection = await DevToolsConnection.connect(target.webSocketDebuggerUrl)
  cdpConnections.add(connection)
  transientTargets.set(target.id, connection)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')
  await connection.send('Log.enable')
  await connection.send('Network.enable')
  const realWorkspace = await realpath(workspace)
  const info = {
    workspace: realWorkspace,
    workspaceId: createHash('sha256').update(realWorkspace).digest('hex').slice(0, 24),
    workspaceVersion: 1,
  }
  const serializedInfo = JSON.stringify(info)
  const storageSetup = [
    freshStorage ? 'localStorage.clear(); sessionStorage.clear();' : '',
    `localStorage.setItem('editor_workspace_info', ${JSON.stringify(serializedInfo)});`,
    `localStorage.setItem('editor_workspace', ${JSON.stringify(realWorkspace)});`,
    sessionId ? `sessionStorage.setItem('editor_draft_tab_session', ${JSON.stringify(sessionId)});` : '',
    ...Object.entries(drafts).map(([key, value]) => `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(value))});`),
  ].filter(Boolean).join('\n')
  await connection.send('Page.addScriptToEvaluateOnNewDocument', {
    source: storageSetup,
  })
  connection.targetId = target.id
  return connection
}

function promoteTarget(connection) {
  for (const [id, value] of transientTargets) {
    if (value === connection) {
      targetId = id
      transientTargets.delete(id)
    }
  }
}

before(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-save-test-'))
  workspace = path.join(tempRoot, 'notes')
  workspaceB = path.join(tempRoot, 'workspace-b')
  await mkdir(workspace, { recursive: true })
  await mkdir(workspaceB, { recursive: true })
  await writeFile(path.join(workspace, firstFile), firstSeed)
  await writeFile(path.join(workspace, secondFile), secondSeed)
  await writeFile(path.join(workspaceB, firstFile), 'Workspace B seed')
  const cleanupFailureShim = path.join(tempRoot, 'zip-import-cleanup-shim.mjs')
  const staleImportMarker = path.join(tempRoot, 'stale-import-cleanup')
  await writeFile(cleanupFailureShim, `
import fs from 'node:fs/promises'
import path from 'node:path'
const workspace = await fs.realpath(process.env.EDITOR_DEFAULT_WORKSPACE)
const originalUnlink = fs.unlink.bind(fs)
const originalReaddir = fs.readdir.bind(fs)
const originalStat = fs.stat.bind(fs)
let delayedStaleImport = false
let failedTreeRefresh = false
fs.unlink = async target => {
  const candidate = path.resolve(String(target))
  if (!candidate.startsWith(workspace + path.sep) || !candidate.includes('.standalone-editor-import-')) {
    return originalUnlink(target)
  }
  if (candidate.includes('界面告警') && !candidate.includes('.rollback-')) {
    const error = new Error('simulated ZIP staging cleanup permission error')
    error.code = 'EACCES'
    throw error
  }
  if (!delayedStaleImport && candidate.includes('stale-switch.md') && !candidate.includes('.rollback-')) {
    delayedStaleImport = true
    const marker = process.env.EDITOR_TEST_STALE_IMPORT_MARKER
    await fs.writeFile(marker + '.started', 'started')
    const deadline = Date.now() + 30_000
    let released = false
    while (Date.now() < deadline) {
      try {
        await fs.access(marker + '.release')
        released = true
        break
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (!released) throw new Error('test did not release the delayed ZIP cleanup')
    await fs.writeFile(marker + '.done', 'done')
  }
  return originalUnlink(target)
}
fs.readdir = async (target, options) => {
  const candidate = path.resolve(String(target))
  if (!failedTreeRefresh && candidate === workspace) {
    try {
      await originalStat(path.join(workspace, 'tree-refresh-error.md'))
      failedTreeRefresh = true
      const error = new Error('simulated directory refresh permission error')
      error.code = 'EACCES'
      throw error
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return originalReaddir(target, options)
}
`)
  backendPort = await freePort()
  frontendPort = await freePort()

  const sharedEnv = { ...process.env }
  backendProcess = startProcess('backend', process.execPath, [backendEntry, '--workspace', workspace], {
    ...sharedEnv,
    PORT: String(backendPort),
    EDITOR_PORT: String(backendPort),
    FRONTEND_PORT: String(frontendPort),
    WORKSPACE_CONFIG_FILE: path.join(tempRoot, 'workspace-config.json'),
    EDITOR_RECOVERY_DIR: path.join(tempRoot, 'recovery'),
    EDITOR_DIRECTORY_ROOTS: tempRoot,
    EDITOR_DEFAULT_WORKSPACE: workspace,
    EDITOR_TEST_STALE_IMPORT_MARKER: staleImportMarker,
    ALLOW_ANY_WORKSPACE: '1',
    HOST: '127.0.0.1',
    NODE_OPTIONS: [process.env.NODE_OPTIONS || '', `--import=${pathToFileURL(cleanupFailureShim).href}`].filter(Boolean).join(' '),
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
  await writeFile(path.join(workspaceB, firstFile), 'Workspace B seed')
  // Use a fresh renderer for every test. A previous test may leave a dirty
  // editor that writes its recovery snapshot during unmount; injecting a
  // clean origin store into the new target isolates each interaction.
  if (cdp && targetId) {
    await cdp.send('Page.close').catch(() => {})
    cdp.close()
    cdpConnections.delete(cdp)
    await fetch(`http://127.0.0.1:${chromeDebugPort}/json/close/${targetId}`).catch(() => {})
  }
  cdp = await createPageTarget({ freshStorage: true })
  promoteTarget(cdp)
  await setupPage()
})

afterEach(async () => {
  for (const [id, connection] of transientTargets) {
    connection.close()
    cdpConnections.delete(connection)
    await fetch(`http://127.0.0.1:${chromeDebugPort}/json/close/${id}`).catch(() => {})
  }
  transientTargets.clear()
})

after(async () => {
  await cleanupBrowserTest({
    browser: { child: chromeProcess, port: chromeDebugPort },
    connections: [...cdpConnections],
    children: [frontendProcess, backendProcess],
    tempRoot,
  })
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

test('ZIP import cleanup warnings remain visible, readable on a narrow screen, and dismissible', { timeout: 75_000 }, async t => {
  const importEntries = Array.from({ length: 8 }, (_, index) => ({
    name: `界面告警/深层中文资料目录/这是一条用于窄屏自动换行和滚动验收的长中文Markdown文件名-${String(index + 1).padStart(2, '0')}.md`,
    data: `# Import warning fixture ${index + 1}`,
  }))
  const archive = createZip(importEntries)
  const screenshotDirectory = process.env.EDITOR_REVIEW_INTERACTION_DIR || os.tmpdir()

  await cdp.evaluate(`document.querySelector('button[aria-label="切换到深色模式"]')?.click()`)
  await waitUntil('dark theme to be applied', () => cdp.evaluate(`document.documentElement.dataset.theme === 'dark'`))
  await openImportDialog()
  await cdp.send('Page.bringToFront')
  await waitUntil('browser page to receive keyboard focus', () => cdp.evaluate(`document.hasFocus()`))
  let pickerFocused = false
  const pickerFocusTrace = []
  for (let attempt = 0; attempt < 8 && !pickerFocused; attempt += 1) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    pickerFocusTrace.push(await cdp.evaluate(`(() => {
      const active = document.activeElement;
      return { tagName: active?.tagName, className: active?.className, ariaLabel: active?.getAttribute('aria-label'), text: active?.textContent?.trim().slice(0, 50), inDialog: Boolean(active?.closest('.ant-modal')) };
    })()`))
    pickerFocused = await cdp.evaluate(`document.activeElement === document.querySelector('.import-file-picker')`)
  }
  const pickerState = await cdp.evaluate(`(() => {
    const picker = document.querySelector('.import-file-picker');
    return {
      tagName: picker?.tagName,
      tabIndex: picker?.tabIndex,
      documentFocused: document.hasFocus(),
      focused: document.activeElement === picker,
      focusVisible: picker?.matches(':focus-visible'),
      outline: getComputedStyle(picker).outlineStyle,
      background: getComputedStyle(picker).backgroundColor,
    };
  })()`)
  assert.equal(pickerState.tagName, 'BUTTON')
  assert.equal(pickerState.tabIndex, 0)
  assert.equal(pickerState.documentFocused, true)
  assert.equal(pickerFocused && pickerState.focused, true, JSON.stringify({ pickerState, pickerFocusTrace }))
  assert.equal(pickerState.focusVisible, true)
  assert.notEqual(pickerState.outline, 'none', JSON.stringify(pickerState))
  const pickerScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await mkdir(screenshotDirectory, { recursive: true })
  const pickerScreenshotPath = path.join(screenshotDirectory, 'standalone-editor-import-picker-dark.png')
  await writeFile(pickerScreenshotPath, Buffer.from(pickerScreenshot.data, 'base64'))

  await chooseImportArchive('cleanup-warning.zip', archive)
  await waitUntil('successful import and retained staging warning', () => cdp.evaluate(`(() => {
    const warning = document.querySelector('.import-cleanup-warning');
    return Boolean(warning && warning.innerText.includes('无法安全清理') &&
      warning.querySelectorAll('.import-cleanup-warning-paths li').length >= 8);
  })()`), 20_000)
  await waitForImportDialogSettled()
  await waitUntil('successful import count in the result', () => cdp.evaluate(
    `document.querySelector('.import-completion-count')?.innerText === '已导入 8 个文件'`,
  ))
  const warningPaths = await cdp.evaluate(`Array.from(document.querySelectorAll('.import-cleanup-warning-paths li')).map(item => item.innerText.trim())`)
  assert.ok(warningPaths.length >= 8)
  assert.ok(warningPaths.every(item => item.startsWith('.standalone-editor-import-') && !item.startsWith('/')))
  for (const warningPath of warningPaths) {
    await lstat(path.join(workspace, ...warningPath.split('/')))
  }
  for (const entry of importEntries) {
    assert.equal(await readFile(path.join(workspace, ...entry.name.split('/')), 'utf8'), entry.data)
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  })
  await waitForImportDialogSettled()
  await waitUntil('warning to adapt to a narrow viewport', () => cdp.evaluate(`(() => {
    const warning = document.querySelector('.import-cleanup-warning');
    const list = warning?.querySelector('.import-cleanup-warning-paths');
    const firstPath = list?.querySelector('li span');
    const warningRect = warning?.getBoundingClientRect();
    return warning && list && firstPath && warningRect.width <= window.innerWidth &&
      warningRect.left >= 0 && warningRect.right <= window.innerWidth && list.scrollWidth <= list.clientWidth + 1 &&
      list.scrollHeight > list.clientHeight && parseFloat(getComputedStyle(firstPath).fontSize) >= 14 &&
      getComputedStyle(firstPath).overflowWrap === 'anywhere';
  })()`))
  const warningScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const warningScreenshotPath = path.join(screenshotDirectory, 'standalone-editor-import-warning-dark-mobile.png')
  await writeFile(warningScreenshotPath, Buffer.from(warningScreenshot.data, 'base64'))
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1195, height: 751, deviceScaleFactor: 1, mobile: false,
  })
  await cdp.evaluate(`document.querySelector('button[aria-label="切换到浅色模式"]')?.click()`)
  await waitUntil('light theme to be applied', () => cdp.evaluate(`document.documentElement.dataset.theme === 'light'`))
  await waitForImportDialogSettled()
  const lightWarningScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const lightWarningScreenshotPath = path.join(screenshotDirectory, 'standalone-editor-import-warning-light-desktop.png')
  await writeFile(lightWarningScreenshotPath, Buffer.from(lightWarningScreenshot.data, 'base64'))
  console.log(`[IMPORT_REVIEW_SCREENSHOTS] ${pickerScreenshotPath} ${warningScreenshotPath} ${lightWarningScreenshotPath}`)

  await cdp.send('Page.bringToFront')
  await waitUntil('browser page to keep keyboard focus before dismissing warning', () => cdp.evaluate(`document.hasFocus()`))
  await waitForImportDialogSettled()
  const warningCloseState = await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="关闭清理提醒"]');
    window.__importWarningKeyEvents = [];
    for (const name of ['keydown', 'keypress', 'keyup', 'click']) {
      button?.addEventListener(name, event => window.__importWarningKeyEvents.push({ name, key: event.key, trusted: event.isTrusted }), { once: name === 'click' });
    }
    button?.focus({ preventScroll: true });
    return {
      focused: document.activeElement === button,
      focusVisible: button?.matches(':focus-visible'),
      pageFocused: document.hasFocus(),
      visible: Boolean(button?.getClientRects().length && getComputedStyle(button).visibility !== 'hidden'),
      modalOpacity: getComputedStyle(button?.closest('.ant-modal')).opacity,
    };
  })()`)
  assert.equal(warningCloseState.focused, true, JSON.stringify(warningCloseState))
  assert.equal(warningCloseState.pageFocused, true, JSON.stringify(warningCloseState))
  assert.equal(warningCloseState.focusVisible, true, JSON.stringify(warningCloseState))
  assert.equal(warningCloseState.visible, true, JSON.stringify(warningCloseState))
  assert.ok(Number(warningCloseState.modalOpacity) >= 0.99, JSON.stringify(warningCloseState))
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
  })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const keyboardDismissState = await cdp.evaluate(`({
    events: window.__importWarningKeyEvents || [],
    warningVisible: Boolean(document.querySelector('.import-cleanup-warning')),
    importedCount: document.querySelector('.import-completion-count')?.innerText,
    pageFocused: document.hasFocus(),
  })`)
  assert.ok(keyboardDismissState.events.some(event => event.name === 'keydown' && event.key === 'Enter' && event.trusted), JSON.stringify(keyboardDismissState))
  assert.ok(keyboardDismissState.events.some(event => event.name === 'keypress' && event.key === 'Enter' && event.trusted), JSON.stringify(keyboardDismissState))
  assert.ok(keyboardDismissState.events.some(event => event.name === 'click' && event.trusted), JSON.stringify(keyboardDismissState))
  await waitUntil('warning details to dismiss while import count remains', () => cdp.evaluate(`Boolean(
    !document.querySelector('.import-cleanup-warning') &&
    document.querySelector('.import-completion-count')?.innerText === '已导入 8 个文件'
  )`))
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1195, height: 751, deviceScaleFactor: 1, mobile: false,
  })
  await waitUntil('desktop workspace to return', () => pageIsReady())
  await cdp.evaluate(`document.querySelector('.ant-modal-wrap .ant-modal-close')?.focus()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitUntil('import result dialog to close and return to the directory', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal-wrap')).find(item => item.querySelector('.import-modal-content'));
    return (!modal || !modal.getClientRects().length || getComputedStyle(modal).display === 'none') &&
      Boolean(document.querySelector('.workspace-sidebar'));
  })()`))

  await openImportDialog()
  await chooseImportArchive('normal-success.zip', createZip([{ name: 'normal-success.md', data: '# Normal import' }]))
  await waitUntil('normal success to close the import dialog with a success message', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal-wrap')).find(item => item.querySelector('.import-modal-content'));
    const notices = Array.from(document.querySelectorAll('.ant-message-notice-content')).map(item => item.innerText);
    return (!modal || !modal.getClientRects().length || getComputedStyle(modal).display === 'none') &&
      notices.some(item => item.includes('已导入 1 个文件'));
  })()`))
  assert.equal(await readFile(path.join(workspace, 'normal-success.md'), 'utf8'), '# Normal import')

  await openImportDialog()
  await chooseImportArchive('tree-refresh-error.zip', createZip([{ name: 'tree-refresh-error.md', data: '# Refresh warning import' }]))
  await waitUntil('successful import to stay distinct from a failed directory refresh', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal-wrap')).find(item => item.querySelector('.import-modal-content'));
    const notices = Array.from(document.querySelectorAll('.ant-message-notice-content')).map(item => item.innerText);
    return (!modal || !modal.getClientRects().length || getComputedStyle(modal).display === 'none') &&
      notices.some(item => item.includes('已导入 1 个文件')) &&
      notices.some(item => item.includes('导入成功，但目录刷新失败，请刷新目录。')) &&
      !notices.some(item => item.startsWith('导入失败：'));
  })()`))
  assert.equal(await readFile(path.join(workspace, 'tree-refresh-error.md'), 'utf8'), '# Refresh warning import')

  await openImportDialog()
  await chooseImportArchive('invalid.zip', Buffer.from('not a ZIP archive'))
  await waitUntil('invalid archive to remain an import error', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal-wrap')).find(item => item.querySelector('.import-modal-content'));
    const notices = Array.from(document.querySelectorAll('.ant-message-notice-content')).map(item => item.innerText);
    return Boolean(modal?.getClientRects().length && notices.some(item => item.startsWith('导入失败：')) &&
      !document.querySelector('.import-cleanup-warning'));
  })()`))
})

test('a delayed ZIP result cannot surface after switching to another workspace', { timeout: 60_000 }, async t => {
  const staleImportMarker = path.join(tempRoot, 'stale-import-cleanup')
  t.after(async () => {
    const teardownErrors = []
    try {
      await writeFile(staleImportMarker + '.release', 'release during test teardown')
    } catch (error) {
      teardownErrors.push(error)
    }

    let cleanupStarted = false
    try {
      await readFile(staleImportMarker + '.started', 'utf8')
      cleanupStarted = true
    } catch (error) {
      if (error.code !== 'ENOENT') teardownErrors.push(error)
    }
    if (cleanupStarted) {
      try {
        await waitUntil('delayed ZIP cleanup to finish before workspace restoration', async () => {
          return await readFile(staleImportMarker + '.done', 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
        }, 20_000)
      } catch (error) {
        teardownErrors.push(error)
      }
    }

    try {
      const originalWorkspace = await realpath(workspace)
      const setResponse = await fetch(`http://127.0.0.1:${backendPort}/api/workspace/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: originalWorkspace }),
      })
      if (!setResponse.ok) throw new Error(`workspace teardown restore returned ${setResponse.status}: ${await setResponse.text()}`)
      const selected = await setResponse.json()
      assert.equal(await realpath(selected.workspace), originalWorkspace)
      const checkResponse = await fetch(`http://127.0.0.1:${backendPort}/api/workspace/check`)
      if (!checkResponse.ok) throw new Error(`workspace teardown check returned ${checkResponse.status}: ${await checkResponse.text()}`)
      const checked = await checkResponse.json()
      assert.equal(await realpath(checked.workspace), originalWorkspace)
    } catch (error) {
      teardownErrors.push(error)
    }

    try {
      await Promise.all([
        rm(path.join(workspace, 'stale-switch.md'), { force: true }),
        rm(path.join(workspaceB, 'stale-switch.md'), { force: true }),
      ])
    } catch (error) {
      teardownErrors.push(error)
    }
    if (cleanupStarted && teardownErrors.length === 0) {
      await Promise.all([
        rm(staleImportMarker + '.started', { force: true }),
        rm(staleImportMarker + '.release', { force: true }),
        rm(staleImportMarker + '.done', { force: true }),
      ])
    }
    if (teardownErrors.length === 1) throw teardownErrors[0]
    if (teardownErrors.length > 1) throw new AggregateError(teardownErrors, 'stale ZIP result test teardown failed')
  })
  await openImportDialog()
  await chooseImportArchive('stale-switch.zip', createZip([{ name: 'stale-switch.md', data: '# Stale import' }]))
  await waitUntil('stale import to publish in its original workspace', async () => {
    return await readFile(path.join(workspace, 'stale-switch.md'), 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  }, 20_000)
  await waitUntil('stale import cleanup delay to begin', async () => {
    return await readFile(path.join(tempRoot, 'stale-import-cleanup.started'), 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  }, 10_000)

  await cdp.evaluate(`document.querySelector('.ant-modal-wrap .ant-modal-close')?.click()`)
  await waitUntil('pending import dialog to close', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal-wrap')).find(item => item.querySelector('.import-modal-content'));
    return !modal || !modal.getClientRects().length || getComputedStyle(modal).display === 'none';
  })()`))
  await switchWorkspace('workspace-b')
  await writeFile(path.join(tempRoot, 'stale-import-cleanup.release'), 'release')
  await waitUntil('delayed import API response to finish', async () => {
    return await readFile(path.join(tempRoot, 'stale-import-cleanup.done'), 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  }, 20_000)
  await new Promise(resolve => setTimeout(resolve, 250))

  const staleResultState = await cdp.evaluate(`(() => ({
    workspace: JSON.parse(localStorage.getItem('editor_workspace_info') || 'null')?.workspace,
    warningVisible: Boolean(document.querySelector('.import-cleanup-warning')),
    importModalVisible: Array.from(document.querySelectorAll('.ant-modal-wrap')).some(item =>
      item.querySelector('.import-modal-content') && item.getClientRects().length > 0 && getComputedStyle(item).display !== 'none'),
    successNoticeVisible: Array.from(document.querySelectorAll('.ant-message-notice-content')).some(item => item.innerText.includes('已导入 1 个文件')),
  }))()`)
  assert.equal(path.basename(staleResultState.workspace), 'workspace-b')
  assert.equal(staleResultState.warningVisible, false)
  assert.equal(staleResultState.importModalVisible, false)
  assert.equal(staleResultState.successNoticeVisible, false)
  assert.equal(await readFile(path.join(workspace, 'stale-switch.md'), 'utf8'), '# Stale import')
  await assert.rejects(readFile(path.join(workspaceB, 'stale-switch.md')), error => error.code === 'ENOENT')
})

test('denied browser storage leaves the workspace editable and the three-second server save working', async () => {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const denied = () => { throw new DOMException('storage denied by isolated test', 'SecurityError') };
      for (const method of ['getItem', 'setItem', 'removeItem', 'key']) {
        Storage.prototype[method] = function() { return denied(); };
      }
      Object.defineProperty(Storage.prototype, 'length', {
        configurable: true,
        get: denied,
      });
    })();`,
  })
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitUntil('workspace editor to mount while browser storage is denied', () => pageIsReady())
  await openFile(firstFile, firstSeed)
  await waitUntil('the local recovery warning to explain the storage failure', () => cdp.evaluate(
    `document.querySelector('.draft-storage-warning')?.innerText.includes('服务端自动保存仍会继续')`,
  ))

  const token = `STORAGE-DENIED-SERVER-SAVE-${Date.now()}`
  const editedAt = Date.now()
  await insertAtDocumentEnd(token)
  await waitUntil('the edited text to remain visible while browser storage is denied', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(token)})`,
  ))
  const saved = await waitUntil('the backend to persist the edit despite browser storage failures', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content.includes(token) ? content : null
  }, 9000)

  assert.ok(Date.now() - editedAt >= 2700, 'server save should keep the three-second debounce')
  assert.ok(saved.includes(token))
  assert.equal(await pageIsReady(), true, 'storage failures must not be reported as an unavailable workspace')
  assert.ok(await cdp.evaluate(`document.querySelector('.draft-storage-warning')?.innerText.includes('服务端自动保存仍会继续')`))
})

test('restoring history in source mode stays clean and does not schedule another save', async () => {
  const original = '---\ntitle: Original source version\n---\n\nOriginal body\n'
  const changed = `HISTORY-CURRENT-${Date.now()}`
  await writeFile(path.join(workspace, firstFile), original)
  await openFile(firstFile, 'Original body')
  await insertAtSourceEnd(`\n\n<!-- ${changed} -->`)
  await clickAriaButton('保存当前文件')

  await waitUntil('edited source version and its original history entry', async () => {
    const disk = await readFile(path.join(workspace, firstFile), 'utf8')
    const history = await readWorkspaceHistory(firstFile)
    return disk.includes(changed) && history.status === 200 && history.data.history?.length
  }, 10000)
  await waitUntil('saved source version to become clean', () => cdp.evaluate(
    `document.querySelector('.save-status')?.innerText.includes('已保存')`,
  ))

  await clickAriaButton('查看版本历史')
  await waitUntil('source history dialog to finish loading', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes(${JSON.stringify(firstFile)}));
    return Boolean(modal && !modal.innerText.includes('正在读取版本历史'));
  })()`))
  const historyState = await cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes(${JSON.stringify(firstFile)}));
    return JSON.stringify({ title: modal?.querySelector('.ant-modal-title')?.innerText, text: modal?.innerText, buttons: Array.from(modal?.querySelectorAll('button') || []).map(button => ({ text: button.innerText.trim(), disabled: button.disabled })) });
  })()`)
  assert.ok(JSON.parse(historyState).buttons.some(button => button.text.replace(/\s/g, '') === '恢复' && !button.disabled), historyState)
  const requestOffset = cdp.networkRequests.length
  await cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes(${JSON.stringify(firstFile)}));
    Array.from(modal?.querySelectorAll('button') || []).find(button => button.innerText.replace(/\\s/g, '') === '恢复' && !button.disabled)?.click();
  })()`)
  await clickConfirmButton('恢复版本')
  await waitUntil('restored source content to reach CodeMirror', () => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(original)}`,
  ))
  await new Promise(resolve => setTimeout(resolve, 100))

  assert.equal(await cdp.evaluate(`document.querySelector('.save-status')?.innerText`), '已保存')
  await new Promise(resolve => setTimeout(resolve, 3300))
  const unexpectedPuts = cdp.networkRequests.slice(requestOffset).filter(request =>
    request.method === 'PUT' && new URL(request.url).pathname === '/api/workspace',
  )
  assert.deepEqual(unexpectedPuts, [], 'loading the restored value into CodeMirror must not schedule a second save')
  assert.equal(await readFile(path.join(workspace, firstFile), 'utf8'), original)
})

test('a denied workspace write explains the permission error and keeps the draft', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    return t.skip('requires POSIX permission checks under a non-root backend account')
  }
  const token = `PERMISSION-DENIED-${Date.now()}`
  const filePath = path.join(workspace, firstFile)
  await openFile(firstFile, firstSeed)
  t.after(() => chmod(filePath, 0o644))
  await chmod(filePath, 0o444)
  await insertAtDocumentEnd(token)
  await waitUntil('permission test draft to appear in editor', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(token)})`,
  ))

  await clickAriaButton('保存当前文件')
  await waitUntil('save status to explain the permission denial', () => cdp.evaluate(
    `document.querySelector('.save-status')?.innerText.includes('无权限')`,
  ))
  await waitUntil('save notification to explain that the draft was kept', () => cdp.evaluate(
    `document.body.innerText.includes('无权限访问或修改该路径') && document.body.innerText.includes('未保存内容已保留')`,
  ))
  assert.equal(await readFile(filePath, 'utf8'), firstSeed)
  assert.ok(await cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(token)})`))
})

test('Markdown larger than the preview cap opens read-only without a draft or autosave', async t => {
  const fileName = `large-readonly-${Date.now()}.md`
  const filePath = path.join(workspace, fileName)
  await writeFile(filePath, '')
  await truncate(filePath, 10 * 1024 * 1024 + 1)
  t.after(() => rm(filePath, { force: true }))
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitUntil('editor to reload before opening the large Markdown fixture', () => pageIsReady())
  await waitUntil('oversized Markdown fixture to appear in the file tree', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(fileName)})`,
  ))

  const requestOffset = cdp.networkRequests.length
  await cdp.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(fileName)});
    node?.click();
    return Boolean(node);
  })()`)
  await waitUntil('large Markdown to open in its read-only download view', () => cdp.evaluate(
    `Boolean(document.querySelector('[aria-label="Markdown 只读预览"]')?.innerText.includes('超过 5 MiB 可编辑上限'))`,
  ))
  const view = await cdp.evaluate(`JSON.stringify({
    source: Boolean(document.querySelector('.source-editor .cm-content')),
    save: Boolean(document.querySelector('button[aria-label="保存当前文件"]')),
    history: Boolean(document.querySelector('button[aria-label="查看版本历史"]')),
    download: Boolean(document.querySelector('button[aria-label="下载 Markdown"]')),
    editable: document.querySelector('.ProseMirror')?.getAttribute('contenteditable') || null,
    dirty: document.querySelector('.editor-status-actions')?.innerText.includes('修改待保存') || false,
    view: document.querySelector('[aria-label="Markdown 只读预览"]')?.innerText || '',
    draft: Object.keys(localStorage).some(key => key.startsWith('editor_pending_drafts:') && localStorage.getItem(key)?.includes(${JSON.stringify(fileName)})),
  })`)
  const state = JSON.parse(view)
  assert.equal(state.source, false)
  assert.equal(state.save, false)
  assert.equal(state.history, false)
  assert.equal(state.download, true)
  assert.notEqual(state.editable, 'true')
  assert.equal(state.dirty, false)
  assert.equal(state.draft, false)

  await new Promise(resolve => setTimeout(resolve, 3200))
  const writes = cdp.networkRequests.slice(requestOffset).filter(request => request.method === 'PUT' && new URL(request.url).pathname === '/api/workspace')
  assert.deepEqual(writes, [])
})

test('a late large-document response cannot block the next tab from editing', async t => {
  const fileName = `large-tab-race-${Date.now()}.md`
  const filePath = path.join(workspace, fileName)
  await writeFile(filePath, 'x'.repeat(5 * 1024 * 1024 + 512 * 1024))
  t.after(() => rm(filePath, { force: true }))
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitUntil('editor to reload before the rapid tab switch', () => pageIsReady())
  await waitUntil('both documents to appear before the rapid tab switch', () => cdp.evaluate(
    `['${fileName}', '${firstFile}'].every(name => Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === name))`,
  ))

  await cdp.evaluate(`(() => {
    const large = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(fileName)});
    const normal = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(firstFile)});
    large?.click();
    normal?.click();
    return Boolean(large && normal);
  })()`)
  await waitUntil('the regular document to become editable after the large response', () => cdp.evaluate(
    `Boolean(document.querySelector('.ProseMirror[contenteditable="true"]')?.innerText.includes(${JSON.stringify(firstSeed)}))`,
  ))
  const token = `RAPID-SWITCH-SAVE-${Date.now()}`
  await insertAtDocumentEnd(token)
  await waitUntil('the regular document to autosave after the switch', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content.includes(token) ? content : null
  }, 9000)
})

test('a dirty draft survives a read-only transition and remains recoverable after close', async t => {
  const fileName = `large-dirty-${Date.now()}.md`
  const filePath = path.join(workspace, fileName)
  const seed = 'Dirty draft seed'
  await writeFile(filePath, seed)
  t.after(() => rm(filePath, { force: true }))
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitUntil('editor to reload before opening the draft fixture', () => pageIsReady())
  await openFile(fileName, seed)
  await cdp.evaluate(`(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 2500 ? 60000 : delay, ...args);
  })()`)

  const token = `PRESERVED-READONLY-DRAFT-${Date.now()}`
  await insertAtDocumentEnd(token)
  await waitUntil('the local draft to become dirty', () => cdp.evaluate(
    `Boolean(Array.from(document.querySelectorAll('.document-tab')).find(tab => tab.innerText.includes(${JSON.stringify(fileName)}) && tab.innerText.includes('未保存')))`
  ))

  await writeFile(filePath, 'x'.repeat(5 * 1024 * 1024 + 1))
  await openFile(firstFile, firstSeed)
  await cdp.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(fileName)});
    node?.click();
    return Boolean(node);
  })()`)
  await waitUntil('the enlarged file to become read-only with a retained draft', () => cdp.evaluate(
    `Boolean(document.querySelector('[aria-label="Markdown 只读预览"] [role="alert"]')?.innerText.includes('未保存的本地草稿'))`,
  ))
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('button[aria-label="下载本地草稿"]'))`), true)
  assert.equal(await cdp.evaluate(`Boolean(Array.from(document.querySelectorAll('.document-tab')).find(tab => tab.innerText.includes(${JSON.stringify(fileName)}) && tab.innerText.includes('未保存')))`), true)
  assert.equal((await readFile(filePath, 'utf8')).includes(token), false)

  const closeClicked = await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.tab-close')).find(item => item.getAttribute('aria-label') === ${JSON.stringify(`关闭 ${fileName}`)});
    button?.click();
    return Boolean(button);
  })()`)
  assert.equal(closeClicked, true)
  try {
    await waitUntil('a close warning to explain the readonly draft', () => cdp.evaluate(
      `Array.from(document.querySelectorAll('.ant-modal')).some(modal => modal.innerText.includes('下载草稿并关闭') && modal.innerText.includes('未保存草稿'))`,
    ))
  } catch (error) {
    const state = await cdp.evaluate(`JSON.stringify({ dialogs: Array.from(document.querySelectorAll('.ant-modal')).map(modal => modal.innerText), tabs: Array.from(document.querySelectorAll('.document-tab')).map(tab => ({ text: tab.innerText, label: tab.getAttribute('aria-label') })), storage: Object.keys(localStorage).filter(key => key.startsWith('editor_pending_drafts:')).map(key => localStorage.getItem(key)) })`)
    throw new Error(`${error.message}\nAfter close: ${state}`)
  }
  await cdp.evaluate(`Array.from(document.querySelectorAll('.ant-modal button')).find(button => button.innerText.trim() === '保留草稿')?.click()`)
  await waitUntil('the canceled close to leave the draft tab open', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('.document-tab')).some(tab => tab.innerText.includes(${JSON.stringify(fileName)}) && tab.innerText.includes('未保存'))`,
  ))
  await waitUntil('the canceled close dialog to disappear', () => cdp.evaluate(
    `!Array.from(document.querySelectorAll('.ant-modal')).some(modal => modal.innerText.includes('下载草稿并关闭'))`,
  ))

  const quotaKey = await cdp.evaluate(`(() => {
    const key = Object.keys(localStorage).find(item => item.startsWith('editor_pending_drafts:'));
    if (!key) return null;
    const nativeSetItem = Storage.prototype.setItem;
    nativeSetItem.call(localStorage, key, JSON.stringify({ version: 2, savedAt: Date.now(), drafts: { 'other.md': { content: 'older recovery', savedAt: Date.now() } } }));
    window.__nativeStorageSetItemForQuotaTest = nativeSetItem;
    Storage.prototype.setItem = function(storageKey, value) {
      if (storageKey === key) throw new DOMException('quota simulated by test', 'QuotaExceededError');
      return nativeSetItem.call(this, storageKey, value);
    };
    return key;
  })()`)
  assert.ok(quotaKey)
  await cdp.evaluate(`Array.from(document.querySelectorAll('.tab-close')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(`关闭 ${fileName}`)})?.click()`)
  await waitUntil('the quota warning to keep the tab open', () => cdp.evaluate(
    `document.body.innerText.includes('无法确认本地恢复草稿已写入')`,
  ))
  assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('.ant-modal')).some(modal => modal.innerText.includes('下载草稿并关闭'))`), false)
  assert.equal(await cdp.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(quotaKey)}))?.drafts?.['other.md']?.content === 'older recovery'`), true)
  await cdp.evaluate(`Storage.prototype.setItem = window.__nativeStorageSetItemForQuotaTest; delete window.__nativeStorageSetItemForQuotaTest`)

  await cdp.evaluate(`Array.from(document.querySelectorAll('.tab-close')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(`关闭 ${fileName}`)})?.click()`)
  await waitUntil('the second close warning', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('.ant-modal')).some(modal => modal.innerText.includes('下载草稿并关闭'))`,
  ))
  await cdp.evaluate(`Array.from(document.querySelectorAll('.ant-modal button')).find(button => button.innerText.trim() === '下载草稿并关闭')?.click()`)
  await waitUntil('the downloaded draft tab to close', () => cdp.evaluate(
    `!Array.from(document.querySelectorAll('.document-tab')).some(tab => tab.innerText.includes(${JSON.stringify(fileName)}))`,
  ))
  assert.equal(await cdp.evaluate(`Object.keys(localStorage).some(key => {
    if (!key.startsWith('editor_pending_drafts:')) return false;
    try { return JSON.parse(localStorage.getItem(key))?.drafts?.[${JSON.stringify(fileName)}]?.content.includes(${JSON.stringify(token)}) || false; }
    catch { return false; }
  })`), true)

  await cdp.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(fileName)});
    node?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    return Boolean(node);
  })()`)
  await waitUntil('the tree context menu for the retained draft file', () => cdp.evaluate(
    `Boolean(document.querySelector('.editor-context-menu') && document.querySelector('.editor-context-menu').innerText.includes('重命名') && document.querySelector('.editor-context-menu').innerText.includes('移入回收站'))`,
  ))
  await cdp.evaluate(`(() => {
    const menu = document.querySelector('.editor-context-menu');
    Array.from(menu?.querySelectorAll('[role="menuitem"]') || []).find(item => item.innerText.trim() === '移入回收站')?.click();
    return Boolean(menu);
  })()`)
  await waitUntil('the delete confirmation for the retained draft file', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('.ant-modal')).some(modal => modal.innerText.includes(${JSON.stringify(fileName)}) && modal.innerText.includes('移入回收站'))`,
  ))
  await cdp.evaluate(`Array.from(document.querySelectorAll('.ant-modal button')).find(button => button.innerText.trim() === '移入回收站')?.click()`)
  await waitUntil('the delete operation to be blocked by the retained draft', () => cdp.evaluate(
    `document.body.innerText.includes('文件只读且保留有未保存草稿')`,
  ))
  assert.equal((await readFile(filePath)).byteLength, 5 * 1024 * 1024 + 1)
  assert.equal(await cdp.evaluate(`Object.keys(localStorage).some(key => {
    if (!key.startsWith('editor_pending_drafts:')) return false;
    try { return JSON.parse(localStorage.getItem(key))?.drafts?.[${JSON.stringify(fileName)}]?.content.includes(${JSON.stringify(token)}) || false; }
    catch { return false; }
  })`), true)
})

test('canceling a move reference warning does not flush an open draft or move the directory', async t => {
  const movePage = await createPageTarget({ freshStorage: true })
  const movePageId = movePage.targetId
  await setupPage(movePage)
  const folderName = `move-source-${Date.now()}`
  const archiveName = `move-archive-${Date.now()}`
  const guideName = `guide-${Date.now()}.md`
  const guidePath = path.join(folderName, guideName)
  const guideDiskContent = '# Move source guide'
  const outsidePath = `move-outside-${Date.now()}.md`
  await mkdir(path.join(workspace, folderName), { recursive: true })
  await mkdir(path.join(workspace, archiveName), { recursive: true })
  await writeFile(path.join(workspace, guidePath), guideDiskContent)
  await writeFile(path.join(workspace, outsidePath), `[guide](${guidePath})`)
  t.after(async () => {
    await movePage.send('Page.close').catch(() => {})
    movePage.close()
    cdpConnections.delete(movePage)
    transientTargets.delete(movePageId)
    await fetch(`http://127.0.0.1:${chromeDebugPort}/json/close/${movePageId}`).catch(() => {})
    await rm(path.join(workspace, folderName), { recursive: true, force: true })
    await rm(path.join(workspace, archiveName), { recursive: true, force: true })
    await rm(path.join(workspace, outsidePath), { force: true })
  })
  await movePage.send('Page.reload', { ignoreCache: true })
  await waitUntil('move fixture folders to appear in the tree', () => movePage.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(folderName)}) && Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(archiveName)})`,
  ))

  await movePage.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.ant-tree-treenode')).find(item => item.innerText.includes(${JSON.stringify(folderName)}));
    row?.querySelector('.ant-tree-switcher')?.click();
    return Boolean(row);
  })()`)
  await openFile(guideName, 'Move source guide', movePage)
  await movePage.evaluate(`(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 2500 ? 60000 : delay, ...args);
  })()`)
  const draftToken = `UNFLUSHED-MOVE-DRAFT-${Date.now()}`
  await insertAtDocumentEnd(draftToken, movePage)
  const requestOffset = movePage.networkRequests.length
  await movePage.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(folderName)});
    node?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    return Boolean(node);
  })()`)
  await waitUntil('directory context menu to open', () => movePage.evaluate(`Array.from(document.querySelectorAll('.editor-context-menu [role="menuitem"]')).some(item => item.innerText.trim() === '移动到...' && item.getBoundingClientRect().width > 0)`))
  await movePage.evaluate(`(() => {
    const action = Array.from(document.querySelectorAll('.editor-context-menu [role="menuitem"]')).find(item => item.innerText.trim() === '移动到...' && item.getBoundingClientRect().width > 0);
    action?.click();
    return Boolean(action);
  })()`)
  await waitUntil('move dialog to list the archive destination', () => movePage.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes(${JSON.stringify(folderName)}));
    return Boolean(Array.from(modal?.querySelectorAll('.ant-tree-title > div') || []).find(item => item.innerText.trim() === ${JSON.stringify(archiveName)}));
  })()`))
  await movePage.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes(${JSON.stringify(folderName)}));
    const destination = Array.from(modal?.querySelectorAll('.ant-tree-title > div') || []).find(item => item.innerText.trim() === ${JSON.stringify(archiveName)});
    destination?.click();
    return Boolean(destination);
  })()`)
  const moveDialogState = await movePage.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes(${JSON.stringify(folderName)}));
    return { text: modal?.innerText, buttons: Array.from(modal?.querySelectorAll('button') || []).map(button => ({ text: button.innerText.trim(), disabled: button.disabled, width: button.getBoundingClientRect().width })) };
  })()`)
  assert.ok(moveDialogState.buttons.some(button => button.text.replace(/\s/g, '') === '移动'), `move dialog should expose its action: ${JSON.stringify(moveDialogState)}`)
  await movePage.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes(${JSON.stringify(folderName)}));
    const button = Array.from(modal?.querySelectorAll('button') || []).find(item => item.innerText.replace(/\\s/g, '') === '移动');
    button?.click();
    return Boolean(button);
  })()`)
  await waitUntil('incoming Markdown link warning to appear', () => movePage.evaluate(
    `Array.from(document.querySelectorAll('.ant-modal-confirm')).some(item => item.innerText.includes('移动可能影响 Markdown 引用') && item.innerText.includes(${JSON.stringify(outsidePath)}))`,
  ))
  await cancelVisibleConfirmation(movePage)
  await waitUntil('reference warning to close while the move dialog remains open', () => movePage.evaluate(
    `!document.querySelector('.ant-modal-confirm') && Array.from(document.querySelectorAll('.ant-modal')).some(item => item.querySelector('.ant-modal-title')?.innerText.includes(${JSON.stringify(folderName)}))`,
  ))

  assert.equal(await readFile(path.join(workspace, guidePath), 'utf8'), guideDiskContent)
  await assert.rejects(readFile(path.join(workspace, archiveName, guideName)), error => error.code === 'ENOENT')
  const attemptedMutations = movePage.networkRequests.slice(requestOffset).filter(request => {
    const pathname = new URL(request.url).pathname
    return (request.method === 'PUT' && pathname === '/api/workspace') ||
      (request.method === 'POST' && pathname === '/api/workspace/move')
  })
  assert.deepEqual(attemptedMutations, [], 'cancel must not flush the open draft or issue the move request')
  assert.ok(await movePage.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(draftToken)})`), 'the unsaved draft stays visible')
})

test('.markdown stays editable while attachments use a read-only byte download view', async () => {
  const markdownPath = 'extended.markdown'
  const attachmentPath = 'archive.sqlite'
  const attachmentBytes = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
  await writeFile(path.join(workspace, markdownPath), '# Markdown extension seed')
  await writeFile(path.join(workspace, attachmentPath), attachmentBytes)
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitUntil('editor to reload after creating Markdown and attachment fixtures', () => pageIsReady())

  await openFile(markdownPath, 'Markdown extension seed')
  const markdownToken = `MARKDOWN-EXTENSION-${Date.now()}`
  await insertAtDocumentEnd(markdownToken)
  await waitUntil('the .markdown document to autosave', async () => {
    const content = await readFile(path.join(workspace, markdownPath), 'utf8')
    return content.includes(markdownToken) ? content : null
  }, 9000)

  const requestOffset = cdp.networkRequests.length
  await waitUntil(`${attachmentPath} in the file tree`, () => cdp.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(node => node.innerText.trim() === ${JSON.stringify(attachmentPath)})`,
  ))
  await cdp.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(attachmentPath)});
    node?.click();
    return Boolean(node);
  })()`)
  await waitUntil('attachment to open in its read-only panel', () => cdp.evaluate(
    `Boolean(document.querySelector('[aria-label="附件只读查看"]') && document.querySelector('[aria-label="附件只读查看"]').innerText.includes('不会按 Markdown 打开或自动保存'))`,
  ))
  const attachmentState = await cdp.evaluate(`JSON.stringify({
    sourceEditor: Boolean(document.querySelector('.source-editor .cm-content')),
    saveButton: Boolean(document.querySelector('button[aria-label="保存当前文件"]')),
    historyButton: Boolean(document.querySelector('button[aria-label="查看版本历史"]')),
    attachedDraft: Object.values(localStorage).some(value => value.includes(${JSON.stringify(attachmentPath)})),
    editorEditable: document.querySelector('.ProseMirror')?.getAttribute('contenteditable') || null,
  })`)
  assert.deepEqual(JSON.parse(attachmentState), {
    sourceEditor: false,
    saveButton: false,
    historyButton: false,
    attachedDraft: false,
    editorEditable: null,
  })
  const openedFileRequests = cdp.networkRequests.slice(requestOffset).filter(request =>
    request.method === 'GET' && request.url.includes('/file?path=archive.sqlite'),
  )
  assert.deepEqual(openedFileRequests, [], 'opening an attachment must not request text content')

  await clickExactAriaButton('下载附件')
  await waitUntil('the attachment to use the binary download endpoint', () => Promise.resolve(
    cdp.networkRequests.some(request => request.method === 'GET' && request.url.includes('/download?path=archive.sqlite')),
  ))
  assert.deepEqual(await readFile(path.join(workspace, attachmentPath)), attachmentBytes)
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

test('two independent browser tabs cannot silently overwrite a newer save', async () => {
  const secondContext = await createPageTarget()
  await setupPage(secondContext)
  await openFile(firstFile, firstSeed, cdp)
  await openFile(firstFile, firstSeed, secondContext)

  const newerToken = `SECOND-CONTEXT-${Date.now()}`
  await insertAtDocumentEnd(newerToken, secondContext)
  await waitUntil('newer second-tab draft to reach disk', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content.includes(newerToken) ? content : null
  }, 9000)

  const staleToken = `STALE-FIRST-CONTEXT-${Date.now()}`
  await insertAtDocumentEnd(staleToken, cdp)
  await waitUntil('first tab to report a version conflict', () => cdp.evaluate(
    `document.querySelector('.file-conflict-banner')?.innerText.includes('本地草稿已保留')`,
  ), 9000)

  const diskContent = await readFile(path.join(workspace, firstFile), 'utf8')
  assert.ok(diskContent.includes(newerToken), 'the newer second-tab write must remain on disk')
  assert.ok(!diskContent.includes(staleToken), 'the stale first-tab draft must not replace disk content')
  const firstTabState = await cdp.evaluate(`JSON.stringify({
    editor: document.querySelector('.ProseMirror')?.innerText,
    status: document.querySelector('.save-status')?.innerText,
    dirty: document.querySelector('.file-conflict-banner')?.innerText,
  })`)
  const state = JSON.parse(firstTabState)
  assert.ok(state.editor.includes(staleToken), 'the stale tab must keep its local draft visible')
  assert.match(state.status, /内容冲突待处理/)
  assert.match(state.dirty, /本地草稿已保留/)
})

test('duplicating a tab with a cloned session id keeps each draft snapshot separate', async () => {
  await openFile(firstFile, firstSeed)
  await cdp.evaluate(`document.querySelector('[aria-label="切换到源码编辑"]')?.click()`)
  await waitUntil('first source editor to open', () => cdp.evaluate(`Boolean(document.querySelector('.source-editor .cm-content'))`))
  const storageWorkspace = await realpath(workspace)
  const originalSession = await cdp.evaluate(`sessionStorage.getItem('editor_draft_tab_session')`)
  const firstToken = `DUPLICATE-A-${Date.now()}`
  await insertAtSourceEnd(firstToken)
  let snapshotDiagnostic = ''
  try {
    await waitUntil('first tab snapshot to include its draft', async () => {
      snapshotDiagnostic = await cdp.evaluate(`(() => {
    const prefix = 'editor_pending_drafts:' + encodeURIComponent(${JSON.stringify(storageWorkspace)}) + ':';
    const matching = Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => [key, localStorage.getItem(key)]);
    const found = matching.some(([key, value]) => {
      if (!key.startsWith(prefix)) return false;
      try { return JSON.parse(value)?.drafts?.[${JSON.stringify(firstFile)}]?.content?.includes(${JSON.stringify(firstToken)}); }
      catch { return false; }
    });
    return JSON.stringify({ found, session: sessionStorage.getItem('editor_draft_tab_session'), status: document.querySelector('.save-status')?.innerText, conflict: document.querySelector('.file-conflict-banner')?.innerText, editor: document.querySelector('.ProseMirror')?.innerText, matching });
  })()`)
      return JSON.parse(snapshotDiagnostic).found
    })
  } catch (error) {
    throw new Error(`${error.message}\nLast browser snapshot state: ${snapshotDiagnostic}`)
  }

  const secondContext = await createPageTarget({ sessionId: originalSession })
  await setupPage(secondContext)
  await waitUntil('duplicated tab to claim a distinct session id', () => secondContext.evaluate(
    `sessionStorage.getItem('editor_draft_tab_session') !== ${JSON.stringify(originalSession)}`,
  ))
  const originalSlotSurvivedRotation = await secondContext.evaluate(`(() => {
    const key = 'editor_pending_drafts:' + encodeURIComponent(${JSON.stringify(storageWorkspace)}) + ':' + encodeURIComponent(${JSON.stringify(originalSession)});
    try { return JSON.parse(localStorage.getItem(key))?.drafts?.[${JSON.stringify(firstFile)}]?.content?.includes(${JSON.stringify(firstToken)}) || false; }
    catch { return false; }
  })()`)
  assert.equal(originalSlotSurvivedRotation, true, 'rotating a cloned ID must leave the original live tab snapshot untouched')
  await openFile(firstFile, firstSeed, secondContext)
  const secondToken = `DUPLICATE-B-${Date.now()}`
  await insertAtSourceEnd(secondToken, secondContext)
  await waitUntil('both tab snapshots to exist independently', () => secondContext.evaluate(`(() => {
    const prefix = 'editor_pending_drafts:' + encodeURIComponent(${JSON.stringify(storageWorkspace)}) + ':';
    const snapshots = Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => {
      try { return { key, content: JSON.parse(localStorage.getItem(key))?.drafts?.[${JSON.stringify(firstFile)}]?.content || '' }; }
      catch { return { key, content: '' }; }
    }).filter(item => item.content.includes(${JSON.stringify(firstToken)}) || item.content.includes(${JSON.stringify(secondToken)}));
    return snapshots.length >= 2 ? snapshots : null;
  })()`))
  const snapshots = await secondContext.evaluate(`(() => {
    const prefix = 'editor_pending_drafts:' + encodeURIComponent(${JSON.stringify(storageWorkspace)}) + ':';
    return Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => {
      try { return { key, content: JSON.parse(localStorage.getItem(key))?.drafts?.[${JSON.stringify(firstFile)}]?.content || '' }; }
      catch { return { key, content: '' }; }
    }).filter(item => item.content.includes(${JSON.stringify(firstToken)}) || item.content.includes(${JSON.stringify(secondToken)}));
  })()`)
  assert.equal(new Set(snapshots.map(item => item.key)).size, 2)
  assert.ok(snapshots.some(item => item.content.includes(firstToken)))
  assert.ok(snapshots.some(item => item.content.includes(secondToken)))
})

test('choosing an alternate recovery draft keeps the previous draft reachable', async () => {
  const storageWorkspace = await realpath(workspace)
  const workspacePrefix = `editor_pending_drafts:${encodeURIComponent(storageWorkspace)}:`
  const sessionId = `recovery-owner-${Date.now()}`
  const savedAt = Date.now()
  const firstDraft = 'LOCAL-DRAFT-A'
  const secondDraft = 'LOCAL-DRAFT-B'
  const draftStore = content => ({
    version: 2,
    savedAt,
    drafts: { [firstFile]: { content, baseRevision: null, savedAt } },
  })
  const recoveryPage = await createPageTarget({
    sessionId,
    drafts: {
      [`${workspacePrefix}${sessionId}`]: draftStore(firstDraft),
      [`${workspacePrefix}other-session`]: draftStore(secondDraft),
    },
  })
  await setupPage(recoveryPage)
  await clickAriaButton('更多目录操作', recoveryPage)
  await waitUntil('other-session recovery snapshot to be discovered', () => recoveryPage.evaluate(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).some(item => item.innerText.includes('其他恢复草稿（1）'))`,
  ))
  await clickMenuItem('其他恢复草稿（1）', recoveryPage)
  await waitUntil('alternate recovery draft to be listed', () => recoveryPage.evaluate(
    `Array.from(document.querySelector('.ant-modal')?.querySelectorAll('textarea') || []).some(input => input.value.includes(${JSON.stringify(secondDraft)}))`,
  ))
  await clickVisibleButton('载入并比较磁盘版本', recoveryPage)
  await waitUntil('selected alternate to open the disk comparison', () => recoveryPage.evaluate(
    `Array.from(document.querySelectorAll('.ant-modal')).some(modal => modal.innerText.includes('当前磁盘版本') && modal.querySelector('[aria-label="本地草稿内容"]')?.value.includes(${JSON.stringify(secondDraft)}))`,
  ))
  await clickVisibleButton('保留草稿', recoveryPage)
  await clickAriaButton('更多目录操作', recoveryPage)
  await clickMenuItem('其他恢复草稿（2）', recoveryPage)
  await waitUntil('both versions to remain reachable after switching', () => recoveryPage.evaluate(`(() => {
    const modal = document.querySelector('.ant-modal');
    const values = Array.from(modal?.querySelectorAll('textarea') || []).map(item => item.value);
    return modal?.innerText.includes('其他本地恢复草稿（2）') && values.some(value => value.includes(${JSON.stringify(firstDraft)})) && values.some(value => value.includes(${JSON.stringify(secondDraft)}));
  })()`))
})

test('switching workspace A to B and back keeps A recovery candidate separate', async () => {
  await openFile(firstFile, firstSeed)
  await waitUntil('tab session identity to initialize', () => cdp.evaluate(`sessionStorage.getItem('editor_draft_tab_session')`))
  const sessionId = await cdp.evaluate(`sessionStorage.getItem('editor_draft_tab_session')`)
  const revision = await cdp.evaluate(`(async () => {
    const info = JSON.parse(localStorage.getItem('editor_workspace_info'));
    const response = await fetch('/api/workspace/file?path=${firstFile}', { headers: {
      'X-Workspace-Id': info.workspaceId,
      'X-Workspace-Version': String(info.workspaceVersion),
    }});
    return (await response.json()).revision;
  })()`)
  const recoveredContent = `${firstSeed}\nRECOVERED-AFTER-SWITCH`
  const savedAt = Date.now()
  const storageWorkspace = await realpath(workspace)
  const abandonedSession = `workspace-switch-recovery-${Date.now()}`
  const storageKey = `editor_pending_drafts:${encodeURIComponent(storageWorkspace)}:${encodeURIComponent(abandonedSession)}`
  await cdp.evaluate(`localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify({
    version: 2,
    savedAt,
    drafts: { [firstFile]: { content: recoveredContent, baseRevision: revision, savedAt } },
  }))})`)

  await switchWorkspace('workspace-b')
  await openFile(firstFile, 'Workspace B seed')
  assert.equal(await readFile(path.join(workspaceB, firstFile), 'utf8'), 'Workspace B seed')

  await switchWorkspace('notes')
  await openFile(firstFile, firstSeed)
  await clickAriaButton('更多目录操作')
  await waitUntil('A recovery alternative to appear after returning from B', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).some(item => item.innerText.includes('其他恢复草稿（1）'))`,
  ))
  await clickMenuItem('其他恢复草稿（1）')
  await waitUntil('A recovery candidate to remain available after switching', () => cdp.evaluate(
    `Array.from(document.querySelector('.ant-modal')?.querySelectorAll('textarea') || []).some(input => input.value.includes('RECOVERED-AFTER-SWITCH'))`,
  ))
  assert.equal(await readFile(path.join(workspace, firstFile), 'utf8'), firstSeed, 'switch-back recovery must stay local until deliberately saved')
  assert.equal(await readFile(path.join(workspaceB, firstFile), 'utf8'), 'Workspace B seed', 'workspace B must never receive workspace A draft bytes')
})

test('trash UI can restore a deleted file to its original path', async () => {
  await waitUntil('second file in the workspace tree', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(secondFile)})`,
  ))
  await cdp.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(secondFile)});
    node?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    return Boolean(node);
  })()`)
  await waitUntil('file context menu to open', () => cdp.evaluate(`Boolean(document.querySelector('.editor-context-menu')?.innerText.includes('重命名') && document.querySelector('.editor-context-menu')?.innerText.includes('移入回收站'))`))
  await cdp.evaluate(`(() => {
    const action = Array.from(document.querySelectorAll('.editor-context-menu [role="menuitem"]')).find(item => item.innerText.trim() === '移入回收站' && item.getBoundingClientRect().width > 0);
    action?.click();
    return Boolean(action);
  })()`)
  await clickVisibleButton('移入回收站')
  await waitUntil('file to leave the workspace tree', () => cdp.evaluate(
    `!Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(secondFile)})`,
  ))
  await waitUntil('delete confirmation to close', () => cdp.evaluate(
    `!document.querySelector('.ant-modal-confirm')`,
  ))
  assert.equal(await readFile(path.join(workspace, secondFile)).catch(error => error.code), 'ENOENT')

  await clickAriaButton('更多目录操作')
  await clickMenuItem('回收站')
  await waitUntil('trash modal to list the deleted file', () => cdp.evaluate(
    `document.querySelector('.ant-modal')?.innerText.includes(${JSON.stringify(secondFile)})`,
  ))
  const restoreButtonState = await cdp.evaluate(`(() => {
    const trashModal = Array.from(document.querySelectorAll('.ant-modal')).find(modal => modal.innerText.includes('回收站'));
    const button = Array.from(trashModal?.querySelectorAll('button') || []).find(item =>
      item.getAttribute('aria-label')?.includes(${JSON.stringify(secondFile)}) ||
      (item.innerText.trim() === '恢复' && item.parentElement?.innerText.includes(${JSON.stringify(secondFile)}))
    );
    button?.click();
    return { clicked: Boolean(button), modalText: trashModal?.innerText, buttons: Array.from(trashModal?.querySelectorAll('button') || []).map(item => ({ text: item.innerText, label: item.getAttribute('aria-label') })) };
  })()`)
  assert.equal(restoreButtonState.clicked, true, `the trash row should expose a restore action: ${JSON.stringify(restoreButtonState)}`)
  await waitUntil('trash restore request to report an outcome', () => cdp.evaluate(
    `document.body.innerText.includes('已从回收站恢复') || document.body.innerText.includes('恢复失败：')`,
  ))
  const restoreNotice = await cdp.evaluate('document.body.innerText')
  assert.ok(restoreNotice.includes('已从回收站恢复'), restoreNotice)
  await waitUntil('restore to bring the file back to disk and tree', async () => {
    const disk = await readFile(path.join(workspace, secondFile), 'utf8').catch(() => '')
    const inTree = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(secondFile)})`)
    return disk === secondSeed && inTree
  })
  assert.equal(await readFile(path.join(workspace, secondFile), 'utf8'), secondSeed)
})

test('history dialog confirms per-version deletion without changing current documents', async () => {
  const firstHistoryToken = `HISTORY-DELETE-${Date.now()}`
  const secondHistoryToken = `OTHER-HISTORY-${Date.now()}`
  await openFile(firstFile, firstSeed)
  await insertAtSourceEnd(firstHistoryToken)
  await waitUntil('first document edit to create a history entry', async () => {
    const disk = await readFile(path.join(workspace, firstFile), 'utf8').catch(() => '')
    const history = await readWorkspaceHistory(firstFile)
    return disk.includes(firstHistoryToken) && history.status === 200 && history.data.history?.length
  }, 10000)
  await openFile(secondFile, secondSeed)
  await insertAtSourceEnd(secondHistoryToken)
  await waitUntil('second document edit to create a history entry', async () => {
    const disk = await readFile(path.join(workspace, secondFile), 'utf8').catch(() => '')
    const history = await readWorkspaceHistory(secondFile)
    return disk.includes(secondHistoryToken) && history.status === 200 && history.data.history?.length
  }, 10000)

  const firstHistoryBefore = await readWorkspaceHistory(firstFile)
  const secondHistoryBefore = await readWorkspaceHistory(secondFile)
  assert.equal(firstHistoryBefore.status, 200)
  assert.equal(secondHistoryBefore.status, 200)
  const targetHistory = firstHistoryBefore.data.history[0]
  const secondHistoryIds = secondHistoryBefore.data.history.map(item => item.id).sort()
  const firstDocumentBeforeDelete = await readFile(path.join(workspace, firstFile), 'utf8')
  const recoveryStatsBeforeDelete = await readWorkspaceRecoveryStats()
  assert.equal(recoveryStatsBeforeDelete.status, 200)

  await openFile(firstFile, firstHistoryToken)
  await clickAriaButton('查看版本历史')
  const historyDeleteLabel = `永久删除历史版本 ${firstFile} ${targetHistory.id}`
  const beforeConfirmedHistoryDelete = cdp.networkRequests.length
  await clickExactAriaButton(historyDeleteLabel)
  await waitUntil('history delete confirmation to show its effect', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('.ant-modal-confirm')).some(dialog => {
      const style = getComputedStyle(dialog);
      return dialog.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && dialog.innerText.includes('当前文档内容不会被删除或修改') && dialog.innerText.includes('无法从编辑器恢复');
    })`,
  ))
  const beforeHistoryCancel = cdp.networkRequests.length
  await cancelVisibleConfirmation()
  await waitUntil('history delete confirmation to close after cancel', async () => !await hasVisibleConfirmation())
  const canceledHistoryRequests = cdp.networkRequests.slice(beforeHistoryCancel).filter(request =>
    request.method === 'DELETE' && new URL(request.url).pathname.endsWith('/api/workspace/file/history'),
  )
  assert.equal(canceledHistoryRequests.length, 0, 'canceling confirmation must not send a history delete request')
  assert.ok(await cdp.evaluate(`Boolean(document.querySelector('button[aria-label=${JSON.stringify(historyDeleteLabel)}]'))`), 'the canceled history entry must remain available')

  await clickExactAriaButton(historyDeleteLabel)
  await clickConfirmButton('永久删除历史版本')
  await waitUntil('history deletion confirmation to finish', async () => !await hasVisibleConfirmation())
  await waitUntil('history entry to disappear from the browser list', () => cdp.evaluate(
    `!Array.from(document.querySelectorAll('button')).some(button => button.getAttribute('aria-label') === ${JSON.stringify(historyDeleteLabel)})`,
  ))
  const firstHistoryAfter = await readWorkspaceHistory(firstFile)
  const secondHistoryAfter = await readWorkspaceHistory(secondFile)
  assert.equal(firstHistoryAfter.status, 200)
  assert.equal(secondHistoryAfter.status, 200)
  assert.ok(!firstHistoryAfter.data.history.some(item => item.id === targetHistory.id), 'the confirmed item must be removed')
  assert.deepEqual(secondHistoryAfter.data.history.map(item => item.id).sort(), secondHistoryIds, 'deleting one file history must preserve another file history')
  assert.equal(await readFile(path.join(workspace, firstFile), 'utf8'), firstDocumentBeforeDelete, 'deleting history must not change the current document')
  await waitUntil('successful history deletion to refresh recovery statistics', () => cdp.networkRequests.slice(beforeConfirmedHistoryDelete).some(request =>
    request.method === 'GET' && new URL(request.url).pathname.endsWith('/api/workspace/recovery/stats'),
  ))
  const recoveryStatsAfterDelete = await readWorkspaceRecoveryStats()
  assert.equal(recoveryStatsAfterDelete.data.history.items, recoveryStatsBeforeDelete.data.history.items - 1)
})

test('trash dialog reports storage and limits permanent cleanup to confirmed expired items', async () => {
  const workspaceHistoryToken = `RECOVERY-STATS-${Date.now()}`
  await openFile(firstFile, firstSeed)
  await insertAtSourceEnd(workspaceHistoryToken)
  await waitUntil('workspace history to exist for the storage display', async () => {
    const disk = await readFile(path.join(workspace, firstFile), 'utf8').catch(() => '')
    const history = await readWorkspaceHistory(firstFile)
    return disk.includes(workspaceHistoryToken) && history.status === 200 && history.data.history?.length
  }, 10000)

  const expiredName = `expired-${Date.now()}.md`
  const retainedName = `retained-${Date.now()}.md`
  const retainedAfterFailureName = `retained-after-failure-${Date.now()}.md`
  await writeFile(path.join(workspace, expiredName), 'expired test payload')
  await writeFile(path.join(workspace, retainedName), 'retained test payload')
  await writeFile(path.join(workspace, retainedAfterFailureName), 'retained test payload after failure')
  await cdp.send('Page.reload')
  await setupPage(cdp)
  await Promise.all([expiredName, retainedName, retainedAfterFailureName].map(name => waitUntil(
    `${name} to appear after reload`,
    () => cdp.evaluate(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(name)})`),
  )))
  await moveFileToTrash(expiredName)
  await moveFileToTrash(retainedName)
  await moveFileToTrash(retainedAfterFailureName)

  const realWorkspace = await realpath(workspace)
  const workspaceId = createHash('sha256').update(realWorkspace).digest('hex')
  const trashDirectory = path.join(tempRoot, 'recovery', 'trash', workspaceId)
  const trashEntries = await readdir(trashDirectory)
  const manifestFor = async originalPath => {
    for (const id of trashEntries) {
      const manifestPath = path.join(trashDirectory, id, 'entry.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => 'null'))
      if (manifest?.originalPath === originalPath) return { id, manifestPath, manifest }
    }
    return null
  }
  const expiredEntry = await manifestFor(expiredName)
  const retainedEntry = await manifestFor(retainedName)
  const retainedAfterFailureEntry = await manifestFor(retainedAfterFailureName)
  assert.ok(expiredEntry && retainedEntry && retainedAfterFailureEntry, 'all three test files should have isolated trash entries')
  await writeFile(expiredEntry.manifestPath, JSON.stringify({
    ...expiredEntry.manifest,
    expiresAt: '2000-01-01T00:00:00.000Z',
  }, null, 2))

  await openTrash()
  const statsResponse = await readWorkspaceRecoveryStats()
  assert.equal(statsResponse.status, 200)
  await waitUntil('all three recovery storage statistics to render', () => cdp.evaluate(
    `document.querySelectorAll('.recovery-stats-card').length === 3 && Array.from(document.querySelectorAll('.recovery-stats-card')).every(card => card.innerText.includes('占用'))`,
  ))
  const cards = await cdp.evaluate(`Array.from(document.querySelectorAll('.recovery-stats-card')).map(card => ({
    label: card.querySelector('.recovery-stats-label')?.innerText,
    items: card.querySelector('strong')?.innerText,
    bytes: card.querySelector('.recovery-stats-bytes')?.innerText,
  }))`)
  for (const [index, [label, section]] of [
    ['历史版本', statsResponse.data.history],
    ['回收站', statsResponse.data.trash],
    ['总计', statsResponse.data.total],
  ].entries()) {
    assert.equal(cards[index].label, label)
    assert.equal(cards[index].items, `${Number(section.items).toLocaleString()} 项`)
    assert.equal(cards[index].bytes, `${formatDisplayedBytes(section.bytes)} 占用`)
  }
  assert.equal(statsResponse.data.trash.items, 3, 'only this temporary workspace has the three new trash fixtures')
  assert.ok(statsResponse.data.history.items > 0, 'the source workspace should have history usage to distinguish its stats')

  await clickVisibleButton('清理过期项目')
  await waitUntil('expiry cleanup confirmation to be explicit', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('.ant-modal-confirm')).some(dialog => {
      const style = getComputedStyle(dialog);
      return dialog.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && dialog.innerText.includes('只会清理已过期的项目') && dialog.innerText.includes('永久删除') && dialog.innerText.includes('未过期项目会保留');
    })`,
  ))
  const beforePurgeCancel = cdp.networkRequests.length
  await cancelVisibleConfirmation()
  await waitUntil('expiry cleanup confirmation to close after cancel', async () => !await hasVisibleConfirmation())
  const canceledPurgeRequests = cdp.networkRequests.slice(beforePurgeCancel).filter(request =>
    request.method === 'POST' && new URL(request.url).pathname.endsWith('/api/workspace/trash/purge-expired'),
  )
  assert.equal(canceledPurgeRequests.length, 0, 'canceling cleanup confirmation must not send a purge request')

  const beforePurge = cdp.networkRequests.length
  await clickVisibleButton('清理过期项目')
  await clickConfirmButton('确认清理过期项目')
  await waitUntil('expiry cleanup to report success', () => cdp.evaluate(`document.body.innerText.includes('已永久清理 1 个过期项目')`))
  await waitUntil('expiry cleanup confirmation to close after success', async () => !await hasVisibleConfirmation())
  await waitUntil('only unexpired trash entries to remain', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.innerText.includes('回收站'));
    return modal?.innerText.includes(${JSON.stringify(retainedName)}) && modal?.innerText.includes(${JSON.stringify(retainedAfterFailureName)}) && !modal?.innerText.includes(${JSON.stringify(expiredName)});
  })()`))
  await waitUntil('trash storage count to refresh after expiry cleanup', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('.recovery-stats-card')).find(card => card.querySelector('.recovery-stats-label')?.innerText === '回收站')?.querySelector('strong')?.innerText === '2 项'`,
  ))
  assert.ok(cdp.networkRequests.slice(beforePurge).some(request => request.method === 'POST' && new URL(request.url).pathname.endsWith('/api/workspace/trash/purge-expired')))
  assert.equal(await readFile(path.join(trashDirectory, expiredEntry.id, 'entry.json')).catch(error => error.code), 'ENOENT', 'the expired test entry should be permanently removed')
  await access(path.join(trashDirectory, retainedEntry.id, 'entry.json'))
  await access(path.join(trashDirectory, retainedAfterFailureEntry.id, 'entry.json'))

  const retainedDeleteLabel = `永久删除 ${retainedName}`
  await clickExactAriaButton(retainedDeleteLabel)
  await waitUntil('single trash deletion confirmation to explain irreversible effect', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('.ant-modal-confirm')).some(dialog => {
      const style = getComputedStyle(dialog);
      return dialog.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && dialog.innerText.includes('无法从编辑器恢复') && dialog.innerText.includes('历史版本会保留');
    })`,
  ))
  const beforeTrashDeleteCancel = cdp.networkRequests.length
  await cancelVisibleConfirmation()
  await waitUntil('single trash deletion confirmation to close after cancel', async () => !await hasVisibleConfirmation())
  const canceledTrashDeleteRequests = cdp.networkRequests.slice(beforeTrashDeleteCancel).filter(request =>
    request.method === 'DELETE' && new URL(request.url).pathname.endsWith('/api/workspace/trash'),
  )
  assert.equal(canceledTrashDeleteRequests.length, 0, 'canceling a trash delete must not send a delete request')

  const beforeTrashDelete = cdp.networkRequests.length
  await clickExactAriaButton(retainedDeleteLabel)
  await clickConfirmButton('永久删除')
  await waitUntil('single trash deletion confirmation to close after success', async () => !await hasVisibleConfirmation())
  await waitUntil('selected unexpired trash item to be removed', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.innerText.includes('回收站'));
    return !modal?.innerText.includes(${JSON.stringify(retainedName)}) && modal?.innerText.includes(${JSON.stringify(retainedAfterFailureName)});
  })()`))
  await waitUntil('trash statistics to refresh after the selected deletion', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('.recovery-stats-card')).find(card => card.querySelector('.recovery-stats-label')?.innerText === '回收站')?.querySelector('strong')?.innerText === '1 项'`,
  ))
  assert.ok(cdp.networkRequests.slice(beforeTrashDelete).some(request => request.method === 'DELETE' && new URL(request.url).pathname.endsWith('/api/workspace/trash')))
  assert.equal(await readFile(path.join(trashDirectory, retainedEntry.id, 'entry.json')).catch(error => error.code), 'ENOENT')
  await access(path.join(trashDirectory, retainedAfterFailureEntry.id, 'entry.json'))

  const failedDeleteManifest = {
    ...retainedAfterFailureEntry.manifest,
    state: 'staging',
  }
  await writeFile(retainedAfterFailureEntry.manifestPath, JSON.stringify(failedDeleteManifest, null, 2))
  const beforeFailedDelete = cdp.networkRequests.length
  await clickExactAriaButton(`永久删除 ${retainedAfterFailureName}`)
  await clickConfirmButton('永久删除')
  await waitUntil('failed permanent deletion to report a clear error', () => cdp.evaluate(`document.body.innerText.includes('永久删除回收站项目失败：')`))
  await waitUntil('trash list and stats to refresh after a failed deletion', () => {
    const requests = cdp.networkRequests.slice(beforeFailedDelete)
    const deleted = requests.some(request => request.method === 'DELETE' && new URL(request.url).pathname.endsWith('/api/workspace/trash'))
    const listRefresh = requests.some(request => request.method === 'GET' && new URL(request.url).pathname.endsWith('/api/workspace/trash'))
    const statsRefresh = requests.some(request => request.method === 'GET' && new URL(request.url).pathname.endsWith('/api/workspace/recovery/stats'))
    return deleted && listRefresh && statsRefresh
  })
  await waitUntil('failed deletion confirmation to close', async () => !await hasVisibleConfirmation())
  await waitUntil('failed deletion to leave the item listed with refreshed count', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.innerText.includes('回收站'));
    const count = Array.from(document.querySelectorAll('.recovery-stats-card')).find(card => card.querySelector('.recovery-stats-label')?.innerText === '回收站')?.querySelector('strong')?.innerText;
    return modal?.innerText.includes(${JSON.stringify(retainedAfterFailureName)}) && count === '1 项';
  })()`))

  await writeFile(retainedAfterFailureEntry.manifestPath, JSON.stringify(retainedAfterFailureEntry.manifest, null, 2))
  await clickExactAriaButton(`永久删除 ${retainedAfterFailureName}`)
  await clickConfirmButton('永久删除')
  await waitUntil('final trash deletion confirmation to close', async () => !await hasVisibleConfirmation())
  await waitUntil('final test trash item to be removed', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.innerText.includes('回收站'));
    const count = Array.from(document.querySelectorAll('.recovery-stats-card')).find(card => card.querySelector('.recovery-stats-label')?.innerText === '回收站')?.querySelector('strong')?.innerText;
    return !modal?.innerText.includes(${JSON.stringify(retainedAfterFailureName)}) && count === '0 项';
  })()`))
  assert.equal(await readFile(path.join(trashDirectory, retainedAfterFailureEntry.id, 'entry.json')).catch(error => error.code), 'ENOENT')

  await switchWorkspace('workspace-b')
  const workspaceBInitialView = await cdp.evaluate(`JSON.stringify({
    workspace: JSON.parse(localStorage.getItem('editor_workspace_info') || 'null')?.workspace || '',
    visibleTrashModals: Array.from(document.querySelectorAll('.ant-modal')).filter(modal => {
      const style = getComputedStyle(modal);
      return modal.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
    }).map(modal => modal.innerText),
    visibleTrashRows: Array.from(document.querySelectorAll('.trash-item-row')).filter(row => {
      const style = getComputedStyle(row);
      return row.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
    }).map(row => row.innerText),
    visiblePermanentDeleteButtons: Array.from(document.querySelectorAll('button')).filter(button => {
      const style = getComputedStyle(button);
      return button.getAttribute('aria-label')?.startsWith('永久删除') && button.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0 && !button.disabled;
    }).map(button => button.getAttribute('aria-label')),
  })`)
  const initialView = JSON.parse(workspaceBInitialView)
  assert.equal(path.basename(initialView.workspace), 'workspace-b')
  const visibleOldTrash = [
    ...initialView.visibleTrashModals,
    ...initialView.visibleTrashRows,
    ...initialView.visiblePermanentDeleteButtons,
  ].filter(value => [expiredName, retainedName, retainedAfterFailureName].some(name => String(value).includes(name)))
  assert.deepEqual(visibleOldTrash, [], `workspace B must not display or enable workspace A trash actions in its first view: ${workspaceBInitialView}`)
  await openTrash()
  await waitUntil('workspace B recovery statistics to replace workspace A statistics', () => cdp.evaluate(`Array.from(document.querySelectorAll('.recovery-stats-card')).length === 3 && Array.from(document.querySelectorAll('.recovery-stats-card')).every(card => card.querySelector('strong')?.innerText === '0 项')`))
  const workspaceBStats = await readWorkspaceRecoveryStats()
  assert.equal(workspaceBStats.status, 200)
  assert.equal(workspaceBStats.data.total.items, 0, 'workspace B must not display workspace A recovery records')
  assert.ok(!await cdp.evaluate(`document.querySelector('.ant-modal')?.innerText.includes(${JSON.stringify(firstFile)})`))
  // Leave the isolated backend on the suite's default workspace for the next
  // test; its startup context is deliberately refreshed from this selection.
  await switchWorkspace('notes')
})

test('an external disk edit is detected before the browser can overwrite it', async () => {
  await openFile(firstFile, firstSeed)
  const externalVersion = `${firstSeed}\nExternal editor update`
  await writeFile(path.join(workspace, firstFile), externalVersion)

  const localToken = `LOCAL-AFTER-EXTERNAL-${Date.now()}`
  await insertAtDocumentEnd(localToken)
  await waitUntil('browser to report external-file conflict', () => cdp.evaluate(
    `document.querySelector('.file-conflict-banner')?.innerText.includes('磁盘文件已变化')`,
  ), 9000)

  const diskContent = await readFile(path.join(workspace, firstFile), 'utf8')
  assert.equal(diskContent, externalVersion, 'external disk bytes must remain untouched')
  assert.ok(await cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(localToken)})`), 'the local draft must stay visible')

  await clickVisibleButton('查看磁盘版本')
  await waitUntil('side-by-side conflict comparison to open', () => cdp.evaluate(`(() => {
    return Array.from(document.querySelectorAll('.ant-modal')).some(modal =>
      modal.querySelector('[aria-label="本地草稿内容"]')?.value.includes(${JSON.stringify(localToken)}) &&
      modal.querySelector('[aria-label="当前磁盘版本内容"]')?.value.includes('External editor update'));
  })()`))

  const latestExternalVersion = `${externalVersion}\nSecond external update`
  await writeFile(path.join(workspace, firstFile), latestExternalVersion)
  await clickVisibleButton('覆盖磁盘并保存本地草稿')
  await clickVisibleButton('确认并保存本地草稿')
  await waitUntil('comparison to refresh after disk changes during review', () => cdp.evaluate(`(() => {
    const disk = document.querySelector('[aria-label="当前磁盘版本内容"]')?.value || '';
    return disk.includes('Second external update');
  })()`))
  assert.equal(await readFile(path.join(workspace, firstFile), 'utf8'), latestExternalVersion, 'a changed revision must stop the local write')
  await waitUntil('stale-revision confirmation to finish closing', () => cdp.evaluate(
    `!document.querySelector('.ant-modal-confirm')`,
  ))

  await clickVisibleButton('覆盖磁盘并保存本地草稿')
  await clickVisibleButton('确认并保存本地草稿')
  try {
    await waitUntil('reviewed local draft to save with a fresh compare-and-swap revision', async () => {
      const content = await readFile(path.join(workspace, firstFile), 'utf8')
      const hasConflict = await cdp.evaluate(`document.body.innerText.includes('内容冲突待处理')`)
      return content.includes(localToken) && !hasConflict ? content : null
    })
  } catch (error) {
    const disk = await readFile(path.join(workspace, firstFile), 'utf8').catch(() => '<unreadable>')
    const browserState = await cdp.evaluate(`JSON.stringify({
      body: document.body.innerText.slice(-1500),
      modals: Array.from(document.querySelectorAll('.ant-modal')).map(modal => modal.innerText),
      local: document.querySelector('[aria-label="本地草稿内容"]')?.value,
      disk: document.querySelector('[aria-label="当前磁盘版本内容"]')?.value,
    })`).catch(cdpError => `inspection failed: ${cdpError.message}`)
    throw new Error(`${error.message}\nDisk bytes: ${disk}\nBrowser state: ${browserState}`)
  }
  const resolved = await readFile(path.join(workspace, firstFile), 'utf8')
  assert.ok(resolved.includes(localToken))
  assert.ok(!resolved.includes('Second external update'), 'choosing the local version intentionally replaces the current content')
})

test('a renderer crash restores the throttled draft without writing it blindly', async () => {
  const inspectCrashState = async (connection, inspectedTargetId) => {
    const disk = await readFile(path.join(workspace, firstFile), 'utf8').catch(() => '<unreadable>')
    const targets = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/list`).then(response => response.json()).catch(() => [])
    const target = targets.find(item => item.id === inspectedTargetId)
    const page = connection
      ? await Promise.race([
        connection.evaluate(`JSON.stringify({ url: location.href, status: document.querySelector('.save-status')?.innerText || '', source: document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() || '', editor: document.querySelector('.ProseMirror')?.innerText || '' })`).catch(error => `unavailable: ${error.message}`),
        new Promise(resolve => setTimeout(() => resolve('renderer did not answer within 500ms'), 500)),
      ])
      : 'closed'
    return {
      disk,
      chromePid: chromeProcess.pid,
      targetExists: Boolean(target),
      targetUrl: target?.url || null,
      page,
      requests: connection?.networkRequests?.filter(request => request.method === 'PUT') || [],
    }
  }
  const installSaveTimerProbe = connection => connection.evaluate(`(() => {
    const original = window.setTimeout.bind(window);
    window.__saveTimerProbe = [];
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 3000) window.__saveTimerProbe.push(new Error('save timer scheduled').stack);
      return original(callback, delay, ...args);
    };
  })()`)
  await openFile(firstFile, firstSeed)
  await installSaveTimerProbe(cdp)
  await cdp.evaluate(`document.querySelector('[aria-label="切换到源码编辑"]')?.click()`)
  await waitUntil('source editor to open before the crash test', () => cdp.evaluate(`Boolean(document.querySelector('.source-editor .cm-content'))`))
  const token = `CRASH-RECOVERY-${Date.now()}`
  await insertAtSourceEnd(token)
  await waitUntil('draft snapshot to reach local storage before autosave', () => cdp.evaluate(`(() => {
    const key = Object.keys(localStorage).find(item => item.startsWith('editor_pending_drafts:'));
    if (!key) return false;
    try {
      const stored = JSON.parse(localStorage.getItem(key));
      return Boolean(stored?.drafts?.[${JSON.stringify(firstFile)}]?.content?.includes(${JSON.stringify(token)}));
    } catch { return false; }
  })()`))

  const crashedSessionId = await cdp.evaluate(`sessionStorage.getItem('editor_draft_tab_session')`)
  const beforeCrash = await inspectCrashState(cdp, targetId)
  const oldPageTimers = await cdp.evaluate(`JSON.stringify(window.__saveTimerProbe || [])`)
  const crashCommandPromise = cdp.send('Page.crash').then(() => 'acknowledged').catch(error => `rejected: ${error.message}`)
  const crashCommand = await Promise.race([
    crashCommandPromise,
    new Promise(resolve => setTimeout(() => resolve('no response within 750ms'), 750)),
  ])
  await new Promise(resolve => setTimeout(resolve, 250))
  const afterCrash = await inspectCrashState(cdp, targetId)
  assert.equal(afterCrash.disk, firstSeed, `the old renderer must not save during the crash; state: ${JSON.stringify(afterCrash)}`)
  assert.ok(!String(afterCrash.page).startsWith('{"url"'), `Page.crash must leave the renderer unresponsive before closing it: ${afterCrash.page}`)
  cdp.close()
  const closeResponse = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/close/${targetId}`).catch(() => null)
  const closeStatus = closeResponse ? `${closeResponse.status} ${await closeResponse.text()}` : 'request failed'
  await waitUntil('crashed target to close', async () => {
    const targets = await fetch(`http://127.0.0.1:${chromeDebugPort}/json/list`).then(response => response.json()).catch(() => [])
    return !targets.some(item => item.id === targetId)
  })
  const afterClose = { ...(await inspectCrashState(null, targetId)), closeStatus }
  assert.equal(afterClose.targetExists, false, `the old renderer target must be gone before recovery: ${JSON.stringify(afterClose)}`)
  assert.ok(closeStatus.startsWith('200 '), `Chrome should close the crashed renderer target: ${closeStatus}`)
  cdp = await createPageTarget({ sessionId: crashedSessionId })
  promoteTarget(cdp)
  await setupPage(cdp)
  await installSaveTimerProbe(cdp)
  const beforeOpen = await inspectCrashState(cdp, targetId)
  await openFile(firstFile, token, cdp)
  const afterOpen = await inspectCrashState(cdp, targetId)
  const recoveredPageTimers = await cdp.evaluate(`JSON.stringify(window.__saveTimerProbe || [])`)

  assert.equal(afterOpen.disk, firstSeed, `recovery must not issue an automatic PUT; states: ${JSON.stringify({ crashCommand, beforeCrash, afterCrash, afterClose, beforeOpen, afterOpen })}`)
  assert.equal(JSON.parse(recoveredPageTimers).length, 0, `rendering a recovered draft must not schedule autosave: ${recoveredPageTimers}`)
  assert.match(await cdp.evaluate(`document.querySelector('.save-status')?.innerText || ''`), /修改待保存/)
  await new Promise(resolve => setTimeout(resolve, 3300))
  const afterRecoveryWindow = await inspectCrashState(cdp, targetId)
  console.log('CRASH_RECOVERY_DIAGNOSTICS ' + JSON.stringify({
    crashCommand,
    chromePid: beforeCrash.chromePid,
    oldTargetListedAfterCrash: afterCrash.targetExists,
    rendererResponsiveAfterCrash: String(afterCrash.page).startsWith('{"url"'),
    closeStatus,
    oldPagePutRequests: beforeCrash.requests,
    recoveredPagePutRequests: afterRecoveryWindow.requests,
    oldPageSaveTimers: JSON.parse(oldPageTimers).length,
    recoveredPageSaveTimers: JSON.parse(recoveredPageTimers).length,
    diskAt: [beforeCrash.disk, afterCrash.disk, afterClose.disk, beforeOpen.disk, afterOpen.disk, afterRecoveryWindow.disk],
  }))
  assert.deepEqual(afterRecoveryWindow.requests, [], 'recovered content must not trigger an automatic PUT')
  assert.equal(afterRecoveryWindow.disk, firstSeed, `a restored draft stays local until a deliberate save; states: ${JSON.stringify({ crashCommand, beforeCrash, afterCrash, afterClose, beforeOpen, afterOpen, afterRecoveryWindow })}`)
})

test('orphan history can be previewed, restored without silent overwrite, and explicitly deleted', async () => {
  const token = Date.now()
  const orphanFile = `orphan-${token}.md`
  const orphanSeed = `Orphan source seed ${token}`
  const editToken = `ORPHAN-HISTORY-${token}`
  const restoredPath = `restored-${token}.md`
  await writeFile(path.join(workspace, orphanFile), orphanSeed)
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitUntil('editor to reload after creating the orphan test file', () => pageIsReady())
  await waitUntil('orphan test file in the workspace tree', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(orphanFile)})`,
  ))
  await openFile(orphanFile, orphanSeed)
  await insertAtSourceEnd(`\n${editToken}`)
  await clickAriaButton('保存当前文件')
  await waitUntil('edited content to save and create a history version', async () => {
    const disk = await readFile(path.join(workspace, orphanFile), 'utf8').catch(() => '')
    const history = await readWorkspaceHistory(orphanFile)
    return disk.includes(editToken) && history.status === 200 && history.data.history?.length > 0
  })
  await moveFileToTrash(orphanFile)
  assert.equal(await readFile(path.join(workspace, orphanFile)).catch(error => error.code), 'ENOENT')

  await openTrash()
  await waitUntil('orphan history manager to show its count', () => cdp.evaluate(
    `Boolean(Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === '管理已删除文件历史')?.innerText.includes('1'))`,
  ))
  await clickAriaButton('管理已删除文件历史')
  await waitUntil('deleted file history to show its path, version count, and path state', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes('已删除文件的历史版本'));
    return modal?.innerText.includes(${JSON.stringify(orphanFile)}) && modal?.innerText.includes('1 个版本') && modal?.innerText.includes('原路径不存在');
  })()`))

  await clickVisibleButton('查看版本')
  await waitUntil('archived version actions to appear', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('button')).some(button => button.innerText.trim() === '预览内容')`,
  ))
  await clickVisibleButton('预览内容')
  await waitUntil('orphan history preview to contain the original Markdown', () => cdp.evaluate(
    `document.querySelector('textarea[aria-label="孤儿历史预览 ${orphanFile}"]')?.value.includes(${JSON.stringify(orphanSeed)})`,
  ))

  await clickVisibleButton('恢复此版本…')
  const restoreInputLabel = `恢复目标路径 ${orphanFile}`
  const setRestorePath = async value => cdp.evaluate(`(() => {
    const input = document.querySelector('input[aria-label=${JSON.stringify(restoreInputLabel)}]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value === ${JSON.stringify(value)};
  })()`)

  assert.equal(await setRestorePath(secondFile), true)
  const beforeOverwriteAttempt = cdp.networkRequests.length
  await clickVisibleButton('恢复到此路径')
  await waitUntil('restoring over an existing document to require explicit confirmation', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('.ant-modal-confirm')).some(dialog => dialog.innerText.includes('覆盖当前文件') && dialog.innerText.includes(${JSON.stringify(secondFile)}))`,
  ))
  assert.equal(cdp.networkRequests.slice(beforeOverwriteAttempt).filter(request =>
    request.method === 'POST' && new URL(request.url).pathname.endsWith('/api/workspace/recovery/history/restore'),
  ).length, 0, 'an existing target must not be restored before explicit confirmation')
  await cancelVisibleConfirmation()
  await waitUntil('overwrite confirmation to close after cancel', async () => !await hasVisibleConfirmation())
  assert.equal(await readFile(path.join(workspace, secondFile), 'utf8'), secondSeed)

  assert.equal(await setRestorePath(restoredPath), true)
  const beforeNewPathRestore = cdp.networkRequests.length
  await clickVisibleButton('恢复到此路径')
  await waitUntil('orphan version restore to finish', () => cdp.evaluate(
    `document.body.innerText.includes(${JSON.stringify(`已将历史版本恢复到 ${restoredPath}`)})`,
  ))
  assert.equal(await readFile(path.join(workspace, restoredPath), 'utf8'), orphanSeed)
  assert.ok(cdp.networkRequests.slice(beforeNewPathRestore).some(request =>
    request.method === 'POST' && new URL(request.url).pathname.endsWith('/api/workspace/recovery/history/restore'),
  ), 'restoring to a new path should use the guarded recovery endpoint')

  await clickExactAriaButton(`永久删除孤儿历史 ${orphanFile}`)
  await waitUntil('orphan history delete confirmation to explain the permanent effect', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('.ant-modal-confirm')).some(dialog => dialog.innerText.includes('1 个历史版本') && dialog.innerText.includes('无法恢复'))`,
  ))
  await clickConfirmButton('永久删除这些历史')
  await waitUntil('orphan history delete confirmation to close', async () => !await hasVisibleConfirmation())
  await waitUntil('orphan history to disappear only after confirmation', () => cdp.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes('已删除文件的历史版本'));
    return modal?.innerText.includes('当前没有孤儿历史');
  })()`))
  assert.equal(await readFile(path.join(workspace, restoredPath), 'utf8'), orphanSeed, 'deleting orphan history must not delete the restored workspace file')
})
