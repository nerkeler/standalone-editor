import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Button, Input, Modal, Spin } from 'antd'
import { ArrowUpOutlined, FolderOutlined, RightOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api'
import { isPermissionDenied } from '../requestErrorMessage'

const DIRS_API = '/api/dirs'

const knownDirectoryErrors = {
  SAVED_WORKSPACE_UNAVAILABLE: '上次记录的工作目录当前不可访问。请重新连接磁盘，或选择其他目录。',
  WORKSPACE_CONFIG_INVALID: '工作目录配置无效。',
  WORKSPACE_CONFIG_UNREADABLE: '无法读取工作目录配置。',
  RECOVERY_ROOT_INSIDE_WORKSPACE: '恢复数据目录位于所选工作目录内部。请调整恢复目录或选择其他目录。',
  WORKSPACE_INSIDE_RECOVERY_ROOT: '所选工作目录位于恢复数据目录内部。请调整恢复目录或选择其他目录。',
}

function getErrorMessage(error, fallback = '无法读取此目录') {
  const payload = error?.response?.data || {}
  const detail = knownDirectoryErrors[payload.code || payload.errorCode]
    || payload.error
    || payload.message
  if (detail) return detail
  if (!error?.response && (error?.isAxiosError || error?.request)) return '无法连接后端，请检查服务后重试。'
  if (error?.response) return '后端未能读取目录，请稍后重试。'
  return error?.message || fallback
}

function getConciseErrorSummary(detail, action) {
  const firstClause = String(detail || '').trim().replace(/\s+/g, ' ').split(/[。；;]/u, 1)[0]
  if (!firstClause) return `无法完成目录操作；${action}`
  const characters = Array.from(firstClause)
  const prefix = characters.slice(0, 10).join('')
  return `${prefix}${characters.length > 10 ? '…' : ''}；${action}`
}

function trimTerminalPunctuation(value) {
  return String(value || '').replace(/[。；;，,、!?！？\s]+$/u, '')
}

function getNavigationErrorSummary(error, detail) {
  const payload = error?.response?.data || {}
  const code = payload.code || payload.errorCode || payload.systemCode || error?.code
  const status = error?.response?.status

  if (isPermissionDenied(error) || status === 403) return '无权限读取此目录，请选择其他目录。'
  if (['RECOVERY_ROOT_INSIDE_WORKSPACE', 'WORKSPACE_INSIDE_RECOVERY_ROOT'].includes(code)) {
    return '此目录与恢复数据冲突，请换目录。'
  }
  if (code === 'SAVED_WORKSPACE_UNAVAILABLE') return '上次工作目录不可访问，请重新连接磁盘或换目录。'
  if (code === 'WORKSPACE_CONFIG_INVALID') return '工作目录配置无效，请重新选择。'
  if (code === 'WORKSPACE_CONFIG_UNREADABLE') return '无法读取工作目录配置，请重新选择。'
  if (status === 404 || ['ENOENT', 'ENOTDIR', 'PATH_NOT_FOUND', 'DIRECTORY_NOT_FOUND'].includes(code)) {
    return '目录不存在，请检查路径后重试。'
  }
  if (/不存在|找不到|不是目录|no such file|not found|ENOTDIR/i.test(detail)) {
    return '目录不存在或路径无效，请检查后重试。'
  }
  if (/无权限|无权|权限不足|permission denied|access denied|EACCES|EPERM|EROFS|PERMISSION_DENIED/i.test(detail)) {
    return '无权限读取此目录，请选择其他目录。'
  }
  if (status >= 500) return '后端未能读取目录，请稍后重试。'
  if (!error?.response && (error?.isAxiosError || error?.request)) return '无法连接后端，请检查服务后重试。'
  return getConciseErrorSummary(detail, '请检查路径后重试')
}

function getTransactionErrorSummary(detail) {
  const message = String(detail || '')
  if (/草稿|保存失败|保存冲突/u.test(message)) return '草稿未保存，请先处理保存失败或冲突。'
  if (/RECOVERY_ROOT_INSIDE_WORKSPACE|WORKSPACE_INSIDE_RECOVERY_ROOT|恢复数据目录|恢复目录/u.test(message)) {
    return '此目录与恢复数据冲突，请换目录。'
  }
  if (/上次.*工作目录.*不可访问/u.test(message)) return '上次工作目录不可访问，请重新连接磁盘或换目录。'
  if (/无权限|无权|权限不足|permission denied|access denied|EACCES|EPERM|EROFS|PERMISSION_DENIED/i.test(message)) {
    return '无权限设置此工作目录，请选择其他目录。'
  }
  if (/工作目录配置无效/u.test(message)) return '工作目录配置无效，请重新选择。'
  if (/无法读取工作目录配置/u.test(message)) return '无法读取工作目录配置，请重新选择。'
  if (/无法确认工作目录设置结果/u.test(message)) return '目录验证未通过，请重新选择。'
  if (/无法确认切换结果/u.test(message)) return '切换结果未确认，请重试或换目录。'
  if (/无法连接后端|Network Error|ECONN|ETIMEDOUT/i.test(message)) {
    return '无法连接后端，请检查服务后重试。'
  }
  return getConciseErrorSummary(message, '请重试或选择其他目录')
}

export default function WorkspacePickerModal({
  open,
  initialPath = '',
  locked = false,
  operationMessage = '',
  transactionError = '',
  onClearTransactionError,
  onCancel,
  onConfirm,
}) {
  const [directory, setDirectory] = useState(null)
  const [address, setAddress] = useState('')
  const [navigationState, setNavigationState] = useState('idle')
  const [navigationError, setNavigationError] = useState('')
  const [navigationErrorSummary, setNavigationErrorSummary] = useState('')
  const [retryPath, setRetryPath] = useState(null)
  const [loadingVisible, setLoadingVisible] = useState(false)
  const requestSeqRef = useRef(0)
  const abortRef = useRef(null)
  const loadingTimerRef = useRef(null)
  const confirmInFlightRef = useRef(false)

  const abortNavigation = useCallback(() => {
    requestSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current)
    loadingTimerRef.current = null
    setLoadingVisible(false)
  }, [])

  const loadDirectory = useCallback(async rawPath => {
    const path = typeof rawPath === 'string' ? rawPath : ''
    abortRef.current?.abort()
    onClearTransactionError?.()
    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current)
    const requestId = ++requestSeqRef.current
    const controller = new AbortController()
    abortRef.current = controller
    setAddress(path)
    setNavigationState('loading')
    setNavigationError('')
    setNavigationErrorSummary('')
    setRetryPath(path)
    setLoadingVisible(false)
    loadingTimerRef.current = setTimeout(() => {
      if (requestId === requestSeqRef.current) setLoadingVisible(true)
    }, 120)

    const url = path === '' ? DIRS_API : `${DIRS_API}?path=${encodeURIComponent(path)}`
    try {
      const response = await api.get(url, { signal: controller.signal })
      if (requestId !== requestSeqRef.current) return false
      const nextDirectory = response.data
      if (!nextDirectory || typeof nextDirectory.path !== 'string') {
        throw new Error('后端没有返回有效目录路径')
      }
      setDirectory(nextDirectory)
      setAddress(nextDirectory.path)
      setNavigationState('ready')
      setNavigationError('')
      setNavigationErrorSummary('')
      setRetryPath(null)
      return true
    } catch (error) {
      if (requestId !== requestSeqRef.current || error?.code === 'ERR_CANCELED') return false
      setNavigationState('error')
      const detail = getErrorMessage(error)
      setNavigationError(detail)
      setNavigationErrorSummary(getNavigationErrorSummary(error, detail))
      setAddress(path)
      setRetryPath(path)
      return false
    } finally {
      if (requestId === requestSeqRef.current) {
        if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current)
        loadingTimerRef.current = null
        abortRef.current = null
        setLoadingVisible(false)
      }
    }
  }, [onClearTransactionError])

  useLayoutEffect(() => {
    if (!open) {
      abortNavigation()
      return undefined
    }

    setDirectory(null)
    setAddress('')
    setNavigationState('idle')
    setNavigationError('')
    setNavigationErrorSummary('')
    setRetryPath(null)
    loadDirectory(initialPath || '')

    document.body.classList.add('workspace-picker-open')
    return () => {
      document.body.classList.remove('workspace-picker-open')
      abortNavigation()
    }
  }, [abortNavigation, initialPath, loadDirectory, open])

  const handleAddressChange = event => {
    const value = event.target.value
    const interruptedLoad = navigationState === 'loading'
    const cameFromError = navigationState === 'error'
    if (interruptedLoad) abortNavigation()
    onClearTransactionError?.()
    setAddress(value)
    setNavigationError('')
    setNavigationErrorSummary('')
    setRetryPath(null)
    const canReuseVerifiedDirectory = value === directory?.path && !interruptedLoad && !cameFromError
    setNavigationState(canReuseVerifiedDirectory ? 'ready' : directory ? 'edited' : 'idle')
  }

  const handleOpenPath = () => {
    if (locked || navigationState === 'loading') return
    loadDirectory(address)
  }

  const handleGoUp = () => {
    if (locked || navigationState === 'loading' || !directory?.canGoUp || !directory.parent) return
    loadDirectory(directory.parent)
  }

  const shortcuts = (directory?.locations?.length ? directory.locations : directory?.roots || [])
    .filter(location => location.canNavigate !== false)
  const folders = (directory?.entries || [])
    .filter(entry => entry.type === 'dir' && entry.canNavigate !== false)
  const pathIsLoaded = navigationState === 'ready'
    && directory
    && address === directory.path
  const isReady = Boolean(open && pathIsLoaded && directory.canSelect === true)
  const isBusy = navigationState === 'loading'
  const canClose = !locked

  const handleConfirm = async () => {
    if (!isReady || locked || confirmInFlightRef.current) return
    confirmInFlightRef.current = true
    try {
      await onConfirm?.(directory)
    } finally {
      confirmInFlightRef.current = false
    }
  }

  let statusText = ''
  let statusDetail = ''
  let statusKind = 'neutral'
  if (operationMessage) {
    statusText = operationMessage
  } else if (transactionError) {
    statusText = getTransactionErrorSummary(transactionError)
    statusDetail = transactionError
    statusKind = 'error'
  } else if (navigationError) {
    statusText = directory && directory.path !== address
      ? `${trimTerminalPunctuation(navigationErrorSummary)}；列表仍显示旧目录。`
      : navigationErrorSummary
    statusDetail = directory && directory.path !== address
      ? `${trimTerminalPunctuation(navigationError)}；下方列表仍显示 ${directory.path}`
      : navigationError
    statusKind = 'error'
  } else if (navigationState === 'edited') {
    statusText = directory && directory.path !== address
      ? `路径尚未验证；下方列表仍显示 ${directory.path}`
      : '路径有更改，请打开路径验证后再使用。'
  } else if (directory && pathIsLoaded && directory.canSelect !== true && folders.length > 0) {
    statusText = '此位置仅供浏览，请进入工作目录。'
  } else if (isBusy && loadingVisible) {
    statusText = directory && directory.path !== address
      ? `正在读取 ${address || '默认目录'}…；下方列表仍显示 ${directory.path}`
      : `正在读取 ${address || '默认目录'}…`
  } else if (directory && directory.path !== address) {
    statusText = `下方列表仍显示 ${directory.path}`
  } else if (!directory && isBusy && loadingVisible) {
    statusText = '正在读取目录…'
  }

  return (
    <Modal
      rootClassName="workspace-picker-modal"
      data-current-path={directory?.path}
      centered
      title="选择工作目录"
      open={open}
      destroyOnHidden
      onCancel={() => { if (canClose) onCancel?.() }}
      closable={canClose}
      maskClosable={canClose}
      keyboard={canClose}
      width="min(640px, calc(100vw - 24px))"
      footer={(
        <div className="workspace-picker-footer">
          <Button
            aria-label="取消选择工作目录"
            onClick={onCancel}
            disabled={locked}
          >
            取消
          </Button>
          <Button
            type="primary"
            aria-label="使用当前目录"
            onClick={handleConfirm}
            disabled={!isReady || locked}
            loading={locked}
          >
            使用此目录
          </Button>
        </div>
      )}
    >
      <div className="workspace-picker-body">
        <div className="workspace-picker-controls">
          <div className="workspace-picker-address-row" role="group" aria-label="目录路径导航">
            <Button
              className="workspace-picker-up"
              icon={<ArrowUpOutlined aria-hidden="true" />}
              onClick={handleGoUp}
              disabled={locked || isBusy || !directory?.canGoUp || !directory?.parent}
              aria-label="返回上级目录"
              title="上一级"
            >
              <span>上一级</span>
            </Button>
            <Input
              className="workspace-picker-current-path"
              aria-label="目录路径"
              value={address}
              onChange={handleAddressChange}
              onPressEnter={handleOpenPath}
              disabled={locked}
              autoComplete="off"
              spellCheck={false}
              placeholder="输入服务器上的完整目录路径"
            />
            <Button
              className="workspace-picker-open-path"
              onClick={handleOpenPath}
              disabled={locked || isBusy}
              aria-label="打开路径"
            >
              打开路径
            </Button>
          </div>

          <div className="workspace-picker-shortcut-list" role="group" aria-label="快捷访问位置">
            {shortcuts.map(location => (
              <Button
                key={location.path}
                className="workspace-picker-shortcut"
                disabled={locked || isBusy || location.canNavigate === false || location.path === directory?.path}
                title={location.path}
                aria-label={location.path === directory?.path ? `当前位置 ${location.path}` : `打开位置 ${location.path}`}
                aria-current={location.path === directory?.path ? 'location' : undefined}
                data-path={location.path}
                onClick={() => loadDirectory(location.path)}
              >
                <code>{location.path}</code>
              </Button>
            ))}
          </div>

          <div
            className={`workspace-picker-status is-${statusKind}`}
            role={statusKind === 'error' ? 'alert' : 'status'}
            aria-live={statusKind === 'error' ? 'assertive' : 'polite'}
          >
            <span
              className="workspace-picker-status-text"
              title={statusDetail || undefined}
              aria-label={statusDetail ? `${statusText} 错误详情：${statusDetail}` : undefined}
              tabIndex={statusDetail ? 0 : undefined}
            >
              {statusText}
            </span>
            {navigationError && retryPath !== null && (
              <Button
                size="small"
                icon={<ReloadOutlined aria-hidden="true" />}
                onClick={() => loadDirectory(retryPath)}
                disabled={locked || isBusy}
              >
                重试读取
              </Button>
            )}
            {isBusy && loadingVisible && <Spin size="small" aria-label="正在读取目录" />}
          </div>
        </div>

        <div className="workspace-picker-list" role="group" aria-label="当前目录内容" aria-busy={isBusy ? 'true' : 'false'}>
          {folders.length > 0 ? folders.map(entry => (
            <button
              key={entry.path}
              type="button"
              className="welcome-directory-entry"
              data-path={entry.path}
              disabled={locked || isBusy}
              aria-label={`打开文件夹 ${entry.name}`}
              onClick={() => loadDirectory(entry.path)}
            >
              <FolderOutlined aria-hidden="true" className="workspace-picker-folder-icon" />
              <span className="workspace-picker-folder-name">{entry.name}</span>
              <RightOutlined aria-hidden="true" className="workspace-picker-row-chevron" />
            </button>
          )) : directory && pathIsLoaded ? (
            <div className="workspace-picker-empty">
              {directory.canSelect === true
                ? '此目录中没有可浏览的子文件夹，可以使用当前目录。'
                : '此位置仅供浏览，请进入工作目录。'}
            </div>
          ) : !directory && isBusy ? (
            <div className="workspace-picker-initial-loading" aria-hidden="true">
              <span /><span /><span />
            </div>
          ) : !directory && navigationError ? (
            <div className="workspace-picker-empty">无法读取此位置。请修正路径或重试。</div>
          ) : directory ? (
            <div className="workspace-picker-empty">此目录中没有可浏览的子文件夹。</div>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
