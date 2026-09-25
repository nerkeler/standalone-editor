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
  ZoomInOutlined, ZoomOutOutlined, WarningOutlined, HistoryOutlined
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
import useEditorDrafts, { isImageFile, isMarkdownFile } from './useEditorDrafts'
import DocumentTabs from './DocumentTabs'
import OrphanHistoryManager from './OrphanHistoryManager'
import './Editor.css'

const lowlight = createLowlight(common)

const API = '/api/workspace'

function SaveStatus({ status, onRetry }) {
  const states = {
    modified: { icon: <EditOutlined />, label: '修改待保存', className: 'is-modified' },
    saving: { icon: <LoadingOutlined spin />, label: '保存中', className: 'is-saving' },
    saved: { icon: <CheckOutlined />, label: '已保存', className: 'is-saved' },
    error: { icon: <CloseCircleOutlined />, label: '保存失败', className: 'is-error' },
    conflict: { icon: <WarningOutlined />, label: '内容冲突待处理', className: 'is-error' },
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

function requiresSourceMode(markdown) {
  const content = String(markdown || '')
  return Boolean(
    /^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---(?:\s|$)/.test(content) ||
    /!?\[\[[^\]\n]+\]\]/.test(content) ||
    /^(?: {2,}|\t+)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/m.test(content) ||
    /<\/?[A-Za-z][\w:-]*(?:\s[^<>]*?)?\s*\/?>/.test(content) ||
    /^(?:```|~~~)\s*[\w+-]+(?:\s+[^`\r\n]+)+$/m.test(content)
  )
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

function formatRecoveryBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '不可用'
  if (bytes < 1024) return `${bytes.toLocaleString()} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = bytes
  let unitIndex = -1
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024
    unitIndex += 1
  }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unitIndex]}`
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
  const [attachmentViewer, setAttachmentViewer] = useState(null) // { path, name }
  const [imageZoom, setImageZoom] = useState(100)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [importModal, setImportModal] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [conflictReview, setConflictReview] = useState(null)
  const [historyModal, setHistoryModal] = useState({ open: false, path: '', entries: [], loading: false })
  const [trashModalOpen, setTrashModalOpen] = useState(false)
  const [trashItems, setTrashItems] = useState([])
  const [trashItemsWorkspaceKey, setTrashItemsWorkspaceKey] = useState('')
  const [trashLoadingState, setTrashLoadingState] = useState({ workspaceKey: '', loading: false })
  const [trashMutationBusy, setTrashMutationBusy] = useState(false)
  const [recoveryStatsState, setRecoveryStatsState] = useState({ workspaceKey: '', stats: null, loading: false })
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false)
  const recoveryWorkspaceKey = `${workspaceInfo?.workspaceId || ''}:${workspaceInfo?.workspaceVersion ?? ''}:${workspaceInfo?.workspace || workspace || ''}`
  const recoveryWorkspaceKeyRef = useRef(recoveryWorkspaceKey)
  const recoveryStatsRequestRef = useRef(0)
  const trashRequestRef = useRef(0)
  recoveryWorkspaceKeyRef.current = recoveryWorkspaceKey
  const recoveryStats = recoveryStatsState.workspaceKey === recoveryWorkspaceKey ? recoveryStatsState.stats : null
  const recoveryStatsLoading = recoveryStatsState.workspaceKey === recoveryWorkspaceKey && recoveryStatsState.loading
  const visibleTrashItems = trashItemsWorkspaceKey === recoveryWorkspaceKey ? trashItems : []
  const trashLoading = trashLoadingState.workspaceKey === recoveryWorkspaceKey && trashLoadingState.loading

  useEffect(() => {
    recoveryStatsRequestRef.current += 1
    setRecoveryStatsState({ workspaceKey: recoveryWorkspaceKey, stats: null, loading: false })
    trashRequestRef.current += 1
    setTrashItems([])
    setTrashItemsWorkspaceKey(recoveryWorkspaceKey)
    setTrashLoadingState({ workspaceKey: recoveryWorkspaceKey, loading: false })
    setTrashMutationBusy(false)
    setTrashModalOpen(false)
  }, [recoveryWorkspaceKey])

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
    fileRevisions, setFileRevisions, fileRevisionsRef,
    fileConflicts, setFileConflicts, conflictsRef, restoredDraftsRef,
    recoveryAlternatives, applyRecoveryAlternative,
    draftStorageError, setFileRevision, setFileConflict, clearFileConflict,
    writePendingDrafts, clearPendingDraft, collectDirtyDrafts,
    remapPendingDrafts, removePendingDrafts, waitForDraftRestore,
    setDraft, clearSaveTimer, doSave, scheduleSave, waitForPathSaves,
  } = useEditorDrafts(workspace, activeFileRef, workspaceInfo?.workspaceId)
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
      activeFile && !fileLoading && isMarkdownFile(activeFile) &&
      renderedFileRef.current === activeFile
    )
    editor.setEditable(editable, false)
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
        if (currentPath && isMarkdownFile(currentPath)) handleSave()
        return
      }
      if (!isMarkdownFile(currentPath) || showSourceRef.current) return
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
    try {
      // setContent(..., false) does not emit an update. Keep the guard only
      // around the synchronous replacement so an immediate user keystroke
      // cannot be mistaken for a programmatic update and silently ignored.
      editor.commands.setContent(markdownToHtml(content, workspaceInfoRef.current), false)
    } finally {
      suppressEditorUpdateRef.current = false
    }
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
    if (!isMarkdownFile(path) || loadingRef.current || renderedFileRef.current !== path) return undefined
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
      if (!isMarkdownFile(path) || showSourceRef.current || loadingRef.current || renderedFileRef.current !== path) return
      const content = serializeCurrentEditor()
      setDraft(path, content, true)
      setSaveStatus(conflictsRef.current[path] ? 'conflict' : 'modified')
      scheduleSave(path, content)
    }
    editor.on('update', handler)
    return () => editor.off('update', handler)
  }, [editor, scheduleSave, serializeCurrentEditor])

  const loadFile = useCallback(async (path, requestId) => {
    try {
      const res = await axios.get(`${API}/file`, { params: { path } })
      const fetched = res.data.content ?? ''
      const diskRevision = res.data.revision
      const hasDirtyDraft = Boolean(dirtyRef.current[path] && draftContentsRef.current[path] !== undefined)
      const restoredSnapshot = restoredDraftsRef.current[path]
      const draftBaseline = restoredSnapshot
        ? restoredSnapshot.baseRevision
        : (fileRevisionsRef.current[path] ?? null)
      cleanContentsRef.current[path] = fetched
      if (!hasDirtyDraft) {
        if (diskRevision) setFileRevision(path, diskRevision)
        setDraft(path, fetched, false)
        clearFileConflict(path)
      } else {
        // Never advance a dirty draft's baseline just because a reload saw a
        // newer disk revision. This applies to both crash-recovered and
        // in-memory drafts; a mismatch must be compared before it can save.
        if (!draftBaseline || !diskRevision || draftBaseline !== diskRevision) {
          setFileConflict(path, {
            type: draftBaseline ? 'draft-stale' : 'draft-unverified',
            baseRevision: draftBaseline,
            diskRevision: diskRevision || null,
            diskContent: fetched,
          })
        } else {
          setFileRevision(path, diskRevision)
        }
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
      const keepSource = requiresSourceMode(visible)
      showSourceRef.current = keepSource
      setShowSource(keepSource)
      if (!keepSource) setEditorMarkdown(withoutZoom)
      setSourceContent(visible)
      setSaveStatus(conflictsRef.current[path] ? 'conflict' : (saveErrorsRef.current[path] ? 'error' : (dirtyRef.current[path] ? 'modified' : 'saved')))
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
  }, [applyZoom, clearFileConflict, setEditorMarkdown, setDraft, setFileConflict, setFileRevision])

  const handleFileOpen = useCallback(async node => {
    // The tab identity probe and own-tab crash recovery must finish before a
    // file load decides whether the disk bytes or a recovered draft to show.
    await waitForDraftRestore()
    const path = node.path
    if (
      activeFileRef.current === path &&
      renderedFileRef.current === path &&
      !loadingRef.current
    ) {
      setFileLoading(false)
      editor?.setEditable(isMarkdownFile(node.name || path), false)
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
    setImageViewer(null)
    setAttachmentViewer(null)
    loadingRef.current = true
    setFileLoading(true)
    editor?.setEditable(false, false)

    if (isImageFile(node.name || path)) {
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
    if (!isMarkdownFile(node.name || path)) {
      // Attachments remain manageable in the tree and tab strip, but never
      // enter the text read, autosave, or local draft recovery paths.
      renderedFileRef.current = path
      loadingRef.current = false
      setFileLoading(false)
      setEditorMarkdown('')
      sourceContentRef.current = ''
      setSourceContent('')
      setAttachmentViewer({ path, name: node.name || path.split('/').pop() })
      setSaveStatus('idle')
      return
    }
    if (draftContentsRef.current[path] !== undefined && !restoredDraftsRef.current[path]) {
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
      const keepSource = requiresSourceMode(visible)
      showSourceRef.current = keepSource
      setShowSource(keepSource)
      if (!keepSource) setEditorMarkdown(withoutZoom)
      setSourceContent(visible)
      setSaveStatus(conflictsRef.current[path] ? 'conflict' : (saveErrorsRef.current[path] ? 'error' : (dirtyRef.current[path] ? 'modified' : 'saved')))
      setTimeout(applyZoom, 0)
    } else {
      await loadFile(path, requestId)
    }
  }, [applyZoom, captureCurrentDraft, editor, loadFile, setEditorMarkdown, waitForDraftRestore])

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
    delete fileRevisionsRef.current[path]
    delete conflictsRef.current[path]
    delete restoredDraftsRef.current[path]
    setFileRevisions(prev => { const next = { ...prev }; delete next[path]; return next })
    setFileConflicts(prev => { const next = { ...prev }; delete next[path]; return next })
    setIsDirty(prev => { const next = { ...prev }; delete next[path]; return next })
    setSavedContents(prev => { const next = { ...prev }; delete next[path]; return next })
  }, [clearSaveTimer])

  const pathsUnder = useCallback(path => (
    openFilesRef.current.filter(file => file === path || file.startsWith(`${path}/`))
  ), [])

  const migrateVersionState = useCallback((oldPath, newPath) => {
    const migrate = source => Object.fromEntries(
      Object.entries(source).map(([key, value]) => [remapPath(key, oldPath, newPath), value])
    )
    fileRevisionsRef.current = migrate(fileRevisionsRef.current)
    conflictsRef.current = migrate(conflictsRef.current)
    restoredDraftsRef.current = migrate(restoredDraftsRef.current)
    setFileRevisions(fileRevisionsRef.current)
    setFileConflicts(conflictsRef.current)
  }, [setFileConflicts, setFileRevisions])

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
      setAttachmentViewer(null)
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
    if (!isMarkdownFile(path)) return
    const content = showSourceRef.current ? sourceContentRef.current : captureCurrentDraft()
    if (content === undefined) return
    if (conflictsRef.current[path]) {
      setSaveStatus('conflict')
      message.warning('文件已在磁盘上变化，请先查看冲突内容')
      return
    }
    setSaveStatus('saving')
    try {
      await doSave(path, content)
      message.success('保存成功')
    } catch (error) {
      message.error(error?.response?.data?.code === 'FILE_CONFLICT'
        ? '文件已在磁盘上变化；本地草稿已保留，没有覆盖磁盘内容'
        : '保存失败，已保留未保存状态')
    }
  }, [captureCurrentDraft, doSave])

  const handleRetrySave = useCallback(() => {
    const path = activeFileRef.current
    if (!isMarkdownFile(path) || conflictsRef.current[path]) return
    const content = showSourceRef.current ? sourceContentRef.current : captureCurrentDraft()
    if (content === undefined) return
    setSaveStatus('saving')
    doSave(path, content).catch(() => {})
  }, [captureCurrentDraft, doSave])

  const handleShowConflictReview = useCallback(async (requestedPath = activeFileRef.current, suppliedConflict) => {
    const path = requestedPath
    const conflict = suppliedConflict || conflictsRef.current[path] || fileConflicts[path]
    if (!path || !conflict) return
    try {
      const res = await axios.get(`${API}/file`, { params: { path } })
      setFileConflict(path, {
        ...conflict,
        diskRevision: res.data.revision ?? null,
        diskContent: res.data.content ?? '',
      })
      setConflictReview({
        path,
        localContent: draftContentsRef.current[path] ?? '',
        diskContent: res.data.content ?? '',
        diskRevision: res.data.revision ?? null,
      })
    } catch (error) {
      setConflictReview({
        path,
        localContent: draftContentsRef.current[path] ?? '',
        diskContent: null,
        diskRevision: conflict.diskRevision ?? null,
      })
      message.warning('无法读取当前磁盘版本；本地草稿仍已保留，可先下载备份')
    }
  }, [fileConflicts, setFileConflict])

  const handleUseRecoveryAlternative = useCallback(async (path, entry) => {
    try {
      clearSaveTimer(path)
      const pendingSave = saveQueuesRef.current.get(path)
      if (pendingSave) await pendingSave.catch(() => {})
      if (activeFileRef.current !== path) {
        await handleFileOpen({ path, name: path.split('/').pop(), type: 'file' })
      }
      applyRecoveryAlternative(path, entry)
      const content = entry.snapshot.content
      const withoutZoom = content.replace(/!\[(.*?)\]\((.*?)\)<!-- zoom:(\d+) -->/g, '![$1]($2)')
      const keepSource = requiresSourceMode(content)
      sourceContentRef.current = content
      setSourceContent(content)
      showSourceRef.current = keepSource
      setShowSource(keepSource)
      if (!keepSource) setEditorMarkdown(withoutZoom)
      setSaveStatus('conflict')
      setRecoveryModalOpen(false)
      await handleShowConflictReview(path, conflictsRef.current[path])
    } catch (error) {
      message.error('载入恢复草稿失败：' + (error.response?.data?.error || error.message))
    }
  }, [applyRecoveryAlternative, clearSaveTimer, handleFileOpen, handleShowConflictReview, setEditorMarkdown])

  const handleSaveLocalConflict = useCallback(async () => {
    if (!conflictReview?.path || conflictReview.diskRevision == null || conflictReview.diskContent == null) return
    const { path } = conflictReview
    try {
      const latest = await axios.get(`${API}/file`, { params: { path } })
      const latestContent = latest.data.content ?? ''
      const latestRevision = latest.data.revision ?? null
      const localContent = draftContentsRef.current[path] ?? ''
      if (localContent !== conflictReview.localContent || latestRevision !== conflictReview.diskRevision) {
        const currentConflict = conflictsRef.current[path] || {}
        setFileConflict(path, {
          ...currentConflict,
          type: latestRevision === conflictReview.diskRevision ? currentConflict.type : 'disk-changed-during-review',
          diskRevision: latestRevision,
          diskContent: latestContent,
        })
        setConflictReview({ path, localContent, diskContent: latestContent, diskRevision: latestRevision })
        message.warning(localContent !== conflictReview.localContent
          ? '本地草稿在比较后又有修改，请核对更新后的内容'
          : '磁盘文件在比较后又有变化，请核对最新版本')
        return
      }
      if (!latestRevision) {
        message.error('缺少当前文件版本，无法安全保存本地草稿')
        return
      }

      // The fresh revision above must still match the reviewed version. The
      // server performs the final compare-and-swap so a later race is safe.
      const response = await axios.put(API, { path, content: localContent, expectedRevision: latestRevision })
      const nextRevision = response.data?.revision || response.headers?.['x-file-revision']
      cleanContentsRef.current[path] = localContent
      if (nextRevision) setFileRevision(path, nextRevision)
      const currentDraft = draftContentsRef.current[path] ?? localContent
      const changedWhileSaving = currentDraft !== localContent
      if (changedWhileSaving) {
        const restored = restoredDraftsRef.current[path]
        if (restored && nextRevision) restoredDraftsRef.current[path] = { ...restored, baseRevision: nextRevision }
        setDraft(path, currentDraft, true)
      } else {
        delete restoredDraftsRef.current[path]
        setDraft(path, localContent, false)
      }
      clearPendingDraft(path, localContent)
      clearFileConflict(path)
      const nextErrors = { ...saveErrorsRef.current }
      delete nextErrors[path]
      saveErrorsRef.current = nextErrors
      setSaveErrors(nextErrors)
      if (activeFileRef.current === path) {
        if (changedWhileSaving) {
          setSaveStatus('modified')
          scheduleSave(path, currentDraft)
        } else {
          sourceContentRef.current = localContent
          setSourceContent(localContent)
          setSaveStatus('saved')
        }
      }
      setConflictReview(null)
      message.success(changedWhileSaving
        ? '已保存比较时的草稿；之后的新修改仍待保存，原磁盘版本已保留在历史记录中'
        : '本地草稿已保存；原磁盘版本已保留在历史记录中')
    } catch (error) {
      if (error.response?.status === 409 && error.response?.data?.code === 'FILE_CONFLICT') {
        try {
          const latest = await axios.get(`${API}/file`, { params: { path } })
          const currentConflict = conflictsRef.current[path] || {}
          const refreshed = {
            path,
            localContent: draftContentsRef.current[path] ?? '',
            diskContent: latest.data.content ?? '',
            diskRevision: latest.data.revision ?? null,
          }
          setFileConflict(path, { ...currentConflict, type: 'disk-changed-during-save', diskRevision: refreshed.diskRevision, diskContent: refreshed.diskContent })
          setConflictReview(refreshed)
          message.warning('保存前磁盘版本再次变化；本地草稿仍保留，请重新比较')
        } catch {
          message.error('条件保存失败，且无法重新读取磁盘版本；本地草稿仍已保留')
        }
        return
      }
      message.error('保存本地草稿失败：' + (error.response?.data?.error || error.message))
    }
  }, [clearFileConflict, clearPendingDraft, conflictReview, scheduleSave, setDraft, setFileConflict, setFileRevision])

  const handleExportConflictDraft = useCallback(() => {
    const path = conflictReview?.path || activeFileRef.current
    const content = draftContentsRef.current[path]
    if (!path || content === undefined) return
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${path.split('/').pop()}.local-draft.md`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }, [conflictReview])

  const handleReloadDiskAfterConflict = useCallback(() => {
    const path = conflictReview?.path
    if (!path) return
    Modal.confirm({
      title: '放弃本地草稿并载入磁盘版本？',
      content: '这会丢弃编辑器中的本地草稿。建议先下载草稿备份，再继续。',
      okText: '丢弃草稿并载入',
      cancelText: '保留本地草稿',
      okButtonProps: { danger: true },
      onOk: async () => {
        // Fetch again at confirmation time so a second external change cannot
        // leave the editor showing an older version than the current disk.
        const draftAtRequest = draftContentsRef.current[path]
        const res = await axios.get(`${API}/file`, { params: { path } })
        const content = res.data.content ?? ''
        const latestDraft = draftContentsRef.current[path]
        if (latestDraft !== draftAtRequest) {
          if (res.data.revision) setFileRevision(path, res.data.revision)
          setFileConflict(path, {
            ...(conflictsRef.current[path] || {}),
            type: 'draft-changed-during-discard',
            diskRevision: res.data.revision ?? null,
            diskContent: content,
          })
          setConflictReview({
            path,
            localContent: latestDraft ?? '',
            diskContent: content,
            diskRevision: res.data.revision ?? null,
          })
          message.warning('确认期间本地草稿又有修改；草稿已保留，请重新比较后再决定')
          return
        }
        cleanContentsRef.current[path] = content
        if (res.data.revision) setFileRevision(path, res.data.revision)
        setDraft(path, content, false)
        clearPendingDraft(path)
        clearFileConflict(path)
        const nextErrors = { ...saveErrorsRef.current }
        delete nextErrors[path]
        saveErrorsRef.current = nextErrors
        setSaveErrors(nextErrors)
        if (activeFileRef.current === path) {
          sourceContentRef.current = content
          setSourceContent(content)
          const keepSource = requiresSourceMode(content)
          showSourceRef.current = keepSource
          setShowSource(keepSource)
          if (!keepSource) setEditorMarkdown(content)
          setSaveStatus('saved')
        }
        setConflictReview(null)
        message.success('已载入磁盘版本')
      },
    })
  }, [clearFileConflict, clearPendingDraft, conflictReview, setDraft, setEditorMarkdown, setFileConflict, setFileRevision])

  const handleOpenHistory = useCallback(async (path = activeFileRef.current) => {
    if (!isMarkdownFile(path)) return
    setHistoryModal({ open: true, path, entries: [], loading: true })
    try {
      const res = await axios.get(`${API}/file/history`, { params: { path } })
      setHistoryModal({ open: true, path, entries: res.data.history || [], loading: false })
    } catch (error) {
      setHistoryModal({ open: false, path: '', entries: [], loading: false })
      message.error('读取版本历史失败：' + (error.response?.data?.error || error.message))
    }
  }, [])

  const handleRestoreHistory = useCallback(entry => {
    const path = historyModal.path
    if (!path || dirtyRef.current[path] || conflictsRef.current[path]) {
      message.warning('请先保存或处理当前草稿，再恢复历史版本')
      return
    }
    const expectedRevision = fileRevisionsRef.current[path]
    if (!expectedRevision) {
      message.error('缺少当前文件版本，无法安全恢复')
      return
    }
    Modal.confirm({
      title: '恢复这个历史版本？',
      content: '恢复会用历史内容替换当前磁盘版本，并保留当前版本作为新历史记录。',
      okText: '恢复版本',
      cancelText: '取消',
      onOk: async () => {
        try {
          const draftAtRequest = draftContentsRef.current[path]
          await axios.post(`${API}/file/restore`, { path, historyId: entry.id, expectedRevision })
          const res = await axios.get(`${API}/file`, { params: { path } })
          const content = res.data.content ?? ''
          cleanContentsRef.current[path] = content
          if (res.data.revision) setFileRevision(path, res.data.revision)
          const currentDraft = draftContentsRef.current[path]
          const changedDuringRestore = dirtyRef.current[path] || currentDraft !== draftAtRequest
          if (changedDuringRestore) {
            setFileConflict(path, {
              type: 'history-restored-during-edit',
              baseRevision: expectedRevision,
              diskRevision: res.data.revision ?? null,
              diskContent: content,
            })
            setConflictReview({
              path,
              localContent: currentDraft ?? '',
              diskContent: content,
              diskRevision: res.data.revision ?? null,
            })
            if (currentDraft !== undefined) setDraft(path, currentDraft, true)
            if (activeFileRef.current === path) setSaveStatus('conflict')
            message.warning('历史版本已恢复；恢复期间的新草稿已保留，请先比较磁盘版本')
          } else {
            setDraft(path, content, false)
            clearPendingDraft(path)
            if (activeFileRef.current === path) {
              sourceContentRef.current = content
              setSourceContent(content)
              const keepSource = requiresSourceMode(content)
              showSourceRef.current = keepSource
              setShowSource(keepSource)
              if (!keepSource) setEditorMarkdown(content)
              setSaveStatus('saved')
            }
            message.success('已恢复历史版本')
          }
          const updated = await axios.get(`${API}/file/history`, { params: { path } })
          setHistoryModal({ open: true, path, entries: updated.data.history || [], loading: false })
        } catch (error) {
          if (error.response?.status === 409 && error.response?.data?.code === 'FILE_CONFLICT') {
            const conflict = {
              type: 'disk-changed',
              baseRevision: expectedRevision,
              diskRevision: error.response.data.currentRevision ?? null,
              diskContent: error.response.data.currentContent ?? null,
            }
            setFileConflict(path, conflict)
            message.error('磁盘文件已变化，历史版本未恢复；请先查看冲突')
          } else {
            message.error('恢复历史版本失败：' + (error.response?.data?.error || error.message))
          }
        }
      },
    })
  }, [clearPendingDraft, historyModal.path, setDraft, setEditorMarkdown, setFileConflict, setFileRevision])

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
    const enterRichMode = () => {
      const zoomMap = {}
      content.replace(/!\[([^\]]*)\]\((.*?)\)<!-- zoom:(\d+) -->/g, (_, _alt, src, zoom) => {
        zoomMap[src.replace(/^\//, '')] = zoom
        return ''
      })
      zoomMapRef.current = zoomMap
      setEditorMarkdown(content.replace(/!\[([^\]]*)\]\((.*?)\)<!-- zoom:(\d+) -->/g, '![$1]($2)'))
      setDraft(path, content, content !== cleanContentsRef.current[path])
      if (content !== cleanContentsRef.current[path]) setSaveStatus(conflictsRef.current[path] ? 'conflict' : 'modified')
      showSourceRef.current = false
      setShowSource(false)
      setTimeout(applyZoom, 0)
    }
    if (requiresSourceMode(content)) {
      Modal.confirm({
        title: '此文档包含源码模式保护内容',
        content: '富文本编辑器无法完整保留 YAML、WikiLinks、缩进任务、原始 HTML 或代码围栏附加信息。继续使用源码模式可以原样保存；仍切换后，下一次富文本编辑可能改写这些内容。',
        okText: '仍切换到富文本',
        cancelText: '继续源码模式',
        onOk: enterRichMode,
      })
      return
    }
    enterRichMode()
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
        isMarkdownFile(activeFileRef.current)
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
      const drafts = collectDirtyDrafts()
      writePendingDrafts(drafts)
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [captureCurrentDraft, collectDirtyDrafts, writePendingDrafts])

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
      setAttachmentViewer(null)
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
  const handleExport = async (targetPath = activeFileRef.current) => {
    const path = targetPath
    if (!path) return
    try {
      const markdown = isMarkdownFile(path)
      const res = await axios.get(`${API}/${markdown ? 'export' : 'download'}`, { params: { path }, responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = path.split('/').pop() || (markdown ? 'export.md' : 'attachment')
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { message.error('下载失败：' + (error.response?.data?.error || error.message)) }
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
      !isMarkdownFile(targetFile) || loadingRef.current ||
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
          setAttachmentViewer(null)
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
      await Promise.all([loadTrash(), loadRecoveryStats()])
      message.success(`已移入回收站：${node.path}。可从回收站恢复`)
    } catch (error) {
      message.error('移入回收站失败：' + (error.response?.data?.error || error.message))
    }
  }

  const loadTrash = useCallback(async () => {
    const requestId = ++trashRequestRef.current
    const requestedWorkspaceKey = recoveryWorkspaceKeyRef.current
    setTrashLoadingState({ workspaceKey: requestedWorkspaceKey, loading: true })
    try {
      const res = await axios.get(`${API}/trash`)
      if (
        trashRequestRef.current === requestId &&
        recoveryWorkspaceKeyRef.current === requestedWorkspaceKey
      ) {
        setTrashItems(Array.isArray(res.data?.items) ? res.data.items : [])
        setTrashItemsWorkspaceKey(requestedWorkspaceKey)
      }
      return true
    } catch (error) {
      if (
        trashRequestRef.current === requestId &&
        recoveryWorkspaceKeyRef.current === requestedWorkspaceKey
      ) message.error('读取回收站失败：' + (error.response?.data?.error || error.message))
      return false
    } finally {
      if (
        trashRequestRef.current === requestId &&
        recoveryWorkspaceKeyRef.current === requestedWorkspaceKey
      ) setTrashLoadingState({ workspaceKey: requestedWorkspaceKey, loading: false })
    }
  }, [])

  const loadRecoveryStats = useCallback(async () => {
    const requestId = ++recoveryStatsRequestRef.current
    const requestedWorkspaceKey = recoveryWorkspaceKeyRef.current
    setRecoveryStatsState(current => ({
      workspaceKey: requestedWorkspaceKey,
      stats: current.workspaceKey === requestedWorkspaceKey ? current.stats : null,
      loading: true,
    }))
    try {
      const res = await axios.get(`${API}/recovery/stats`)
      if (
        recoveryStatsRequestRef.current === requestId &&
        recoveryWorkspaceKeyRef.current === requestedWorkspaceKey
      ) {
        setRecoveryStatsState({ workspaceKey: requestedWorkspaceKey, stats: res.data, loading: false })
      }
      return true
    } catch (error) {
      if (
        recoveryStatsRequestRef.current === requestId &&
        recoveryWorkspaceKeyRef.current === requestedWorkspaceKey
      ) {
        setRecoveryStatsState({ workspaceKey: requestedWorkspaceKey, stats: null, loading: false })
        message.error('读取恢复数据空间统计失败：' + (error.response?.data?.error || error.message))
      }
      return false
    }
  }, [])

  const refreshTrashAndRecoveryStats = useCallback(async () => {
    await Promise.all([loadTrash(), loadRecoveryStats()])
  }, [loadRecoveryStats, loadTrash])

  const handleDeleteHistory = useCallback(entry => {
    const path = historyModal.path
    if (!path || !entry?.id) return
    Modal.confirm({
      title: '永久删除这个历史版本？',
      content: `将永久删除「${path}」的这条历史版本，无法从编辑器恢复。当前文档内容不会被删除或修改。`,
      okText: '永久删除历史版本',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setHistoryModal(current => current.path === path ? { ...current, loading: true } : current)
        try {
          await axios.delete(`${API}/file/history`, { params: { path, id: entry.id } })
          message.success('已永久删除这条历史版本；当前文档保持不变')
        } catch (error) {
          message.error('删除历史版本失败：' + (error.response?.data?.error || error.message))
        }
        try {
          const [updated] = await Promise.all([
            axios.get(`${API}/file/history`, { params: { path } }),
            loadRecoveryStats(),
          ])
          setHistoryModal(current => current.path === path
            ? { ...current, entries: updated.data.history || [], loading: false }
            : current)
        } catch (error) {
          setHistoryModal(current => current.path === path ? { ...current, loading: false } : current)
          message.error('刷新版本历史失败：' + (error.response?.data?.error || error.message))
        }
      },
    })
  }, [historyModal.path, loadRecoveryStats])

  const handleOpenTrash = useCallback(async () => {
    setTrashModalOpen(true)
    await Promise.all([loadTrash(), loadRecoveryStats()])
  }, [loadRecoveryStats, loadTrash])

  const handleRestoreTrashItem = useCallback(async item => {
    try {
      await axios.post(`${API}/trash/restore`, { id: item.id })
      await Promise.all([loadTree(), loadTrash(), loadRecoveryStats()])
      message.success(`已从回收站恢复：${item.path}`)
    } catch (error) {
      message.error('恢复失败：' + (error.response?.data?.error || error.message))
    }
  }, [loadRecoveryStats, loadTrash, loadTree])

  const handlePurgeExpiredTrash = useCallback(() => {
    Modal.confirm({
      title: '永久清理已过期回收站项目？',
      content: '只会清理已过期的项目。确认后会永久删除这些数据，无法从编辑器恢复；未过期项目会保留。',
      okText: '确认清理过期项目',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setTrashMutationBusy(true)
        try {
          const res = await axios.post(`${API}/trash/purge-expired`)
          message.success(`已永久清理 ${Number(res.data?.purged || 0).toLocaleString()} 个过期项目`)
        } catch (error) {
          message.error('清理过期项目失败：' + (error.response?.data?.error || error.message))
        } finally {
          await refreshTrashAndRecoveryStats()
          setTrashMutationBusy(false)
        }
      },
    })
  }, [refreshTrashAndRecoveryStats])

  const handlePermanentlyDeleteTrashItem = useCallback(item => {
    if (!item?.id) return
    Modal.confirm({
      title: `永久删除「${item.path}」？`,
      content: `这会永久删除回收站中的「${item.path}」及其内容，无法从编辑器恢复。该路径已归档的历史版本会保留，可在“已删除文件的历史版本”中单独查看或删除。`,
      okText: '永久删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setTrashMutationBusy(true)
        try {
          await axios.delete(`${API}/trash`, { params: { id: item.id } })
          message.success(`已永久删除：${item.path}`)
        } catch (error) {
          message.error('永久删除回收站项目失败：' + (error.response?.data?.error || error.message))
        } finally {
          await refreshTrashAndRecoveryStats()
          setTrashMutationBusy(false)
        }
      },
    })
  }, [refreshTrashAndRecoveryStats])

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
      migrateVersionState(node.path, newPath)
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
      migrateVersionState(renamingPath, newPath)
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
  const activeConflict = activeFile ? fileConflicts[activeFile] : null
  const sourceModeRequired = showSource && requiresSourceMode(sourceContent)
  const recoveryAlternativeCount = Object.values(recoveryAlternatives).reduce((count, entries) => count + entries.length, 0)
  const activeSaveStatus = activeFile
    ? (activeConflict ? 'conflict' : (saveErrors[activeFile] ? 'error' : (saveStatus === 'idle' ? 'saved' : saveStatus)))
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
                        { key: 'export', label: isMarkdownFile(activeFile) ? '导出当前文件' : '下载当前文件', icon: <ApiOutlined />, disabled: !activeFile },
                        { type: 'divider' },
                        { key: 'trash', label: '回收站', icon: <DeleteOutlined /> },
                        { key: 'recovery-drafts', label: `其他恢复草稿（${recoveryAlternativeCount}）`, icon: <HistoryOutlined />, disabled: recoveryAlternativeCount === 0 },
                      ],
                      onClick: ({ key }) => {
                        if (key === 'expand') handleToggleExpandAll()
                        if (key === 'locate') handleLocateCurrentFile()
                        if (key === 'folder') setCreateModal({ open: true, parent: '', type: 'dir' })
                        if (key === 'import') setImportModal(true)
                        if (key === 'export') handleExport()
                        if (key === 'trash') handleOpenTrash()
                        if (key === 'recovery-drafts') setRecoveryModalOpen(true)
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
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <Tooltip title="更改目录"><Button size="small" icon={<FolderOpenOutlined />} onClick={handleChangeWorkspace} aria-label="更改目录" title="更改目录" /></Tooltip>
            <Tooltip title={isAllExpanded ? '全部折叠' : '全部展开'}><Button aria-label={isAllExpanded ? '全部折叠' : '全部展开'} size="small" icon={<MenuOutlined />} onClick={handleToggleExpandAll} title={isAllExpanded ? '全部折叠' : '全部展开'} /></Tooltip>
            <Tooltip title="定位当前文件"><Button aria-label="定位当前文件" size="small" icon={<NodeIndexOutlined />} onClick={handleLocateCurrentFile} title="定位当前文件" disabled={!activeFile} /></Tooltip>
            <Tooltip title={sidebarView === 'outline' ? '返回文件目录' : '查看文档大纲'}><Button aria-label={sidebarView === 'outline' ? '返回文件目录' : '查看文档大纲'} size="small" icon={<ReadOutlined />} onClick={() => setSidebarView(v => v === 'outline' ? 'tree' : 'outline')} title={sidebarView === 'outline' ? '返回文件目录' : '查看文档大纲'} /></Tooltip>
            <Tooltip title="新建文件夹"><Button aria-label="新建文件夹" size="small" icon={<PlusOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'dir' })} title="新建文件夹" /></Tooltip>
            <Tooltip title="新建文件"><Button aria-label="新建文件" size="small" icon={<FileOutlined />} onClick={() => setCreateModal({ open: true, parent: '', type: 'file' })} title="新建文件" /></Tooltip>
            <Tooltip title="回收站"><Button aria-label="打开回收站" size="small" icon={<DeleteOutlined />} onClick={() => { setMobileSidebarOpen(false); handleOpenTrash() }} /></Tooltip>
            {recoveryAlternativeCount > 0 && <Tooltip title={`其他恢复草稿（${recoveryAlternativeCount}）`}><Button aria-label="打开其他恢复草稿" size="small" icon={<HistoryOutlined />} onClick={() => { setMobileSidebarOpen(false); setRecoveryModalOpen(true) }} /></Tooltip>}
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

      <Modal
        title={`回收站（${visibleTrashItems.length}）`}
        open={trashModalOpen}
        onCancel={() => setTrashModalOpen(false)}
        footer={<Button onClick={() => setTrashModalOpen(false)}>关闭</Button>}
        width={640}
      >
        <div className="recovery-stats-panel" aria-label="恢复数据空间统计">
          <div className="recovery-stats-heading">恢复数据占用</div>
          {recoveryStatsLoading ? (
            <div role="status" className="recovery-stats-status">正在读取空间统计…</div>
          ) : recoveryStats ? (
            <>
              <div className="recovery-stats-grid">
                {[
                  ['历史版本', recoveryStats.history],
                  ['回收站', recoveryStats.trash],
                  ['总计', recoveryStats.total],
                ].map(([label, section]) => (
                  <div className="recovery-stats-card" key={label} aria-label={`${label}占用`}>
                    <span className="recovery-stats-label">{label}</span>
                    <strong>{Number(section?.items || 0).toLocaleString()} 项</strong>
                    <span className="recovery-stats-bytes">{formatRecoveryBytes(section?.bytes)} 占用</span>
                  </div>
                ))}
              </div>
              {recoveryStats.generatedAt && (
                <div className="recovery-stats-generated">统计时间：{new Date(recoveryStats.generatedAt).toLocaleString()}</div>
              )}
            </>
          ) : (
            <div className="recovery-stats-error" role="alert">
              <span>空间统计暂不可用，回收站列表仍可操作。</span>
              <Button size="small" onClick={loadRecoveryStats}>重试统计</Button>
            </div>
          )}
        </div>
        <div className="trash-maintenance-row">
          <span>只清理已过期项目；每条也可单独永久删除。</span>
          <Button
            danger
            disabled={trashMutationBusy || trashLoading || visibleTrashItems.length === 0}
            onClick={handlePurgeExpiredTrash}
          >清理过期项目</Button>
        </div>
        {trashModalOpen && (
          <OrphanHistoryManager onChange={async change => {
            await refreshTrashAndRecoveryStats()
            if (change?.type === 'restore') await loadTree()
          }} />
        )}
        {trashLoading ? (
          <div role="status" style={{ padding: 24, textAlign: 'center' }}>正在读取回收站…</div>
        ) : visibleTrashItems.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>回收站为空</div>
        ) : (
          <div className="trash-items-list">
            {visibleTrashItems.map(item => (
              <div key={item.id} className="trash-item-row">
                <div className="trash-item-details">
                  <div className="trash-item-path" title={item.path}>{item.path}</div>
                  <div className="trash-item-meta">
                    {item.type === 'directory' ? '文件夹' : '文件'} · 移入时间：{new Date(item.createdAt).toLocaleString()}
                    {item.expiresAt && ` · 到期时间：${new Date(item.expiresAt).toLocaleString()}`}
                  </div>
                </div>
                <div className="trash-item-actions">
                  <Button size="small" type="primary" disabled={trashMutationBusy} aria-label={`恢复 ${item.path}`} onClick={() => handleRestoreTrashItem(item)}>恢复</Button>
                  <Button size="small" danger disabled={trashMutationBusy} aria-label={`永久删除 ${item.path}`} onClick={() => handlePermanentlyDeleteTrashItem(item)}>永久删除</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        title={`其他本地恢复草稿（${recoveryAlternativeCount}）`}
        open={recoveryModalOpen}
        onCancel={() => setRecoveryModalOpen(false)}
        footer={<Button onClick={() => setRecoveryModalOpen(false)}>关闭</Button>}
        width="min(1050px, 94vw)"
      >
        {recoveryAlternativeCount === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>没有其他可恢复草稿</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '65vh', overflow: 'auto' }}>
            {Object.entries(recoveryAlternatives).flatMap(([path, entries]) => entries.map(entry => {
              const currentDraft = savedContents[path] ?? draftContentsRef.current[path]
              return (
                <section key={`${path}:${entry.id}`} style={{ padding: 12, border: '1px solid var(--color-border)', borderRadius: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <strong style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={path}>{path}</strong>
                    <span style={{ color: 'var(--color-text-secondary)', fontSize: 11, whiteSpace: 'nowrap' }}>
                      {entry.sourceSession === '旧版恢复数据' ? '旧版草稿' : '其他标签页'} · {new Date(entry.snapshot.savedAt).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600 }}>
                      当前标签页草稿
                      <Input.TextArea readOnly value={currentDraft ?? '当前标签页还没有本地草稿'} autoSize={{ minRows: 5, maxRows: 12 }} aria-label={`当前草稿 ${path}`} />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 600 }}>
                      其他恢复草稿{entry.snapshot.baseRevision ? `（基于 ${entry.snapshot.baseRevision.slice(0, 12)}）` : '（磁盘基线未知）'}
                      <Input.TextArea readOnly value={entry.snapshot.content} autoSize={{ minRows: 5, maxRows: 12 }} aria-label={`其他恢复草稿 ${path}`} />
                    </label>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                    <Button type="primary" onClick={() => handleUseRecoveryAlternative(path, entry)}>载入并比较磁盘版本</Button>
                  </div>
                </section>
              )
            }))}
          </div>
        )}
      </Modal>

      <Modal
        title={`文件冲突：${conflictReview?.path || ''}`}
        open={Boolean(conflictReview)}
        onCancel={() => setConflictReview(null)}
        footer={[
          <Button key="download" onClick={handleExportConflictDraft}>下载本地草稿</Button>,
          <Button key="reload" danger disabled={conflictReview?.diskContent == null} onClick={handleReloadDiskAfterConflict}>丢弃草稿并重载</Button>,
          <Button key="close" type="primary" onClick={() => setConflictReview(null)}>保留草稿</Button>,
          <Button
            key="save-local"
            disabled={conflictReview?.diskContent == null || conflictReview?.diskRevision == null}
            onClick={() => Modal.confirm({
              title: '采用本地草稿并覆盖当前磁盘内容？',
              content: '确认后会重新读取磁盘版本；只有版本仍与上方比较内容一致时才保存本地草稿。若版本再次变化，保存会停止并刷新比较内容。',
              okText: '确认并保存本地草稿',
              cancelText: '返回比较',
              okButtonProps: { danger: true },
              onOk: handleSaveLocalConflict,
            })}
          >覆盖磁盘并保存本地草稿</Button>,
        ]}
        width="min(1100px, 94vw)"
      >
        <div style={{ marginBottom: 12, color: 'var(--color-text-secondary)', fontSize: 13 }}>
          请先比较本地草稿与当前磁盘版本。编辑器不会自动合并或覆盖；采用本地草稿前会再次确认，保存也会重新校验磁盘版本并使用条件写入。
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 600 }}>
            本地草稿
            <Input.TextArea readOnly value={conflictReview?.localContent ?? ''} autoSize={{ minRows: 14, maxRows: 24 }} aria-label="本地草稿内容" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 600 }}>
            当前磁盘版本
            <Input.TextArea readOnly value={conflictReview?.diskContent ?? '磁盘文件当前不可读取。请保留并下载本地草稿。'} autoSize={{ minRows: 14, maxRows: 24 }} aria-label="当前磁盘版本内容" />
          </label>
        </div>
      </Modal>

      <Modal
        title={`版本历史：${historyModal.path || ''}`}
        open={historyModal.open}
        confirmLoading={historyModal.loading}
        onCancel={() => setHistoryModal({ open: false, path: '', entries: [], loading: false })}
        footer={<Button onClick={() => setHistoryModal({ open: false, path: '', entries: [], loading: false })}>关闭</Button>}
        width={640}
      >
        {historyModal.loading ? (
          <div role="status" style={{ padding: 24, textAlign: 'center' }}>正在读取版本历史…</div>
        ) : historyModal.entries.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>暂无可恢复的历史版本</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '60vh', overflow: 'auto' }}>
            {(isDirty[historyModal.path] || fileConflicts[historyModal.path]) && (
              <div role="alert" style={{ padding: 10, color: 'var(--color-warning)', background: 'var(--color-bg-muted)', borderRadius: 6 }}>
                请先保存或处理当前本地草稿，再恢复历史版本。
              </div>
            )}
            {historyModal.entries.map(entry => (
              <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 10, border: '1px solid var(--color-border)', borderRadius: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{new Date(entry.savedAt).toLocaleString()}</div>
                  <div title={entry.revision} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-secondary)', fontSize: 11 }}>
                    {entry.revision?.slice(0, 16)} · {Number(entry.size || 0).toLocaleString()} 字节
                  </div>
                </div>
                <Button
                  size="small"
                  disabled={Boolean(isDirty[historyModal.path] || fileConflicts[historyModal.path])}
                  onClick={() => handleRestoreHistory(entry)}
                >恢复</Button>
                <Button
                  size="small"
                  danger
                  disabled={historyModal.loading}
                  aria-label={`永久删除历史版本 ${historyModal.path} ${entry.id}`}
                  onClick={() => handleDeleteHistory(entry)}
                >删除版本</Button>
              </div>
            ))}
          </div>
        )}
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
          ) : attachmentViewer ? (
            <div className="attachment-viewer" role="region" aria-label="附件只读查看">
              <FileOutlined className="empty-editor-icon" aria-hidden="true" />
              <div className="attachment-viewer-name">{attachmentViewer.name}</div>
              <div className="attachment-viewer-copy">
                此文件作为附件保留原始字节，当前不会按 Markdown 打开或自动保存。
              </div>
              <Button type="primary" aria-label="下载附件" onClick={() => handleExport(attachmentViewer.path)}>
                下载原始文件
              </Button>
            </div>
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
              {sourceModeRequired && (
                <div role="alert" className="source-fidelity-warning" style={{ padding: '7px 12px', color: 'var(--color-warning)', background: 'var(--color-bg-muted)', borderBottom: '1px solid var(--color-border)', fontSize: 12 }}>
                  此文档包含富文本模式无法完整保留的 Markdown 语法。当前使用源码模式，可原样编辑和保存；切换到富文本前会再次提示风险。
                </div>
              )}
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
                      setSaveStatus(conflictsRef.current[path] ? 'conflict' : 'modified')
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
          {draftStorageError && (
            <div role="alert" className="draft-storage-warning" style={{ padding: '6px 12px', color: 'var(--color-warning)', background: 'var(--color-bg-muted)', borderBottom: '1px solid var(--color-border)', fontSize: 12 }}>
              {draftStorageError}。服务端自动保存仍会继续。
            </div>
          )}
          {activeConflict && (
            <div role="alert" className="file-conflict-banner" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', color: 'var(--color-danger)', background: 'var(--color-bg-muted)', borderBottom: '1px solid var(--color-border)', fontSize: 12 }}>
              <WarningOutlined aria-hidden="true" />
              <span style={{ flex: '1 1 280px' }}>磁盘文件已变化；本地草稿已保留，自动保存已暂停。请比较版本后选择处理。</span>
              <Button size="small" onClick={() => handleShowConflictReview()}>查看磁盘版本</Button>
              <Button size="small" onClick={handleExportConflictDraft}>下载本地草稿</Button>
              <Button size="small" danger disabled={!activeConflict.diskRevision} onClick={handleReloadDiskAfterConflict}>丢弃草稿并重载</Button>
            </div>
          )}
          <div className="editor-statusbar" aria-label="文档状态栏">
            <div className="editor-file-location" title={activeFile || '尚未选择文件'}>
              <FileOutlined aria-hidden="true" />
              <span>{activeFile ? activeFile.split('/').pop() : '选择文件开始编辑'}</span>
            </div>
            <div className="editor-status-actions">
              {activeFile && isMarkdownFile(activeFile) && <SaveStatus status={activeSaveStatus} onRetry={handleRetrySave} />}
              {activeFile && isMarkdownFile(activeFile) && (
                <Button aria-label="查看版本历史" size="small" icon={<HistoryOutlined />} onClick={() => handleOpenHistory(activeFile)}>历史</Button>
              )}
              {activeFile && isMarkdownFile(activeFile) && (
                <Button aria-label="保存当前文件" size="small" type="primary" icon={<SaveOutlined />} onClick={handleSave} className="save-button">保存</Button>
              )}
              {attachmentViewer && (
                <Button aria-label="下载附件" size="small" icon={<ApiOutlined />} onClick={() => handleExport(attachmentViewer.path)}>下载</Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {!isMobile && !editorFullscreen && showOutline && isMarkdownFile(activeFile) && (
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--color-danger)' }} onClick={() => { setContextMenu(p => ({ ...p, visible: false })); Modal.confirm({ title: `将「${contextMenu.node.name}」移入回收站？`, content: contextMenu.node.type === 'dir' ? '整个文件夹及其中内容会一起移入回收站，可从回收站恢复。' : '文件会移入回收站，可从回收站恢复。', okText: '移入回收站', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => handleDelete(contextMenu.node) }) }}>
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
