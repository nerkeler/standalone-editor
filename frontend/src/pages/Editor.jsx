import { useState, useEffect, useCallback, useRef } from 'react'
import { Tree, Button, Modal, Input, message, Tooltip } from 'antd'
import {
  FileOutlined, FolderOpenOutlined, PlusOutlined, UploadOutlined, SaveOutlined,
  CloseOutlined, CheckSquareOutlined, TableOutlined, MoreOutlined, DeleteOutlined,
  SwapOutlined, BoldOutlined, ItalicOutlined, StrikethroughOutlined,
  UnorderedListOutlined, OrderedListOutlined, LinkOutlined, ExpandOutlined,
  ShrinkOutlined, HolderOutlined, ArrowLeftOutlined, EditOutlined, MenuOutlined,
  NodeIndexOutlined, CodeOutlined, ApiOutlined, AppstoreOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, AlignLeftOutlined
} from '@ant-design/icons'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import Strike from '@tiptap/extension-strike'
import axios from 'axios'
import { marked } from 'marked'
import Turndown from 'turndown'
import { common, createLowlight } from 'lowlight'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import './Editor.css'

const lowlight = createLowlight(common)

const API = '/api/workspace'

// ========== 文件树工具函数 ==========

function buildTree(flat) {
  const map = {}
  const roots = []
  flat.forEach(n => { map[n.path] = { ...n, children: n.children || [] } })
  flat.forEach(n => {
    const parts = n.path.split('/')
    if (parts.length === 1) roots.push(map[n.path])
    else {
      const parent = parts.slice(0, -1).join('/')
      map[parent]?.children?.push(map[n.path])
    }
  })
  return roots
}

function findNode(nodes, path) {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children) { const f = findNode(n.children, path); if (f) return f }
  }
  return null
}

function addChildrenToTree(nodes, parentPath, children) {
  return nodes.map(n => {
    if (n.path === parentPath) {
      const childNodes = children.map(c => ({ ...c, children: [] }))
      return { ...n, children: childNodes }
    }
    if (n.children) {
      return { ...n, children: addChildrenToTree(n.children, parentPath, children) }
    }
    return n
  })
}

function collectFolders(nodes, excludePath) {
  return nodes.filter(n => n.type === 'dir' && n.path !== excludePath).map(n => ({
    ...n,
    children: n.children ? collectFolders(n.children, excludePath) : []
  }))
}

// ========== 主组件 ==========

export default function Editor({ workspace }) {
  const [tree, setTree] = useState([])
  const [selectedKey, setSelectedKey] = useState('')
  const [openFiles, setOpenFiles] = useState([])
  const [activeFile, setActiveFile] = useState('')
  const [savedContents, setSavedContents] = useState({})
  const [createModal, setCreateModal] = useState({ open: false, parent: '', type: 'file' })
  const [createName, setCreateName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [contextMenu, setContextMenu] = useState({ visible: false, node: null, x: 0, y: 0 })
  const [moveModal, setMoveModal] = useState({ open: false, node: null })
  const [moveTarget, setMoveTarget] = useState('')
  const [showSource, setShowSource] = useState(false)
  const [sourceContent, setSourceContent] = useState('')
  const [editorFullscreen, setEditorFullscreen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [showSidebar, setShowSidebar] = useState(true)
  const [showToolbar, setShowToolbar] = useState(true)
  const [sidebarView, setSidebarView] = useState('tree')
  const [isDirty, setIsDirty] = useState({})
  const [expandedKeys, setExpandedKeys] = useState([])
  const [isAllExpanded, setIsAllExpanded] = useState(false)
  const [outlineItems, setOutlineItems] = useState([])

  // 生成大纲
  useEffect(() => {
    const content = savedContents[activeFile] || ''
    if (!content) { setOutlineItems([]); return }
    const items = []
    const lines = content.split('\n')
    lines.forEach(line => {
      const h1 = line.match(/^# (.+)/)
      const h2 = line.match(/^## (.+)/)
      const h3 = line.match(/^### (.+)/)
      if (h1) items.push({ level: 1, text: h1[1] })
      else if (h2) items.push({ level: 2, text: h2[1] })
      else if (h3) items.push({ level: 3, text: h3[1] })
    })
    setOutlineItems(items)
  }, [activeFile, savedContents[activeFile]])
  const [saveStatus, setSaveStatus] = useState('idle')
  const autoSaveTimerRef = useRef(null)
  const cleanContentsRef = useRef({})
  const [renamingPath, setRenamingPath] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef(null)
  const zoomMapRef = useRef({})

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    setIsMobile(mq.matches)
    const handler = e => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, strike: false, codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
      Image.configure({ inline: false, allowBase64: true }),
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: '' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      Strike,
    ],
  }, [])

  const applyZoom = useCallback(() => {
    const zoomMap = zoomMapRef.current
    document.querySelectorAll('.ProseMirror img').forEach(img => {
      const key = (img.getAttribute('src') || '').replace(/^\//, '')
      if (zoomMap[key] && !img.getAttribute('data-zoom')) {
        img.setAttribute('data-zoom', zoomMap[key])
        img.style.zoom = zoomMap[key] + '%'
      }
    })
  }, [])

  useEffect(() => {
    if (!editor) return
    const observer = new MutationObserver(() => applyZoom())
    const el = document.querySelector('.ProseMirror')
    if (el) observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
    editor.on('transaction', () => { setTimeout(applyZoom, 0) })
    return () => { observer.disconnect() }
  }, [editor, applyZoom])

  const loadTree = useCallback(async () => {
    try {
      const res = await axios.get(API, { params: { path: '' } })
      setTree(buildTree(res.data || []))
    } catch {}
  }, [])

  // 懒加载子目录
  const loadChildren = useCallback(async (dirPath) => {
    try {
      const res = await axios.get(API, { params: { path: dirPath } })
      const children = res.data || []
      if (children.length > 0) {
        setTree(prev => addChildrenToTree(prev, dirPath, children))
      }
    } catch {}
  }, [])

  // 展开目录时懒加载
  const handleExpand = useCallback((keys) => {
    const prevExpanded = expandedKeys
    // 找出新增展开的 key（原来没有，新请求里有）
    const newKey = keys.find(k => !prevExpanded.includes(k))
    if (newKey) {
      const node = findNode(tree, newKey)
      if (node && node.type === 'dir') {
        // 先立即展开，避免无效点击
        setExpandedKeys(prev => prev.includes(newKey) ? prev : [...prev, newKey])
        // 加载子目录
        loadChildren(newKey)
        return
      }
    }
    // 折叠操作或未知 key，直接更新
    setExpandedKeys(keys)
  }, [expandedKeys, tree, loadChildren])

  useEffect(() => { loadTree() }, [loadTree])

  useEffect(() => {
    const handler = () => setContextMenu(p => ({ ...p, visible: false }))
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  // 编辑内容变化 → 自动保存
  useEffect(() => {
    if (!editor) return
    const handler = () => {
      if (!activeFile) return
      setIsDirty(p => ({ ...p, [activeFile]: true }))
      setSaveStatus('modified')
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = setTimeout(() => {
        if (activeFile) doSave(activeFile)
      }, 3000)
    }
    editor.on('update', handler)
    return () => { editor.off('update', handler) }
  }, [editor, activeFile])

  const loadFile = async (path) => {
    try {
      const res = await axios.get(`${API}/file`, { params: { path } })
      let content = (res.data.content || '')
      const zoomMap = {}
      content = content.replace(/!\[(.*?)\]\((.*?)\)<!-- zoom:(\d+) -->/g, (_, _alt, src, zoom) => {
        zoomMap[src.replace(/^\//, '')] = zoom
        return `![${_alt}](${src})`
      })
      zoomMapRef.current = zoomMap
      const html = marked.parse(content)
      editor?.commands.setContent(html)
      setSaveStatus('idle')
      let attempts = 0
      const poll = setInterval(() => {
        const hasImg = document.querySelector('.ProseMirror img')
        attempts++
        if (hasImg || attempts > 40) { clearInterval(poll); applyZoom() }
      }, 50)
      editor?.commands.focus('start')
      setSavedContents(p => ({ ...p, [path]: res.data.content || '' }))
      cleanContentsRef.current[path] = res.data.content || ''
    } catch {}
  }

  const handleFileOpen = async (node) => {
    if (editor && activeFile && activeFile !== node.path) {
      const td = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      const currentMd = td.turndown(editor.getHTML()).replace(/\\([!\[\]\(\)_*#`\-])/g, '$1')
      setSavedContents(p => ({ ...p, [activeFile]: currentMd }))
      cleanContentsRef.current[activeFile] = currentMd
    }
    setSelectedKey(node.path)
    if (!openFiles.includes(node.path)) setOpenFiles(p => [...p, node.path])
    setActiveFile(node.path)
    await loadFile(node.path)
  }

  const handleClose = (path, e) => {
    e?.stopPropagation()
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    setIsDirty(p => { const n = { ...p }; delete n[path]; return n })
    setSavedContents(p => { const n = { ...p }; delete n[path]; return n })
    const newClean = { ...cleanContentsRef.current }
    delete newClean[path]
    cleanContentsRef.current = newClean
    const newOpen = openFiles.filter(f => f !== path)
    setOpenFiles(newOpen)
    if (activeFile === path) {
      setActiveFile(newOpen[newOpen.length - 1] || '')
      setSaveStatus('idle')
    }
  }

  const doSave = async (path) => {
    console.log('[doSave] path:', path, 'workspace:', workspace)
    if (!editor) return
    try {
      const td = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      let md = td.turndown(editor.getHTML()).replace(/\\([!\[\]\(\)_*#`\-])/g, '$1')
      document.querySelectorAll('.ProseMirror img[data-zoom]').forEach(img => {
        const zoom = img.getAttribute('data-zoom')
        if (zoom && zoom !== '100') {
          const src = img.getAttribute('src') || ''
          const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const pattern = `!\\[([^\\]]*)\\]\\(${escapedSrc}\\)`
          md = md.replace(new RegExp(pattern), `$&<!-- zoom:${zoom} -->`)
        }
      })
      console.log('[doSave] PUT payload:', { path, contentLen: md.length })
      const res = await axios.put(API, { path, content: md })
      console.log('[doSave] response:', res.data)
      setSavedContents(p => ({ ...p, [path]: md }))
      cleanContentsRef.current[path] = md
      setIsDirty(p => { const n = { ...p }; delete n[path]; return n })
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (err) {
      console.error('[doSave] ERROR:', err?.response?.data || err.message || err)
      setSaveStatus('modified')
    }
  }

  const handleSave = async () => {
    if (!activeFile || !editor) return
    setSaveStatus('saving')
    try {
      await doSave(activeFile)
      message.success('保存成功')
    } catch { message.error('保存失败') }
  }

  const handleCreate = async () => {
    if (!createName.trim()) return
    try {
      let name = createName.trim()
      if (createModal.type === 'file' && !name.endsWith('.md')) name = name + '.md'
      await axios.post(API, { path: createModal.parent, name, type: createModal.type })
      setCreateModal({ open: false, parent: '', type: 'file' })
      setCreateName('')
      await loadTree()
      message.success('创建成功')
    } catch { message.error('创建失败') }
  }

  const handleImageUpload = async (file) => {
    if (!activeFile || !editor) return
    const parts = activeFile.split('/'); parts.pop()
    const uploadPath = parts.join('/')
    const formData = new FormData()
    formData.append('file', file)
    setUploading(true)
    try {
      const res = await axios.post(`${API}/upload${uploadPath ? '/' + uploadPath : ''}`, formData)
      const md = `![](${res.data.path.startsWith('/') ? '' : '/' + res.data.path})`
      editor?.chain().focus().setImage({ src: '/' + res.data.path }).run()
      message.success('图片已插入')
    } catch { message.error('上传失败') }
    finally { setUploading(false) }
  }

  const handleDelete = async (node) => {
    try {
      await axios.delete(API, { params: { path: node.path } })
      if (openFiles.includes(node.path)) handleClose(node.path)
      await loadTree()
      message.success('删除成功')
    } catch { message.error('删除失败') }
  }

  const handleMove = async (node, newParent) => {
    const parts = node.path.split('/')
    const oldName = parts.pop() || node.name
    const newPath = newParent ? `${newParent}/${oldName}` : oldName
    if (node.path === newPath) return
    try {
      await axios.post(`${API}/move`, { old_path: node.path, new_path: newPath })
      if (openFiles.includes(node.path)) {
        const newOpen = openFiles.map(f => f === node.path ? newPath : f)
        setOpenFiles(newOpen)
        setActiveFile(prev => prev === node.path ? newPath : prev)
      }
      await loadTree()
      message.success('移动成功')
    } catch { message.error('移动失败') }
  }

  const handleClear = () => {
    if (!editor) return
    Modal.confirm({
      title: '确定清空当前内容？', content: '清空后不可恢复。',
      okText: '清空', cancelText: '取消', okButtonProps: { danger: true },
      onOk: () => { editor.commands.clearContent(); message.success('已清空') },
    })
  }

  const handleInsertLink = () => {
    Modal.confirm({
      title: '插入链接',
      content: <Input placeholder="输入链接 URL" id="link-url-input" autoFocus style={{ marginTop: 8 }} />,
      onOk: () => {
        const url = document.getElementById('link-url-input')?.value
        if (url) editor?.chain().focus().setLink({ href: url }).run()
      },
    })
  }

  const handleRenameStart = (node) => {
    setRenamingPath(node.path)
    setRenameValue(node.name)
    setContextMenu(p => ({ ...p, visible: false }))
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const handleRenameConfirm = async () => {
    if (!renamingPath || !renameValue.trim()) { setRenamingPath(null); return }
    const parts = renamingPath.split('/')
    const oldName = parts.pop()
    const newName = renameValue.trim()
    if (newName === oldName) { setRenamingPath(null); return }
    const parent = parts.join('/')
    const newPath = parent ? `${parent}/${newName}` : newName
    try {
      await axios.post(`${API}/move`, { old_path: renamingPath, new_path: newPath })
      if (openFiles.includes(renamingPath)) {
        setOpenFiles(p => p.map(f => f === renamingPath ? newPath : f))
        setActiveFile(p => p === renamingPath ? newPath : p)
      }
      await loadTree()
      message.success('重命名成功')
    } catch { message.error('重命名失败') }
    setRenamingPath(null)
  }

  const handleToggleExpandAll = () => {
    if (isAllExpanded) {
      setExpandedKeys([])
    } else {
      const allFolderPaths = []
      const collect = nodes => nodes.forEach(n => {
        if (n.type === 'dir') { allFolderPaths.push(n.path); n.children && collect(n.children) }
      })
      collect(tree)
      setExpandedKeys(allFolderPaths)
    }
    setIsAllExpanded(v => !v)
  }

  const handleLocateCurrentFile = () => {
    if (!activeFile) return
    const parts = activeFile.split('/')
    const parents = []
    let cur = ''
    parts.slice(0, -1).forEach(p => { cur += (cur ? '/' : '') + p; parents.push(cur) })
    setExpandedKeys(p => [...new Set([...p, ...parents])])
    setSelectedKey(activeFile)
    setTimeout(() => {
      const el = document.querySelector(`[data-node-key="${activeFile}"]`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 100)
  }

  const renderTreeNodes = (nodes) =>
    nodes.map(node => {
      const isRenaming = renamingPath === node.path
      const title = isRenaming ? (
        <input
          autoFocus ref={renameInputRef}
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleRenameConfirm(); if (e.key === 'Escape') setRenamingPath(null) }}
          onBlur={handleRenameConfirm}
          onClick={e => e.stopPropagation()}
          style={{ padding: '1px 4px', fontSize: 13, width: '100%', border: '1px solid #1890ff', borderRadius: 4, outline: 'none', background: 'var(--color-bg-card)', color: 'var(--color-text)' }}
        />
      ) : (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, paddingLeft: node.type === 'file' ? 20 : 0 }}
          onClick={node.type === 'file' ? e => { e.stopPropagation(); handleFileOpen(node) } : undefined}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ visible: true, node, x: e.clientX, y: e.clientY }) }}
        >
          {savedContents[node.path] !== undefined && <span style={{ color: '#f39c12', marginRight: 2 }}>●</span>}
          {node.type === 'dir' ? <FolderOpenOutlined style={{ color: '#f39c12' }} /> : <FileOutlined style={{ color: '#74b9ff' }} />}
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
          <span
            className="tree-node-more"
            onClick={e => { e.stopPropagation(); setContextMenu({ visible: true, node, x: e.clientX, y: e.clientY }) }}
            style={{ opacity: 0, cursor: 'pointer', fontSize: 14 }}
          ><MoreOutlined /></span>
        </div>
      )
      if (node.type === 'dir') {
        const hasChildren = node.children && node.children.length > 0
        return { key: node.path, title, ...node, isLeaf: false, ...(hasChildren ? { children: renderTreeNodes(node.children) } : {}) }
      }
      return { key: node.path, title, ...node, isLeaf: true }
    })

  const tbBtn = (active, color) => ({
    size: 'small',
    style: {
      fontWeight: 700, fontSize: 13, borderRadius: 6, height: 34, minWidth: 34, padding: '0 8px',
      background: active ? 'rgba(255,255,255,0.15)' : 'transparent',
      color: active ? 'var(--color-primary)' : (color || 'var(--color-text)'),
      border: 'none', transition: 'all 0.15s',
    },
  })

  const moveFolderTree = moveModal.node ? collectFolders(tree, moveModal.node.path) : []

  return (
    <div
      id="editor-root"
      style={{
        display: 'flex',
        ...(isMobile
          ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }
          : { height: 'calc(100vh - 64px)', padding: '0 4px' }),
        gap: isMobile ? 0 : 12,
        overflow: 'hidden',
        background: 'var(--color-bg)',
      }}
    >
      {/* 左侧面板 - PC */}
      {!editorFullscreen && !isMobile && showSidebar && (
        <div style={{
          width: 360, flexShrink: 0, display: 'flex', flexDirection: 'column',
          background: 'var(--color-bg-card)', borderRadius: 12,
          border: '1px solid var(--color-border)', overflow: 'hidden',
          boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
        }}>
          {sidebarView === 'tree' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 12px 8px' }}>
                <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', fontWeight: 600 }}>目录</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <Button size="small" icon={<MenuOutlined />} onClick={handleToggleExpandAll} title={isAllExpanded ? '全部折叠' : '全部展开'} />
                  <Button size="small" icon={<NodeIndexOutlined />} onClick={handleLocateCurrentFile} title="定位当前文件" disabled={!activeFile} />
                  <Button size="small" icon={<PlusOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'dir' })} title="新建文件夹" />
                  <Button size="small" icon={<FileOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'file' })} title="新建文件" />
                </div>
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: '0 8px 8px' }}>
                <Tree
                  treeData={renderTreeNodes(tree)}
                  selectedKeys={[selectedKey]}
                  expandedKeys={expandedKeys}
                  onExpand={handleExpand}
                  expandAction="click"
                  draggable
                  onDrop={info => {
                    const target = info.node
                    const draggedKey = info.dragNodesKeys[0]
                    const draggedNode = findNode(tree, draggedKey)
                    const targetNode = findNode(tree, target.key)
                    if (!draggedNode || !targetNode || targetNode.type !== 'dir') return
                    if (draggedNode.path.startsWith(target.key + '/')) { message.warning('不能移动到自己的子目录'); return }
                    if (draggedNode.path !== target.key) handleMove(draggedNode, target.key)
                  }}
                />
              </div>
            </>
          )}

          {sidebarView === 'outline' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 12px 8px', borderBottom: '1px solid var(--color-border)' }}>
                <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => setSidebarView('tree')} title="返回目录" />
                <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', fontWeight: 600 }}>大纲</span>
                {activeFile && <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginLeft: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {activeFile.split('/').pop()}</span>}
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
                {outlineItems.length === 0 && (
                  <div style={{ padding: '24px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>当前文档无标题</div>
                )}
                {outlineItems.map((item, i) => (
                  <div
                    key={i}
                    onClick={() => editor?.commands.focus('start')}
                    style={{
                      padding: '6px 8px', fontSize: 13, cursor: 'pointer',
                      paddingLeft: 8 + (item.level - 1) * 14,
                      color: 'var(--color-text)',
                      borderRadius: 6, marginBottom: 2,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.05)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', fontWeight: 700, minWidth: 14 }}>H{item.level}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* 移动端抽屉侧边栏 */}
      <Modal
        title="📂 笔记目录" open={mobileSidebarOpen}
        onCancel={() => setMobileSidebarOpen(false)}
        footer={null}
        width={300}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <Button size="small" icon={<MenuOutlined />} onClick={handleToggleExpandAll} />
            <Button size="small" icon={<NodeIndexOutlined />} onClick={handleLocateCurrentFile} disabled={!activeFile} />
            <Button size="small" icon={<PlusOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'dir' })} />
            <Button size="small" icon={<FileOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'file' })} />
          </div>
          <Tree
            treeData={renderTreeNodes(tree)}
            selectedKeys={[selectedKey]}
            expandedKeys={expandedKeys}
            onExpand={handleExpand}
            expandAction="click"
            onDrop={info => {
              const target = info.node
              const draggedKey = info.dragNodesKeys[0]
              const draggedNode = findNode(tree, draggedKey)
              const targetNode = findNode(tree, target.key)
              if (!draggedNode || !targetNode || targetNode.type !== 'dir') return
              handleMove(draggedNode, target.key)
            }}
          />
        </div>
      </Modal>

      {/* 主区域 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: editorFullscreen ? 'hidden' : 'visible' }}>
        {/* 标签页 */}
        {openFiles.length > 0 && (
          <div style={{
            display: 'flex', background: 'var(--color-bg-card)',
            borderRadius: '8px 8px 0 0', border: '1px solid var(--color-border)', borderBottom: 'none',
            overflow: 'auto', flexShrink: 0,
          }}>
            {isMobile && (
              <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px', height: 36, flexShrink: 0, borderRight: '1px solid var(--color-border)', gap: 2 }}>
                <Button size="small" icon={<AppstoreOutlined />} onClick={() => setMobileSidebarOpen(true)} />
                <Tooltip title={showSidebar ? '隐藏文件栏' : '显示文件栏'}><Button size="small" {...tbBtn(!showSidebar)} onClick={() => setShowSidebar(v => !v)} icon={showSidebar ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />} /></Tooltip>
                <Tooltip title={showToolbar ? '隐藏工具栏' : '显示工具栏'}><Button size="small" {...tbBtn(!showToolbar)} onClick={() => setShowToolbar(v => !v)} icon={<AlignLeftOutlined />} /></Tooltip>
              </div>
            )}
            {openFiles.map(f => {
              const name = f.split('/').pop() || f
              const active = f === activeFile
              return (
                <div key={f} onClick={() => { setActiveFile(f); loadFile(f) }}
                  style={{
                    position: 'relative', display: 'flex', alignItems: 'center',
                    padding: '0 14px', height: 36, fontSize: 13, cursor: 'pointer',
                    borderRight: '1px solid var(--color-border)',
                    background: active ? 'var(--color-bg-card)' : 'transparent',
                    color: active ? 'rgba(0,0,0,0.85)' : 'var(--color-text-secondary)',
                    whiteSpace: 'nowrap', minWidth: 100, gap: 0,
                  }}>
                  {active && <div style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 6, height: 6, borderRadius: '50%', background: '#1890ff' }} />}
                  <FileOutlined style={{ color: '#74b9ff', marginLeft: 10 }} />
                  <span style={{ marginLeft: 6 }}>{name}</span>
                  <CloseOutlined style={{ fontSize: 10, marginLeft: 4, opacity: 0.6 }} onClick={e => handleClose(f, e)} />
                </div>
              )
            })}
          </div>
        )}

        {/* 编辑区 */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          background: 'var(--color-bg-card)',
          borderRadius: openFiles.length === 0 ? 12 : '0 0 12px 12px',
          border: '1px solid var(--color-border)', overflow: 'hidden',
          boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
        }}>
          {!activeFile ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              height: '100%', gap: 16, padding: 24, color: 'var(--color-text-secondary)',
            }}>
              {isMobile ? (
                <>
                  <FileOutlined style={{ fontSize: 48, opacity: 0.4 }} />
                  <Button type="primary" icon={<AppstoreOutlined />} onClick={() => setMobileSidebarOpen(true)}>📂 打开目录</Button>
                </>
              ) : (
                <span>从左侧选择文件</span>
              )}
            </div>
          ) : (
            <>
              {showToolbar && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 2, padding: '6px 12px',
                borderBottom: '1px solid var(--color-border)', flexShrink: 0, flexWrap: 'wrap',
              }}>
                {isMobile && <Button size="small" icon={<AppstoreOutlined />} onClick={() => setMobileSidebarOpen(true)} />}
                <Tooltip title="加粗 (Ctrl+B)"><Button {...tbBtn(editor?.isActive('bold') || false)} onClick={() => editor?.chain().focus().toggleBold().run()} icon={<BoldOutlined />} /></Tooltip>
                <Tooltip title="斜体 (Ctrl+I)"><Button {...tbBtn(editor?.isActive('italic') || false)} onClick={() => editor?.chain().focus().toggleItalic().run()} icon={<ItalicOutlined />} /></Tooltip>
                <Tooltip title="删除线"><Button {...tbBtn(editor?.isActive('strike') || false)} onClick={() => editor?.chain().focus().toggleStrike().run()} icon={<StrikethroughOutlined />} /></Tooltip>
                <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.12)', margin: '0 4px' }} />
                <Tooltip title="标题1"><Button {...tbBtn(editor?.isActive('heading', { level: 1 }) || false, 'rgba(0,0,0,0.65)')} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} style={{ fontWeight: 700 }}>H1</Button></Tooltip>
                <Tooltip title="标题2"><Button {...tbBtn(editor?.isActive('heading', { level: 2 }) || false, 'rgba(0,0,0,0.65)')} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} style={{ fontWeight: 700, fontSize: 12 }}>H2</Button></Tooltip>
                <Tooltip title="标题3"><Button {...tbBtn(editor?.isActive('heading', { level: 3 }) || false, 'rgba(0,0,0,0.65)')} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} style={{ fontWeight: 700, fontSize: 11 }}>H3</Button></Tooltip>
                <Tooltip title="标题4"><Button {...tbBtn(editor?.isActive('heading', { level: 4 }) || false, 'rgba(0,0,0,0.65)')} onClick={() => editor?.chain().focus().toggleHeading({ level: 4 }).run()} style={{ fontWeight: 700, fontSize: 10 }}>H4</Button></Tooltip>
                <Tooltip title="标题5"><Button {...tbBtn(editor?.isActive('heading', { level: 5 }) || false, 'rgba(0,0,0,0.65)')} onClick={() => editor?.chain().focus().toggleHeading({ level: 5 }).run()} style={{ fontWeight: 700, fontSize: 9 }}>H5</Button></Tooltip>
                <Tooltip title="标题6"><Button {...tbBtn(editor?.isActive('heading', { level: 6 }) || false, 'rgba(0,0,0,0.65)')} onClick={() => editor?.chain().focus().toggleHeading({ level: 6 }).run()} style={{ fontWeight: 700, fontSize: 8 }}>H6</Button></Tooltip>
                <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.12)', margin: '0 4px' }} />
                <Tooltip title="无序列表"><Button {...tbBtn(editor?.isActive('bulletList') || false)} onClick={() => editor?.chain().focus().toggleBulletList().run()} icon={<UnorderedListOutlined />} /></Tooltip>
                <Tooltip title="有序列表"><Button {...tbBtn(editor?.isActive('orderedList') || false)} onClick={() => editor?.chain().focus().toggleOrderedList().run()} icon={<OrderedListOutlined />} /></Tooltip>
                <Tooltip title="任务列表"><Button {...tbBtn(editor?.isActive('taskList') || false)} onClick={() => editor?.chain().focus().toggleTaskList().run()} icon={<CheckSquareOutlined />} /></Tooltip>
                <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.12)', margin: '0 4px' }} />
                <Tooltip title="引用"><Button {...tbBtn(editor?.isActive('blockquote') || false)} onClick={() => editor?.chain().focus().toggleBlockquote().run()} icon={<HolderOutlined />} /></Tooltip>
                <Tooltip title="代码块"><Button {...tbBtn(editor?.isActive('codeBlock') || false)} onClick={() => editor?.chain().focus().toggleCodeBlock().run()} icon={<ApiOutlined />} /></Tooltip>
                <Tooltip title="插入链接"><Button {...tbBtn(editor?.isActive('link') || false)} onClick={handleInsertLink} icon={<LinkOutlined />} /></Tooltip>
                <Tooltip title="插入表格"><Button {...tbBtn(false)} onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} icon={<TableOutlined />} /></Tooltip>
                <input type="file" accept="image/*" style={{ display: 'none' }} id="img-up" onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); e.target.value = '' }} />
                <Tooltip title="上传图片"><label><Button {...tbBtn(false)} icon={<UploadOutlined />} loading={uploading} /></label></Tooltip>

                <div style={{ flex: 1 }} />

                <Tooltip title="源文本" mouseEnterDelay={0.5}><Button {...tbBtn(showSource, 'rgba(0,0,0,0.75)')} onClick={async () => {
                    if (!showSource && activeFile) {
                      setSourceContent(savedContents[activeFile] || '')
                    }
                    if (showSource && sourceContent && activeFile) {
                      const zoomMap = {}
                      sourceContent.replace(/!\[([^\]]*)\]\((.*?)\)<!-- zoom:(\d+) -->/g, (_, _alt, src, zoom) => {
                        zoomMap[src.replace(/^\//, '')] = zoom
                        return ''
                      })
                      zoomMapRef.current = zoomMap
                      const html = marked.parse(sourceContent)
                      editor?.commands.setContent(html)
                      let attempts = 0
                      const poll = setInterval(() => {
                        const hasImg = document.querySelector('.ProseMirror img')
                        attempts++
                        if (hasImg || attempts > 40) { clearInterval(poll); applyZoom() }
                      }, 50)
                      setSavedContents(prev => ({ ...prev, [activeFile]: sourceContent }))
                      try {
                        await axios.put(API, { path: activeFile, content: sourceContent })
                      } catch { message.error('源码模式保存失败') }
                    }
                    setShowSource(v => !v)
                  }} icon={<CodeOutlined />} /></Tooltip>
                <Tooltip title={sidebarView === 'outline' ? '返回目录' : '大纲'} mouseEnterDelay={0.5}><Button {...tbBtn(sidebarView === 'outline', 'rgba(0,0,0,0.75)')} onClick={() => setSidebarView(v => v === 'outline' ? 'tree' : 'outline')} icon={<MenuOutlined />} /></Tooltip>
                {!editorFullscreen && <Tooltip title="全屏"><Button {...tbBtn(false)} onClick={() => setEditorFullscreen(true)} icon={<ExpandOutlined />} /></Tooltip>}
                {editorFullscreen && <Tooltip title="退出全屏"><Button {...tbBtn(true)} onClick={() => setEditorFullscreen(false)} icon={<ShrinkOutlined />} /></Tooltip>}
                <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.12)', margin: '0 4px' }} />
                {saveStatus === 'modified' && <span style={{ fontSize: 11, color: '#f39c12', marginRight: 6 }}>● 已修改</span>}
                {saveStatus === 'saving' && <span style={{ fontSize: 11, color: '#999', marginRight: 6 }}>保存中...</span>}
                {saveStatus === 'saved' && <span style={{ fontSize: 11, color: '#52c41a', marginRight: 6 }}>✓ 已保存</span>}
                <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSave} style={{ borderRadius: 6, height: 34 }}>保存</Button>
              </div>
              )}

              {/* 编辑区 */}
              {showSource ? (
                <textarea
                  value={sourceContent}
                  onChange={e => setSourceContent(e.target.value)}
                  style={{ flex: 1, width: '100%', border: 'none', outline: 'none', background: 'var(--color-bg-card)', color: 'var(--color-text)', fontFamily: 'monospace', fontSize: 14, lineHeight: 1.8, padding: '20px 32px', resize: 'none' }}
                />
              ) : (
                <div style={{ flex: 1, overflow: 'auto', padding: '20px 32px', background: 'var(--color-bg-card)' }}>
                  <style>{`
                    .ProseMirror { outline: none; min-height: 100%; font-size: 17px; line-height: 1.8; color: var(--color-text); }
                    .ProseMirror h1 { font-size: 1.8em; font-weight: 700; border-bottom: 1px solid var(--color-border); padding-bottom: 8px; margin: 1em 0 0.5em; }
                    .ProseMirror h2 { font-size: 1.4em; font-weight: 600; margin: 1em 0 0.5em; }
                    .ProseMirror h3 { font-size: 1.2em; font-weight: 600; margin: 0.8em 0 0.4em; }
                    .ProseMirror p { margin: 0.4em 0; }
                    .ProseMirror code { background: rgba(0,0,0,0.08); padding: 2px 6px; border-radius: 4px; font-size: 0.88em; font-family: 'JetBrains Mono', monospace; }
                    .ProseMirror pre {
                      background: #282c34 !important;
                      border-radius: 10px;
                      padding: 16px 20px;
                      margin: 0.8em 0;
                      overflow: auto;
                      border: 1px solid #3a3f4b;
                      box-shadow: 0 2px 12px rgba(0,0,0,0.25);
                      max-width: 760px;
                      display: block;
                    }
                    .ProseMirror pre code {
                      background: none !important;
                      padding: 0;
                      font-family: 'JetBrains Mono', 'Fira Code', monospace !important;
                      font-size: 13.5px;
                      line-height: 1.7;
                      color: #abb2bf;
                    }
                    .ProseMirror blockquote { border-left: 3px solid var(--color-border); padding-left: 12px; margin: 0.5em 0; color: var(--color-text-secondary); }
                    .ProseMirror img { max-width: 100%; border-radius: 4px; }
                    .ProseMirror ul, .ProseMirror ol { padding-left: 1.5em; margin: 0.4em 0; }
                    .ProseMirror li { margin: 0.2em 0; }
                    .ant-tree-treenode:hover .tree-node-more { opacity: 1 !important; }
                    .tree-node-more { transition: opacity 0.15s; }
                    /* ===== 表格样式 ===== */
                    .ProseMirror table {
                      width: 100%;
                      max-width: 760px;
                      border-collapse: collapse;
                      margin: 0.8em 0;
                      border-radius: 8px;
                      overflow: hidden;
                      border: 1px solid #d0d7de;
                      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
                    }
                    .ProseMirror table th {
                      background: #f1f3f5;
                      font-weight: 600;
                      text-align: left;
                      padding: 10px 14px;
                      border: 1px solid #d0d7de;
                      color: #1a1a1a;
                    }
                    .ProseMirror table td {
                      padding: 8px 14px;
                      border: 1px solid #e2e8f0;
                      vertical-align: top;
                    }
                    .ProseMirror table tr:nth-child(even) td {
                      background: #fafbfc;
                    }
                    .ProseMirror table tr:hover td {
                      background: #eef2ff !important;
                    }
                    .ProseMirror table td.selectedCell {
                      background: #dbeafe !important;
                    }
                    .ProseMirror .column-resize-handle {
                      background-color: #1a73e8;
                      width: 3px;
                    }
                  `}</style>
                  <div onPaste={e => {
                    const items = Array.from(e.clipboardData.items)
                    const imageItem = items.find(i => i.type.startsWith('image/'))
                    if (!imageItem) return
                    e.preventDefault()
                    const file = imageItem.getAsFile()
                    if (file) handleImageUpload(file)
                  }}>
                    <EditorContent editor={editor} style={{ height: '100%' }} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 新建 */}
      <Modal title={createModal.type === 'dir' ? '新建文件夹' : '新建文件'} open={createModal.open}
        onOk={handleCreate}
        onCancel={() => { setCreateModal({ open: false, parent: '', type: 'file' }); setCreateName('') }}
        okText="创建" cancelText="取消">
        <Input placeholder="名称" value={createName} onChange={e => setCreateName(e.target.value)} onPressEnter={handleCreate} autoFocus />
      </Modal>

      {/* 移动 */}
      <Modal title={`移动「${moveModal.node?.name}」到...`} open={moveModal.open}
        onOk={async () => { if (!moveModal.node) return; await handleMove(moveModal.node, moveTarget); setMoveModal({ open: false, node: null }) }}
        onCancel={() => setMoveModal({ open: false, node: null })}
        okText="移动" cancelText="取消">
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: 8, maxHeight: 260, overflow: 'auto' }}>
          <div onClick={() => setMoveTarget('')} style={{ padding: '4px 8px', borderRadius: 4, cursor: 'pointer', background: moveTarget === '' ? 'rgba(0,0,0,0.05)' : 'transparent', color: 'var(--color-text-secondary)', marginBottom: 4, fontSize: 13 }}>
            <FolderOpenOutlined style={{ color: '#f39c12', marginRight: 4 }} />根目录
          </div>
          <Tree treeData={renderTreeNodes(moveFolderTree)} selectedKeys={[moveTarget]} onSelect={([key]) => setMoveTarget((key) || '')} />
        </div>
      </Modal>

      {/* 右键菜单 */}
      {contextMenu.visible && contextMenu.node && (
        <div
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 9999, background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', padding: '4px 0', minWidth: 160 }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.node.type === 'dir' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={() => { setContextMenu(p => ({ ...p, visible: false })); setCreateModal({ open: true, parent: contextMenu.node.path, type: 'dir' }) }}>
                <FolderOpenOutlined style={{ color: '#f39c12' }} />在此创建文件夹
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={() => { setContextMenu(p => ({ ...p, visible: false })); setCreateModal({ open: true, parent: contextMenu.node.path, type: 'file' }) }}>
                <FileOutlined style={{ color: '#74b9ff' }} />在此创建文件
              </div>
            </>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={() => handleRenameStart(contextMenu.node)}>
            <EditOutlined />重命名
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={() => { setMoveModal({ open: true, node: contextMenu.node }); setMoveTarget(''); setContextMenu(p => ({ ...p, visible: false })) }}>
            <SwapOutlined />移动到...
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13, color: '#ff4d4f' }} onClick={() => { setContextMenu(p => ({ ...p, visible: false })); Modal.confirm({ title: `确定删除「${contextMenu.node.name}」？`, content: contextMenu.node.type === 'dir' ? '将递归删除所有内容' : '删除后不可恢复', okText: '删除', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => handleDelete(contextMenu.node) }) }}>
            <DeleteOutlined />删除
          </div>
        </div>
      )}
    </div>
  )
}
