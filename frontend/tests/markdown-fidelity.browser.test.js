import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { marked } from 'marked'
import { cleanupBrowserTest } from './helpers/browser-cleanup.js'
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
    this.pauseNextWorkspaceUpload = false
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
          } else if (this.pauseNextWorkspaceUpload && request.method === 'POST' && request.url.includes('/api/workspace/upload')) {
            this.pauseNextWorkspaceUpload = false
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
  await connection.send('Emulation.setDeviceMetricsOverride', {
    width: 1195, height: 751, deviceScaleFactor: 1, mobile: false,
  })
  await connection.send('Emulation.setTouchEmulationEnabled', { enabled: false })
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
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(node => node.innerText.trim() === ${JSON.stringify(fileName)})`,
  ))
  await connection.evaluate(`(() => {
    const node = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(fileName)});
    node?.click();
    return Boolean(node);
  })()`)
  await waitUntil(`${fileName} content`, () => connection.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString().includes(${JSON.stringify(expectedText)}) || document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(expectedText)})`,
  ))
}

async function switchWorkspace(targetPath) {
  await connection.evaluate(`document.querySelector('button[aria-label="更改目录"]')?.click()`)
  await waitUntil('workspace picker path field', () => connection.evaluate(
    `Boolean(document.querySelector('.workspace-picker-modal input[aria-label="目录路径"]'))`,
  ))
  await connection.evaluate(`(() => {
    const input = document.querySelector('.workspace-picker-modal input[aria-label="目录路径"]');
    input?.focus();
    input?.setSelectionRange(0, input.value.length);
  })()`)
  await connection.send('Input.insertText', { text: targetPath })
  assert.equal(await connection.evaluate(`document.querySelector('.workspace-picker-modal input[aria-label="目录路径"]')?.value`), targetPath,
    'the picker address should accept the exact absolute workspace path')
  await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitUntil('requested workspace path to load in the picker', () => connection.evaluate(
    `(() => {
      const modal = document.querySelector('.workspace-picker-modal');
      const list = modal?.querySelector('.workspace-picker-list');
      return modal?.dataset.currentPath === ${JSON.stringify(targetPath)}
        && list?.getAttribute('aria-busy') !== 'true'
        && !modal.querySelector('button[aria-label="使用当前目录"]')?.disabled;
    })()`,
  ))
  await connection.evaluate(`document.querySelector('.workspace-picker-modal button[aria-label="使用当前目录"]')?.click()`)
  await waitUntil('selected workspace to load in the editor', () => connection.evaluate(
    `JSON.parse(localStorage.getItem('editor_workspace_info') || 'null')?.workspace === ${JSON.stringify(targetPath)}
      && Boolean(document.querySelector('.workspace-sidebar') && document.querySelector('.tree-scroll'))`,
  ))
  await waitUntil('workspace picker to close', () => connection.evaluate(
    `!document.body.classList.contains('workspace-picker-open')`,
  ))
}

function workspaceTreeRequestCount() {
  return connection.networkRequests.filter(request => {
    if (request.method !== 'GET') return false
    const url = new URL(request.url)
    return url.pathname === '/api/workspace' && url.searchParams.get('recursive') === '1'
  }).length
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

async function pressKey(key, windowsVirtualKeyCode, { code = key, modifiers = 0 } = {}) {
  await connection.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers,
  })
  await connection.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers,
  })
}

async function setTestViewport(width, height, mobile = false) {
  await connection.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile,
  })
  await connection.send('Emulation.setTouchEmulationEnabled', mobile
    ? { enabled: true, maxTouchPoints: 1 }
    : { enabled: false })

  const expectMobileLayout = width <= 768
  let previousGeometry = null
  let stableGeometryPolls = 0
  await waitUntil(`${expectMobileLayout ? 'mobile' : 'desktop'} editor layout and geometry to settle`, async () => {
    const layout = await connection.evaluate(`(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const expectMobile = ${expectMobileLayout};
      const mobileMedia = matchMedia('(max-width: 768px)').matches;
      const sidebar = document.querySelector('.workspace-sidebar');
      const statusbar = document.querySelector('.editor-statusbar');
      const statusbarUsesMobileLayout = statusbar?.classList.contains('editor-statusbar-theme-slot');
      const responsiveLayoutReady = mobileMedia === expectMobile && statusbar
        && statusbarUsesMobileLayout === expectMobile && Boolean(sidebar) !== expectMobile;
      if (!responsiveLayoutReady) return null;

      const layoutElements = [
        ...document.querySelectorAll('#editor-root, .workspace-sidebar, .editor-main, .editor-scroll, .ProseMirror, .editor-statusbar, .mobile-toolbar'),
        ...document.querySelectorAll('.ProseMirror img, .ProseMirror table'),
      ];
      const geometry = layoutElements.map(element => {
        const rect = element.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height, element.scrollWidth, element.scrollHeight]
          .map(value => Math.round(value * 100) / 100);
      });
      return JSON.stringify(geometry);
    })()`)
    if (!layout) {
      previousGeometry = null
      stableGeometryPolls = 0
      return false
    }
    stableGeometryPolls = layout === previousGeometry ? stableGeometryPolls + 1 : 1
    previousGeometry = layout
    return stableGeometryPolls >= 3
  })
}

async function dispatchRealInput(targetExpression, { touch = false, scrollIntoView = true, button = 'left' } = {}) {
  const point = await connection.evaluate(`(() => {
    const target = (${targetExpression});
    if (!target) return null;
    if (${scrollIntoView}) target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = target.getBoundingClientRect();
    const cellIndex = cell => {
      if (!cell) return null;
      const row = cell.closest('tr');
      const table = cell.closest('table');
      return [Array.from(document.querySelectorAll('.ProseMirror table')).indexOf(table),
        row ? Array.from(table.rows).indexOf(row) : -1, row ? Array.from(row.cells).indexOf(cell) : -1];
    };
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const targetCell = target.matches('td,th') ? target : target.closest('td,th');
    const hitCell = hit?.matches('td,th') ? hit : hit?.closest('td,th');
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      targetLabel: target.getAttribute('aria-label'),
      targetCell: cellIndex(targetCell),
      hitCell: cellIndex(hitCell),
      hitMatchesTarget: hit === target || target.contains(hit) || (target.matches('img') && hit?.closest?.('img') === target),
      hitLabel: hit?.getAttribute?.('aria-label') || hit?.closest?.('[aria-label]')?.getAttribute('aria-label') || null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`)
  assert.ok(point?.width > 0 && point?.height > 0, `real input target must have visible geometry: ${targetExpression}`)
  assert.ok(point.x >= 0 && point.x < point.viewport.width && point.y >= 0 && point.y < point.viewport.height,
    `real input target must be inside the viewport: ${JSON.stringify(point)}`)
  assert.equal(point.hitMatchesTarget, true, `the real input point must hit the requested element: ${JSON.stringify(point)}`)

  if (touch) {
    await connection.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ id: 1, x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1 }],
    })
    await new Promise(resolve => setTimeout(resolve, 45))
    await connection.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: 1 })
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: 1 })
  }
  if (point.targetCell) {
    let matchingPolls = 0
    await waitUntil(`DOM selection in clicked table cell ${JSON.stringify(point.targetCell)}`, async () => {
      await connection.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      const selection = await readDOMCellSelection()
      const matches = JSON.stringify(selection?.cell) === JSON.stringify(point.targetCell)
        && (button === 'right' || selection.editorFocused)
      matchingPolls = matches ? matchingPolls + 1 : 0
      return matchingPolls >= 2
    }, 2500)
    assert.deepEqual(point.hitCell, point.targetCell,
      `the real ${touch ? 'touch' : button === 'right' ? 'right-click' : 'mouse'} point must hit the requested table cell: ${JSON.stringify(point)}`)
  }
  return point
}

async function clickFileFromTree(fileName, expectedText) {
  await dispatchRealInput(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(node => node.innerText.trim() === ${JSON.stringify(fileName)})`)
  await waitUntil(`${fileName} content after a real tree click`, () => connection.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString().includes(${JSON.stringify(expectedText)}) || document.querySelector('.ProseMirror')?.innerText.includes(${JSON.stringify(expectedText)})`,
  ))
}

async function readDOMCellSelection() {
  return connection.evaluate(`(() => {
    const anchorNode = window.getSelection()?.anchorNode || null;
    const anchorElement = anchorNode?.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode?.parentElement;
    const cell = anchorElement?.closest('td,th') || null;
    const active = document.activeElement;
    return {
      cell: cell && [Array.from(document.querySelectorAll('.ProseMirror table')).indexOf(cell.closest('table')),
        Array.from(cell.closest('table').rows).indexOf(cell.closest('tr')),
        Array.from(cell.closest('tr').cells).indexOf(cell)],
      editorFocused: Boolean(active?.classList?.contains('ProseMirror-focused')),
    };
  })()`)
}

async function readRichTableState() {
  return connection.evaluate(`Array.from(document.querySelectorAll('.ProseMirror table')).map(table => ({
    rows: Array.from(table.rows).map(row => Array.from(row.cells).map(cell => cell.innerText.replace(/\\s+/g, ' ').trim())),
  }))`)
}

async function waitForStableContextMenu(label) {
  let previousGeometry = ''
  let stablePolls = 0
  return waitUntil(`${label} context menu to be visible and stable`, async () => {
    const geometry = await connection.evaluate(`(() => {
      const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(item => {
        if (item.getAttribute('aria-label') !== ${JSON.stringify(label)}) return false;
        const rect = item.getBoundingClientRect(), style = getComputedStyle(item);
        return item.getClientRects().length && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible';
      });
      const rect = menu?.getBoundingClientRect(), item = menu?.querySelector('[role="menuitem"]');
      const itemRect = item?.getBoundingClientRect();
      const hit = itemRect && document.elementFromPoint(itemRect.left + itemRect.width / 2, itemRect.top + itemRect.height / 2);
      return menu && rect && itemRect ? { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        itemRect: { x: itemRect.x, y: itemRect.y, width: itemRect.width, height: itemRect.height },
        viewport: { width: innerWidth, height: innerHeight },
        visible: Boolean(menu.getClientRects().length && rect.width > 0 && rect.height > 0
          && getComputedStyle(menu).display !== 'none' && getComputedStyle(menu).visibility === 'visible'
          && item.getClientRects().length && itemRect.width > 0 && itemRect.height > 0),
        hitLabel: hit?.getAttribute?.('aria-label') || hit?.closest?.('[aria-label]')?.getAttribute('aria-label') || null,
        itemLabel: item.getAttribute('aria-label') || item.innerText.trim() } : null;
    })()`)
    const signature = geometry?.visible ? JSON.stringify([geometry.rect, geometry.itemRect, geometry.itemLabel]) : ''
    stablePolls = signature && signature === previousGeometry ? stablePolls + 1 : 0
    previousGeometry = signature
    return stablePolls >= 2 ? geometry : null
  }, 5000)
}

function assertContextMenuFitsViewport(geometry, label) {
  const { rect, viewport } = geometry
  assert.ok(rect && rect.x >= 0 && rect.y >= 0
    && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height,
  `${label} menu must stay inside the viewport: ${JSON.stringify(geometry)}`)
}

async function readContextMenuScrollMetrics(label) {
  return connection.evaluate(`(() => {
    const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(item => {
      const rect = item.getBoundingClientRect(), style = getComputedStyle(item);
      return item.getAttribute('aria-label') === ${JSON.stringify(label)} && item.getClientRects().length
        && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible';
    });
    const elements = menu ? [menu, ...menu.querySelectorAll('*')] : [];
    const constrained = elements.map(element => {
      const style = getComputedStyle(element);
      return { overflowY: style.overflowY, maxHeight: style.maxHeight,
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    }).filter(item => ['auto', 'scroll', 'hidden'].includes(item.overflowY) || item.maxHeight !== 'none');
    return { overflowing: constrained.some(item => item.scrollHeight > item.clientHeight + 1),
      scrollable: constrained.some(item => item.scrollHeight > item.clientHeight + 1 && ['auto', 'scroll'].includes(item.overflowY)),
      constrained };
  })()`)
}

async function waitForStableObjectMenuButton(label, objectExpression) {
  let previousGeometry = ''
  let stablePolls = 0
  let lastGeometry = null
  try {
    return await waitUntil(`${label} touch menu button to be visible and stable`, async () => {
      const geometry = await connection.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(item => {
        if (item.getAttribute('aria-label') !== ${JSON.stringify(label)}) return false;
        const rect = item.getBoundingClientRect(), style = getComputedStyle(item);
        return item.getClientRects().length && rect.width > 0 && rect.height > 0 && style.visibility === 'visible';
      });
      const object = (${objectExpression});
      const buttonStyle = button && getComputedStyle(button);
      const buttonRect = button?.getBoundingClientRect(), objectRect = object?.getBoundingClientRect();
      const hit = buttonRect && document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2);
      const hitButton = hit?.closest?.('button');
      return button && buttonRect && objectRect ? { button: { x: buttonRect.x, y: buttonRect.y, width: buttonRect.width, height: buttonRect.height, zIndex: buttonStyle.zIndex },
        object: { x: objectRect.x, y: objectRect.y, width: objectRect.width, height: objectRect.height },
        visible: Boolean(button.getClientRects().length && getComputedStyle(button).visibility === 'visible'
          && buttonRect.width >= 44 && buttonRect.height >= 44
          && buttonRect.left >= 0 && buttonRect.top >= 0 && buttonRect.right <= innerWidth && buttonRect.bottom <= innerHeight),
        hitLabel: hitButton?.getAttribute('aria-label') || null, hitIsButton: hitButton === button } : null;
      })()`)
      lastGeometry = geometry
      const signature = geometry?.visible && geometry.hitIsButton && geometry.hitLabel === label
        ? JSON.stringify([geometry.button, geometry.object]) : ''
      stablePolls = signature && signature === previousGeometry ? stablePolls + 1 : 0
      previousGeometry = signature
      return stablePolls >= 2 ? geometry : null
    }, 5000)
  } catch (error) {
    const state = await connection.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === ${JSON.stringify(label)});
      const object = (${objectExpression});
      const scroll = document.querySelector('.editor-scroll'), frame = scroll?.getBoundingClientRect(), objectRect = object?.getBoundingClientRect();
      const anchor = window.getSelection()?.anchorNode || null;
      const anchorElement = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
      const cell = anchorElement?.closest('td,th');
      const active = document.activeElement;
      const box = element => { const rect = element?.getBoundingClientRect(), style = element && getComputedStyle(element);
        return element && { x: rect.x, y: rect.y, width: rect.width, height: rect.height, display: style.display, visibility: style.visibility }; };
      return { viewport: { width: innerWidth, height: innerHeight }, mobileMedia: matchMedia('(max-width: 768px)').matches,
        maxTouchPoints: navigator.maxTouchPoints, editorFocus: Boolean(document.querySelector('.ProseMirror-focused')),
        active: active && { tag: active.tagName, role: active.getAttribute('role'), ariaLabel: active.getAttribute('aria-label'), className: String(active.className) },
        editorFrame: frame && { x: frame.x, y: frame.y, width: frame.width, height: frame.height, scrollTop: scroll.scrollTop },
        object: box(object), button: box(button), selectedImages: Array.from(document.querySelectorAll('.ProseMirror img.ProseMirror-selectednode')).length,
        domCell: cell && [Array.from(document.querySelectorAll('.ProseMirror table')).indexOf(cell.closest('table')),
          Array.from(cell.closest('table').rows).indexOf(cell.closest('tr')), Array.from(cell.closest('tr').cells).indexOf(cell)] };
    })()`)
    throw new Error(`${error.message}\nMore button evidence: ${JSON.stringify({ lastGeometry, state })}`)
  }
}

async function openObjectContextMenu(targetExpression, { object = 'table', touch = false, keyboard = false } = {}) {
  const triggerLabel = object === 'image' ? '更多图片操作' : '更多表格操作'
  const menuLabel = object === 'image' ? '图片操作' : '表格操作'
  let touchButtonEvidence = null
  await dispatchRealInput(targetExpression, { touch, button: touch || keyboard ? 'left' : 'right' })
  if (object === 'image') await waitForSelectedImage(targetExpression)
  if (keyboard) await pressKey('F10', 121, { modifiers: 8 })
  if (touch) {
    const selectedObject = object === 'image' ? targetExpression : `(${targetExpression})?.closest('table')`
    touchButtonEvidence = await waitForStableObjectMenuButton(triggerLabel, selectedObject)
    await dispatchRealInput(`Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === ${JSON.stringify(triggerLabel)} && item.getClientRects().length && getComputedStyle(item).visibility === 'visible')`, {
      touch: true, scrollIntoView: false,
    })
    assert.equal(touchButtonEvidence.hitLabel, triggerLabel, `${triggerLabel} must receive touch at its visible center`)
    assert.equal(touchButtonEvidence.hitIsButton, true, `${triggerLabel} touch must land on the actual button receiver`)
    try {
      return { label: menuLabel, geometry: await waitForStableContextMenu(menuLabel) }
    } catch (error) {
      const state = await connection.evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === ${JSON.stringify(triggerLabel)});
        const target = (${selectedObject});
        const scroll = document.querySelector('.editor-scroll'), frame = scroll?.getBoundingClientRect(), buttonRect = button?.getBoundingClientRect();
        const hit = buttonRect && document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2);
        const anchor = window.getSelection()?.anchorNode || null, anchorElement = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
        const cell = anchorElement?.closest('td,th'), active = document.activeElement;
        const visibleMenus = Array.from(document.querySelectorAll('[role="menu"]')).map(menu => {
          const rect = menu.getBoundingClientRect(), style = getComputedStyle(menu);
          return { label: menu.getAttribute('aria-label'), visible: Boolean(menu.getClientRects().length && rect.width && rect.height && style.visibility === 'visible' && style.display !== 'none'),
            x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        return { viewport: { width: innerWidth, height: innerHeight }, mobileMedia: matchMedia('(max-width: 768px)').matches,
          maxTouchPoints: navigator.maxTouchPoints,
          editorFrame: frame && { x: frame.x, y: frame.y, width: frame.width, height: frame.height, scrollTop: scroll.scrollTop },
          button: button && { x: buttonRect.x, y: buttonRect.y, width: buttonRect.width, height: buttonRect.height,
            display: getComputedStyle(button).display, visibility: getComputedStyle(button).visibility, zIndex: getComputedStyle(button).zIndex,
            hitReceiver: hit?.closest?.('button') === button, hitLabel: hit?.closest?.('button')?.getAttribute('aria-label') },
          target: target && { x: target.getBoundingClientRect().x, y: target.getBoundingClientRect().y,
            width: target.getBoundingClientRect().width, height: target.getBoundingClientRect().height },
          domCell: cell && [Array.from(document.querySelectorAll('.ProseMirror table')).indexOf(cell.closest('table')),
            Array.from(cell.closest('table').rows).indexOf(cell.closest('tr')), Array.from(cell.closest('tr').cells).indexOf(cell)],
          selectedImageCount: document.querySelectorAll('.ProseMirror img.ProseMirror-selectednode').length,
          active: active && { tag: active.tagName, role: active.getAttribute('role'), label: active.getAttribute('aria-label'), className: String(active.className) },
          visibleMenus };
      })()`)
      if (process.env.EDITOR_REPAIR_SCREENSHOT_DIR) await saveRepairScreenshot(`${object}-more-tap-no-menu.png`)
      throw new Error(`${error.message}\nMore tap evidence: ${JSON.stringify({ touchButtonEvidence, state })}`)
    }
  }
  return { label: menuLabel, geometry: await waitForStableContextMenu(menuLabel) }
}

async function clickContextMenuItem(menuLabel, itemLabel, { touch = false } = {}) {
  const expression = `(() => {
    const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(menu => {
      const rect = menu.getBoundingClientRect(), style = getComputedStyle(menu);
      return menu.getAttribute('aria-label') === ${JSON.stringify(menuLabel)} && menu.getClientRects().length
        && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility === 'visible';
    });
    return menus.flatMap(menu => Array.from(menu.querySelectorAll('[role="menuitem"]')))
      .find(item => item.getAttribute('aria-label') === ${JSON.stringify(itemLabel)} || item.innerText.trim() === ${JSON.stringify(itemLabel)});
  })()`
  const click = await dispatchRealInput(expression, { touch, scrollIntoView: false })
  assert.equal(click.hitLabel, itemLabel, `real input must hit the ${itemLabel} menu item`)
  return click
}

async function waitForContextMenuClosed(label) {
  return waitUntil(`${label} context menu to close`, () => connection.evaluate(`(() => {
    const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(item => item.getAttribute('aria-label') === ${JSON.stringify(label)});
    return menus.every(menu => { const rect = menu.getBoundingClientRect(), style = getComputedStyle(menu);
      return !menu.getClientRects().length || rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none'; });
  })()`))
}

async function waitForFocusedContextMenuItem(label, description = `${label} first menu command to receive focus`) {
  try {
    return await waitUntil(description, () => connection.evaluate(`(() => {
      const menu = document.querySelector('[role="menu"][aria-label="${label}"]');
      const active = document.activeElement;
      return menu?.contains(active) && active?.getAttribute('role') === 'menuitem'
        ? active.getAttribute('aria-label') : null;
    })()`))
  } catch (error) {
    const evidence = await connection.evaluate(`(() => {
      const menu = document.querySelector('[role="menu"][aria-label="${label}"]');
      const active = document.activeElement;
      return { active: active && { tag: active.tagName, role: active.getAttribute('role'), label: active.getAttribute('aria-label'), className: String(active.className) },
        menu: menu && { visible: Boolean(menu.getClientRects().length), labels: Array.from(menu.querySelectorAll('[role="menuitem"]')).map(item => ({ label: item.getAttribute('aria-label'), tabIndex: item.tabIndex, focused: item === active })) },
        editorFocused: Boolean(document.querySelector('.ProseMirror-focused')) };
    })()`)
    throw new Error(`${error.message}\nMenu focus evidence: ${JSON.stringify(evidence)}`)
  }
}

async function waitForSelectedImage(imageExpression, description = 'clicked image to become the selected node') {
  return waitUntil(description, () => connection.evaluate(`(() => {
    const target = (${imageExpression});
    return Boolean(target?.classList.contains('ProseMirror-selectednode'));
  })()`))
}

async function assertNoPersistentObjectToolbars() {
  assert.equal(await connection.evaluate(`!document.querySelector('.table-context-tools, .image-context-tools')`), true,
    'table and image actions should be available through context menus, not persistent toolbars')
}

async function clickTableAction(label, cellExpression, { touch = false, shape } = {}) {
  const context = await openObjectContextMenu(cellExpression, { touch })
  assert.ok(context.geometry.visible, `table context menu must be visible: ${JSON.stringify(context.geometry)}`)
  await clickContextMenuItem(context.label, label, { touch })
  await waitForContextMenuClosed(context.label)
  if (shape) await waitForTableShape(shape.table, shape.rows, shape.columns, shape.description)
}

async function waitForTableShape(index, rowCount, columnCount, description) {
  return waitUntil(description, async () => {
    const tables = await readRichTableState()
    const table = tables[index]
    return table && table.rows.length === rowCount && table.rows.every(row => row.length === columnCount) ? table : null
  })
}

async function waitForStablePickerTarget(label) {
  let previousGeometry = ''
  let stablePolls = 0
  return waitUntil(`${label} table picker target to be visible and stable`, async () => {
    const geometry = await connection.evaluate(`(() => {
      const target = Array.from(document.querySelectorAll('.table-size-grid button')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)});
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      const panel = target.closest('.ant-popover');
      const panelRect = panel?.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        target: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        panel: panelRect && { x: panelRect.x, y: panelRect.y, width: panelRect.width, height: panelRect.height },
        viewport: { width: innerWidth, height: innerHeight },
        targetLabel: target.getAttribute('aria-label'),
        hitLabel: hit?.getAttribute?.('aria-label') || hit?.closest?.('[aria-label]')?.getAttribute('aria-label') || null,
        visible: Boolean(target.getClientRects().length && getComputedStyle(target).visibility === 'visible'
          && panel?.getClientRects().length && getComputedStyle(panel).visibility === 'visible'),
      };
    })()`)
    const hitReady = geometry?.visible && geometry.target.width > 20 && geometry.target.height > 20
      && geometry.panel?.width > 20 && geometry.panel?.height > 20
      && geometry.targetLabel === label && geometry.hitLabel === label
    const signature = hitReady ? JSON.stringify([geometry.target, geometry.panel]) : ''
    stablePolls = signature && signature === previousGeometry ? stablePolls + 1 : 0
    previousGeometry = signature
    return stablePolls >= 2 ? geometry : null
  }, 8000)
}

function assertPickerFitsViewport(geometry, label) {
  const { panel, viewport } = geometry
  assert.ok(panel && panel.x >= 0 && panel.y >= 0
    && panel.x + panel.width <= viewport.width && panel.y + panel.height <= viewport.height,
  `${label} table picker panel must fit fully inside the viewport: ${JSON.stringify(geometry)}`)
}

function makeLongTableControlsSource() {
  const context = Array.from({ length: 38 }, (_, index) => `Long context paragraph ${String(index + 1).padStart(2, '0')} remains outside the table edit.`)
  return [
    '# Long table controls fixture',
    '',
    ...context,
    '',
    'Adjacent text before the first table remains intact.',
    '',
    '| UPPER-KEY | UPPER-VALUE |',
    '| --- | --- |',
    '| UPPER-ROW-1 | UPPER-CELL-1 |',
    '| UPPER-ROW-2 | UPPER-CELL-2 |',
    '',
    'Between-table text remains intact.',
    '',
    '| LOWER-KEY | LOWER-VALUE |',
    '| --- | --- |',
    '| LOWER-ROW-1 | LOWER-CELL-1 |',
    '| LOWER-ROW-2 | LOWER-CELL-2 |',
    '',
    'Tail insertion point remains intact.',
    '',
  ].join('\n')
}

async function selectImageFile(name, bytes) {
  return connection.evaluate(`(() => {
    const input = document.querySelector('#img-up');
    if (!input) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(${JSON.stringify([...bytes])})], ${JSON.stringify(name)}, { type: 'image/png' }));
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
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
  await cleanupBrowserTest({
    browser: { child: chromeProcess, port: chromePort },
    connections: [connection],
    children: [frontendProcess, backendProcess],
    tempRoot,
  })
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

  await connection.evaluate(`document.querySelector('[aria-label="切换到富文本编辑"]')?.click()`)
  await waitUntil('explicit rich conversion warning', () => connection.evaluate(
    `document.body.innerText.includes('此文档包含源码模式保护内容') && document.body.innerText.includes('仍切换到富文本')`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('.ant-modal button')).find(button => button.innerText.trim() === '继续源码模式')?.click()`)
  await waitUntil('source mode remains active after dismissing warning', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content')) && !document.querySelector('.ProseMirror')`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), fixture)
})

test('source image upload inserts at the CodeMirror cursor, saves, and source outline tracks live headings', async () => {
  const richFile = 'rich-before-source.md'
  const sourceFile = 'source-image-outline.md'
  const sourceSeed = '---\nmode: source\n---\n# Source first\n\n## Source second\n\n```md\n# Fenced false heading\n```\n\nSetext source\n-------------\n\nCursor: \n'
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
  await writeFile(path.join(workspace, richFile), '# Hidden rich heading\n\nRich body\n')
  await writeFile(path.join(workspace, sourceFile), sourceSeed)
  await setupPage()
  await openFile(richFile, 'Hidden rich heading')
  await openFile(sourceFile, 'Source first')

  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.editor-toolbar [aria-label="加粗"], .editor-toolbar [aria-label="插入链接"], .editor-toolbar [aria-label="插入表格"]'))`), false, 'rich tools must not target the hidden editor')
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.editor-toolbar [aria-label="上传图片"]'))`), true)
  await connection.evaluate(`document.querySelector('.editor-toolbar [aria-label="显示右侧大纲"]')?.click()`)
  const outline = await waitUntil('source outline, excluding the old rich heading and fenced code', () => connection.evaluate(
    `(() => { const items = Array.from(document.querySelectorAll('.outline-panel .outline-item')).map(item => item.innerText.trim()); return items.length === 3 ? items : null })()`,
  ))
  assert.match(outline[0], /Source first/)
  assert.match(outline[1], /Source second/)
  assert.match(outline[2], /Setext source/)
  assert.doesNotMatch(outline.join(' '), /Hidden rich|Fenced false/)
  await connection.evaluate(`Array.from(document.querySelectorAll('.outline-panel .outline-item')).find(item => item.innerText.includes('Source second'))?.click()`)
  assert.equal(await connection.evaluate(`(() => { const view = document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view; return view?.state.selection.main.head === view?.state.doc.toString().indexOf('## Source second') })()`), true, 'outline click must select the source heading')
  await connection.evaluate(`Array.from(document.querySelectorAll('.outline-panel .outline-item')).find(item => item.innerText.includes('Setext source'))?.click()`)
  assert.equal(await connection.evaluate(`(() => { const view = document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view; return view?.state.selection.main.head === view?.state.doc.toString().indexOf('Setext source') })()`), true, 'Setext outline click must select its source heading')

  await connection.evaluate(`(() => { const view = document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view; const from = view.state.doc.toString().indexOf('Source second'); view.dispatch({ selection: { anchor: from, head: from + 'Source second'.length } }); view.focus() })()`)
  await connection.send('Input.insertText', { text: 'Live second' })
  await waitUntil('source outline to update after typing', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.outline-panel .outline-item')).some(item => item.innerText.includes('Live second'))`,
  ))

  await connection.evaluate(`(() => { const view = document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view; const cursor = view.state.doc.toString().indexOf('Cursor: ') + 'Cursor: '.length; view.dispatch({ selection: { anchor: cursor } }); view.focus() })()`)
  const pickerOpened = await connection.evaluate(`(() => { const input = document.querySelector('#img-up'); input?.addEventListener('click', event => { event.preventDefault(); window.__sourceImagePickerOpened = true }, { once: true }); document.querySelector('.editor-toolbar [aria-label="上传图片"]')?.click(); return Boolean(window.__sourceImagePickerOpened) })()`)
  assert.equal(pickerOpened, true)
  assert.equal(await selectImageFile('source image.png', imageBytes), true)
  const insertedImage = 'Cursor: ![](assets/source%20image.png)'
  await waitUntil('relative image at the CodeMirror cursor', () => connection.evaluate(
    `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString().includes(${JSON.stringify(insertedImage)})`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.ant-message')?.innerText.includes('图片已插入')`), true)
  await waitForDiskMarker(sourceFile, insertedImage)
  assert.deepEqual(await readFile(path.join(workspace, 'assets', 'source image.png')), imageBytes)
  const saved = await readFile(path.join(workspace, sourceFile), 'utf8')
  assert.match(saved, /^---\nmode: source\n---/)
  assert.match(saved, /## Live second/)
  assert.doesNotMatch(saved, /\/api\/workspace\/media\//)

  await waitUntil('success toast to finish before failure check', () => connection.evaluate(`!document.querySelector('.ant-message-success')`))
  assert.equal(await selectImageFile('source image.png', imageBytes), true)
  await waitUntil('duplicate image upload to fail', () => connection.evaluate(`document.querySelector('.ant-message-error')?.innerText.includes('上传失败')`))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), saved)
  assert.equal(await readFile(path.join(workspace, sourceFile), 'utf8'), saved)

  await connection.send('Fetch.enable', { patterns: [{ urlPattern: '*api/workspace/upload*', requestStage: 'Request' }] })
  connection.pauseNextWorkspaceUpload = true
  assert.equal(await selectImageFile('after-switch.png', imageBytes), true)
  const pausedUpload = await waitUntil('second image upload to pause', () => (
    connection.pausedFetchRequests.find(item => item.request?.method === 'POST' && item.request.url.includes('/api/workspace/upload'))
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('.document-tab')).find(tab => tab.innerText.includes(${JSON.stringify(richFile)}))?.click()`)
  await waitUntil('rich tab active while upload is pending', () => connection.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes('Rich body')`))
  await connection.send('Fetch.continueRequest', { requestId: pausedUpload.requestId })
  await waitUntil('upload completion to report the changed document', () => connection.evaluate(
    `document.querySelector('.ant-message-info')?.innerText.includes('当前文档已变化，未插入')`,
  ))
  await connection.send('Fetch.disable')
  assert.equal(await readFile(path.join(workspace, sourceFile), 'utf8'), saved)
  assert.equal(await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes('after-switch.png')`), false)

  await connection.evaluate(`document.querySelector('[aria-label="切换到源码编辑"]')?.click()`)
  await waitUntil('rich file switched to source before upload', () => connection.evaluate(`Boolean(document.querySelector('.source-editor .cm-content'))`))
  await connection.send('Fetch.enable', { patterns: [{ urlPattern: '*api/workspace/upload*', requestStage: 'Request' }] })
  connection.pauseNextWorkspaceUpload = true
  assert.equal(await selectImageFile('after-mode-switch.png', imageBytes), true)
  const pausedModeUpload = await waitUntil('source upload to pause before mode switch', () => (
    connection.pausedFetchRequests.find(item => item.request?.method === 'POST' && item.request.url.includes('/api/workspace/upload') && item.requestId !== pausedUpload.requestId)
  ))
  await connection.evaluate(`document.querySelector('[aria-label="切换到富文本编辑"]')?.click()`)
  await waitUntil('rich mode restored while upload is pending', () => connection.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes('Rich body')`))
  await connection.send('Fetch.continueRequest', { requestId: pausedModeUpload.requestId })
  await waitUntil('mode change to report no insertion', () => connection.evaluate(
    `document.querySelector('.ant-message-info')?.innerText.includes('当前文档已变化，未插入')`,
  ))
  await connection.send('Fetch.disable')
  assert.equal(await readFile(path.join(workspace, richFile), 'utf8'), '# Hidden rich heading\n\nRich body\n')
  assert.equal(await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes('after-mode-switch.png')`), false)
})

test('image upload refreshes and expands adjacent assets, while a late workspace result stays isolated', async () => {
  const documentDirectory = 'upload-tree-fixture'
  const fileName = `${documentDirectory}/upload-tree.md`
  const assetsDirectory = `${documentDirectory}/assets`
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
  const nextWorkspacePath = path.join(tempRoot, 'upload-next-workspace')
  const nextFile = 'next-workspace.md'
  await mkdir(path.join(workspace, documentDirectory), { recursive: true })
  await writeFile(path.join(workspace, fileName), '# Upload tree fixture\n')
  await mkdir(nextWorkspacePath, { recursive: true })
  const nextWorkspace = await realpath(nextWorkspacePath)
  await writeFile(path.join(nextWorkspace, nextFile), '# Next workspace fixture\n')
  await setupPage()
  await connection.evaluate(`document.querySelector('[aria-label="更多目录操作"]')?.click()`)
  await waitUntil('directory action menu to open', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).some(node => node.innerText.trim() === '全部展开')`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(node => node.innerText.trim() === '全部展开')?.click()`)
  await openFile('upload-tree.md', 'Upload tree fixture')
  assert.equal(await connection.evaluate(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(node => node.dataset.path === ${JSON.stringify(assetsDirectory)})`), false,
    'the test should begin before the adjacent assets directory exists')

  const firstImageName = 'new image.png'
  assert.equal(await selectImageFile(firstImageName, imageBytes), true)
  await waitUntil('first upload to insert a relative image reference', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror img[data-markdown-src="assets/new%20image.png"]'))`,
  ))
  await waitUntil('new assets directory and uploaded image to appear in the expanded tree', () => connection.evaluate(
    `(() => {
      const paths = Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).map(node => node.dataset.path);
      return paths.includes(${JSON.stringify(assetsDirectory)}) && paths.includes(${JSON.stringify(`${assetsDirectory}/${firstImageName}`)});
    })()`,
  ))
  const firstSaved = await waitUntil('first uploaded image reference to autosave', async () => {
    const content = await readFile(path.join(workspace, fileName), 'utf8').catch(() => '')
    return content.includes('assets/new%20image.png') ? content : null
  })
  assert.match(firstSaved, /!\[[^\]]*\]\(assets\/new%20image\.png\)/)
  assert.deepEqual(await readFile(path.join(workspace, assetsDirectory, firstImageName)), imageBytes)
  if (process.env.EDITOR_REVIEW_INTERACTION_DIR) {
    await mkdir(process.env.EDITOR_REVIEW_INTERACTION_DIR, { recursive: true })
    const screenshot = await connection.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(path.join(process.env.EDITOR_REVIEW_INTERACTION_DIR, 'image-upload-refreshed-tree.png'), Buffer.from(screenshot.data, 'base64'))
  }

  await connection.send('Fetch.enable', { patterns: [{ urlPattern: '*api/workspace/upload*', requestStage: 'Response' }] })
  const previousPausedRequests = connection.pausedFetchRequests.length
  connection.pauseNextWorkspaceUpload = true
  const lateImageName = 'late upload.png'
  assert.equal(await selectImageFile(lateImageName, imageBytes), true)
  const pausedUpload = await waitUntil('second upload response to pause after the server stores it', () => (
    connection.pausedFetchRequests.slice(previousPausedRequests).find(item => item.request?.method === 'POST' && item.request.url.includes('/api/workspace/upload'))
  ))
  await waitUntil('late upload to exist only in the original workspace', async () => {
    try {
      await access(path.join(workspace, assetsDirectory, lateImageName))
      return true
    } catch { return false }
  })
  const responseBody = await connection.send('Fetch.getResponseBody', { requestId: pausedUpload.requestId })
  const responseBodyBase64 = responseBody.base64Encoded
    ? responseBody.body
    : Buffer.from(responseBody.body).toString('base64')

  await switchWorkspace(nextWorkspace)
  await waitUntil('next workspace document to appear in its own file tree', () => connection.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(node => node.dataset.path === ${JSON.stringify(nextFile)})`,
  ))
  const treeRequestsAfterSwitch = workspaceTreeRequestCount()
  await connection.send('Fetch.fulfillRequest', {
    requestId: pausedUpload.requestId,
    responseCode: pausedUpload.responseStatusCode || 200,
    responseHeaders: pausedUpload.responseHeaders || [],
    body: responseBodyBase64,
  })
  await waitUntil('late upload completion to report that the current document changed', () => connection.evaluate(
    `document.querySelector('.ant-message-info')?.innerText.includes('当前文档已变化，未插入')`,
  ))
  await connection.send('Fetch.disable')

  assert.equal(workspaceTreeRequestCount(), treeRequestsAfterSwitch,
    'a late upload from the old workspace must not refresh the newly selected workspace tree')
  assert.equal(await connection.evaluate(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(node => node.dataset.path === ${JSON.stringify(assetsDirectory)})`), false,
    'the new workspace must not display the old workspace asset directory')
  assert.equal(await readFile(path.join(nextWorkspace, nextFile), 'utf8'), '# Next workspace fixture\n')
  assert.deepEqual(await readFile(path.join(workspace, assetsDirectory, lateImageName)), imageBytes)
  await switchWorkspace(await realpath(workspace))
})

test('document tabs can be selected with the keyboard without closing adjacent tabs', async () => {
  const first = 'keyboard-first.md'
  const second = 'keyboard-second.md'
  await writeFile(path.join(workspace, first), '# Keyboard first\n')
  await writeFile(path.join(workspace, second), '# Keyboard second\n')
  await setupPage()
  await openFile(first, 'Keyboard first')
  await openFile(second, 'Keyboard second')

  const firstLabel = JSON.stringify(first)
  const secondLabel = JSON.stringify(second)
  await connection.evaluate(`Array.from(document.querySelectorAll('.document-tabs [role="tab"]')).find(tab => tab.getAttribute('aria-label')?.startsWith(${firstLabel}))?.focus()`)
  assert.equal(await connection.evaluate(`document.activeElement?.getAttribute('aria-label')?.startsWith(${firstLabel})`), true)
  await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await waitUntil('second tab selected by ArrowRight', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.document-tabs [role="tab"]')).some(tab => tab.getAttribute('aria-label')?.startsWith(${secondLabel}) && tab.getAttribute('aria-selected') === 'true' && tab === document.activeElement)`,
  ))
  assert.equal(await connection.evaluate(`Array.from(document.querySelectorAll('.document-tab')).filter(tab => tab.innerText.includes('keyboard-first.md') || tab.innerText.includes('keyboard-second.md')).length`), 2)
  assert.equal(await connection.evaluate(`document.querySelector('.document-tabs')?.getAttribute('role')`), 'tablist')
})

test('renaming an open image updates its viewer address and title', async () => {
  const original = 'viewer-before.png'
  const renamed = 'viewer-after.png'
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
  await writeFile(path.join(workspace, original), imageBytes)
  await setupPage()
  await waitUntil('image in the file tree', () => connection.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.innerText.trim() === ${JSON.stringify(original)})`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(original)})?.click()`)
  await waitUntil('image viewer to load', () => connection.evaluate(
    `Boolean(document.querySelector('img[alt=${JSON.stringify(original)}]')?.src.includes(${JSON.stringify(original)}))`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.innerText.trim() === ${JSON.stringify(original)})?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))`)
  await waitUntil('image rename action', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.editor-context-menu [role="menuitem"]')).some(item => item.innerText.trim() === '重命名' && item.getBoundingClientRect().width > 0)`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('.editor-context-menu [role="menuitem"]')).find(item => item.innerText.trim() === '重命名' && item.getBoundingClientRect().width > 0)?.click()`)
  await waitUntil('inline filename input', () => connection.evaluate(`Boolean(document.querySelector('.tree-rename-input'))`))
  await connection.evaluate(`(() => { const input = document.querySelector('.tree-rename-input'); input.focus(); input.select() })()`)
  await connection.send('Input.insertText', { text: renamed })
  await waitUntil('new filename in the input', () => connection.evaluate(`document.querySelector('.tree-rename-input')?.value === ${JSON.stringify(renamed)}`))
  await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitUntil('viewer to follow renamed image', () => connection.evaluate(
    `Boolean(document.querySelector('img[alt=${JSON.stringify(renamed)}]')?.src.includes(${JSON.stringify(renamed)}))`,
  ))
  assert.deepEqual(await readFile(path.join(workspace, renamed)), imageBytes)
  await assert.rejects(readFile(path.join(workspace, original)), error => error.code === 'ENOENT')
})

test('file tree F2 cancel and Shift+F10 Escape restore rc-tree keyboard focus and navigation', async () => {
  const directory = `000-keyboard-focus-${Date.now()}`
  const fileName = 'opened-from-keyboard.md'
  const filePath = `${directory}/${fileName}`
  const content = '# Opened from tree keyboard\n'
  await mkdir(path.join(workspace, directory), { recursive: true })
  await writeFile(path.join(workspace, filePath), content)
  await setupPage()

  await waitUntil('new keyboard test folder to appear in the tree', () => connection.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.dataset.path === ${JSON.stringify(directory)})`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).find(item => item.dataset.path === ${JSON.stringify(directory)})?.click()`)
  await waitUntil('keyboard test file visible under expanded folder', () => connection.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(item => item.dataset.path === ${JSON.stringify(filePath)})`,
  ))
  await connection.evaluate(`document.querySelector('.ant-tree input[tabindex]')?.focus()`)
  await waitUntil('real rc-tree keyboard input to receive focus', () => connection.evaluate(
    `(() => { const input = document.querySelector('.ant-tree input[tabindex]'); return Boolean(input && input.getAttribute('aria-label') === '文件目录键盘导航' && document.activeElement === input) })()`,
  ))
  const visibleTreePaths = await connection.evaluate(`Array.from(document.querySelectorAll('.ant-tree-treenode'))
    .filter(row => row.getClientRects().length > 0)
    .map(row => row.querySelector('[data-testid="file-tree-item"]')?.dataset.path)
    .filter(Boolean)`)
  assert.ok(visibleTreePaths.includes(directory), 'the expanded directory must be available to tree keyboard navigation')
  let activePath = await connection.evaluate(`document.querySelector('.ant-tree-treenode-active [data-testid="file-tree-item"]')?.dataset.path || ''`)
  for (let step = 0; activePath !== directory && step <= visibleTreePaths.length; step += 1) {
    await pressKey('ArrowDown', 40)
    await waitUntil('ArrowDown to move the active tree row', async () => {
      const nextPath = await connection.evaluate(`document.querySelector('.ant-tree-treenode-active [data-testid="file-tree-item"]')?.dataset.path || ''`)
      if (nextPath && nextPath !== activePath) {
        activePath = nextPath
        return true
      }
      return false
    }, 1500)
  }
  assert.equal(activePath, directory, 'keyboard navigation should select the target directory before F2')

  await pressKey('F2', 113)
  await waitUntil('F2 to enter inline rename', () => connection.evaluate(`Boolean(document.querySelector('.tree-rename-input'))`))
  const cancelledName = `cancelled-${Date.now()}`
  await connection.evaluate(`(() => { const input = document.querySelector('.tree-rename-input'); input?.focus(); input?.select() })()`)
  await connection.send('Input.insertText', { text: cancelledName })
  await waitUntil('rename input to contain the unsaved candidate', () => connection.evaluate(
    `document.querySelector('.tree-rename-input')?.value === ${JSON.stringify(cancelledName)}`,
  ))
  await pressKey('Escape', 27)
  await waitUntil('Escape to cancel rename and restore the real tree input', () => connection.evaluate(
    `(() => { const input = document.querySelector('.ant-tree input[tabindex]'); return !document.querySelector('.tree-rename-input') && input?.getAttribute('aria-label') === '文件目录键盘导航' && document.activeElement === input })()`,
  ))
  assert.equal(await readFile(path.join(workspace, filePath), 'utf8'), content, 'Escape must not rename or alter the file')
  await assert.rejects(access(path.join(workspace, cancelledName)), error => error.code === 'ENOENT')

  await pressKey('F10', 121, { modifiers: 8 })
  await waitUntil('Shift+F10 to open the focused folder actions', () => connection.evaluate(
    `Boolean(document.querySelector('.editor-context-menu[role="menu"] [role="menuitem"]'))`,
  ))
  await pressKey('Escape', 27)
  await waitUntil('menu Escape to restore focus to the rc-tree input', () => connection.evaluate(
    `(() => { const input = document.querySelector('.ant-tree input[tabindex]'); return !document.querySelector('.editor-context-menu') && input?.getAttribute('aria-label') === '文件目录键盘导航' && document.activeElement === input })()`,
  ))

  await pressKey('ArrowDown', 40)
  await waitUntil('ArrowDown to activate the visible child file', () => connection.evaluate(
    `document.querySelector('.ant-tree-treenode-active [data-testid="file-tree-item"]')?.dataset.path === ${JSON.stringify(filePath)}`,
  ))
  await pressKey('ArrowUp', 38)
  await waitUntil('ArrowUp to navigate back to the parent folder', () => connection.evaluate(
    `document.querySelector('.ant-tree-treenode-active [data-testid="file-tree-item"]')?.dataset.path === ${JSON.stringify(directory)}`,
  ))
  await pressKey('ArrowDown', 40)
  await waitUntil('ArrowDown to reselect the child before opening', () => connection.evaluate(
    `document.querySelector('.ant-tree-treenode-active [data-testid="file-tree-item"]')?.dataset.path === ${JSON.stringify(filePath)}`,
  ))
  await pressKey('Enter', 13)
  await waitUntil('Enter to open the active file from the tree', () => connection.evaluate(
    `document.querySelector('.ProseMirror')?.innerText.includes('Opened from tree keyboard')`,
  ))
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

test('numbered Markdown heading dots survive rich editing and save without an open-time write', async () => {
  const fileName = 'numbered-headings.md'
  const source = '### 1\\. 第一部分\n\n### 2\\. 第二部分\n\n### 3. 普通标题\n'
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  const initialPuts = workspacePutCount()
  const before = await stat(path.join(workspace, fileName))
  await openFile(fileName, '第一部分')

  await waitUntil('numbered headings to open in rich mode', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror') && !document.querySelector('.source-fidelity-warning'))`,
  ))
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), source, 'opening valid headings must leave source bytes intact')
  assert.equal(workspacePutCount(), initialPuts, 'opening the headings must not send a workspace PUT')
  assert.equal((await stat(path.join(workspace, fileName))).mtimeMs, before.mtimeMs)

  await connection.evaluate(`(() => {
    const editor = document.querySelector('.ProseMirror')
    const heading = Array.from(editor?.querySelectorAll('h3') || []).find(node => node.innerText.includes('普通标题'))
    if (!editor || !heading) return false
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(heading)
    range.collapse(false)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  })()`)
  await waitUntil('selection to target the ordinary third heading', () => connection.evaluate(
    `window.getSelection()?.anchorNode?.parentElement?.closest('h3')?.innerText.includes('普通标题') || window.getSelection()?.anchorNode?.closest?.('h3')?.innerText.includes('普通标题')`,
  ))
  await connection.send('Input.insertText', { text: ' 已编辑' })
  await clickSave()
  const saved = await waitForDiskMarker(fileName, '已编辑')
  assert.match(saved, /### 1\\\. 第一部分/)
  assert.match(saved, /### 2\\\. 第二部分/)
  assert.match(saved, /### 3\. 普通标题 已编辑/)
  assert.doesNotMatch(saved, /### 3\\\./, 'unescaped numbered headings must not gain a slash')

  await setupPage()
  await openFile(fileName, '第一部分')
  await waitUntil('saved numbered headings to reopen in rich mode', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror') && !document.querySelector('.source-fidelity-warning'))`,
  ))
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), saved)
  await saveRepairScreenshot('numbered-headings-rich.png')
})

test('intraword escaped underscores in mixed Markdown open cleanly and survive a rich edit', async () => {
  const fileName = 'intraword-escapes.md'
  const source = [
    'Paragraph: stock\\_report and 学习\\_笔记.',
    '',
    '> Quoted stock\\_report and 学习\\_笔记.',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| Report | stock\\_report |',
    '| 笔记 | 学习\\_笔记 |',
    '',
    '## 1\\. fitness-tracker',
    '',
    'Edit elsewhere: keep this line.',
    '',
  ].join('\n')
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  const initialPuts = workspacePutCount()
  const before = await stat(path.join(workspace, fileName))
  await openFile(fileName, 'Paragraph:')

  await waitUntil('escaped literal Markdown to open in the rich editor', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror') && !document.querySelector('.source-fidelity-warning') && !document.querySelector('.markdown-repair-banner'))`,
  ))
  assert.match(await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText || ''`), /stock_report/)
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.source-editor .cm-content'))`), false)
  await saveRepairScreenshot('intraword-escapes-rich.png')
  await new Promise(resolve => setTimeout(resolve, 3300))
  assert.equal(workspacePutCount(), initialPuts, 'opening intraword escapes must not send a workspace PUT')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), source, 'opening rich-safe escaped text must preserve the original bytes')
  assert.equal((await stat(path.join(workspace, fileName))).mtimeMs, before.mtimeMs)

  await connection.evaluate(`document.querySelector('[aria-label="切换到源码编辑"]')?.click()`)
  await waitUntil('rich-safe escaped Markdown to switch to source mode', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view)`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), source)
  await connection.evaluate(`document.querySelector('[aria-label="切换到富文本编辑"]')?.click()`)
  await waitUntil('rich-safe escaped Markdown to return to rich mode', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror') && !document.querySelector('.source-fidelity-warning'))`,
  ))
  assert.equal(workspacePutCount(), initialPuts, 'switching modes without editing must not send a workspace PUT')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), source)

  const selected = await connection.evaluate(`(() => {
    const editor = document.querySelector('.ProseMirror')
    const paragraph = Array.from(editor?.querySelectorAll('p') || []).find(node => node.innerText.includes('Edit elsewhere: keep this line.'))
    if (!editor || !paragraph) return false
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(false)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  })()`)
  assert.equal(selected, true)
  await connection.send('Input.insertText', { text: ' edited' })
  const beforeEditPuts = workspacePutCount()
  await clickSave()
  const saved = await waitForDiskMarker(fileName, 'Edit elsewhere: keep this line. edited')
  assert.equal(workspacePutCount() - beforeEditPuts, 1, 'one explicit rich edit should save one snapshot')
  assert.ok(saved.includes('stock\\_report'))
  assert.ok(saved.includes('学习\\_笔记'))
  assert.ok(saved.includes('> Quoted stock\\_report and 学习\\_笔记.'))
  assert.ok(saved.includes('| Report | stock\\_report |'))
  assert.ok(saved.includes('## 1\\. fitness-tracker'))
  assert.equal(
    marked.parse(saved),
    marked.parse(source.replace('Edit elsewhere: keep this line.', 'Edit elsewhere: keep this line. edited')),
    'the saved conversion chain should keep the original Markdown rendering',
  )

  const putsBeforeReopen = workspacePutCount()
  await setupPage()
  await openFile(fileName, 'Paragraph:')
  await waitUntil('saved escaped Markdown to reopen without warnings', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror') && !document.querySelector('.source-fidelity-warning') && !document.querySelector('.markdown-repair-banner'))`,
  ))
  await new Promise(resolve => setTimeout(resolve, 3300))
  assert.equal(workspacePutCount(), putsBeforeReopen, 'reopening escaped Markdown must not send an automatic repair PUT')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), saved)
  assert.match(await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText || ''`), /stock_report/)
})

test('escaped underscores in image alt text remain source-protected without an open-time write', async () => {
  const fileName = 'image-alt-escape.md'
  const source = 'Keep stock\\_report as plain text.\n\n![stock\\_report](assets/x.png)\n'
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  const initialPuts = workspacePutCount()
  const before = await stat(path.join(workspace, fileName))
  await openFile(fileName, 'Keep stock')

  await waitUntil('image alt escape to stay in source mode', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content') && document.querySelector('.source-fidelity-warning') && document.querySelector('.cm-protected-range'))`,
  ))
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.ProseMirror'))`), false)
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), source)
  await new Promise(resolve => setTimeout(resolve, 3300))
  assert.equal(workspacePutCount(), initialPuts, 'image alt source protection must not write the file while opening')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), source)
  assert.equal((await stat(path.join(workspace, fileName))).mtimeMs, before.mtimeMs)
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

test('unsupported link destinations stay source-protected and survive autosave byte-for-byte', async () => {
  const fileName = 'unsupported-link-fidelity.md'
  const fileLink = '[Jump](file:///private/tmp/synthetic-note.md)'
  const vaultLink = '[Vault](obsidian://open?vault=Demo&file=Note)'
  const unknownLink = '[Unknown](unknown-note://open/target)'
  const javascriptLink = '[Run](javascript:window.__n01Executed=true)'
  const source = [
    fileLink,
    '',
    vaultLink,
    '',
    `- ${fileLink}`,
    `- ${fileLink}`,
    '',
    `> ${vaultLink}`,
    '',
    '| Location | Link |',
    '| --- | --- |',
    `| table | ${fileLink} |`,
    '',
    unknownLink,
    '',
    javascriptLink,
    '',
    'Adjacent paragraph.',
    '',
  ].join('\n')
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  await openFile(fileName, 'Adjacent paragraph.')
  await waitUntil('unsupported Markdown link destinations to enter source mode', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content') && document.querySelector('.source-fidelity-warning'))`,
  ))
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.ProseMirror'))`), false)
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), source)

  await waitUntil('all unsupported link tokens to receive exact source diagnostics', () => connection.evaluate(
    `document.querySelectorAll('.cm-protected-range').length === 8`,
  ))
  const protectedTokens = await connection.evaluate(`Array.from(document.querySelectorAll('.cm-protected-range')).map(node => node.textContent)`)
  assert.deepEqual(protectedTokens, [fileLink, vaultLink, fileLink, fileLink, vaultLink, fileLink, unknownLink, javascriptLink])
  assert.equal(await connection.evaluate(`Boolean(document.querySelector('.source-editor a[href^="javascript:"]'))`), false,
    'source-protected JavaScript destinations must never become executable anchors')
  await dispatchRealInput(`Array.from(document.querySelectorAll('.cm-protected-range')).find(node => node.textContent === ${JSON.stringify(javascriptLink)})`)
  assert.equal(await connection.evaluate(`window.__n01Executed === true`), false, 'interacting with protected JavaScript Markdown must not execute it')

  const initialPuts = workspacePutCount()
  const editedSource = source.replace('Adjacent paragraph.', 'Adjacent paragraph. edited')
  await connection.evaluate(`(() => {
    const view = document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view;
    const marker = 'Adjacent paragraph.';
    const from = view?.state.doc.toString().indexOf(marker);
    if (!view || from < 0) return false;
    const cursor = from + marker.length;
    view.dispatch({ changes: { from: cursor, to: cursor, insert: ' edited' } });
    return view.state.doc.toString() === ${JSON.stringify(editedSource)};
  })()`)
  const saved = await waitForDiskMarker(fileName, 'Adjacent paragraph. edited')
  await waitUntil('protected Markdown autosave to report success', () => connection.evaluate(
    `document.querySelector('.save-status')?.innerText.includes('已保存')`,
  ))
  assert.ok(workspacePutCount() > initialPuts, 'editing protected Markdown must reach disk through autosave')
  assert.equal(saved, editedSource, 'the saved Markdown must retain every original link target and container')
})

test('rich conversion warning names unsupported link destinations and cancel preserves source', async () => {
  const fileName = 'unsupported-link-rich-cancel.md'
  const source = '[Jump](obsidian://open?vault=Demo&file=Note)\n\nAdjacent paragraph.\n'
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  await openFile(fileName, 'Jump')
  await waitUntil('unsupported link to enter source mode before conversion', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content') && document.querySelector('.source-fidelity-warning'))`,
  ))

  const initialPuts = workspacePutCount()
  await connection.evaluate(`document.querySelector('[aria-label="切换到富文本编辑"]')?.click()`)
  await waitUntil('rich conversion warning for an unsupported link', () => connection.evaluate(
    `Boolean(document.querySelector('.ant-modal-confirm')?.innerText.includes('此文档包含源码模式保护内容'))`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.ant-modal-confirm')?.innerText.includes('不受支持的链接目标')`), true,
    'the confirmation must tell users that unsupported link destinations may be rewritten')

  await connection.evaluate(`Array.from(document.querySelectorAll('.ant-modal-confirm button')).find(button => button.innerText.trim() === '继续源码模式')?.click()`)
  await waitUntil('source mode to remain active after canceling rich conversion', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content') && !document.querySelector('.ProseMirror') && !document.querySelector('.ant-modal-confirm'))`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), source)
  await new Promise(resolve => setTimeout(resolve, 3300))
  assert.equal(workspacePutCount(), initialPuts, 'canceling rich conversion must not trigger an autosave')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), source, 'canceling must leave the original link target on disk')
})

test('CRLF unsupported links in blockquotes, lists, and tables stay protected through autosave', async () => {
  const fileName = 'crlf-unsupported-links.md'
  const quoteLink = '[Vault](obsidian://open?vault=Demo&file=Note)'
  const listLink = '[Jump](file:///private/tmp/synthetic-note.md)'
  const source = [
    `> Quote heading\r\n> ${quoteLink}\r\n`,
    '\r\n',
    `- List heading\r\n  ${listLink}\r\n`,
    '\r\n',
    '| Location | Link |\r\n| --- | --- |\r\n| table | [Vault](obsidian://open?vault=Demo&file=Note) |\r\n',
    '\r\n',
    'Adjacent paragraph.\r\n',
  ].join('')
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  await openFile(fileName, 'Adjacent paragraph.')
  assert.equal(await connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content') && document.querySelector('.source-fidelity-warning'))`,
  ), true, 'CRLF link containers must enter source mode')
  const normalizeLineEndings = value => value.replace(/\r\n?/g, '\n')
  const editorSource = await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`)
  assert.equal(normalizeLineEndings(editorSource), normalizeLineEndings(source))

  await waitUntil('CRLF rejected links to receive their source diagnostics', () => connection.evaluate(
    `document.querySelectorAll('.cm-protected-range').length === 3`,
  ))
  const protectedTokens = await connection.evaluate(`Array.from(document.querySelectorAll('.cm-protected-range')).map(node => node.textContent)`)
  assert.deepEqual(protectedTokens, [quoteLink, listLink, quoteLink])

  const initialPuts = workspacePutCount()
  const editedSource = source.replace('Adjacent paragraph.', 'Adjacent paragraph. edited')
  const editorEditedSource = await connection.evaluate(`(() => {
    const view = document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view;
    const marker = 'Adjacent paragraph.';
    const from = view?.state.doc.toString().indexOf(marker);
    if (!view || from < 0) return null;
    const cursor = from + marker.length;
    view.dispatch({ changes: { from: cursor, to: cursor, insert: ' edited' } });
    return view.state.doc.toString();
  })()`)
  assert.equal(normalizeLineEndings(editorEditedSource), normalizeLineEndings(editedSource))
  const saved = await waitForDiskMarker(fileName, 'Adjacent paragraph. edited')
  await waitUntil('CRLF Markdown autosave to report success', () => connection.evaluate(
    `document.querySelector('.save-status')?.innerText.includes('已保存')`,
  ))
  assert.ok(workspacePutCount() > initialPuts)
  assert.equal(saved, editedSource, 'autosave must preserve original CRLFs and every unsupported link target')
})

test('https, relative, and mailto links remain editable in rich mode', async () => {
  const fileName = 'supported-link-fidelity.md'
  const source = [
    '[Web](https://example.com/docs)',
    '[Relative](../notes/linked-note.md)',
    '[Email](mailto:person@example.com)',
    '',
  ].join('\n')
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  await openFile(fileName, 'Relative')
  await waitUntil('supported links to load in rich mode', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror a') && !document.querySelector('.source-fidelity-warning'))`,
  ))
  const hrefs = await connection.evaluate(`Array.from(document.querySelectorAll('.ProseMirror a')).map(link => link.getAttribute('href'))`)
  assert.deepEqual(hrefs, [
    'https://example.com/docs',
    '../notes/linked-note.md',
    'mailto:person@example.com',
  ])
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
  await waitUntil('autolink repair proposal and its explicit actions', () => connection.evaluate(
    `(() => { const banner = document.querySelector('.markdown-repair-banner'); const labels = Array.from(banner?.querySelectorAll('.markdown-repair-actions button') || []).map(button => button.innerText.trim()); return labels.includes('暂不修复') && labels.includes('确认修复并保存') })()`,
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

test('mixed and ordered task states survive source autosave and reopen', async () => {
  const switchFile = 'task-state-switch.md'
  await writeFile(path.join(workspace, switchFile), '# Switch away from task states\n')
  const cases = [
    {
      fileName: 'mixed-task-state.md',
      source: '# Mixed task state preservation\n\n- ordinary item\n- [x] checked task\n- [ ] pending task\n\nNeighbor paragraph: untouched.\n',
      ordered: false,
      taskStates: [false, true, true],
      checkedStates: [undefined, true, false],
    },
    {
      fileName: 'ordered-task-state.md',
      source: '# Ordered task state preservation\n\n1. [x] checked task\n2. [ ] pending task\n\nNeighbor paragraph: untouched.\n',
      ordered: true,
      taskStates: [true, true],
      checkedStates: [true, false],
    },
  ]

  for (const scenario of cases) {
    await writeFile(path.join(workspace, scenario.fileName), scenario.source)
    await setupPage()
    const initialPuts = workspacePutCount()
    await openFile(scenario.fileName, 'task state preservation')
    await waitUntil(`${scenario.fileName} source protection`, () => connection.evaluate(
      `Boolean(document.querySelector('.source-editor .cm-content') && document.querySelector('.source-fidelity-warning') && document.querySelector('.cm-protected-range'))`,
    ))
    assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), scenario.source)
    assert.equal(await connection.evaluate(`Boolean(document.querySelector('.ProseMirror'))`), false, 'incompatible task Markdown must not enter the rich editor')
    assert.equal(await connection.evaluate(`Boolean(document.querySelector('.markdown-repair-banner'))`), false, 'valid task Markdown must stay unmodified instead of receiving a repair proposal')

    const originalParagraph = 'Neighbor paragraph: untouched.'
    await connection.evaluate(`(() => {
      const view = document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view
      const text = view?.state.doc.toString() || ''
      const from = text.indexOf(${JSON.stringify(originalParagraph)})
      if (!view || from < 0) return false
      view.dispatch({ selection: { anchor: from, head: from + ${originalParagraph.length} } })
      view.focus()
      return true
    })()`)
    const editedParagraph = 'Neighbor paragraph: edited.'
    await connection.send('Input.insertText', { text: editedParagraph })
    const saved = await waitUntil(`${scenario.fileName} source autosave`, async () => {
      const content = await readFile(path.join(workspace, scenario.fileName), 'utf8').catch(() => '')
      return content.includes(editedParagraph) ? content : null
    }, 15000)
    assert.equal(saved, scenario.source.replace(originalParagraph, editedParagraph), 'editing a neighboring paragraph must preserve the source list syntax exactly')
    assert.ok(workspacePutCount() > initialPuts, 'the source edit should reach disk through autosave')
    const taskList = marked.lexer(saved).find(token => token.type === 'list')
    assert.equal(taskList?.ordered, scenario.ordered)
    assert.deepEqual(taskList?.items.map(item => Boolean(item.task)), scenario.taskStates)
    assert.deepEqual(taskList?.items.map(item => item.checked), scenario.checkedStates)

    await openFile(switchFile, 'Switch away from task states')
    await connection.evaluate(`Array.from(document.querySelectorAll('.tab-close')).find(button => button.getAttribute('aria-label') === ${JSON.stringify(`关闭 ${scenario.fileName}`)})?.click()`)
    await waitUntil(`${scenario.fileName} saved tab to close`, () => connection.evaluate(
      `!Array.from(document.querySelectorAll('.document-tab')).some(tab => tab.innerText.includes(${JSON.stringify(scenario.fileName)}))`,
    ))
    await openFile(scenario.fileName, 'task state preservation')
    await waitUntil(`${scenario.fileName} task source to reopen from disk`, () => connection.evaluate(
      `document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString() === ${JSON.stringify(saved)}`,
    ))
    assert.equal(await connection.evaluate(`Boolean(document.querySelector('.source-editor .cm-content') && !document.querySelector('.ProseMirror'))`), true)
    assert.equal(await readFile(path.join(workspace, scenario.fileName), 'utf8'), saved)
  }
})

test('nested task checkboxes do not convert their ordinary parent list item', async () => {
  const fileName = 'nested-task-boundary.md'
  const source = '- Parent\n  - [x] Nested checked task\n  - [ ] Nested pending task\n'
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  await openFile(fileName, 'Nested checked task')
  await waitUntil('nested task source guard before explicit rich conversion', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content') && document.querySelector('.source-fidelity-warning'))`,
  ))
  await connection.evaluate(`document.querySelector('[aria-label="切换到富文本编辑"]')?.click()`)
  await waitUntil('explicit rich conversion prompt for the nested list', () => connection.evaluate(
    `Boolean(document.querySelector('.ant-modal-confirm')?.innerText.includes('此文档包含源码模式保护内容'))`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('.ant-modal-confirm button')).find(button => button.innerText.trim() === '仍切换到富文本')?.click()`)
  await waitUntil('explicit nested task conversion to render', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror ul') && document.querySelector('.ProseMirror li[data-type="taskItem"]'))`,
  ))
  const structure = await connection.evaluate(`(() => {
    const lists = Array.from(document.querySelectorAll('.ProseMirror ul'))
    const outerItem = lists[0]?.querySelector(':scope > li')
    const inner = lists[1]
    const items = Array.from(inner?.querySelectorAll(':scope > li') || [])
    return {
      outerType: lists[0]?.getAttribute('data-type') || null,
      outerItemType: outerItem?.getAttribute('data-type') || null,
      innerType: inner?.getAttribute('data-type') || null,
      innerChecks: items.map(item => item.getAttribute('data-checked')),
    }
  })()`)
  assert.equal(structure.outerType, null, 'the child checkboxes must not turn the ordinary parent list into a task list')
  assert.equal(structure.outerItemType, null, 'the ordinary parent item must remain ordinary')
  assert.equal(structure.innerType, 'taskList')
  assert.deepEqual(structure.innerChecks, ['true', 'false'])
})

test('task checkboxes align with wrapped Chinese text and checked state survives save and reopen', async () => {
  const fileName = 'task-layout-persistence.md'
  const switchFile = 'task-layout-switch.md'
  const longTaskText = '这条较长的中文待办用于检查复选框是否与正文首行对齐，并确认文字换行后仍保持清晰易读。'.repeat(8)
  const source = `- [ ] ${longTaskText}\n- [x] 已完成的中文任务\n`
  await writeFile(path.join(workspace, fileName), source)
  await writeFile(path.join(workspace, switchFile), '# Switch away from task list\n')
  await setupPage()
  await openFile(fileName, '这条较长的中文待办')

  await waitUntil('rich task items with live node view attributes', () => connection.evaluate(
    `document.querySelectorAll('.ProseMirror li[data-type="taskItem"]').length === 2`,
  ))
  const layout = await connection.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.ProseMirror li[data-type="taskItem"]'));
    const checkbox = items[0]?.querySelector(':scope > label input[type="checkbox"]');
    const paragraph = items[0]?.querySelector(':scope > div > p');
    if (!checkbox || !paragraph) return null;
    const checkboxRect = checkbox.getBoundingClientRect();
    const paragraphRect = paragraph.getBoundingClientRect();
    return {
      count: items.length,
      firstChecked: checkbox.checked,
      completedChecked: items[1]?.querySelector(':scope > label input[type="checkbox"]')?.checked,
      firstLineTopDelta: Math.abs(checkboxRect.top - paragraphRect.top),
      paragraphHeight: paragraphRect.height,
      lineHeight: Number.parseFloat(getComputedStyle(paragraph).lineHeight),
      listMarker: getComputedStyle(items[0].parentElement).listStyleType,
    };
  })()`)
  assert.equal(layout.count, 2)
  assert.equal(layout.firstChecked, false)
  assert.equal(layout.completedChecked, true)
  assert.ok(layout.firstLineTopDelta < 12, `checkbox and first text line should align (delta ${layout.firstLineTopDelta}px)`)
  assert.ok(layout.paragraphHeight > layout.lineHeight * 1.5, 'the Chinese task text should wrap to multiple lines')
  assert.equal(layout.listMarker, 'none', 'task list should not render an extra bullet marker')

  await connection.evaluate(`document.querySelector('.ProseMirror li[data-type="taskItem"] > label input[type="checkbox"]')?.click()`)
  await waitUntil('first task to become checked in the editor', () => connection.evaluate(
    `document.querySelector('.ProseMirror li[data-type="taskItem"] > label input[type="checkbox"]')?.checked === true`,
  ))
  await waitUntil('checked task Markdown to persist', async () => {
    const saved = await readFile(path.join(workspace, fileName), 'utf8').catch(() => '')
    return saved.includes(`- [x] ${longTaskText}`) ? saved : null
  })

  await openFile(switchFile, 'Switch away from task list')
  await openFile(fileName, '这条较长的中文待办')
  await waitUntil('checked state to reload from disk', () => connection.evaluate(
    `document.querySelectorAll('.ProseMirror li[data-type="taskItem"]')[0]?.querySelector(':scope > label input[type="checkbox"]')?.checked === true && document.querySelectorAll('.ProseMirror li[data-type="taskItem"]')[1]?.querySelector(':scope > label input[type="checkbox"]')?.checked === true`,
  ))
  assert.ok((await readFile(path.join(workspace, fileName), 'utf8')).includes(`- [x] ${longTaskText}`))
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
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(node => node.innerText.trim() === 'docs')`,
  ))
  await connection.evaluate(`document.querySelector('[aria-label="更多目录操作"]')?.click()`)
  await waitUntil('directory actions menu to open', () => connection.evaluate(
    `Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).some(node => node.innerText.trim() === '全部展开')`,
  ))
  await connection.evaluate(`Array.from(document.querySelectorAll('.ant-dropdown-menu-item')).find(node => node.innerText.trim() === '全部展开')?.click()`)
  await waitUntil('nested Markdown file visible after expand all', () => connection.evaluate(
    `Array.from(document.querySelectorAll('[data-testid="file-tree-item"]')).some(node => node.innerText.trim() === 'relative-images.md')`,
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

  await connection.evaluate(`document.querySelector('[aria-label="切换到源码编辑"]')?.click()`)
  await waitUntil('nested source editor', () => connection.evaluate(
    `Boolean(document.querySelector('.source-editor .cm-content'))`,
  ))
  assert.equal(await connection.evaluate(`document.querySelector('.source-editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()`), original)
  await connection.evaluate(`document.querySelector('[aria-label="切换到富文本编辑"]')?.click()`)
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

  await connection.evaluate(`document.querySelector('[aria-label="切换到源码编辑"]')?.click()`)
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
  await writeFile(path.join(workspace, fileName), '# Image presentation fixture\n\nBefore the first image remains intact.\n\n![diagram](assets/presentation.png)<!-- se-image:width=50;align=center -->\n\nBetween images remains intact.\n\n![second](assets/presentation.png)<!-- se-image:width=100;align=left -->\n\nAfter the second image remains intact.\n')
  await setupPage()
  await openFile(fileName, 'Image presentation fixture')
  await waitUntil('both image presentation nodes', () => connection.evaluate(`document.querySelectorAll('.ProseMirror img').length === 2`))
  const firstImage = `document.querySelectorAll('.ProseMirror img')[0]`
  const secondImage = `document.querySelectorAll('.ProseMirror img')[1]`
  const readImages = () => connection.evaluate(`Array.from(document.querySelectorAll('.ProseMirror img')).map(img => ({
    width: img.getAttribute('data-image-width'), align: img.getAttribute('data-image-align'), style: img.getAttribute('style'),
  }))`)
  const initial = await readImages()
  assert.deepEqual(initial.map(({ width, align }) => ({ width, align })), [
    { width: '50', align: 'center' }, { width: '100', align: 'left' },
  ])
  assert.match(initial[0].style, /width:\s*50%/)
  assert.match(initial[0].style, /margin-left:\s*auto/)

  await dispatchRealInput(firstImage)
  await waitForSelectedImage(firstImage, 'first image to become the old editor selection')
  const rightClickMenu = await openObjectContextMenu(secondImage, { object: 'image' })
  await waitForSelectedImage(secondImage, 'right-clicked second image to replace the old selection')
  await saveRepairScreenshot('image-context-menu-desktop.png')
  assert.equal(await waitForFocusedContextMenuItem('图片操作'), '左对齐', 'right-click should focus the first image command')
  assert.equal(await connection.evaluate(`!Array.from(document.querySelectorAll('.ProseMirror img')).find(img => img.getAttribute('alt') === 'diagram')?.classList.contains('ProseMirror-selectednode')`), true)
  await assertNoPersistentObjectToolbars()
  assertContextMenuFitsViewport(rightClickMenu.geometry, 'desktop image context')
  assert.ok(rightClickMenu.geometry.visible, 'right-clicking the second image should open its menu')
  await pressKey('Escape', 27)
  await waitForContextMenuClosed('图片操作')
  await waitUntil('Escape to restore focus to the selected image', () => connection.evaluate(
    `document.activeElement?.classList.contains('ProseMirror-focused') && document.querySelectorAll('.ProseMirror img')[1]?.classList.contains('ProseMirror-selectednode')`,
  ))

  const keyboardMenu = await openObjectContextMenu(secondImage, { object: 'image', keyboard: true })
  assert.ok(keyboardMenu.geometry.visible, 'Shift+F10 should open the selected image menu')
  assert.equal(await waitForFocusedContextMenuItem('图片操作'), '左对齐', 'Shift+F10 should focus the first image command')
  const firstFocusedCommand = await connection.evaluate(`document.activeElement.getAttribute('aria-label')`)
  await pressKey('ArrowDown', 40)
  await waitUntil('ArrowDown to move through image context commands', () => connection.evaluate(
    `document.querySelector('[role="menu"][aria-label="图片操作"]')?.contains(document.activeElement) && document.activeElement.getAttribute('aria-label') !== ${JSON.stringify(firstFocusedCommand)}`,
  ))
  await pressKey('Escape', 27)
  await waitForContextMenuClosed('图片操作')
  await waitUntil('Escape to return image selection to the editor', () => connection.evaluate(
    `document.activeElement?.classList.contains('ProseMirror-focused') && document.querySelectorAll('.ProseMirror img')[1]?.classList.contains('ProseMirror-selectednode')`,
  ))

  await openObjectContextMenu(secondImage, { object: 'image' })
  await clickContextMenuItem('图片操作', '宽度75%')
  await waitForContextMenuClosed('图片操作')
  await waitUntil('preset width to apply to the right-clicked image only', async () => {
    const images = await readImages()
    return images[1].width === '75' && images[0].width === '50' ? true : null
  })
  await openObjectContextMenu(secondImage, { object: 'image' })
  await clickContextMenuItem('图片操作', '居中')
  await waitForContextMenuClosed('图片操作')
  await waitUntil('center alignment to apply to the right-clicked image only', async () => {
    const images = await readImages()
    return images[1].align === 'center' && images[0].align === 'center' && images[0].width === '50' ? true : null
  })
  await openObjectContextMenu(secondImage, { object: 'image' })
  await clickContextMenuItem('图片操作', '左对齐')
  await waitForContextMenuClosed('图片操作')
  await waitUntil('left alignment to target the second image', () => connection.evaluate(
    `document.querySelectorAll('.ProseMirror img')[1]?.getAttribute('data-image-align') === 'left'`,
  ))

  await openObjectContextMenu(secondImage, { object: 'image' })
  await clickContextMenuItem('图片操作', '自定义宽度…')
  const sliderMenu = await waitForStableContextMenu('图片操作')
  assertContextMenuFitsViewport(sliderMenu, 'custom image width')
  const menuScroll = await readContextMenuScrollMetrics('图片操作')
  assert.ok(!menuScroll.overflowing || menuScroll.scrollable,
    `an expanded image menu must expose a scrollport if its body content overflows: ${JSON.stringify(menuScroll)}`)
  const slider = `document.querySelector('[role="slider"][aria-label="图片宽度百分比"]')`
  const sliderBounds = await waitUntil('custom image width slider', () => connection.evaluate(`(() => {
    const slider = ${slider};
    if (!slider || !slider.getClientRects().length) return null;
    return { min: slider.getAttribute('min') || slider.getAttribute('aria-valuemin'),
      max: slider.getAttribute('max') || slider.getAttribute('aria-valuemax'),
      step: slider.getAttribute('step') || slider.getAttribute('aria-valuestep'),
      value: slider.value || slider.getAttribute('aria-valuenow') };
  })()`))
  assert.deepEqual(sliderBounds, { min: '25', max: '100', step: '5', value: '75' })
  await saveRepairScreenshot('image-context-menu-slider-open.png')
  const sliderSnapshots = []
  const recordSliderState = async step => {
    const state = await connection.evaluate(`(() => {
      const slider = document.querySelector('[role="slider"][aria-label="图片宽度百分比"]');
      const menu = document.querySelector('[role="menu"][aria-label="图片操作"]');
      const active = document.activeElement, rect = menu?.getBoundingClientRect();
      return { value: slider?.value ?? null, ariaValue: slider?.getAttribute('aria-valuenow') ?? null,
        output: slider?.closest('.editor-object-slider')?.querySelector('output')?.innerText ?? null,
        active: active && { tag: active.tagName, type: active.type || null, role: active.getAttribute('role'),
          label: active.getAttribute('aria-label'), className: String(active.className) },
        imageAttrs: Array.from(document.querySelectorAll('.ProseMirror img')).map(img => ({ width: img.getAttribute('data-image-width'), align: img.getAttribute('data-image-align') })),
        menu: rect && { visible: Boolean(menu.getClientRects().length), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight, scrollTop: menu.scrollTop } };
    })()`)
    sliderSnapshots.push({ step, ...state })
  }
  await dispatchRealInput(slider, { scrollIntoView: false })
  await recordSliderState('mouse click')
  await pressKey('Home', 36)
  await recordSliderState('Home')
  await pressKey('ArrowRight', 39)
  await recordSliderState('ArrowRight 1')
  await pressKey('ArrowRight', 39)
  await recordSliderState('ArrowRight 2')
  await pressKey('ArrowRight', 39)
  await recordSliderState('ArrowRight 3')
  try {
    await waitUntil('real slider keyboard input to set custom width to 40 percent', () => connection.evaluate(
      `document.querySelectorAll('.ProseMirror img')[1]?.getAttribute('data-image-width') === '40'`,
    ))
  } catch (error) {
    throw new Error(`${error.message}\nImage slider evidence: ${JSON.stringify(sliderSnapshots)}`)
  }
  await saveRepairScreenshot('image-context-menu-custom-width.png')
  const editorScrollBefore = await connection.evaluate(`(() => {
    const scroll = document.querySelector('.editor-scroll'), rect = scroll.getBoundingClientRect();
    return { top: scroll.scrollTop, x: rect.left + 12, y: rect.top + rect.height / 2 };
  })()`)
  await connection.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: editorScrollBefore.x, y: editorScrollBefore.y,
    deltaX: 0, deltaY: editorScrollBefore.top > 20 ? -100 : 100,
  })
  await waitUntil('user wheel input to scroll the document and close the image menu', () => connection.evaluate(
    `document.querySelector('.editor-scroll').scrollTop !== ${editorScrollBefore.top} && !document.querySelector('[role="menu"][aria-label="图片操作"]')`,
  ))
  assert.equal((await readImages())[1].width, '40', 'scrolling must not alter the image width')
  await openObjectContextMenu(secondImage, { object: 'image' })
  await clickContextMenuItem('图片操作', '自定义宽度…')
  await waitUntil('custom width slider to reopen for Escape', () => connection.evaluate(
    `document.querySelector('[role="slider"][aria-label="图片宽度百分比"]')?.value === '40'`,
  ))
  await pressKey('Escape', 27)
  await waitForContextMenuClosed('图片操作')
  await waitUntil('custom width Escape to preserve the selected editor image', () => connection.evaluate(
    `document.activeElement?.classList.contains('ProseMirror-focused') && document.querySelectorAll('.ProseMirror img')[1]?.classList.contains('ProseMirror-selectednode')`,
  ))

  const handle = await waitUntil('image corner resize handle remains available', () => connection.evaluate(`(() => { const box = document.querySelector('.image-resize-handle')?.getBoundingClientRect(); return box && { x: box.x + box.width / 2, y: box.y + box.height / 2 } })()`))
  await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 })
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + 40, y: handle.y, button: 'left', buttons: 1 })
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 40, y: handle.y, button: 'left', clickCount: 1 })
  await waitUntil('drag changes selected image width', () => connection.evaluate(`Number(document.querySelectorAll('.ProseMirror img')[1]?.getAttribute('data-image-width')) > 40`))
  await openObjectContextMenu(secondImage, { object: 'image' })
  await clickContextMenuItem('图片操作', '宽度75%')
  await waitForContextMenuClosed('图片操作')
  await waitUntil('preset overrides the selected image drag width', () => connection.evaluate(`document.querySelectorAll('.ProseMirror img')[1]?.getAttribute('data-image-width') === '75'`))

  await setTestViewport(390, 844, true)
  await dispatchRealInput(firstImage, { touch: true })
  await waitForSelectedImage(firstImage, 'one mobile tap to select the first image')
  await saveRepairScreenshot('image-mobile-selected-before-more.png')
  const mobileMore = await waitForStableObjectMenuButton('更多图片操作', firstImage)
  assert.equal(mobileMore.hitLabel, '更多图片操作')
  await assertNoPersistentObjectToolbars()
  await saveRepairScreenshot('image-more-button-mobile.png')
  const mobileMenu = await openObjectContextMenu(firstImage, { object: 'image', touch: true })
  assert.ok(mobileMenu.geometry.visible, 'the image corner touch button should open its menu')
  assertContextMenuFitsViewport(mobileMenu.geometry, 'mobile image context')
  await saveRepairScreenshot('image-context-menu-mobile.png')
  await clickContextMenuItem('图片操作', '宽度75%', { touch: true })
  await waitForContextMenuClosed('图片操作')
  await waitUntil('touch width command to change the first image while retaining the second', async () => {
    const images = await readImages()
    return images[0].width === '75' && images[1].width === '75' && images[1].align === 'left'
  })
  await openObjectContextMenu(firstImage, { object: 'image', touch: true })
  await clickContextMenuItem('图片操作', '宽度50%', { touch: true })
  await waitForContextMenuClosed('图片操作')
  await waitUntil('touch width command to restore only the first image', async () => {
    const images = await readImages()
    return images[0].width === '50' && images[1].width === '75'
  })
  await openObjectContextMenu(firstImage, { object: 'image', touch: true })
  await pressKey('Escape', 27)
  await waitForContextMenuClosed('图片操作')
  await setTestViewport(1195, 751, false)

  await clickSave()
  await waitForDiskMarker(fileName, '<!-- se-image:width=50;align=center -->')
  await waitForDiskMarker(fileName, '<!-- se-image:width=75;align=left -->')
  await waitUntil('image save acknowledgment', () => connection.evaluate(`document.querySelector('.save-status')?.innerText.includes('已保存')`))
  const saved = await readFile(path.join(workspace, fileName), 'utf8')
  assert.match(saved, /!\[diagram\]\(assets\/presentation\.png\)<!-- se-image:width=50;align=center -->/)
  assert.match(saved, /!\[second\]\(assets\/presentation\.png\)<!-- se-image:width=75;align=left -->/)
  for (const text of ['Before the first image remains intact.', 'Between images remains intact.', 'After the second image remains intact.']) assert.ok(saved.includes(text))
  await setupPage()
  await openFile(fileName, 'Image presentation fixture')
  await waitUntil('both image nodes to reopen', () => connection.evaluate(`document.querySelectorAll('.ProseMirror img').length === 2`))
  assert.deepEqual((await readImages()).map(({ width, align }) => ({ width, align })), [
    { width: '50', align: 'center' }, { width: '75', align: 'left' },
  ], `disk=${JSON.stringify(await readFile(path.join(workspace, fileName), 'utf8'))}`)
  await dispatchRealInput(firstImage)
  await waitForSelectedImage(firstImage)
  await openObjectContextMenu(secondImage, { object: 'image' })
  await waitForSelectedImage(secondImage, 'right-click should select the second image before deletion')
  await clickContextMenuItem('图片操作', '删除图片')
  await waitForContextMenuClosed('图片操作')
  await waitUntil('delete only the context-targeted second image', () => connection.evaluate(`document.querySelectorAll('.ProseMirror img').length === 1`))
  await waitUntil('deleted image action to return focus to a valid editor caret', () => connection.evaluate(`(() => {
    const anchor = window.getSelection()?.anchorNode;
    const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    return Boolean(document.activeElement?.classList.contains('ProseMirror-focused') && element?.closest('.ProseMirror'));
  })()`))
  assert.deepEqual((await readImages()).map(({ width, align }) => ({ width, align })), [{ width: '50', align: 'center' }])
  await clickSave()
  await waitUntil('saved Markdown to contain only the first image after target deletion', async () => {
    const content = await readFile(path.join(workspace, fileName), 'utf8').catch(() => '')
    return content.includes('<!-- se-image:width=50;align=center -->') && !content.includes('![second]') ? content : null
  })
  const afterDelete = await readFile(path.join(workspace, fileName), 'utf8')
  assert.match(afterDelete, /!\[diagram\]\(assets\/presentation\.png\)<!-- se-image:width=50;align=center -->/)
  assert.doesNotMatch(afterDelete, /!\[second\]/)
  for (const text of ['Before the first image remains intact.', 'Between images remains intact.', 'After the second image remains intact.']) assert.ok(afterDelete.includes(text))
  await setupPage()
  await openFile(fileName, 'Image presentation fixture')
  await waitUntil('only the untouched first image to remain after reopening the deletion', () => connection.evaluate(`document.querySelectorAll('.ProseMirror img').length === 1`))
  assert.deepEqual((await readImages()).map(({ width, align }) => ({ width, align })), [{ width: '50', align: 'center' }])
})

test('explicit left alignment survives rich table editing, save, and reopen', async () => {
  const fileName = 'explicit-left-table.md'
  const source = [
    '# External API fixture',
    '',
    '| 参数 | 值 | 说明 |',
    '|:---|:---|:---|',
    '| `page` | `1 ~ 40` | 页号，每页 100 条 |',
    '| `num` | `100` | 每页数量（固定） |',
    '',
  ].join('\n')
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  const initialPuts = workspacePutCount()
  await openFile(fileName, 'External API fixture')

  await waitUntil('explicitly aligned table to load in rich mode', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror table') && !document.querySelector('.source-fidelity-warning'))`,
  ))
  assert.equal(await connection.evaluate(`Array.from(document.querySelectorAll('.ProseMirror th, .ProseMirror td')).every(cell => cell.getAttribute('align') === 'left')`), true,
    'Marked left alignment must survive in every header and body cell')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), source, 'opening an aligned table must not rewrite source')
  assert.equal(workspacePutCount(), initialPuts, 'opening an aligned table must not send a workspace PUT')

  const selectedCell = await dispatchRealInput(`document.querySelector('.ProseMirror table td')`)
  assert.deepEqual(selectedCell.targetCell, [0, 1, 0], 'the real click must target a body cell in the aligned table')
  await connection.send('Input.insertText', { text: ' 已编辑' })
  await clickSave()
  const saved = await waitForDiskMarker(fileName, '已编辑')
  assert.match(saved, /^\| :--- \| :--- \| :--- \|$/m, 'saving should retain explicit left alignment delimiters')
  assert.deepEqual(marked.lexer(saved).find(token => token.type === 'table')?.align, ['left', 'left', 'left'])

  await setupPage()
  await openFile(fileName, 'External API fixture')
  await waitUntil('saved left alignment to reopen in rich mode', () => connection.evaluate(
    `Boolean(document.querySelector('.ProseMirror table') && !document.querySelector('.source-fidelity-warning'))`,
  ))
  assert.equal(await connection.evaluate(`Array.from(document.querySelectorAll('.ProseMirror th, .ProseMirror td')).every(cell => cell.getAttribute('align') === 'left')`), true,
    'all reopened header and body cells must retain explicit left alignment')
  assert.equal(await readFile(path.join(workspace, fileName), 'utf8'), saved)
  await saveRepairScreenshot('explicit-left-table-rich.png')
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
  const cell = `document.querySelector('.ProseMirror table tr:nth-child(2) td')`
  const keyboardMenu = await openObjectContextMenu(cell, { keyboard: true })
  assert.ok(keyboardMenu.geometry.visible, 'Shift+F10 should open the selected table context menu')
  assert.equal(await waitForFocusedContextMenuItem('表格操作'), '上方增行',
    'Shift+F10 should focus the first table command')
  const firstTableCommand = await connection.evaluate(`document.activeElement.getAttribute('aria-label')`)
  await pressKey('ArrowDown', 40)
  await waitUntil('ArrowDown to move through table context commands', () => connection.evaluate(
    `document.querySelector('[role="menu"][aria-label="表格操作"]')?.contains(document.activeElement) && document.activeElement.getAttribute('aria-label') !== ${JSON.stringify(firstTableCommand)}`,
  ))
  await pressKey('Escape', 27)
  await waitForContextMenuClosed('表格操作')
  await waitUntil('Escape should return focus to the current table selection', () => connection.evaluate(
    `document.activeElement?.classList.contains('ProseMirror-focused')`,
  ))
  assert.deepEqual((await readDOMCellSelection()).cell, [0, 1, 0], 'Escape should preserve the clicked table cell selection')
  await clickTableAction('下方增行', cell, { shape: { table: 0, rows: 5, columns: 5, description: 'context menu row insertion' } })
  await clickTableAction('右侧增列', cell, { shape: { table: 0, rows: 5, columns: 6, description: 'context menu column insertion' } })
  await waitUntil('expanded table', () => connection.evaluate(`document.querySelectorAll('.ProseMirror table tr').length === 5 && document.querySelectorAll('.ProseMirror table tr:first-child > *').length === 6`))
  assert.equal(await connection.evaluate(`!document.querySelector('.table-context-tools')`), true, 'table actions should not remain as a toolbar')
  await clickSave()
  await waitUntil('table Markdown persisted', async () => {
    const content = await readFile(path.join(workspace, fileName), 'utf8')
    return content.split('\n').filter(line => line.startsWith('|')).length === 6
  })
})

test('scrolled desktop table controls edit the clicked Markdown table and preserve its neighbor after deletion', async () => {
  const fileName = 'scrolled-desktop-table-controls.md'
  await writeFile(path.join(workspace, fileName), makeLongTableControlsSource())
  await setupPage()
  await openFile(fileName, 'Long table controls fixture')
  await waitUntil('both Markdown tables to open in the rich editor', () => connection.evaluate(
    `document.querySelectorAll('.ProseMirror table').length === 2 && !document.querySelector('.source-fidelity-warning')`,
  ))

  const lowerFirstCell = `Array.from(document.querySelectorAll('.ProseMirror table'))[1]?.rows[1]?.cells[0]`
  const lowerSecondCell = `Array.from(document.querySelectorAll('.ProseMirror table'))[1]?.rows[1]?.cells[1]`
  const firstBodyRowCell = (row, column = 1) => `Array.from(document.querySelectorAll('.ProseMirror table'))[1]?.rows[${row}]?.cells[${column - 1}]`

  const beforeTables = await readRichTableState()
  assert.equal(beforeTables.length, 2)
  assert.deepEqual(beforeTables[0].rows, [
    ['UPPER-KEY', 'UPPER-VALUE'],
    ['UPPER-ROW-1', 'UPPER-CELL-1'],
    ['UPPER-ROW-2', 'UPPER-CELL-2'],
  ], 'the first existing table should start with its exact source content')
  assert.deepEqual(beforeTables[1].rows, [
    ['LOWER-KEY', 'LOWER-VALUE'],
    ['LOWER-ROW-1', 'LOWER-CELL-1'],
    ['LOWER-ROW-2', 'LOWER-CELL-2'],
  ], 'the lower existing table should start with its exact source content')

  const initialPuts = workspacePutCount()
  await dispatchRealInput(`Array.from(document.querySelectorAll('.ProseMirror table'))[0]?.rows[1]?.cells[0]`)
  const lowerCellClick = await dispatchRealInput(lowerFirstCell, { button: 'right' })
  assert.ok(lowerCellClick.y > 100, `the lower table should be selected after scrolling into the long document: ${JSON.stringify(lowerCellClick)}`)
  const lowerMenu = await waitForStableContextMenu('表格操作')
  assert.ok(lowerMenu.visible, `right-click should open the table menu for the lower table: ${JSON.stringify(lowerMenu)}`)
  assert.deepEqual((await readDOMCellSelection()).cell, [1, 1, 0], 'right-click should move the editor selection into the clicked lower-table cell')
  assert.equal(await waitForFocusedContextMenuItem('表格操作'), '上方增行', 'right-click should focus the first table command')
  assertContextMenuFitsViewport(lowerMenu, 'desktop table context')
  assert.equal(await connection.evaluate(`!document.querySelector('.table-context-tools')`), true, 'the old always-visible table toolbar must be absent')
  await saveRepairScreenshot('table-context-menu-desktop.png')
  await pressKey('Escape', 27)
  await waitForContextMenuClosed('表格操作')
  await waitUntil('Escape to restore editor focus on the right-clicked lower table cell', () => connection.evaluate(
    `document.activeElement?.classList.contains('ProseMirror-focused')`,
  ))
  assert.deepEqual((await readDOMCellSelection()).cell, [1, 1, 0], 'Escape should preserve the right-clicked lower-table cell')

  await clickTableAction('下方增行', lowerFirstCell, { shape: { table: 1, rows: 4, columns: 2, description: 'mouse click to add a row below the selected lower-table cell' } })
  assert.deepEqual((await readRichTableState())[1].rows, [
    ['LOWER-KEY', 'LOWER-VALUE'],
    ['LOWER-ROW-1', 'LOWER-CELL-1'],
    ['', ''],
    ['LOWER-ROW-2', 'LOWER-CELL-2'],
  ], 'the inserted lower row should follow the cell the user selected')
  await clickTableAction('上方增行', lowerFirstCell, { shape: { table: 1, rows: 5, columns: 2, description: 'mouse click to add a row above the selected lower-table cell' } })
  assert.deepEqual((await readRichTableState())[1].rows, [
    ['LOWER-KEY', 'LOWER-VALUE'],
    ['', ''],
    ['LOWER-ROW-1', 'LOWER-CELL-1'],
    ['', ''],
    ['LOWER-ROW-2', 'LOWER-CELL-2'],
  ], 'the second inserted row should precede the selected row without reordering its neighbors')
  await clickTableAction('删除行', firstBodyRowCell(1), { shape: { table: 1, rows: 4, columns: 2, description: 'mouse click to delete the newly inserted blank row above' } })
  assert.deepEqual((await readRichTableState())[1].rows, [
    ['LOWER-KEY', 'LOWER-VALUE'],
    ['LOWER-ROW-1', 'LOWER-CELL-1'],
    ['', ''],
    ['LOWER-ROW-2', 'LOWER-CELL-2'],
  ], 'deleting the selected blank row should retain the original row order')
  await clickTableAction('删除行', firstBodyRowCell(2), { shape: { table: 1, rows: 3, columns: 2, description: 'mouse click to delete the newly inserted blank row below' } })

  await clickTableAction('左侧增列', lowerFirstCell, { shape: { table: 1, rows: 3, columns: 3, description: 'mouse click to add a column before the selected lower-table cell' } })
  await clickTableAction('右侧增列', lowerSecondCell, { shape: { table: 1, rows: 3, columns: 4, description: 'mouse click to add a column after the selected lower-table cell' } })
  await clickTableAction('删除列', firstBodyRowCell(1, 1), { shape: { table: 1, rows: 3, columns: 3, description: 'mouse click to delete the newly inserted blank column on the left' } })
  await clickTableAction('删除列', firstBodyRowCell(1, 2), { shape: { table: 1, rows: 3, columns: 2, description: 'mouse click to delete the newly inserted blank column on the right' } })

  const afterRoundTrip = await readRichTableState()
  assert.deepEqual(afterRoundTrip[0].rows, beforeTables[0].rows, 'row and column actions on the lower table must not change the first table')
  assert.deepEqual(afterRoundTrip[1].rows, beforeTables[1].rows, 'adding and deleting blank rows and columns should retain the selected table content')
  await clickTableAction('删除表格', lowerFirstCell)
  await waitUntil('mouse click to delete only the selected lower Markdown table', async () => (await readRichTableState()).length === 1)

  const afterDeleteText = await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText || ''`)
  for (const text of ['Adjacent text before the first table', 'Between-table text remains intact.', 'Tail insertion point remains intact.', 'UPPER-ROW-1', 'UPPER-ROW-2']) {
    assert.ok(afterDeleteText.includes(text), `deleting the lower table must preserve neighboring content “${text}”`)
  }
  assert.equal(afterDeleteText.includes('LOWER-ROW-1'), false, 'the selected lower table should be the one removed')
  assert.deepEqual((await readRichTableState())[0].rows, beforeTables[0].rows, 'whole-table deletion must leave the first Markdown table unchanged')

  await waitUntil('autosave to write the desktop table deletion', () => workspacePutCount() > initialPuts)
  const saved = await waitUntil('autosaved Markdown to contain only the untouched upper table', async () => {
    const content = await readFile(path.join(workspace, fileName), 'utf8').catch(() => '')
    const tables = marked.lexer(content).filter(token => token.type === 'table')
    return tables.length === 1 && tables[0].header[0].text === 'UPPER-KEY' && !content.includes('LOWER-ROW-1') ? content : null
  })
  for (const text of ['Adjacent text before the first table', 'Between-table text remains intact.', 'Tail insertion point remains intact.']) {
    assert.ok(saved.includes(text), `autosaved Markdown must preserve neighboring text “${text}”`)
  }

  await setupPage()
  await openFile(fileName, 'Long table controls fixture')
  const reopenedTables = await readRichTableState()
  assert.equal(reopenedTables.length, 1, 'reopening after autosave should retain only the unmodified first table')
  assert.deepEqual(reopenedTables[0].rows, beforeTables[0].rows)
  const reopenedText = await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText || ''`)
  assert.ok(reopenedText.includes('Between-table text remains intact.'))
  assert.ok(reopenedText.includes('Tail insertion point remains intact.'))
})

test('mobile touch edits an existing table and an inserted table, then autosaves the exact result', async () => {
  const fileName = 'mobile-table-controls.md'
  const source = makeLongTableControlsSource()
  await writeFile(path.join(workspace, fileName), source)
  await setupPage()
  await openFile(fileName, 'Long table controls fixture')
  await setTestViewport(390, 844, true)
  await waitUntil('mobile toolbar to become visible', () => connection.evaluate(`Boolean(document.querySelector('.mobile-toolbar') && getComputedStyle(document.querySelector('.mobile-toolbar')).display !== 'none')`))
  await waitUntil('both source tables to remain in the mobile rich editor', () => connection.evaluate(`document.querySelectorAll('.ProseMirror table').length === 2`))

  const lowerFirstCell = `Array.from(document.querySelectorAll('.ProseMirror table'))[1]?.rows[1]?.cells[0]`
  const lowerBlankCell = `Array.from(document.querySelectorAll('.ProseMirror table'))[1]?.rows[1]?.cells[0]`
  const initialTables = await readRichTableState()
  assert.deepEqual(initialTables[0].rows, [
    ['UPPER-KEY', 'UPPER-VALUE'],
    ['UPPER-ROW-1', 'UPPER-CELL-1'],
    ['UPPER-ROW-2', 'UPPER-CELL-2'],
  ])
  assert.deepEqual(initialTables[1].rows, [
    ['LOWER-KEY', 'LOWER-VALUE'],
    ['LOWER-ROW-1', 'LOWER-CELL-1'],
    ['LOWER-ROW-2', 'LOWER-CELL-2'],
  ])

  const initialPuts = workspacePutCount()
  const lowerCellTap = await dispatchRealInput(lowerFirstCell, { touch: true })
  assert.ok(lowerCellTap.y > 100, `the mobile lower table should be reached by scrolling: ${JSON.stringify(lowerCellTap)}`)
  await saveRepairScreenshot('table-mobile-selected-before-more.png')
  const mobileMore = await waitForStableObjectMenuButton('更多表格操作', `(${lowerFirstCell})?.closest('table')`)
  assert.equal(mobileMore.hitLabel, '更多表格操作')
  assert.equal(await connection.evaluate(`!document.querySelector('.table-context-tools')`), true, 'the mobile table toolbar should be absent')
  await saveRepairScreenshot('table-more-button-mobile.png')
  const mobileMenu = await openObjectContextMenu(lowerFirstCell, { touch: true })
  assert.ok(mobileMenu.geometry.visible, 'the 44px mobile table entry should open its context menu')
  assertContextMenuFitsViewport(mobileMenu.geometry, 'mobile table context')
  await saveRepairScreenshot('table-context-menu-mobile.png')
  await pressKey('Escape', 27)
  await waitForContextMenuClosed('表格操作')
  await waitUntil('Escape focus restoration to the editor before resetting mobile scroll', () => connection.evaluate(
    `document.activeElement === document.querySelector('.ProseMirror')`,
  ))
  await connection.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await connection.evaluate(`(() => { const scroll = document.querySelector('.editor-scroll'); if (scroll) scroll.scrollTop = 0 })()`)
  const offscreenTableMore = await waitUntil('table more button to hide when its selected table leaves the editor viewport', () => connection.evaluate(`(() => {
    const scroll = document.querySelector('.editor-scroll'), button = Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === '更多表格操作');
    const frame = scroll?.getBoundingClientRect(), rect = button?.getBoundingClientRect(), style = button && getComputedStyle(button);
    const visible = Boolean(button?.getClientRects().length && rect && style.visibility === 'visible' && style.display !== 'none'
      && frame && rect.bottom > frame.top && rect.top < frame.bottom && rect.right > frame.left && rect.left < frame.right);
    return scroll?.scrollTop === 0 && !visible ? { scrollTop: scroll.scrollTop, button: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, visible } : null;
  })()`))
  assert.equal(offscreenTableMore.visible, false)

  await clickTableAction('上方增行', lowerFirstCell, { touch: true, shape: { table: 1, rows: 4, columns: 2, description: 'touch to add a row above the lower existing table cell' } })
  await clickTableAction('删除行', lowerBlankCell, { touch: true, shape: { table: 1, rows: 3, columns: 2, description: 'touch to remove the newly inserted blank row' } })
  await clickTableAction('左侧增列', lowerFirstCell, { touch: true, shape: { table: 1, rows: 3, columns: 3, description: 'touch to add a column before the lower existing table cell' } })
  await clickTableAction('删除列', lowerBlankCell, { touch: true, shape: { table: 1, rows: 3, columns: 2, description: 'touch to remove the newly inserted blank column' } })
  assert.deepEqual((await readRichTableState())[0].rows, initialTables[0].rows, 'mobile edits to the lower table must not change the upper existing table')
  assert.deepEqual((await readRichTableState())[1].rows, initialTables[1].rows, 'mobile add/delete actions should preserve lower-table cells')

  const tailParagraph = `Array.from(document.querySelectorAll('.ProseMirror p')).find(paragraph => paragraph.innerText.includes('Tail insertion point remains intact.'))`
  await dispatchRealInput(tailParagraph, { touch: true })
  // Move past the last paragraph through actual keyboard input, so insertion
  // cannot split the neighboring text merely because the tap landed mid-line.
  for (let step = 0; step < 'Tail insertion point remains intact.'.length; step += 1) {
    await pressKey('ArrowRight', 39)
  }
  const mobileInsertButton = `document.querySelector('.mobile-toolbar button[aria-label="插入表格"]')`
  await dispatchRealInput(mobileInsertButton, { touch: true })
  const settledPicker = await waitForStablePickerTarget('3 行 3 列')
  assertPickerFitsViewport(settledPicker, '390px mobile')
  await saveRepairScreenshot('table-picker-mobile-open.png')
  const sizeGridTap = await dispatchRealInput(`document.querySelector('.table-size-grid button[aria-label="3 行 3 列"]')`, { touch: true, scrollIntoView: false })
  assert.equal(sizeGridTap.hitLabel, '3 行 3 列', `the picker must receive the real touch on its 3x3 cell: ${JSON.stringify(sizeGridTap)}`)
  await waitForTableShape(2, 3, 3, 'real 3x3 touch to insert the new table after the two Markdown tables')

  await setTestViewport(320, 844, true)
  await dispatchRealInput(mobileInsertButton, { touch: true })
  const narrowPicker = await waitForStablePickerTarget('3 行 3 列')
  assertPickerFitsViewport(narrowPicker, '320px mobile')
  const gridStart = await connection.evaluate(`(() => {
    const grid = document.querySelector('.table-size-grid'), rect = grid?.getBoundingClientRect();
    return grid && rect ? { x: rect.right - 12, y: rect.top + rect.height / 2, width: rect.width,
      clientWidth: grid.clientWidth, scrollWidth: grid.scrollWidth, overflowX: getComputedStyle(grid).overflowX } : null;
  })()`)
  assert.ok(gridStart && gridStart.scrollWidth > gridStart.clientWidth && ['auto', 'scroll'].includes(gridStart.overflowX),
    `320px picker grid should expose horizontal scrolling: ${JSON.stringify(gridStart)}`)
  await connection.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: gridStart.x, y: gridStart.y, radiusX: 1, radiusY: 1, force: 1 }] })
  await new Promise(resolve => setTimeout(resolve, 45))
  await connection.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: gridStart.x - 110, y: gridStart.y, radiusX: 1, radiusY: 1, force: 1 }] })
  await new Promise(resolve => setTimeout(resolve, 45))
  await connection.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const scrolledGrid = await waitUntil('real touch swipe to scroll the narrow table-size grid', () => connection.evaluate(`(() => {
    const grid = document.querySelector('.table-size-grid');
    if (!grid || grid.scrollLeft <= 0) return null;
    const button = Array.from(grid.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === '1 行 8 列');
    const rect = button?.getBoundingClientRect(), gridRect = grid.getBoundingClientRect();
    const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const hitLabel = hit?.getAttribute?.('aria-label') || hit?.closest?.('[aria-label]')?.getAttribute('aria-label') || null;
    return button && rect && { scrollLeft: grid.scrollLeft, grid: { left: gridRect.left, right: gridRect.right },
      target: { left: rect.left, right: rect.right }, hitLabel, overflowX: getComputedStyle(grid).overflowX };
  })()`))
  assert.ok(scrolledGrid.scrollLeft > 0, `the real 320px swipe must move the picker grid: ${JSON.stringify(scrolledGrid)}`)
  assert.equal(scrolledGrid.hitLabel, '1 行 8 列', `the final dimension cell must be touch-reachable after scrolling: ${JSON.stringify(scrolledGrid)}`)
  assert.ok(scrolledGrid.target.left >= scrolledGrid.grid.left && scrolledGrid.target.right <= scrolledGrid.grid.right,
    `the last dimension cell must be inside the scrollport after the swipe: ${JSON.stringify(scrolledGrid)}`)
  assert.equal((await readRichTableState()).length, 3, 'swiping the picker must not select a dimension or insert another table')
  await pressKey('Escape', 27)
  await waitUntil('Escape to close the 320px table picker', () => connection.evaluate(`(() => {
    const panel = document.querySelector('.table-insert-panel'), rect = panel?.getBoundingClientRect();
    return !panel || !rect || rect.width === 0 || rect.height === 0 || getComputedStyle(panel).visibility === 'hidden' || getComputedStyle(panel).display === 'none';
  })()`))
  await setTestViewport(390, 844, true)

  const insertedFirstCell = `Array.from(document.querySelectorAll('.ProseMirror table'))[2]?.rows[1]?.cells[0]`
  await dispatchRealInput(insertedFirstCell, { touch: true })
  await connection.send('Input.insertText', { text: 'MOBILE-INSERTED-TABLE-CELL' })
  await waitUntil('keyboard text to appear in the newly inserted table cell', async () => (await readRichTableState())[2]?.rows[1]?.[0]?.includes('MOBILE-INSERTED-TABLE-CELL'))
  const mobileInsertedMore = await waitForStableObjectMenuButton('更多表格操作', `(${insertedFirstCell})?.closest('table')`)
  assert.equal(mobileInsertedMore.hitLabel, '更多表格操作')
  assert.equal(await connection.evaluate(`!document.querySelector('.table-context-tools')`), true, 'inserted-table controls should use the object menu')
  await saveRepairScreenshot('table-controls-mobile-inserted-scrolled.png')

  await clickTableAction('上方增行', insertedFirstCell, { touch: true, shape: { table: 2, rows: 4, columns: 3, description: 'touch to add a row above the inserted table cell' } })
  const insertedBlankRow = `Array.from(document.querySelectorAll('.ProseMirror table'))[2]?.rows[1]?.cells[0]`
  await clickTableAction('删除行', insertedBlankRow, { touch: true, shape: { table: 2, rows: 3, columns: 3, description: 'touch to delete the newly inserted blank row' } })
  await clickTableAction('下方增行', insertedFirstCell, { touch: true, shape: { table: 2, rows: 4, columns: 3, description: 'touch to add a retained row below the inserted table cell' } })

  await clickTableAction('左侧增列', insertedFirstCell, { touch: true, shape: { table: 2, rows: 4, columns: 4, description: 'touch to add a column before the inserted table cell' } })
  const insertedBlankColumn = `Array.from(document.querySelectorAll('.ProseMirror table'))[2]?.rows[1]?.cells[0]`
  await clickTableAction('删除列', insertedBlankColumn, { touch: true, shape: { table: 2, rows: 4, columns: 3, description: 'touch to delete the newly inserted blank column' } })
  await clickTableAction('右侧增列', insertedFirstCell, { touch: true, shape: { table: 2, rows: 4, columns: 4, description: 'touch to add a retained column after the inserted table cell' } })

  const editedTables = await readRichTableState()
  assert.deepEqual(editedTables[0].rows, initialTables[0].rows, 'mobile commands on the inserted table must not alter the first Markdown table')
  assert.deepEqual(editedTables[1].rows, initialTables[1].rows, 'mobile commands on the inserted table must not alter the second Markdown table')
  assert.ok(editedTables[2].rows[1][0].includes('MOBILE-INSERTED-TABLE-CELL'))
  assert.ok((await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText || ''`)).includes('Tail insertion point remains intact.'))

  await waitUntil('autosave PUT after mobile table editing', () => workspacePutCount() > initialPuts)
  const saved = await waitUntil('autosaved Markdown to preserve all three tables and the inserted cell', async () => {
    const content = await readFile(path.join(workspace, fileName), 'utf8').catch(() => '')
    const tables = marked.lexer(content).filter(token => token.type === 'table')
    return tables.length === 3 && tables[2].header.length === 4 && tables[2].rows.length === 3
      && content.includes('MOBILE-INSERTED-TABLE-CELL') ? content : null
  })
  const savedTables = marked.lexer(saved).filter(token => token.type === 'table')
  assert.deepEqual(savedTables[0].header.map(cell => cell.text), ['UPPER-KEY', 'UPPER-VALUE'])
  assert.deepEqual(savedTables[0].rows[0].map(cell => cell.text), ['UPPER-ROW-1', 'UPPER-CELL-1'])
  assert.deepEqual(savedTables[1].header.map(cell => cell.text), ['LOWER-KEY', 'LOWER-VALUE'])
  assert.deepEqual(savedTables[1].rows[0].map(cell => cell.text), ['LOWER-ROW-1', 'LOWER-CELL-1'])
  assert.equal(savedTables[2].header.length, 4, 'the mobile-added column should persist in the new table')
  assert.equal(savedTables[2].rows.length, 3, 'the mobile-added row should persist in the new table')
  assert.ok(savedTables[2].rows[0][0].text.includes('MOBILE-INSERTED-TABLE-CELL'))

  await setupPage()
  await openFile(fileName, 'Long table controls fixture')
  await setTestViewport(390, 844, true)
  await waitUntil('mobile toolbar to return after reopening', () => connection.evaluate(`Boolean(document.querySelector('.mobile-toolbar') && getComputedStyle(document.querySelector('.mobile-toolbar')).display !== 'none')`))
  const reopenedTables = await readRichTableState()
  assert.equal(reopenedTables.length, 3, 'reopening after autosave should retain both Markdown tables and the inserted table')
  assert.deepEqual(reopenedTables[0].rows, initialTables[0].rows)
  assert.deepEqual(reopenedTables[1].rows, initialTables[1].rows)
  assert.equal(reopenedTables[2].rows.length, 4)
  assert.ok(reopenedTables[2].rows.every(row => row.length === 4))
  assert.ok(reopenedTables[2].rows[1][0].includes('MOBILE-INSERTED-TABLE-CELL'))
  const reopenedText = await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText || ''`)
  assert.ok(reopenedText.includes('Adjacent text before the first table remains intact.'))
  assert.ok(reopenedText.includes('Between-table text remains intact.'))
  assert.ok(reopenedText.includes('Tail insertion point remains intact.'))
})

test('table and image context menus close when changing documents without writing either file', async () => {
  const sourceFile = 'context-menu-source.md'
  const targetFile = 'context-menu-target.md'
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
  const source = '# Context source fixture\n\nSource stays unchanged.\n\n| SOURCE-KEY | SOURCE-VALUE |\n| --- | --- |\n| SOURCE-ROW | SOURCE-CELL |\n\n![source](assets/context-menu.png)<!-- se-image:width=50;align=left -->\n'
  const target = '# Context target fixture\n\nTarget stays unchanged.\n\n| TARGET-KEY | TARGET-VALUE |\n| --- | --- |\n| TARGET-ROW | TARGET-CELL |\n\n![target](assets/context-menu.png)<!-- se-image:width=50;align=left -->\n'
  await mkdir(path.join(workspace, 'assets'), { recursive: true })
  await writeFile(path.join(workspace, 'assets', 'context-menu.png'), imageBytes)
  await writeFile(path.join(workspace, sourceFile), source)
  await writeFile(path.join(workspace, targetFile), target)
  await setupPage()
  await openFile(sourceFile, 'Context source fixture')
  await waitUntil('source document table and image', () => connection.evaluate(
    `document.querySelectorAll('.ProseMirror table').length === 1 && document.querySelectorAll('.ProseMirror img').length === 1`,
  ))
  const initialPuts = workspacePutCount()

  const initialTableMenu = await openObjectContextMenu(`document.querySelector('.ProseMirror table tbody td')`)
  assert.ok(initialTableMenu.geometry.visible, 'the first interaction after load should right-click the table and open its menu')
  assert.equal(await waitForFocusedContextMenuItem('表格操作'), '上方增行')
  await clickFileFromTree(targetFile, 'Context target fixture')
  await waitForContextMenuClosed('表格操作')
  await assertNoPersistentObjectToolbars()
  assert.equal(await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes('Target stays unchanged.')`), true)
  assert.equal(workspacePutCount(), initialPuts, 'opening and dismissing a table menu must not write either document')

  const targetImage = `document.querySelector('.ProseMirror img')`
  await waitUntil('target image to have enough rendered area for a real mouse click', () => connection.evaluate(
    `document.querySelector('.ProseMirror img')?.getBoundingClientRect().width >= 100`,
  ))
  const initialImageMenu = await openObjectContextMenu(targetImage, { object: 'image' })
  assert.ok(initialImageMenu.geometry.visible, 'the first interaction after file switch should right-click the image and open its menu')
  assert.equal(await waitForFocusedContextMenuItem('图片操作'), '左对齐')
  await clickFileFromTree(sourceFile, 'Context source fixture')
  await waitForContextMenuClosed('图片操作')
  await assertNoPersistentObjectToolbars()
  assert.equal(await connection.evaluate(`document.querySelector('.ProseMirror')?.innerText.includes('Source stays unchanged.')`), true)
  assert.equal(workspacePutCount(), initialPuts, 'switching away from an open image menu must not write either document')
  assert.equal(await readFile(path.join(workspace, sourceFile), 'utf8'), source)
  assert.equal(await readFile(path.join(workspace, targetFile), 'utf8'), target)
  assert.deepEqual(await readFile(path.join(workspace, 'assets', 'context-menu.png')), imageBytes)
})

test('table picker has one roving tab stop and Escape restores focus to its trigger', async () => {
  const fileName = 'table-picker-keyboard.md'
  await writeFile(path.join(workspace, fileName), '# Table picker keyboard fixture\n')
  await setupPage()
  await openFile(fileName, 'Table picker keyboard fixture')

  await connection.evaluate(`document.querySelector('.editor-toolbar [aria-label="插入表格"]')?.click()`)
  await waitUntil('keyboard table picker and initial focused cell', () => connection.evaluate(
    `Boolean(document.querySelector('.table-insert-panel[role="dialog"]') && document.activeElement?.getAttribute('aria-label') === '1 行 1 列')`,
  ))
  const initialStops = await connection.evaluate(`Array.from(document.querySelectorAll('.table-size-grid button')).filter(button => button.tabIndex === 0).length`)
  assert.equal(initialStops, 1, '64 dimension buttons should expose one tab stop')

  await pressKey('ArrowRight', 39)
  await waitUntil('ArrowRight to move the active table dimension cell', () => connection.evaluate(
    `document.activeElement?.getAttribute('aria-label') === '1 行 2 列' && document.querySelectorAll('.table-size-grid button[tabindex="0"]').length === 1`,
  ))
  await pressKey('Escape', 27)
  await waitUntil('Escape to close the table picker and restore the trigger', () => connection.evaluate(
    `(() => { const panel = document.querySelector('.table-insert-panel'); const rect = panel?.getBoundingClientRect(); const style = panel ? getComputedStyle(panel) : null; const hidden = !panel || !rect || rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none'; return hidden && document.activeElement === document.querySelector('.editor-toolbar [aria-label="插入表格"]') })()`,
  ))
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
  const image = `document.querySelector('.ProseMirror img')`
  await openObjectContextMenu(image, { object: 'image' })
  await assertNoPersistentObjectToolbars()
  await screenshot('image-context-menu-light.png')
  await pressKey('Escape', 27)
  await waitForContextMenuClosed('图片操作')
  await setTestViewport(390, 844, true)
  await dispatchRealInput(image, { touch: true })
  await screenshot('image-mobile-selected-before-more.png')
  const mobileMore = await waitForStableObjectMenuButton('更多图片操作', image)
  assert.equal(mobileMore.hitLabel, '更多图片操作')
  await screenshot('image-more-button-mobile.png')
  await openObjectContextMenu(image, { object: 'image', touch: true })
  await screenshot('image-context-menu-mobile.png')
  await pressKey('Escape', 27)
  await waitForContextMenuClosed('图片操作')
  const positions = await waitUntil('mobile resize handle aligned with image corner', () => connection.evaluate(`(() => {
    const image = document.querySelector('.ProseMirror img')?.getBoundingClientRect();
    const handle = document.querySelector('.image-resize-handle')?.getBoundingClientRect();
    if (!image || !handle) return null;
    return Math.abs(image.right - handle.right) < 24 && Math.abs(image.bottom - handle.bottom) < 24;
  })()`))
  assert.equal(positions, true)
  await screenshot('image-controls-mobile.png')
})
