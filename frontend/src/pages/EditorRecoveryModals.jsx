import { Button, Input, Modal } from 'antd'
import OrphanHistoryManager from './OrphanHistoryManager'

export function TrashModal({
  open,
  onClose,
  items,
  statsLoading,
  stats,
  formatBytes,
  onRetryStats,
  mutationBusy,
  loading,
  onPurgeExpired,
  onOrphanHistoryChange,
  onRestore,
  onPermanentlyDelete,
}) {
  return (
    <Modal
      title={`回收站（${items.length}）`}
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      width={640}
    >
      <div className="recovery-stats-panel" aria-label="恢复数据空间统计">
        <div className="recovery-stats-heading">恢复数据占用</div>
        {statsLoading ? (
          <div role="status" className="recovery-stats-status">正在读取空间统计…</div>
        ) : stats ? (
          <>
            <div className="recovery-stats-grid">
              {[
                ['历史版本', stats.history],
                ['回收站', stats.trash],
                ['总计', stats.total],
              ].map(([label, section]) => (
                <div className="recovery-stats-card" key={label} aria-label={`${label}占用`}>
                  <span className="recovery-stats-label">{label}</span>
                  <strong>{Number(section?.items || 0).toLocaleString()} 项</strong>
                  <span className="recovery-stats-bytes">{formatBytes(section?.bytes)} 占用</span>
                </div>
              ))}
            </div>
            {stats.generatedAt && (
              <div className="recovery-stats-generated">统计时间：{new Date(stats.generatedAt).toLocaleString()}</div>
            )}
          </>
        ) : (
          <div className="recovery-stats-error" role="alert">
            <span>空间统计暂不可用，回收站列表仍可操作。</span>
            <Button size="small" onClick={onRetryStats}>重试统计</Button>
          </div>
        )}
      </div>
      <div className="trash-maintenance-row">
        <span>只清理已过期项目；每条也可单独永久删除。</span>
        <Button
          danger
          disabled={mutationBusy || loading || items.length === 0}
          onClick={onPurgeExpired}
        >清理过期项目</Button>
      </div>
      {open && <OrphanHistoryManager onChange={onOrphanHistoryChange} />}
      {loading ? (
        <div role="status" style={{ padding: 24, textAlign: 'center' }}>正在读取回收站…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>回收站为空</div>
      ) : (
        <div className="trash-items-list">
          {items.map(item => (
            <div key={item.id} className="trash-item-row">
              <div className="trash-item-details">
                <div className="trash-item-path" title={item.path}>{item.path}</div>
                <div className="trash-item-meta">
                  {item.type === 'directory' ? '文件夹' : '文件'} · 移入时间：{new Date(item.createdAt).toLocaleString()}
                  {item.expiresAt && ` · 到期时间：${new Date(item.expiresAt).toLocaleString()}`}
                </div>
              </div>
              <div className="trash-item-actions">
                <Button size="small" type="primary" disabled={mutationBusy} aria-label={`恢复 ${item.path}`} onClick={() => onRestore(item)}>恢复</Button>
                <Button size="small" danger disabled={mutationBusy} aria-label={`永久删除 ${item.path}`} onClick={() => onPermanentlyDelete(item)}>永久删除</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

export function RecoveryAlternativesModal({
  open,
  onClose,
  count,
  alternatives,
  savedContents,
  draftContents,
  onUseAlternative,
}) {
  return (
    <Modal
      title={`其他本地恢复草稿（${count}）`}
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      width="min(1050px, 94vw)"
    >
      {count === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>没有其他可恢复草稿</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '65vh', overflow: 'auto' }}>
          {Object.entries(alternatives).flatMap(([path, entries]) => entries.map(entry => {
            const currentDraft = savedContents[path] ?? draftContents[path]
            return (
              <section key={`${path}:${entry.id}`} style={{ padding: 12, border: '1px solid var(--color-border)', borderRadius: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <strong style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={path}>{path}</strong>
                  <span style={{ color: 'var(--color-text-secondary)', fontSize: 11, whiteSpace: 'nowrap' }}>
                    {entry.sourceSession === '旧版恢复数据' ? '旧版草稿' : '其他标签页'} · {new Date(entry.snapshot.savedAt).toLocaleString()}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600 }}>
                    当前标签页草稿
                    <Input.TextArea readOnly value={currentDraft ?? '当前标签页还没有本地草稿'} autoSize={{ minRows: 5, maxRows: 12 }} aria-label={`当前草稿 ${path}`} />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600 }}>
                    其他恢复草稿{entry.snapshot.baseRevision ? `（基于 ${entry.snapshot.baseRevision.slice(0, 12)}）` : '（磁盘基线未知）'}
                    <Input.TextArea readOnly value={entry.snapshot.content} autoSize={{ minRows: 5, maxRows: 12 }} aria-label={`其他恢复草稿 ${path}`} />
                  </label>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <Button type="primary" onClick={() => onUseAlternative(path, entry)}>载入并比较磁盘版本</Button>
                </div>
              </section>
            )
          }))}
        </div>
      )}
    </Modal>
  )
}

export function ConflictModal({ conflictReview, onClose, onExport, onReload, onSave }) {
  return (
    <Modal
      title={`文件冲突：${conflictReview?.path || ''}`}
      open={Boolean(conflictReview)}
      onCancel={onClose}
      footer={[
        <Button key="download" onClick={onExport}>下载本地草稿</Button>,
        <Button key="reload" danger disabled={conflictReview?.diskContent == null} onClick={onReload}>丢弃草稿并重载</Button>,
        <Button key="close" type="primary" onClick={onClose}>保留草稿</Button>,
        <Button
          key="save-local"
          disabled={conflictReview?.diskContent == null || conflictReview?.diskRevision == null}
          onClick={() => Modal.confirm({
            title: '采用本地草稿并覆盖当前磁盘内容？',
            content: '确认后会重新读取磁盘版本；只有版本仍与上方比较内容一致时才保存本地草稿。若版本再次变化，保存会停止并刷新比较内容。',
            okText: '确认并保存本地草稿',
            cancelText: '返回比较',
            okButtonProps: { danger: true },
            onOk: onSave,
          })}
        >覆盖磁盘并保存本地草稿</Button>,
      ]}
      width="min(1100px, 94vw)"
    >
      <div style={{ marginBottom: 12, color: 'var(--color-text-secondary)', fontSize: 13 }}>
        请先比较本地草稿与当前磁盘版本。编辑器不会自动合并或覆盖；采用本地草稿前会再次确认，保存也会重新校验磁盘版本并使用条件写入。
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 600 }}>
          本地草稿
          <Input.TextArea readOnly value={conflictReview?.localContent ?? ''} autoSize={{ minRows: 14, maxRows: 24 }} aria-label="本地草稿内容" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 600 }}>
          当前磁盘版本
          <Input.TextArea readOnly value={conflictReview?.diskContent ?? '磁盘文件当前不可读取。请保留并下载本地草稿。'} autoSize={{ minRows: 14, maxRows: 24 }} aria-label="当前磁盘版本内容" />
        </label>
      </div>
    </Modal>
  )
}

export function HistoryModal({ historyModal, onClose, isDirty, fileConflicts, onRestore, onDelete }) {
  const hasUnresolvedDraft = isDirty[historyModal.path] || fileConflicts[historyModal.path]

  return (
    <Modal
      title={`版本历史：${historyModal.path || ''}`}
      open={historyModal.open}
      confirmLoading={historyModal.loading}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      width={640}
    >
      {historyModal.loading ? (
        <div role="status" style={{ padding: 24, textAlign: 'center' }}>正在读取版本历史…</div>
      ) : historyModal.entries.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>暂无可恢复的历史版本</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '60vh', overflow: 'auto' }}>
          {hasUnresolvedDraft && (
            <div role="alert" style={{ padding: 10, color: 'var(--color-warning)', background: 'var(--color-bg-muted)', borderRadius: 6 }}>
              请先保存或处理当前本地草稿，再恢复历史版本。
            </div>
          )}
          {historyModal.entries.map(entry => (
            <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 10, border: '1px solid var(--color-border)', borderRadius: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{new Date(entry.savedAt).toLocaleString()}</div>
                <div title={entry.revision} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)', fontSize: 11 }}>
                  {entry.revision?.slice(0, 16)} · {Number(entry.size || 0).toLocaleString()} 字节
                </div>
              </div>
              <Button
                size="small"
                disabled={Boolean(hasUnresolvedDraft)}
                onClick={() => onRestore(entry)}
              >恢复</Button>
              <Button
                size="small"
                danger
                disabled={historyModal.loading}
                aria-label={`永久删除历史版本 ${historyModal.path} ${entry.id}`}
                onClick={() => onDelete(entry)}
              >删除版本</Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
