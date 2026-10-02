const API = '/api/workspace'
const ACTIONS = new Set(['refresh', 'restore-trash', 'purge-expired', 'delete-trash'])

export function createWorkspaceRecoveryState(context) {
  return {
    workspaceKey: context.workspaceKey,
    workspaceId: context.workspaceId,
    workspaceVersion: context.workspaceVersion,
    workspaceEpoch: context.workspaceEpoch,
    trashItems: [],
    trashLoading: false,
    trashError: null,
    stats: null,
    statsLoading: false,
    statsError: null,
    mutationBusy: false,
  }
}

function normalizeContext(context) {
  return {
    workspaceKey: typeof context?.workspaceKey === 'string' ? context.workspaceKey : '',
    workspaceId: typeof context?.workspaceId === 'string' ? context.workspaceId : '',
    workspaceVersion: context?.workspaceVersion ?? null,
    workspaceEpoch: Number.isSafeInteger(context?.workspaceEpoch) ? context.workspaceEpoch : 0,
    active: context?.active !== false,
  }
}

function sameContext(left, right) {
  return left?.workspaceKey === right?.workspaceKey
    && left?.workspaceId === right?.workspaceId
    && left?.workspaceVersion === right?.workspaceVersion
    && left?.workspaceEpoch === right?.workspaceEpoch
}

function contextForIntent(intent) {
  return normalizeContext(intent)
}

function responseData(response) {
  return response?.data ?? response
}

function requestConfig(context) {
  return {
    headers: {
      'X-Workspace-Id': context.workspaceId,
      'X-Workspace-Version': String(context.workspaceVersion),
    },
  }
}

function failed(reason, extra = {}) {
  return { ok: false, reason, committed: false, ...extra }
}

export function createWorkspaceRecoveryCoordinator({ api, getWorkspaceContext, onStateChange }) {
  if (!api || typeof getWorkspaceContext !== 'function' || typeof onStateChange !== 'function') {
    throw new TypeError('Recovery coordinator requires api, getWorkspaceContext, and onStateChange')
  }

  const intents = new WeakSet()
  const requestSequence = { trash: 0, stats: 0 }
  const activeMutations = new Set()

  function currentContext() {
    return normalizeContext(getWorkspaceContext())
  }

  function isCurrent(context) {
    const current = currentContext()
    return context.active
      && current.active
      && context.workspaceKey.length > 0
      && context.workspaceId.length > 0
      && context.workspaceVersion != null
      && sameContext(context, current)
  }

  function contextToken(context) {
    return JSON.stringify([context.workspaceKey, context.workspaceEpoch])
  }

  function isIntentCurrent(intent) {
    return Boolean(intent && intents.has(intent) && isCurrent(contextForIntent(intent)))
  }

  function updateState(context, update) {
    if (!isCurrent(context)) return false
    onStateChange(previous => {
      // Recheck when React applies the queued state update; a workspace switch
      // can happen after this request resolves but before the render commits.
      if (!isCurrent(context)) return previous
      const current = sameContext(previous, context)
        ? previous
        : createWorkspaceRecoveryState(context)
      return typeof update === 'function' ? update(current) : { ...current, ...update }
    })
    return true
  }

  function createIntent(action, payload = {}) {
    if (!ACTIONS.has(action)) return null
    const context = currentContext()
    if (!context.active || !context.workspaceKey || !context.workspaceId || context.workspaceVersion == null
      || !payload || typeof payload !== 'object') return null
    if ((action === 'restore-trash' || action === 'delete-trash') && !payload.id) return null
    const intent = Object.freeze({
      ...payload,
      action,
      workspaceKey: context.workspaceKey,
      workspaceId: context.workspaceId,
      workspaceVersion: context.workspaceVersion,
      workspaceEpoch: context.workspaceEpoch,
    })
    intents.add(intent)
    return intent
  }

  async function loadTrash(context) {
    if (!isCurrent(context)) return failed('stale-workspace')
    const requestId = ++requestSequence.trash
    updateState(context, state => ({ ...state, trashLoading: true, trashError: null }))
    try {
      const response = await api.get(`${API}/trash`, requestConfig(context))
      if (!isCurrent(context)) return failed('stale-workspace')
      if (requestSequence.trash !== requestId) return failed('superseded')
      const items = Array.isArray(response?.data?.items) ? response.data.items : []
      updateState(context, state => ({ ...state, trashItems: items }))
      return { ok: true, data: items }
    } catch (error) {
      if (!isCurrent(context)) return failed('stale-workspace', { error })
      if (requestSequence.trash !== requestId) return failed('superseded', { error })
      updateState(context, state => ({ ...state, trashError: error }))
      return failed('request-failed', { error })
    } finally {
      if (isCurrent(context) && requestSequence.trash === requestId) {
        updateState(context, state => ({ ...state, trashLoading: false }))
      }
    }
  }

  async function loadStats(context) {
    if (!isCurrent(context)) return failed('stale-workspace')
    const requestId = ++requestSequence.stats
    updateState(context, state => ({ ...state, statsLoading: true, statsError: null }))
    try {
      const response = await api.get(`${API}/recovery/stats`, requestConfig(context))
      if (!isCurrent(context)) return failed('stale-workspace')
      if (requestSequence.stats !== requestId) return failed('superseded')
      updateState(context, state => ({ ...state, stats: responseData(response) }))
      return { ok: true, data: responseData(response) }
    } catch (error) {
      if (!isCurrent(context)) return failed('stale-workspace', { error })
      if (requestSequence.stats !== requestId) return failed('superseded', { error })
      updateState(context, state => ({ ...state, stats: null, statsError: error }))
      return failed('request-failed', { error })
    } finally {
      if (isCurrent(context) && requestSequence.stats === requestId) {
        updateState(context, state => ({ ...state, statsLoading: false }))
      }
    }
  }

  async function refresh(context) {
    if (!isCurrent(context)) return failed('stale-workspace')
    const [trash, stats] = await Promise.all([loadTrash(context), loadStats(context)])
    const current = isCurrent(context)
    return {
      ok: current && trash.ok && stats.ok,
      reason: current ? (trash.ok && stats.ok ? null : 'partial-failure') : 'stale-workspace',
      currentWorkspace: current,
      trash,
      stats,
    }
  }

  async function runIntent(intent) {
    if (!intent || typeof intent !== 'object' || !intents.has(intent)) {
      return failed('invalid-intent')
    }
    const context = contextForIntent(intent)
    if (!isIntentCurrent(intent)) return failed('stale-workspace')
    if (intent.action === 'refresh') return refresh(context)

    const token = contextToken(context)
    if (activeMutations.has(token)) return failed('busy')
    activeMutations.add(token)
    updateState(context, state => ({ ...state, mutationBusy: true }))

    try {
      let response
      if (intent.action === 'restore-trash') {
        response = await api.post(`${API}/trash/restore`, { id: intent.id }, requestConfig(context))
      } else if (intent.action === 'purge-expired') {
        response = await api.post(`${API}/trash/purge-expired`, undefined, requestConfig(context))
      } else if (intent.action === 'delete-trash') {
        response = await api.delete(`${API}/trash`, {
          params: { id: intent.id },
          ...requestConfig(context),
        })
      } else {
        return failed('invalid-intent')
      }

      const data = responseData(response)
      if (!isCurrent(context)) {
        return { ok: true, reason: 'workspace-changed', committed: true, currentWorkspace: false, data }
      }
      const refreshResult = await refresh(context)
      const currentWorkspace = isCurrent(context)
      return {
        ok: true,
        reason: currentWorkspace ? null : 'workspace-changed',
        committed: true,
        currentWorkspace,
        data,
        refresh: refreshResult,
      }
    } catch (error) {
      if (!isCurrent(context)) {
        return { ok: false, reason: 'workspace-changed', committed: false, currentWorkspace: false, error }
      }
      // A failed mutation may still have changed server state (for example, a
      // response can be lost after the write). Refresh only while this intent's
      // workspace remains current, and never let refresh failure replace the
      // mutation error shown to the caller.
      let refreshResult
      try {
        refreshResult = await refresh(context)
      } catch (refreshError) {
        refreshResult = failed('refresh-failed', { error: refreshError })
      }
      const currentWorkspace = isCurrent(context)
      if (!currentWorkspace) {
        return {
          ok: false,
          reason: 'workspace-changed',
          committed: false,
          currentWorkspace: false,
          error,
          refresh: refreshResult,
        }
      }
      return failed('request-failed', { error, currentWorkspace: true, refresh: refreshResult })
    } finally {
      activeMutations.delete(token)
      updateState(context, state => ({ ...state, mutationBusy: false }))
    }
  }

  return { createIntent, isIntentCurrent, runIntent }
}

export function sameWorkspaceRecoveryContext(left, right) {
  return sameContext(left, right)
}
