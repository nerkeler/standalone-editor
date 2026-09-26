import assert from 'node:assert/strict'
import test from 'node:test'
import { createSearchCoordinator } from '../src/searchCoordinator.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await wait(5)
  }
  assert.fail('Timed out waiting for search coordinator state')
}

test('debounces rapid input and sends the trimmed latest query once', async () => {
  const calls = []
  const results = []
  const loading = []
  const coordinator = createSearchCoordinator({
    delayMs: 20,
    search: async query => { calls.push(query); return [{ path: query }] },
    onResults: value => results.push(value),
    onLoading: value => loading.push(value),
  })

  coordinator.query(' do')
  await wait(5)
  coordinator.query(' doc ')
  await wait(5)
  coordinator.query(' document ')
  await waitFor(() => calls.length > 0 && results.at(-1)?.[0]?.path === 'document')

  assert.deepEqual(calls, ['document'])
  assert.deepEqual(results.at(-1), [{ path: 'document' }])
  assert.equal(loading.at(-1), false)
  coordinator.dispose()
})

test('a late response cannot replace newer results and clearing is immediate', async () => {
  const pending = new Map()
  const results = []
  const loading = []
  const coordinator = createSearchCoordinator({
    delayMs: 0,
    search: query => new Promise((resolve, reject) => pending.set(query, { resolve, reject })),
    onResults: value => results.push(value),
    onLoading: value => loading.push(value),
  })

  coordinator.query('old')
  await wait(0)
  coordinator.query('new')
  await wait(0)
  pending.get('new').resolve([{ path: 'new.md' }])
  await wait(0)
  pending.get('old').resolve([{ path: 'old.md' }])
  await wait(0)

  assert.deepEqual(results.at(-1), [{ path: 'new.md' }])
  coordinator.query('   ')
  assert.deepEqual(results.at(-1), [])
  assert.equal(loading.at(-1), false)
  coordinator.dispose()
})

test('clearing an in-flight query prevents its response from repopulating results', async () => {
  let resolveSearch
  let signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const results = []
  const loading = []
  const coordinator = createSearchCoordinator({
    delayMs: 0,
    search: () => new Promise(resolve => { resolveSearch = resolve; signalStarted() }),
    onResults: value => results.push(value),
    onLoading: value => loading.push(value),
  })

  coordinator.query('old query')
  await started
  coordinator.query('')
  const resultUpdateCount = results.length
  assert.deepEqual(results.at(-1), [])
  assert.equal(loading.at(-1), false)

  resolveSearch([{ path: 'old.md' }])
  await wait(0)
  assert.equal(results.length, resultUpdateCount)
  assert.deepEqual(results.at(-1), [])
  assert.equal(loading.at(-1), false)
  coordinator.dispose()
})

test('dispose cancels a pending debounce and ignores requests that finish later', async () => {
  const calls = []
  const results = []
  let resolveInFlight
  let signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const coordinator = createSearchCoordinator({
    delayMs: 15,
    search: query => new Promise(resolve => {
      calls.push(query)
      resolveInFlight = resolve
      signalStarted()
    }),
    onResults: value => results.push(value),
    onLoading: () => {},
  })

  coordinator.query('not-started')
  coordinator.dispose()
  await wait(25)
  assert.deepEqual(calls, [])
  coordinator.query('after-dispose')
  assert.deepEqual(calls, [])

  const lateCoordinator = createSearchCoordinator({
    delayMs: 0,
    search: () => new Promise(resolve => { resolveInFlight = resolve; signalStarted() }),
    onResults: value => results.push(value),
    onLoading: () => {},
  })
  lateCoordinator.query('in-flight')
  await started
  const resultUpdateCount = results.length
  lateCoordinator.dispose()
  resolveInFlight([{ path: 'late.md' }])
  await wait(0)
  assert.equal(results.length, resultUpdateCount)
  assert.deepEqual(results.at(-1), [])
})
