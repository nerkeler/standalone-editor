import test from 'node:test'
import assert from 'node:assert/strict'
import { formatBackendUrl } from '../src/serverRuntime.js'

test('backend address log formats IPv6 and ordinary host URLs', () => {
  assert.equal(formatBackendUrl('::1', 5557), 'http://[::1]:5557')
  assert.equal(formatBackendUrl('2001:db8::1', 5557), 'http://[2001:db8::1]:5557')
  assert.equal(formatBackendUrl('127.0.0.1', 5557), 'http://127.0.0.1:5557')
  assert.equal(formatBackendUrl('[::1]', 5557), 'http://[::1]:5557')
})
