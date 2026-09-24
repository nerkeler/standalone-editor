import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

const API = '/api/workspace'
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif']
const DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const DRAFT_SNAPSHOT_INTERVAL_MS = 500

export function isImageFile(name) {
  return IMAGE_EXTS.includes(name.split('.').pop()?.toLowerCase() || '')
}

function remapPath(pathValue, oldPath, newPath) {
  if (pathValue === oldPath) return newPath
  if (pathValue.startsWith(`${oldPath}/`)) return `${newPath}${pathValue.slice(oldPath.length)}`
  return pathValue
}

/** Owns each open document's Markdown draft and its serialized save queue. */
function normalizeDraftSnapshot(value, savedAt) {
  if (typeof value === 'string') return { content: value, baseRevision: null, savedAt: savedAt || 0 }
  if (!value || typeof value.content !== 'string') return null
  return {
    content: value.content,
    baseRevision: typeof value.baseRevision === 'string' ? value.baseRevision : null,
    savedAt: Number(value.savedAt) || savedAt || 0,
  }
}

function isFileConflict(error) {
  return error?.response?.status === 409 && (
    error?.response?.data?.error === 'FILE_CONFLICT' ||
    error?.response?.data?.code === 'FILE_CONFLICT'
  )
}

function getTabSessionId() {
  const key = 'editor_draft_tab_session'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const created = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessionStorage.setItem(key, created)
    return created
  } catch {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

function createTabSessionId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Owns each open document's Markdown draft and its serialized save queue. */
export default function useEditorDrafts(workspace, activeFileRef, workspaceId) {
  const [savedContents, setSavedContents] = useState({})
  const [isDirty, setIsDirty] = useState({})
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveErrors, setSaveErrors] = useState({})
  const [fileRevisions, setFileRevisions] = useState({})
  const [fileConflicts, setFileConflicts] = useState({})
  const [recoveryAlternatives, setRecoveryAlternatives] = useState({})
  const [draftStorageError, setDraftStorageError] = useState('')
  const [tabSessionId, setTabSessionId] = useState(getTabSessionId)
  const [sessionIdentityReady, setSessionIdentityReady] = useState(false)

  const draftContentsRef = useRef({})
  const dirtyRef = useRef({})
  const saveTimersRef = useRef(new Map())
  const saveQueuesRef = useRef(new Map())
  const saveErrorsRef = useRef(saveErrors)
  const cleanContentsRef = useRef({})
  const fileRevisionsRef = useRef({})
  const conflictsRef = useRef({})
  const restoredDraftsRef = useRef({})
  const snapshotTimerRef = useRef(null)
  const lastSnapshotWriteRef = useRef(0)
  const presenceChannelRef = useRef(null)
  const presenceProbesRef = useRef(new Map())
  const workspaceIdentityRef = useRef(workspace || workspaceId || '')
  const draftWorkspaceIdentity = workspace || workspaceId || ''
  const draftRestoreRef = useRef(null)
  if (!draftRestoreRef.current || draftRestoreRef.current.identity !== draftWorkspaceIdentity) {
    draftRestoreRef.current?.resolve()
    let resolve
    const promise = new Promise(complete => { resolve = complete })
    draftRestoreRef.current = { identity: draftWorkspaceIdentity, ready: false, promise, resolve }
  }
  const waitForDraftRestore = useCallback(async () => {
    while (true) {
      const pending = draftRestoreRef.current
      if (!pending || pending.ready) return
      await pending.promise
      if (draftRestoreRef.current === pending && pending.ready) return
    }
  }, [])

  useEffect(() => { saveErrorsRef.current = saveErrors }, [saveErrors])

  const workspaceStoragePrefix = `editor_pending_drafts:${encodeURIComponent(draftWorkspaceIdentity)}:`
  const pendingDraftKey = `${workspaceStoragePrefix}${encodeURIComponent(tabSessionId)}`
  const legacyPendingDraftKey = `editor_pending_drafts:${encodeURIComponent(draftWorkspaceIdentity)}`
  const readDraftStore = useCallback(key => {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null')
      if (!parsed || typeof parsed.drafts !== 'object' || Array.isArray(parsed.drafts)) return {}
      const savedAt = Number(parsed.savedAt) || 0
      // A draft left by a crashed/closed tab should not shadow a file forever.
      if (savedAt && Date.now() - savedAt > DRAFT_RETENTION_MS) {
        // Expired entries are the one case where stale storage can be pruned
        // without coordinating with another live window.
        localStorage.removeItem(key)
        return {}
      }
      return Object.fromEntries(Object.entries(parsed.drafts).flatMap(([path, value]) => {
        const snapshot = normalizeDraftSnapshot(value, savedAt)
        if (!snapshot || (snapshot.savedAt && Date.now() - snapshot.savedAt > DRAFT_RETENTION_MS)) return []
        return [[path, snapshot]]
      }))
    } catch (error) {
      setDraftStorageError(error?.name === 'SecurityError'
        ? '浏览器禁止访问本地恢复存储'
        : '无法读取浏览器本地恢复草稿')
      return {}
    }
  }, [])

  const readPendingDrafts = useCallback(() => readDraftStore(pendingDraftKey), [pendingDraftKey, readDraftStore])

  const writePendingDrafts = useCallback(drafts => {
    try {
      if (Object.keys(drafts).length) {
        const savedAt = Date.now()
        const normalized = Object.fromEntries(Object.entries(drafts).flatMap(([path, value]) => {
          const snapshot = normalizeDraftSnapshot(value, savedAt)
          return snapshot ? [[path, { ...snapshot, savedAt }]] : []
        }))
        localStorage.setItem(pendingDraftKey, JSON.stringify({ version: 2, savedAt, drafts: normalized }))
      } else {
        localStorage.removeItem(pendingDraftKey)
      }
      setDraftStorageError('')
      lastSnapshotWriteRef.current = Date.now()
      return true
    } catch (error) {
      setDraftStorageError(error?.name === 'QuotaExceededError'
        ? '浏览器存储空间已满，最近的未保存内容可能无法恢复'
        : '无法写入浏览器本地恢复草稿；服务自动保存仍会继续')
      return false
    }
  }, [pendingDraftKey])

  const clearPendingDraft = useCallback((path, expectedContent) => {
    const drafts = readPendingDrafts()
    if (expectedContent === undefined || drafts[path]?.content === expectedContent) {
      delete drafts[path]
      writePendingDrafts(drafts)
    }
  }, [readPendingDrafts, writePendingDrafts])

  const remapPendingDrafts = useCallback((oldPath, newPath) => {
    const drafts = readPendingDrafts()
    const remapped = Object.fromEntries(Object.entries(drafts).map(([key, value]) => [remapPath(key, oldPath, newPath), value]))
    writePendingDrafts(remapped)
  }, [readPendingDrafts, writePendingDrafts])

  const removePendingDrafts = useCallback(path => {
    const drafts = readPendingDrafts()
    const remaining = Object.fromEntries(Object.entries(drafts).filter(([key]) => (
      key !== path && !key.startsWith(`${path}/`)
    )))
    writePendingDrafts(remaining)
  }, [readPendingDrafts, writePendingDrafts])

  const collectDirtyDrafts = useCallback(() => Object.fromEntries(
    Object.entries(dirtyRef.current).flatMap(([path, dirty]) => {
      const content = draftContentsRef.current[path]
      if (!dirty || content === undefined || isImageFile(path)) return []
      const restored = restoredDraftsRef.current[path]
      return [[path, {
        content,
        baseRevision: restored ? restored.baseRevision : (fileRevisionsRef.current[path] ?? null),
        savedAt: Date.now(),
      }]]
    }),
  ), [])

  const addRecoveryAlternative = useCallback((path, snapshot, sourceSession) => {
    if (!path || !snapshot) return
    setRecoveryAlternatives(previous => {
      const entries = previous[path] || []
      if (entries.some(entry => (
        entry.sourceSession === sourceSession &&
        entry.snapshot.content === snapshot.content &&
        entry.snapshot.baseRevision === snapshot.baseRevision
      ))) return previous
      return {
        ...previous,
        [path]: [...entries, {
          id: `${sourceSession}:${snapshot.savedAt}:${entries.length}`,
          sourceSession,
          snapshot,
        }].sort((left, right) => right.snapshot.savedAt - left.snapshot.savedAt),
      }
    })
  }, [])

  const restoreDraftSnapshots = useCallback((snapshots, sourceSession = '本标签页') => {
    const accepted = {}
    for (const [path, snapshot] of Object.entries(snapshots)) {
      const current = restoredDraftsRef.current[path]
      if (current && current.content !== snapshot.content) {
        addRecoveryAlternative(path, snapshot, sourceSession)
        continue
      }
      if (!current) {
        restoredDraftsRef.current[path] = snapshot
        draftContentsRef.current[path] = snapshot.content
        dirtyRef.current[path] = true
        accepted[path] = snapshot.content
      }
    }
    if (Object.keys(accepted).length) {
      setSavedContents(prev => ({ ...prev, ...accepted }))
      setIsDirty(prev => ({ ...prev, ...Object.fromEntries(Object.keys(accepted).map(path => [path, true])) }))
    }
  }, [addRecoveryAlternative])

  // Persist a throttled snapshot while typing. The first edit is written
  // promptly; continued edits schedule at most one write per interval.
  const scheduleDraftSnapshot = useCallback(() => {
    // Do not write to a possibly cloned sessionStorage identity before the
    // BroadcastChannel probe has assigned this tab a distinct snapshot key.
    if (!sessionIdentityReady) return
    if (snapshotTimerRef.current) return
    const elapsed = Date.now() - lastSnapshotWriteRef.current
    const delay = Math.max(0, DRAFT_SNAPSHOT_INTERVAL_MS - elapsed)
    snapshotTimerRef.current = setTimeout(() => {
      snapshotTimerRef.current = null
      writePendingDrafts(collectDirtyDrafts())
    }, delay)
  }, [collectDirtyDrafts, sessionIdentityReady, writePendingDrafts])

  const setFileRevision = useCallback((path, revision) => {
    if (!path || typeof revision !== 'string' || !revision) return
    fileRevisionsRef.current[path] = revision
    setFileRevisions(prev => ({ ...prev, [path]: revision }))
  }, [])

  const setFileConflict = useCallback((path, conflict) => {
    if (!path) return
    const next = { ...conflictsRef.current, [path]: conflict }
    conflictsRef.current = next
    setFileConflicts(next)
    if (activeFileRef.current === path) setSaveStatus('conflict')
  }, [activeFileRef])

  const clearFileConflict = useCallback(path => {
    if (!path) return
    const next = { ...conflictsRef.current }
    delete next[path]
    conflictsRef.current = next
    setFileConflicts(next)
  }, [])

  useEffect(() => {
    const sessionId = tabSessionId
    let channel
    try {
      channel = new BroadcastChannel('standalone-editor-draft-presence')
      channel.onmessage = event => {
        const data = event.data || {}
        if (data.workspacePrefix !== workspaceStoragePrefix) return
        if (data.type === 'probe') {
          channel.postMessage({
            type: 'present',
            workspacePrefix: workspaceStoragePrefix,
            from: sessionId,
            to: data.from,
            probeId: data.probeId,
          })
        } else if (data.type === 'present' && data.to === sessionId) {
          presenceProbesRef.current.get(data.probeId)?.add(data.from)
        }
      }
      presenceChannelRef.current = channel
    } catch {
      presenceChannelRef.current = null
    }
    return () => {
      channel?.close()
      if (presenceChannelRef.current === channel) presenceChannelRef.current = null
    }
  }, [tabSessionId, workspaceStoragePrefix])

  // Browsers can copy sessionStorage when duplicating a tab. Probe that ID
  // before reading or writing its localStorage slot; a live twin gets a fresh
  // slot and leaves the original tab's draft untouched.
  useEffect(() => {
    if (sessionIdentityReady) return undefined
    const channel = presenceChannelRef.current
    if (!channel) {
      // sessionStorage can be cloned when a tab is duplicated. Without a
      // cross-tab presence channel, use a fresh slot for this page instance
      // so two tabs can never write the same localStorage snapshot key.
      const replacement = createTabSessionId()
      try { sessionStorage.setItem('editor_draft_tab_session', replacement) } catch {}
      setTabSessionId(replacement)
      setSessionIdentityReady(true)
      return undefined
    }
    let cancelled = false
    const probeId = `same-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const responses = new Set()
    presenceProbesRef.current.set(probeId, responses)
    channel.postMessage({
      type: 'probe',
      workspacePrefix: workspaceStoragePrefix,
      from: tabSessionId,
      probeId,
    })
    const timer = setTimeout(() => {
      presenceProbesRef.current.delete(probeId)
      if (cancelled) return
      if (responses.has(tabSessionId)) {
        const replacement = createTabSessionId()
        try { sessionStorage.setItem('editor_draft_tab_session', replacement) } catch {}
        setTabSessionId(replacement)
      }
      setSessionIdentityReady(true)
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
      presenceProbesRef.current.delete(probeId)
    }
  }, [sessionIdentityReady, tabSessionId, workspaceStoragePrefix])

  useEffect(() => {
    const nextIdentity = workspace || workspaceId || ''
    if (workspaceIdentityRef.current !== nextIdentity) {
      workspaceIdentityRef.current = nextIdentity
      if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current)
      snapshotTimerRef.current = null
      draftContentsRef.current = {}
      dirtyRef.current = {}
      cleanContentsRef.current = {}
      fileRevisionsRef.current = {}
      conflictsRef.current = {}
      restoredDraftsRef.current = {}
      saveErrorsRef.current = {}
      saveTimersRef.current.forEach(timer => clearTimeout(timer))
      saveTimersRef.current.clear()
      saveQueuesRef.current.clear()
      setSavedContents({})
      setIsDirty({})
      setSaveErrors({})
      setFileRevisions({})
      setFileConflicts({})
      setRecoveryAlternatives({})
      setSaveStatus('idle')
    }
    if (!sessionIdentityReady) return undefined
    let cancelled = false
    const ownDrafts = readPendingDrafts()
    restoreDraftSnapshots(ownDrafts, tabSessionId)
    const restoreState = draftRestoreRef.current
    if (restoreState?.identity === draftWorkspaceIdentity) {
      restoreState.ready = true
      restoreState.resolve()
    }

    // The previous editor stored one workspace-wide key. Keep copying it
    // forward as a selectable recovery source instead of deleting a key that
    // an older browser tab may still be updating.
    const legacyDrafts = readDraftStore(legacyPendingDraftKey)
    for (const [path, snapshot] of Object.entries(legacyDrafts)) {
      addRecoveryAlternative(path, snapshot, '旧版恢复数据')
    }

    const recoverAbandonedSessions = async () => {
      let candidates = []
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index)
          if (key?.startsWith(workspaceStoragePrefix) && key !== pendingDraftKey) candidates.push(key)
        }
      } catch {
        return
      }
      const candidateSessions = candidates.map(key => key.slice(workspaceStoragePrefix.length))
      const channel = presenceChannelRef.current
      if (channel && candidateSessions.length) {
        const probeId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const responses = new Set()
        presenceProbesRef.current.set(probeId, responses)
        channel.postMessage({
          type: 'probe',
          workspacePrefix: workspaceStoragePrefix,
          from: tabSessionId,
          probeId,
        })
        await new Promise(resolve => setTimeout(resolve, 180))
        presenceProbesRef.current.delete(probeId)
        if (cancelled) return
        candidates = candidates.filter((_, index) => !responses.has(candidateSessions[index]))
      }

      for (const key of candidates) {
        if (cancelled) return
        try {
          const parsed = JSON.parse(localStorage.getItem(key) || 'null')
          if (!parsed || typeof parsed.drafts !== 'object') continue
          const savedAt = Number(parsed.savedAt) || 0
          if (savedAt && Date.now() - savedAt > DRAFT_RETENTION_MS) {
            localStorage.removeItem(key)
            continue
          }
          const abandoned = Object.fromEntries(Object.entries(parsed.drafts).flatMap(([path, value]) => {
            const snapshot = normalizeDraftSnapshot(value, savedAt)
            if (!snapshot || (snapshot.savedAt && Date.now() - snapshot.savedAt > DRAFT_RETENTION_MS)) return []
            return [[path, snapshot]]
          }))
          if (!Object.keys(abandoned).length) continue
          // Other session stores are read-only here. A slow or suspended
          // window may miss the presence probe, so adopting and deleting its
          // snapshot automatically could erase a live draft. Keep every
          // alternative visible until the user chooses it.
          const sourceSession = key.slice(workspaceStoragePrefix.length)
          for (const [path, snapshot] of Object.entries(abandoned)) {
            addRecoveryAlternative(path, snapshot, sourceSession)
          }
        } catch (error) {
          setDraftStorageError('无法读取其他标签页遗留的本地恢复草稿')
        }
      }
    }
    recoverAbandonedSessions()
    return () => { cancelled = true }
  }, [addRecoveryAlternative, draftWorkspaceIdentity, legacyPendingDraftKey, readDraftStore, readPendingDrafts, restoreDraftSnapshots, sessionIdentityReady, tabSessionId, workspace, workspaceId, workspaceStoragePrefix])

  useEffect(() => () => {
    // The first effect instance can be cleaned up when a duplicate tab rotates
    // its cloned ID. Never serialize into that old (possibly live) tab's slot.
    if (!sessionIdentityReady) return
    if (snapshotTimerRef.current) clearTimeout(snapshotTimerRef.current)
    const drafts = collectDirtyDrafts()
    writePendingDrafts(drafts)
  }, [collectDirtyDrafts, pendingDraftKey, sessionIdentityReady, writePendingDrafts])

  useEffect(() => {
    // If a user types during the short identity probe, persist that draft once
    // the unique per-tab storage key is ready.
    if (sessionIdentityReady && Object.keys(collectDirtyDrafts()).length) scheduleDraftSnapshot()
  }, [collectDirtyDrafts, scheduleDraftSnapshot, sessionIdentityReady])

  const setDraft = useCallback((path, content, dirty = content !== cleanContentsRef.current[path]) => {
    const previousContent = draftContentsRef.current[path]
    draftContentsRef.current[path] = content
    dirtyRef.current[path] = Boolean(dirty)
    if (!dirty) delete restoredDraftsRef.current[path]
    if (dirty && saveErrorsRef.current[path] && previousContent !== content) {
      const nextErrors = { ...saveErrorsRef.current }
      delete nextErrors[path]
      saveErrorsRef.current = nextErrors
      setSaveErrors(nextErrors)
    }
    setSavedContents(prev => ({ ...prev, [path]: content }))
    setIsDirty(prev => {
      const next = { ...prev }
      if (dirty) next[path] = true
      else delete next[path]
      return next
    })
    // Rebuild the store after both edits and clean transitions. A user can
    // undo back to the on-disk bytes, and leaving the prior dirty snapshot in
    // storage would incorrectly resurrect the abandoned version after a crash.
    // The collector reads every current dirty path, so a newer same-path draft
    // is retained if one was entered before this throttled write runs.
    scheduleDraftSnapshot()
  }, [scheduleDraftSnapshot])

  const applyRecoveryAlternative = useCallback((path, entry) => {
    const snapshot = entry?.snapshot
    if (!path || !snapshot) return
    const currentContent = draftContentsRef.current[path]
    if (dirtyRef.current[path] && currentContent !== undefined && currentContent !== snapshot.content) {
      addRecoveryAlternative(path, {
        content: currentContent,
        baseRevision: restoredDraftsRef.current[path]
          ? restoredDraftsRef.current[path].baseRevision
          : (fileRevisionsRef.current[path] ?? null),
        savedAt: Date.now(),
      }, '当前标签页草稿')
    }
    restoredDraftsRef.current[path] = snapshot
    setDraft(path, snapshot.content, true)
    setFileConflict(path, {
      type: 'recovered-alternative',
      baseRevision: snapshot.baseRevision,
      diskRevision: fileRevisionsRef.current[path] ?? null,
    })
  }, [addRecoveryAlternative, setDraft, setFileConflict])

  const clearSaveTimer = useCallback(path => {
    const timer = saveTimersRef.current.get(path)
    if (timer) clearTimeout(timer)
    saveTimersRef.current.delete(path)
  }, [])

  const doSave = useCallback((path, content = draftContentsRef.current[path]) => {
    if (!path || isImageFile(path) || content === undefined) return Promise.resolve(false)
    clearSaveTimer(path)
    const previous = saveQueuesRef.current.get(path) || Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      if (conflictsRef.current[path]) {
        const blocked = new Error('文件存在版本冲突，处理前不会覆盖磁盘内容')
        blocked.code = 'FILE_CONFLICT'
        throw blocked
      }
      // Read the baseline only when this operation reaches the front of the
      // queue. Earlier saves may have advanced the disk revision while this
      // snapshot waited behind them.
      const expectedRevision = fileRevisionsRef.current[path]
      if (!expectedRevision) {
        const conflict = {
          type: 'unverified-draft',
          baseRevision: restoredDraftsRef.current[path]?.baseRevision ?? null,
          diskRevision: null,
        }
        setFileConflict(path, conflict)
        const blocked = new Error('缺少文件版本信息，已暂停保存以保护磁盘内容')
        blocked.code = 'FILE_CONFLICT'
        throw blocked
      }
      if (activeFileRef.current === path) setSaveStatus('saving')
      try {
        const response = await api.put(API, { path, content, expectedRevision })
        const nextRevision = response.data?.revision || response.headers?.['x-file-revision']
        if (nextRevision) setFileRevision(path, nextRevision)
        // Only acknowledge the snapshot the server actually received. The user
        // may have typed a newer draft while this request was in flight.
        if (draftContentsRef.current[path] === content) {
          cleanContentsRef.current[path] = content
          dirtyRef.current[path] = false
          delete restoredDraftsRef.current[path]
          clearPendingDraft(path, content)
          const nextErrors = { ...saveErrorsRef.current }
          delete nextErrors[path]
          saveErrorsRef.current = nextErrors
          setSaveErrors(nextErrors)
          setSavedContents(prev => ({ ...prev, [path]: content }))
          setIsDirty(prev => { const next = { ...prev }; delete next[path]; return next })
          if (activeFileRef.current === path) setSaveStatus('saved')
        } else {
          if (activeFileRef.current === path) setSaveStatus('modified')
          // The draft's base revision must advance with the successful earlier
          // queue item, so a crash cannot restore it as falsely stale.
          const restored = restoredDraftsRef.current[path]
          if (restored && nextRevision) {
            restoredDraftsRef.current[path] = { ...restored, baseRevision: nextRevision }
          }
          writePendingDrafts(collectDirtyDrafts())
        }
        return true
      } catch (error) {
        if (isFileConflict(error)) {
          const conflict = {
            type: 'disk-changed',
            baseRevision: expectedRevision,
            diskRevision: error.response?.data?.currentRevision ?? null,
            diskContent: error.response?.data?.currentContent ?? null,
          }
          setFileConflict(path, conflict)
          // Leave the draft dirty and persisted. Never route a conflict through
          // the generic retry path, which could turn it into a blind overwrite.
          if (activeFileRef.current === path) setSaveStatus('conflict')
          throw error
        }
        const nextErrors = { ...saveErrorsRef.current, [path]: error?.message || '保存失败' }
        saveErrorsRef.current = nextErrors
        setSaveErrors(nextErrors)
        if (activeFileRef.current === path) setSaveStatus('error')
        throw error
      }
    })
    saveQueuesRef.current.set(path, operation)
    operation.then(
      () => { if (saveQueuesRef.current.get(path) === operation) saveQueuesRef.current.delete(path) },
      () => { if (saveQueuesRef.current.get(path) === operation) saveQueuesRef.current.delete(path) },
    )
    return operation
  }, [activeFileRef, clearPendingDraft, clearSaveTimer, collectDirtyDrafts, setFileConflict, setFileRevision, writePendingDrafts])

  const scheduleSave = useCallback((path, content) => {
    clearSaveTimer(path)
    const timer = setTimeout(() => {
      saveTimersRef.current.delete(path)
      doSave(path, content).catch(() => {})
    }, 3000)
    saveTimersRef.current.set(path, timer)
  }, [clearSaveTimer, doSave])

  const waitForPathSaves = useCallback(async paths => {
    const unique = [...new Set(paths)]
    for (const path of unique) {
      clearSaveTimer(path)
      if (dirtyRef.current[path] && draftContentsRef.current[path] !== undefined) {
        await doSave(path, draftContentsRef.current[path])
      }
      const pending = saveQueuesRef.current.get(path)
      if (pending) await pending
    }
  }, [clearSaveTimer, doSave])

  return {
    savedContents, setSavedContents,
    isDirty, setIsDirty,
    saveStatus, setSaveStatus,
    saveErrors, setSaveErrors,
    draftContentsRef, dirtyRef, saveTimersRef, saveQueuesRef,
    saveErrorsRef, cleanContentsRef,
    writePendingDrafts,
    clearPendingDraft, collectDirtyDrafts,
    remapPendingDrafts, removePendingDrafts,
    fileRevisions, setFileRevisions, fileRevisionsRef,
    fileConflicts, setFileConflicts, conflictsRef, restoredDraftsRef,
    recoveryAlternatives, applyRecoveryAlternative,
    draftStorageError, setFileRevision, setFileConflict, clearFileConflict,
    waitForDraftRestore,
    setDraft, clearSaveTimer, doSave, scheduleSave, waitForPathSaves,
  }
}
