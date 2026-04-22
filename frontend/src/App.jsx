import React, { useState } from 'react'
import Welcome from './pages/Welcome'
import Editor from './pages/Editor'

export default function App() {
  const [workspace, setWorkspace] = useState(null)

  if (!workspace) {
    return <Welcome onEnter={setWorkspace} />
  }

  return <Editor workspace={workspace} />
}
