import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'

export const CHROME_STARTUP_TIMEOUT_MS = 30_000

const MAX_STARTUP_ATTEMPTS = 2
const STDERR_TAIL_LIMIT = 8_000
const DEVTOOLS_PROBE_TIMEOUT_MS = 750
const POLL_INTERVAL_MS = 100

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatStderr(stderr) {
  return stderr.trim()
    ? `\nChrome stderr (last ${STDERR_TAIL_LIMIT} characters):\n${stderr}`
    : '\nChrome stderr: <empty>'
}

function makeStartupError(message, stderr) {
  return new Error(`${message}${formatStderr(stderr)}`)
}

function waitForChildClose(closePromise, timeoutMs = 250) {
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      resolve()
    }
    const timeoutId = setTimeout(finish, timeoutMs)
    closePromise.then(finish)
  })
}

async function stopChild(child, closePromise, exitStatus, launchError) {
  if (!exitStatus && !launchError) {
    try { child.kill('SIGTERM') } catch {}
  }
  await waitForChildClose(closePromise, 750)
  if (!exitStatus && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch {}
    await waitForChildClose(closePromise, 750)
  }
}

async function probeDevTools(port) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEVTOOLS_PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal })
    if (!response.ok) {
      await response.body?.cancel()
      return { ready: false, reason: `HTTP ${response.status}` }
    }
    const version = await response.json()
    if (typeof version.webSocketDebuggerUrl !== 'string' || !version.webSocketDebuggerUrl) {
      return { ready: false, reason: 'response did not include webSocketDebuggerUrl' }
    }
    return { ready: true }
  } catch (error) {
    return { ready: false, reason: error?.message || String(error) }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function startChromeAttempt(chromePath, profileDir, timeoutMs) {
  let child
  try {
    child = spawn(chromePath, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    throw new Error(`Could not spawn Chrome at ${chromePath}: ${error.message}`)
  }

  let stderr = ''
  let launchError = null
  let exitStatus = null
  let closeStatus = null
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_LIMIT)
  })
  child.on('error', error => { launchError = error })
  child.on('exit', (code, signal) => { exitStatus = { code, signal } })
  const closePromise = new Promise(resolve => {
    child.once('close', (code, signal) => {
      closeStatus = { code, signal }
      resolve(closeStatus)
    })
  })

  const activePortFile = path.join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  let lastReadinessError = 'DevToolsActivePort has not been written'

  try {
    while (Date.now() < deadline) {
      if (launchError || exitStatus || closeStatus) {
        await waitForChildClose(closePromise)
        const status = exitStatus || closeStatus
        const message = launchError
          ? `Chrome failed to start at ${chromePath}: ${launchError.message}`
          : `Chrome exited before DevTools became ready (exit code ${status?.code ?? 'unknown'}, signal ${status?.signal ?? 'none'}).`
        throw makeStartupError(message, stderr)
      }

      const contents = await readFile(activePortFile, 'utf8').catch(() => '')
      const port = Number(contents.split('\n')[0])
      if (port > 0 && port <= 65_535) {
        const readiness = await probeDevTools(port)
        if (readiness.ready) return { child, port }
        lastReadinessError = readiness.reason
      }

      await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
    }

    if (launchError || exitStatus || closeStatus) {
      await waitForChildClose(closePromise)
      const status = exitStatus || closeStatus
      const message = launchError
        ? `Chrome failed to start at ${chromePath}: ${launchError.message}`
        : `Chrome exited before DevTools became ready (exit code ${status?.code ?? 'unknown'}, signal ${status?.signal ?? 'none'}).`
      throw makeStartupError(message, stderr)
    }

    throw makeStartupError(
      `Timed out after ${timeoutMs} ms waiting for Chrome DevTools /json/version (${lastReadinessError}).`,
      stderr,
    )
  } catch (error) {
    await stopChild(child, closePromise, exitStatus, launchError)
    if (error.message.includes('Chrome stderr:') || error.message.includes('Chrome stderr (last')) throw error
    throw makeStartupError(error.message, stderr)
  }
}

export async function startChrome({
  chromePath = process.env.CHROME_PATH,
  profileDir,
  timeoutMs = CHROME_STARTUP_TIMEOUT_MS,
} = {}) {
  if (!chromePath) throw new Error('Chrome executable is required. Set CHROME_PATH.')
  if (!profileDir) throw new Error('A unique Chrome profileDir is required.')

  const attempts = []
  // Retry only Chrome launch and DevTools readiness. Callers create targets and run assertions afterward.
  for (let attempt = 1; attempt <= MAX_STARTUP_ATTEMPTS; attempt += 1) {
    let attemptProfileDir = profileDir
    if (attempt > 1) {
      try {
        attemptProfileDir = await mkdtemp(path.join(
          path.dirname(profileDir),
          `${path.basename(profileDir)}-retry-`,
        ))
      } catch (error) {
        attempts.push({
          attempt,
          profileDir: '<fresh sibling profile could not be created>',
          error: `Could not create a fresh Chrome profile: ${error.message}`,
        })
        break
      }
    }

    try {
      const result = await startChromeAttempt(chromePath, attemptProfileDir, timeoutMs)
      attempts.push({ attempt, profileDir: attemptProfileDir, ready: true, port: result.port })
      if (attempt > 1) {
        const diagnostics = attempts.map(formatAttemptDiagnostic).join('\n\n')
        process.stderr.write(`[chrome-startup] Recovered on attempt ${attempt}.\n${diagnostics}\n`)
      }
      return { ...result, profileDir: attemptProfileDir, attempts }
    } catch (error) {
      attempts.push({ attempt, profileDir: attemptProfileDir, error: error.message })
    }
  }

  const diagnostics = attempts.map(formatAttemptDiagnostic).join('\n\n')
  const attemptLabel = attempts.length === 1 ? 'attempt' : 'attempts'
  throw new Error(`Chrome failed to start after ${attempts.length} ${attemptLabel}.\n${diagnostics}`)
}

function formatAttemptDiagnostic({ attempt, profileDir: attemptProfile, error, port }) {
  return error
    ? `Attempt ${attempt} failed with profile ${attemptProfile}:\n${error}`
    : `Attempt ${attempt} reached DevTools on port ${port} with profile ${attemptProfile}.`
}
