import { useRef, useState } from 'react'
import { Button, Checkbox, InputNumber, Popover } from 'antd'
import { TableOutlined } from '@ant-design/icons'

const MAX_ROWS = 20
const MAX_COLUMNS = 12

export function TableInsertButton({ editor, buttonProps = {}, onInsert }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState(3)
  const [cols, setCols] = useState(3)
  const [activeCell, setActiveCell] = useState([0, 0])
  const [header, setHeader] = useState(true)
  const triggerRef = useRef(null)
  const cellRefs = useRef([])
  const insert = (selectedRows = rows, selectedCols = cols) => {
    editor?.chain().focus().insertTable({ rows: selectedRows, cols: selectedCols, withHeaderRow: header }).run()
    onInsert?.()
    setOpen(false)
  }
  const selectCell = (row, column) => {
    setRows(row + 1)
    setCols(column + 1)
  }
  const moveCellFocus = (row, column) => {
    const nextRow = Math.max(0, Math.min(7, row))
    const nextColumn = Math.max(0, Math.min(7, column))
    setActiveCell([nextRow, nextColumn])
    selectCell(nextRow, nextColumn)
    requestAnimationFrame(() => cellRefs.current[nextRow * 8 + nextColumn]?.focus())
  }
  const handleGridKeyDown = event => {
    const [row, column] = activeCell
    if (event.key === 'ArrowUp') { event.preventDefault(); moveCellFocus(row - 1, column) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); moveCellFocus(row + 1, column) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); moveCellFocus(row, column - 1) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); moveCellFocus(row, column + 1) }
    else if (event.key === 'Home') { event.preventDefault(); moveCellFocus(event.ctrlKey || event.metaKey ? 0 : row, 0) }
    else if (event.key === 'End') { event.preventDefault(); moveCellFocus(event.ctrlKey || event.metaKey ? 7 : row, 7) }
  }
  const handlePanelKeyDown = event => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const handleOpenChange = nextOpen => {
    setOpen(nextOpen)
    if (nextOpen) {
      setActiveCell([0, 0])
      requestAnimationFrame(() => cellRefs.current[0]?.focus())
    }
  }
  return <Popover open={open} onOpenChange={handleOpenChange} trigger="click" placement="bottom" autoAdjustOverflow content={
    <div className="table-insert-panel" role="dialog" aria-label="插入表格" onKeyDown={handlePanelKeyDown}>
      <div className="table-insert-title" aria-live="polite">{rows} 行 × {cols} 列</div>
      <div className="table-size-grid" role="group" aria-label="选择表格行列数" onKeyDown={handleGridKeyDown}>
        {Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 }, (_, column) =>
          <button key={`${row}-${column}`} ref={element => { cellRefs.current[row * 8 + column] = element }}
            type="button" className={row < rows && column < cols ? 'is-selected' : ''}
            aria-label={`${row + 1} 行 ${column + 1} 列`}
            aria-pressed={row < rows && column < cols}
            tabIndex={activeCell[0] === row && activeCell[1] === column ? 0 : -1}
            onMouseEnter={() => selectCell(row, column)}
            onFocus={() => { setActiveCell([row, column]); selectCell(row, column) }}
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
    <Button ref={triggerRef} aria-label="插入表格" aria-haspopup="dialog" aria-expanded={open} icon={<TableOutlined />} {...buttonProps} />
  </Popover>
}
