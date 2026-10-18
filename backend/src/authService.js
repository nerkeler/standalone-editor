// @ts-check
import crypto from 'crypto'

const SCRYPT_PARAMETERS = { N: 16384, r: 8, p: 1 }
const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SESSIONS = 64

/**
 * DomainError with a stable machine-readable code.
 * @typedef {import('./errors.js').DomainError} DomainError
 */

/**
 * @param {string} message
 * @param {string} code
 * @returns {DomainError}
 */
function authError(message, code) {
  return /** @type {DomainError} */ (Object.assign(new Error(message), { code }))
}

/**
 * The on-disk record for the single access password. The plaintext password is
 * never stored; only its salted scrypt digest is kept.
 * @typedef {{
 *   version: 1,
 *   scrypt: { N: number, r: number, p: number },
 *   salt: string,
 *   hash: string,
 * }} PasswordRecord
 */

/**
 * Derive and serialize the password record.
 * @param {string} password
 * @returns {Promise<PasswordRecord>}
 */
export async function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  return {
    version: 1,
    scrypt: { ...SCRYPT_PARAMETERS },
    salt,
    hash: await scryptHex(password, salt, SCRYPT_PARAMETERS),
  }
}

/**
 * Timing-safe verification of a candidate password against a stored record.
 * @param {string} candidate
 * @param {PasswordRecord} record
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(candidate, record) {
  const parameters = record?.scrypt || SCRYPT_PARAMETERS
  const { N, r, p } = parameters
  if (
    !Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) ||
    N < 16384 || N > 2 ** 21 || r < 8 || r > 32 || p < 1 || p > 8 ||
    typeof record?.salt !== 'string' || typeof record?.hash !== 'string'
  ) return false
  let digest
  try {
    digest = await scryptHex(candidate, record.salt, { N, r, p })
  } catch {
    return false
  }
  const stored = Buffer.from(record.hash, 'hex')
  const provided = Buffer.from(digest, 'hex')
  if (stored.length !== provided.length) return false
  return crypto.timingSafeEqual(stored, provided)
}

/**
 * @param {string} password
 * @param {string} saltHex
 * @param {{ N: number, r: number, p: number }} parameters
 */
async function scryptHex(password, saltHex, parameters) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, Buffer.from(saltHex, 'hex'), 64, parameters, (error, derived) => {
      if (error) reject(/** @type {Error} */ (error))
      else resolve(derived.toString('hex'))
    })
  })
}

/**
 * Parse and validate a persisted auth file. Returns null when absent.
 * @param {string} content
 * @returns {PasswordRecord | null}
 */
export function parsePasswordFile(content) {
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw authError('认证配置文件无法解析，请删除后重新设置密码', 'AUTH_CONFIG_CORRUPT')
  }
  if (parsed?.version !== 1 || typeof parsed?.salt !== 'string' || typeof parsed?.hash !== 'string') {
    throw authError('认证配置文件格式无效，请删除后重新设置密码', 'AUTH_CONFIG_CORRUPT')
  }
  return parsed
}

/** In-memory sliding session store. Restarting the process signs everyone out. */
export function createSessionStore({ idleMs = SESSION_IDLE_MS, maxSessions = MAX_SESSIONS } = {}) {
  /** @type {Map<string, { csrfToken: string, expiresAt: number }>} */
  const sessions = new Map()

  /** @returns {{ token: string, csrfToken: string, expiresAt: number }} */
  function issue(now = Date.now()) {
    pruneExpired(now)
    if (sessions.size >= maxSessions) {
      // Refuse new sign-ins at a hard ceiling instead of silently evicting
      // someone else's session.
      throw authError('会话数量已达上限，请稍后重试', 'SESSION_LIMIT')
    }
    const token = crypto.randomBytes(32).toString('hex')
    const csrfToken = crypto.randomBytes(24).toString('hex')
    sessions.set(token, { csrfToken, expiresAt: now + idleMs })
    return { token, csrfToken, expiresAt: now + idleMs }
  }

  /**
   * Validate a session token and slide its expiry forward. A mismatching CSRF
   * token invalidates the session entirely.
   * @param {string} token
   * @param {{ now?: number }} [options]
   * @returns {{ csrfToken: string, expiresAt: number } | null}
   */
  function verify(token, { now = Date.now() } = {}) {
    if (typeof token !== 'string') return null
    const stored = sessions.get(token)
    if (!stored) return null
    if (now >= stored.expiresAt) {
      sessions.delete(token)
      return null
    }
    stored.expiresAt = now + idleMs
    return { csrfToken: stored.csrfToken, expiresAt: stored.expiresAt }
  }

  /** @param {string | undefined} token */
  function revoke(token) {
    if (token) sessions.delete(token)
  }

  function pruneExpired(now = Date.now()) {
    for (const [token, stored] of sessions) {
      if (now >= stored.expiresAt) sessions.delete(token)
    }
  }

  function size() {
    return sessions.size
  }

  return { issue, verify, revoke, pruneExpired, size }
}

/**
 * Per-IP login throttling: `maxFailures` misses within `windowMs` block the
 * address for an exponentially growing cool-down measured from the last miss.
 * @param {{ maxFailures?: number, windowMs?: number }} [options]
 */
export function createLoginRateLimiter({ maxFailures = 5, windowMs = 60_000 } = {}) {
  /** @type {Map<string, { misses: number[], blockedUntil: number }>} */
  const entries = new Map()

  /**
   * @param {string} key
   * @param {{ now?: number }} [options]
   * @returns {number} remaining seconds until unblocked; 0 when allowed or key empty
   */
  function blockRemaining(key, { now = Date.now() } = {}) {
    if (!key) return 0
    const entry = entries.get(key)
    if (!entry) return 0
    return entry.blockedUntil > now ? Math.ceil((entry.blockedUntil - now) / 1000) : 0
  }

  /**
   * @param {string} key
   * @param {{ now?: number }} [options]
   */
  function recordFailure(key, { now = Date.now() } = {}) {
    if (!key) return 0
    const entry = entries.get(key) || { misses: [], blockedUntil: 0 }
    // A finished block period starts a fresh counting window.
    if (entry.blockedUntil && now >= entry.blockedUntil) {
      entry.misses = []
      entry.blockedUntil = 0
    }
    entry.misses = entry.misses.filter(timestamp => now - timestamp < windowMs)
    entry.misses.push(now)
    entries.set(key, entry)
    if (entry.misses.length >= maxFailures) {
      const factor = 2 ** Math.min(entry.misses.length - maxFailures, 6)
      entry.blockedUntil = now + windowMs * factor
    }
    return blockRemaining(key, { now })
  }

  /** @param {string} key */
  function reset(key) {
    if (key) entries.delete(key)
  }

  return { blockRemaining, recordFailure, reset }
}

/**
 * Parse the `Cookie` header into a lookup object.
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookieHeader(header) {
  /** @type {Record<string, string>} */
  const cookies = {}
  if (!header) return cookies
  for (const piece of header.split(';')) {
    const separator = piece.indexOf('=')
    if (separator === -1) continue
    const name = piece.slice(0, separator).trim()
    if (!name) continue
    let value = piece.slice(separator + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1)
    }
    // Percent-decoding is intentionally skipped: session tokens are hex and
    // other values never need to round-trip through this parser.
    if (!(name in cookies)) cookies[name] = value
  }
  return cookies
}

/**
 * Serialize a session cookie. `secure` is set by the runtime when the request
 * arrived over a TLS connection (directly or via a trusted proxy).
 * @param {string} name
 * @param {string} value
 * @param {{ maxAgeSeconds?: number, secure?: boolean }} [options]
 */
export function serializeSessionCookie(name, value, { maxAgeSeconds, secure = false } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Lax', 'HttpOnly']
  if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`)
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** A null cookie value expires it unconditionally. */
export const CLEAR_SESSION_COOKIE = 'editor_session=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0'
