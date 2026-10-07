import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import Welcome from './pages/Welcome'
import { api, setWorkspaceContext } from './api'
import ThemeToggle from './components/ThemeToggle'
import WorkspacePickerModal from './components/WorkspacePickerModal'
import EditorLoadErrorBoundary from './components/EditorLoadErrorBoundary'
import { applyTheme, getInitialTheme, THEME_KEY } from './theme'
import { writeStorage } from './safeStorage.js'

const Editor = lazy(() => import('./pages/Editor'))

function describeWorkspaceCheckError(error) {
  const payload = error?.response?.data || {}
  const code = payload.code || payload.errorCode || 'WORKSPACE_CHECK_FAILED'
  const workspace = payload.workspace
    || payload.savedWorkspace
    || payload.workspacePath
    || payload.path
    || null
  const messages = {
    SAVED_WORKSPACE_UNAVAILABLE: '上次使用的工作区当前不可访问。请重新连接磁盘后重试，或选择其他目录。',
    WORKSPACE_CONFIG_INVALID: '工作区配置无效。请重新选择一个目录。',
    WORKSPACE_CONFIG_UNREADABLE: '无法读取工作区配置。请重新选择一个目录。',
  }
  return {
    code,
    workspace,
    configurationFile: payload.configFile || null,
    detail: payload.error || payload.message || null,
    message: messages[code] || payload.error || payload.message
      || '暂时无法验证工作区。请检查后端服务，或重新选择一个目录。',
  }
}

function sameWorkspaceIdentity(left, right) {
  return Boolean(
    left?.workspace && right?.workspace
    && left.workspace === right.workspace
    && left.workspaceId != null && right.workspaceId != null
    && left.workspaceId === right.workspaceId
    && left.workspaceVersion != null && right.workspaceVersion != null
    && left.workspaceVersion === right.workspaceVersion
  )
}

function describeSelectionError(error, fallback = '切换工作目录失败') {
  const payload = error?.response?.data || {}
  const knownErrors = {
    RECOVERY_ROOT_INSIDE_WORKSPACE: '恢复数据目录位于所选工作目录内部。请调整恢复目录或选择其他目录。',
    WORKSPACE_INSIDE_RECOVERY_ROOT: '所选工作目录位于恢复数据目录内部。请调整恢复目录或选择其他目录。',
    WORKSPACE_CONFIG_INVALID: '工作目录配置无效。',
    WORKSPACE_CONFIG_UNREADABLE: '无法读取工作目录配置。',
    SAVED_WORKSPACE_UNAVAILABLE: '上次使用的工作目录当前不可访问。',
  }
  return knownErrors[payload.code || payload.errorCode]
    || payload.error
    || payload.message
    || error?.message
    || fallback
}

export default function App() {
  const [theme, setTheme] = useState(getInitialTheme)
  const [workspaceInfo, setWorkspaceInfo] = useState(null)
  const [checkingWorkspace, setCheckingWorkspace] = useState(true)
  const [workspaceDiagnostic, setWorkspaceDiagnostic] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerInitialPath, setPickerInitialPath] = useState('')
  const [pickerOperation, setPickerOperation] = useState('')
  const [pickerError, setPickerError] = useState('')
  const requestIdRef = useRef(0)
  const selectionRequestIdRef = useRef(0)
  const beforeSelectRef = useRef(null)
  const mountedRef = useRef(true)
  const workspace = workspaceInfo?.workspace || null

  useEffect(() => {
    applyTheme(theme)
    writeStorage(THEME_KEY, theme)
  }, [theme])

  const validateWorkspace = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setCheckingWorkspace(true)
    setWorkspaceDiagnostic(null)
    try {
      // The backend is authoritative. A cached path or successful /set
      // response alone never grants entry to the editor.
      const response = await api.get('/api/workspace/check')
      if (!mountedRef.current || requestId !== requestIdRef.current) return false
      const info = response.data
      if (!info?.workspace) throw new Error('后端没有返回有效工作区')
      setWorkspaceContext(info)
      setWorkspaceInfo(info)
      setWorkspaceDiagnostic(null)
      setCheckingWorkspace(false)
      return true
    } catch (error) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return false
      const diagnostic = describeWorkspaceCheckError(error)
      // Keep the rejected path only in the diagnostic so it can be shown as
      // context. Clear it from the active browser context to prevent reuse.
      setWorkspaceContext(null)
      setWorkspaceInfo(null)
      setWorkspaceDiagnostic(diagnostic)
      setCheckingWorkspace(false)
      return false
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    validateWorkspace()
    return () => {
      mountedRef.current = false
      requestIdRef.current += 1
      selectionRequestIdRef.current += 1
    }
  }, [validateWorkspace])

  const openWorkspacePicker = useCallback(({ initialPath = '', beforeSelect = null } = {}) => {
    beforeSelectRef.current = typeof beforeSelect === 'function' ? beforeSelect : null
    setPickerInitialPath(typeof initialPath === 'string' ? initialPath : '')
    setPickerError('')
    setPickerOperation('')
    setPickerOpen(true)
  }, [])

  const clearPickerError = useCallback(() => setPickerError(''), [])

  const closeWorkspacePicker = useCallback(() => {
    if (pickerOperation) return
    selectionRequestIdRef.current += 1
    beforeSelectRef.current = null
    setPickerOpen(false)
    setPickerError('')
  }, [pickerOperation])

  const enterSelectionDiagnostic = useCallback((message, detail = '') => {
    setWorkspaceContext(null)
    setWorkspaceInfo(null)
    setWorkspaceDiagnostic({
      code: 'WORKSPACE_SELECTION_UNCONFIRMED',
      message,
      detail: detail || null,
    })
    setCheckingWorkspace(false)
    setPickerError(message)
    beforeSelectRef.current = null
  }, [])

  const confirmWorkspaceSelection = useCallback(async directory => {
    if (!directory?.canSelect || typeof directory.path !== 'string' || pickerOperation) return false
    const requestId = ++selectionRequestIdRef.current
    const previousWorkspace = workspaceInfo
    const beforeSelect = beforeSelectRef.current
    setPickerError('')

    if (beforeSelect) {
      setPickerOperation('saving')
      try {
        const prepared = await beforeSelect()
        if (prepared === false) throw new Error('保存失败，暂不能更改目录')
      } catch (error) {
        if (!mountedRef.current || requestId !== selectionRequestIdRef.current) return false
        setPickerOperation('')
        setPickerError('当前草稿未能保存，暂不能更改目录。请先处理保存失败或冲突。')
        return false
      }
    }

    if (!mountedRef.current || requestId !== selectionRequestIdRef.current) return false
    setPickerOperation('setting')
    let setInfo
    try {
      const response = await api.post('/api/workspace/set', { path: directory.path }, { timeout: 20000 })
      if (!mountedRef.current || requestId !== selectionRequestIdRef.current) return false
      setInfo = response.data
    } catch (error) {
      if (!mountedRef.current || requestId !== selectionRequestIdRef.current) return false
      const status = error?.response?.status
      if (status >= 400 && status < 500) {
        setPickerOperation('')
        setPickerError(describeSelectionError(error))
        return false
      }

      // A lost response can mean the backend already changed its active path.
      // Keep the old editor covered until a context-free check resolves that
      // ambiguity; never restore the previous context by assumption.
      setPickerOperation('reconciling')
      try {
        const checkResponse = await api.get('/api/workspace/check', { timeout: 20000 })
        if (!mountedRef.current || requestId !== selectionRequestIdRef.current) return false
        const checkedInfo = checkResponse.data
        if (sameWorkspaceIdentity(previousWorkspace, checkedInfo)) {
          setWorkspaceContext(checkedInfo)
          setWorkspaceInfo(checkedInfo)
          setWorkspaceDiagnostic(null)
          setPickerOperation('')
          setPickerError(`无法确认切换结果；后端仍验证为 ${checkedInfo.workspace}。请重试或选择其他目录。`)
          return false
        }
        enterSelectionDiagnostic(
          '无法确认工作目录设置结果。为避免继续使用可能已失效的目录，编辑器已暂停。请重新选择并验证工作目录。',
          checkedInfo?.workspace ? `后端目前报告的目录：${checkedInfo.workspace}` : describeSelectionError(error)
        )
      } catch (checkError) {
        if (!mountedRef.current || requestId !== selectionRequestIdRef.current) return false
        const checkDiagnostic = describeWorkspaceCheckError(checkError)
        enterSelectionDiagnostic(
          '无法确认工作目录设置结果。为避免继续使用可能已失效的目录，编辑器已暂停。请重新选择并验证工作目录。',
          checkDiagnostic.detail || checkDiagnostic.message
        )
      }
      setPickerOperation('')
      return false
    }

    if (!mountedRef.current || requestId !== selectionRequestIdRef.current) return false
    setPickerOperation('checking')
    try {
      const checkResponse = await api.get('/api/workspace/check', { timeout: 20000 })
      if (!mountedRef.current || requestId !== selectionRequestIdRef.current) return false
      const checkedInfo = checkResponse.data
      if (!sameWorkspaceIdentity(setInfo, checkedInfo) || setInfo.workspace !== directory.path) {
        enterSelectionDiagnostic(
          '工作目录设置结果与后端校验不匹配。编辑器已暂停，请重新选择并验证目录。',
          `所选目录：${directory.path}；设置响应：${setInfo?.workspace || '无有效路径'}；校验响应：${checkedInfo?.workspace || '无有效路径'}`
        )
        setPickerOperation('')
        return false
      }

      setWorkspaceContext(checkedInfo)
      setWorkspaceInfo(checkedInfo)
      setWorkspaceDiagnostic(null)
      setPickerOperation('')
      setPickerError('')
      beforeSelectRef.current = null
      setPickerOpen(false)
      return true
    } catch (error) {
      if (!mountedRef.current || requestId !== selectionRequestIdRef.current) return false
      const diagnostic = describeWorkspaceCheckError(error)
      enterSelectionDiagnostic(
        '工作目录已请求切换，但后端校验未通过。编辑器已暂停，请重新选择并验证工作目录。',
        diagnostic.detail || diagnostic.message
      )
      setPickerOperation('')
      return false
    }
  }, [enterSelectionDiagnostic, pickerOperation, workspaceInfo])

  const toggleTheme = () => setTheme(current => current === 'dark' ? 'light' : 'dark')
  const openWelcomePicker = useCallback(() => openWorkspacePicker(), [openWorkspacePicker])
  const pickerOperationMessage = {
    saving: '正在保存当前草稿…',
    setting: '正在设置工作目录…',
    checking: '正在验证已设置的工作目录…',
    reconciling: '正在重新验证后端当前工作目录…',
  }[pickerOperation] || ''

  const content = checkingWorkspace
    ? <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--color-text-secondary)' }}>正在校验工作空间…</div>
    : !workspace
      ? <Welcome
          diagnostic={workspaceDiagnostic}
          onRetry={validateWorkspace}
          onChooseWorkspace={openWelcomePicker}
        />
      : <EditorLoadErrorBoundary key={`${workspaceInfo?.workspaceId || ''}:${workspaceInfo?.workspaceVersion ?? ''}`}>
          <Suspense fallback={<div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--color-text-secondary)' }}>正在加载编辑器…</div>}>
            <Editor workspace={workspace} workspaceInfo={workspaceInfo} onRequestWorkspacePicker={openWorkspacePicker}
              themeToggle={<ThemeToggle theme={theme} onToggle={toggleTheme} />} />
          </Suspense>
        </EditorLoadErrorBoundary>

  return (
    <ConfigProvider
      theme={{
        algorithm: theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: theme === 'dark' ? '#91bdd0' : '#517893',
          colorInfo: theme === 'dark' ? '#91bdd0' : '#517893',
          colorLink: theme === 'dark' ? '#91bdd0' : '#517893',
          borderRadius: 8,
        },
      }}
    >
      {!workspace && <ThemeToggle theme={theme} onToggle={toggleTheme} />}
      {content}
      <WorkspacePickerModal
        open={pickerOpen}
        initialPath={pickerInitialPath}
        locked={Boolean(pickerOperation)}
        operationMessage={pickerOperationMessage}
        transactionError={pickerError}
        onClearTransactionError={clearPickerError}
        onCancel={closeWorkspacePicker}
        onConfirm={confirmWorkspaceSelection}
      />
    </ConfigProvider>
  )
}
