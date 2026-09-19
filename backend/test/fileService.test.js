import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  writeFile,
  uploadFile,
} from '../src/fileService.js'

async function temporaryWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-editor-test-'))
  t.after(() => fs.rm(workspace, { recursive: true, force: true }))
  return workspace
}

test('atomic writes preserve private file permissions', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.writeFile(path.join(workspace, 'private.md'), 'old', { mode: 0o600 })
  await fs.chmod(path.join(workspace, 'private.md'), 0o600)

  await writeFile(workspace, 'private.md', 'new')

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(workspace, 'private.md'))).mode & 0o777, 0o600)
  }
  assert.equal(await fs.readFile(path.join(workspace, 'private.md'), 'utf8'), 'new')
})

test('new atomic writes default to owner-only permissions', async t => {
  const workspace = await temporaryWorkspace(t)

  await writeFile(workspace, 'new.md', 'draft')

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(workspace, 'new.md'))).mode & 0o777, 0o600)
  }
})

test('uploads keep binary bytes and refuse replacement', async t => {
  const workspace = await temporaryWorkspace(t)
  const bytes = Buffer.from([0x00, 0x89, 0xff, 0x10, 0x00])

  await uploadFile(workspace, '', { originalname: 'asset.bin', buffer: bytes })
  assert.deepEqual(await fs.readFile(path.join(workspace, 'asset.bin')), bytes)
  await assert.rejects(
    uploadFile(workspace, '', { originalname: 'asset.bin', buffer: Buffer.from('changed') }),
    error => error.code === 'CONFLICT',
  )
  assert.deepEqual(await fs.readFile(path.join(workspace, 'asset.bin')), bytes)
})
