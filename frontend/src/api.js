import axios from 'axios'
import { readJsonStorage, readStorage, removeStorage, writeStorage } from './safeStorage.js'

const CONTEXT_KEY = 'editor_workspace_info'
const PATH_KEY = 'editor_workspace'

function readContext() {
  const cached = readJsonStorage(CONTEXT_KEY)
  if (cached.ok && typeof cached.value?.workspace === 'string' && cached.value.workspace) {
    return cached.value
  }
  const legacy = readStorage(PATH_KEY)
  return legacy.ok && typeof legacy.value === 'string' && legacy.value
    ? { workspace: legacy.value }
    : null
}

let context = readContext()

// Per-session CSRF token issued by /api/auth/login. The backend compares it
// against the session cookie for every mutating request.
let csrfToken = null

const authRequiredListeners = new Set()

export function subscribeAuthRequired(listener) {
  authRequiredListeners.add(listener)
  return () => authRequiredListeners.delete(listener)
}

export function getSessionCsrfToken() {
  return csrfToken
}

export function setSessionCsrfToken(token) {
  csrfToken = typeof token === 'string' && token ? token : null
}

export function isSessionAuthenticated() {
  return Boolean(csrfToken)
}

export const api = axios.create()

export function getWorkspaceContext() {
  return context
}

export function setWorkspaceContext(value) {
  if (!value) {
    context = null
    removeStorage(CONTEXT_KEY)
    removeStorage(PATH_KEY)
    return null
  }
  const next = typeof value === 'string' ? { workspace: value } : {
    workspace: value.workspace || value.path || '',
    workspaceId: value.workspaceId,
    workspaceVersion: value.workspaceVersion,
  }
  if (!next.workspace) return null
  context = next
  writeStorage(PATH_KEY, next.workspace)
  writeStorage(CONTEXT_KEY, JSON.stringify(next))
  return next
}

function isContextFreeRequest(config) {
  const url = String(config.url || '')
  return url.includes('/api/dirs') || url.includes('/api/workspace/check') || url.includes('/api/workspace/set')
}

function hasHeader(headers, name) {
  if (typeof headers?.has === 'function') return headers.has(name)
  const normalizedName = name.toLowerCase()
  return Object.keys(headers || {}).some(key => key.toLowerCase() === normalizedName)
}

api.interceptors.request.use(config => {
  if (!isContextFreeRequest(config) && context?.workspaceId) {
    config.headers = config.headers || {}
    // Preserve identity explicitly bound to an operation, such as a delayed
    // confirmation. The backend can then reject it with 409 after a workspace
    // switch instead of redirecting that operation to the newly selected path.
    if (!hasHeader(config.headers, 'X-Workspace-Id')) {
      config.headers['X-Workspace-Id'] = context.workspaceId
    }
    if (context.workspaceVersion != null && !hasHeader(config.headers, 'X-Workspace-Version')) {
      config.headers['X-Workspace-Version'] = String(context.workspaceVersion)
    }
  }
  // The session cookie travels with every same-origin request automatically;
  // mutating calls additionally present the CSRF token issued at login.
  if (csrfToken && config.method?.toLowerCase() !== 'get' && config.method?.toLowerCase() !== 'head') {
    config.headers = config.headers || {}
    if (!hasHeader(config.headers, 'X-CSRF-Token')) {
      config.headers['X-CSRF-Token'] = csrfToken
    }
  }
  return config
})

api.interceptors.response.use(response => {
  const workspaceId = response.headers?.['x-workspace-id']
  const version = response.headers?.['x-workspace-version']
  if (workspaceId && context?.workspace === response.data?.workspace) {
    setWorkspaceContext({ ...context, workspaceId, workspaceVersion: Number(version) || context.workspaceVersion })
  }
  return response
}, error => {
  const status = error?.response?.status
  const actionCode = error?.response?.data?.code || error?.code
  if (status === 401 && actionCode === 'AUTH_REQUIRED') {
    csrfToken = null
    for (const listener of authRequiredListeners) {
      try { listener() } catch {} 
    }
  }
  throw error
})

// ---------- 认证会话 ----------

/** Returns `{ enabled: true, authenticated: boolean }` or `{ enabled: false }` when auth is off. */
export async function probeSession(timeout = 10_000) {
  const response = await api.get('/api/auth/session', { timeout })
  const body = response.data || {}
  if (body.enabled === false) return { enabled: false }
  if (body.success && body.csrfToken) {
    setSessionCsrfToken(body.csrfToken)
    return { enabled: true, authenticated: true }
  }
  return { enabled: true, authenticated: false }
}

export async function loginWithPassword(password, timeout = 20_000) {
  const response = await api.post('/api/auth/login', { password }, { timeout })
  const body = response.data || {}
  setSessionCsrfToken(body.csrfToken)
  return body
}

export async function logoutSession(timeout = 10_000) {
  try {
    await api.post('/api/auth/logout', {}, { timeout })
  } finally {
    setSessionCsrfToken(null)
  }
}

export function describeAuthError(error) {
  const payload = error?.response?.data || {}
  if (payload.code === 'AUTH_NOT_ENABLED') return '当前服务未启用密码登录。请通过后端命令设置访问密码，或重启服务。'
  if (payload.code === 'RATE_LIMITED') {
    return `尝试次数过多：请 ${payload.retryAfterSeconds || 60} 秒后再试。`
  }
  return payload.error || error?.message || '登录失败'
}

export function authCooldownSeconds(error) {
  return error?.response?.data?.retryAfterSeconds || 0
}

export default api
