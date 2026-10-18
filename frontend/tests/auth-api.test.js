import assert from 'node:assert/strict'
import test from 'node:test'
import {
  api,
  authCooldownSeconds,
  describeAuthError,
  getSessionCsrfToken,
  isSessionAuthenticated,
  loginWithPassword,
  logoutSession,
  probeSession,
  setSessionCsrfToken,
  subscribeAuthRequired,
} from '../src/api.js'

// Replace the transport with a scripted responder. Non-2xx responses are
// thrown in the same shape axios produces so the response interceptor runs.
function scriptResponses(handler) {
  const seen = []
  api.defaults.adapter = async config => {
    seen.push(config)
    const result = await handler(config)
    const status = result.status ?? 200
    const response = { data: result.data ?? {}, status, headers: result.headers ?? {}, config }
    if (status >= 400) {
      const error = new Error(`Request failed with status code ${status}`)
      error.response = response
      error.config = config
      throw error
    }
    return response
  }
  return seen
}

function reset(t) {
  setSessionCsrfToken(null)
  t.after(() => setSessionCsrfToken(null))
}

test('login stores the CSRF token and mutating requests present it', async t => {
  reset(t)
  scriptResponses(config => {
    if (config.url === '/api/auth/login') return { data: { success: true, csrfToken: 'csrf-1' } }
    return { data: { ok: true } }
  })
  await loginWithPassword('pw')
  assert.equal(getSessionCsrfToken(), 'csrf-1')
  assert.equal(isSessionAuthenticated(), true)

  const sent = scriptResponses(() => ({ data: {} }))
  await api.post('/api/workspace', { name: 'b.md' })
  assert.equal(sent[0].headers['X-CSRF-Token'], 'csrf-1')
})

test('safe methods never carry the CSRF header', async t => {
  reset(t)
  setSessionCsrfToken('csrf-2')
  const seen = scriptResponses(() => ({ data: {} }))
  await api.get('/api/workspace/check')
  assert.equal(seen[0].headers['X-CSRF-Token'], undefined)
})

test('an AUTH_REQUIRED response clears the token and notifies listeners once', async t => {
  reset(t)
  setSessionCsrfToken('csrf-3')
  let notified = 0
  const unsubscribe = subscribeAuthRequired(() => { notified += 1 })
  t.after(unsubscribe)
  scriptResponses(() => ({ status: 401, data: { code: 'AUTH_REQUIRED', error: '需要登录' } }))
  await assert.rejects(api.get('/api/workspace/file?path=a.md'))
  assert.equal(getSessionCsrfToken(), null)
  assert.equal(notified, 1)
})

test('other 401 responses and unrelated errors do not trigger the login gate', async t => {
  reset(t)
  setSessionCsrfToken('csrf-4')
  let notified = 0
  const unsubscribe = subscribeAuthRequired(() => { notified += 1 })
  t.after(unsubscribe)
  scriptResponses(() => ({ status: 401, data: { code: 'SOMETHING_ELSE' } }))
  await assert.rejects(api.get('/api/x'))
  scriptResponses(() => ({ status: 409, data: { code: 'WORKSPACE_MISMATCH' } }))
  await assert.rejects(api.get('/api/y'))
  assert.equal(notified, 0)
  assert.equal(getSessionCsrfToken(), 'csrf-4')
})

test('probeSession distinguishes disabled, locked and authenticated states', async t => {
  reset(t)
  scriptResponses(() => ({ data: { success: false, enabled: false } }))
  assert.deepEqual(await probeSession(), { enabled: false })

  scriptResponses(() => ({ data: { success: true, enabled: true, csrfToken: 'csrf-5' } }))
  assert.deepEqual(await probeSession(), { enabled: true, authenticated: true })
  assert.equal(getSessionCsrfToken(), 'csrf-5')
})

test('logout always clears the token, even when the request fails', async t => {
  reset(t)
  setSessionCsrfToken('csrf-6')
  scriptResponses(() => ({ status: 500, data: { error: 'boom' } }))
  await assert.rejects(logoutSession())
  assert.equal(getSessionCsrfToken(), null)
})

test('auth error text covers disabled auth and rate limiting', () => {
  const disabled = { response: { data: { code: 'AUTH_NOT_ENABLED' } } }
  assert.match(describeAuthError(disabled), /未启用密码登录/)
  const limited = { response: { data: { code: 'RATE_LIMITED', retryAfterSeconds: 42 } } }
  assert.match(describeAuthError(limited), /42 秒/)
  assert.equal(authCooldownSeconds(limited), 42)
  assert.equal(describeAuthError({ response: { data: { error: '密码不正确' } } }), '密码不正确')
  assert.equal(authCooldownSeconds({ response: { data: {} } }), 0)
})
