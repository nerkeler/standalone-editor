import { Button, Tooltip } from 'antd'
import {
  AlignLeftOutlined,
  AppstoreOutlined,
  CloseOutlined,
  FileOutlined,
  ReadOutlined,
} from '@ant-design/icons'

function toolbarButtonProps(active) {
  return {
    size: 'small',
    style: {
      fontWeight: 700,
      fontSize: 13,
      borderRadius: 6,
      height: 34,
      minWidth: 34,
      padding: '0 8px',
      background: active ? 'var(--color-surface-selected)' : 'transparent',
      color: active ? 'var(--color-primary)' : 'var(--color-text)',
      border: 'none',
      transition: 'all 0.15s',
    },
  }
}

export default function DocumentTabs({
  files,
  activeFile,
  saveErrors,
  isDirty,
  isMobile,
  showToolbar,
  onShowTree,
  onShowOutline,
  onToggleToolbar,
  onOpenFile,
  onCloseFile,
  onTabContextMenu,
}) {
  if (!files.length) return null

  return (
    <div className="document-tabs" role="tablist" aria-label="打开的文档" style={{
      display: 'flex', background: 'var(--color-bg-card)',
      borderRadius: 0, border: '1px solid var(--color-border)', borderBottom: 'none',
      overflowX: 'auto', overflowY: 'hidden', flexShrink: 0, flexWrap: 'nowrap',
    }}>
      {isMobile && (
        <div className="document-tabs-utility" style={{ display: 'flex', alignItems: 'center', padding: '0 6px', height: 40, flexShrink: 0, borderRight: '1px solid var(--color-border)', gap: 2 }}>
          <Tooltip title="打开目录"><Button aria-label="打开目录" size="small" icon={<AppstoreOutlined />} onClick={onShowTree} /></Tooltip>
          <Tooltip title="查看大纲"><Button aria-label="查看大纲" size="small" icon={<ReadOutlined />} onClick={onShowOutline} /></Tooltip>
          <Tooltip title={showToolbar ? '隐藏工具栏' : '显示工具栏'}><Button aria-label={showToolbar ? '隐藏工具栏' : '显示工具栏'} size="small" {...toolbarButtonProps(!showToolbar)} onClick={onToggleToolbar} icon={<AlignLeftOutlined />} /></Tooltip>
        </div>
      )}
      {files.map((file, index) => {
        const name = file.split('/').pop() || file
        const active = file === activeFile
        const hasSaveError = Boolean(saveErrors[file])
        const hasUnsavedChanges = Boolean(isDirty[file])
        return (
          <div key={file} className={`document-tab${active ? ' is-active' : ''}`} title={file} onClick={() => onOpenFile(file, name)}
            onContextMenu={event => onTabContextMenu(file, event)}
            style={{ cursor: 'pointer', borderRight: '1px solid var(--color-border)' }}>
            <button type="button" className="document-tab-select" role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
              aria-label={`${name}${hasSaveError ? '，保存失败' : hasUnsavedChanges ? '，修改待保存' : ''}`}
              onKeyDown={event => {
                let nextIndex = index
                if (event.key === 'ArrowRight') nextIndex = (index + 1) % files.length
                else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + files.length) % files.length
                else if (event.key === 'Home') nextIndex = 0
                else if (event.key === 'End') nextIndex = files.length - 1
                else return
                event.preventDefault()
                event.currentTarget.closest('.document-tabs')?.querySelectorAll('[role="tab"]')[nextIndex]?.focus()
                const nextFile = files[nextIndex]
                onOpenFile(nextFile, nextFile.split('/').pop() || nextFile)
              }}>
              <FileOutlined aria-hidden="true" />
              <span className="document-tab-title">{name}</span>
            </button>
            {hasSaveError ? (
              <Tooltip title="保存失败">
                <span className="tab-status-label is-error" aria-label="保存失败">失败</span>
              </Tooltip>
            ) : hasUnsavedChanges ? (
              <Tooltip title="修改待保存">
                <span className="tab-status-label is-modified" aria-label="修改待保存">未保存</span>
              </Tooltip>
            ) : null}
            <button type="button" className="tab-close" aria-label={`关闭 ${name}`} title={`关闭 ${name}`} onClick={event => onCloseFile(file, event)}>
              <CloseOutlined aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
