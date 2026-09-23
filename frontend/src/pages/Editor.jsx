import { useState, useEffect, useCallback, useRef } from 'react'
import { Tree, Button, Modal, Input, message, Tooltip, Dropdown } from 'antd'
import {
  FileOutlined, FolderOpenOutlined, PlusOutlined, UploadOutlined, SaveOutlined,
  CloseOutlined, CheckSquareOutlined, TableOutlined, MoreOutlined, DeleteOutlined,
  SwapOutlined, BoldOutlined, ItalicOutlined, StrikethroughOutlined,
  UnorderedListOutlined, OrderedListOutlined, LinkOutlined, ExpandOutlined,
  ShrinkOutlined, HolderOutlined, ArrowLeftOutlined, EditOutlined, MenuOutlined,
  NodeIndexOutlined, CodeOutlined, ApiOutlined, AppstoreOutlined,
  AlignLeftOutlined, DownOutlined,
  CheckOutlined, LoadingOutlined, CloseCircleOutlined, ReloadOutlined,
  ReadOutlined, FileAddOutlined, FolderAddOutlined, SearchOutlined,
  ZoomInOutlined, ZoomOutOutlined
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
import { api as axios } from '../api'
import { marked } from 'marked'
import Turndown from 'turndown'
import { common, createLowlight } from 'lowlight'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import useEditorDrafts, { isImageFile } from './useEditorDrafts'
import DocumentTabs from './DocumentTabs'
import './Editor.css'

const lowlight = createLowlight(common)

const API = '/api/workspace'

function SaveStatus({ status, onRetry }) {
  const states = {
    modified: { icon: <EditOutlined />, label: '修改待保存', className: 'is-modified' },
    saving: { icon: <LoadingOutlined spin />, label: '保存中', className: 'is-saving' },
    saved: { icon: <CheckOutlined />, label: '已保存', className: 'is-saved' },
    error: { icon: <CloseCircleOutlined />, label: '保存失败', className: 'is-error' },
  }
  const current = states[status] || states.saved
  return (
    <div className={`save-status ${current.className}`} role="status" aria-live="polite">
      <span className="save-status-icon" aria-hidden="true">{current.icon}</span>
      <span>{current.label}</span>
      {status === 'error' && (
        <Button
          type="link"
          size="small"
          className="save-retry"
          icon={<ReloadOutlined />}
          onClick={onRetry}
          aria-label="重试保存"
        >重试</Button>
      )}
    </div>
  )
}

function imageSrcWithWorkspaceIdentity(src, info) {
  if (!src || !src.startsWith('/api/workspace/assets/') || !info?.workspaceId) return src
  try {
    const url = new URL(src, 'http://standalone-editor.local')
    url.searchParams.set('workspaceId', info.workspaceId)
    if (info.workspaceVersion != null) url.searchParams.set('workspaceVersion', String(info.workspaceVersion))
    return `${url.pathname}${url.search}${url.hash}`
  } catch { return src }
}

function markdownToHtml(markdown, imageIdentity) {
  const html = marked.parse(markdown || '')
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('ul').forEach(list => {
    const items = Array.from(list.children).filter(node => node.nodeName === 'LI')
    if (!items.length || !items.every(item => item.querySelector('input[type="checkbox"]'))) return
    list.setAttribute('data-type', 'taskList')
    items.forEach(item => {
      const checkbox = item.querySelector('input[type="checkbox"]')
      item.setAttribute('data-type', 'taskItem')
      item.setAttribute('data-checked', String(Boolean(checkbox?.checked)))
      checkbox?.remove()
    })
  })
  // Markdown saved by an older editor may contain a bare asset URL or an old
  // workspace version. <img> cannot send custom headers, so always refresh
  // the query identity at render time for the current workspace.
  doc.querySelectorAll('img[src]').forEach(image => {
    image.setAttribute('src', imageSrcWithWorkspaceIdentity(image.getAttribute('src'), imageIdentity))
  })
  return doc.body.innerHTML
}

function createMarkdownSerializer() {
  const td = new Turndown({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
  })
  td.addRule('editorStrike', {
    filter: ['del', 's'],
    replacement: content => `~~${content}~~`,
  })
  td.addRule('editorTaskItem', {
    filter: node => node.nodeName === 'LI' && node.parentNode?.getAttribute('data-type') === 'taskList',
    replacement: (content, node) => {
      const checked = node.getAttribute('data-checked') === 'true' ? 'x' : ' '
      return `- [${checked}] ${content.trim()}\n`
    },
  })
  td.addRule('editorTaskList', {
    filter: node => node.nodeName === 'UL' && node.getAttribute('data-type') === 'taskList',
    replacement: content => `\n${content.trim()}\n`,
  })
  td.addRule('editorTable', {
    filter: 'table',
    replacement: (content, node) => {
      const rows = Array.from(node.querySelectorAll('tr')).map(row =>
        Array.from(row.querySelectorAll('th,td')).map(cell =>
          td.turndown(cell.innerHTML).trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>')
        )
      ).filter(row => row.length)
      if (!rows.length) return ''
      const columns = Math.max(...rows.map(row => row.length))
      const normalized = rows.map(row => Array.from({ length: columns }, (_, index) => row[index] || ''))
      const separator = normalized[0].map(() => '---')
      const lines = [
        `| ${normalized[0].join(' | ')} |`,
        `| ${separator.join(' | ')} |`,
        ...normalized.slice(1).map(row => `| ${row.join(' | ')} |`),
      ]
      return `\n${lines.join('\n')}\n`
    },
  })
  return td
}

function htmlToMarkdown(html) {
  return createMarkdownSerializer().turndown(html || '')
}

function remapPath(pathValue, oldPath, newPath) {
  if (pathValue === oldPath) return newPath
  if (pathValue.startsWith(`${oldPath}/`)) return `${newPath}${pathValue.slice(oldPath.length)}`
  return pathValue
}

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

  // 排序：文件夹在前；同类型内：ASCII英文 > 中文
  const sortKey = (name) => {
    const hasNonAscii = /[^\x00-\x7F]/.test(name)
    const isAscii = !hasNonAscii
    return [isAscii ? 0 : 1, name]
  }

  roots.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    const [pa, sa] = sortKey(a.name)
    const [pb, sb] = sortKey(b.name)
    if (pa !== pb) return pa - pb
    return sa.localeCompare(sb)
  })

  const sortChildren = (nodes) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      const [pa, sa] = sortKey(a.name)
      const [pb, sb] = sortKey(b.name)
      if (pa !== pb) return pa - pb
      return sa.localeCompare(sb)
    })
    nodes.forEach(n => n.children && sortChildren(n.children))
  }
  sortChildren(roots)

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

export default function Editor({ workspace, workspaceInfo, onWorkspaceChange }) {
  const [tree, setTree] = useState([])
  const [selectedKey, setSelectedKey] = useState('')
  const [openFiles, setOpenFiles] = useState([])
  const [activeFile, setActiveFile] = useState('')
  const [tabMenu, setTabMenu] = useState({ visible: false, x: 0, y: 0, target: '' })
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
  const [showSidebar] = useState(true)
  const [showToolbar, setShowToolbar] = useState(true)
  const [sidebarView, setSidebarView] = useState('tree')
  const [showOutline, setShowOutline] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = parseInt(localStorage.getItem('sidebarWidth') || '280', 10)
    return Math.max(220, Math.min(520, Number.isFinite(stored) ? stored : 280))
  })
  const sidebarWidthRef = useRef(sidebarWidth)
  const isDraggingRef = useRef(false)
  const [expandedKeys, setExpandedKeys] = useState([])
  const [isAllExpanded, setIsAllExpanded] = useState(false)
  const [outlineItems, setOutlineItems] = useState([])
  const [imageViewer, setImageViewer] = useState(null)   // { path, url, name }
  const [imageZoom, setImageZoom] = useState(100)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [importModal, setImportModal] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)

  // The editor renders one document at a time, but every open tab keeps its
  // own Markdown draft. Refs make save callbacks independent of React's
  // render timing, which is essential when tabs are switched quickly.
  const activeFileRef = useRef(activeFile)
  const workspaceInfoRef = useRef(workspaceInfo)
  const showSourceRef = useRef(showSource)
  const sourceContentRef = useRef(sourceContent)
  const openFilesRef = useRef([])
  const {
    savedContents, setSavedContents,
    isDirty, setIsDirty,
    saveStatus, setSaveStatus,
    saveErrors, setSaveErrors,
    draftContentsRef, dirtyRef, saveTimersRef, saveQueuesRef,
    saveErrorsRef, cleanContentsRef,
    writePendingDrafts,
    remapPendingDrafts, removePendingDrafts,
    setDraft, clearSaveTimer, doSave, scheduleSave, waitForPathSaves,
  } = useEditorDrafts(workspace, activeFileRef)
  // renderedFileRef identifies the document currently represented by the
  // ProseMirror instance. While a file request is pending the editor still
  // contains the previous tab, so capturing it as the new tab would corrupt
  // that tab's draft.
  const renderedFileRef = useRef('')
  const loadingRef = useRef(false)
  const openRequestRef = useRef(0)
  const suppressEditorUpdateRef = useRef(false)
  const handleImageUploadRef = useRef(null)

  useEffect(() => { activeFileRef.current = activeFile }, [activeFile])
  useEffect(() => { workspaceInfoRef.current = workspaceInfo }, [workspaceInfo])
  useEffect(() => { openFilesRef.current = openFiles }, [openFiles])
  useEffect(() => { showSourceRef.current = showSource }, [showSource])
  useEffect(() => { sourceContentRef.current = sourceContent }, [sourceContent])

  useEffect(() => {
    if (workspaceInfo?.workspaceId) {
      // App normally installs this context before mounting Editor. This
      // fallback also makes a direct Editor mount use the supplied identity.
      localStorage.setItem('editor_workspace_info', JSON.stringify(workspaceInfo))
      localStorage.setItem('editor_workspace', workspaceInfo.workspace || workspace)
    }
  }, [workspaceInfo, workspace])

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

  useEffect(() => {
    if (!editor) return
    const editable = Boolean(
      activeFile && !fileLoading && !isImageFile(activeFile) &&
      renderedFileRef.current === activeFile
    )
    editor.setEditable(editable)
  }, [activeFile, editor, fileLoading])

  const refreshOutline = useCallback(() => {
    if (!editor) return
    const items = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        items.push({ level: node.attrs.level, text: node.textContent, pos })
      }
    })
    setOutlineItems(items)
  }, [editor])

  useEffect(() => {
    if (!editor) return
    refreshOutline()
    editor.on('update', refreshOutline)
    return () => editor.off('update', refreshOutline)
  }, [editor, refreshOutline, activeFile, savedContents[activeFile]])

  // 键盘快捷键
  useEffect(() => {
    if (!editor) return
    const handler = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const currentPath = activeFileRef.current
      if (e.key === 's') {
        e.preventDefault()
        if (currentPath && !isImageFile(currentPath)) handleSave()
        return
      }
      if (!currentPath || isImageFile(currentPath) || showSourceRef.current) return
      if (e.key === 'b') { e.preventDefault(); editor.chain().focus().toggleBold().run() }
      if (e.key === 'i') { e.preventDefault(); editor.chain().focus().toggleItalic().run() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [editor, activeFile])

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

  // TipTap paste handler — use a ref so it always sees the current tab.
  useEffect(() => {
    if (!editor) return
    const handlePaste = event => {
      const items = Array.from(event.clipboardData?.items || [])
      const imageItem = items.find(item => item.type.startsWith('image/'))
      if (!imageItem) return
      event.preventDefault()
      const file = imageItem.getAsFile()
      if (file) handleImageUploadRef.current?.(file)
    }
    const dom = editor.view.dom
    dom.addEventListener('paste', handlePaste)
    return () => dom.removeEventListener('paste', handlePaste)
  }, [editor])

  useEffect(() => {
    if (!editor) return
    const observer = new MutationObserver(() => applyZoom())
    const el = editor.view.dom
    observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
    const onTransaction = () => setTimeout(applyZoom, 0)
    editor.on('transaction', onTransaction)
    return () => { observer.disconnect(); editor.off('transaction', onTransaction) }
  }, [editor, applyZoom])

  const loadTree = useCallback(async () => {
    try {
      const res = await axios.get(API, { params: { recursive: '1' } })
      setTree(buildTree(res.data || []))
      setExpandedKeys(prev => prev.filter(key => findNode(buildTree(res.data || []), key)))
    } catch {}
  }, [])

  // 搜索文件
  const handleSearch = useCallback(async q => {
    setSearchQuery(q)
    if (!q.trim()) { setSearchResults([]); return }
    try {
      const res = await axios.get(`${API}/search`, { params: { q } })
      setSearchResults(res.data || [])
    } catch { setSearchResults([]) }
  }, [])

  const handleExpand = useCallback(keys => setExpandedKeys(keys), [])

  useEffect(() => { loadTree() }, [loadTree])

  useEffect(() => {
    const handler = () => {
      setContextMenu(p => ({ ...p, visible: false }))
      setTabMenu(p => ({ ...p, visible: false }))
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  const setEditorMarkdown = useCallback((content) => {
    if (!editor) return
    suppressEditorUpdateRef.current = true
    editor.commands.setContent(markdownToHtml(content, workspaceInfoRef.current), false)
    setTimeout(() => { suppressEditorUpdateRef.current = false }, 0)
  }, [editor])

  const serializeCurrentEditor = useCallback(() => {
    if (!editor) return ''
    let md = htmlToMarkdown(editor.getHTML())
    document.querySelectorAll('.ProseMirror img[data-zoom]').forEach(img => {
      const zoom = img.getAttribute('data-zoom')
      if (zoom && zoom !== '100') {
        const src = img.getAttribute('src') || ''
        const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = `!\\[([^\\]]*)\\]\\(${escapedSrc}\\)`
        md = md.replace(new RegExp(pattern), `$&<!-- zoom:${zoom} -->`)
      }
    })
    return md
  }, [editor])

  const captureCurrentDraft = useCallback(() => {
    const path = activeFileRef.current
    if (!path || isImageFile(path) || loadingRef.current || renderedFileRef.current !== path) return undefined
    // Converting Markdown to editor HTML and back can normalize whitespace or
    // syntax even when the user has not touched the document. Keep the exact
    // loaded bytes for clean files; real edits are already marked by the
    // editor update handler (or the source textarea's change handler).
    if (!dirtyRef.current[path]) return draftContentsRef.current[path] ?? cleanContentsRef.current[path]
    const content = showSourceRef.current ? sourceContentRef.current : serializeCurrentEditor()
    setDraft(path, content, true)
    return content
  }, [serializeCurrentEditor])

  // 编辑内容变化 → 将当前快照绑定到当前路径，再防抖保存。
  useEffect(() => {
    if (!editor) return
    const handler = () => {
      if (suppressEditorUpdateRef.current) return
      const path = activeFileRef.current
      if (!path || isImageFile(path) || showSourceRef.current || loadingRef.current || renderedFileRef.current !== path) return
      const content = serializeCurrentEditor()
      setDraft(path, content, true)
      setSaveStatus('modified')
      scheduleSave(path, content)
    }
    editor.on('update', handler)
    return () => editor.off('update', handler)
  }, [editor, scheduleSave, serializeCurrentEditor])

  const loadFile = useCallback(async (path, requestId) => {
    try {
      const res = await axios.get(`${API}/file`, { params: { path } })
      const fetched = res.data.content ?? ''
      if (draftContentsRef.current[path] === undefined || !dirtyRef.current[path]) {
        cleanContentsRef.current[path] = fetched
        setDraft(path, fetched, false)
      }
      if (requestId !== openRequestRef.current || activeFileRef.current !== path) return
      const visible = draftContentsRef.current[path] ?? fetched
      const zoomMap = {}
      const withoutZoom = visible.replace(/!\[(.*?)\]\((.*?)\)<!-- zoom:(\d+) -->/g, (_, _alt, src, zoom) => {
        zoomMap[src.replace(/^\//, '')] = zoom
        return `![${_alt}](${src})`
      })
      zoomMapRef.current = zoomMap
      sourceContentRef.current = visible
      renderedFileRef.current = path
      loadingRef.current = false
      setFileLoading(false)
      setEditorMarkdown(withoutZoom)
      setSourceContent(visible)
      setSaveStatus(saveErrorsRef.current[path] ? 'error' : (dirtyRef.current[path] ? 'modified' : 'saved'))
      if (window.matchMedia('(max-width: 768px)').matches) setMobileSidebarOpen(false)
      setTimeout(applyZoom, 0)
    } catch (error) {
      if (requestId !== openRequestRef.current || activeFileRef.current !== path) return
      loadingRef.current = false
      renderedFileRef.current = ''
      setFileLoading(false)
      setEditorMarkdown('')
      sourceContentRef.current = ''
      setSourceContent('')
      setSaveStatus('idle')
      message.error('打开文件失败：' + (error.response?.data?.error || error.message))
    }
  }, [applyZoom, setEditorMarkdown])

  const handleFileOpen = useCallback(async node => {
    const path = node.path
    if (
      activeFileRef.current === path &&
      renderedFileRef.current === path &&
      !loadingRef.current
    ) {
      setFileLoading(false)
      editor?.setEditable(!isImageFile(node.name || path))
      return
    }
    const requestId = ++openRequestRef.current
    const previousPath = activeFileRef.current
    if (
      previousPath && previousPath !== path &&
      !loadingRef.current && renderedFileRef.current === previousPath
    ) captureCurrentDraft()
    setSelectedKey(path)
    if (!openFilesRef.current.includes(path)) {
      openFilesRef.current = [...openFilesRef.current, path]
      setOpenFiles(prev => prev.includes(path) ? prev : [...prev, path])
    }
    activeFileRef.current = path
    setActiveFile(path)
    setShowSource(false)
    showSourceRef.current = false
    loadingRef.current = true
    setFileLoading(true)
    editor?.setEditable(false)

    if (isImageFile(node.name || path)) {
      setImageViewer(null)
      try {
        const res = await axios.get(`${API}/image`, { params: { path } })
        if (requestId !== openRequestRef.current || activeFileRef.current !== path) return
        loadingRef.current = false
        renderedFileRef.current = path
        setFileLoading(false)
        setImageViewer({ path, url: `data:${res.data.mime};base64,${res.data.data}`, name: node.name || path.split('/').pop() })
        setImageZoom(100)
        setSaveStatus('saved')
      } catch (error) {
        if (requestId !== openRequestRef.current || activeFileRef.current !== path) return
        loadingRef.current = false
        renderedFileRef.current = ''
        setFileLoading(false)
        setImageViewer(null)
        message.error('打开图片失败：' + (error.response?.data?.error || error.message))
      }
      return
    }
    setImageViewer(null)
    if (draftContentsRef.current[path] !== undefined) {
      if (requestId !== openRequestRef.current || activeFileRef.current !== path) return
      const visible = draftContentsRef.current[path]
      const zoomMap = {}
      const withoutZoom = visible.replace(/!\[(.*?)\]\((.*?)\)<!-- zoom:(\d+) -->/g, (_, _alt, src, zoom) => {
        zoomMap[src.replace(/^\//, '')] = zoom
        return `![${_alt}](${src})`
      })
      zoomMapRef.current = zoomMap
      sourceContentRef.current = visible
      renderedFileRef.current = path
      loadingRef.current = false
      setFileLoading(false)
      setEditorMarkdown(withoutZoom)
      setSourceContent(visible)
      setSaveStatus(saveErrorsRef.current[path] ? 'error' : (dirtyRef.current[path] ? 'modified' : 'saved'))
      setTimeout(applyZoom, 0)
    } else {
      await loadFile(path, requestId)
    }
  }, [applyZoom, captureCurrentDraft, editor, loadFile, setEditorMarkdown])

  const removeTabState = useCallback(path => {
    clearSaveTimer(path)
    saveQueuesRef.current.delete(path)
    const nextErrors = { ...saveErrorsRef.current }
    delete nextErrors[path]
    saveErrorsRef.current = nextErrors
    setSaveErrors(nextErrors)
    delete draftContentsRef.current[path]
    delete dirtyRef.current[path]
    delete cleanContentsRef.current[path]
    setIsDirty(prev => { const next = { ...prev }; delete next[path]; return next })
    setSavedContents(prev => { const next = { ...prev }; delete next[path]; return next })
  }, [clearSaveTimer])

  const pathsUnder = useCallback(path => (
    openFilesRef.current.filter(file => file === path || file.startsWith(`${path}/`))
  ), [])

  const flushPaths = useCallback(async paths => {
    if (paths.includes(activeFileRef.current)) captureCurrentDraft()
    await waitForPathSaves(paths)
    // A timer may have been installed by a stale render while the request was
    // being awaited. Clearing it here prevents an old path from coming back
    // after a successful move or delete.
    paths.forEach(clearSaveTimer)
  }, [captureCurrentDraft, clearSaveTimer, waitForPathSaves])

  const handleClose = useCallback(async (path, e) => {
    e?.stopPropagation()
    try {
      await flushPaths([path])
    } catch {
      message.error('保存失败，标签页仍保持打开')
      return
    }
    const remaining = openFilesRef.current.filter(file => file !== path)
    removeTabState(path)
    openFilesRef.current = remaining
    setOpenFiles(remaining)
    if (activeFileRef.current === path) {
      const next = remaining[remaining.length - 1] || ''
      activeFileRef.current = next
      setActiveFile(next)
      setImageViewer(null)
      if (next) {
        await handleFileOpen({ path: next, name: next.split('/').pop(), type: 'file' })
      } else {
        openRequestRef.current += 1
        loadingRef.current = false
        setFileLoading(false)
        renderedFileRef.current = ''
        setEditorMarkdown('')
        sourceContentRef.current = ''
        setSourceContent('')
        setSaveStatus('idle')
      }
    }
  }, [flushPaths, handleFileOpen, removeTabState, setEditorMarkdown])

  const handleSave = useCallback(async () => {
    const path = activeFileRef.current
    if (!path || isImageFile(path)) return
    const content = showSourceRef.current ? sourceContentRef.current : captureCurrentDraft()
    if (content === undefined) return
    setSaveStatus('saving')
    try {
      await doSave(path, content)
      message.success('保存成功')
    } catch { message.error('保存失败，已保留未保存状态') }
  }, [captureCurrentDraft, doSave])

  const handleRetrySave = useCallback(() => {
    const path = activeFileRef.current
    if (!path || isImageFile(path)) return
    const content = showSourceRef.current ? sourceContentRef.current : captureCurrentDraft()
    if (content === undefined) return
    setSaveStatus('saving')
    doSave(path, content).catch(() => {})
  }, [captureCurrentDraft, doSave])

  const handleToggleSource = useCallback(() => {
    const path = activeFileRef.current
    if (!path || loadingRef.current || renderedFileRef.current !== path) return
    if (!showSourceRef.current) {
      const content = captureCurrentDraft() ?? draftContentsRef.current[path] ?? ''
      sourceContentRef.current = content
      setSourceContent(content)
      showSourceRef.current = true
      setShowSource(true)
      return
    }
    const content = sourceContentRef.current
    const zoomMap = {}
    content.replace(/!\[([^\]]*)\]\((.*?)\)<!-- zoom:(\d+) -->/g, (_, _alt, src, zoom) => {
      zoomMap[src.replace(/^\//, '')] = zoom
      return ''
    })
    zoomMapRef.current = zoomMap
    setEditorMarkdown(content.replace(/!\[([^\]]*)\]\((.*?)\)<!-- zoom:(\d+) -->/g, '![$1]($2)'))
    setDraft(path, content, content !== cleanContentsRef.current[path])
    if (content !== cleanContentsRef.current[path]) setSaveStatus('modified')
    showSourceRef.current = false
    setShowSource(false)
    setTimeout(applyZoom, 0)
  }, [applyZoom, captureCurrentDraft, setEditorMarkdown])

  const handleChangeWorkspace = useCallback(async () => {
    try {
      await flushPaths(openFilesRef.current)
    } catch {
      message.error('保存失败，暂不能更改目录')
      return
    }
    openRequestRef.current += 1
    onWorkspaceChange?.('')
  }, [flushPaths, onWorkspaceChange])

  // Give the browser a last chance to transmit drafts when a tab/window is
  // closed. The confirmation keeps the page alive long enough for keepalive
  // requests to be queued; clean documents leave unload completely silent.
  useEffect(() => {
    const handler = event => {
      if (
        activeFileRef.current && !loadingRef.current &&
        renderedFileRef.current === activeFileRef.current &&
        !isImageFile(activeFileRef.current)
      ) captureCurrentDraft()

      const pendingPaths = new Set([
        ...Object.entries(dirtyRef.current).filter(([, dirty]) => dirty).map(([path]) => path),
        ...saveTimersRef.current.keys(),
        ...saveQueuesRef.current.keys(),
      ])
      if (!pendingPaths.size) return

      // Preserve drafts locally instead of issuing a second unordered PUT
      // beside an in-flight save. If the user cancels the browser prompt,
      // existing timers and queues continue normally.
      const drafts = Object.fromEntries([...pendingPaths].flatMap(path => {
        const content = draftContentsRef.current[path]
        return content === undefined || isImageFile(path) ? [] : [[path, content]]
      }))
      writePendingDrafts(drafts)
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [captureCurrentDraft, writePendingDrafts])

  const closeTabGroup = useCallback(async paths => {
    const closing = new Set(paths)
    try {
      await flushPaths(paths)
    } catch {
      message.error('保存失败，未关闭相关标签页')
      return
    }
    paths.forEach(path => removeTabState(path))
    const remaining = openFilesRef.current.filter(path => !closing.has(path))
    openFilesRef.current = remaining
    setOpenFiles(remaining)
    if (closing.has(activeFileRef.current)) {
      const next = remaining[remaining.length - 1] || ''
      activeFileRef.current = next
      setActiveFile(next)
      setImageViewer(null)
      if (next) {
        await handleFileOpen({ path: next, name: next.split('/').pop(), type: 'file' })
      } else {
        openRequestRef.current += 1
        loadingRef.current = false
        setFileLoading(false)
        renderedFileRef.current = ''
        setEditorMarkdown('')
        sourceContentRef.current = ''
        setSourceContent('')
        setSaveStatus('idle')
      }
    }
  }, [flushPaths, handleFileOpen, removeTabState, setEditorMarkdown])

  // 导出当前文件。下载请求也要经过 API 客户端，以带上工作空间标识。
  const handleExport = async () => {
    const path = activeFileRef.current
    if (!path || isImageFile(path)) return
    try {
      const res = await axios.get(`${API}/export`, { params: { path }, responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = path.split('/').pop() || 'export.md'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { message.error('导出失败：' + (error.response?.data?.error || error.message)) }
  }

  // 导入弹窗处理
  const handleImport = async (file) => {
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await axios.post(`${API}/import`, formData, { headers: { 'Content-Type': 'multipart/form-data' } })
      message.success(res.data.message || '导入成功')
      setImportModal(false)
      await loadTree()
    } catch (e) { message.error('导入失败：' + (e.response?.data?.error || e.message)) }
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
    } catch (error) { message.error('创建失败：' + (error.response?.data?.error || error.message)) }
  }

  const handleImageUpload = async (file) => {
    const targetFile = activeFileRef.current
    const requestId = openRequestRef.current
    if (
      !targetFile || isImageFile(targetFile) || loadingRef.current ||
      renderedFileRef.current !== targetFile
    ) {
      message.error('请先打开一个 Markdown 文件')
      return
    }
    if (!editor) return
    const formData = new FormData()
    formData.append('file', file)
    formData.append('path', 'assets')
    setUploading(true)
    try {
      const res = await axios.post(`${API}/upload`, formData)
      // img 标签不会自动带自定义请求头，因此资源 URL 携带同一个只读身份。
      const info = workspaceInfo || JSON.parse(localStorage.getItem('editor_workspace_info') || 'null') || {}
      const query = info.workspaceId
        ? `?workspaceId=${encodeURIComponent(info.workspaceId)}&workspaceVersion=${encodeURIComponent(info.workspaceVersion ?? '')}`
        : ''
      const src = `/api/workspace/assets/${encodeURIComponent(res.data.filename)}${query}`
      if (
        activeFileRef.current === targetFile &&
        openRequestRef.current === requestId &&
        !loadingRef.current && renderedFileRef.current === targetFile
      ) editor?.chain().focus().setImage({ src }).run()
      message.success('图片已插入')
    } catch (e) { message.error('上传失败：' + (e.response?.data?.error || e.message)) }
    finally { setUploading(false) }
  }

  handleImageUploadRef.current = handleImageUpload

  const handleDelete = async (node) => {
    const removed = pathsUnder(node.path)
    try {
      await flushPaths(removed)
      await axios.delete(API, { params: { path: node.path } })
      removePendingDrafts(node.path)
      removed.forEach(file => removeTabState(file))
      if (removed.length) {
        const remaining = openFilesRef.current.filter(file => !removed.includes(file))
        openFilesRef.current = remaining
        setOpenFiles(remaining)
        if (removed.includes(activeFileRef.current)) {
          const next = remaining[remaining.length - 1] || ''
          activeFileRef.current = next
          setActiveFile(next)
          setImageViewer(null)
          if (next) {
            await handleFileOpen({ path: next, name: next.split('/').pop(), type: 'file' })
          } else {
            openRequestRef.current += 1
            loadingRef.current = false
            setFileLoading(false)
            renderedFileRef.current = ''
            setEditorMarkdown('')
            sourceContentRef.current = ''
            setSourceContent('')
            setSaveStatus('idle')
          }
        }
      }
      await loadTree()
      message.success('删除成功')
    } catch (error) {
      message.error('删除失败：' + (error.response?.data?.error || error.message))
    }
  }

  const handleMove = async (node, newParent) => {
    const parts = node.path.split('/')
    const oldName = parts.pop() || node.name
    const newPath = newParent ? `${newParent}/${oldName}` : oldName
    if (node.path === newPath) return
    if (node.type === 'dir' && newPath.startsWith(`${node.path}/`)) {
      message.warning('不能移动到自己的子目录')
      return
    }
    const affected = pathsUnder(node.path)
    try {
      await flushPaths(affected)
      await axios.post(`${API}/move`, { old_path: node.path, new_path: newPath })
      remapPendingDrafts(node.path, newPath)
      const migrate = source => Object.fromEntries(
        Object.entries(source).map(([key, value]) => [remapPath(key, node.path, newPath), value])
      )
      affected.forEach(clearSaveTimer)
      draftContentsRef.current = migrate(draftContentsRef.current)
      dirtyRef.current = migrate(dirtyRef.current)
      cleanContentsRef.current = migrate(cleanContentsRef.current)
      const migratedErrors = migrate(saveErrorsRef.current)
      saveErrorsRef.current = migratedErrors
      setSaveErrors(migratedErrors)
      setSavedContents(migrate)
      setIsDirty(migrate)
      setOpenFiles(prev => prev.map(file => remapPath(file, node.path, newPath)))
      openFilesRef.current = openFilesRef.current.map(file => remapPath(file, node.path, newPath))
      setExpandedKeys(prev => prev.map(key => remapPath(key, node.path, newPath)))
      setSelectedKey(prev => remapPath(prev, node.path, newPath))
      if (activeFileRef.current) {
        activeFileRef.current = remapPath(activeFileRef.current, node.path, newPath)
        setActiveFile(activeFileRef.current)
      }
      renderedFileRef.current = remapPath(renderedFileRef.current, node.path, newPath)
      await loadTree()
      message.success('移动成功')
    } catch (error) {
      message.error('移动失败：' + (error.response?.data?.error || error.message))
    }
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
    const affected = pathsUnder(renamingPath)
    try {
      await flushPaths(affected)
      await axios.post(`${API}/move`, { old_path: renamingPath, new_path: newPath })
      remapPendingDrafts(renamingPath, newPath)
      const migrate = source => Object.fromEntries(
        Object.entries(source).map(([key, value]) => [remapPath(key, renamingPath, newPath), value])
      )
      affected.forEach(clearSaveTimer)
      draftContentsRef.current = migrate(draftContentsRef.current)
      dirtyRef.current = migrate(dirtyRef.current)
      cleanContentsRef.current = migrate(cleanContentsRef.current)
      const migratedErrors = migrate(saveErrorsRef.current)
      saveErrorsRef.current = migratedErrors
      setSaveErrors(migratedErrors)
      setSavedContents(migrate)
      setIsDirty(migrate)
      setOpenFiles(prev => prev.map(file => remapPath(file, renamingPath, newPath)))
      openFilesRef.current = openFilesRef.current.map(file => remapPath(file, renamingPath, newPath))
      setExpandedKeys(prev => prev.map(key => remapPath(key, renamingPath, newPath)))
      setSelectedKey(prev => remapPath(prev, renamingPath, newPath))
      if (activeFileRef.current) {
        activeFileRef.current = remapPath(activeFileRef.current, renamingPath, newPath)
        setActiveFile(activeFileRef.current)
      }
      renderedFileRef.current = remapPath(renderedFileRef.current, renamingPath, newPath)
      await loadTree()
      message.success('重命名成功')
    } catch (error) {
      message.error('重命名失败：' + (error.response?.data?.error || error.message))
    }
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
          style={{ padding: '1px 4px', fontSize: 13, width: '100%', border: '1px solid var(--color-primary)', borderRadius: 4, outline: 'none', background: 'var(--color-bg-card)', color: 'var(--color-text)' }}
        />
      ) : (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, overflow: 'hidden', paddingLeft: node.type === 'file' ? 20 : 0 }}
          onClick={node.type === 'file' ? e => { e.stopPropagation(); handleFileOpen(node); if (isMobile) setMobileSidebarOpen(false) } : undefined}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ visible: true, node, x: e.clientX, y: e.clientY }) }}
        >
          {node.type === 'dir' ? <FolderOpenOutlined style={{ color: 'var(--color-warning)' }} /> : <FileOutlined style={{ color: 'var(--color-file)' }} />}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
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
      background: active ? 'var(--color-surface-selected)' : 'transparent',
      color: active ? 'var(--color-primary)' : (color || 'var(--color-text)'),
      border: 'none', transition: 'all 0.15s',
    },
  })

  const moveFolderTree = moveModal.node ? collectFolders(tree, moveModal.node.path) : []
  const activeSaveStatus = activeFile
    ? (saveErrors[activeFile] ? 'error' : (saveStatus === 'idle' ? 'saved' : saveStatus))
    : 'idle'
  const headingItems = [
    { key: 'paragraph', label: '正文' },
    { key: 'heading-1', label: '标题 1' },
    { key: 'heading-2', label: '标题 2' },
    { key: 'heading-3', label: '标题 3' },
    { key: 'heading-4', label: '标题 4' },
    { key: 'heading-5', label: '标题 5' },
    { key: 'heading-6', label: '标题 6' },
  ]
  const activeHeading = [1, 2, 3, 4, 5, 6].find(level => editor?.isActive('heading', { level }))
  const activeHeadingLabel = activeHeading ? `标题 ${activeHeading}` : '正文'
  const mobileToolbarItems = [
    { key: 'strike', label: '删除线', icon: <StrikethroughOutlined /> },
    { key: 'bullet-list', label: '无序列表', icon: <UnorderedListOutlined /> },
    { key: 'ordered-list', label: '有序列表', icon: <OrderedListOutlined /> },
    { key: 'task-list', label: '任务列表', icon: <CheckSquareOutlined /> },
    { type: 'divider' },
    { key: 'blockquote', label: '引用', icon: <HolderOutlined /> },
    { key: 'code-block', label: '代码块', icon: <ApiOutlined /> },
    { key: 'link', label: '插入链接', icon: <LinkOutlined /> },
    { key: 'table', label: '插入表格', icon: <TableOutlined /> },
    { key: 'image', label: '上传图片', icon: <UploadOutlined /> },
  ]
  const applyMobileToolbarAction = ({ key }) => {
    const chain = editor?.chain().focus()
    if (key === 'strike') chain?.toggleStrike().run()
    if (key === 'bullet-list') chain?.toggleBulletList().run()
    if (key === 'ordered-list') chain?.toggleOrderedList().run()
    if (key === 'task-list') chain?.toggleTaskList().run()
    if (key === 'blockquote') chain?.toggleBlockquote().run()
    if (key === 'code-block') chain?.toggleCodeBlock().run()
    if (key === 'link') handleInsertLink()
    if (key === 'table') chain?.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    if (key === 'image') document.getElementById('img-up')?.click()
  }

  return (
    <div
      id="editor-root"
      className="editor-shell"
      style={{
        display: 'flex',
        ...(isMobile
          ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }
          : { height: 'calc(100vh - 0px)', padding: 0 }),
        gap: isMobile ? 0 : 0,
        overflow: 'hidden',
        background: 'var(--color-bg)',
      }}
    >
      {/* 左侧面板 - PC */}
      {!editorFullscreen && !isMobile && showSidebar && (
        <div className="workspace-sidebar" style={{
          width: sidebarWidth, flexShrink: 0, display: 'flex', flexDirection: 'column',
          background: 'var(--color-bg-card)', borderRadius: 0,
          border: '1px solid var(--color-border)', overflow: 'hidden',
          boxShadow: 'var(--shadow-lg)',
        }}>
          {sidebarView === 'tree' && (
            <>
              <div className="sidebar-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 12px 8px', borderBottom: '1px solid var(--color-border)' }}>
                <div className="sidebar-heading">
                  <span className="sidebar-title">目录</span>
                </div>
                <div className="sidebar-actions" style={{ display: 'flex', gap: 4 }}>
                  <Tooltip title="更改目录"><Button size="small" icon={<FolderOpenOutlined />} onClick={handleChangeWorkspace} aria-label="更改目录" title="更改目录" /></Tooltip>
                  <Tooltip title="新建文件"><Button size="small" icon={<FileAddOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'file' })} aria-label="新建文件" title="新建文件" /></Tooltip>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'expand', label: isAllExpanded ? '全部折叠' : '全部展开', icon: <MenuOutlined /> },
                        { key: 'locate', label: '定位当前文件', icon: <NodeIndexOutlined />, disabled: !activeFile },
                        { type: 'divider' },
                        { key: 'folder', label: '新建文件夹', icon: <FolderAddOutlined /> },
                        { key: 'import', label: '导入文件', icon: <UploadOutlined /> },
                        { key: 'export', label: '导出当前文件', icon: <ApiOutlined />, disabled: !activeFile },
                      ],
                      onClick: ({ key }) => {
                        if (key === 'expand') handleToggleExpandAll()
                        if (key === 'locate') handleLocateCurrentFile()
                        if (key === 'folder') setCreateModal({ open: true, parent: '', type: 'dir' })
                        if (key === 'import') setImportModal(true)
                        if (key === 'export') handleExport()
                      },
                    }}
                  >
                    <Tooltip title="更多目录操作"><Button size="small" icon={<MoreOutlined />} aria-label="更多目录操作" /></Tooltip>
                  </Dropdown>
                </div>
              </div>
              {/* 搜索框 */}
              <div className="sidebar-search" style={{ padding: '0 8px 8px' }}>
                <Input size="small" prefix={<SearchOutlined />} placeholder="搜索文件..." allowClear
                  value={searchQuery} onChange={e => handleSearch(e.target.value)} />
              </div>
              {/* 搜索结果 */}
              {searchQuery && (
                <div style={{ padding: '0 8px 8px', maxHeight: 200, overflow: 'auto' }}>
                  {searchResults.length === 0 && (
                    <div style={{ padding: '8px 4px', fontSize: 12, color: 'var(--color-text-secondary)' }}>无结果</div>
                  )}
                  {searchResults.map(r => (
                    <div key={r.path} onClick={() => handleFileOpen({ path: r.path, name: r.name, type: 'file' })}
                      style={{ padding: '6px 8px', cursor: 'pointer', borderRadius: 6, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <FileOutlined style={{ color: 'var(--color-file)', marginRight: 6 }} />
                      <span style={{ fontWeight: 500 }}>{r.name}</span>
                      {r.preview && <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 20 }}>{r.preview}</div>}
                    </div>
                  ))}
                </div>
              )}
              <div className="tree-scroll" style={{ flex: '1 1 0%', minHeight: 0, minWidth: 0, overflowX: 'hidden', overflowY: 'auto', padding: '0 8px 8px' }}>
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
                    onClick={() => {
                      if (!editor || item.pos == null) return
                      editor.chain().focus().setTextSelection(Math.min(item.pos + 1, editor.state.doc.content.size)).scrollIntoView().run()
                    }}
                    style={{
                      padding: '6px 8px', fontSize: 13, cursor: 'pointer',
                      paddingLeft: 8 + (item.level - 1) * 14,
                      color: 'var(--color-text)',
                      borderRadius: 6, marginBottom: 2,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', fontWeight: 700, minWidth: 14 }}>H{item.level}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="workspace-status" style={{ flexShrink: 0, padding: '4px 12px 6px', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-muted)' }}>
            <div title={workspace} aria-label={`当前目录：${workspace}`} style={{ fontSize: 11, lineHeight: '16px', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspace}</div>
          </div>
        </div>
      )}

      {/* 拖拽分隔条：window级监听，2px视觉线+8px热区 */}
      {!editorFullscreen && !isMobile && showSidebar && (() => {
        const handleMouseDown = (e) => {
          e.preventDefault()
          isDraggingRef.current = true
          document.body.style.cursor = 'col-resize'
          document.body.style.userSelect = 'none'

          const handleMouseMove = (ev) => {
            if (!isDraggingRef.current) return
            window.requestAnimationFrame(() => {
              const newWidth = Math.max(200, Math.min(800, ev.clientX))
              sidebarWidthRef.current = newWidth
              setSidebarWidth(newWidth)
            })
          }

          const handleMouseUp = () => {
            if (!isDraggingRef.current) return
            isDraggingRef.current = false
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
            localStorage.setItem('sidebarWidth', String(sidebarWidthRef.current))
            window.removeEventListener('mousemove', handleMouseMove)
            window.removeEventListener('mouseup', handleMouseUp)
          }

          window.addEventListener('mousemove', handleMouseMove)
          window.addEventListener('mouseup', handleMouseUp)
        }

        return (
          <div
            className="sidebar-resizer"
            onMouseDown={handleMouseDown}
            style={{
              width: 2, cursor: 'col-resize', flexShrink: 0,
              background: 'var(--color-border)', position: 'relative', zIndex: 10,
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--color-primary)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--color-border)'}
          >
            {/* 透明热区：左右各4px，不影响2px视觉线 */}
            <div style={{
              position: 'absolute', left: -4, right: -4, top: 0, bottom: 0,
              background: 'transparent', zIndex: 11,
            }} />
          </div>
        )
      })()}

      {/* 移动端抽屉侧边栏 */}
      <Modal
        className="mobile-workspace-modal"
        title="笔记目录" open={mobileSidebarOpen}
        onCancel={() => setMobileSidebarOpen(false)}
        footer={null}
        width={300}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <Tooltip title="更改目录"><Button size="small" icon={<FolderOpenOutlined />} onClick={handleChangeWorkspace} aria-label="更改目录" title="更改目录" /></Tooltip>
            <Tooltip title={isAllExpanded ? '全部折叠' : '全部展开'}><Button aria-label={isAllExpanded ? '全部折叠' : '全部展开'} size="small" icon={<MenuOutlined />} onClick={handleToggleExpandAll} title={isAllExpanded ? '全部折叠' : '全部展开'} /></Tooltip>
            <Tooltip title="定位当前文件"><Button aria-label="定位当前文件" size="small" icon={<NodeIndexOutlined />} onClick={handleLocateCurrentFile} title="定位当前文件" disabled={!activeFile} /></Tooltip>
            <Tooltip title={sidebarView === 'outline' ? '返回文件目录' : '查看文档大纲'}><Button aria-label={sidebarView === 'outline' ? '返回文件目录' : '查看文档大纲'} size="small" icon={<ReadOutlined />} onClick={() => setSidebarView(v => v === 'outline' ? 'tree' : 'outline')} title={sidebarView === 'outline' ? '返回文件目录' : '查看文档大纲'} /></Tooltip>
            <Tooltip title="新建文件夹"><Button aria-label="新建文件夹" size="small" icon={<PlusOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'dir' })} title="新建文件夹" /></Tooltip>
            <Tooltip title="新建文件"><Button aria-label="新建文件" size="small" icon={<FileOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'file' })} title="新建文件" /></Tooltip>
          </div>
          {sidebarView === 'outline' ? (
            <div className="mobile-outline-list" aria-label="文档大纲">
              {outlineItems.length === 0 && <div className="outline-empty">当前文档还没有标题</div>}
              {outlineItems.map((item, i) => (
                <button
                  type="button"
                  className="outline-item"
                  key={`${item.pos}-${i}`}
                  style={{ paddingLeft: 10 + (item.level - 1) * 14 }}
                  onClick={() => {
                    if (!editor || item.pos == null) return
                    editor.chain().focus().setTextSelection(Math.min(item.pos + 1, editor.state.doc.content.size)).scrollIntoView().run()
                    setMobileSidebarOpen(false)
                  }}
                  title={item.text}
                >
                  <span className="outline-level">H{item.level}</span>
                  <span>{item.text || '无标题'}</span>
                </button>
              ))}
            </div>
          ) : (
            <Tree
              treeData={renderTreeNodes(tree)}
              selectedKeys={[selectedKey]}
              expandedKeys={expandedKeys}
              onExpand={handleExpand}
              expandAction="click"
              onSelect={(keys) => {
                if (keys.length > 0) setMobileSidebarOpen(false)
              }}
              onDrop={info => {
                const target = info.node
                const draggedKey = info.dragNodesKeys[0]
                const draggedNode = findNode(tree, draggedKey)
                const targetNode = findNode(tree, target.key)
                if (!draggedNode || !targetNode || targetNode.type !== 'dir') return
                handleMove(draggedNode, target.key)
              }}
            />
          )}
          <div style={{ marginTop: 4, padding: '4px 10px 6px', borderRadius: 8, background: 'var(--color-bg-muted)', border: '1px solid var(--color-border)' }}>
            <div title={workspace} aria-label={`当前目录：${workspace}`} style={{ fontSize: 11, lineHeight: '16px', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspace}</div>
          </div>
        </div>
      </Modal>

      {/* 主区域 */}
      <div className="editor-main" style={{ flex: '1 1 0%', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {/* 标签页 */}
        <DocumentTabs
          files={openFiles}
          activeFile={activeFile}
          saveErrors={saveErrors}
          isDirty={isDirty}
          isMobile={isMobile}
          showToolbar={showToolbar}
          onShowTree={() => { setSidebarView('tree'); setMobileSidebarOpen(true) }}
          onShowOutline={() => { setSidebarView('outline'); setMobileSidebarOpen(true) }}
          onToggleToolbar={() => setShowToolbar(value => !value)}
          onOpenFile={(path, name) => {
            handleFileOpen({ path, name, type: 'file' })
            setMobileSidebarOpen(false)
          }}
          onCloseFile={handleClose}
          onTabContextMenu={(target, event) => {
            event.preventDefault()
            setTabMenu({ visible: true, x: event.clientX, y: event.clientY, target })
          }}
        />

        {/* 编辑区 */}
        <div className="editor-surface" style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          background: 'var(--color-bg-card)',
          borderRadius: openFiles.length === 0 ? 0 : 0,
          border: '1px solid var(--color-border)', overflow: 'hidden', position: 'relative',
          boxShadow: 'var(--shadow-lg)',
        }}>
          {!activeFile ? (
            <div className="empty-editor" style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              height: '100%', gap: 16, padding: 24, color: 'var(--color-text-secondary)',
            }}>
              {isMobile ? (
                <>
                  <FileOutlined className="empty-editor-icon" />
                  <span className="empty-editor-title">打开一篇笔记开始编辑</span>
                  <span className="empty-editor-copy">从左侧目录选择文件，或先切换到其他工作区。</span>
                  <Button type="primary" icon={<FileAddOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'file' })}>新建笔记</Button>
                  <Button aria-label="打开目录" size="middle" icon={<AppstoreOutlined />} onClick={() => { setSidebarView('tree'); setMobileSidebarOpen(true) }}>打开目录</Button>
                  <Button size="middle" icon={<FolderOpenOutlined />} onClick={handleChangeWorkspace}>更改目录</Button>
                </>
              ) : (
                <>
                  <FileOutlined className="empty-editor-icon" />
                  <span className="empty-editor-title">打开一篇笔记开始编辑</span>
                  <span className="empty-editor-copy">从左侧目录选择文件，或先切换到其他工作区。</span>
                  <Button type="primary" size="middle" icon={<FileAddOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'file' })}>新建笔记</Button>
                  <Button aria-label="打开目录" size="middle" icon={<FolderOpenOutlined />} onClick={handleChangeWorkspace}>打开目录</Button>
                </>
              )}
            </div>
          ) : imageViewer ? (
            <>
              {/* 图片查看器 */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {/* 工具栏 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
                  <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', flex: 1 }}>{imageViewer.name}</span>
                  <Tooltip title="放大"><Button aria-label="放大" size="small" icon={<ZoomInOutlined />} onClick={() => setImageZoom(z => Math.min(z + 25, 400))} /></Tooltip>
                  <span style={{ fontSize: 12, minWidth: 44, textAlign: 'center' }}>{imageZoom}%</span>
                  <Button size="small" onClick={() => setImageZoom(100)}>重置</Button>
                  <Tooltip title="缩小"><Button aria-label="缩小" size="small" icon={<ZoomOutOutlined />} onClick={() => setImageZoom(z => Math.max(z - 25, 25))} /></Tooltip>
                  <Button aria-label="关闭图片" size="small" danger icon={<CloseOutlined />} onClick={() => handleClose(imageViewer.path)} />
                </div>
                {/* 图片显示区：点击切换 100% ↔ 200% */}
                <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, cursor: 'zoom-in' }}
                  onClick={() => setImageZoom(z => z >= 200 ? 100 : 200)}>
                  <img src={imageViewer.url} alt={imageViewer.name}
                    style={{ maxWidth: '100%', maxHeight: '100%', transform: `scale(${imageZoom / 100})`, transformOrigin: 'center center', transition: 'transform 0.2s', borderRadius: 8, boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }} />
                </div>
              </div>
            </>
          ) : (
            <>
              {showToolbar && !isMobile && (
                <div className="editor-toolbar" role="toolbar" aria-label="编辑工具栏">
                  <div className="toolbar-group toolbar-format-group">
                    <Tooltip title="加粗 (⌘/Ctrl+B)"><Button aria-label="加粗" {...tbBtn(editor?.isActive('bold') || false)} onClick={() => editor?.chain().focus().toggleBold().run()} icon={<BoldOutlined />} /></Tooltip>
                    <Tooltip title="斜体 (⌘/Ctrl+I)"><Button aria-label="斜体" {...tbBtn(editor?.isActive('italic') || false)} onClick={() => editor?.chain().focus().toggleItalic().run()} icon={<ItalicOutlined />} /></Tooltip>
                    <Tooltip title="删除线"><Button aria-label="删除线" {...tbBtn(editor?.isActive('strike') || false)} onClick={() => editor?.chain().focus().toggleStrike().run()} icon={<StrikethroughOutlined />} /></Tooltip>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: headingItems,
                        selectable: false,
                        onClick: ({ key }) => {
                          const chain = editor?.chain().focus()
                          if (!chain) return
                          if (key === 'paragraph') chain.setParagraph().run()
                          else chain.toggleHeading({ level: Number(key.split('-')[1]) }).run()
                        },
                      }}
                    >
                      <Button className="heading-picker" aria-label={`当前段落样式：${activeHeadingLabel}`} {...tbBtn(Boolean(activeHeading), 'var(--color-text)')}>
                        <span>{activeHeadingLabel}</span><DownOutlined />
                      </Button>
                    </Dropdown>
                  </div>
                  <span className="toolbar-divider" aria-hidden="true" />
                  <div className="toolbar-group">
                    <Tooltip title="无序列表"><Button aria-label="无序列表" {...tbBtn(editor?.isActive('bulletList') || false)} onClick={() => editor?.chain().focus().toggleBulletList().run()} icon={<UnorderedListOutlined />} /></Tooltip>
                    <Tooltip title="有序列表"><Button aria-label="有序列表" {...tbBtn(editor?.isActive('orderedList') || false)} onClick={() => editor?.chain().focus().toggleOrderedList().run()} icon={<OrderedListOutlined />} /></Tooltip>
                    <Tooltip title="任务列表"><Button aria-label="任务列表" {...tbBtn(editor?.isActive('taskList') || false)} onClick={() => editor?.chain().focus().toggleTaskList().run()} icon={<CheckSquareOutlined />} /></Tooltip>
                  </div>
                  <span className="toolbar-divider" aria-hidden="true" />
                  <div className="toolbar-group">
                    <Tooltip title="引用"><Button aria-label="引用" {...tbBtn(editor?.isActive('blockquote') || false)} onClick={() => editor?.chain().focus().toggleBlockquote().run()} icon={<HolderOutlined />} /></Tooltip>
                    <Tooltip title="代码块"><Button aria-label="代码块" {...tbBtn(editor?.isActive('codeBlock') || false)} onClick={() => editor?.chain().focus().toggleCodeBlock().run()} icon={<ApiOutlined />} /></Tooltip>
                    <Tooltip title="插入链接"><Button aria-label="插入链接" {...tbBtn(editor?.isActive('link') || false)} onClick={handleInsertLink} icon={<LinkOutlined />} /></Tooltip>
                    <Tooltip title="插入表格"><Button aria-label="插入表格" {...tbBtn(false)} onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} icon={<TableOutlined />} /></Tooltip>
                    <input type="file" accept="image/*" style={{ display: 'none' }} id="img-up" onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); e.target.value = '' }} />
                    <Tooltip title="上传图片"><label><Button aria-label="上传图片" {...tbBtn(false)} icon={<UploadOutlined />} loading={uploading} /></label></Tooltip>
                  </div>
                  <span className="toolbar-spacer" />
                  <div className="toolbar-group toolbar-view-group">
                    <Tooltip title={showSource ? '编辑' : '源码'}>
                      <Button aria-label={showSource ? '编辑' : '源码'} disabled={fileLoading} {...tbBtn(showSource, 'var(--color-text-secondary)')} onClick={handleToggleSource} icon={showSource ? <EditOutlined /> : <CodeOutlined />}>
                        <span className="mode-button-label">{showSource ? '编辑' : '源码'}</span>
                      </Button>
                    </Tooltip>
                    {!isMobile && <Tooltip title={showOutline ? '隐藏右侧大纲' : '显示右侧大纲'}>
                      <Button aria-label={showOutline ? '隐藏右侧大纲' : '显示右侧大纲'} {...tbBtn(showOutline, 'var(--color-text-secondary)')} onClick={() => setShowOutline(v => !v)} icon={<ReadOutlined />} />
                    </Tooltip>}
                    <Tooltip title={editorFullscreen ? '退出专注模式' : '专注模式'}><Button aria-label={editorFullscreen ? '退出专注模式' : '进入专注模式'} {...tbBtn(editorFullscreen, 'var(--color-text-secondary)')} onClick={() => setEditorFullscreen(v => !v)} icon={editorFullscreen ? <ShrinkOutlined /> : <ExpandOutlined />} /></Tooltip>
                    <Tooltip title="隐藏工具栏"><Button aria-label="隐藏工具栏" {...tbBtn(false, 'var(--color-text-secondary)')} onClick={() => setShowToolbar(false)} icon={<AlignLeftOutlined />} /></Tooltip>
                  </div>
                </div>
              )}

              {showToolbar && isMobile && (
                <div className="mobile-toolbar" role="toolbar" aria-label="移动端编辑工具栏">
                  <Tooltip title="加粗"><Button aria-label="加粗" {...tbBtn(editor?.isActive('bold') || false)} onClick={() => editor?.chain().focus().toggleBold().run()} icon={<BoldOutlined />} /></Tooltip>
                  <Tooltip title="斜体"><Button aria-label="斜体" {...tbBtn(editor?.isActive('italic') || false)} onClick={() => editor?.chain().focus().toggleItalic().run()} icon={<ItalicOutlined />} /></Tooltip>
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: headingItems,
                      selectable: false,
                      onClick: ({ key }) => {
                        const chain = editor?.chain().focus()
                        if (!chain) return
                        if (key === 'paragraph') chain.setParagraph().run()
                        else chain.toggleHeading({ level: Number(key.split('-')[1]) }).run()
                      },
                    }}
                  >
                    <Button className="heading-picker" aria-label={`当前段落样式：${activeHeadingLabel}`} {...tbBtn(Boolean(activeHeading), 'var(--color-text)')}>
                      <span>{activeHeadingLabel}</span><DownOutlined />
                    </Button>
                  </Dropdown>
                  <Dropdown
                    trigger={['click']}
                    menu={{ items: mobileToolbarItems, selectable: false, onClick: applyMobileToolbarAction }}
                  >
                    <Button className="mobile-more-formats" aria-label="更多格式" {...tbBtn(false, 'var(--color-text-secondary)')} icon={<MoreOutlined />}>更多格式</Button>
                  </Dropdown>
                  <input type="file" accept="image/*" style={{ display: 'none' }} id="img-up" onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); e.target.value = '' }} />
                  <span className="toolbar-spacer" />
                  <Tooltip title={showSource ? '编辑' : '源码'}>
                    <Button aria-label={showSource ? '编辑' : '源码'} disabled={fileLoading} {...tbBtn(showSource, 'var(--color-text-secondary)')} onClick={handleToggleSource} icon={showSource ? <EditOutlined /> : <CodeOutlined />}>
                      <span className="mode-button-label">{showSource ? '编辑' : '源码'}</span>
                    </Button>
                  </Tooltip>
                  <Tooltip title="隐藏工具栏"><Button aria-label="隐藏工具栏" {...tbBtn(false, 'var(--color-text-secondary)')} onClick={() => setShowToolbar(false)} icon={<AlignLeftOutlined />} /></Tooltip>
                </div>
              )}

              {!showToolbar && !isMobile && (
                <Button
                  size="small"
                  icon={<AlignLeftOutlined />}
                  onClick={() => setShowToolbar(true)}
                  title="显示工具栏"
                  style={{ position: 'absolute', top: 8, right: 12, zIndex: 2, borderRadius: 6 }}
                />
              )}

              {/* 编辑区 */}
              {fileLoading && (
                <div style={{
                  position: 'absolute', inset: '48px 0 0', zIndex: 3,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'color-mix(in srgb, var(--color-bg-card) 86%, transparent)',
                  color: 'var(--color-text-secondary)', fontSize: 13,
                }}>
                  正在加载…
                </div>
              )}
              {showSource ? (
                <textarea
                  value={sourceContent}
                  onChange={e => {
                    const value = e.target.value
                    sourceContentRef.current = value
                    setSourceContent(value)
                    const path = activeFileRef.current
                    if (path) {
                      setDraft(path, value, true)
                      setSaveStatus('modified')
                      scheduleSave(path, value)
                    }
                  }}
                  className="source-editor"
                  aria-label="Markdown 源文本"
                  style={{ flex: 1, width: '100%', border: 'none', outline: 'none', background: 'var(--color-bg-card)', color: 'var(--color-text)', fontFamily: 'monospace', fontSize: 14, lineHeight: 1.8, padding: '20px 32px', resize: 'none' }}
                />
              ) : (
                <div className="editor-scroll" style={{ flex: 1, overflow: 'auto', padding: '20px 32px', background: 'var(--color-bg-card)' }}>
                  <style>{`
                    .ProseMirror { outline: none; min-height: 100%; font-size: 17px; line-height: 1.8; color: var(--color-text); }
                    .ProseMirror h1 { font-size: 1.8em; font-weight: 700; border-bottom: 1px solid var(--color-border); padding-bottom: 8px; margin: 1em 0 0.5em; }
                    .ProseMirror h2 { font-size: 1.4em; font-weight: 600; margin: 1em 0 0.5em; }
                    .ProseMirror h3 { font-size: 1.2em; font-weight: 600; margin: 0.8em 0 0.4em; }
                    .ProseMirror p { margin: 0.4em 0; }
                    .ProseMirror code { background: var(--color-code-inline); padding: 2px 6px; border-radius: 4px; font-size: 0.88em; font-family: 'JetBrains Mono', monospace; }
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
                    .ProseMirror blockquote { border-inline-start: 2px solid var(--color-border); padding-inline-start: 12px; margin: 0.5em 0; color: var(--color-text-secondary); }
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
                      border: 1px solid var(--color-border);
                      box-shadow: var(--shadow);
                    }
                    .ProseMirror table th {
                      background: var(--color-table-header);
                      font-weight: 600;
                      text-align: left;
                      padding: 10px 14px;
                      border: 1px solid var(--color-border);
                      color: var(--color-text);
                    }
                    .ProseMirror table td {
                      padding: 8px 14px;
                      border: 1px solid var(--color-border);
                      vertical-align: top;
                    }
                    .ProseMirror table tr:nth-child(even) td {
                      background: var(--color-table-row-alt);
                    }
                    .ProseMirror table tr:hover td {
                      background: var(--color-table-hover) !important;
                    }
                    .ProseMirror table td.selectedCell {
                      background: var(--color-table-selected) !important;
                    }
                    .ProseMirror .column-resize-handle {
                      background-color: var(--color-primary);
                      width: 3px;
                    }
                  `}</style>
                  <div className="prose-column">
                    <EditorContent editor={editor} style={{ height: '100%' }} />
                  </div>
                </div>
              )}
            </>
          )}
          <div className="editor-statusbar" aria-label="文档状态栏">
            <div className="editor-file-location" title={activeFile || '尚未选择文件'}>
              <FileOutlined aria-hidden="true" />
              <span>{activeFile ? activeFile.split('/').pop() : '选择文件开始编辑'}</span>
            </div>
            <div className="editor-status-actions">
              {activeFile && <SaveStatus status={activeSaveStatus} onRetry={handleRetrySave} />}
              {activeFile && !imageViewer && (
                <Button aria-label="保存当前文件" size="small" type="primary" icon={<SaveOutlined />} onClick={handleSave} className="save-button">保存</Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {!isMobile && !editorFullscreen && showOutline && activeFile && (
        <aside className="outline-panel" aria-label="文档大纲">
          <div className="outline-panel-header">
            <div>
              <span className="outline-panel-title">文档大纲</span>
              <span className="outline-panel-file">{activeFile.split('/').pop()}</span>
            </div>
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              aria-label="隐藏右侧大纲"
              onClick={() => setShowOutline(false)}
            />
          </div>
          <div className="outline-panel-body">
            {outlineItems.length === 0 && (
              <div className="outline-empty">当前文档还没有标题</div>
            )}
            {outlineItems.map((item, i) => (
              <button
                type="button"
                className="outline-item"
                key={`${item.pos}-${i}`}
                style={{ paddingLeft: 12 + (item.level - 1) * 14 }}
                onClick={() => {
                  if (!editor || item.pos == null) return
                  editor.chain().focus().setTextSelection(Math.min(item.pos + 1, editor.state.doc.content.size)).scrollIntoView().run()
                }}
                title={item.text}
              >
                <span className="outline-level">H{item.level}</span>
                <span>{item.text || '无标题'}</span>
              </button>
            ))}
          </div>
        </aside>
      )}

      {/* 新建 */}
      <Modal title={createModal.type === 'dir' ? '新建文件夹' : '新建文件'} open={createModal.open}
        onOk={handleCreate}
        onCancel={() => { setCreateModal({ open: false, parent: '', type: 'file' }); setCreateName('') }}
        okText="创建" cancelText="取消">
        <Input placeholder="名称" value={createName} onChange={e => setCreateName(e.target.value)} onPressEnter={handleCreate} autoFocus />
      </Modal>

      {/* 导入 */}
      <Modal title="导入文件（支持 .zip）" open={importModal}
        onCancel={() => setImportModal(false)} footer={null} okText="导入" cancelText="取消">
        <div style={{ padding: '16px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="file"
            accept=".zip"
            id="import-zip-input"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = '' }}
          />
          <label htmlFor="import-zip-input" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', border: '1px dashed var(--color-border)', borderRadius: 8, color: 'var(--color-text-secondary)', fontSize: 13 }}>
            <UploadOutlined />点击选择 .zip 文件
          </label>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            仅允许导入 <b>.md</b> 和 <b>图片</b>（.jpg/.png/.gif/.webp/.bmp/.svg）文件。
          </div>
        </div>
      </Modal>

      {/* 移动 */}
      <Modal title={`移动「${moveModal.node?.name}」到...`} open={moveModal.open}
        onOk={async () => { if (!moveModal.node) return; await handleMove(moveModal.node, moveTarget); setMoveModal({ open: false, node: null }) }}
        onCancel={() => setMoveModal({ open: false, node: null })}
        okText="移动" cancelText="取消">
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: 8, maxHeight: 260, overflow: 'auto' }}>
          <div onClick={() => setMoveTarget('')} style={{ padding: '4px 8px', borderRadius: 4, cursor: 'pointer', background: moveTarget === '' ? 'var(--color-surface-selected)' : 'transparent', color: 'var(--color-text-secondary)', marginBottom: 4, fontSize: 13 }}>
            <FolderOpenOutlined style={{ color: 'var(--color-warning)', marginRight: 4 }} />根目录
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
                <FolderOpenOutlined style={{ color: 'var(--color-warning)' }} />在此创建文件夹
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={() => { setContextMenu(p => ({ ...p, visible: false })); setCreateModal({ open: true, parent: contextMenu.node.path, type: 'file' }) }}>
                <FileOutlined style={{ color: 'var(--color-file)' }} />在此创建文件
              </div>
            </>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={() => handleRenameStart(contextMenu.node)}>
            <EditOutlined />重命名
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={() => { setMoveModal({ open: true, node: contextMenu.node }); setMoveTarget(''); setContextMenu(p => ({ ...p, visible: false })) }}>
            <SwapOutlined />移动到...
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--color-danger)' }} onClick={() => { setContextMenu(p => ({ ...p, visible: false })); Modal.confirm({ title: `确定删除「${contextMenu.node.name}」？`, content: contextMenu.node.type === 'dir' ? '将递归删除所有内容' : '删除后不可恢复', okText: '删除', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => handleDelete(contextMenu.node) }) }}>
            <DeleteOutlined />删除
          </div>
        </div>
      )}
      {tabMenu.visible && (
        <div style={{ position: 'fixed', left: tabMenu.x, top: tabMenu.y, zIndex: 9999, background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', padding: '4px 0', minWidth: 160 }} onContextMenu={(e) => { e.preventDefault() }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={() => { handleClose(tabMenu.target); setTabMenu(p => ({ ...p, visible: false })) }}>
            <CloseOutlined />关闭当前
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={async () => { const target = tabMenu.target; await closeTabGroup(openFiles.filter(file => file !== target)); await handleFileOpen({ path: target, name: target.split('/').pop(), type: 'file' }); setTabMenu(p => ({ ...p, visible: false })) }}>
            <FileOutlined />关闭其他
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={async () => { const target = tabMenu.target; const idx = openFiles.indexOf(target); await closeTabGroup(openFiles.slice(0, idx)); await handleFileOpen({ path: target, name: target.split('/').pop(), type: 'file' }); setTabMenu(p => ({ ...p, visible: false })) }}>
            <SwapOutlined />关闭左侧
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13 }} onClick={async () => { const target = tabMenu.target; const idx = openFiles.indexOf(target); await closeTabGroup(openFiles.slice(idx + 1)); await handleFileOpen({ path: target, name: target.split('/').pop(), type: 'file' }); setTabMenu(p => ({ ...p, visible: false })) }}>
            <EditOutlined />关闭右侧
          </div>
        </div>
      )}
      {tabMenu.visible && <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onClick={() => setTabMenu(p => ({ ...p, visible: false }))} />}
    </div>
  )
}
