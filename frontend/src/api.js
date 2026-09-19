import axios from 'axios'

const CONTEXT_KEY = 'editor_workspace_info'
const PATH_KEY = 'editor_workspace'

function readContext() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONTEXT_KEY) || 'null')
    if (parsed?.workspace) return parsed
  } catch {}
  const workspace = localStorage.getItem(PATH_KEY)
  return workspace ? { workspace } : null
}

let context = readContext()

export const api = axios.create()

export function getWorkspaceContext() {
  return context
}

export function setWorkspaceContext(value) {
  if (!value) {
    context = null
    localStorage.removeItem(CONTEXT_KEY)
    localStorage.removeItem(PATH_KEY)
    return null
  }
  const next = typeof value === 'string' ? { workspace: value } : {
    workspace: value.workspace || value.path || '',
    workspaceId: value.workspaceId,
    workspaceVersion: value.workspaceVersion,
  }
  if (!next.workspace) return null
  context = next
  localStorage.setItem(PATH_KEY, next.workspace)
  localStorage.setItem(CONTEXT_KEY, JSON.stringify(next))
  return next
}

function isContextFreeRequest(config) {
  const url = String(config.url || '')
  return url.includes('/api/dirs') || url.includes('/api/workspace/check') || url.includes('/api/workspace/set')
}

api.interceptors.request.use(config => {
  if (!isContextFreeRequest(config) && context?.workspaceId) {
    config.headers = config.headers || {}
    config.headers['X-Workspace-Id'] = context.workspaceId
    if (context.workspaceVersion != null) config.headers['X-Workspace-Version'] = String(context.workspaceVersion)
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
