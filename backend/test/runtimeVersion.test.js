import test from 'node:test'
import assert from 'node:assert/strict'
import { isSupportedNodeVersion } from '../src/runtimeVersion.js'

test('runtime support stays within Node 22.17.0 or newer in the 22.x line', () => {
  assert.equal(isSupportedNodeVersion('22.16.9'), false)
  assert.equal(isSupportedNodeVersion('v22.17.0'), true)
  assert.equal(isSupportedNodeVersion('22.22.3'), true)
  assert.equal(isSupportedNodeVersion('22.99.0'), true)
  assert.equal(isSupportedNodeVersion('23.0.0'), false)
  assert.equal(isSupportedNodeVersion('24.0.0'), false)
  assert.equal(isSupportedNodeVersion('v22.17.0-nightly'), false)
  assert.equal(isSupportedNodeVersion('not-a-version'), false)
})
