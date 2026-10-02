import { useEffect, useRef, useState } from 'react'
import { Button } from 'antd'

export default function ImageControls({ editor, visible }) {
  const [handle, setHandle] = useState(null)
  const dragRef = useRef(null)
  const selection = editor?.state.selection
  const image = visible && selection?.node?.type?.name === 'image' ? selection.node : null
  useEffect(() => {
    if (!image) { setHandle(null); return undefined }
    const scroll = editor.view.dom.closest('.editor-scroll')
    const measure = () => {
      const selected = editor.view.dom.querySelector('img.ProseMirror-selectednode')
      if (!scroll || !selected) { setHandle(null); return }
      const box = selected.getBoundingClientRect()
      const frame = scroll.getBoundingClientRect()
      setHandle({ left: box.right - frame.left + scroll.scrollLeft - 44, top: box.bottom - frame.top + scroll.scrollTop - 44,
        containerWidth: selected.parentElement?.clientWidth || box.width })
    }
    measure()
    const selected = editor.view.dom.querySelector('img.ProseMirror-selectednode')
    const observer = new ResizeObserver(measure)
    if (scroll) observer.observe(scroll)
    if (selected) observer.observe(selected)
    scroll?.addEventListener('scroll', measure)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); scroll?.removeEventListener('scroll', measure); window.removeEventListener('resize', measure) }
  }, [editor, image?.attrs.imageWidth, image?.attrs.imageAlign, selection?.from])
  if (!image) return null
  const width = Number(image.attrs.legacyZoom) || Number(image.attrs.imageWidth) || 100
  const align = image.attrs.imageAlign || 'left'
  const update = attrs => editor.chain().focus().updateAttributes('image', attrs).run()
  const setWidth = value => update({ legacyZoom: null, imageWidth: value })
  return <>
    {handle && <button type="button" className="image-resize-handle" aria-label="拖动调整图片宽度" title="拖动调整图片宽度"
      style={{ left: handle.left, top: handle.top }}
      onPointerDown={event => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        dragRef.current = { x: event.clientX, width, containerWidth: handle.containerWidth }
        const finish = () => { dragRef.current = null }
        window.addEventListener('pointerup', finish, { once: true })
        window.addEventListener('pointercancel', finish, { once: true })
      }}
      onPointerMove={event => {
        if (!dragRef.current) return
        const next = Math.max(25, Math.min(100, Math.round((dragRef.current.width + (event.clientX - dragRef.current.x) / dragRef.current.containerWidth * 100) / 5) * 5))
        if (next !== Number(editor.state.selection.node?.attrs.imageWidth || 100)) setWidth(next)
      }}
      onPointerUp={() => { dragRef.current = null }}
      onPointerCancel={() => { dragRef.current = null }} />}
    <div className="image-context-tools" role="toolbar" aria-label="图片显示设置">
    <span>图片</span>
    <Button size="small" aria-label="图片左对齐" aria-pressed={align === 'left'} onClick={() => update({ imageAlign: 'left' })}>左对齐</Button>
    <Button size="small" aria-label="图片居中" aria-pressed={align === 'center'} onClick={() => update({ imageAlign: 'center' })}>居中</Button>
    {[50, 75, 100].map(preset => <Button key={preset} size="small" aria-label={`图片宽度 ${preset}%`}
      aria-pressed={width === preset} onClick={() => setWidth(preset)}>{preset}%</Button>)}
    <label>宽度 <input type="range" aria-label="图片显示宽度" min="25" max="100" step="5" value={Math.min(100, width)}
      onChange={event => setWidth(Number(event.target.value))} /></label>
    <span aria-live="polite">{width}%</span>
    </div>
  </>
}
