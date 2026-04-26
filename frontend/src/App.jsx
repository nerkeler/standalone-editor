import React, { useState } from 'react'
import Welcome from './pages/Welcome'
import Editor from './pages/Editor'

export default function App() {
  const [workspace, setWorkspace] = useState(() => {
    return localStorage.getItem('editor_workspace') || null
  })

  if (!workspace) {
    return <Welcome onEnter={(ws) => {
      localStorage.setItem('editor_workspace', ws)
      setWorkspace(ws)
    }} />
  }

  return <Editor workspace={workspace} onWorkspaceChange={(ws) => {
    localStorage.setItem('editor_workspace', ws)
    setWorkspace(ws)
  }} />
}
