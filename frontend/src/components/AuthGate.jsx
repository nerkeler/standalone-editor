import React, { useEffect, useState } from 'react'
import { Alert, Button, Card, Input } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import { authCooldownSeconds, describeAuthError, loginWithPassword } from '../api'

/**
 * Full-screen access password entry, shown whenever the backend reports
 * AUTH_REQUIRED. Follows the Welcome page's quiet centered column and reuses
 * the shared theme algorithm through ConfigProvider.
 */
export default function AuthGate({ themeToggle, onAuthenticated }) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [cooldownUntil])

  const cooldownRemaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

  const handleSubmit = async event => {
    event?.preventDefault?.()
    if (!password || submitting || cooldownRemaining > 0) return
    setSubmitting(true)
    setError('')
    try {
      const result = await loginWithPassword(password)
      if (result?.success && onAuthenticated) onAuthenticated()
      setPassword('')
    } catch (loginError) {
      const seconds = authCooldownSeconds(loginError)
      if (loginError?.response?.status === 429 || seconds > 0) {
        setCooldownUntil(Date.now() + seconds * 1000)
        setNow(Date.now())
      }
      setError(describeAuthError(loginError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-gate" role="dialog" aria-label="登录 Standalone Editor">
      <div className="auth-gate-theme">{themeToggle}</div>
      <Card className="auth-gate-card" bordered={false}>
        <form onSubmit={handleSubmit}>
          <div className="auth-gate-header">
            <LockOutlined aria-hidden="true" className="auth-gate-icon" />
            <div>
              <h1 className="auth-gate-title">Standalone Editor</h1>
              <p className="auth-gate-hint">此工作台已开启访问保护，请输入访问密码继续。</p>
            </div>
          </div>
          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
          <Input.Password
            autoFocus
            aria-label="访问密码"
            value={password}
            onChange={event => setPassword(event.target.value)}
            onPressEnter={handleSubmit}
            disabled={cooldownRemaining > 0}
            placeholder="访问密码"
            size="large"
            autoComplete="current-password"
          />
          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={submitting}
            disabled={cooldownRemaining > 0 || !password}
            style={{ marginTop: 12 }}
          >
            {cooldownRemaining > 0 ? `请 ${cooldownRemaining} 秒后再试` : '登录'}
          </Button>
        </form>
        <div className="auth-gate-footer">登录信息保存在本机服务，与浏览器会话绑定。</div>
      </Card>
    </div>
  )
}
