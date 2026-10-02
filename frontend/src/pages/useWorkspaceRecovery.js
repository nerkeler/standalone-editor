import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createWorkspaceRecoveryCoordinator,
  createWorkspaceRecoveryState,
  sameWorkspaceRecoveryContext,
} from './workspaceRecoveryCoordinator.js'

export default function useWorkspaceRecovery({ api, workspaceKey, workspaceInfo }) {
  const [state, setState] = useState(null)
  const nextContext = {
    workspaceKey,
    workspaceId: workspaceInfo?.workspaceId || '',
    workspaceVersion: workspaceInfo?.workspaceVersion ?? null,
  }
  const contextRef = useRef({ ...nextContext, workspaceEpoch: 0 })
  if (
    contextRef.current.workspaceKey !== nextContext.workspaceKey ||
    contextRef.current.workspaceId !== nextContext.workspaceId ||
    contextRef.current.workspaceVersion !== nextContext.workspaceVersion
  ) {
    contextRef.current = {
      ...nextContext,
      workspaceEpoch: contextRef.current.workspaceEpoch + 1,
    }
  }

  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      contextRef.current = {
        ...contextRef.current,
        workspaceEpoch: contextRef.current.workspaceEpoch + 1,
      }
    }
  }, [])

  const apiRef = useRef(api)
  apiRef.current = api
  const apiFacadeRef = useRef(null)
  if (!apiFacadeRef.current) {
    apiFacadeRef.current = {
      get: (...args) => apiRef.current.get(...args),
      post: (...args) => apiRef.current.post(...args),
      delete: (...args) => apiRef.current.delete(...args),
    }
  }

  const coordinatorRef = useRef(null)
  if (!coordinatorRef.current) {
    coordinatorRef.current = createWorkspaceRecoveryCoordinator({
      api: apiFacadeRef.current,
      getWorkspaceContext: () => ({ ...contextRef.current, active: mountedRef.current }),
      onStateChange: setState,
    })
  }
  const coordinator = coordinatorRef.current
  const currentContext = contextRef.current
  const visibleState = sameWorkspaceRecoveryContext(state, currentContext)
    ? state
    : createWorkspaceRecoveryState(currentContext)

  const createIntent = useCallback((action, payload) => (
    coordinator.createIntent(action, payload)
  ), [coordinator])
  const isIntentCurrent = useCallback(intent => coordinator.isIntentCurrent(intent), [coordinator])
  const runIntent = useCallback(intent => coordinator.runIntent(intent), [coordinator])
  const refresh = useCallback(() => {
    const intent = coordinator.createIntent('refresh')
    return coordinator.runIntent(intent)
  }, [coordinator])

  return {
    ...visibleState,
    createIntent,
    isIntentCurrent,
    runIntent,
    refresh,
  }
}
