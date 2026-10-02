import React, { useState, useCallback, useRef } from 'react'
import { Alert, Button, Modal, Breadcrumb, Spin } from 'antd'
import { FolderOpenOutlined, FileOutlined, ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons'
import { api, setWorkspaceContext } from '../api'

const DIRS_API = '/api/dirs'
const WS_API = '/api/workspace'

const knownErrors = {
  RECOVERY_ROOT_INSIDE_WORKSPACE: '恢复数据目录位于所选工作区内部。请调整恢复目录或选择其他工作区。',
  WORKSPACE_INSIDE_RECOVERY_ROOT: '所选工作区位于恢复数据目录内部。请调整恢复目录或选择其他工作区。',
  WORKSPACE_CONFIG_INVALID: '工作区配置无效。请重新选择一个目录。',
  WORKSPACE_CONFIG_UNREADABLE: '无法读取工作区配置。请重新选择一个目录。',
  SAVED_WORKSPACE_UNAVAILABLE: '上次使用的工作区当前不可访问。请重新连接磁盘后重试，或选择其他目录。',
}

function errorMessage(error, fallback) {
  const payload = error?.response?.data || {}
  return knownErrors[payload.code || payload.errorCode]
    || payload.error
    || payload.message
    || error?.message
    || fallback
}

export default function Welcome({ diagnostic, onRetry, onEnter }) {
  const [pickerVisible, setPickerVisible] = useState(false)
  const [pickerData, setPickerData] = useState(null)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [pickerError, setPickerError] = useState('')
  const pickerRequestRef = useRef(0)
  const confirmRequestRef = useRef(0)

  const loadPickerDir = useCallback((dir = '', { fallbackToRoot = false } = {}) => {
    const requestId = ++pickerRequestRef.current
    setPickerError('')
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
        setPickerError(errorMessage(err, '无法读取目录'))
        setPickerData(null)
        setPickerLoading(false)
      })
  }, [])

  const openPicker = () => {
    // No cached workspace is trusted here. /api/dirs is deliberately
    // context-free so a picker remains available when the saved path is gone.
    const start = ''
    pickerRequestRef.current += 1
    setPickerData(null)
    setPickerError('')
    setPickerVisible(true)
    loadPickerDir(start)
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
        setWorkspaceContext(info)
        setPickerVisible(false)
        setConfirming(false)
        setPickerLoading(false)
        // App performs /api/workspace/check before mounting the editor.
        onEnter(info)
      })
      .catch(err => {
        if (requestId !== confirmRequestRef.current) return
        setPickerError(errorMessage(err, '切换目录失败'))
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
      minHeight: '100dvh', gap: 32,
      padding: 'max(clamp(16px, 4vw, 32px), env(safe-area-inset-top)) max(clamp(16px, 4vw, 32px), env(safe-area-inset-right)) max(clamp(16px, 4vw, 32px), env(safe-area-inset-bottom)) max(clamp(16px, 4vw, 32px), env(safe-area-inset-left))',
    }}>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 28, fontWeight: 700 }}>
        <FolderOpenOutlined aria-hidden="true" style={{ color: 'var(--color-primary)' }} />
        <span>在线编辑器</span>
      </h1>

      <div style={{
        background: 'var(--color-bg-card)', borderRadius: 16,
        padding: 'clamp(20px, 6vw, 32px) clamp(18px, 7vw, 40px)', boxShadow: 'var(--shadow-lg)',
        display: 'flex', flexDirection: 'column', gap: 20, width: 'min(100%, 480px)',
      }}>
        {diagnostic && (
          <Alert
            type="warning"
            showIcon
            message={diagnostic.message || errorMessage({ response: { data: diagnostic } }, '工作区尚未通过校验')}
            description={(
              <div style={{ wordBreak: 'break-all' }}>
                {diagnostic.workspace ? (
                  <div>
                    <div>上次记录的路径（当前未验证）：</div>
                    <code>{diagnostic.workspace}</code>
                  </div>
                ) : diagnostic.configurationFile ? (
                  <div>
                    <div>无法读取的配置文件：</div>
                    <code>{diagnostic.configurationFile}</code>
                  </div>
                ) : '当前没有可用且已验证的工作区。'}
                {diagnostic.detail && diagnostic.detail !== diagnostic.message && (
                  <div style={{ marginTop: 6 }}>后端信息：{diagnostic.detail}</div>
                )}
              </div>
            )}
            action={(
              <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
                重试
              </Button>
            )}
          />
        )}

        <div style={{
          background: 'var(--color-bg-muted)', borderRadius: 10,
          padding: '12px 16px', fontSize: 13,
          color: 'var(--color-text-secondary)',
        }}>
          选择一个可访问的工作目录后，编辑器会先向后端确认再打开。
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
      </div>

      {/* 目录选择器弹窗 */}
      <Modal
        className="workspace-picker-modal"
        title="选择工作目录"
        open={pickerVisible}
        onCancel={closePicker}
        onOk={confirmSelection}
        confirmLoading={confirming}
        okButtonProps={{ disabled: pickerLoading || confirming || !pickerData?.canSelect }}
        okText="确认选择"
        cancelText="取消"
        width="min(560px, calc(100vw - 32px))"
      >
        {pickerError && <div role="alert" style={{ padding: '6px 8px', fontSize: 12, color: 'var(--color-danger)', background: 'color-mix(in srgb, var(--color-danger) 12%, var(--color-bg-card))', borderRadius: 4, marginBottom: 8 }}>{pickerError}</div>}

        {/* Root locations come from the host. Keep the complete path in the
            tooltip and use the backend-provided path when navigating so this
            works for POSIX roots, Windows drive letters, and UNC shares. */}
        {(pickerData?.locations || pickerData?.roots || []).length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>位置</span>
            {(pickerData.locations || pickerData.roots).map(root => (
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
              <Button size="small" icon={<ArrowLeftOutlined />} onClick={goUp} disabled={pickerLoading || !pickerData?.canGoUp} aria-label="返回上级目录">返回</Button>
          <Breadcrumb
            separator={pickerData?.separator || '/'}
            items={(pickerData?.breadcrumb || []).map((item, index, all) => ({
              key: item.path,
              title: (
                index === all.length - 1 ? (
                  <span aria-current="page" style={{ fontWeight: 700 }}>{item.name}</span>
                ) : (
                  <button
                    type="button"
                    className="welcome-breadcrumb-button"
                    disabled={pickerLoading || !item.canNavigate}
                    onClick={() => {
                      if (!pickerLoading && item.canNavigate && item.path !== pickerData.path) loadPickerDir(item.path)
                    }}
                  >
                    {item.name}
                  </button>
                )
              ),
            }))}
          />
        </div>

        {/* 目录列表 */}
        <div
          role="group"
          aria-label="当前目录内容"
          aria-busy={pickerLoading}
          style={{ maxHeight: 'min(360px, 50dvh)', overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', border: '1px solid var(--color-border)', borderRadius: 8, padding: '4px 0' }}
        >
          {pickerLoading ? (
            <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
          ) : !pickerData || pickerData.entries?.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--color-text-secondary)' }}>空目录</div>
          ) : (
            pickerData.entries.map(entry => (
              <button
                type="button"
                key={entry.path}
                onClick={() => enterDir(entry)}
                disabled={entry.type !== 'dir' || entry.canNavigate === false}
                aria-label={entry.type === 'dir' ? `打开文件夹 ${entry.name}` : `${entry.name}，文件`}
                title={entry.type === 'dir' ? `打开文件夹 ${entry.name}` : entry.name}
                className="welcome-directory-entry"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', minHeight: 44, padding: '10px 12px', cursor: entry.type === 'dir' && entry.canNavigate !== false ? 'pointer' : 'default',
                  border: 0, background: 'transparent', textAlign: 'left', font: 'inherit',
                  fontSize: 14,
                  opacity: entry.type === 'dir' && entry.canNavigate === false ? 0.5 : 1,
                }}
              >
                {entry.type === 'dir'
                  ? <FolderOpenOutlined aria-hidden="true" style={{ color: 'var(--color-warning)', fontSize: 18 }} />
                  : <FileOutlined aria-hidden="true" style={{ color: 'var(--color-text-secondary)', fontSize: 16 }} />}
                <span style={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere', color: 'var(--color-text)' }}>{entry.name}</span>
                {entry.type === 'file' && <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>文件</span>}
              </button>
            ))
          )}
        </div>
      </Modal>
    </div>
  )
}
