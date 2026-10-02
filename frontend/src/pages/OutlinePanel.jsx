import { Button } from 'antd'
import { CloseOutlined } from '@ant-design/icons'

export function OutlineList({ items = [], onSelect, className = '' }) {
  return (
    <div className={`outline-items ${className}`.trim()} role="list">
      {items.length === 0 ? (
        <div className="outline-empty">当前文档还没有标题</div>
      ) : items.map((item, index) => (
        <div role="listitem" key={`${item.pos ?? 'source'}-${index}`}>
          <button
            type="button"
            className="outline-item"
            style={{ paddingInlineStart: 12 + (item.level - 1) * 14 }}
            aria-label={`H${item.level} ${item.text || '无标题'}`}
            title={item.text || '无标题'}
            onClick={() => onSelect?.(item)}
          >
            <span className="outline-level" aria-hidden="true">H{item.level}</span>
            <span>{item.text || '无标题'}</span>
          </button>
        </div>
      ))}
    </div>
  )
}

export default function OutlinePanel({ items, fileName, onSelect, onClose }) {
  return (
    <aside className="outline-panel" aria-label="文档大纲">
      <div className="outline-panel-header">
        <div>
          <span className="outline-panel-title">文档大纲</span>
          {fileName && <span className="outline-panel-file">{fileName}</span>}
        </div>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          aria-label="隐藏右侧大纲"
          title="隐藏右侧大纲"
          onClick={onClose}
        />
      </div>
      <nav className="outline-panel-body" aria-label="标题列表">
        <OutlineList items={items} onSelect={onSelect} />
      </nav>
    </aside>
  )
}
