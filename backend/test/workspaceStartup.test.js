import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function startBackend(t, {
  configFile,
  recoveryRoot,
  defaultWorkspace,
  cliWorkspace,
} = {}) {
  const source = `import { server } from './src/index.js'; server.once('listening', () => process.send({ port: server.address().port }));`
  const args = ['--input-type=module', '-e', source]
  if (cliWorkspace) args.push('standalone-editor-test', '--workspace', cliWorkspace)
  const env = {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    WORKSPACE_CONFIG_FILE: configFile,
    EDITOR_RECOVERY_DIR: recoveryRoot,
    ALLOW_ANY_WORKSPACE: '1',
  }
  delete env.EDITOR_RECOVERY_ROOT
  delete env.STANDALONE_EDITOR_RECOVERY_ROOT
  if (defaultWorkspace) env.EDITOR_DEFAULT_WORKSPACE = defaultWorkspace
  else delete env.EDITOR_DEFAULT_WORKSPACE

  const child = spawn(process.execPath, args, {
    // -e puts its first trailing argument at process.argv[1], so include a
    // script-like placeholder before the CLI option expected by index.js.
    // This keeps commandWorkspace()'s production argv shape intact.
    cwd: backendRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend did not listen: ${output}`)), 5000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`backend exited (${code}): ${output}`)) })
    child.on('message', message => {
      if (message?.port) { clearTimeout(timer); resolve(message.port) }
    })
  })

  t.after(async () => {
    child.kill('SIGTERM')
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', resolve)
      setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1000)
    })
  })
  return `http://127.0.0.1:${port}`
}

async function postWorkspace(baseUrl, workspacePath) {
  return fetch(`${baseUrl}/api/workspace/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: workspacePath }),
  })
}

test('first launch creates and persists the default workspace only when config is missing', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-startup-default-')
  const configFile = path.join(root, 'config', 'workspace.json')
  const recoveryRoot = path.join(root, 'recovery')
  const defaultWorkspace = path.join(root, 'notes')
  const baseUrl = await startBackend(t, { configFile, recoveryRoot, defaultWorkspace })

  const health = await fetch(`${baseUrl}/api/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).status, 'ok')

  const response = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(response.status, 200)
  const info = await response.json()
  assert.equal(info.workspace, await fs.realpath(defaultWorkspace))
  assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')), { workspace: info.workspace })
  assert.ok((await fs.stat(defaultWorkspace)).isDirectory())
  await assert.rejects(fs.stat(recoveryRoot), error => error.code === 'ENOENT')
})

test('explicit CLI workspace can create a new directory after recovery preflight', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-startup-cli-')
  const configFile = path.join(root, 'workspace.json')
  const recoveryRoot = path.join(root, 'recovery')
  const cliWorkspace = path.join(root, 'cli-notes')
  const baseUrl = await startBackend(t, { configFile, recoveryRoot, cliWorkspace })

  const response = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(response.status, 200)
  const info = await response.json()
  assert.equal(info.workspace, await fs.realpath(cliWorkspace))
  assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')), { workspace: info.workspace })
})

test('an invalid default workspace is rejected before either path is created', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-startup-default-overlap-')
  const configFile = path.join(root, 'workspace.json')
  const recoveryRoot = path.join(root, 'recovery')
  const defaultWorkspace = path.join(recoveryRoot, 'notes')
  const baseUrl = await startBackend(t, { configFile, recoveryRoot, defaultWorkspace })

  const response = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.equal(body.code, 'WORKSPACE_INSIDE_RECOVERY_ROOT')
  assert.equal(body.workspace, path.join(await fs.realpath(root), 'recovery', 'notes'))
  await assert.rejects(fs.stat(recoveryRoot), error => error.code === 'ENOENT')
  await assert.rejects(fs.stat(defaultWorkspace), error => error.code === 'ENOENT')
})

test('missing saved workspace keeps API alive at 503 until explicit selection', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-startup-missing-')
  const configFile = path.join(root, 'config', 'workspace.json')
  const recoveryRoot = path.join(root, 'recovery')
  const missingWorkspace = path.join(root, 'removed-drive', 'notes')
  const defaultWorkspace = path.join(root, 'must-not-be-created')
  await fs.mkdir(path.dirname(configFile), { recursive: true })
  await fs.writeFile(configFile, JSON.stringify({ workspace: missingWorkspace }))
  const selectedWorkspace = path.join(root, 'selected')
  await fs.mkdir(selectedWorkspace)
  const baseUrl = await startBackend(t, { configFile, recoveryRoot, defaultWorkspace })

  const check = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(check.status, 503)
  const checkBody = await check.json()
  assert.equal(checkBody.code, 'SAVED_WORKSPACE_UNAVAILABLE')
  assert.equal(checkBody.workspace, missingWorkspace)
  assert.equal(checkBody.canRetry, true)
  assert.equal(checkBody.canSelectWorkspace, true)

  const guarded = await fetch(`${baseUrl}/api/workspace/file?path=note.md`)
  assert.equal(guarded.status, 503)
  assert.equal((await guarded.json()).code, 'SAVED_WORKSPACE_UNAVAILABLE')

  const dirs = await fetch(`${baseUrl}/api/dirs?path=${encodeURIComponent(root)}`)
  assert.equal(dirs.status, 200)

  await assert.rejects(fs.stat(defaultWorkspace), error => error.code === 'ENOENT')
  const selected = await postWorkspace(baseUrl, selectedWorkspace)
  assert.equal(selected.status, 200)
  const selectedInfo = await selected.json()
  assert.equal(selectedInfo.workspace, await fs.realpath(selectedWorkspace))
  assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')), { workspace: selectedInfo.workspace })
  assert.equal((await (await fetch(`${baseUrl}/api/workspace/check`)).json()).workspace, selectedInfo.workspace)
})

test('invalid config is reported without default fallback and can be repaired by explicit selection', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-startup-corrupt-')
  const configFile = path.join(root, 'workspace.json')
  const recoveryRoot = path.join(root, 'recovery')
  const defaultWorkspace = path.join(root, 'must-not-be-created')
  const selectedWorkspace = path.join(root, 'selected')
  await fs.writeFile(configFile, '{invalid')
  await fs.mkdir(selectedWorkspace)
  const baseUrl = await startBackend(t, { configFile, recoveryRoot, defaultWorkspace })

  const check = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(check.status, 503)
  const body = await check.json()
  assert.equal(body.code, 'WORKSPACE_CONFIG_INVALID')
  assert.equal(body.configFile, configFile)
  const guarded = await fetch(`${baseUrl}/api/workspace/file?path=note.md`)
  assert.equal(guarded.status, 503)
  assert.equal((await guarded.json()).code, 'WORKSPACE_CONFIG_INVALID')
  await assert.rejects(fs.stat(defaultWorkspace), error => error.code === 'ENOENT')

  const selected = await postWorkspace(baseUrl, selectedWorkspace)
  assert.equal(selected.status, 200)
  assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')), { workspace: await fs.realpath(selectedWorkspace) })
})

test('startup and workspace selection reject recovery overlap before creating recovery storage', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-startup-recovery-overlap-')
  const configFile = path.join(root, 'workspace.json')
  const conflictingWorkspace = path.join(root, 'notes')
  const recoveryRoot = path.join(conflictingWorkspace, '.standalone-editor-recovery')
  const defaultWorkspace = path.join(root, 'default')
  const activeWorkspace = path.join(root, 'active')
  await fs.mkdir(conflictingWorkspace)
  await fs.mkdir(activeWorkspace)
  await fs.writeFile(configFile, JSON.stringify({ workspace: conflictingWorkspace }))
  const baseUrl = await startBackend(t, { configFile, recoveryRoot, defaultWorkspace })

  const unavailable = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(unavailable.status, 503)
  const unavailableBody = await unavailable.json()
  assert.equal(unavailableBody.code, 'RECOVERY_ROOT_INSIDE_WORKSPACE')
  assert.equal(unavailableBody.workspace, await fs.realpath(conflictingWorkspace))
  await assert.rejects(fs.stat(recoveryRoot), error => error.code === 'ENOENT')

  const selected = await postWorkspace(baseUrl, activeWorkspace)
  assert.equal(selected.status, 200)
  const activeInfo = await selected.json()
  const version = activeInfo.workspaceVersion

  // Selecting an ancestor of the recovery root is rejected too, while the
  // current active workspace and its version remain unchanged.
  await fs.writeFile(configFile, JSON.stringify({ workspace: activeInfo.workspace }))
  const rootSelection = await postWorkspace(baseUrl, root)
  assert.equal(rootSelection.status, 400)
  assert.equal((await rootSelection.json()).code, 'RECOVERY_ROOT_INSIDE_WORKSPACE')
  const afterRejectedSelection = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  assert.equal(afterRejectedSelection.workspace, activeInfo.workspace)
  assert.equal(afterRejectedSelection.workspaceVersion, version)

  await fs.mkdir(recoveryRoot, { recursive: true })
  const nestedWorkspace = path.join(recoveryRoot, 'nested-workspace')
  await fs.mkdir(nestedWorkspace)
  const nestedSelection = await postWorkspace(baseUrl, nestedWorkspace)
  assert.equal(nestedSelection.status, 400)
  assert.equal((await nestedSelection.json()).code, 'WORKSPACE_INSIDE_RECOVERY_ROOT')
  const afterNestedRejection = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  assert.equal(afterNestedRejection.workspace, activeInfo.workspace)
  assert.equal(afterNestedRejection.workspaceVersion, version)
})

test('failed config rename does not switch the active workspace or version', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-startup-save-failure-')
  const configFile = path.join(root, 'config', 'workspace.json')
  const recoveryRoot = path.join(root, 'recovery')
  const activeWorkspace = path.join(root, 'active')
  const selectedWorkspace = path.join(root, 'selected')
  await fs.mkdir(path.dirname(configFile), { recursive: true })
  await fs.mkdir(activeWorkspace)
  await fs.mkdir(selectedWorkspace)
  await fs.mkdir(recoveryRoot)
  await fs.writeFile(configFile, JSON.stringify({ workspace: activeWorkspace }))
  const baseUrl = await startBackend(t, { configFile, recoveryRoot })
  const before = await (await fetch(`${baseUrl}/api/workspace/check`)).json()

  // Rename a file over a directory fails on supported local filesystems, after
  // the service has written and synced its temporary sibling.
  const backupConfig = `${configFile}.backup`
  await fs.rename(configFile, backupConfig)
  await fs.mkdir(configFile)
  const failed = await postWorkspace(baseUrl, selectedWorkspace)
  assert.equal(failed.status, 500)
  assert.equal((await failed.json()).code, 'WORKSPACE_CONFIG_SAVE_FAILED')

  const after = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  assert.equal(after.workspace, before.workspace)
  assert.equal(after.workspaceVersion, before.workspaceVersion)
  assert.deepEqual(await fs.readdir(path.dirname(configFile)), ['workspace.json', 'workspace.json.backup'])
})

test('concurrent workspace selections serialize config and in-memory version changes', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-startup-concurrent-set-')
  const configFile = path.join(root, 'workspace.json')
  const recoveryRoot = path.join(root, 'recovery')
  const initialWorkspace = path.join(root, 'initial')
  const firstWorkspace = path.join(root, 'first')
  const secondWorkspace = path.join(root, 'second')
  await fs.mkdir(initialWorkspace)
  await fs.mkdir(firstWorkspace)
  await fs.mkdir(secondWorkspace)
  await fs.writeFile(configFile, JSON.stringify({ workspace: initialWorkspace }))
  const baseUrl = await startBackend(t, { configFile, recoveryRoot })
  const before = await (await fetch(`${baseUrl}/api/workspace/check`)).json()

  const [firstResponse, secondResponse] = await Promise.all([
    postWorkspace(baseUrl, firstWorkspace),
    postWorkspace(baseUrl, secondWorkspace),
  ])
  assert.equal(firstResponse.status, 200)
  assert.equal(secondResponse.status, 200)
  const first = await firstResponse.json()
  const second = await secondResponse.json()
  const latest = first.workspaceVersion > second.workspaceVersion ? first : second
  assert.equal(Math.max(first.workspaceVersion, second.workspaceVersion), before.workspaceVersion + 2)

  const check = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  assert.equal(check.workspace, latest.workspace)
  assert.equal(check.workspaceVersion, latest.workspaceVersion)
  assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')), { workspace: latest.workspace })
})

test('after first-run setup and explicit selection, a missing config never reactivates the default', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-startup-no-fallback-')
  const configFile = path.join(root, 'workspace.json')
  const recoveryRoot = path.join(root, 'recovery')
  const defaultWorkspace = path.join(root, 'default-notes')
  const selectedWorkspace = path.join(root, 'selected-notes')
  await fs.mkdir(selectedWorkspace)
  const baseUrl = await startBackend(t, { configFile, recoveryRoot, defaultWorkspace })

  const defaultCheck = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  assert.equal(defaultCheck.workspace, await fs.realpath(defaultWorkspace))
  const selectedResponse = await postWorkspace(baseUrl, selectedWorkspace)
  assert.equal(selectedResponse.status, 200)
  const selected = await selectedResponse.json()
  assert.equal(selected.workspace, await fs.realpath(selectedWorkspace))

  await fs.unlink(configFile)
  await fs.rename(selectedWorkspace, `${selectedWorkspace}.offline`)
  const unavailable = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(unavailable.status, 503)
  assert.equal((await unavailable.json()).code, 'SAVED_WORKSPACE_UNAVAILABLE')

  const retry = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(retry.status, 503)
  const body = await retry.json()
  assert.equal(body.code, 'WORKSPACE_CONFIG_MISSING')
  assert.equal(body.workspace, selected.workspace)
  assert.equal((await fs.realpath(defaultWorkspace)), defaultCheck.workspace)
})

test('retry never switches from an unavailable CLI workspace to another saved path', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-startup-cli-retry-')
  const configFile = path.join(root, 'workspace.json')
  const recoveryRoot = path.join(root, 'recovery')
  const savedWorkspace = path.join(root, 'saved-notes')
  const cliWorkspace = path.join(root, 'cli-notes')
  await fs.mkdir(savedWorkspace)
  await fs.mkdir(cliWorkspace)
  await fs.writeFile(configFile, JSON.stringify({ workspace: savedWorkspace }))
  const baseUrl = await startBackend(t, { configFile, recoveryRoot, cliWorkspace })
  const cliInfo = await (await fetch(`${baseUrl}/api/workspace/check`)).json()
  assert.equal(cliInfo.workspace, await fs.realpath(cliWorkspace))

  // Simulate the previous config surviving an unsuccessful CLI config rename.
  await fs.writeFile(configFile, JSON.stringify({ workspace: savedWorkspace }))
  await fs.rename(cliWorkspace, `${cliWorkspace}.offline`)
  const unavailable = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(unavailable.status, 503)
  assert.equal((await unavailable.json()).code, 'SAVED_WORKSPACE_UNAVAILABLE')

  const retry = await fetch(`${baseUrl}/api/workspace/check`)
  assert.equal(retry.status, 503)
  const body = await retry.json()
  assert.equal(body.code, 'WORKSPACE_CONFIG_CHANGED')
  assert.equal(body.workspace, cliInfo.workspace)
  assert.equal(body.configuredWorkspace, await fs.realpath(savedWorkspace))
})
