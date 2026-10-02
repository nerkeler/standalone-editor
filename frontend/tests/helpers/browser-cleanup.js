import { rm } from 'node:fs/promises'

const TRANSIENT_REMOVE_CODES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM'])

function hasExited(child) {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true)

  return new Promise(resolve => {
    let timer
    const finish = stopped => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(stopped)
    }
    const onExit = () => finish(true)

    child.once('exit', onExit)
    if (hasExited(child)) {
      finish(true)
      return
    }
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}

export async function stopChildProcess(child, {
  gracefulWaitMs = 0,
  terminateWaitMs = 2_000,
  killWaitMs = 2_000,
} = {}) {
  if (!child || hasExited(child)) return

  if (gracefulWaitMs > 0 && await waitForExit(child, gracefulWaitMs)) return
  if (hasExited(child)) return

  const termWait = waitForExit(child, terminateWaitMs)
  child.kill('SIGTERM')
  if (await termWait) return
  if (hasExited(child)) return

  const killWait = waitForExit(child, killWaitMs)
  child.kill('SIGKILL')
  if (await killWait) return
  if (!hasExited(child)) {
    throw new Error(`Child process ${child.pid ?? '<unknown>'} did not exit after SIGKILL`)
  }
}

async function requestBrowserClose(port, timeoutMs = 2_000) {
  const controller = new AbortController()
  const fetchTimer = setTimeout(() => controller.abort(), timeoutMs)
  let endpoint
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal })
    if (!response.ok) throw new Error(`Chrome DevTools endpoint returned HTTP ${response.status}`)
    endpoint = (await response.json()).webSocketDebuggerUrl
  } finally {
    clearTimeout(fetchTimer)
  }
  if (!endpoint) throw new Error('Chrome DevTools version response did not include a browser websocket URL')

  const socket = new WebSocket(endpoint)
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome browser DevTools')), timeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome browser DevTools websocket failed')) }, { once: true })
    })

    await new Promise((resolve, reject) => {
      let commandSent = false
      const timer = setTimeout(() => reject(new Error('Timed out closing Chrome through Browser.close')), timeoutMs)
      socket.addEventListener('message', event => {
        let message
        try {
          message = JSON.parse(event.data.toString())
        } catch (error) {
          clearTimeout(timer)
          reject(error)
          return
        }
        if (message.id !== 1) return
        clearTimeout(timer)
        if (message.error) reject(new Error(`Chrome Browser.close failed: ${message.error.message}`))
        else resolve()
      })
      socket.addEventListener('close', () => {
        if (!commandSent) return
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('Chrome browser DevTools websocket failed during Browser.close'))
      })
      try {
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
        commandSent = true
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    })
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
  }
}

export async function closeChrome({ child, port }) {
  if (!child || hasExited(child)) return

  let browserCloseRequested = false
  let browserCloseError
  try {
    await requestBrowserClose(port)
    browserCloseRequested = true
  } catch (error) {
    browserCloseError = error
    // Chrome may already be shutting down or its DevTools endpoint may have closed.
    // Process exit is still required below; otherwise use bounded TERM/KILL escalation.
  }

  try {
    await stopChildProcess(child, { gracefulWaitMs: browserCloseRequested ? 1_500 : 0 })
  } catch (processStopError) {
    if (browserCloseError) {
      throw new AggregateError([browserCloseError, processStopError], 'Chrome DevTools close and process shutdown both failed')
    }
    throw processStopError
  }
}

export async function removeTempDirWithRetry(directory, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (!TRANSIENT_REMOVE_CODES.has(error.code) || attempt >= retries) throw error
      await new Promise(resolve => setTimeout(resolve, 40 * (2 ** attempt)))
    }
  }
}

export async function cleanupBrowserTest({ browser, connections = [], children = [], actions = [], tempRoot }) {
  const errors = []
  const run = async action => {
    try {
      await action()
    } catch (error) {
      errors.push(error)
    }
  }

  if (browser?.child) await run(() => closeChrome(browser))
  for (const connection of connections) {
    if (connection) await run(() => connection.close())
  }
  for (const child of children) {
    if (child) await run(() => stopChildProcess(child))
  }
  for (const action of actions) await run(action)
  if (tempRoot) await run(() => removeTempDirWithRetry(tempRoot))

  if (errors.length) throw new AggregateError(errors, 'Browser test cleanup failed')
}
