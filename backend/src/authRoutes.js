// @ts-check
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { makeError } from './errors.js'
import {
  CLEAR_SESSION_COOKIE,
  createLoginRateLimiter,
  createPasswordRecord,
  createSessionStore,
  parseCookieHeader,
  parsePasswordFile,
  serializeSessionCookie,
  verifyPassword,
} from './authService.js'

const SESSION_COOKIE = 'editor_session'
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/** @typedef {import('./authService.js').PasswordRecord} PasswordRecord */
/** @typedef {ReturnType<typeof createSessionStore>} SessionStore */
/** @typedef {ReturnType<typeof createLoginRateLimiter>} RateLimiter */

/**
 * Load the configured password record, keeping the plaintext out of memory.
 * An explicit password parameter always wins and is (re)persisted, so a later
 * run without the environment variable still accepts the terminal-set value.
 *
 * @param {string} authFile
 * @param {{ password?: string }} [options]
 * @returns {Promise<{ record: PasswordRecord | null, enabled: boolean }>}
 */
export async function loadPasswordRecord(authFile, { password } = {}) {
  let fileContent = null
  try {
    fileContent = await fs.readFile(authFile, 'utf-8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw makeError(`无法读取认证配置：${error?.message || '未知错误'}`, 'AUTH_CONFIG_UNAVAILABLE')
    }
  }
  if (typeof password === 'string' && password.length > 0) {
    const record = await createPasswordRecord(password)
    await fs.mkdir(path.dirname(path.resolve(authFile)), { recursive: true })
    const temporary = `${authFile}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 })
      await fs.chmod(temporary, 0o600)
      await fs.rename(temporary, authFile)
    } catch (error) {
      await fs.unlink(temporary).catch(() => {})
      throw makeError(`无法保存认证配置：${error?.message || '未知错误'}`, 'AUTH_CONFIG_SAVE_FAILED')
    }
    return { record, enabled: true }
  }
  return { record: fileContent ? parsePasswordFile(fileContent) : null, enabled: Boolean(fileContent) }
}

/**
 * @param {import('express').Express} app
 * @param {{
 *   state: { record: PasswordRecord | null, enabled: boolean },
 *   sendError: (res: import('express').Response, error: unknown, req?: import('express').Request) => void,
 *   secure: (req: unknown) => boolean,
 *   sessions?: SessionStore,
 *   rateLimiter?: RateLimiter,
 * }} deps
 */
export function registerAuthRoutes(app, deps) {
  const { sendError, secure } = deps
  /** Populated by the caller once startup config loading resolves. */
  const state = deps.state
  void state
  const sessions = deps.sessions || createSessionStore()
  const rateLimiter = deps.rateLimiter || createLoginRateLimiter()

  function sessionCookie(value, maxAgeSeconds, req) {
    return serializeSessionCookie(SESSION_COOKIE, value, { maxAgeSeconds, secure: Boolean(secure(req)) })
  }

  function clientKey(req) {
    return String(req.socket?.remoteAddress || req.ip || 'unknown')
  }

  function rateLimited(res, seconds) {
    res.set('Retry-After', String(seconds))
    return res.status(429).json({
      error: `尝试次数过多，请 ${seconds} 秒后再试`,
      code: 'RATE_LIMITED',
      retryAfterSeconds: seconds,
    })
  }

  app.post('/api/auth/login', async (req, res) => {
    if (!state?.enabled || !state?.record) {
      return res.status(400).json({ error: '当前服务未启用密码登录', code: 'AUTH_NOT_ENABLED' })
    }
    const now = Date.now()
    const key = clientKey(req)
    const preBlocked = rateLimiter.blockRemaining(key, { now })
    if (preBlocked > 0) return rateLimited(res, preBlocked)
    const password = req.body?.password
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: '缺少密码', code: 'AUTH_FAILED' })
    }
    const verified = await verifyPassword(password, state.record).catch(error => {
      throw makeError(`密码校验失败：${error?.message || '未知错误'}`, 'AUTH_CONFIG_CORRUPT')
    })
    if (!verified) {
      const cooldown = rateLimiter.recordFailure(key, { now })
      if (cooldown > 0) return rateLimited(res, cooldown)
      return res.status(401).json({ error: '密码不正确', code: 'AUTH_FAILED' })
    }
    rateLimiter.reset(key)
    let session
    try {
      session = sessions.issue(now)
    } catch (error) {
      return sendError(res, error, req)
    }
    res.setHeader('Set-Cookie', sessionCookie(session.token, Math.floor((session.expiresAt - now) / 1000), req))
    return res.json({ success: true, csrfToken: session.csrfToken })
  })

  app.post('/api/auth/logout', (req, res) => {
    const cookies = parseCookieHeader(req.get('cookie'))
    sessions.revoke(cookies[SESSION_COOKIE])
    res.setHeader('Set-Cookie', CLEAR_SESSION_COOKIE)
    return res.json({ success: true })
  })

  app.get('/api/auth/session', (req, res) => {
    // Probing when auth is off answers 200 with enabled=false so the client can
    // distinguish an unauthenticated window from a service without protection.
    if (!state?.enabled) return res.json({ success: false, enabled: false })
    const cookies = parseCookieHeader(req.get('cookie'))
    const verified = sessions.verify(cookies[SESSION_COOKIE])
    if (!verified) return res.status(401).json({ error: '需要登录', code: 'AUTH_REQUIRED' })
    return res.json({ success: true, enabled: true, csrfToken: verified.csrfToken })
  })

  /**
   * Gate every other API route. Static assets stay public (only the SPA shell
   * and bundled JS are exposed); auth paths self-exempt. Every mutating call
   * must present the per-session CSRF token.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  function authGuard(req, res, next) {
    if (req.method === 'OPTIONS') return next()
    const pathName = req.path.split('?')[0]
    if (pathName === '/api/auth/session' || pathName === '/api/auth/login' || pathName === '/api/auth/logout') return next()
    if (!pathName.startsWith('/api/')) return next()
    if (!state?.enabled) return next()
    const cookies = parseCookieHeader(req.get('cookie'))
    const token = cookies[SESSION_COOKIE]
    const verified = sessions.verify(token)
    if (!verified) {
      res.setHeader('Set-Cookie', CLEAR_SESSION_COOKIE)
      return res.status(401).json({
        error: '需要登录后才能继续',
        code: 'AUTH_REQUIRED',
      })
    }
    const safeMethod = req.method === 'GET' || req.method === 'HEAD'
    if (!safeMethod && req.get('X-CSRF-Token') !== verified.csrfToken) {
      return res.status(403).json({ error: '会话校验失败，请刷新页面后重试', code: 'CSRF_FAILED' })
    }
    req.sessionToken = token
    req.csrfToken = verified.csrfToken
    next()
  }

  // Whether auth is active is only known after initializeBackend fills the
  // state; the caller decides when to print the startup notice.

  return { authGuard, sessions, rateLimiter }
}
