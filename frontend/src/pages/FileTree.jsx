import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Tree } from 'antd'
import { FileOutlined, FolderOpenOutlined, MoreOutlined } from '@ant-design/icons'

function createTreeData(nodes, options) {
  return nodes.map(node => {
    const isRenaming = options.renamingPath === node.path
    const title = isRenaming ? (
      <input
        autoFocus
        ref={options.renameInputRef}
        value={options.renameValue}
        aria-label={`重命名 ${node.name}`}
        onFocus={() => { options.renameCancelledRef.current = false }}
        onChange={event => options.onRenameChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            if (!options.renameCancelledRef.current) {
              options.renameCancelledRef.current = true
              options.onRenameConfirm()
            }
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            const treeItem = event.currentTarget.closest('.ant-tree-node-content-wrapper')
            const keyboardInput = treeItem?.closest('.ant-tree')?.querySelector('input[tabindex]')
            options.renameCancelledRef.current = true
            options.setActiveKey(node.path)
            options.onRenameCancel()
            requestAnimationFrame(() => keyboardInput?.focus())
          }
        }}
        onBlur={() => {
          if (options.renameCancelledRef.current) {
            options.renameCancelledRef.current = false
            return
          }
          options.renameCancelledRef.current = true
          options.onRenameConfirm()
        }}
        onClick={event => event.stopPropagation()}
        className="tree-rename-input"
      />
    ) : (
      <div
        className="tree-node-title"
        data-testid="file-tree-item"
        data-path={node.path}
        onContextMenu={event => {
          event.preventDefault()
          event.stopPropagation()
          const treeItem = event.target?.closest?.('.ant-tree-node-content-wrapper')
            || event.currentTarget.closest('.ant-tree-node-content-wrapper')
          const keyboardInput = treeItem?.closest('.ant-tree')?.querySelector('input[tabindex]')
          options.setActiveKey(node.path)
          options.onContextMenu?.(node, event, keyboardInput)
        }}
      >
        {node.type === 'dir'
          ? <FolderOpenOutlined aria-hidden="true" className="tree-node-icon is-folder" />
          : <FileOutlined aria-hidden="true" className="tree-node-icon is-file" />}
        <span className="tree-node-name" title={node.name}>{node.name}</span>
        {options.showActions && (
          <button
            type="button"
            className="tree-node-more"
            tabIndex={-1}
            aria-label={`更多操作：${node.name}`}
            title={`更多操作：${node.name}`}
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              options.setActiveKey(node.path)
              options.onContextMenu?.(node, event, event.currentTarget.closest('.ant-tree')?.querySelector('input[tabindex]'))
            }}
          >
            <MoreOutlined aria-hidden="true" />
          </button>
        )}
      </div>
    )

    const childNodes = Array.isArray(node.children) ? node.children : []
    return {
      ...node,
      key: node.path,
      title,
      isLeaf: node.type !== 'dir',
      ...(node.type === 'dir' && childNodes.length ? { children: createTreeData(childNodes, options) } : {}),
    }
  })
}

function FileTree({
  nodes = [],
  selectedKeys = [],
  expandedKeys,
  onExpand,
  onSelect,
  onContextMenu,
  onDrop,
  draggable = false,
  showActions = true,
  renamingPath = null,
  renameValue = '',
  renameInputRef,
  onRenameChange,
  onRenameStart,
  onRenameConfirm,
  onRenameCancel,
  className,
  ...treeProps
}) {
  const renameCancelledRef = useRef(false)
  const [activeKey, setActiveKey] = useState(selectedKeys[0] || null)
  useEffect(() => {
    if (selectedKeys[0]) setActiveKey(selectedKeys[0])
  }, [selectedKeys[0]])
  const treeRef = useRef(null)
  const findNode = key => {
    for (const node of nodes) {
      if (node.path === key) return node
      const child = node.children ? findInChildren(node.children, key) : null
      if (child) return child
    }
    return null
  }
  const findInChildren = (children, key) => {
    for (const node of children) {
      if (node.path === key) return node
      const child = node.children ? findInChildren(node.children, key) : null
      if (child) return child
    }
    return null
  }
  const handleTreeKeyDown = event => {
    if (event.key !== 'F2' && event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    const node = findNode(activeKey)
    if (!node) return
    event.preventDefault()
    event.stopPropagation()
    const tree = treeRef.current?.querySelector('.ant-tree')
    const keyboardInput = tree?.querySelector('input[tabindex]')
    if (event.key === 'F2') {
      onRenameStart?.(node)
      return
    }
    const title = Array.from(tree?.querySelectorAll('[data-testid="file-tree-item"]') || [])
      .find(item => item.dataset.path === node.path)
    const anchor = title?.getBoundingClientRect()
    onContextMenu?.(node, {
      clientX: anchor ? anchor.left + Math.min(anchor.width, 24) : 12,
      clientY: anchor ? anchor.bottom : 12,
      preventDefault() {},
      stopPropagation() {},
    }, keyboardInput)
  }
  const treeData = useMemo(() => createTreeData(nodes, {
    renamingPath,
    renameValue,
    renameInputRef,
    onRenameChange,
    onRenameStart,
    onRenameConfirm,
    onRenameCancel,
    renameCancelledRef,
    setActiveKey,
    onContextMenu,
    showActions,
  }), [nodes, renamingPath, renameValue, renameInputRef, onRenameChange, onRenameStart, onRenameConfirm, onRenameCancel, onContextMenu, showActions])
  useEffect(() => {
    const input = treeRef.current?.querySelector('.ant-tree input[tabindex]')
    input?.setAttribute('aria-label', '文件目录键盘导航')
  }, [treeData])

  return (
    <div ref={treeRef} onKeyDown={handleTreeKeyDown} className="file-tree-keyboard-scope">
      <Tree
        {...treeProps}
        className={className}
        treeData={treeData}
        selectedKeys={selectedKeys}
        expandedKeys={expandedKeys}
        activeKey={activeKey}
        onActiveChange={key => {
          if (key !== null) setActiveKey(key)
        }}
        onExpand={onExpand}
        onSelect={(keys, info) => onSelect?.(keys, info.node, info)}
        onDrop={onDrop}
        expandAction="click"
        blockNode
        draggable={draggable}
      />
    </div>
  )
}

export default memo(FileTree)
