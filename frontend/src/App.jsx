import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import Welcome from './pages/Welcome'
import Editor from './pages/Editor'
import { api, setWorkspaceContext } from './api'
import ThemeToggle from './components/ThemeToggle'
import { applyTheme, getInitialTheme, THEME_KEY } from './theme'

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

export default function App() {
  const [theme, setTheme] = useState(getInitialTheme)
  const [workspaceInfo, setWorkspaceInfo] = useState(null)
  const [checkingWorkspace, setCheckingWorkspace] = useState(true)
  const [workspaceDiagnostic, setWorkspaceDiagnostic] = useState(null)
  const requestIdRef = useRef(0)
  const mountedRef = useRef(true)
  const workspace = workspaceInfo?.workspace || null

  useEffect(() => {
    applyTheme(theme)
    try { localStorage.setItem(THEME_KEY, theme) } catch {}
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
    }
  }, [validateWorkspace])

  const enterWorkspace = useCallback(value => {
    if (!value) {
      setWorkspaceContext(null)
      setWorkspaceInfo(null)
      setWorkspaceDiagnostic(null)
      setCheckingWorkspace(false)
      return Promise.resolve(false)
    }
    // Selection and context changes are followed by the same authoritative
    // check as startup. Do not mount Editor from the supplied value.
    return validateWorkspace()
  }, [validateWorkspace])

  const content = checkingWorkspace
    ? <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--color-text-secondary)' }}>正在校验工作空间…</div>
    : !workspace
      ? <Welcome
          diagnostic={workspaceDiagnostic}
          onRetry={validateWorkspace}
          onEnter={enterWorkspace}
        />
      : <Editor workspace={workspace} workspaceInfo={workspaceInfo} onWorkspaceChange={enterWorkspace} />

  const toggleTheme = () => setTheme(current => current === 'dark' ? 'light' : 'dark')
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
      <ThemeToggle theme={theme} onToggle={toggleTheme} />
      {content}
    </ConfigProvider>
  )
}
