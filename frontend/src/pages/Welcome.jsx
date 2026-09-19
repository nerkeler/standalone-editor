import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Button, message, Modal, Breadcrumb, Spin } from 'antd'
import { FolderOpenOutlined, EditOutlined, ArrowLeftOutlined, LoadingOutlined } from '@ant-design/icons'
import { api, getWorkspaceContext, setWorkspaceContext } from '../api'

const DIRS_API = '/api/dirs'
const WS_API = '/api/workspace'

export default function Welcome({ onEnter }) {
  const [currentWorkspace, setCurrentWorkspace] = useState('')
  const [loading, setLoading] = useState(true)
  const [pickerVisible, setPickerVisible] = useState(false)
  const [pickerData, setPickerData] = useState(null)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const pickerRequestRef = useRef(0)
  const confirmRequestRef = useRef(0)

  useEffect(() => {
    // 每次进入都从后端取得工作空间标识，避免另一个窗口切换目录后继续使用旧状态。
    api.get(`${WS_API}/check`)
      .then(res => {
        const info = res.data
        const ws = info.workspace
        setWorkspaceContext(info)
        setCurrentWorkspace(ws)
        setLoading(false)
      })
      .catch(() => {
        const saved = getWorkspaceContext()
        if (saved?.workspace) setCurrentWorkspace(saved.workspace)
        setLoading(false)
      })
  }, [])

  const loadPickerDir = useCallback((dir = '', { fallbackToRoot = false } = {}) => {
    const requestId = ++pickerRequestRef.current
    setError('')
    setPickerLoading(true)
    const url = dir ? `${DIRS_API}?path=${encodeURIComponent(dir)}` : DIRS_API
    api.get(url)
      .then(res => {
        if (requestId !== pickerRequestRef.current) return
        setPickerData(res.data)
        setPickerLoading(false)
      })
      .catch(err => {
        if (requestId !== pickerRequestRef.current) return
        if (fallbackToRoot && dir) {
          loadPickerDir('')
          return
        }
        setError(String(err.response?.data?.error || err.message || 'unknown error'))
        setPickerData(null)
        setPickerLoading(false)
      })
  }, [])

  const openPicker = () => {
    // Start at the active workspace when it is available. This keeps the
    // picker usable when the backend allow-list is narrower than $HOME (as it
    // is for a sandbox or a macOS volume), while the backend falls back to a
    // legal configured root for a fresh session.
    const start = currentWorkspace || getWorkspaceContext()?.workspace || ''
    pickerRequestRef.current += 1
    setPickerData(null)
    setError('')
    setPickerVisible(true)
    loadPickerDir(start, { fallbackToRoot: Boolean(start) })
  }

  const enterDir = (entry) => {
    if (entry.type !== 'dir' || entry.canNavigate === false) return
    loadPickerDir(entry.path)
  }

  const goUp = () => {
    if (!pickerData?.canGoUp || !pickerData.parent) return
    loadPickerDir(pickerData.parent)
  }

  const confirmSelection = () => {
    if (!pickerData?.path || !pickerData.canSelect || pickerLoading || confirming) return
    const requestId = ++confirmRequestRef.current
    const selectedPath = pickerData.path
    setConfirming(true)
    setPickerLoading(true)
    api.post(`${WS_API}/set`, { path: selectedPath })
      .then(res => {
        if (requestId !== confirmRequestRef.current) return
        const info = res.data
        const ws = info.workspace
        setWorkspaceContext(info)
        setCurrentWorkspace(ws)
        setPickerVisible(false)
        setConfirming(false)
        setPickerLoading(false)
        message.success(`已切换到：${ws}`)
        onEnter(info)
      })
      .catch(err => {
        if (requestId !== confirmRequestRef.current) return
        message.error(err.response?.data?.error || '切换目录失败')
        setConfirming(false)
        setPickerLoading(false)
      })
  }

  const closePicker = () => {
    if (confirming) return
    pickerRequestRef.current += 1
    setPickerVisible(false)
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100vh', gap: 32, padding: 24,
    }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>📝 在线编辑器</h1>

      <div style={{
        background: 'var(--color-bg-card)', borderRadius: 16,
        padding: '32px 40px', boxShadow: 'var(--shadow-lg)',
        display: 'flex', flexDirection: 'column', gap: 20, minWidth: 380,
      }}>
        {loading ? (
          <Spin indicator={<LoadingOutlined spin />} />
        ) : (
          <>
            <div style={{
              background: 'var(--color-bg-muted)', borderRadius: 10,
              padding: '12px 16px', fontSize: 13,
              color: 'var(--color-text-secondary)',
              wordBreak: 'break-all',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                当前工作目录
              </div>
              <div style={{ fontWeight: 600, fontFamily: 'monospace' }}>
                {currentWorkspace || '未选择工作目录'}
              </div>
            </div>

            <Button
              size="large"
              icon={<FolderOpenOutlined />}
              onClick={openPicker}
              block
              style={{ height: 52, borderRadius: 10, fontSize: 15 }}
            >
              选择工作目录
            </Button>

            <Button
              size="large"
              icon={<EditOutlined />}
              onClick={() => onEnter(getWorkspaceContext() || currentWorkspace)}
              disabled={!currentWorkspace}
              block
              style={{ height: 52, borderRadius: 10, fontSize: 15 }}
            >
              打开当前目录
            </Button>
          </>
        )}
      </div>

      {/* 目录选择器弹窗 */}
      <Modal
        title="选择工作目录"
        open={pickerVisible}
        onCancel={closePicker}
        onOk={confirmSelection}
        confirmLoading={confirming}
        okButtonProps={{ disabled: pickerLoading || confirming || !pickerData?.canSelect }}
        okText="确认选择"
        cancelText="取消"
        width={560}
      >
        {error && <div style={{ padding: '6px 8px', fontSize: 12, color: 'var(--color-danger)', background: 'color-mix(in srgb, var(--color-danger) 12%, var(--color-bg-card))', borderRadius: 4, marginBottom: 8 }}>{error}</div>}

        {/* Root locations come from the host. Keep the complete path in the
            tooltip and use the backend-provided path when navigating so this
            works for POSIX roots, Windows drive letters, and UNC shares. */}
        {(pickerData?.roots || []).length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>位置</span>
            {pickerData.roots.map(root => (
              <Button
                key={root.path}
                size="small"
                type={root.path === pickerData.path ? 'primary' : 'default'}
                disabled={pickerLoading || confirming || root.canNavigate === false}
                title={root.path}
                aria-label={root.path}
                onClick={() => loadPickerDir(root.path)}
              >
                {root.name || root.path}
              </Button>
            ))}
          </div>
        )}

        {/* 面包屑 + 返回按钮；路径由后端生成，前端不拼接平台分隔符。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Button size="small" icon={<ArrowLeftOutlined />} onClick={goUp} disabled={pickerLoading || !pickerData?.canGoUp}>返回</Button>
          <Breadcrumb
            separator={pickerData?.separator || '/'}
            items={(pickerData?.breadcrumb || []).map((item, index, all) => ({
              key: item.path,
              title: (
                <a
                  style={{ fontWeight: index === all.length - 1 ? 700 : 400 }}
                  onClick={() => {
                    if (!pickerLoading && item.canNavigate && item.path !== pickerData.path) loadPickerDir(item.path)
                  }}
                >
                  {item.name}
                </a>
              ),
            }))}
          />
        </div>

        {/* 目录列表 */}
        <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 8, padding: '4px 0' }}>
          {pickerLoading ? (
            <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
          ) : !pickerData || pickerData.entries?.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--color-text-secondary)' }}>空目录</div>
          ) : (
            pickerData.entries.map(entry => (
              <div
                key={entry.path}
                onClick={() => enterDir(entry)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 12px', cursor: 'pointer',
                  fontSize: 14,
                  opacity: entry.type === 'dir' && entry.canNavigate === false ? 0.5 : 1,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <FolderOpenOutlined style={{ color: entry.type === 'dir' ? 'var(--color-warning)' : 'var(--color-text-secondary)', fontSize: 18 }} />
                <span style={{ flex: 1, color: 'var(--color-text)' }}>{entry.name}</span>
                {entry.type === 'file' && <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>文件</span>}
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  )
}
