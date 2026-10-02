import test from 'node:test'
import assert from 'node:assert/strict'
import { fileFingerprint, matchesFileFingerprint } from '../src/zipImportIdentity.js'

function fakeRegularFile({ dev = 7n, ino = 11n, size = 4n, mtimeNs = 100n, ctimeNs = 200n } = {}) {
  return {
    dev,
    ino,
    size,
    mtimeNs,
    ctimeNs,
    mode: 0o100600n,
    isFile: () => true,
    isSymbolicLink: () => false,
  }
}

test('a reused dev/ino, size, and content hash is rejected when its captured generation changes', () => {
  const expected = fileFingerprint(fakeRegularFile(), 'same-sha256')
  const replacement = fakeRegularFile({ ctimeNs: 201n })

  assert.equal(replacement.dev, expected.dev)
  assert.equal(replacement.ino, expected.ino)
  assert.equal(replacement.size, expected.size)
  assert.equal(matchesFileFingerprint(replacement, expected, 'same-sha256'), false)
})
