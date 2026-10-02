import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSameEntry } from '../src/workspacePathGuard.js'

test('assertSameEntry compares adjacent bigint inode identities exactly above 2^53', async () => {
  const current = {
    dev: 7n,
    ino: 9007199254740992n,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true,
  }
  const expected = {
    ...current,
    ino: 9007199254740993n,
  }
  assert.equal(Number(current.ino), Number(expected.ino))

  let lstatCalls = 0
  const lstat = async (_target, options) => {
    lstatCalls += 1
    assert.deepEqual(options, { bigint: true })
    return current
  }
  await assert.rejects(assertSameEntry(
    '/unused/path',
    expected,
    message => Object.assign(new Error(message), { code: 'INVALID_PATH' }),
    { lstat },
  ), error => error.code === 'INVALID_PATH' && error.message === '文件在操作期间发生变化')
  assert.equal(lstatCalls, 1)

  await assert.doesNotReject(assertSameEntry(
    '/unused/path',
    current,
    message => Object.assign(new Error(message), { code: 'INVALID_PATH' }),
    { lstat },
  ))
  assert.equal(lstatCalls, 2)
})
