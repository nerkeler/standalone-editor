import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTrashService } from '../src/trashService.js'

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function workspaceFixture(t) {
  const outer = await tempDirectory(t, 'standalone-editor-trash-test-')
  const workspace = path.join(outer, 'notes')
  const recovery = path.join(outer, 'app-recovery')
  await fs.mkdir(workspace)
  return { outer, workspace, recovery }
}

test('trash stages directories with hidden contents outside the workspace and restores them', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  const original = path.join(workspace, 'project')
  await fs.mkdir(path.join(original, '.obsidian'), { recursive: true })
  await fs.writeFile(path.join(original, 'readme.md'), '# notes')
  await fs.writeFile(path.join(original, '.obsidian', 'workspace.json'), '{"layout":true}')
  await fs.chmod(path.join(original, 'readme.md'), 0o600)

  const trash = createTrashService(workspace, { recoveryRoot: recovery })
  const result = await trash.trash('project')

  await assert.rejects(fs.lstat(original), error => error.code === 'ENOENT')
  const entries = await trash.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, result.id)
  assert.equal(entries[0].path, 'project')
  assert.equal(entries[0].type, 'directory')
  assert.ok(entries[0].expiresAt)
  const hash = (await fs.readdir(path.join(recovery, 'trash')))[0]
  const payloadPath = path.join(recovery, 'trash', hash, result.id, 'payload')
  assert.equal(await fs.readFile(path.join(payloadPath, '.obsidian', 'workspace.json'), 'utf8'), '{"layout":true}')
  assert.equal((await fs.stat(path.join(payloadPath, 'readme.md'))).mode & 0o777, process.platform === 'win32' ? (await fs.stat(path.join(payloadPath, 'readme.md'))).mode & 0o777 : 0o600)

  assert.deepEqual(await trash.restore(result.id), { success: true, path: 'project' })
  assert.equal(await fs.readFile(path.join(original, 'readme.md'), 'utf8'), '# notes')
  assert.equal(await fs.readFile(path.join(original, '.obsidian', 'workspace.json'), 'utf8'), '{"layout":true}')
  assert.deepEqual(await trash.list(), [])
})

test('restore refuses to overwrite an item created at the original path', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  await fs.writeFile(path.join(workspace, 'note.md'), 'original')
  const trash = createTrashService(workspace, { recoveryRoot: recovery })
  const { id } = await trash.trash('note.md')
  await fs.writeFile(path.join(workspace, 'note.md'), 'newer')

  await assert.rejects(trash.restore(id), error => error.code === 'CONFLICT')
  assert.equal(await fs.readFile(path.join(workspace, 'note.md'), 'utf8'), 'newer')
  assert.equal((await trash.list()).length, 1)
})

test('trash rejects symlinks without moving the source', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation may require administrator privileges')
  const { workspace, recovery } = await workspaceFixture(t)
  const outside = path.join(path.dirname(workspace), 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.md'), 'secret')
  await fs.mkdir(path.join(workspace, 'linked-folder'))
  await fs.symlink(path.join(outside, 'secret.md'), path.join(workspace, 'linked-folder', 'secret-link'))
  const trash = createTrashService(workspace, { recoveryRoot: recovery })

  await assert.rejects(trash.trash('linked-folder'), error => error.code === 'INVALID_PATH')
  assert.equal(await fs.readFile(path.join(workspace, 'linked-folder', 'secret-link'), 'utf8'), 'secret')
  assert.deepEqual(await trash.list(), [])
})

test('EXDEV uses a verified copy before removing the original', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  await fs.mkdir(path.join(workspace, 'folder'))
  await fs.writeFile(path.join(workspace, 'folder', '.hidden'), 'kept')
  await fs.writeFile(path.join(workspace, 'folder', 'normal.md'), 'kept too')
  const source = await fs.realpath(path.join(workspace, 'folder'))
  let simulated = false
  const rename = async (from, to) => {
    if (!simulated && from === source && to.endsWith(`${path.sep}payload`)) {
      simulated = true
      const error = new Error('simulated device boundary')
      error.code = 'EXDEV'
      throw error
    }
    return fs.rename(from, to)
  }
  const trash = createTrashService(workspace, { recoveryRoot: recovery, rename })

  const result = await trash.trash('folder')
  assert.equal(simulated, true)
  await assert.rejects(fs.lstat(source), error => error.code === 'ENOENT')
  const entry = (await trash.list()).find(item => item.id === result.id)
  assert.ok(entry)
  assert.equal(entry.state, 'ready')
  assert.equal(await trash.restore(result.id).then(() => fs.readFile(path.join(source, '.hidden'), 'utf8')), 'kept')
  assert.equal(await fs.readFile(path.join(source, 'normal.md'), 'utf8'), 'kept too')
})

test('a failed EXDEV copy leaves the source untouched and creates no trash entry', async t => {
  const { workspace, recovery } = await workspaceFixture(t)
  const original = path.join(workspace, 'important.md')
  await fs.writeFile(original, 'must survive')
  const rename = async () => {
    const error = new Error('simulated device boundary')
    error.code = 'EXDEV'
    throw error
  }
  const copyFile = async () => { throw new Error('simulated recovery disk failure') }
  const trash = createTrashService(workspace, { recoveryRoot: recovery, rename, copyFile })

  await assert.rejects(trash.trash('important.md'), /recovery disk failure/)
  assert.equal(await fs.readFile(original, 'utf8'), 'must survive')
  assert.deepEqual(await trash.list(), [])
})

test('recovery storage inside the selected workspace is rejected', async t => {
  const { workspace } = await workspaceFixture(t)
  const trash = createTrashService(workspace, { recoveryRoot: path.join(workspace, '.app-recovery') })
  await fs.writeFile(path.join(workspace, 'note.md'), 'safe')

  await assert.rejects(trash.trash('note.md'), error => error.code === 'INVALID_RECOVERY_ROOT')
  assert.equal(await fs.readFile(path.join(workspace, 'note.md'), 'utf8'), 'safe')
})
