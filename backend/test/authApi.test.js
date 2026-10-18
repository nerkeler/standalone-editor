import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createBackend } from '../src/index.js'
import { createHttpServer } from '../src/httpServer.js'
import {
  CLEAR_SESSION_COOKIE,
  createLoginRateLimiter,
  createPasswordRecord,
  createSessionStore,
  parseCookieHeader,
  parsePasswordFile,
  serializeSessionCookie,
  verifyPassword,
} from '../src/authService.js'
import { loadPasswordRecord } from '../src/authRoutes.js'

const WEEK_SECONDS = 7 * 24 * 60 * 60

async function temporaryDirectory(t, name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `standalone-editor-${name}-`))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function makeBackend(t, options, envOverrides = {}) {
  const root = await temporaryDirectory(t, `auth-${options.name}`)
  const workspace = path.join(root, 'notes')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'note.md'), '# auth test\n')
  const backend = createBackend({
    env: {
      ...process.env,
      ALLOW_ANY_WORKSPACE: '1',
      CORS_ORIGINS: '*',
      ...envOverrides,
    },
    argv: [],
    workspace,
    defaultWorkspace: workspace,
    configFile: path.join(root, 'workspace.json'),
    recoveryRoot: path.join(root, 'recovery'),
    host: '127.0.0.1',
    port: 0,
    ...options.factory,
  })
  await backend.initialize()
  const server = createHttpServer(backend.app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const info = backend.currentWorkspaceInfo()
  return { backend, url, root, workspace,
    identityHeaders: { 'X-Workspace-Id': info.workspaceId, 'X-Workspace-Version': String(info.workspaceVersion) } }
}

/**
 * @param {string} url
 * @param {string} pathname
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [options]
 */
function request(url, pathname, { method = 'GET', headers = {}, body } = {}) {
  return fetch(`${url}${pathname}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  })
}

function cookiesFrom(response) {
  const raw = response.headers.getSetCookie?.() || []
  return raw.map(value => value.split(';')[0])
}

// ---------- 单元 authService ----------

test('password records round-trip through scrypt and reject wrong passwords', async () => {
  const record = await createPasswordRecord('correct horse battery')
  assert.equal(record.version, 1)
  assert.equal(await verifyPassword('correct horse battery', record), true)
  assert.equal(await verifyPassword('wrong password', record), false)
  assert.equal(await verifyPassword('', record), false)
})

test('corrupt password files throw instead of silently disabling auth', () => {
  assert.throws(() => parsePasswordFile('not json'), /** @type {(e: unknown) => boolean} */ (error) => /** @type {Error & { code?: string }} */ (error)?.code === 'AUTH_CONFIG_CORRUPT')
  assert.equal(parsePasswordFile(JSON.stringify({ version: 1, salt: 'ab', hash: 'cd' }))?.salt, 'ab')
})

test('sliding sessions renew on verification and vanish on revoke', () => {
  const store = createSessionStore({ idleMs: 1000 })
  const startedAt = Date.now()
  const session = store.issue(startedAt)
  assert.equal(store.verify('missing-token', { now: startedAt }), null)
  const verifiedAt = startedAt + 500
  const verified = store.verify(session.token, { now: verifiedAt })
  assert.equal(verified?.csrfToken, session.csrfToken)
  // Sliding window: expiry extended relative to the verification time.
  assert.equal(verified?.expiresAt, verifiedAt + 1000)
  // Expired exactly at the slide boundary after last renewal.
  assert.equal(store.verify(session.token, { now: verifiedAt + 1001 }), null)
  const second = store.issue(startedAt)
  store.revoke(second.token)
  assert.equal(store.verify(second.token, { now: startedAt }), null)
})

test('session store enforces the ceiling instead of evicting', () => {
  const store = createSessionStore({ maxSessions: 2 })
  store.issue()
  store.issue()
  assert.throws(() => store.issue(), /** @type {(e: unknown) => boolean} */ (error) => /** @type {Error & { code?: string }} */ (error)?.code === 'SESSION_LIMIT')
})

test('login rate limiter grows the cool-down on repeated failures', () => {
  const limiter = createLoginRateLimiter({ maxFailures: 5, windowMs: 1000 })
  const now = 5_000
  for (let index = 0; index < 4; index += 1) {
    assert.equal(limiter.recordFailure('ip', { now }), 0)
  }
  assert.equal(limiter.recordFailure('ip', { now: now + 10 }), 1)
  assert.equal(limiter.blockRemaining('ip', { now: now + 20 }), 1)
  // After the block window the state resets for the next burst.
  assert.equal(limiter.recordFailure('ip', { now: now + 2000 }), 0)
  assert.equal(limiter.blockRemaining('other-ip'), 0)
})

test('cookie helpers parse lists and serialize secure variants', () => {
  const parsed = parseCookieHeader('a=1; editor_session="face"; b=2')
  assert.deepEqual(parsed, { a: '1', editor_session: 'face', b: '2' })
  assert.deepEqual(parseCookieHeader(undefined), {})
  const plain = serializeSessionCookie('editor_session', 'token', { maxAgeSeconds: WEEK_SECONDS })
  assert.match(plain, /HttpOnly/)
  assert.match(plain, /SameSite=Lax/)
  assert.match(plain, new RegExp(`Max-Age=${WEEK_SECONDS}`))
  assert.doesNotMatch(plain, /Secure/)
  assert.match(serializeSessionCookie('editor_session', 'x', { secure: true }), /Secure/)
  assert.match(CLEAR_SESSION_COOKIE, /Max-Age=0/)
})

test('loadPasswordRecord prefers the explicit password and persists it', async t => {
  await makeBackend(t, { name: 'record' })
  const authFile = path.join(await temporaryDirectory(t, 'record'), 'auth.json')
  await loadPasswordRecord(authFile, { password: 'from-env' })
  const persisted = parsePasswordFile(await fs.readFile(authFile, 'utf-8'))
  assert.equal(await verifyPassword('from-env', persisted), true)
  const mode = (await fs.stat(authFile)).mode & 0o777
  assert.equal(mode, 0o600)
})

// ---------- API 集成 ----------

test('without a password file the service stays open and login reports disabled', async t => {
  const { url, identityHeaders } = await makeBackend(t, { name: 'open' })
  const probe = await request(url, '/api/auth/session')
  assert.equal(probe.status, 200)
  assert.deepEqual(await probe.json(), { success: false, enabled: false })

  const login = await request(url, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'anything' }),
  })
  assert.equal(login.status, 400)
  assert.equal((await login.json()).code, 'AUTH_NOT_ENABLED')

  const put = await request(url, '/api/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...identityHeaders },
    body: JSON.stringify({ path: 'note.md', content: 'changed',
      expectedRevision: createHash('sha256').update('# auth test\n').digest('hex') }),
  })
  assert.equal(put.status, 200)
})

test('password protection guards every API route and recovers after login', async t => {
  const { url, identityHeaders } = await makeBackend(t, { name: 'guard' }, { EDITOR_PASSWORD: 's3cret-pass' })

  const blocked = await request(url, '/api/workspace/file?path=note.md')
  assert.equal(blocked.status, 401)
  assert.equal((await blocked.json()).code, 'AUTH_REQUIRED')
  // A missing cookie gets an explicit clear so stale tokens cannot linger.
  assert.ok((blocked.headers.getSetCookie() || []).some(value => value.startsWith('editor_session=')))

  const wrong = await request(url, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'totally-wrong' }),
  })
  assert.equal(wrong.status, 401)
  assert.equal((await wrong.json()).code, 'AUTH_FAILED')

  const login = await request(url, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 's3cret-pass' }),
  })
  assert.equal(login.status, 200)
  const { csrfToken, success } = await login.json()
  assert.equal(success, true)
  assert.match(csrfToken, /^[0-9a-f]{48}$/)
  const sessionCookie = (() => {
    const value = (login.headers.getSetCookie() || []).find(item => item.startsWith('editor_session='))
    return value?.split(';')[0]
  })()
  assert.match(sessionCookie, /^editor_session=[0-9a-f]{64}$/)
  assert.match((login.headers.getSetCookie() || [])[0], /HttpOnly/)
  assert.match((login.headers.getSetCookie() || [])[0], /SameSite=Lax/)
  assert.match((login.headers.getSetCookie() || [])[0], new RegExp(`Max-Age=${WEEK_SECONDS}`))
  ;(void cookiesFrom)

  // Session route confirms the slide window and returns the same CSRF pair.
  const session = await request(url, '/api/auth/session', { headers: { Cookie: sessionCookie } })
  assert.equal(session.status, 200)
  assert.equal((await session.json()).csrfToken, csrfToken)

  // Reads work with just the session cookie plus workspace identity.
  const read = await request(url, '/api/workspace/file?path=note.md', {
    headers: { Cookie: sessionCookie, ...identityHeaders },
  })
  assert.equal(read.status, 200)

  // Writes demand the CSRF token.
  const noCsrf = await request(url, '/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({ name: 'a.md', type: 'file' }),
  })
  assert.equal(noCsrf.status, 403)
  assert.equal((await noCsrf.json()).code, 'CSRF_FAILED')
  const staleCsrf = await request(url, '/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie, 'X-CSRF-Token': `${csrfToken.slice(0, 46)}00` },
    body: JSON.stringify({ name: 'a.md', type: 'file' }),
  })
  assert.equal(staleCsrf.status, 403)

  const created = await request(url, '/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie, 'X-CSRF-Token': csrfToken, ...identityHeaders },
    body: JSON.stringify({ name: 'created.md', type: 'file' }),
  })
  const createdPayload = await created.text()
  if (created.status !== 200) console.error('CREATED_DEBUG', created.status, createdPayload)
  assert.equal(created.status, 200, createdPayload)

  const logout = await request(url, '/api/auth/logout', {
    method: 'POST',
    headers: { Cookie: sessionCookie },
  })
  assert.equal(logout.status, 200)
  assert.ok((logout.headers.getSetCookie() || []).some(value => value === CLEAR_SESSION_COOKIE))

  const afterLogout = await request(url, '/api/workspace/file?path=note.md', { headers: { Cookie: sessionCookie } })
  assert.equal(afterLogout.status, 401)
})

test('login failures trigger the per-address rate limit', async t => {
  const { url } = await makeBackend(t, { name: 'rate' }, { EDITOR_PASSWORD: 'target-password' })
  for (let index = 0; index < 5; index += 1) {
    const response = await request(url, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: `wrong-${index}` }),
    })
    assert.ok([401, 429].includes(response.status), `attempt ${index} → ${response.status}`)
  }
  const limited = await request(url, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'target-password' }),
  })
  assert.equal(limited.status, 429)
  assert.equal((await limited.json()).code, 'RATE_LIMITED')
  assert.ok(Number((limited.headers.get('Retry-After') || '0')) >= 1)
})

test('a corrupted auth file fails startup instead of running unprotected', async t => {
  const root = await temporaryDirectory(t, 'auth-corrupt')
  const workspace = path.join(root, 'notes')
  await fs.mkdir(workspace)
  const authFile = path.join(root, 'auth.json')
  await fs.writeFile(authFile, '{!!!')
  const backend = createBackend({
    env: { ...process.env, ALLOW_ANY_WORKSPACE: '1' },
    argv: [],
    workspace,
    recoveryRoot: path.join(root, 'recovery'),
    configFile: path.join(root, 'workspace.json'),
    host: '127.0.0.1',
    port: 0,
    authFile,
  })
  await assert.rejects(backend.initialize(), /** @type {(e: unknown) => boolean} */ (error) => /** @type {Error & { code?: string }} */ (error)?.code === 'AUTH_CONFIG_CORRUPT')
})
