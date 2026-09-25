import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertWorkspaceRecoveryRootsDisjoint,
  defaultRecoveryRoot,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from '../src/workspaceConfigService.js'

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

function rejectingRenameFileSystem() {
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'rename') {
        return async () => {
          const error = new Error('injected rename failure')
          error.code = 'EIO'
          throw error
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function rejectingWorkspaceReadFileSystem(workspace) {
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (property === 'readdir') {
        return async directory => {
          if (path.resolve(directory) === workspace) {
            const error = new Error('injected access denial')
            error.code = 'EACCES'
            throw error
          }
          return target.readdir(directory)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('only a missing config file means first launch', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-workspace-config-')
  const configFile = path.join(root, 'workspace.json')
  assert.deepEqual(await loadWorkspaceConfig(configFile), { kind: 'missing', configFile })

  await assert.rejects(
    loadWorkspaceConfig(root),
    error => error.code === 'WORKSPACE_CONFIG_UNREADABLE',
  )
})

test('invalid config and unavailable saved workspaces are diagnosed without fallback', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-workspace-config-')
  const configFile = path.join(root, 'workspace.json')
  const configuredWorkspace = path.join(root, 'saved-notes')

  await fs.writeFile(configFile, '{broken json')
  await assert.rejects(
    loadWorkspaceConfig(configFile),
    error => error.code === 'WORKSPACE_CONFIG_INVALID',
  )

  await fs.writeFile(configFile, JSON.stringify({ workspace: 42 }))
  await assert.rejects(
    loadWorkspaceConfig(configFile),
    error => error.code === 'WORKSPACE_CONFIG_INVALID',
  )

  await fs.writeFile(configFile, JSON.stringify({ workspace: configuredWorkspace }))
  await assert.rejects(loadWorkspaceConfig(configFile), error => {
    assert.equal(error.code, 'SAVED_WORKSPACE_UNAVAILABLE')
    assert.equal(error.details.workspace, configuredWorkspace)
    assert.equal(error.details.causeCode, 'ENOENT')
    return true
  })
  await assert.rejects(fs.stat(configuredWorkspace), error => error.code === 'ENOENT')
})

test('configured workspace is canonicalized and checked for directory enumeration', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-workspace-config-')
  const workspace = path.join(root, 'notes')
  const configFile = path.join(root, 'workspace.json')
  await fs.mkdir(workspace)
  await fs.writeFile(configFile, JSON.stringify({ workspace: path.join(workspace, '.') }))

  const result = await loadWorkspaceConfig(configFile)
  assert.equal(result.kind, 'configured')
  assert.equal(result.workspace, await fs.realpath(workspace))
  assert.equal(result.configuredPath, workspace)

  await assert.rejects(
    loadWorkspaceConfig(configFile, { fileSystem: rejectingWorkspaceReadFileSystem(await fs.realpath(workspace)) }),
    error => {
      assert.equal(error.code, 'SAVED_WORKSPACE_UNAVAILABLE')
      assert.equal(error.details.causeCode, 'EACCES')
      return true
    },
  )
})

test('config save uses a sibling temp file, syncs it, and atomically replaces JSON', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-workspace-config-')
  const configFile = path.join(root, 'config', 'workspace.json')
  const workspace = path.join(root, 'notes')
  await fs.mkdir(workspace)
  await fs.mkdir(path.dirname(configFile))
  await fs.writeFile(configFile, '{"workspace":"old"}')

  const storedPath = await saveWorkspaceConfig(configFile, workspace, { makeId: () => 'test-id' })
  assert.equal(storedPath, workspace)
  assert.deepEqual(JSON.parse(await fs.readFile(configFile, 'utf8')), { workspace })
  assert.deepEqual(await fs.readdir(path.dirname(configFile)), ['workspace.json'])
  if (process.platform !== 'win32') assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600)
})

test('failed config rename preserves the old file and removes the temporary file', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-workspace-config-')
  const configFile = path.join(root, 'workspace.json')
  const oldContents = '{"workspace":"previous"}'
  await fs.writeFile(configFile, oldContents)

  await assert.rejects(
    saveWorkspaceConfig(configFile, path.join(root, 'next'), {
      fileSystem: rejectingRenameFileSystem(),
      makeId: () => 'failed',
    }),
    error => error.code === 'EIO',
  )
  assert.equal(await fs.readFile(configFile, 'utf8'), oldContents)
  assert.deepEqual(await fs.readdir(root), ['workspace.json'])
})

test('workspace and recovery roots cannot contain one another, without creating paths', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-workspace-recovery-')
  const workspace = path.join(root, 'notes')
  const recovery = path.join(root, 'recovery')
  await fs.mkdir(workspace)

  const resolved = await assertWorkspaceRecoveryRootsDisjoint(workspace, recovery)
  assert.equal(resolved.workspace, await fs.realpath(workspace))
  assert.equal(resolved.recoveryRoot, path.join(await fs.realpath(root), 'recovery'))
  await assert.rejects(fs.stat(recovery), error => error.code === 'ENOENT')

  await assert.rejects(
    assertWorkspaceRecoveryRootsDisjoint(workspace, path.join(workspace, 'recovery', 'nested')),
    error => error.code === 'RECOVERY_ROOT_INSIDE_WORKSPACE',
  )
  await assert.rejects(fs.stat(path.join(workspace, 'recovery')), error => error.code === 'ENOENT')

  const outer = path.join(root, 'shared-root')
  const nestedWorkspace = path.join(outer, 'notes')
  await fs.mkdir(nestedWorkspace, { recursive: true })
  await assert.rejects(
    assertWorkspaceRecoveryRootsDisjoint(nestedWorkspace, outer),
    error => error.code === 'WORKSPACE_INSIDE_RECOVERY_ROOT',
  )
})

test('recovery containment follows existing symlink ancestors and uses configured defaults', async t => {
  const root = await temporaryDirectory(t, 'standalone-editor-workspace-recovery-')
  const workspace = path.join(root, 'notes')
  const alias = path.join(root, 'workspace-alias')
  await fs.mkdir(workspace)
  try {
    await fs.symlink(workspace, alias, 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symlink unavailable: ${error.code}`)
    throw error
  }

  await assert.rejects(
    assertWorkspaceRecoveryRootsDisjoint(workspace, path.join(alias, 'recovery')),
    error => error.code === 'RECOVERY_ROOT_INSIDE_WORKSPACE',
  )

  assert.equal(
    defaultRecoveryRoot({ home: root, env: { EDITOR_RECOVERY_DIR: '', EDITOR_RECOVERY_ROOT: path.join(root, 'custom') } }),
    path.join(root, 'custom'),
  )
  assert.equal(
    defaultRecoveryRoot({ home: root, env: {} }),
    path.join(root, '.standalone-editor', 'recovery'),
  )
})
