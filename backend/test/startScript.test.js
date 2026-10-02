import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sourceScript = path.join(repositoryRoot, 'start.sh')

async function waitFor(description, check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

test('development start script stops the other child when either service exits', {
  skip: process.platform === 'win32' ? 'start.sh supervises POSIX processes; Windows uses PowerShell' : false,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-start-supervisor-'))
  const project = path.join(root, 'project')
  const state = path.join(root, 'state')
  const fakeBin = path.join(root, 'bin')
  const frontendCommand = path.join(project, 'frontend', 'node_modules', '.bin', 'vite')
  const backendCommand = path.join(fakeBin, 'node')
  const curlCommand = path.join(fakeBin, 'curl')
  const script = path.join(project, 'start.sh')
  await mkdir(path.dirname(frontendCommand), { recursive: true })
  await mkdir(path.join(project, 'backend'), { recursive: true })
  await mkdir(fakeBin, { recursive: true })
  await mkdir(state, { recursive: true })
  await writeFile(script, await readFile(sourceScript))
  await chmod(script, 0o755)
  const serviceShim = label => `#!/bin/bash
if [[ "\${1:-}" == "--version" ]]; then echo "\${START_TEST_NODE_VERSION:-v22.22.3}"; exit 0; fi
echo "$$" > "$START_TEST_STATE/${label}.pid"
trap 'echo stopped > "$START_TEST_STATE/${label}.stopped"; exit 0' TERM INT
while :; do sleep 1; done
`
  await writeFile(backendCommand, serviceShim('backend'))
  await writeFile(frontendCommand, serviceShim('frontend'))
  await writeFile(curlCommand, '#!/bin/sh\nexit 0\n')
  await Promise.all([backendCommand, frontendCommand, curlCommand].map(file => chmod(file, 0o755)))

  let output = ''
  const child = spawn('/bin/bash', [script], {
    cwd: project,
    env: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      START_TEST_STATE: state,
      START_TEST_NODE_VERSION: 'v22.17.0',
      EDITOR_PORT: '45557',
      FRONTEND_PORT: '45558',
      EDITOR_HOST: '127.0.0.1',
      EDITOR_MODE: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const stopped = await Promise.race([
        new Promise(resolve => child.once('exit', () => resolve(true))),
        new Promise(resolve => setTimeout(() => resolve(false), 1_000)),
      ])
      if (!stopped) {
        child.kill('SIGKILL')
        await new Promise(resolve => child.once('exit', resolve))
      }
    }
    await rm(root, { recursive: true, force: true })
  })

  const frontendPid = Number(await waitFor('frontend process to start', async () => {
    try { return await readFile(path.join(state, 'frontend.pid'), 'utf8') } catch { return null }
  }))
  const backendPid = Number(await waitFor('backend process to start', async () => {
    try { return await readFile(path.join(state, 'backend.pid'), 'utf8') } catch { return null }
  }))
  process.kill(frontendPid, 'SIGTERM')
  await waitFor('start script to exit after frontend exits', () => child.exitCode !== null || child.signalCode !== null)

  assert.match(output, /前端进程已退出/)
  await waitFor('backend child to receive cleanup signal', async () => {
    try { return await readFile(path.join(state, 'backend.stopped'), 'utf8') } catch { return null }
  })
  assert.notEqual(backendPid, frontendPid)
})

test('production start mode rejects a missing frontend build clearly', {
  skip: process.platform === 'win32' ? 'start.sh is the macOS/Linux launcher' : false,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-start-production-'))
  const project = path.join(root, 'project')
  const script = path.join(project, 'start.sh')
  await mkdir(path.join(project, 'frontend'), { recursive: true })
  await writeFile(script, await readFile(sourceScript))
  await chmod(script, 0o755)
  t.after(() => rm(root, { recursive: true, force: true }))

  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [script], {
      cwd: project,
      env: { ...process.env, EDITOR_MODE: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('exit', code => resolve({ code, output }))
  })
  assert.equal(result.code, 1)
  assert.match(result.output, /未找到 frontend\/dist\/index\.html/)
})

test('start script rejects unsupported Node versions before launching services', {
  skip: process.platform === 'win32' ? 'start.sh is the macOS/Linux launcher' : false,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'standalone-editor-start-node-version-'))
  const project = path.join(root, 'project')
  const fakeBin = path.join(root, 'bin')
  const script = path.join(project, 'start.sh')
  const nodeCommand = path.join(fakeBin, 'node')
  await mkdir(project, { recursive: true })
  await mkdir(fakeBin, { recursive: true })
  await writeFile(script, await readFile(sourceScript))
  await chmod(script, 0o755)
  await writeFile(nodeCommand, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "%s\\n" "$START_TEST_NODE_VERSION"; exit 0; fi\necho "services must not start" >&2\nexit 99\n')
  await chmod(nodeCommand, 0o755)
  t.after(() => rm(root, { recursive: true, force: true }))

  for (const version of ['v22.12.0', 'v23.0.0']) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', [script], {
        cwd: project,
        env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, START_TEST_NODE_VERSION: version },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
      child.once('error', reject)
      child.once('exit', code => resolve({ code, output }))
    })
    assert.equal(result.code, 1)
    assert.match(result.output, /Node\.js 22\.17\.0 或更新的 22\.x 版本/)
    assert.match(result.output, new RegExp(version.replaceAll('.', '\\.')))
  }
})
