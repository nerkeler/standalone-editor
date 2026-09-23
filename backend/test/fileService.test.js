import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  listAll,
  listTree,
  searchWorkspace,
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

test('recursive tree uses the workspace-relative shape and omits hidden and symlink entries', async t => {
  const workspace = await temporaryWorkspace(t)
  const outside = await temporaryWorkspace(t)
  await fs.mkdir(path.join(workspace, 'notes'))
  await fs.mkdir(path.join(workspace, '.private'))
  await fs.writeFile(path.join(workspace, 'notes', 'one.md'), 'inside')
  await fs.writeFile(path.join(workspace, '.hidden.md'), 'hidden')
  await fs.writeFile(path.join(workspace, '.private', 'secret.md'), 'hidden')
  await fs.writeFile(path.join(outside, 'outside.md'), 'outside')

  if (process.platform !== 'win32') {
    await fs.symlink(path.join(outside, 'outside.md'), path.join(workspace, 'linked.md'))
    await fs.symlink(outside, path.join(workspace, 'linked-dir'))
  }

  const tree = await listTree(workspace)
  assert.deepEqual(tree, [
    { name: 'notes', type: 'dir', path: 'notes' },
    { name: 'one.md', type: 'file', path: 'notes/one.md' },
  ])
})

test('recursive tree handles a large flat and nested workspace', async t => {
  const workspace = await temporaryWorkspace(t)
  const expected = []
  for (let directory = 0; directory < 80; directory += 1) {
    const name = `dir-${directory}`
    await fs.mkdir(path.join(workspace, name))
    expected.push({ name, type: 'dir', path: name })
    const files = Array.from({ length: 12 }, (_, file) => {
      const fileName = `note-${file}.md`
      expected.push({ name: fileName, type: 'file', path: `${name}/${fileName}` })
      return fs.writeFile(path.join(workspace, name, fileName), 'content')
    })
    await Promise.all(files)
  }

  const tree = await listTree(workspace)
  assert.equal(tree.length, expected.length)
  assert.deepEqual(new Set(tree.map(item => `${item.type}:${item.path}`)), new Set(expected.map(item => `${item.type}:${item.path}`)))
})

test('workspace search keeps name and Markdown matching, previews and tree order', async t => {
  const workspace = await temporaryWorkspace(t)
  await fs.mkdir(path.join(workspace, 'nested'))
  await fs.writeFile(path.join(workspace, 'first.md'), 'before NEEDLE after')
  await fs.writeFile(path.join(workspace, 'Needle-by-name.md'), 'no body match')
  await fs.writeFile(path.join(workspace, 'plain.txt'), 'needle in a non-Markdown file')
  await fs.writeFile(path.join(workspace, 'nested', 'third.MD'), 'another needle here')
  await fs.mkdir(path.join(workspace, '.hidden'))
  await fs.writeFile(path.join(workspace, '.hidden', 'secret.md'), 'needle must stay hidden')

  const expectedOrder = []
  for (const item of await listAll(workspace)) {
    if (item.name.toLowerCase().includes('needle')) {
      expectedOrder.push(item.path)
    } else if (
      item.name.toLowerCase().endsWith('.md') &&
      (await fs.readFile(path.join(workspace, item.path), 'utf8')).toLowerCase().includes('needle')
    ) {
      expectedOrder.push(item.path)
    }
  }
  const results = await searchWorkspace(workspace, ' needle ')

  assert.deepEqual(results.map(item => item.path), expectedOrder)
  assert.equal(results.find(item => item.path === 'Needle-by-name.md').preview, undefined)
  assert.equal(results.find(item => item.path === 'first.md').preview, 'before NEEDLE after')
  assert.equal(results.find(item => item.path === 'nested/third.MD').preview, 'another needle here')
})

test('workspace search omits external symlink content and caps results at 100', async t => {
  const workspace = await temporaryWorkspace(t)
  const outside = await temporaryWorkspace(t)
  await fs.writeFile(path.join(outside, 'outside.md'), 'symlink-secret')
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(outside, 'outside.md'), path.join(workspace, 'linked.md'))
  }

  for (let index = 0; index < 105; index += 1) {
    await fs.writeFile(path.join(workspace, `target-${String(index).padStart(3, '0')}.md`), 'body does not match')
  }
  const expected = (await listAll(workspace))
    .filter(item => item.name.startsWith('target-'))
    .slice(0, 100)
    .map(item => item.path)

  const matches = await searchWorkspace(workspace, 'target-')
  assert.equal(matches.length, 100)
  assert.deepEqual(matches.map(item => item.path), expected)
  assert.ok(matches.every(item => item.preview === undefined))
  assert.deepEqual(await searchWorkspace(workspace, 'symlink-secret'), [])
})
