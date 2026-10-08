import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, truncate, writeFile } from 'node:fs/promises'
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

// Seed a recorded interruption, including exact native identities and bytes,
// rather than relying on a timing-dependent process termination in a UI test.
async function seedPendingTrashFile(fileName, content) {
  const hash = value => createHash('sha256').update(value).digest('hex')
  const id = randomUUID()
  const source = path.join(workspace, fileName)
  await writeFile(source, content, { mode: 0o600 })
  const sourceStat = await lstat(source, { bigint: true })
  const mode = Number(sourceStat.mode & 0o777n)
  const entryDirectory = path.join(tempRoot, 'recovery', 'trash', hash(await realpath(workspace)), id)
  const payload = path.join(entryDirectory, 'payload')
  const quarantine = path.join(workspace, `.trash-pending-${id}`)
  await mkdir(entryDirectory, { recursive: true, mode: 0o700 })
  await writeFile(payload, content, { mode: 0o600 })
  await chmod(payload, mode)
  const payloadStat = await lstat(payload, { bigint: true })
  const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), type: 'file', mode: Number(stat.mode & 0o777n) })
  await rename(source, quarantine)
  const createdAt = new Date().toISOString()
  await writeFile(path.join(entryDirectory, 'entry.json'), JSON.stringify({
    version: 1, id, workspaceId: hash(await realpath(workspace)), originalPath: fileName,
    type: 'file', state: 'ready', createdAt,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    sourceRemoval: {
      version: 1, phase: 'quarantined', sourceQuarantinePath: `.trash-pending-${id}`,
      sourceIdentity: identity(sourceStat), payloadIdentity: identity(payloadStat),
      treeFingerprint: { entries: 1, sha256: hash(`${JSON.stringify(['', 'file', Buffer.byteLength(content), mode, hash(content)])}\n`) },
    },
  }), { mode: 0o600 })
  return { id, source, quarantine, payload }
}

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
          this.networkRequests.push({ method: request.method, url: request.url, postData: request.postData || '', observedAt: Date.now() })
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

async function workspacePickerIsClosed(connection = cdp) {
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

async function workspacePickerIsOpen(connection = cdp) {
  return connection.evaluate(`(() => {
    const root = document.querySelector('.workspace-picker-modal');
    const wrapper = root?.querySelector('.ant-modal-wrap');
    const panel = root?.querySelector('.ant-modal-content');
    const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const panelRect = panel?.getBoundingClientRect();
    return document.body.classList.contains('workspace-picker-open')
      && Boolean(wrapper && panel && panelRect?.width && panelRect?.height)
      && wrapperStyle.display !== 'none' && wrapperStyle.visibility !== 'hidden'
      && panelStyle.display !== 'none' && panelStyle.visibility !== 'hidden';
  })()`)
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

async function readHistoryButton(label, connection = cdp) {
  return connection.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(item =>
      item.getAttribute('aria-label') === ${JSON.stringify(label)} && item.getClientRects().length > 0
      && getComputedStyle(item).visibility !== 'hidden' && getComputedStyle(item).display !== 'none');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return {
      disabled: button.disabled || button.getAttribute('aria-disabled') === 'true',
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      hitIsButton: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') === button,
    };
  })()`)
}

async function clickHistoryButton(label, { touch = false, connection = cdp } = {}) {
  const point = await waitUntil(`${label} history button to be visible and enabled`, async () => {
    const state = await readHistoryButton(label, connection)
    return state && !state.disabled && state.width > 0 && state.height > 0 && state.hitIsButton ? state : null
  })
  const x = point.x + point.width / 2
  const y = point.y + point.height / 2
  if (touch) {
    await connection.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    await connection.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  return point
}

async function pressHistoryShortcut(key, { control = false, shift = false, nativeInput = false, connection = cdp } = {}) {
  const isMac = await connection.evaluate(`navigator.platform.toLowerCase().includes('mac')`)
  const platformModifier = control ? 2 : isMac ? 4 : 2
  const modifiers = platformModifier | (shift ? 8 : 0)
  const upper = key.toUpperCase()
  const keyEvent = { key: shift ? upper : key.toLowerCase(), code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers }
  const commands = nativeInput && isMac && upper === 'Z' ? [shift ? 'redo' : 'undo'] : undefined
  await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyEvent, ...(commands ? { commands } : {}) })
  await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyEvent })
}

async function setHistoryTestViewport(width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  await cdp.send('Emulation.setTouchEmulationEnabled', mobile
    ? { enabled: true, maxTouchPoints: 1 }
    : { enabled: false })

  const expectMobileLayout = width <= 768
  let previousGeometry = null
  let stablePolls = 0
  return waitUntil(`${expectMobileLayout ? 'mobile' : 'desktop'} history toolbar layout to settle`, async () => {
    const state = await cdp.evaluate(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const expectMobile = ${expectMobileLayout};
      const toolbar = document.querySelector(expectMobile ? '.mobile-toolbar' : '.editor-toolbar');
      const statusbar = document.querySelector('.editor-statusbar');
      const sidebar = document.querySelector('.workspace-sidebar');
      const responsiveReady = matchMedia('(max-width: 768px)').matches === expectMobile
        && statusbar?.classList.contains('editor-statusbar-theme-slot') === expectMobile
        && Boolean(sidebar) !== expectMobile
        && Boolean(toolbar?.getClientRects().length && getComputedStyle(toolbar).display !== 'none');
      if (!responsiveReady) return null;

      const buttons = ['撤销', '重做'].map(label => {
        const button = Array.from(toolbar.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === label);
        const rect = button?.getBoundingClientRect();
        return rect ? [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 100) / 100) : null;
      });
      const rect = toolbar.getBoundingClientRect();
      const root = document.querySelector('#editor-root');
      const signature = JSON.stringify({ toolbar: [rect.x, rect.y, rect.width, rect.height], buttons,
        rootWidth: root?.getBoundingClientRect().width, scrollWidth: document.documentElement.scrollWidth });
      return { signature };
    })()`)
    if (!state) {
      previousGeometry = null
      stablePolls = 0
      return false
    }
    stablePolls = state.signature === previousGeometry ? stablePolls + 1 : 1
    previousGeometry = state.signature
    return stablePolls >= 3 ? state : null
  })
}

async function saveHistoryReviewScreenshot(name) {
  const directory = process.env.EDITOR_REVIEW_INTERACTION_DIR
  if (!directory) return null
  await mkdir(directory, { recursive: true })
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const filePath = path.join(directory, name)
  await writeFile(filePath, Buffer.from(screenshot.data, 'base64'))
  console.log(`[EDITOR_HISTORY_SCREENSHOT] ${filePath}`)
  return filePath
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

async function readAntModalInventory(connection = cdp) {
  return connection.evaluate(`Array.from(document.querySelectorAll('.ant-modal')).map(modal => {
    const wrapper = modal.closest('.ant-modal-wrap');
    const modalStyle = getComputedStyle(modal);
    const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
    const rect = modal.getBoundingClientRect();
    const opacity = Number(modalStyle.opacity || 1) * Number(wrapperStyle?.opacity || 1);
    const visible = Boolean(rect.width && rect.height && modal.getClientRects().length)
      && modalStyle.display !== 'none' && modalStyle.visibility !== 'hidden'
      && (!wrapper || (wrapperStyle.display !== 'none' && wrapperStyle.visibility !== 'hidden'))
      && opacity > 0;
    return {
      visible,
      className: String(modal.className),
      title: modal.querySelector('.ant-modal-title')?.innerText?.trim() || '',
      text: modal.innerText || '',
      textareaValues: Array.from(modal.querySelectorAll('textarea')).map(input => input.value),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      modalVisibility: modalStyle.visibility,
      modalDisplay: modalStyle.display,
      modalOpacity: modalStyle.opacity,
      wrapperVisibility: wrapperStyle?.visibility ?? null,
      wrapperDisplay: wrapperStyle?.display ?? null,
      wrapperOpacity: wrapperStyle?.opacity ?? null,
    };
  })`)
}

async function readVisibleAntModals(connection = cdp) {
  return (await readAntModalInventory(connection)).filter(modal => modal.visible)
}

let modalEvidenceSequence = 0
async function captureAntModalEvidence(label, connection = cdp) {
  const evidenceDirectory = process.env.WORKSPACE_PICKER_EVIDENCE_DIR
  if (!evidenceDirectory) return
  await mkdir(evidenceDirectory, { recursive: true })
  const suffix = `${String(++modalEvidenceSequence).padStart(2, '0')}-${label}`
  await writeFile(path.join(evidenceDirectory, `${suffix}.json`), JSON.stringify(await readAntModalInventory(connection), null, 2))
  const screenshot = await connection.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(path.join(evidenceDirectory, `${suffix}.png`), Buffer.from(screenshot.data, 'base64'))
}

async function openTrash(connection = cdp) {
  await clickAriaButton('更多目录操作', connection)
  await clickMenuItem('回收站', connection)
  await waitUntil('visible trash modal with the expected title to open', async () =>
    (await readVisibleAntModals(connection)).some(modal => modal.title.includes('回收站')))
  await new Promise(resolve => setTimeout(resolve, 250))
  await captureAntModalEvidence('trash-modal', connection)
}

async function closeTrash(connection = cdp) {
  await connection.evaluate(`(() => {
    const modal = Array.from(document.querySelectorAll('.ant-modal')).find(item => item.querySelector('.ant-modal-title')?.innerText.includes('回收站'));
    modal?.querySelector('.ant-modal-close')?.click();
  })()`)
  await waitUntil('trash modal to close', async () =>
    !(await readVisibleAntModals(connection)).some(modal => modal.title.includes('回收站')))
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

async function switchWorkspace(targetPath) {
  assert.ok(path.isAbsolute(targetPath), `workspace switch target must be an absolute path: ${targetPath}`)
  await waitUntil('workspace change button', () => cdp.evaluate(`Boolean(document.querySelector('button[aria-label="更改目录"]')?.getBoundingClientRect().width)`))
  await cdp.evaluate(`(() => {
    document.querySelector('button[aria-label="更改目录"]')?.click();
  })()`)
  await waitUntil('directory picker overlay to open', () => workspacePickerIsOpen())

  const pickerState = () => cdp.evaluate(`(() => {
    const modal = document.querySelector('.workspace-picker-modal');
    const wrapper = modal?.querySelector('.ant-modal-wrap');
    const panel = modal?.querySelector('.ant-modal-content');
    const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const panelRect = panel?.getBoundingClientRect();
    const open = document.body.classList.contains('workspace-picker-open')
      && Boolean(wrapper && panel && panelRect?.width && panelRect?.height)
      && wrapperStyle.display !== 'none' && wrapperStyle.visibility !== 'hidden'
      && panelStyle.display !== 'none' && panelStyle.visibility !== 'hidden';
    const path = modal?.dataset.currentPath ?? null;
    const input = modal?.querySelector('input[aria-label="目录路径"]');
    const listing = modal?.querySelector('.workspace-picker-list');
    const confirm = modal?.querySelector('button[aria-label="使用当前目录"]');
    return {
      open,
      path,
      inputValue: input?.value ?? null,
      loaded: open && path !== null && listing?.getAttribute('aria-busy') !== 'true',
      canConfirm: Boolean(path === ${JSON.stringify(targetPath)} && confirm && !confirm.disabled),
    };
  })()`)

  await waitUntil('directory picker current path to load', async () => {
    const state = await pickerState()
    return state.loaded && state.path !== null && state.inputValue === state.path
  })

  const initialPickerState = await pickerState()
  if (initialPickerState.path !== targetPath) {
    const dirsBeforeTyping = cdp.networkRequests.filter(request => request.method === 'GET' && new URL(request.url).pathname === '/api/dirs').length
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.workspace-picker-modal input[aria-label="目录路径"]');
      input?.focus();
      input?.setSelectionRange(0, input.value.length);
    })()`)
    await cdp.send('Input.insertText', { text: targetPath })
    assert.equal((await pickerState()).inputValue, targetPath, 'the address field should preserve the exact backend path')
    assert.equal(await cdp.evaluate(`document.querySelector('.workspace-picker-modal button[aria-label="使用当前目录"]')?.disabled`), true, 'editing a different path must disable confirmation until GET verifies it')
    assert.equal(cdp.networkRequests.filter(request => request.method === 'GET' && new URL(request.url).pathname === '/api/dirs').length, dirsBeforeTyping, 'editing the input must not request directories before Enter')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
    await waitUntil(`GET /api/dirs to verify ${targetPath}`, async () => {
      const state = await pickerState()
      return state.loaded && state.path === targetPath && state.inputValue === targetPath
    })
    const lastDirsRequest = cdp.networkRequests.filter(request => request.method === 'GET' && new URL(request.url).pathname === '/api/dirs').at(-1)
    assert.equal(new URL(lastDirsRequest.url).searchParams.get('path'), targetPath, 'the request query must preserve the canonical target exactly')
  } else {
    assert.equal(initialPickerState.inputValue, targetPath, 'the GET-confirmed current path should remain exact when it already matches the requested workspace')
  }
  await waitUntil(`${targetPath} current path and enabled confirmation`, async () => {
    const state = await pickerState()
    return state.loaded && state.path === targetPath && state.canConfirm
  })
  await clickVisibleButton('使用此目录')
  await waitUntil(`${targetPath} workspace to load`, () => cdp.evaluate(`(() => {
    const info = JSON.parse(localStorage.getItem('editor_workspace_info') || 'null');
    return info?.workspace === ${JSON.stringify(targetPath)} && Boolean(document.querySelector('.workspace-sidebar') && document.querySelector('.tree-scroll'));
  })()`), 12000)
  await waitUntil('workspace picker close animation to finish after selection', () => workspacePickerIsClosed())
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

test('rich undo and redo shortcuts and toolbar stay document-scoped across autosave', async () => {
  await openFile(firstFile, firstSeed)
  await setHistoryTestViewport(1195, 751, false)

  const initialButtons = await Promise.all(['撤销', '重做'].map(label => readHistoryButton(label)))
  assert.deepEqual(initialButtons.map(button => button?.disabled), [true, true], 'loading a document must not create undo history')
  const desktopToolbar = await cdp.evaluate(`(() => {
    const toolbar = document.querySelector('.editor-toolbar');
    const read = label => {
      const button = Array.from(toolbar?.querySelectorAll('button') || []).find(item => item.getAttribute('aria-label') === label);
      const rect = button?.getBoundingClientRect();
      return rect && { width: rect.width, height: rect.height, visible: Boolean(button.getClientRects().length) };
    };
    return { visible: Boolean(toolbar?.getClientRects().length && getComputedStyle(toolbar).display !== 'none'), undo: read('撤销'), redo: read('重做') };
  })()`)
  assert.equal(desktopToolbar.visible, true, JSON.stringify(desktopToolbar))
  assert.ok(desktopToolbar.undo?.visible && desktopToolbar.undo.width > 0 && desktopToolbar.undo.height > 0, JSON.stringify(desktopToolbar))
  assert.ok(desktopToolbar.redo?.visible && desktopToolbar.redo.width > 0 && desktopToolbar.redo.height > 0, JSON.stringify(desktopToolbar))
  await saveHistoryReviewScreenshot('editor-history-desktop.png')

  const token = `RICH-HISTORY-${Date.now()}`
  await insertAtDocumentEnd(token)
  await waitUntil('rich history edit to appear and focus the editor', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(`${firstSeed}${token}`)}
      && document.activeElement === document.querySelector('.ProseMirror')`,
  ))
  await waitUntil('rich undo enabled and redo disabled after typing', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo && redo && !undo.disabled && redo.disabled
  })

  await pressHistoryShortcut('z')
  await waitUntil('platform undo to restore the exact rich seed once', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(firstSeed)}`,
  ))
  await waitUntil('undo state and editor focus after shortcut', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo?.disabled && !redo?.disabled && await cdp.evaluate(
      `document.activeElement === document.querySelector('.ProseMirror')`,
    )
  })

  await pressHistoryShortcut('y', { control: true })
  await waitUntil('Ctrl+Y to redo the same rich edit once', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(`${firstSeed}${token}`)}`,
  ))
  await waitUntil('redo to disable after Ctrl+Y', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return !undo?.disabled && redo?.disabled
  })

  await pressHistoryShortcut('z')
  await waitUntil('platform undo after Ctrl+Y to restore the exact rich seed once', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(firstSeed)}`,
  ))
  await pressHistoryShortcut('z', { shift: true })
  await waitUntil('platform Shift+Z redo to restore the rich edit once', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(`${firstSeed}${token}`)}`,
  ))

  const richAfterFirstStep = `${firstSeed}${token}RICH-HISTORY-STEP-ONE`
  const richAfterSecondStep = `${richAfterFirstStep}RICH-HISTORY-STEP-TWO`
  await new Promise(resolve => setTimeout(resolve, 650))
  await insertAtDocumentEnd('RICH-HISTORY-STEP-ONE')
  await waitUntil('first distinct rich typing event to append its text', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterFirstStep)}`,
  ))
  await new Promise(resolve => setTimeout(resolve, 650))
  await insertAtDocumentEnd('RICH-HISTORY-STEP-TWO')
  await waitUntil('second distinct rich typing event to append its text', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterSecondStep)}`,
  ))
  await pressHistoryShortcut('z')
  await waitUntil('one undo to remove only the second distinct rich edit', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterFirstStep)}`,
  ))
  await pressHistoryShortcut('z')
  await waitUntil('a second undo to remove only the first distinct rich edit', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(`${firstSeed}${token}`)}`,
  ))
  await pressHistoryShortcut('z', { shift: true })
  await waitUntil('one redo to restore only the first distinct rich edit', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterFirstStep)}`,
  ))
  const lastRedoAt = Date.now()
  await pressHistoryShortcut('z', { shift: true })
  await waitUntil('a second redo to restore only the second distinct rich edit', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterSecondStep)}`,
  ))
  const initiallySaved = await waitUntil('the rich redo value to autosave after the three-second debounce', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content === richAfterSecondStep ? content : null
  }, 10000)
  assert.equal(initiallySaved, richAfterSecondStep)
  assert.ok(Date.now() - lastRedoAt >= 2700, 'redo must remain a real document edit and use the normal autosave debounce')

  await clickHistoryButton('撤销')
  await waitUntil('desktop toolbar undo to restore the prior rich edit and return focus', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterFirstStep)}
      && document.activeElement === document.querySelector('.ProseMirror')`,
  ))
  await waitUntil('desktop toolbar undo to enable redo while preserving older undo history', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return !undo?.disabled && !redo?.disabled
  })
  assert.equal(await waitUntil('desktop toolbar undo value to autosave', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content === richAfterFirstStep ? content : null
  }, 10000), richAfterFirstStep)

  await clickHistoryButton('重做')
  await waitUntil('desktop toolbar redo to restore the rich edit and editor focus', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterSecondStep)}
      && document.activeElement === document.querySelector('.ProseMirror')`,
  ))
  await waitUntil('desktop toolbar redo to disable after restoring the edit', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return !undo?.disabled && redo?.disabled
  })
  assert.equal(await waitUntil('desktop toolbar redo value to autosave', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content === richAfterSecondStep ? content : null
  }, 10000), richAfterSecondStep)

  const mobileLayout = await setHistoryTestViewport(390, 844, true)
  const mobileToolbarGeometry = await cdp.evaluate(`(() => {
    const toolbar = document.querySelector('.mobile-toolbar');
    const rect = toolbar?.getBoundingClientRect();
    const buttons = ['撤销', '重做'].map(label => {
      const button = Array.from(toolbar?.querySelectorAll('button') || []).find(item => item.getAttribute('aria-label') === label);
      const box = button?.getBoundingClientRect();
      return box && { width: box.width, height: box.height, left: box.left, right: box.right, visible: Boolean(button.getClientRects().length) };
    });
    return { viewportWidth: innerWidth, toolbarVisible: Boolean(toolbar?.getClientRects().length), toolbarWidth: rect?.width,
      toolbarScrollWidth: toolbar?.scrollWidth, toolbarClientWidth: toolbar?.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
      rootScrollWidth: document.querySelector('#editor-root')?.scrollWidth, rootClientWidth: document.querySelector('#editor-root')?.clientWidth,
      buttons };
  })()`)
  assert.ok(mobileLayout?.signature, 'mobile layout geometry should settle before touch input')
  assert.equal(mobileToolbarGeometry.toolbarVisible, true, JSON.stringify(mobileToolbarGeometry))
  assert.ok(mobileToolbarGeometry.toolbarWidth > 0, JSON.stringify(mobileToolbarGeometry))
  assert.ok(mobileToolbarGeometry.buttons.every(button => button?.visible && button.width >= 44 && button.height >= 44), JSON.stringify(mobileToolbarGeometry))
  assert.ok(mobileToolbarGeometry.buttons.every(button => button.left >= 0 && button.right <= mobileToolbarGeometry.viewportWidth + 1), JSON.stringify(mobileToolbarGeometry))
  assert.ok(mobileToolbarGeometry.documentScrollWidth <= mobileToolbarGeometry.viewportWidth + 1
    && mobileToolbarGeometry.bodyScrollWidth <= mobileToolbarGeometry.viewportWidth + 1
    && mobileToolbarGeometry.rootScrollWidth <= mobileToolbarGeometry.rootClientWidth + 1
    && mobileToolbarGeometry.toolbarScrollWidth <= mobileToolbarGeometry.toolbarClientWidth + 1,
  `mobile history toolbar must not introduce horizontal overflow: ${JSON.stringify(mobileToolbarGeometry)}`)
  await saveHistoryReviewScreenshot('editor-history-mobile.png')

  await clickHistoryButton('撤销', { touch: true })
  await waitUntil('one real mobile toolbar touch to undo only the last edit and restore editor focus', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterFirstStep)}
      && document.activeElement === document.querySelector('.ProseMirror')`,
  ))
  await waitUntil('mobile undo to retain older undo and expose redo', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return !undo?.disabled && !redo?.disabled
  })
  assert.equal(await waitUntil('mobile toolbar undo value to autosave', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content === richAfterFirstStep ? content : null
  }, 10000), richAfterFirstStep)

  await clickHistoryButton('重做', { touch: true })
  await waitUntil('one real mobile toolbar touch to redo and restore editor focus', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterSecondStep)}
      && document.activeElement === document.querySelector('.ProseMirror')`,
  ))
  await waitUntil('mobile redo to update toolbar availability', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return !undo?.disabled && redo?.disabled
  })
  assert.equal(await waitUntil('mobile toolbar redo value to autosave', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content === richAfterSecondStep ? content : null
  }, 10000), richAfterSecondStep)

  await pressHistoryShortcut('z')
  await waitUntil('undo before branching rich history to restore only the final edit', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterFirstStep)}`,
  ))
  await waitUntil('an undone rich edit to expose its redo branch before new input', async () => {
    const redo = await readHistoryButton('重做')
    return redo && !redo.disabled
  })
  const branchToken = 'RICH-HISTORY-BRANCH'
  const richAfterBranch = `${richAfterFirstStep}${branchToken}`
  await insertAtDocumentEnd(branchToken)
  await waitUntil('a new real rich edit to replace the previous redo branch', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(richAfterBranch)}`,
  ))
  await waitUntil('new rich input to clear redo after undo', async () => {
    const redo = await readHistoryButton('重做')
    return redo?.disabled
  })
  await pressHistoryShortcut('z', { shift: true })
  await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  assert.equal(await cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText`), richAfterBranch,
    'redo after a new edit must not restore the abandoned branch')
  assert.equal((await readHistoryButton('重做'))?.disabled, true,
    'the redo button must remain disabled after the abandoned-branch shortcut')
  assert.equal(await waitUntil('branched rich edit to autosave without the abandoned redo', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content === richAfterBranch ? content : null
  }, 10000), richAfterBranch)

  await setHistoryTestViewport(1195, 751, false)
  await openFile(secondFile, secondSeed)
  await waitUntil('loading the second rich document to clear the first document history', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo?.disabled && redo?.disabled
      && await cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(secondSeed)}`)
  })
  await cdp.evaluate(`document.querySelector('.ProseMirror')?.focus()`)
  await waitUntil('second document editor to own keyboard focus', () => cdp.evaluate(
    `document.activeElement === document.querySelector('.ProseMirror')`,
  ))
  await pressHistoryShortcut('z')
  await waitUntil('undo in a freshly loaded second document to leave its contents intact', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(secondSeed)}`,
  ))
  await waitUntil('fresh document history buttons to stay disabled', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo?.disabled && redo?.disabled
  })

  const searchInput = await cdp.evaluate(`(() => {
    const input = document.querySelector('.sidebar-search input');
    input?.focus();
    return Boolean(input);
  })()`)
  assert.equal(searchInput, true, 'the file search input should exist on desktop')
  const searchText = `history-search-${Date.now()}`
  await cdp.send('Input.insertText', { text: searchText })
  await waitUntil('real typing to update the file search input', () => cdp.evaluate(
    `document.querySelector('.sidebar-search input')?.value === ${JSON.stringify(searchText)}`,
  ))
  await cdp.evaluate(`(() => {
    const search = document.querySelector('.sidebar-search input');
    window.__searchHistoryKeyEvents = [];
    window.__searchHistoryKeyHandler = event => {
      if (event.key.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey)) return;
      const record = {
        key: event.key,
        trusted: event.isTrusted,
        targetIsSearch: event.target === search,
        defaultPrevented: null,
      };
      window.__searchHistoryKeyEvents.push(record);
      queueMicrotask(() => { record.defaultPrevented = event.defaultPrevented; });
    };
    document.addEventListener('keydown', window.__searchHistoryKeyHandler, true);
    return Boolean(search);
  })()`)
  await pressHistoryShortcut('z', { nativeInput: true })
  await waitUntil('search input undo to restore its own empty value', () => cdp.evaluate(
    `document.querySelector('.sidebar-search input')?.value === ''`,
  ))
  assert.equal(await cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText`), secondSeed,
    'undo in search must not alter the document')
  await pressHistoryShortcut('z', { shift: true, nativeInput: true })
  await waitUntil('search input redo to restore its own text', () => cdp.evaluate(
    `document.querySelector('.sidebar-search input')?.value === ${JSON.stringify(searchText)}`,
  ))
  assert.equal(await cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText`), secondSeed,
    'redo in search must not alter the document')
  const inputHistoryEvents = await waitUntil('native search undo and redo key events to finish propagation', () => cdp.evaluate(`(() => {
    const events = window.__searchHistoryKeyEvents || [];
    return events.length === 2 && events.every(event => event.defaultPrevented !== null) ? events : null;
  })()`))
  assert.ok(inputHistoryEvents.every(event => event.targetIsSearch && event.defaultPrevented === false && event.trusted),
    `search shortcuts must remain unhandled by the document and default input editor: ${JSON.stringify(inputHistoryEvents)}`)
  await cdp.evaluate(`document.removeEventListener('keydown', window.__searchHistoryKeyHandler, true)`)
  await new Promise(resolve => setTimeout(resolve, 3300))
  assert.equal(await readFile(path.join(workspace, firstFile), 'utf8'), richAfterBranch)
  assert.equal(await readFile(path.join(workspace, secondFile), 'utf8'), secondSeed,
    'document and search history in B must not write A history into the second file')
})

test('source undo and redo preserve exact bytes and loaded source has no history', async () => {
  const original = '# Source history fixture\n\n## Source body\n\nTwo spaces stay here.  '
  const marker = 'SOURCE-HISTORY-EDIT'
  const changed = `${original}${marker}`
  await writeFile(path.join(workspace, firstFile), original)
  await openFile(firstFile, 'Source body')
  const firstFileAlreadyUsesSource = await cdp.evaluate(`Boolean(document.querySelector('.source-editor .cm-content'))`)
  if (!firstFileAlreadyUsesSource) await clickExactAriaButton('切换到源码编辑')
  await waitUntil('programmatically loaded exact source bytes', () => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(original)}`,
  ))
  await waitUntil('programmatic source load to leave both history buttons disabled', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo?.disabled && redo?.disabled
  })

  await cdp.evaluate(`(() => {
    const view = document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view;
    if (!view) return false;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();
    return true;
  })()`)
  await cdp.send('Input.insertText', { text: marker })
  await waitUntil('source edit to retain exact trailing spaces and original bytes', () => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(changed)}`,
  ))
  await waitUntil('source undo enabled after input and redo disabled', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return !undo?.disabled && redo?.disabled
  })

  await pressHistoryShortcut('z')
  await waitUntil('source shortcut undo to restore every original byte', () => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(original)}`,
  ))
  await waitUntil('source undo state to enable redo', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo?.disabled && !redo?.disabled
  })
  await pressHistoryShortcut('y', { control: true })
  await waitUntil('source Ctrl+Y redo to restore the exact edited bytes', () => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(changed)}`,
  ))

  await clickHistoryButton('撤销')
  await waitUntil('source toolbar undo to restore original bytes and CodeMirror focus', () => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(original)}
      && document.querySelector('.source-editor .cm-editor')?.classList.contains('cm-focused')`,
  ))
  await clickHistoryButton('重做')
  await waitUntil('source toolbar redo to restore edited bytes and CodeMirror focus', () => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(changed)}
      && document.querySelector('.source-editor .cm-editor')?.classList.contains('cm-focused')`,
  ))
  assert.equal(await waitUntil('source edit autosave to preserve exact original-byte content', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content === changed ? content : null
  }, 10000), changed)
  await waitUntil('source history controls to remain available after saving', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return !undo?.disabled && redo?.disabled
  })

  await pressHistoryShortcut('z')
  await waitUntil('undo after source autosave to restore original exact bytes', () => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(original)}`,
  ))
  await waitUntil('saved source undo to expose redo', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo?.disabled && !redo?.disabled
  })
  assert.equal(await waitUntil('source undo after save to persist the original exact bytes', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content === original ? content : null
  }, 10000), original)
  await pressHistoryShortcut('z', { shift: true })
  await waitUntil('redo after source autosave to restore edited exact bytes', () => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(changed)}`,
  ))
  await waitUntil('saved source redo to remain available with no redo remaining', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return !undo?.disabled && redo?.disabled
  })
  assert.equal(await waitUntil('source redo after save to persist edited exact bytes again', async () => {
    const content = await readFile(path.join(workspace, firstFile), 'utf8')
    return content === changed ? content : null
  }, 10000), changed)

  await openFile(secondFile, secondSeed)
  const secondFileAlreadyUsesSource = await cdp.evaluate(`Boolean(document.querySelector('.source-editor .cm-content'))`)
  if (!secondFileAlreadyUsesSource) await clickExactAriaButton('切换到源码编辑')
  await waitUntil('programmatic source load of another file to start with empty history', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo?.disabled && redo?.disabled
      && await cdp.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(secondSeed)}`)
  })
  await cdp.evaluate(`document.querySelector('.source-editor .cm-content')?.focus()`)
  await pressHistoryShortcut('z')
  assert.equal(await cdp.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), secondSeed,
    'undo in a programmatically loaded source file must not reach the previous source file')
  assert.equal(await readFile(path.join(workspace, secondFile), 'utf8'), secondSeed)

  await clickExactAriaButton('切换到富文本编辑')
  await waitUntil('return from source mode to render the clean rich document', () => cdp.evaluate(
    `document.querySelector('.ProseMirror')?.innerText === ${JSON.stringify(secondSeed)}`,
  ))
  await waitUntil('switching from source to rich mode to leave history empty', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo?.disabled && redo?.disabled
  })
  await cdp.evaluate(`document.querySelector('.ProseMirror')?.focus()`)
  await pressHistoryShortcut('z')
  assert.equal(await cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText`), secondSeed,
    'switching the loaded source value to rich mode must not create an undo transaction')
  assert.equal(await readFile(path.join(workspace, secondFile), 'utf8'), secondSeed)
})

test('source conflict overwrite keeps undo and redo while disk reload starts a new history', async () => {
  const original = '---\nkind: source-conflict-history\n---\n\nOriginal source.  \n'
  const saved = `${original}FIRST`
  const local = `${saved}-LOCAL`
  const redone = `${local}-REDO`
  const filePath = path.join(workspace, firstFile)
  const sourceIs = content => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(content)}`,
  )
  const typeAtEnd = async text => {
    assert.equal(await cdp.evaluate(`(() => {
      const view = document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view;
      if (!view) return false;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
      return true;
    })()`), true)
    await cdp.send('Input.insertText', { text })
  }
  const diskIs = async content => (await readFile(filePath, 'utf8')) === content
  const waitForConflict = () => waitUntil('source save conflict without overwriting external bytes', () => cdp.evaluate(
    `Boolean(document.querySelector('.file-conflict-banner'))`,
  ))

  await writeFile(filePath, original)
  await openFile(firstFile, 'Original source')
  await waitUntil('protected source to load exact bytes', () => sourceIs(original))
  await typeAtEnd('FIRST')
  await clickAriaButton('保存当前文件')
  await waitUntil('ordinary source save to persist exact bytes', () => diskIs(saved))
  assert.equal((await readHistoryButton('撤销')).disabled, false, 'ordinary save must retain history')

  // Separate native history groups, leaving both undo and redo available when
  // the conflict is resolved. All edits use actual browser keyboard input.
  await new Promise(resolve => setTimeout(resolve, 600))
  await typeAtEnd('-LOCAL')
  await new Promise(resolve => setTimeout(resolve, 600))
  await typeAtEnd('-REDO')
  await pressHistoryShortcut('z')
  await waitUntil('undo of the latest source edit to leave a local draft', () => sourceIs(local))
  await waitUntil('source history to contain both undo and redo before conflict', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo && redo && !undo.disabled && !redo.disabled
  })
  await cdp.evaluate(`(() => {
    window.__sourceBeforeConflict = document.querySelector('.source-editor .cm-content').cmTile.root.view;
    return true;
  })()`)
  const external = `${original}EXTERNAL`
  await writeFile(filePath, external)
  await clickAriaButton('保存当前文件')
  await waitForConflict()
  assert.equal(await readFile(filePath, 'utf8'), external)
  await clickVisibleButton('查看磁盘版本')
  await waitUntil('comparison to show the exact source draft and external version', () => cdp.evaluate(
    `document.querySelector('[aria-label="本地草稿内容"]')?.value === ${JSON.stringify(local)}
      && document.querySelector('[aria-label="当前磁盘版本内容"]')?.value === ${JSON.stringify(external)}`,
  ))
  await clickVisibleButton('覆盖磁盘并保存本地草稿')
  await clickVisibleButton('确认并保存本地草稿')
  await waitUntil('conflict overwrite to save local bytes and become clean', async () =>
    await diskIs(local) && await cdp.evaluate(
      `document.querySelector('.save-status')?.innerText === '已保存' && !document.querySelector('.file-conflict-banner')`,
    ),
  )
  const historyAfterSave = await cdp.evaluate(`({
    sameView: window.__sourceBeforeConflict === document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view,
    undoDisabled: document.querySelector('button[aria-label="撤销"]')?.disabled,
    redoDisabled: document.querySelector('button[aria-label="重做"]')?.disabled,
  })`)
  assert.deepEqual(historyAfterSave, { sameView: true, undoDisabled: false, redoDisabled: false },
    'saving the reviewed source draft must retain its editor and both native history branches')
  await saveHistoryReviewScreenshot('source-conflict-history-after-save.png')

  await cdp.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.focus()`)
  await pressHistoryShortcut('z')
  await waitUntil('shortcut undo after conflict save to restore the earlier edit', () => sourceIs(saved))
  await waitUntil('undo after conflict save to autosave with the new revision', () => diskIs(saved))
  await pressHistoryShortcut('z', { shift: true })
  await waitUntil('shortcut redo after conflict save to restore local content', () => sourceIs(local))
  await clickHistoryButton('重做')
  await waitUntil('original redo branch after conflict save to remain usable', () => sourceIs(redone))
  await waitUntil('redone source bytes to autosave exactly', () => diskIs(redone))

  const replacement = `${original}DISK REPLACEMENT`
  await writeFile(filePath, replacement)
  await typeAtEnd('-DISCARD')
  await clickAriaButton('保存当前文件')
  await waitForConflict()
  await clickVisibleButton('查看磁盘版本')
  await waitUntil('reload comparison to show the latest external version and local draft', () => cdp.evaluate(
    `document.querySelector('[aria-label="本地草稿内容"]')?.value === ${JSON.stringify(`${redone}-DISCARD`)}
      && document.querySelector('[aria-label="当前磁盘版本内容"]')?.value === ${JSON.stringify(replacement)}`,
  ))
  await clickVisibleButton('丢弃草稿并重载')
  await clickConfirmButton('丢弃草稿并载入')
  await waitUntil('intentional disk reload to start a clean source history', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo?.disabled && redo?.disabled && await sourceIs(replacement)
  })
  await cdp.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.focus()`)
  await pressHistoryShortcut('z')
  assert.equal(await sourceIs(replacement), true, 'undo must not cross an intentional disk reload')
  assert.equal(await readFile(filePath, 'utf8'), replacement)
})

test('locating the current file handles selector metacharacters in POSIX paths', {
  skip: process.platform === 'win32' && 'Windows filenames cannot contain double quotes',
}, async () => {
  const directories = ['引用"与[括号]', '深层 雪国[资料]']
  const directoryPaths = directories.map((_, index) => directories.slice(0, index + 1).join('/'))
  const fileName = '报告"名 [草稿] — 中文.md'
  const relativePath = [...directories, fileName].join('/')
  const filePath = path.join(workspace, ...directories, fileName)
  const seed = 'Locate unusual filename seed'
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, seed)
  await cdp.send('Page.reload', { ignoreCache: true })
  await waitUntil('editor to reload after creating the unusual-path file', () => pageIsReady())
  const waitForFolderState = (directory, expanded) => waitUntil(
    `${directory} to finish ${expanded ? 'expanding' : 'collapsing'}`,
    () => cdp.evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]'))
        .find(node => node.getAttribute('data-path') === ${JSON.stringify(directory)});
      const row = item?.closest('.ant-tree-treenode');
      return row?.getAttribute('aria-expanded') === ${JSON.stringify(String(expanded))}
        && !document.querySelector('.ant-tree-treenode-motion');
    })()`),
  )

  for (const directory of directoryPaths) {
    await waitUntil(`${directory} to appear in the file tree`, () => cdp.evaluate(
      `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.getAttribute('data-path') === ${JSON.stringify(directory)})`,
    ))
    assert.equal(await cdp.evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]'))
        .find(node => node.getAttribute('data-path') === ${JSON.stringify(directory)});
      const row = item?.closest('.ant-tree-treenode');
      if (!row) return false;
      if (row.getAttribute('aria-expanded') !== 'true') row.querySelector('.ant-tree-switcher')?.click();
      return true;
    })()`), true, `the ${directory} folder should expand`)
    await waitForFolderState(directory, true)
  }

  await waitUntil('the expanded nested tree to render the exact file path', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]'))
      .some(item => item.getAttribute('data-path') === ${JSON.stringify(relativePath)})`,
  ))
  const renderedTreeItems = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).map(item => ({
    path: item.getAttribute('data-path'),
    text: item.innerText.trim(),
    visible: item.getClientRects().length > 0,
  }))`)
  const renderedFile = renderedTreeItems.find(item => item.path === relativePath)
  assert.ok(renderedFile, `the exact nested file path should render after expanding both folders: ${JSON.stringify(renderedTreeItems)}`)
  assert.equal(renderedFile.text, fileName, 'the tree should display the filename without selector-related truncation')
  assert.equal(renderedFile.visible, true, 'the nested filename should be visible before opening')
  await cdp.evaluate(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]'))
    .find(item => item.getAttribute('data-path') === ${JSON.stringify(relativePath)})?.click()`)
  await waitUntil(`${relativePath} content`, () => cdp.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString().includes(${JSON.stringify(seed)}) || document.querySelector('.ProseMirror[contenteditable="true"]')?.innerText.includes(${JSON.stringify(seed)})`,
  ))
  assert.equal(await cdp.evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]'))
      .find(node => node.getAttribute('data-path') === ${JSON.stringify(directoryPaths[0])});
    const row = item?.closest('.ant-tree-treenode');
    if (!row) return false;
    row.querySelector('.ant-tree-switcher')?.click();
    return true;
  })()`), true, 'the active file ancestor should collapse before locating it')
  await waitForFolderState(directoryPaths[0], false)

  assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('.document-tab'))
    .some(tab => tab.getAttribute('title') === ${JSON.stringify(relativePath)} && tab.querySelector('[role="tab"]')?.getAttribute('aria-selected') === 'true')`), true,
  'the unusual path should remain the active document before locating it')
  await cdp.evaluate(`(() => {
    window.__locateErrors = [];
    window.addEventListener('error', event => window.__locateErrors.push(event.error?.name || event.message));
    window.addEventListener('unhandledrejection', event => window.__locateErrors.push(event.reason?.name || String(event.reason)));
    window.__locateScrollKeys = [];
    window.__locateScrollCalls = [];
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      const path = this.getAttribute?.('data-path')
        || this.querySelector?.('[data-testid="file-tree-item"]')?.getAttribute('data-path');
      window.__locateScrollCalls.push({ path, className: String(this.className || ''), tagName: this.tagName });
      if (path === ${JSON.stringify(relativePath)}) {
        window.__locateScrollKeys.push(path);
      }
      return originalScrollIntoView?.apply(this, args);
    };
  })()`)
  await clickAriaButton('更多目录操作')
  await waitUntil('locate current file menu item', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).some(item => item.innerText.trim() === '定位当前文件' && item.getClientRects().length > 0 && item.getAttribute('aria-disabled') !== 'true')`,
  ))
  await clickMenuItem('定位当前文件')
  for (const directory of directoryPaths) await waitForFolderState(directory, true)
  const targetRowIsRendered = () => cdp.evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]'))
      .find(node => node.getAttribute('data-path') === ${JSON.stringify(relativePath)});
    const row = item?.closest('.ant-tree-treenode');
    return Boolean(row && row.getClientRects().length && !row.closest('.ant-tree-treenode-motion'));
  })()`)
  await waitUntil('locate to render the target as a real tree row', targetRowIsRendered)
  const isTargetInsideTreeViewport = () => cdp.evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]'))
      .find(node => node.getAttribute('data-path') === ${JSON.stringify(relativePath)});
    const row = item?.closest('.ant-tree-treenode');
    const container = row?.closest('.tree-scroll');
    if (!row || !container) return false;
    const rowRect = row.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return row.getClientRects().length > 0
      && rowRect.top >= containerRect.top
      && rowRect.bottom <= containerRect.bottom;
  })()`)
  await waitUntil('locate to place the target row inside the tree scroll viewport', isTargetInsideTreeViewport)
  const locateState = await cdp.evaluate(`(() => ({
    errors: window.__locateErrors,
    scrollKeys: window.__locateScrollKeys,
    scrollCalls: window.__locateScrollCalls,
  }))()`)
  assert.deepEqual(locateState.errors, [], `locate should not throw for selector metacharacters: ${JSON.stringify(locateState)}`)
  assert.deepEqual(locateState.scrollKeys, [relativePath], `locate should scroll the exact active path: ${JSON.stringify(locateState)}`)
  assert.equal(await isTargetInsideTreeViewport(), true, 'locate should expand the path and bring its row inside the tree scroll viewport')
  if (process.env.EDITOR_REVIEW_INTERACTION_DIR) {
    const directory = process.env.EDITOR_REVIEW_INTERACTION_DIR
    await mkdir(directory, { recursive: true })
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(path.join(directory, 'locate-unusual-path.png'), Buffer.from(screenshot.data, 'base64'))
  }
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
  await switchWorkspace(await realpath(workspaceB))
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
  assert.equal((await readHistoryButton('撤销')).disabled, false, 'saved source edits must have history before restoration')

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
  await waitUntil('history restoration to intentionally reset source undo and redo', async () => {
    const [undo, redo] = await Promise.all([readHistoryButton('撤销'), readHistoryButton('重做')])
    return undo?.disabled && redo?.disabled
  })
  await cdp.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.focus()`)
  await pressHistoryShortcut('z')
  assert.equal(await cdp.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), original,
    'undo must not restore edits from before an intentional history restoration')

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

  await switchWorkspace(await realpath(workspaceB))
  await openFile(firstFile, 'Workspace B seed')
  assert.equal(await readFile(path.join(workspaceB, firstFile), 'utf8'), 'Workspace B seed')

  await switchWorkspace(await realpath(workspace))
  await openFile(firstFile, firstSeed)
  await clickAriaButton('更多目录操作')
  await waitUntil('A recovery alternative to appear after returning from B', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).some(item => item.innerText.includes('其他恢复草稿（1）'))`,
  ))
  await clickMenuItem('其他恢复草稿（1）')
  await waitUntil('visible A recovery modal to retain the exact candidate after switching', async () =>
    (await readVisibleAntModals()).some(modal => modal.title.includes('其他本地恢复草稿')
      && modal.textareaValues.some(value => value.includes('RECOVERED-AFTER-SWITCH'))))
  await new Promise(resolve => setTimeout(resolve, 250))
  await captureAntModalEvidence('workspace-switch-recovery-candidate')
  assert.equal(await readFile(path.join(workspace, firstFile), 'utf8'), firstSeed, 'switch-back recovery must stay local until deliberately saved')
  assert.equal(await readFile(path.join(workspaceB, firstFile), 'utf8'), 'Workspace B seed', 'workspace B must never receive workspace A draft bytes')
})

test('canceling the workspace picker keeps the same tabs, draft, tree scroll, and Editor context', async t => {
  const generatedNames = Array.from({ length: 48 }, (_, index) => `picker-scroll-${String(index).padStart(2, '0')}.md`)
  t.after(async () => {
    await Promise.all(generatedNames.map(name => rm(path.join(workspace, name), { force: true })))
  })
  await switchWorkspace(await realpath(workspaceB))
  await Promise.all(generatedNames.map(name => writeFile(path.join(workspace, name), `# ${name}`)))
  await switchWorkspace(await realpath(workspace))
  await waitUntil('generated entries to fill the workspace tree', () => cdp.evaluate(
    `document.querySelectorAll('[data-testid="file-tree-item"]').length >= 50`,
  ))
  await openFile(firstFile, firstSeed)
  await openFile(secondFile, secondSeed)

  const scrollState = await cdp.evaluate(`(() => {
    const tree = document.querySelector('.tree-scroll');
    if (!tree) return null;
    tree.scrollTop = Math.floor((tree.scrollHeight - tree.clientHeight) / 2);
    return { top: tree.scrollTop, max: tree.scrollHeight - tree.clientHeight };
  })()`)
  assert.ok(scrollState.max > 0, `generated files should make the tree genuinely scrollable: ${JSON.stringify(scrollState)}`)
  assert.ok(scrollState.top > 0, `the test should start from a scrolled tree position: ${JSON.stringify(scrollState)}`)
  await cdp.evaluate(`(() => {
    window.__pickerSidebarBefore = document.querySelector('.workspace-sidebar');
    window.__pickerTreeBefore = document.querySelector('.tree-scroll');
    window.__pickerTabsBefore = document.querySelector('.document-tabs');
    window.__pickerActiveTabBefore = document.querySelector('.document-tab.is-active');
    window.__pickerEditorBefore = document.querySelector('.ProseMirror');
    window.__pickerWorkspaceInfoBefore = localStorage.getItem('editor_workspace_info');
  })()`)

  const token = `PICKER-CANCEL-DRAFT-${Date.now()}`
  const requestOffset = cdp.networkRequests.length
  const editStartedAt = Date.now()
  await insertAtDocumentEnd(token)
  await waitUntil('dirty draft to be visible in the active tab', () => cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(token)}) && document.querySelector('.document-tab.is-active [role="tab"]')?.getAttribute('aria-label')?.includes('修改待保存')`))
  await waitUntil('draft snapshot to reach browser recovery storage', () => cdp.evaluate(`(() => {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    return keys.some(key => key?.startsWith('editor_pending_drafts:') && localStorage.getItem(key)?.includes(${JSON.stringify(token)}));
  })()`), 2000)
  const currentWorkspace = await realpath(workspace)
  await clickAriaButton('更改目录')
  await waitUntil('picker overlay and canonical listing to load without leaving the editor', () => cdp.evaluate(`(() => {
    const root = document.querySelector('.workspace-picker-modal');
    const wrapper = root?.querySelector('.ant-modal-wrap');
    const panel = root?.querySelector('.ant-modal-content');
    const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const rect = panel?.getBoundingClientRect();
    const input = root?.querySelector('input[aria-label="目录路径"]');
    return document.body.classList.contains('workspace-picker-open')
      && Boolean(wrapper && panel && rect?.width && rect?.height)
      && wrapperStyle.display !== 'none' && wrapperStyle.visibility !== 'hidden'
      && panelStyle.display !== 'none' && panelStyle.visibility !== 'hidden'
      && root.dataset.currentPath === ${JSON.stringify(currentWorkspace)}
      && input?.value === ${JSON.stringify(currentWorkspace)}
      && root.querySelector('.workspace-picker-list')?.getAttribute('aria-busy') === 'false'
      && document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(token)});
  })()`))
  const pickerPath = await cdp.evaluate(`document.querySelector('.workspace-picker-modal')?.dataset.currentPath ?? null`)
  assert.equal(pickerPath, currentWorkspace, 'the overlay should start from the active canonical workspace')
  await clickAriaButton('取消选择工作目录')
  await waitUntil('picker overlay to hide after cancel', () => workspacePickerIsClosed())

  const retainedContext = await cdp.evaluate(`(() => {
    const tree = document.querySelector('.tree-scroll');
    const activeTab = document.querySelector('.document-tab.is-active');
    const source = document.querySelector('.ProseMirror');
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    return {
      sameSidebar: window.__pickerSidebarBefore === document.querySelector('.workspace-sidebar'),
      sameTreeNode: window.__pickerTreeBefore === tree,
      sameTabsNode: window.__pickerTabsBefore === document.querySelector('.document-tabs'),
      sameActiveTab: window.__pickerActiveTabBefore === activeTab,
      sameEditorNode: window.__pickerEditorBefore === source,
      activeLabel: activeTab?.querySelector('[role="tab"]')?.getAttribute('aria-label') || '',
      draftVisible: source?.innerText.includes(${JSON.stringify(token)}) || false,
      draftStored: keys.some(key => key?.startsWith('editor_pending_drafts:') && localStorage.getItem(key)?.includes(${JSON.stringify(token)})),
      treeScrollTop: tree?.scrollTop ?? null,
      workspaceInfo: localStorage.getItem('editor_workspace_info'),
    };
  })()`)
  const expectedInfo = await cdp.evaluate(`window.__pickerWorkspaceInfoBefore`)
  assert.deepEqual({
    sameSidebar: retainedContext.sameSidebar,
    sameTreeNode: retainedContext.sameTreeNode,
    sameTabsNode: retainedContext.sameTabsNode,
    sameActiveTab: retainedContext.sameActiveTab,
    sameEditorNode: retainedContext.sameEditorNode,
    draftVisible: retainedContext.draftVisible,
    treeScrollTop: retainedContext.treeScrollTop,
    workspaceInfo: retainedContext.workspaceInfo,
  }, {
    sameSidebar: true,
    sameTreeNode: true,
    sameTabsNode: true,
    sameActiveTab: true,
    sameEditorNode: true,
    draftVisible: true,
    treeScrollTop: scrollState.top,
    workspaceInfo: expectedInfo,
  }, 'cancel should preserve the active document, its tab and text, the scrolled tree, and the same workspace identity')
  assert.ok(['second.md', 'second.md，修改待保存'].includes(retainedContext.activeLabel), `the active tab should remain open whether its scheduled save has completed or not: ${retainedContext.activeLabel}`)
  await waitUntil('draft to remain in recovery storage or reach disk after cancel', async () => {
    const stored = await cdp.evaluate(`(() => {
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
      return keys.some(key => key?.startsWith('editor_pending_drafts:') && localStorage.getItem(key)?.includes(${JSON.stringify(token)}));
    })()`)
    const disk = await readFile(path.join(workspace, secondFile), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
    return stored || disk.includes(token)
  }, 5000)

  const writes = cdp.networkRequests.slice(requestOffset).filter(request => {
    const pathname = new URL(request.url).pathname
    return (request.method === 'PUT' && pathname === '/api/workspace') || (request.method === 'POST' && pathname === '/api/workspace/set')
  })
  const workspaceSetRequests = writes.filter(request => request.method === 'POST')
  assert.deepEqual(workspaceSetRequests, [], 'cancel must not submit a workspace change')
  const earlyFlushes = writes.filter(request => request.method === 'PUT' && request.observedAt - editStartedAt < 2900)
  assert.deepEqual(earlyFlushes, [], 'cancel must not force an early flush before the normal three-second autosave')
  await waitUntil('the normal autosave to persist the draft after cancel', async () => {
    const content = await readFile(path.join(workspace, secondFile), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
    return content.includes(token)
  }, 8000)
})

test('a dirty draft flush failure prevents workspace selection', async () => {
  await switchWorkspace(await realpath(workspace))
  await openFile(firstFile, firstSeed)
  const currentWorkspace = await realpath(workspace)
  const token = `PICKER-FLUSH-CONFLICT-${Date.now()}`
  await insertAtDocumentEnd(token)
  await waitUntil('draft text to reach the active editor', () => cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(token)})`))
  const externalContent = `${firstSeed}\nEXTERNAL-DISK-CHANGE-${Date.now()}`
  await writeFile(path.join(workspace, firstFile), externalContent)
  const requestOffset = cdp.networkRequests.length

  await clickAriaButton('更改目录')
  await waitUntil('picker overlay to open for a dirty draft', async () => await workspacePickerIsOpen()
    && await cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(token)})`))
  await waitUntil('current workspace to be ready for confirmation', () => cdp.evaluate(`(() => {
    const modal = document.querySelector('.workspace-picker-modal');
    return modal?.dataset.currentPath === ${JSON.stringify(currentWorkspace)}
      && modal.querySelector('.workspace-picker-list')?.getAttribute('aria-busy') !== 'true'
      && modal.querySelector('button[aria-label="使用当前目录"]')?.disabled === false;
  })()`))
  await clickAriaButton('使用当前目录')
  await waitUntil('flush conflict to report that changeover is blocked', () => cdp.evaluate(`document.body.innerText.includes('保存失败')`))
  const afterFailure = cdp.networkRequests.slice(requestOffset)
  const attemptedFlush = afterFailure.some(request => request.method === 'PUT' && new URL(request.url).pathname === '/api/workspace')
  const attemptedSet = afterFailure.some(request => request.method === 'POST' && new URL(request.url).pathname === '/api/workspace/set')
  assert.equal(attemptedFlush, true, 'confirmation should attempt to flush the dirty draft before changing context')
  assert.equal(attemptedSet, false, 'a failed flush must stop before POST /api/workspace/set')
  assert.equal(await readFile(path.join(workspace, firstFile), 'utf8'), externalContent, 'the conflict must not overwrite the external disk edit')
  assert.equal(await cdp.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(token)})`), true, 'the local draft should remain visible after the flush fails')
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.workspace-sidebar') && document.querySelector('.document-tab.is-active'))`), true, 'the current Editor and tab should remain available after a failed flush')
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
  await waitUntil('only unexpired trash entries to remain in the visible trash modal', async () => {
    const modal = (await readVisibleAntModals()).find(item => item.title.includes('回收站'))
    return modal?.text.includes(retainedName) && modal?.text.includes(retainedAfterFailureName) && !modal?.text.includes(expiredName)
  })
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
  await waitUntil('selected unexpired trash item to be removed from the visible trash modal', async () => {
    const modal = (await readVisibleAntModals()).find(item => item.title.includes('回收站'))
    return modal && !modal.text.includes(retainedName) && modal.text.includes(retainedAfterFailureName)
  })
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
  await waitUntil('failed deletion to leave the item listed with refreshed count', async () => {
    const modal = (await readVisibleAntModals()).find(item => item.title.includes('回收站'))
    const count = await cdp.evaluate(`Array.from(document.querySelectorAll('.recovery-stats-card')).find(card => card.querySelector('.recovery-stats-label')?.innerText === '回收站')?.querySelector('strong')?.innerText`)
    return modal?.text.includes(retainedAfterFailureName) && count === '1 项'
  })

  await writeFile(retainedAfterFailureEntry.manifestPath, JSON.stringify(retainedAfterFailureEntry.manifest, null, 2))
  await clickExactAriaButton(`永久删除 ${retainedAfterFailureName}`)
  await clickConfirmButton('永久删除')
  await waitUntil('final trash deletion confirmation to close', async () => !await hasVisibleConfirmation())
  await waitUntil('final test trash item to be removed', async () => {
    const modal = (await readVisibleAntModals()).find(item => item.title.includes('回收站'))
    const count = await cdp.evaluate(`Array.from(document.querySelectorAll('.recovery-stats-card')).find(card => card.querySelector('.recovery-stats-label')?.innerText === '回收站')?.querySelector('strong')?.innerText`)
    return modal && !modal.text.includes(retainedAfterFailureName) && count === '0 项'
  })
  assert.equal(await readFile(path.join(trashDirectory, retainedAfterFailureEntry.id, 'entry.json')).catch(error => error.code), 'ENOENT')

  await switchWorkspace(await realpath(workspaceB))
  const workspaceBInitialView = await cdp.evaluate(`JSON.stringify({
    workspace: JSON.parse(localStorage.getItem('editor_workspace_info') || 'null')?.workspace || '',
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
  initialView.visibleTrashModals = (await readVisibleAntModals()).filter(modal => modal.title.includes('回收站')).map(modal => modal.text)
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
  assert.equal((await readVisibleAntModals()).some(modal => modal.title.includes('回收站') && modal.text.includes(firstFile)), false, 'workspace B trash modal must not expose workspace A file recovery records')
  // Leave the isolated backend on the suite's default workspace for the next
  // test; its startup context is deliberately refreshed from this selection.
  await switchWorkspace(await realpath(workspace))
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


test('saved document remains saved while recovery cleanup warnings are visible in the trash dialog', async () => {
  await openFile(firstFile, firstSeed)
  await insertAtSourceEnd('HISTORY-WARNING-INITIAL')
  await waitUntil('initial history snapshot', async () => {
    const history = await readWorkspaceHistory(firstFile)
    return (await readFile(path.join(workspace, firstFile), 'utf8')).includes('HISTORY-WARNING-INITIAL') && history.data.history?.length
  })
  const hash = value => createHash('sha256').update(value).digest('hex')
  const bucket = path.join(tempRoot, 'recovery', 'history', hash(await realpath(workspace)), hash(firstFile))
  const invalidRecord = path.join(bucket, `${randomUUID()}.json`)
  await writeFile(invalidRecord, 'invalid history JSON')
  try {
    await insertAtSourceEnd('HISTORY-WARNING-SAVED')
    await waitUntil('committed save with a nonfatal cleanup warning', async () => {
      const stats = await readWorkspaceRecoveryStats()
      return (await readFile(path.join(workspace, firstFile), 'utf8')).includes('HISTORY-WARNING-SAVED') &&
        stats.data.maintenance?.historyCleanupWarnings?.some(warning => warning.path === firstFile)
    })
    await waitUntil('successful save status', () => cdp.evaluate(`document.querySelector('.save-status')?.innerText === '已保存'`))
    await openTrash()
    await waitUntil('cleanup warning in recovery UI', () => cdp.evaluate(`(() => {
      const notice = document.querySelector('[aria-label="恢复检查结果"]');
      return notice?.innerText.includes(${JSON.stringify(firstFile)}) && notice.innerText.includes('文档已保存，旧历史清理未完成');
    })()`))
    await saveHistoryReviewScreenshot('history-cleanup-warning.png')
    assert.equal(await cdp.evaluate(`document.querySelector('.save-status')?.innerText`), '已保存')
    await closeTrash()
    await rm(invalidRecord)
    await insertAtSourceEnd('HISTORY-WARNING-RETRY')
    await waitUntil('real save retries cleanup and clears its warning', async () => {
      const stats = await readWorkspaceRecoveryStats()
      return (await readFile(path.join(workspace, firstFile), 'utf8')).includes('HISTORY-WARNING-RETRY') &&
        !stats.data.maintenance.historyCleanupWarnings.some(warning => warning.path === firstFile)
    })
  } finally {
    await rm(invalidRecord, { force: true })
  }
})

test('pending trash recovery preserves an occupied path and restores its original through the recovery dialog', async () => {
  const fileName = `pending-recovery-${Date.now()}.md`
  const content = 'Original quarantined note'
  const pending = await seedPendingTrashFile(fileName, content)
  await writeFile(pending.source, 'Newer occupying note')
  const report = await cdp.evaluate(`(async () => {
    const info = JSON.parse(localStorage.getItem('editor_workspace_info'));
    const response = await fetch('/api/workspace/recovery/reconcile', { method: 'POST', headers: {
      'X-Workspace-Id': info.workspaceId, 'X-Workspace-Version': String(info.workspaceVersion),
    }});
    return { status: response.status, data: await response.json() };
  })()`)
  assert.equal(report.status, 200)
  assert.equal(report.data.issues.find(issue => issue.id === pending.id)?.code, 'RESTORE_PATH_OCCUPIED')
  assert.equal(await readFile(pending.source, 'utf8'), 'Newer occupying note')
  assert.equal(await readFile(pending.quarantine, 'utf8'), content)
  assert.equal(await readFile(pending.payload, 'utf8'), content)
  await openTrash()
  await waitUntil('pending entry and safe recovery actions', () => cdp.evaluate(`(() => {
    const notice = document.querySelector('[aria-label="恢复检查结果"]');
    const restore = Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(`恢复 ${fileName}`)});
    const remove = Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(`永久删除 ${fileName}`)});
    return notice?.innerText.includes(${JSON.stringify(fileName)}) && notice.innerText.includes('原路径已有内容') && restore?.disabled && remove?.disabled;
  })()`))
  await saveHistoryReviewScreenshot('trash-interruption-path-occupied.png')
  await rm(pending.source)
  await clickVisibleButton('检查并恢复中断操作')
  await waitUntil('exact original restored and pending actions released', async () => {
    const stats = await readWorkspaceRecoveryStats()
    return (await readFile(pending.source, 'utf8').catch(() => null)) === content &&
      !stats.data.maintenance.trash.issues.length &&
      await cdp.evaluate(`(() => {
        const restore = Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(`恢复 ${fileName}`)});
        return restore && !restore.disabled && document.querySelector('[aria-label="恢复检查结果"]')?.innerText.includes('已恢复上次中断操作的原项目');
      })()`)
  })
  assert.equal(await readFile(pending.payload, 'utf8'), content, 'the verified full recovery copy must remain available')
  await assert.rejects(lstat(pending.quarantine), error => error.code === 'ENOENT')
  await saveHistoryReviewScreenshot('trash-interruption-restored.png')
  await closeTrash()
  await waitUntil('restored file appears in the refreshed tree', () => cdp.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(fileName)})`,
  ))
})
