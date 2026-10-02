import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceRecoveryCoordinator } from '../src/pages/workspaceRecoveryCoordinator.js'

function createHarness(api) {
  const context = {
    workspaceKey: 'workspace-a',
    workspaceId: 'workspace-id-a',
    workspaceVersion: 3,
    workspaceEpoch: 0,
  }
  const updates = []
  let state = null
  const coordinator = createWorkspaceRecoveryCoordinator({
    api,
    getWorkspaceContext: () => context,
    onStateChange(update) {
      state = typeof update === 'function' ? update(state) : update
      updates.push(state)
    },
  })
  return {
    context,
    coordinator,
    get state() { return state },
    updates,
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('a delayed destructive confirmation cannot mutate the newly selected workspace', async () => {
  const calls = []
  const harness = createHarness({
    get: async (...args) => { calls.push(['get', ...args]); return { data: {} } },
    post: async (...args) => { calls.push(['post', ...args]); return { data: {} } },
    delete: async (...args) => { calls.push(['delete', ...args]); return { data: {} } },
  })
  const confirmIntent = harness.coordinator.createIntent('purge-expired')

  // A user can leave a confirmation dialog open while the workspace changes.
  harness.context.workspaceKey = 'workspace-b'
  harness.context.workspaceId = 'workspace-id-b'
  harness.context.workspaceVersion = 4
  harness.context.workspaceEpoch += 1
  const result = await harness.coordinator.runIntent(confirmIntent)

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'stale-workspace')
  assert.equal(result.committed, false)
  assert.deepEqual(calls, [])
})

test('unmount invalidates pending recovery intents, including after a StrictMode-style remount', async () => {
  const calls = []
  const harness = createHarness({
    get: async (...args) => { calls.push(['get', ...args]); return { data: {} } },
    post: async (...args) => { calls.push(['post', ...args]); return { data: {} } },
    delete: async (...args) => { calls.push(['delete', ...args]); return { data: {} } },
  })
  const intent = harness.coordinator.createIntent('purge-expired')

  // The hook marks itself inactive and advances the epoch during cleanup.
  harness.context.active = false
  harness.context.workspaceEpoch += 1
  assert.equal((await harness.coordinator.runIntent(intent)).reason, 'stale-workspace')

  // StrictMode may run setup again for the same hook instance. Reactivating
  // must not revive intents or requests created before cleanup.
  harness.context.active = true
  assert.equal((await harness.coordinator.runIntent(intent)).reason, 'stale-workspace')
  assert.deepEqual(calls, [])
})

test('a recovery response finishing after unmount cannot write state after reactivation', async () => {
  const pending = deferred()
  const harness = createHarness({
    get: async () => pending.promise,
    post: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
  })
  const intent = harness.coordinator.createIntent('refresh')
  const request = harness.coordinator.runIntent(intent)
  const updateCountAtUnmount = harness.updates.length

  harness.context.active = false
  harness.context.workspaceEpoch += 1
  harness.context.active = true
  pending.resolve({ data: { items: [{ id: 'late-result' }] } })

  const result = await request
  assert.equal(result.reason, 'stale-workspace')
  assert.equal(harness.updates.length, updateCountAtUnmount)
  assert.equal(harness.state.trashItems.length, 0)
  assert.equal(harness.state.stats, null)
})

test('a completed mutation refreshes data and reports intent-level results without UI dependencies', async () => {
  const calls = []
  const harness = createHarness({
    get: async (path, config) => {
      calls.push(['get', path, config])
      return path.endsWith('/trash')
        ? { data: { items: [{ id: 'trash-1', path: 'notes/old.md' }] } }
        : { data: { total: { items: 2, bytes: 24 } } }
    },
    post: async (path, body, config) => {
      calls.push(['post', path, body, config])
      return { data: { success: true, path: 'notes/old.md' } }
    },
    delete: async (...args) => { calls.push(['delete', ...args]); return { data: {} } },
  })
  const intent = harness.coordinator.createIntent('restore-trash', { id: 'trash-1' })
  const result = await harness.coordinator.runIntent(intent)

  assert.equal(result.ok, true)
  assert.equal(result.committed, true)
  assert.equal(result.currentWorkspace, true)
  assert.equal(result.data.path, 'notes/old.md')
  assert.equal(result.refresh.ok, true)
  assert.deepEqual(calls, [
    ['post', '/api/workspace/trash/restore', { id: 'trash-1' }, {
      headers: { 'X-Workspace-Id': 'workspace-id-a', 'X-Workspace-Version': '3' },
    }],
    ['get', '/api/workspace/trash', {
      headers: { 'X-Workspace-Id': 'workspace-id-a', 'X-Workspace-Version': '3' },
    }],
    ['get', '/api/workspace/recovery/stats', {
      headers: { 'X-Workspace-Id': 'workspace-id-a', 'X-Workspace-Version': '3' },
    }],
  ])
  assert.deepEqual(harness.state.trashItems, [{ id: 'trash-1', path: 'notes/old.md' }])
  assert.deepEqual(harness.state.stats, { total: { items: 2, bytes: 24 } })
  assert.equal(harness.state.mutationBusy, false)
})

test('refresh state updates preserve cached items, stats, and a running mutation', async () => {
  const pendingPost = deferred()
  const pendingGets = []
  let getCount = 0
  const harness = createHarness({
    get(path) {
      getCount += 1
      if (getCount > 2) {
        return new Promise(resolve => pendingGets.push({ path, resolve }))
      }
      return Promise.resolve(path.endsWith('/trash')
        ? { data: { items: [{ id: 'trash-3' }] } }
        : { data: { total: { items: 3, bytes: 30 } } })
    },
    post: () => pendingPost.promise,
    delete: async () => ({ data: {} }),
  })

  await harness.coordinator.runIntent(harness.coordinator.createIntent('refresh'))
  const mutation = harness.coordinator.runIntent(harness.coordinator.createIntent('purge-expired'))
  assert.equal(harness.state.mutationBusy, true)
  pendingPost.resolve({ data: { purged: 0 } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pendingGets.length, 2)
  assert.equal(harness.state.mutationBusy, true)
  assert.deepEqual(harness.state.trashItems, [{ id: 'trash-3' }])
  assert.deepEqual(harness.state.stats, { total: { items: 3, bytes: 30 } })

  for (const request of pendingGets) {
    request.resolve(request.path.endsWith('/trash')
      ? { data: { items: [{ id: 'trash-4' }] } }
      : { data: { total: { items: 4, bytes: 40 } } })
  }
  await mutation
  assert.equal(harness.state.mutationBusy, false)
  assert.deepEqual(harness.state.trashItems, [{ id: 'trash-4' }])
  assert.deepEqual(harness.state.stats, { total: { items: 4, bytes: 40 } })
})

test('a request that finishes after a workspace switch cannot update recovery state', async () => {
  const pending = deferred()
  const harness = createHarness({
    get: () => pending.promise,
    post: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
  })
  const intent = harness.coordinator.createIntent('refresh')
  const request = harness.coordinator.runIntent(intent)
  const updatesBeforeSwitch = harness.updates.length
  harness.context.workspaceKey = 'workspace-b'
  harness.context.workspaceId = 'workspace-id-b'
  harness.context.workspaceVersion = 4
  harness.context.workspaceEpoch += 1
  pending.resolve({ data: { items: ['late response'] } })

  const result = await request
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'stale-workspace')
  assert.equal(harness.updates.length, updatesBeforeSwitch)
  assert.equal(harness.updates.some(update => update.workspaceKey === 'workspace-b'), false)
})

test('an in-flight destructive action reports that it committed but does not refresh a different workspace', async () => {
  const pending = deferred()
  const calls = []
  const harness = createHarness({
    get: async (...args) => { calls.push(['get', ...args]); return { data: {} } },
    post: (...args) => { calls.push(['post', ...args]); return pending.promise },
    delete: async (...args) => { calls.push(['delete', ...args]); return { data: {} } },
  })
  const intent = harness.coordinator.createIntent('delete-trash', { id: 'trash-2' })
  const request = harness.coordinator.runIntent(intent)
  const updatesBeforeSwitch = harness.updates.length
  harness.context.workspaceKey = 'workspace-b'
  harness.context.workspaceId = 'workspace-id-b'
  harness.context.workspaceVersion = 4
  harness.context.workspaceEpoch += 1
  pending.resolve({ data: { success: true } })

  const result = await request
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'workspace-changed')
  assert.equal(result.committed, true)
  assert.equal(result.currentWorkspace, false)
  assert.deepEqual(calls, [['delete', '/api/workspace/trash', {
    params: { id: 'trash-2' },
    headers: { 'X-Workspace-Id': 'workspace-id-a', 'X-Workspace-Version': '3' },
  }]])
  assert.equal(harness.updates.length, updatesBeforeSwitch)
})

test('a failed trash mutation refreshes with its captured workspace identity and releases busy state', async () => {
  const error = new Error('storage service unavailable')
  const calls = []
  const expectedConfig = {
    headers: { 'X-Workspace-Id': 'workspace-id-a', 'X-Workspace-Version': '3' },
  }
  const harness = createHarness({
    get: async (path, config) => {
      calls.push(['get', path, config])
      return path.endsWith('/trash') ? { data: { items: [] } } : { data: { total: { items: 0, bytes: 0 } } }
    },
    post: async () => ({ data: {} }),
    delete: async (path, config) => {
      calls.push(['delete', path, config])
      throw error
    },
  })
  const intent = harness.coordinator.createIntent('delete-trash', { id: 'trash-7' })
  const result = await harness.coordinator.runIntent(intent)

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'request-failed')
  assert.equal(result.error, error)
  assert.equal(result.committed, false)
  assert.equal(result.currentWorkspace, true)
  assert.equal(result.refresh.ok, true)
  assert.deepEqual(calls, [
    ['delete', '/api/workspace/trash', {
      params: { id: 'trash-7' },
      ...expectedConfig,
    }],
    ['get', '/api/workspace/trash', expectedConfig],
    ['get', '/api/workspace/recovery/stats', expectedConfig],
  ])
  assert.equal(harness.state.mutationBusy, false)
})

test('a failed mutation does not update state when its refresh finishes after a workspace switch', async () => {
  const requests = []
  const error = new Error('delete response failed')
  const harness = createHarness({
    get(path, config) {
      const pending = deferred()
      requests.push({ path, config, ...pending })
      return pending.promise
    },
    post: async () => ({ data: {} }),
    delete: async () => { throw error },
  })
  const intent = harness.coordinator.createIntent('delete-trash', { id: 'trash-8' })
  const mutation = harness.coordinator.runIntent(intent)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests.map(request => request.path), [
    '/api/workspace/trash',
    '/api/workspace/recovery/stats',
  ])

  const updatesBeforeSwitch = harness.updates.length
  harness.context.workspaceKey = 'workspace-b'
  harness.context.workspaceId = 'workspace-id-b'
  harness.context.workspaceVersion = 4
  harness.context.workspaceEpoch += 1
  for (const request of requests) {
    request.resolve(request.path.endsWith('/trash')
      ? { data: { items: [{ id: 'stale-trash' }] } }
      : { data: { total: { items: 1, bytes: 1 } } })
  }

  const result = await mutation
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'workspace-changed')
  assert.equal(result.currentWorkspace, false)
  assert.equal(result.error, error)
  assert.equal(harness.updates.length, updatesBeforeSwitch)
  assert.deepEqual(harness.state.trashItems ?? [], [])
})
