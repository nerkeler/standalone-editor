import React, { useEffect, useRef, useState } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import Welcome from './pages/Welcome'
import Editor from './pages/Editor'
import { api, getWorkspaceContext, setWorkspaceContext } from './api'
import ThemeToggle from './components/ThemeToggle'
import { applyTheme, getInitialTheme, THEME_KEY } from './theme'

export default function App() {
  const [theme, setTheme] = useState(getInitialTheme)
  const initialContextRef = useRef(getWorkspaceContext())
  const [workspaceInfo, setWorkspaceInfo] = useState(() => initialContextRef.current)
  const [checkingWorkspace, setCheckingWorkspace] = useState(() => Boolean(initialContextRef.current?.workspace))
  const workspace = workspaceInfo?.workspace || null

  useEffect(() => {
    applyTheme(theme)
    try { localStorage.setItem(THEME_KEY, theme) } catch {}
  }, [theme])

  // A cached path/version is only a hint. Validate it before mounting Editor;
  // another window or a restarted backend may have selected a different
  // workspace, and rendering immediately would produce a confusing empty tree
  // after a series of 409 responses.
  useEffect(() => {
    const cached = initialContextRef.current
    if (!cached?.workspace) {
      setCheckingWorkspace(false)
      return undefined
    }
    let mounted = true
    api.get('/api/workspace/check')
      .then(response => {
        if (!mounted) return
        const info = response.data
        setWorkspaceContext(info)
        setWorkspaceInfo(info)
        setCheckingWorkspace(false)
      })
      .catch(() => {
        if (!mounted) return
        // Keep the stale context out of Editor. Welcome will retry the
        // context-free check and can show a usable directory chooser.
        setWorkspaceContext(null)
        setWorkspaceInfo(null)
        setCheckingWorkspace(false)
      })
    return () => { mounted = false }
  }, [])

  const enterWorkspace = value => {
    if (!value) {
      setWorkspaceContext(null)
      setWorkspaceInfo(null)
      return
    }
    const next = setWorkspaceContext(value) || getWorkspaceContext()
    setWorkspaceInfo(next)
    setCheckingWorkspace(false)
  }

  const content = checkingWorkspace
    ? <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--color-text-secondary)' }}>正在校验工作空间…</div>
    : !workspace
      ? <Welcome onEnter={enterWorkspace} />
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
