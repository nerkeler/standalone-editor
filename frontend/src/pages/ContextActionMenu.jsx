import { useEffect, useLayoutEffect, useRef, useState } from 'react'

function visibleFocusables(exclude) {
  return Array.from(document.querySelectorAll(
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
  )).filter(element => !exclude?.contains(element) && element.getClientRects().length > 0)
}

function enabledItemIndexes(items) {
  return items.flatMap((item, index) => !['divider', 'custom'].includes(item.type) && !item.disabled ? [index] : [])
}

export default function ContextActionMenu({ x, y, label, items = [], restoreFocusTo, onClose, className = '' }) {
  const menuRef = useRef(null)
  const itemRefs = useRef([])
  const [activeIndex, setActiveIndex] = useState(() => enabledItemIndexes(items)[0] ?? -1)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    const gutter = 8
    setPosition({
      left: Math.max(gutter, Math.min(x, window.innerWidth - rect.width - gutter)),
      top: Math.max(gutter, Math.min(y, window.innerHeight - rect.height - gutter)),
    })
  }, [x, y, items.length])

  useLayoutEffect(() => {
    const first = enabledItemIndexes(items)[0] ?? -1
    if (first >= 0) itemRefs.current[first]?.focus()
  }, [])

  useEffect(() => {
    const closeIfOutside = event => {
      if (!menuRef.current?.contains(event.target)) onClose?.()
    }
    document.addEventListener('pointerdown', closeIfOutside)
    document.addEventListener('click', closeIfOutside)
    return () => {
      document.removeEventListener('pointerdown', closeIfOutside)
      document.removeEventListener('click', closeIfOutside)
    }
  }, [onClose])

  const closeAndRestore = () => {
    onClose?.()
    requestAnimationFrame(() => {
      if (restoreFocusTo?.isConnected) restoreFocusTo.focus()
    })
  }

  const moveFocus = index => {
    const available = enabledItemIndexes(items)
    if (!available.length) return
    const next = available.includes(index) ? index : available[0]
    setActiveIndex(next)
    itemRefs.current[next]?.focus()
  }

  const handleKeyDown = event => {
    const available = enabledItemIndexes(items)
    if (event.key === 'Escape') {
      event.preventDefault()
      closeAndRestore()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const outside = visibleFocusables(menuRef.current)
      const current = outside.indexOf(restoreFocusTo)
      const next = outside[current + (event.shiftKey ? -1 : 1)]
      onClose?.()
      requestAnimationFrame(() => {
        if (next) next.focus()
        else restoreFocusTo?.focus?.()
      })
      return
    }
    if (!available.length) return
    const currentPosition = Math.max(0, available.indexOf(activeIndex))
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      moveFocus(available[(currentPosition + 1) % available.length])
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      moveFocus(available[(currentPosition - 1 + available.length) % available.length])
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveFocus(available[0])
    } else if (event.key === 'End') {
      event.preventDefault()
      moveFocus(available[available.length - 1])
    }
  }

  return (
    <div
      ref={menuRef}
      className={`editor-context-menu${className ? ` ${className}` : ''}`}
      role="menu"
      aria-label={label}
      style={{ left: position.left, top: position.top }}
      onKeyDown={handleKeyDown}
      onClick={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
    >
      {items.map((item, index) => item.type === 'divider' ? (
        <div key={item.key || `divider-${index}`} className="editor-context-menu-divider" role="separator" />
      ) : item.type === 'custom' ? (
        <div key={item.key || `custom-${index}`} className="editor-context-menu-custom" role="none">
          {item.content}
        </div>
      ) : (
        <button
          key={item.key}
          ref={element => { itemRefs.current[index] = element }}
          type="button"
          role="menuitem"
          aria-label={item.ariaLabel || item.label}
          tabIndex={index === activeIndex ? 0 : -1}
          disabled={item.disabled}
          className={`editor-context-menu-item${item.danger ? ' is-danger' : ''}`}
          onFocus={() => setActiveIndex(index)}
          onClick={() => {
            if (!item.keepOpen) onClose?.()
            item.onSelect?.()
          }}
        >
          {item.icon && <span className="editor-context-menu-icon" aria-hidden="true">{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}
