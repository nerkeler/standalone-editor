import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

const API = '/api/workspace'
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif']

export function isImageFile(name) {
  return IMAGE_EXTS.includes(name.split('.').pop()?.toLowerCase() || '')
}

function remapPath(pathValue, oldPath, newPath) {
  if (pathValue === oldPath) return newPath
  if (pathValue.startsWith(`${oldPath}/`)) return `${newPath}${pathValue.slice(oldPath.length)}`
  return pathValue
}

/** Owns each open document's Markdown draft and its serialized save queue. */
export default function useEditorDrafts(workspace, activeFileRef) {
  const [savedContents, setSavedContents] = useState({})
  const [isDirty, setIsDirty] = useState({})
  const [saveStatus, setSaveStatus] = useState('idle')
  const [saveErrors, setSaveErrors] = useState({})

  const draftContentsRef = useRef({})
  const dirtyRef = useRef({})
  const saveTimersRef = useRef(new Map())
  const saveQueuesRef = useRef(new Map())
  const saveErrorsRef = useRef(saveErrors)
  const cleanContentsRef = useRef({})

  useEffect(() => { saveErrorsRef.current = saveErrors }, [saveErrors])

  const pendingDraftKey = `editor_pending_drafts:${encodeURIComponent(workspace || '')}`
  const readPendingDrafts = useCallback(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(pendingDraftKey) || 'null')
      if (!parsed || typeof parsed.drafts !== 'object') return {}
      // A draft left by a crashed/closed tab should not shadow a file forever.
      if (parsed.savedAt && Date.now() - parsed.savedAt > 7 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(pendingDraftKey)
        return {}
      }
      return Object.fromEntries(Object.entries(parsed.drafts).filter(([, value]) => typeof value === 'string'))
    } catch { return {} }
  }, [pendingDraftKey])

  const writePendingDrafts = useCallback(drafts => {
    try {
      if (Object.keys(drafts).length) {
        localStorage.setItem(pendingDraftKey, JSON.stringify({ savedAt: Date.now(), drafts }))
      } else {
        localStorage.removeItem(pendingDraftKey)
      }
    } catch {}
  }, [pendingDraftKey])

  const clearPendingDraft = useCallback((path, expectedContent) => {
    const drafts = readPendingDrafts()
    if (expectedContent === undefined || drafts[path] === expectedContent) {
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

  useEffect(() => {
    const restored = readPendingDrafts()
    const paths = Object.keys(restored)
    if (!paths.length) return
    Object.assign(draftContentsRef.current, restored)
    paths.forEach(path => { dirtyRef.current[path] = true })
    setSavedContents(prev => ({ ...prev, ...restored }))
    setIsDirty(prev => ({ ...prev, ...Object.fromEntries(paths.map(path => [path, true])) }))
  }, [readPendingDrafts])

  const setDraft = useCallback((path, content, dirty = content !== cleanContentsRef.current[path]) => {
    const previousContent = draftContentsRef.current[path]
    draftContentsRef.current[path] = content
    dirtyRef.current[path] = Boolean(dirty)
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
  }, [])

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
      if (activeFileRef.current === path) setSaveStatus('saving')
      try {
        await api.put(API, { path, content })
        // Only acknowledge the snapshot the server actually received. The user
        // may have typed a newer draft while this request was in flight.
        if (draftContentsRef.current[path] === content) {
          cleanContentsRef.current[path] = content
          dirtyRef.current[path] = false
          clearPendingDraft(path, content)
          const nextErrors = { ...saveErrorsRef.current }
          delete nextErrors[path]
          saveErrorsRef.current = nextErrors
          setSaveErrors(nextErrors)
          setSavedContents(prev => ({ ...prev, [path]: content }))
          setIsDirty(prev => { const next = { ...prev }; delete next[path]; return next })
          if (activeFileRef.current === path) setSaveStatus('saved')
        } else if (activeFileRef.current === path) {
          setSaveStatus('modified')
        }
        return true
      } catch (error) {
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
  }, [activeFileRef, clearPendingDraft, clearSaveTimer])

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
    remapPendingDrafts, removePendingDrafts,
    setDraft, clearSaveTimer, doSave, scheduleSave, waitForPathSaves,
  }
}
