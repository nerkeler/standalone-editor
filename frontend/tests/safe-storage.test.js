import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyStorageError,
  listStorageKeys,
  readJsonStorage,
  readStorage,
  removeStorage,
  writeStorage,
} from '../src/safeStorage.js'

function installStorage(t, storage) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
}

function storageError(name, message = name) {
  return new DOMException(message, name)
}

test('safe storage reports denied get, set, and remove operations without throwing', t => {
  installStorage(t, {
    getItem() { throw storageError('SecurityError') },
    setItem() { throw storageError('SecurityError') },
    removeItem() { throw storageError('SecurityError') },
  })

  const read = readStorage('key')
  assert.equal(read.ok, false)
  assert.equal(read.value, null)
  assert.equal(read.code, 'security')
  assert.equal(read.error.name, 'SecurityError')
  const write = writeStorage('key', 'value')
  assert.equal(write.ok, false)
  assert.equal(write.code, 'security')
  assert.equal(write.error.name, 'SecurityError')
  const remove = removeStorage('key')
  assert.equal(remove.ok, false)
  assert.equal(remove.code, 'security')
  assert.equal(remove.error.name, 'SecurityError')
})

test('safe storage identifies quota exhaustion and malformed JSON', t => {
  installStorage(t, {
    getItem() { return '{broken' },
    setItem() { throw storageError('QuotaExceededError') },
    removeItem() {},
    get length() { return 0 },
    key() { return null },
  })

  const parsed = readJsonStorage('cache', { fallback: true })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.code, 'invalid-json')
  assert.deepEqual(parsed.value, { fallback: true })
  assert.equal(writeStorage('key', 'large payload').code, 'quota')
  assert.equal(classifyStorageError(storageError('QuotaExceededError')), 'quota')
})

test('workspace context stays usable in memory when browser storage is denied', async t => {
  installStorage(t, {
    getItem() { throw storageError('SecurityError') },
    setItem() { throw storageError('QuotaExceededError') },
    removeItem() { throw storageError('SecurityError') },
  })

  const suffix = `${Date.now()}-${Math.random()}`
  const { api, getWorkspaceContext, setWorkspaceContext } = await import(`../src/api.js?denied=${suffix}`)
  assert.equal(getWorkspaceContext(), null)

  const selected = {
    workspace: '/tmp/isolated-workspace',
    workspaceId: 'workspace-memory-id',
    workspaceVersion: 7,
  }
  assert.deepEqual(setWorkspaceContext(selected), selected)
  assert.deepEqual(getWorkspaceContext(), selected)
  const config = api.interceptors.request.handlers[0].fulfilled({ url: '/api/workspace', headers: {} })
  assert.equal(config.headers['X-Workspace-Id'], selected.workspaceId)
  assert.equal(config.headers['X-Workspace-Version'], '7')
  setWorkspaceContext({
    workspace: '/tmp/new-current-workspace',
    workspaceId: 'workspace-current-id',
    workspaceVersion: 8,
  })
  const delayedIntentConfig = api.interceptors.request.handlers[0].fulfilled({
    url: '/api/workspace/trash/purge-expired',
    headers: {
      'X-Workspace-Id': selected.workspaceId,
      'X-Workspace-Version': String(selected.workspaceVersion),
    },
  })
  assert.equal(delayedIntentConfig.headers['X-Workspace-Id'], selected.workspaceId)
  assert.equal(delayedIntentConfig.headers['X-Workspace-Version'], '7')
  assert.doesNotThrow(() => setWorkspaceContext(null))
  assert.equal(getWorkspaceContext(), null)
})

test('malformed cached workspace JSON safely falls back to the legacy cached path', async t => {
  installStorage(t, {
    getItem(key) {
      if (key === 'editor_workspace_info') return '{broken'
      if (key === 'editor_workspace') return '/tmp/isolated-cached-workspace'
      return null
    },
    setItem() {},
    removeItem() {},
  })

  const suffix = `${Date.now()}-${Math.random()}`
  const { getWorkspaceContext } = await import(`../src/api.js?malformed=${suffix}`)
  assert.deepEqual(getWorkspaceContext(), { workspace: '/tmp/isolated-cached-workspace' })
})

test('storage key enumeration failures are contained', t => {
  installStorage(t, {
    get length() { throw storageError('SecurityError') },
    key() { return null },
  })

  const keys = listStorageKeys('editor_pending_drafts:')
  assert.equal(keys.ok, false)
  assert.equal(keys.code, 'security')
  assert.deepEqual(keys.keys, [])
})
