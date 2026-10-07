import { useEffect, useRef, useState } from 'react'
import { NodeSelection } from '@tiptap/pm/state'

export default function ImageControls({ editor, visible, activeFile, workspaceKey }) {
  const [handle, setHandle] = useState(null)
  const [layoutEpoch, setLayoutEpoch] = useState(0)
  const dragRef = useRef(null)
  const dragUpdateRef = useRef(false)
  const latestRef = useRef({ editor, visible, activeFile, workspaceKey })
  latestRef.current = { editor, visible, activeFile, workspaceKey }
  const selection = editor?.state.selection
  const canEdit = Boolean(visible && editor?.isEditable)
  const image = canEdit && selection?.node?.type?.name === 'image' ? selection.node : null
  const imagePos = image ? selection.from : null

  useEffect(() => {
    if (!editor) return undefined
    const onTransaction = ({ transaction }) => {
      if (!transaction.docChanged) return
      const drag = dragRef.current
      if (drag && dragUpdateRef.current) {
        drag.doc = editor.state.doc
        drag.node = editor.state.doc.nodeAt(drag.pos)
      } else if (drag) {
        dragRef.current = null
      }
      setLayoutEpoch(value => value + 1)
    }
    const onSelectionUpdate = () => {
      const drag = dragRef.current
      const current = editor.state.selection
      if (drag && (!(current instanceof NodeSelection) || current.from !== drag.pos || current.node.type.name !== 'image')) {
        dragRef.current = null
      }
    }
    editor.on('transaction', onTransaction)
    editor.on('selectionUpdate', onSelectionUpdate)
    return () => {
      editor.off('transaction', onTransaction)
      editor.off('selectionUpdate', onSelectionUpdate)
      dragRef.current = null
    }
  }, [editor])

  useEffect(() => {
    dragRef.current = null
  }, [activeFile, workspaceKey])

  useEffect(() => {
    if (!canEdit || imagePos == null) {
      dragRef.current = null
      setHandle(null)
      return undefined
    }
    const scroll = editor.view.dom.closest('.editor-scroll')
    const measure = () => {
      const selected = editor.view.dom.querySelector('img.ProseMirror-selectednode')
      if (!scroll || !selected) { setHandle(null); return }
      const box = selected.getBoundingClientRect()
      const frame = scroll.getBoundingClientRect()
      setHandle({
        left: box.right - frame.left + scroll.scrollLeft - 44,
        top: box.bottom - frame.top + scroll.scrollTop - 44,
        containerWidth: selected.parentElement?.clientWidth || box.width,
      })
    }
    measure()
    const selected = editor.view.dom.querySelector('img.ProseMirror-selectednode')
    const observer = new ResizeObserver(measure)
    if (scroll) observer.observe(scroll)
    if (selected) observer.observe(selected)
    scroll?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      scroll?.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [canEdit, editor, imagePos, image?.attrs.imageWidth, image?.attrs.imageAlign, layoutEpoch])

  if (!image || imagePos == null) return null
  const width = Number(image.attrs.legacyZoom) || Number(image.attrs.imageWidth) || 100

  const setWidth = value => {
    const drag = dragRef.current
    const latest = latestRef.current
    if (!drag || !latest.visible || latest.editor !== editor || !editor.isEditable ||
      latest.activeFile !== drag.activeFile || latest.workspaceKey !== drag.workspaceKey || editor.state.doc !== drag.doc) return false
    const state = editor.state
    const node = state.doc.nodeAt(drag.pos)
    if (node !== drag.node || node?.type.name !== 'image' ||
      !(state.selection instanceof NodeSelection) || state.selection.from !== drag.pos) return false
    const tr = state.tr.setNodeMarkup(drag.pos, null, { ...node.attrs, legacyZoom: null, imageWidth: value })
    tr.setSelection(NodeSelection.create(tr.doc, drag.pos))
    dragUpdateRef.current = true
    try {
      editor.view.dispatch(tr)
    } finally {
      dragUpdateRef.current = false
    }
    drag.doc = editor.state.doc
    drag.node = editor.state.doc.nodeAt(drag.pos)
    return true
  }

  return handle && <button
    type="button"
    className="image-resize-handle"
    aria-label="拖动调整图片宽度"
    title="拖动调整图片宽度"
    style={{ left: handle.left, top: handle.top }}
    onPointerDown={event => {
      const state = editor.state
      if (!visible || !editor.isEditable || state.doc.nodeAt(imagePos) !== image ||
        !(state.selection instanceof NodeSelection) || state.selection.from !== imagePos) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = {
        pos: imagePos,
        doc: editor.state.doc,
        node: editor.state.doc.nodeAt(imagePos),
        activeFile: latestRef.current.activeFile,
        workspaceKey: latestRef.current.workspaceKey,
        x: event.clientX,
        width,
        containerWidth: Math.max(1, handle.containerWidth),
      }
      const finish = () => { dragRef.current = null }
      window.addEventListener('pointerup', finish, { once: true })
      window.addEventListener('pointercancel', finish, { once: true })
    }}
    onPointerMove={event => {
      const drag = dragRef.current
      if (!drag || editor.state.doc !== drag.doc || !editor.isEditable) return
      const next = Math.max(25, Math.min(100,
        Math.round((drag.width + (event.clientX - drag.x) / drag.containerWidth * 100) / 5) * 5))
      const current = editor.state.doc.nodeAt(drag.pos)
      const currentWidth = Number(current?.attrs.legacyZoom) || Number(current?.attrs.imageWidth) || 100
      if (next !== currentWidth) setWidth(next)
    }}
    onPointerUp={() => { dragRef.current = null }}
    onPointerCancel={() => { dragRef.current = null }}
  />
}
