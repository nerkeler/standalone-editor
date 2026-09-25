import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Modal, Tag, message } from 'antd'
import { DeleteOutlined, HistoryOutlined, ReloadOutlined } from '@ant-design/icons'
import { api as axios } from '../api'
import './OrphanHistoryManager.css'

const API = '/api/workspace'

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = -1
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unitIndex]}`
}

function isValidRestorePath(value) {
  const target = String(value || '').trim()
  if (!target || target.startsWith('/') || target.includes('\\') || target.includes('\0')) return false
  if (!/\.(?:md|markdown)$/i.test(target)) return false
  return target.split('/').every(part => part && part !== '.' && part !== '..')
}

function orphanReasonLabel(reason) {
  if (reason === 'trash') return '文件移入回收站时归档'
  if (reason === 'path-reused') return '原路径被新文件复用时归档'
  return reason ? '已归档' : ''
}

export default function OrphanHistoryManager({ onChange }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState([])
  const [expandedId, setExpandedId] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewLoadingId, setPreviewLoadingId] = useState('')
  const [restoreSelection, setRestoreSelection] = useState(null)
  const [restorePath, setRestorePath] = useState('')
  const [mutating, setMutating] = useState(false)

  const loadOrphans = useCallback(async () => {
    setLoading(true)
    try {
      const response = await axios.get(`${API}/recovery/history`)
      setItems(Array.isArray(response.data?.items) ? response.data.items : [])
      return true
    } catch (error) {
      message.error(`读取已删除文件的历史失败：${error.response?.data?.error || error.message}`)
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadOrphans() }, [loadOrphans])

  const openManager = useCallback(() => {
    setOpen(true)
  }, [])

  const handlePreview = useCallback(async (orphan, entry) => {
    const key = `${orphan.id}:${entry.id}`
    setPreviewLoadingId(key)
    try {
      const response = await axios.get(`${API}/recovery/history/content`, {
        params: { orphanId: orphan.id, historyId: entry.id },
      })
      setPreview({ key, path: orphan.path, entry, content: response.data?.content ?? '' })
    } catch (error) {
      message.error(`读取历史版本失败：${error.response?.data?.error || error.message}`)
    } finally {
      setPreviewLoadingId('')
    }
  }, [])

  const handleSelectRestore = useCallback((orphan, entry) => {
    setExpandedId(orphan.id)
    setRestoreSelection({ orphan, entry })
    setRestorePath(orphan.path)
  }, [])

  const restoreSelected = useCallback(async expectedRevision => {
    const selection = restoreSelection
    const target = restorePath.trim()
    if (!selection || !isValidRestorePath(target)) {
      message.error('请输入工作区内的 Markdown 相对路径，例如 notes.md')
      return
    }
    setMutating(true)
    try {
      await axios.post(`${API}/recovery/history/restore`, {
        orphanId: selection.orphan.id,
        historyId: selection.entry.id,
        path: target,
        expectedRevision,
      })
      message.success(`已将历史版本恢复到 ${target}`)
      setRestoreSelection(null)
      setPreview(null)
      await Promise.all([loadOrphans(), onChange?.({ type: 'restore', path: target })])
    } catch (error) {
      const code = error.response?.data?.code
      const detail = error.response?.data?.error || error.message
      if (code === 'FILE_CONFLICT') {
        message.error(`目标文件在确认后发生变化，未覆盖任何内容。请重新检查后再恢复：${detail}`)
      } else {
        message.error(`恢复历史版本失败：${detail}`)
      }
    } finally {
      setMutating(false)
    }
  }, [loadOrphans, onChange, restorePath, restoreSelection])

  const handleRestore = useCallback(async () => {
    const target = restorePath.trim()
    if (!restoreSelection || !isValidRestorePath(target)) {
      message.error('请输入工作区内的 Markdown 相对路径，例如 notes.md')
      return
    }

    try {
      const current = await axios.get(`${API}/file`, { params: { path: target } })
      const expectedRevision = current.data?.revision
      if (typeof expectedRevision !== 'string') {
        message.error('无法确认目标文件版本，未执行恢复')
        return
      }
      Modal.confirm({
        title: `覆盖当前文件「${target}」？`,
        content: '目标文件已经存在。确认后会用所选历史版本替换它；提交时会再次检查文件版本，如果期间有变化则停止，不会覆盖新内容。',
        okText: '确认覆盖并恢复',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => restoreSelected(expectedRevision),
      })
    } catch (error) {
      if (error.response?.status === 404) {
        await restoreSelected(null)
      } else if (['INVALID_UTF8', 'INVALID_TEXT_FILE'].includes(error.response?.data?.code)) {
        message.error('恢复目标已存在，但不是可安全读取的 Markdown 文本。请改选一个新路径。')
      } else {
        message.error(`检查恢复目标失败：${error.response?.data?.error || error.message}`)
      }
    }
  }, [restorePath, restoreSelected, restoreSelection])

  const handleDelete = useCallback(orphan => {
    Modal.confirm({
      title: `永久删除「${orphan.path}」的孤儿历史？`,
      content: `将永久删除该路径下的 ${orphan.history?.length || 0} 个历史版本，且无法恢复。此操作不会修改工作区中的当前文件或回收站项目。`,
      okText: '永久删除这些历史',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setMutating(true)
        try {
          await axios.delete(`${API}/recovery/history`, { params: { id: orphan.id } })
          message.success(`已永久删除「${orphan.path}」的历史版本`)
          setExpandedId(current => current === orphan.id ? '' : current)
          setPreview(current => current?.key.startsWith(`${orphan.id}:`) ? null : current)
          setRestoreSelection(current => current?.orphan.id === orphan.id ? null : current)
          await Promise.all([loadOrphans(), onChange?.({ type: 'delete-history', path: orphan.path })])
        } catch (error) {
          message.error(`永久删除孤儿历史失败：${error.response?.data?.error || error.message}`)
        } finally {
          setMutating(false)
        }
      },
    })
  }, [loadOrphans, onChange])

  return (
    <>
      <div className="orphan-history-entry">
        <div>
          <strong>已删除文件的历史版本</strong>
          <span>文件移入回收站后，其历史版本会保留在这里，可预览、恢复或单独清理。</span>
        </div>
        <Button aria-label="管理已删除文件历史" icon={<HistoryOutlined />} onClick={openManager}>
          管理历史（{items.length}）
        </Button>
      </div>

      <Modal
        title={`已删除文件的历史版本（${items.length}）`}
        open={open}
        onCancel={() => setOpen(false)}
        footer={<Button onClick={() => setOpen(false)}>关闭</Button>}
        width="min(900px, 94vw)"
      >
        <div className="orphan-history-toolbar">
          <span>这些版本不会被同名新文件继承。恢复时请选择工作区内的目标路径。</span>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={loadOrphans}>刷新</Button>
        </div>
        {loading && items.length === 0 ? (
          <div role="status" className="orphan-history-empty">正在读取孤儿历史…</div>
        ) : items.length === 0 ? (
          <div className="orphan-history-empty">当前没有孤儿历史</div>
        ) : (
          <div className="orphan-history-list">
            {items.map(orphan => {
              const expanded = expandedId === orphan.id
              const entries = Array.isArray(orphan.history) ? orphan.history : []
              return (
                <section className="orphan-history-card" key={orphan.id}>
                  <div className="orphan-history-card-head">
                    <div className="orphan-history-summary">
                      <strong title={orphan.path}>{orphan.path}</strong>
                      <div className="orphan-history-meta">
                        <Tag color={orphan.pathExists ? 'gold' : 'default'}>
                          {orphan.pathExists ? '原路径已有文件' : '原路径不存在'}
                        </Tag>
                        <span>{entries.length} 个版本</span>
                        {orphan.reason && <span>· {orphanReasonLabel(orphan.reason)}</span>}
                        {orphan.createdAt && <span>· 归档于 {new Date(orphan.createdAt).toLocaleString()}</span>}
                      </div>
                    </div>
                    <div className="orphan-history-actions">
                      <Button size="small" onClick={() => setExpandedId(expanded ? '' : orphan.id)}>
                        {expanded ? '收起版本' : '查看版本'}
                      </Button>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={mutating}
                        aria-label={`永久删除孤儿历史 ${orphan.path}`}
                        onClick={() => handleDelete(orphan)}
                      >永久删除历史</Button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="orphan-history-entries">
                      {entries.length === 0 ? (
                        <div className="orphan-history-empty">没有可用版本</div>
                      ) : entries.map(entry => {
                        const key = `${orphan.id}:${entry.id}`
                        return (
                          <div className="orphan-history-version" key={entry.id}>
                            <div className="orphan-history-version-meta">
                              <strong>{new Date(entry.savedAt).toLocaleString()}</strong>
                              <span>{formatBytes(entry.size)}</span>
                              {entry.revision && <code title={entry.revision}>{entry.revision.slice(0, 12)}</code>}
                              {entry.sourcePath && entry.sourcePath !== orphan.path && <span>来源：{entry.sourcePath}</span>}
                            </div>
                            <div className="orphan-history-actions">
                              <Button size="small" loading={previewLoadingId === key} onClick={() => handlePreview(orphan, entry)}>预览内容</Button>
                              <Button size="small" type="primary" disabled={mutating} onClick={() => handleSelectRestore(orphan, entry)}>恢复此版本…</Button>
                            </div>
                          </div>
                        )
                      })}

                      {preview?.key.startsWith(`${orphan.id}:`) && (
                        <div className="orphan-history-preview">
                          <div className="orphan-history-preview-heading">{preview.path} · {new Date(preview.entry.savedAt).toLocaleString()}</div>
                          <Input.TextArea readOnly value={preview.content} autoSize={{ minRows: 6, maxRows: 16 }} aria-label={`孤儿历史预览 ${orphan.path}`} />
                        </div>
                      )}

                      {restoreSelection?.orphan.id === orphan.id && (
                        <div className="orphan-history-restore">
                          <label htmlFor={`orphan-restore-path-${orphan.id}`}>恢复目标路径</label>
                          <Input
                            id={`orphan-restore-path-${orphan.id}`}
                            value={restorePath}
                            onChange={event => setRestorePath(event.target.value)}
                            placeholder="工作区相对路径，例如 archive/note.md"
                            aria-label={`恢复目标路径 ${orphan.path}`}
                          />
                          <div className="orphan-history-restore-hint">
                            {orphan.pathExists
                              ? '原路径已有文件。继续时会先提示覆盖，并校验文件版本；若目标在确认期间变化，恢复会取消。'
                              : '原路径当前不存在；如改用已有文件路径，系统会先要求明确确认覆盖。'}
                          </div>
                          <div className="orphan-history-actions">
                            <Button onClick={() => setRestoreSelection(null)}>取消</Button>
                            <Button type="primary" loading={mutating} onClick={handleRestore}>恢复到此路径</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </Modal>
    </>
  )
}
