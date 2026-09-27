import { useState } from 'react'
import { Button, Checkbox, InputNumber, Popover } from 'antd'
import { TableOutlined } from '@ant-design/icons'

const MAX_ROWS = 20
const MAX_COLUMNS = 12

export function TableInsertButton({ editor, buttonProps = {}, onInsert }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState(3)
  const [cols, setCols] = useState(3)
  const [header, setHeader] = useState(true)
  const insert = (selectedRows = rows, selectedCols = cols) => {
    editor?.chain().focus().insertTable({ rows: selectedRows, cols: selectedCols, withHeaderRow: header }).run()
    onInsert?.()
    setOpen(false)
  }
  return <Popover open={open} onOpenChange={setOpen} trigger="click" placement="bottomLeft" content={
    <div className="table-insert-panel">
      <div className="table-insert-title" aria-live="polite">{rows} 行 × {cols} 列</div>
      <div className="table-size-grid" role="group" aria-label="选择表格行列数">
        {Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 }, (_, column) =>
          <button key={`${row}-${column}`} type="button" className={row < rows && column < cols ? 'is-selected' : ''}
            aria-label={`${row + 1} 行 ${column + 1} 列`}
            onMouseEnter={() => { setRows(row + 1); setCols(column + 1) }}
            onFocus={() => { setRows(row + 1); setCols(column + 1) }}
            onClick={() => insert(row + 1, column + 1)} />
        ))}
      </div>
      <div className="table-size-fields">
        <label>行 <InputNumber aria-label="表格行数" min={1} max={MAX_ROWS} value={rows} onChange={value => setRows(value || 1)} /></label>
        <label>列 <InputNumber aria-label="表格列数" min={1} max={MAX_COLUMNS} value={cols} onChange={value => setCols(value || 1)} /></label>
      </div>
      <Checkbox checked={header} onChange={event => setHeader(event.target.checked)}>首行为表头</Checkbox>
      <Button size="small" type="primary" onClick={() => insert()}>插入表格</Button>
    </div>
  }>
    <Button aria-label="插入表格" icon={<TableOutlined />} {...buttonProps} />
  </Popover>
}

export function TableContextTools({ editor, visible }) {
  if (!visible || !editor?.isActive('table')) return null
  const actions = [
    ['上方增行', 'addRowBefore'], ['下方增行', 'addRowAfter'],
    ['左侧增列', 'addColumnBefore'], ['右侧增列', 'addColumnAfter'],
    ['删除行', 'deleteRow'], ['删除列', 'deleteColumn'], ['删除表格', 'deleteTable'],
  ]
  return <div className="table-context-tools" role="toolbar" aria-label="表格行列操作">
    {actions.map(([label, command]) => <Button key={command} size="small" aria-label={label}
      disabled={!editor.can().chain().focus()[command]().run()}
      onClick={() => editor.chain().focus()[command]().run()}>{label}</Button>)}
  </div>
}
