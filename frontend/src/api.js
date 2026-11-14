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
  return config
})

api.interceptors.response.use(response => {
  const workspaceId = response.headers?.['x-workspace-id']
  const version = response.headers?.['x-workspace-version']
  if (workspaceId && context?.workspace === response.data?.workspace) {
    setWorkspaceContext({ ...context, workspaceId, workspaceVersion: Number(version) || context.workspaceVersion })
  }
  return response
})

export default api
