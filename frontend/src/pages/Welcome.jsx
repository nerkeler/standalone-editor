import React from 'react'
import { Alert, Button } from 'antd'
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'

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

export default function Welcome({ diagnostic, onRetry, onChooseWorkspace }) {
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
            className="workspace-diagnostic"
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
          onClick={onChooseWorkspace}
          block
          style={{ height: 52, borderRadius: 10, fontSize: 15 }}
        >
          选择工作目录
        </Button>
      </div>

    </div>
  )
}
