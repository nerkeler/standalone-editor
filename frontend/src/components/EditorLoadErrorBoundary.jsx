import React from 'react'

export default class EditorLoadErrorBoundary extends React.Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Editor failed to load or render.', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <main
          role="alert"
          aria-labelledby="editor-load-error-title"
          style={{
            minHeight: '100vh',
            display: 'grid',
            placeContent: 'center',
            gap: 12,
            padding: 24,
            color: 'var(--color-text)',
            background: 'var(--color-bg)',
            textAlign: 'center',
          }}
        >
          <h1 id="editor-load-error-title" style={{ margin: 0, fontSize: 20 }}>编辑器加载失败</h1>
          <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
            编辑器资源可能已过期或网络连接中断。请重新加载页面后重试。
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              justifySelf: 'center',
              minHeight: 40,
              padding: '0 16px',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              color: 'var(--color-text)',
              background: 'var(--color-bg-card)',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >重新加载页面</button>
        </main>
      )
    }

    return this.props.children
  }
}
