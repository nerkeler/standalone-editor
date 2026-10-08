import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreOutlined } from '@ant-design/icons'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { cellAround } from '@tiptap/pm/tables'
import ContextActionMenu from './ContextActionMenu'

function asElement(target) {
  if (target?.nodeType === Node.ELEMENT_NODE) return target
  return target?.parentElement || null
}

function nodePositionForDOM(editor, dom, predicate) {
  if (!dom) return null
  const { state, view } = editor
  let mapped
  try { mapped = view.posAtDOM(dom, 0) } catch { mapped = null }
  const candidates = mapped == null ? [] : [mapped, mapped - 1, mapped + 1]
  for (const pos of candidates) {
    if (pos < 0 || pos > state.doc.content.size) continue
    const node = state.doc.nodeAt(pos)
    if (node && predicate(node) && view.nodeDOM(pos) === dom) return pos
  }
  let result = null
  state.doc.descendants((node, pos) => {
    if (predicate(node) && view.nodeDOM(pos) === dom) {
      result = pos
      return false
    }
    return result == null
  })
  return result
}

function tableTargetFromCell(editor, cellPos) {
  const { doc } = editor.state
  const cellNode = doc.nodeAt(cellPos)
  if (!cellNode || !['cell', 'header_cell'].includes(cellNode.type.spec.tableRole)) return null
  const inside = doc.resolve(Math.min(cellPos + 1, doc.content.size))
  let tablePos = null
  for (let depth = inside.depth; depth > 0; depth -= 1) {
    if (inside.node(depth).type.spec.tableRole === 'table') {
      tablePos = inside.before(depth)
      break
    }
  }
  const table = tablePos == null ? null : doc.nodeAt(tablePos)
  if (!table || table.type.spec.tableRole !== 'table') return null
  return { kind: 'table', objectPos: tablePos, node: table, cellPos }
}

function tableTargetAtSelection(editor) {
  const { state } = editor
  const resolved = state.selection.$headCell || cellAround(state.selection.$head)
  return resolved ? tableTargetFromCell(editor, resolved.pos) : null
}

function imageTargetAtSelection(editor) {
  const { selection, doc } = editor.state
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image') return null
  const node = doc.nodeAt(selection.from)
  return node?.type.name === 'image'
    ? { kind: 'image', objectPos: selection.from, node }
    : null
}

function selectedObjectTarget(editor) {
  if (!editor) return null
  return imageTargetAtSelection(editor) || tableTargetAtSelection(editor)
}

function findTableTarget(editor, cell) {
  const cellPos = nodePositionForDOM(editor, cell, node => ['cell', 'header_cell'].includes(node.type.spec.tableRole))
  return cellPos == null ? null : tableTargetFromCell(editor, cellPos)
}

function targetDOM(editor, target) {
  if (!target) return null
  if (target.kind === 'image') {
    const dom = editor.view.nodeDOM(target.objectPos)
    return dom?.nodeType === Node.ELEMENT_NODE ? dom : null
  }
  const cell = editor.view.nodeDOM(target.cellPos)
  if (cell?.nodeType === Node.ELEMENT_NODE) return cell
  const table = editor.view.nodeDOM(target.objectPos)
  return table?.nodeType === Node.ELEMENT_NODE ? table : null
}

function targetMatchesSelection(editor, target) {
  const current = selectedObjectTarget(editor)
  return current?.kind === target.kind && current.objectPos === target.objectPos &&
    (target.kind !== 'table' || current.cellPos === target.cellPos)
}

function clampWidth(value) {
  return Math.max(25, Math.min(100, Math.round(Number(value) / 5) * 5))
}

function ImageWidthControl({ value, onChange, onClose, editor, target }) {
  const inputRef = useRef(null)
  useLayoutEffect(() => { inputRef.current?.focus() }, [])
  return (
    <div className="editor-object-slider" role="group" aria-label="自定义图片宽度">
      <input
        ref={inputRef}
        type="range"
        role="slider"
        min="25"
        max="100"
        step="5"
        value={value}
        aria-label="图片宽度百分比"
        onChange={event => onChange(Number(event.target.value))}
        onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
            event.stopPropagation()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            requestAnimationFrame(() => {
              if (editor.isEditable && editor.state.doc === target.doc) editor.view.focus()
            })
          }
        }}
      />
      <output aria-live="polite">{value}%</output>
    </div>
  )
}

export default function EditorObjectActions({ editor, activeFile, workspaceKey, enabled, isMobile }) {
  const [menu, setMenu] = useState(null)
  const [customWidthOpen, setCustomWidthOpen] = useState(false)
  const [customWidthValue, setCustomWidthValue] = useState(null)
  const [triggerPosition, setTriggerPosition] = useState(null)
  const menuRef = useRef(null)
  const ownImageLayoutScrollUntilRef = useRef(0)
  const userScrollSinceImageChangeRef = useRef(false)
  const latestRef = useRef({ editor, activeFile, workspaceKey, enabled })
  latestRef.current = { editor, activeFile, workspaceKey, enabled }

  const closeMenu = useCallback(() => {
    menuRef.current = null
    setMenu(null)
    setCustomWidthOpen(false)
    setCustomWidthValue(null)
  }, [])

  const isTargetCurrent = useCallback((target, requireOpen = false) => {
    const latest = latestRef.current
    if (!target || !latest.enabled || latest.editor !== target.editor || !target.editor?.isEditable ||
      latest.activeFile !== target.activeFile || latest.workspaceKey !== target.workspaceKey ||
      target.editor.state.doc !== target.doc) return false
    if (requireOpen && menuRef.current?.target !== target) return false
    const current = target.editor.state.doc.nodeAt(target.objectPos)
    return current === target.node && current?.type.name === (target.kind === 'image' ? 'image' : 'table')
  }, [])

  const captureTarget = useCallback((rawTarget, x, y) => {
    if (!enabled || !editor?.isEditable || !rawTarget) return false
    const { state, view } = editor
    const node = state.doc.nodeAt(rawTarget.objectPos)
    if (!node || node !== rawTarget.node || node.type.name !== (rawTarget.kind === 'image' ? 'image' : 'table')) return false
    const target = {
      ...rawTarget,
      editor,
      activeFile,
      workspaceKey,
      doc: state.doc,
      node,
      allowOwnDocChange: false,
    }
    let selection
    if (target.kind === 'image') {
      selection = NodeSelection.create(state.doc, target.objectPos)
    } else {
      const cell = state.doc.nodeAt(target.cellPos)
      if (!cell || !['cell', 'header_cell'].includes(cell.type.spec.tableRole)) return false
      selection = TextSelection.near(state.doc.resolve(Math.min(target.cellPos + 1, state.doc.content.size)), 1)
    }
    if (!selection) return false
    view.dispatch(state.tr.setSelection(selection))
    // This synchronous focus writes the exact selection to the DOM before the
    // menu mounts; the object-only mousedown guard prevents a later ProseMirror
    // mouseup handler from stealing focus back from that menu.
    view.focus()
    const anchor = targetDOM(editor, target)
    const rect = anchor?.getBoundingClientRect()
    const pointX = Number.isFinite(x) ? x : (rect?.left ?? 12) + Math.min(rect?.width ?? 12, 24)
    const pointY = Number.isFinite(y) ? y : (rect?.bottom ?? 12)
    const nextMenu = { x: pointX, y: pointY, target }
    menuRef.current = nextMenu
    setCustomWidthOpen(false)
    setCustomWidthValue(null)
    setMenu(nextMenu)
    return true
  }, [activeFile, editor, enabled, workspaceKey])

  useEffect(() => {
    if (!editor) return undefined
    const dom = editor.view.dom
    let emptyCellTap = null
    const onEmptyCellTouchStart = event => {
      emptyCellTap = null
      if (!enabled || !editor.isEditable || editor.view.composing || event.touches.length !== 1) return
      const cell = asElement(event.target)?.closest('td, th')
      if (!cell || !dom.contains(cell)) return
      const target = findTableTarget(editor, cell)
      const node = target && editor.state.doc.nodeAt(target.cellPos)
      // A blank paragraph has no native text hit target. Some touch browsers
      // keep the previous caret there, which would apply row actions elsewhere.
      if (node?.childCount !== 1 || node.firstChild?.type.name !== 'paragraph' || node.firstChild.content.size !== 0) return
      const touch = event.touches[0]
      emptyCellTap = { cell, id: touch.identifier, x: touch.clientX, y: touch.clientY, time: Date.now(), doc: editor.state.doc }
    }
    const onEmptyCellTouchMove = event => {
      if (!emptyCellTap) return
      const touch = event.touches[0]
      if (event.touches.length !== 1 || touch.identifier !== emptyCellTap.id ||
        Math.hypot(touch.clientX - emptyCellTap.x, touch.clientY - emptyCellTap.y) > 8) emptyCellTap = null
    }
    const onEmptyCellTouchEnd = event => {
      const tap = emptyCellTap
      emptyCellTap = null
      if (!tap || event.touches.length || event.changedTouches.length !== 1 ||
        !enabled || !editor.isEditable || editor.view.composing || editor.state.doc !== tap.doc) return
      const touch = event.changedTouches[0]
      if (touch.identifier !== tap.id || Date.now() - tap.time > 400 ||
        Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > 8 ||
        !dom.contains(tap.cell)) return
      const target = findTableTarget(editor, tap.cell)
      if (!target) return
      // Handle only a short stationary tap; scrolling and long press keep
      // their browser behavior. No content change or history entry is added.
      event.preventDefault()
      const { state, view } = editor
      view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(target.cellPos + 1), 1)))
      view.focus()
    }
    const cancelEmptyCellTap = () => { emptyCellTap = null }
    const onObjectMouseDownCapture = event => {
      if (event.button !== 2 || !enabled || !editor.isEditable) return
      const element = asElement(event.target)
      const imageDOM = element?.closest('img')
      const cell = element?.closest('td, th')
      if ((imageDOM && dom.contains(imageDOM)) || (cell && dom.contains(cell))) event.stopPropagation()
    }
    const onContextMenu = event => {
      if (!enabled || !editor.isEditable) return
      const element = asElement(event.target)
      const imageDOM = element?.closest('img')
      if (imageDOM && dom.contains(imageDOM)) {
        const pos = nodePositionForDOM(editor, imageDOM, node => node.type.name === 'image')
        const node = pos == null ? null : editor.state.doc.nodeAt(pos)
        if (node && captureTarget({ kind: 'image', objectPos: pos, node }, event.clientX, event.clientY)) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      const cell = element?.closest('td, th')
      if (cell && dom.contains(cell)) {
        const target = findTableTarget(editor, cell)
        if (target && captureTarget(target, event.clientX, event.clientY)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
    }
    const onContextKey = event => {
      if (!enabled || !editor.isEditable || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10') || event.keyCode === 93)) return
      const target = selectedObjectTarget(editor)
      if (!target) return
      if (captureTarget(target)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    dom.addEventListener('mousedown', onObjectMouseDownCapture, true)
    dom.addEventListener('contextmenu', onContextMenu)
    dom.addEventListener('keydown', onContextKey)
    dom.addEventListener('touchstart', onEmptyCellTouchStart, { passive: true })
    dom.addEventListener('touchmove', onEmptyCellTouchMove, { passive: true })
    dom.addEventListener('touchend', onEmptyCellTouchEnd, { passive: false })
    dom.addEventListener('touchcancel', cancelEmptyCellTap)
    return () => {
      dom.removeEventListener('mousedown', onObjectMouseDownCapture, true)
      dom.removeEventListener('contextmenu', onContextMenu)
      dom.removeEventListener('keydown', onContextKey)
      dom.removeEventListener('touchstart', onEmptyCellTouchStart)
      dom.removeEventListener('touchmove', onEmptyCellTouchMove)
      dom.removeEventListener('touchend', onEmptyCellTouchEnd)
      dom.removeEventListener('touchcancel', cancelEmptyCellTap)
    }
  }, [captureTarget, editor, enabled])

  useEffect(() => {
    if (!editor) return undefined
    const scroll = editor.view.dom.closest('.editor-scroll')
    const closeOnViewportChange = event => {
      if (asElement(event?.target)?.closest('.editor-context-menu')) return
      if (event?.type === 'scroll' && event.target === scroll &&
        Date.now() < ownImageLayoutScrollUntilRef.current && !userScrollSinceImageChangeRef.current) return
      closeMenu()
    }
    const markUserScrollIntent = event => {
      if (Date.now() >= ownImageLayoutScrollUntilRef.current) return
      const element = asElement(event?.target)
      if (element?.closest('.editor-context-menu')) return
      if (event.type === 'pointerdown' && (!element || !scroll?.contains(element))) return
      userScrollSinceImageChangeRef.current = true
    }
    window.addEventListener('resize', closeOnViewportChange)
    window.addEventListener('scroll', closeOnViewportChange, true)
    scroll?.addEventListener('scroll', closeOnViewportChange)
    scroll?.addEventListener('wheel', markUserScrollIntent, true)
    scroll?.addEventListener('touchmove', markUserScrollIntent, true)
    scroll?.addEventListener('pointerdown', markUserScrollIntent, true)
    scroll?.addEventListener('keydown', markUserScrollIntent, true)
    const onTransaction = ({ transaction }) => {
      const activeMenu = menuRef.current
      const target = activeMenu?.target
      if (!target || !transaction.docChanged) return
      if (target.allowOwnDocChange) {
        const latest = latestRef.current
        const node = editor.state.doc.nodeAt(target.objectPos)
        if (latest.enabled && latest.editor === editor && editor.isEditable &&
          latest.activeFile === target.activeFile && latest.workspaceKey === target.workspaceKey &&
          target.editor === editor && node?.type.name === 'image') {
          target.doc = editor.state.doc
          target.node = node
          return
        }
      }
      closeMenu()
    }
    const onSelectionUpdate = () => {
      const target = menuRef.current?.target
      if (target && !targetMatchesSelection(editor, target)) closeMenu()
    }
    editor.on('transaction', onTransaction)
    editor.on('selectionUpdate', onSelectionUpdate)
    return () => {
      window.removeEventListener('resize', closeOnViewportChange)
      window.removeEventListener('scroll', closeOnViewportChange, true)
      scroll?.removeEventListener('scroll', closeOnViewportChange)
      scroll?.removeEventListener('wheel', markUserScrollIntent, true)
      scroll?.removeEventListener('touchmove', markUserScrollIntent, true)
      scroll?.removeEventListener('pointerdown', markUserScrollIntent, true)
      scroll?.removeEventListener('keydown', markUserScrollIntent, true)
      editor.off('transaction', onTransaction)
      editor.off('selectionUpdate', onSelectionUpdate)
    }
  }, [closeMenu, editor])

  useEffect(() => {
    const target = menuRef.current?.target
    if (target && (!enabled || target.activeFile !== activeFile || target.workspaceKey !== workspaceKey || target.editor !== editor)) closeMenu()
  }, [activeFile, closeMenu, editor, enabled, workspaceKey])

  const selectionTarget = enabled && editor?.isEditable ? selectedObjectTarget(editor) : null
  useEffect(() => {
    if (!isMobile || !selectionTarget || !editor) {
      setTriggerPosition(null)
      return undefined
    }
    const scroll = editor.view.dom.closest('.editor-scroll')
    const updatePosition = () => {
      const dom = targetDOM(editor, selectionTarget)
      const rect = dom?.getBoundingClientRect()
      const frame = scroll?.getBoundingClientRect()
      if (!rect || !frame || rect.width <= 0 || rect.height <= 0) { setTriggerPosition(null); return }
      const visibleLeft = Math.max(0, frame.left)
      const visibleRight = Math.min(window.innerWidth, frame.right)
      const visibleTop = Math.max(0, frame.top)
      const visibleBottom = Math.min(window.innerHeight, frame.bottom)
      if (rect.right <= visibleLeft || rect.left >= visibleRight || rect.bottom <= visibleTop || rect.top >= visibleBottom ||
        visibleRight - visibleLeft < 52 || visibleBottom - visibleTop < 52) {
        setTriggerPosition(null)
        return
      }
      const left = Math.max(visibleLeft + 4, Math.min(rect.right - 44, visibleRight - 48))
      const preferredTop = rect.top - 44
      setTriggerPosition({
        left,
        top: preferredTop >= visibleTop + 4
          ? preferredTop
          : Math.max(visibleTop + 4, Math.min(rect.top, visibleBottom - 48)),
      })
    }
    updatePosition()
    scroll?.addEventListener('scroll', updatePosition)
    window.addEventListener('resize', updatePosition)
    return () => {
      scroll?.removeEventListener('scroll', updatePosition)
      window.removeEventListener('resize', updatePosition)
    }
  }, [editor, isMobile, enabled, selectionTarget?.kind, selectionTarget?.objectPos, selectionTarget?.cellPos, selectionTarget?.node])

  const openSelectedObject = () => {
    if (!selectionTarget) return
    const rect = triggerPosition
    captureTarget(selectionTarget, rect ? rect.left : undefined, rect ? rect.top : undefined)
  }

  const applyImageAttrs = useCallback((target, attrs, { requireOpen = false } = {}) => {
    if (!isTargetCurrent(target, requireOpen)) return false
    const { state, view } = target.editor
    const node = state.doc.nodeAt(target.objectPos)
    if (!node || node !== target.node) return false
    const nextAttrs = { ...node.attrs, ...attrs }
    const tr = state.tr.setNodeMarkup(target.objectPos, null, nextAttrs)
    tr.setSelection(NodeSelection.create(tr.doc, target.objectPos))
    const ownWidthChange = requireOpen && target.kind === 'image' &&
      Number(node.attrs.imageWidth) !== Number(nextAttrs.imageWidth)
    if (ownWidthChange) {
      const until = Date.now() + 150
      ownImageLayoutScrollUntilRef.current = until
      userScrollSinceImageChangeRef.current = false
      window.setTimeout(() => {
        if (ownImageLayoutScrollUntilRef.current === until) {
          ownImageLayoutScrollUntilRef.current = 0
          userScrollSinceImageChangeRef.current = false
        }
      }, 160)
    }
    target.allowOwnDocChange = true
    try {
      view.dispatch(tr)
    } finally {
      target.allowOwnDocChange = false
    }
    if (target.doc === state.doc) {
      target.doc = target.editor.state.doc
      target.node = target.doc.nodeAt(target.objectPos)
    }
    return true
  }, [isTargetCurrent])

  const runTableCommand = (target, command) => {
    if (!isTargetCurrent(target)) return
    const { state, view } = target.editor
    if (state.doc !== target.doc || !state.doc.nodeAt(target.objectPos)) return
    const cell = state.doc.nodeAt(target.cellPos)
    if (!cell || !['cell', 'header_cell'].includes(cell.type.spec.tableRole)) return
    const selection = TextSelection.near(state.doc.resolve(Math.min(target.cellPos + 1, state.doc.content.size)), 1)
    view.dispatch(state.tr.setSelection(selection))
    const chain = target.editor.chain()
    if (typeof chain[command] !== 'function') return
    const didRun = chain[command]().run()
    if (didRun) view.focus()
  }

  const canRunTableCommand = (target, command) => {
    if (!isTargetCurrent(target)) return false
    try { return Boolean(target.editor.can()[command]()) } catch { return false }
  }

  const runImageDelete = target => {
    if (!isTargetCurrent(target)) return
    const { state, view } = target.editor
    const node = state.doc.nodeAt(target.objectPos)
    if (node !== target.node || node?.type.name !== 'image') return
    view.dispatch(state.tr.delete(target.objectPos, target.objectPos + node.nodeSize))
    view.focus()
  }

  const target = menu?.target
  const visibleMenu = menu && target && isTargetCurrent(target) ? menu : null
  const imageWidth = target?.kind === 'image'
    ? clampWidth(Number(target.node.attrs.legacyZoom) || Number(target.node.attrs.imageWidth) || 100)
    : 100
  const items = target?.kind === 'table' ? [
    { key: 'row-before', label: '上方增行', disabled: !canRunTableCommand(target, 'addRowBefore'), onSelect: () => runTableCommand(target, 'addRowBefore') },
    { key: 'row-after', label: '下方增行', disabled: !canRunTableCommand(target, 'addRowAfter'), onSelect: () => runTableCommand(target, 'addRowAfter') },
    { key: 'column-before', label: '左侧增列', disabled: !canRunTableCommand(target, 'addColumnBefore'), onSelect: () => runTableCommand(target, 'addColumnBefore') },
    { key: 'column-after', label: '右侧增列', disabled: !canRunTableCommand(target, 'addColumnAfter'), onSelect: () => runTableCommand(target, 'addColumnAfter') },
    { type: 'divider', key: 'table-actions-divider' },
    { key: 'delete-row', label: '删除行', disabled: !canRunTableCommand(target, 'deleteRow'), onSelect: () => runTableCommand(target, 'deleteRow') },
    { key: 'delete-column', label: '删除列', disabled: !canRunTableCommand(target, 'deleteColumn'), onSelect: () => runTableCommand(target, 'deleteColumn') },
    { type: 'divider', key: 'table-delete-divider' },
    { key: 'delete-table', label: '删除表格', danger: true, disabled: !canRunTableCommand(target, 'deleteTable'), onSelect: () => runTableCommand(target, 'deleteTable') },
  ] : target?.kind === 'image' ? [
    { key: 'align-left', label: '左对齐', onSelect: () => { if (applyImageAttrs(target, { imageAlign: 'left' })) target.editor.view.focus() } },
    { key: 'align-center', label: '居中', onSelect: () => { if (applyImageAttrs(target, { imageAlign: 'center' })) target.editor.view.focus() } },
    { type: 'divider', key: 'image-alignment-divider' },
    ...[50, 75, 100].map(width => ({ key: `width-${width}`, label: `宽度${width}%`, onSelect: () => {
      if (applyImageAttrs(target, { legacyZoom: null, imageWidth: width })) target.editor.view.focus()
    } })),
    { key: 'custom-width', label: '自定义宽度…', keepOpen: true, onSelect: () => {
      setCustomWidthValue(imageWidth)
      setCustomWidthOpen(true)
    } },
    ...(customWidthOpen ? [{
      type: 'custom',
      key: 'custom-width-control',
      content: <ImageWidthControl
        value={customWidthValue ?? imageWidth}
        editor={editor}
        target={target}
        onClose={closeMenu}
        onChange={value => {
          const nextWidth = clampWidth(value)
          setCustomWidthValue(nextWidth)
          applyImageAttrs(target, { legacyZoom: null, imageWidth: nextWidth }, { requireOpen: true })
        }}
      />,
    }] : []),
    { type: 'divider', key: 'image-delete-divider' },
    { key: 'delete-image', label: '删除图片', danger: true, onSelect: () => runImageDelete(target) },
  ] : []

  const restoreFocusTo = editor?.view?.dom
  if (typeof document === 'undefined') return null
  return createPortal(<>
    {isMobile && selectionTarget && triggerPosition && !menu && (
      <button
        type="button"
        className="editor-object-more-button"
        aria-label={selectionTarget.kind === 'table' ? '更多表格操作' : '更多图片操作'}
        aria-haspopup="menu"
        aria-expanded="false"
        style={{ left: triggerPosition.left, top: triggerPosition.top }}
        onClick={event => {
          event.stopPropagation()
          openSelectedObject()
        }}
      ><MoreOutlined aria-hidden="true" /></button>
    )}
    {visibleMenu && target && (
      <ContextActionMenu
        x={visibleMenu.x}
        y={visibleMenu.y}
        label={target.kind === 'table' ? '表格操作' : '图片操作'}
        items={items}
        restoreFocusTo={restoreFocusTo}
        onClose={closeMenu}
        className="editor-object-context-menu"
      />
    )}
  </>, document.body)
}
