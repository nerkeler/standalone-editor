import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { Button, Modal, Input, message, Tooltip, Dropdown } from 'antd'
import {
  FileOutlined, FolderOpenOutlined, PlusOutlined, SaveOutlined,
  CloseOutlined, MoreOutlined, DeleteOutlined, SwapOutlined,
  ArrowLeftOutlined, EditOutlined, MenuOutlined,
  NodeIndexOutlined, ApiOutlined, AppstoreOutlined,
  CheckOutlined, LoadingOutlined, CloseCircleOutlined, ReloadOutlined,
  ReadOutlined, FileAddOutlined, FolderAddOutlined, SearchOutlined,
  ZoomInOutlined, ZoomOutOutlined, WarningOutlined, HistoryOutlined,
  UploadOutlined
} from '@ant-design/icons'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import Heading from '@tiptap/extension-heading'
import Strike from '@tiptap/extension-strike'
import { api as axios } from '../api'
import { readJsonStorage, readStorage, writeStorage } from '../safeStorage.js'
import { common, createLowlight } from 'lowlight'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import useEditorDrafts, { isImageFile, isMarkdownFile } from './useEditorDrafts'
import { requiresSourceMode } from './markdownSourcePolicy'
import { analyzeMarkdownSource } from './markdownDiagnostics.js'
import { getMarkdownSourceOutline } from './markdownSourceOutline.js'
import { proposeSafeMarkdownRepair } from './safeMarkdownNormalization.js'
import { isPermissionDenied, requestErrorMessage } from '../requestErrorMessage'
import { TableContextTools } from './TableControls'
import ImageControls from './ImageControls'
import { createSearchCoordinator } from '../searchCoordinator'
import { createUploadedImageReference } from '../markdownImagePaths'
import { createMarkdownCodec } from './markdownCodec'
import { MAX_EDITABLE_MARKDOWN_BYTES, isEditableMarkdownSize, utf8ByteLength } from '../markdownSize'
import DocumentTabs from './DocumentTabs'
import { ConflictModal, HistoryModal, RecoveryAlternativesModal, TrashModal } from './EditorRecoveryModals'
import useWorkspaceRecovery from './useWorkspaceRecovery.js'
import FileTree from './FileTree'
import ContextActionMenu from './ContextActionMenu'
import OutlinePanel, { OutlineList } from './OutlinePanel'
import WorkbenchToolbar from './WorkbenchToolbar'
import './Editor.css'

const lowlight = createLowlight(common)
const MarkdownSourceEditor = lazy(() => import('./MarkdownSourceEditor'))
const markdownCodec = createMarkdownCodec()

const API = '/api/workspace'

function SaveStatus({ status, errorMessage, onRetry }) {
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
      <span title={status === 'error' ? errorMessage : undefined}>
        {status === 'error' && errorMessage?.includes('无权限') ? '无权限，保存失败' : current.label}
      </span>
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

function downloadMarkdownDraft(filePath, content) {
  if (!filePath || typeof content !== 'string') return
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${filePath.split('/').pop()}.local-draft.md`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function repairChangeLabel(change) {
  if (typeof change === 'string') return change
  if (!change || typeof change !== 'object') return ''
  const directLabel = change.label || change.description || change.summary || change.message
  if (typeof directLabel === 'string') return directLabel
  if (['referenceLinks', 'reference-link', 'reference_link'].includes(change.reason || change.type || change.code)) {
    return '将引用式链接改为直接链接'
  }
  return '修复一处 Markdown 写法'
}

function repairDiagnosticLabel(diagnostic) {
  if (typeof diagnostic === 'string') return diagnostic
  const directLabel = diagnostic?.message || diagnostic?.label || diagnostic?.description
  if (directLabel) return directLabel
  const names = {
    frontMatter: 'YAML 元数据',
    wikiLinks: 'WikiLinks',
    footnotes: '脚注',
    referenceLinks: '引用式链接',
    escapedSyntax: '转义语法',
    tableAlignment: '表格对齐',
    nestedLists: '嵌套列表',
    rawHtml: '原始 HTML',
    codeFenceMetadata: '代码围栏附加信息',
    unparseableMarkdown: '无法解析的 Markdown',
  }
  return names[diagnostic?.reason] || diagnostic?.reason || ''
}

function markdownRepairPreview(before, after) {
  const sourceBefore = String(before || '')
  const sourceAfter = String(after || '')
  let changedAt = 0
  while (changedAt < sourceBefore.length && changedAt < sourceAfter.length && sourceBefore[changedAt] === sourceAfter[changedAt]) changedAt += 1
  const linePreview = source => {
    const start = source.lastIndexOf('\n', Math.max(0, changedAt - 1)) + 1
    const lineEnd = source.indexOf('\n', changedAt)
    const end = lineEnd < 0 ? source.length : lineEnd
    const line = source.slice(start, end).replace(/\t/g, '⇥')
    return line.length > 110 ? `${line.slice(0, 107)}…` : line || '(空行)'
  }
  return { before: linePreview(sourceBefore), after: linePreview(sourceAfter) }
}

const MarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      markdownSrc: {
        default: null,
        parseHTML: element => element.getAttribute('data-markdown-src'),
        renderHTML: attributes => attributes.markdownSrc
          ? { 'data-markdown-src': attributes.markdownSrc }
          : {},
      },
      markdownTitle: {
        default: null,
        parseHTML: element => element.getAttribute('data-markdown-title'),
        renderHTML: attributes => attributes.markdownTitle
          ? { 'data-markdown-title': attributes.markdownTitle }
          : {},
      },
      imageWidth: {
        default: null,
        parseHTML: element => element.getAttribute('data-image-width'),
        renderHTML: attributes => attributes.imageWidth
          ? { 'data-image-width': String(attributes.imageWidth), style: `width:${attributes.imageWidth}%;max-width:100%` }
          : {},
      },
      imageAlign: {
        default: null,
        parseHTML: element => element.getAttribute('data-image-align'),
        renderHTML: attributes => attributes.imageAlign
          ? { 'data-image-align': attributes.imageAlign, style: attributes.imageAlign === 'center' ? 'display:block;margin-left:auto;margin-right:auto' : 'display:block;margin-left:0;margin-right:auto' }
          : {},
      },
      legacyZoom: {
        default: null,
        parseHTML: element => element.getAttribute('data-legacy-zoom'),
        renderHTML: attributes => attributes.legacyZoom
          ? { 'data-legacy-zoom': attributes.legacyZoom, style: `zoom:${attributes.legacyZoom}%` }
          : {},
      },
    }
  },
})

const MarkdownHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      escapedNumberingDot: {
        default: false,
        parseHTML: element => element.getAttribute('data-markdown-escaped-numbering-dot') === 'true',
        renderHTML: attributes => attributes.escapedNumberingDot
          ? { 'data-markdown-escaped-numbering-dot': 'true' }
          : {},
      },
    }
  },
})

const MarkdownTableCell = TableCell.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      textAlign: {
        default: null,
        parseHTML: element => element.getAttribute('align'),
        renderHTML: attributes => attributes.textAlign ? { align: attributes.textAlign } : {},
      },
    }
  },
})

const MarkdownTableHeader = TableHeader.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      textAlign: {
        default: null,
        parseHTML: element => element.getAttribute('align'),
        renderHTML: attributes => attributes.textAlign ? { align: attributes.textAlign } : {},
      },
    }
  },
})

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

function menuAnchorPosition(event, fallbackElement) {
  const clientX = Number(event?.clientX) || 0
  const clientY = Number(event?.clientY) || 0
  if (clientX || clientY) return { x: clientX, y: clientY }
  const rect = fallbackElement?.getBoundingClientRect?.()
  return rect
    ? { x: rect.left + Math.min(rect.width / 2, 20), y: rect.bottom }
    : { x: 12, y: 12 }
}

// ========== 主组件 ==========

export default function Editor({ workspace, workspaceInfo, onRequestWorkspacePicker, themeToggle }) {
  const [tree, setTree] = useState([])
  const [selectedKey, setSelectedKey] = useState('')
  const selectedTreeKeys = useMemo(() => [selectedKey], [selectedKey])
  const [openFiles, setOpenFiles] = useState([])
  const [activeFile, setActiveFile] = useState('')
  const [tabMenu, setTabMenu] = useState({ visible: false, x: 0, y: 0, target: '', restoreFocusTo: null })
  const [createModal, setCreateModal] = useState({ open: false, parent: '', type: 'file' })
  const [createName, setCreateName] = useState('')
  const [uploading, setUploading] = useState(false)
  const imageInputRef = useRef(null)
  const importInputRef = useRef(null)
  const [contextMenu, setContextMenu] = useState({ visible: false, node: null, x: 0, y: 0, restoreFocusTo: null })
  const [moveModal, setMoveModal] = useState({ open: false, node: null })
  const [moveTarget, setMoveTarget] = useState('')
  const moveTreeSelectedKeys = useMemo(() => moveTarget ? [moveTarget] : [], [moveTarget])
  const [moveBusy, setMoveBusy] = useState(false)
  const fileTreeHandlersRef = useRef({})
  const fileTreeSelect = useCallback((...args) => fileTreeHandlersRef.current.select?.(...args), [])
  const fileTreeDrop = useCallback((...args) => fileTreeHandlersRef.current.drop?.(...args), [])
  const fileTreeContextMenu = useCallback((...args) => fileTreeHandlersRef.current.contextMenu?.(...args), [])
  const fileTreeRenameStart = useCallback((...args) => fileTreeHandlersRef.current.renameStart?.(...args), [])
  const fileTreeRenameConfirm = useCallback((...args) => fileTreeHandlersRef.current.renameConfirm?.(...args), [])
  const fileTreeRenameCancel = useCallback((...args) => fileTreeHandlersRef.current.renameCancel?.(...args), [])
  const moveTreeSelect = useCallback((...args) => fileTreeHandlersRef.current.moveSelect?.(...args), [])
  const [showSource, setShowSource] = useState(false)
  const [sourceContent, setSourceContent] = useState('')
  const [markdownRepairProposal, setMarkdownRepairProposal] = useState(null)
  const [markdownRepairError, setMarkdownRepairError] = useState(null)
  const [markdownRepairSaving, setMarkdownRepairSaving] = useState(false)
  const [, setSelectionEpoch] = useState(0)
  const [editorInteracted, setEditorInteracted] = useState(false)
  const sourceEditorRef = useRef(null)
  const [largeMarkdownView, setLargeMarkdownView] = useState(null)
  const [editorFullscreen, setEditorFullscreen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [showSidebar] = useState(true)
  const [showToolbar, setShowToolbar] = useState(true)
  const [directoryMenuOpen, setDirectoryMenuOpen] = useState(false)
  const [sidebarView, setSidebarView] = useState('tree')
  const [showOutline, setShowOutline] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const storedWidth = readStorage('sidebarWidth')
    const stored = parseInt(storedWidth.ok ? (storedWidth.value || '280') : '280', 10)
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
  const [searchLoading, setSearchLoading] = useState(false)
  const searchCoordinatorRef = useRef(null)
  const [importModal, setImportModal] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [importWarningDismissed, setImportWarningDismissed] = useState(false)
  const importComponentMountedRef = useRef(true)
  const [fileLoading, setFileLoading] = useState(false)
  const [conflictReview, setConflictReview] = useState(null)
  const [historyModal, setHistoryModal] = useState({ open: false, path: '', entries: [], loading: false })
  const [trashModalOpen, setTrashModalOpen] = useState(false)
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false)
  const recoveryWorkspaceKey = `${workspaceInfo?.workspaceId || ''}:${workspaceInfo?.workspaceVersion ?? ''}:${workspaceInfo?.workspace || workspace || ''}`
  const recoveryWorkspaceKeyRef = useRef(recoveryWorkspaceKey)
  recoveryWorkspaceKeyRef.current = recoveryWorkspaceKey
  const {
    trashItems: visibleTrashItems,
    trashLoading,
    mutationBusy: trashMutationBusy,
    stats: recoveryStats,
    statsLoading: recoveryStatsLoading,
    createIntent: createRecoveryIntent,
    isIntentCurrent: isRecoveryIntentCurrent,
    runIntent: runRecoveryIntent,
  } = useWorkspaceRecovery({ api: axios, workspaceKey: recoveryWorkspaceKey, workspaceInfo })

  useEffect(() => {
    setTrashModalOpen(false)
  }, [recoveryWorkspaceKey])

  useEffect(() => {
    setImportModal(false)
    setImportResult(null)
    setImportWarningDismissed(false)
    setImportLoading(false)
  }, [recoveryWorkspaceKey])

  useEffect(() => {
    importComponentMountedRef.current = true
    return () => { importComponentMountedRef.current = false }
  }, [])

  const reportRecoveryRefresh = useCallback((result, requestedWorkspaceKey) => {
    if (requestedWorkspaceKey !== recoveryWorkspaceKeyRef.current || result?.currentWorkspace !== true) return
    if (result.trash?.reason === 'request-failed') {
      message.error('读取回收站失败：' + requestErrorMessage(result.trash.error, '请求失败'))
    }
    if (result.stats?.reason === 'request-failed') {
      message.error('读取恢复数据空间统计失败：' + requestErrorMessage(result.stats.error, '请求失败'))
    }
  }, [])

  const refreshTrashAndRecoveryStats = useCallback(async () => {
    const intent = createRecoveryIntent('refresh')
    if (!intent) return { ok: false, reason: 'stale-workspace', currentWorkspace: false }
    const result = await runRecoveryIntent(intent)
    const requestedWorkspaceKey = intent.workspaceKey
    const currentWorkspace = isRecoveryIntentCurrent(intent) && result?.currentWorkspace === true
    const scopedResult = { ...result, currentWorkspace }
    reportRecoveryRefresh(scopedResult, requestedWorkspaceKey)
    return scopedResult
  }, [createRecoveryIntent, isRecoveryIntentCurrent, reportRecoveryRefresh, runRecoveryIntent])

  // The editor renders one document at a time, but every open tab keeps its
  // own Markdown draft. Refs make save callbacks independent of React's
  // render timing, which is essential when tabs are switched quickly.
  const activeFileRef = useRef(activeFile)
  const workspaceInfoRef = useRef(workspaceInfo)
  const showSourceRef = useRef(showSource)
  const sourceContentRef = useRef(sourceContent)
  const markdownRepairProposalRef = useRef(null)
  const markdownRepairOperationRef = useRef(false)
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
    setDraft, clearSaveTimer, setSaveBlocked, saveBlockedRef, doSave, scheduleSave, waitForPathSaves,
  } = useEditorDrafts(workspace, activeFileRef, workspaceInfo?.workspaceId)
  // renderedFileRef identifies the document currently represented by the
  // ProseMirror instance. While a file request is pending the editor still
  // contains the previous tab, so capturing it as the new tab would corrupt
  // that tab's draft.
  const renderedFileRef = useRef('')
  const readOnlyMarkdownRef = useRef(false)
  const loadingRef = useRef(false)
  const openRequestRef = useRef(0)
  const suppressEditorUpdateRef = useRef(false)
  const handleImageUploadRef = useRef(null)

  const markEditorInteracted = useCallback(() => {
    setEditorInteracted(true)
    return false
  }, [])
  const handleEditorPaste = useCallback((_view, event) => {
    const items = Array.from(event.clipboardData?.items || [])
    const imageItem = items.find(item => item.type.startsWith('image/'))
    if (!imageItem) return false
    event.preventDefault()
    const file = imageItem.getAsFile()
    if (file) handleImageUploadRef.current?.(file)
    return true
  }, [])
  const editorProps = useMemo(() => ({
    handleDOMEvents: {
      click: markEditorInteracted,
      focusin: markEditorInteracted,
      paste: handleEditorPaste,
    },
  }), [handleEditorPaste, markEditorInteracted])

  useEffect(() => { activeFileRef.current = activeFile }, [activeFile])
  useEffect(() => { workspaceInfoRef.current = workspaceInfo }, [workspaceInfo])
  useEffect(() => { openFilesRef.current = openFiles }, [openFiles])
  useEffect(() => { showSourceRef.current = showSource }, [showSource])
  useEffect(() => { sourceContentRef.current = sourceContent }, [sourceContent])

  const updateMarkdownRepairProposal = useCallback(proposal => {
    markdownRepairProposalRef.current = proposal
    setMarkdownRepairProposal(proposal)
    setMarkdownRepairError(null)
  }, [])

  const clearMarkdownRepairProposal = useCallback((expectedProposal = null) => {
    if (expectedProposal && markdownRepairProposalRef.current !== expectedProposal) return
    markdownRepairProposalRef.current = null
    setMarkdownRepairProposal(null)
    setMarkdownRepairError(null)
  }, [])

  useEffect(() => {
    const proposal = markdownRepairProposalRef.current
    if (proposal && (
      proposal.path !== activeFile ||
      proposal.workspaceKey !== recoveryWorkspaceKey ||
      proposal.diskRevision !== fileRevisions[proposal.path] ||
      isDirty[proposal.path] ||
      fileConflicts[proposal.path]
    )) clearMarkdownRepairProposal(proposal)
  }, [activeFile, clearMarkdownRepairProposal, fileConflicts, fileRevisions, isDirty, recoveryWorkspaceKey])

  useEffect(() => {
    if (workspaceInfo?.workspaceId) {
      // App normally installs this context before mounting Editor. This
      // fallback also makes a direct Editor mount use the supplied identity.
      writeStorage('editor_workspace_info', JSON.stringify(workspaceInfo))
      writeStorage('editor_workspace', workspaceInfo.workspace || workspace)
    }
  }, [workspaceInfo, workspace])

  const [renamingPath, setRenamingPath] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef(null)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    setIsMobile(mq.matches)
    const handler = e => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const editor = useEditor({
    editorProps,
    extensions: [
      StarterKit.configure({ heading: false, strike: false, codeBlock: false, link: false, underline: false }),
      MarkdownHeading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
      MarkdownImage.configure({ inline: false, allowBase64: true }),
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: '' }),
      TaskList,
      TaskItem.configure({ nested: true, HTMLAttributes: { 'data-type': 'taskItem' } }),
      Table.configure({ resizable: true }),
      TableRow,
      MarkdownTableCell,
      MarkdownTableHeader,
      Strike,
    ],
  }, [])

  useEffect(() => {
    if (!editor) return
    const editable = Boolean(
      activeFile && !fileLoading && isMarkdownFile(activeFile) &&
      renderedFileRef.current === activeFile && !readOnlyMarkdownRef.current
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

  const sourceOutlineItems = useMemo(
    () => showSource && (showOutline || sidebarView === 'outline') ? getMarkdownSourceOutline(sourceContent) : [],
    [showSource, showOutline, sidebarView, sourceContent],
  )
  const visibleOutlineItems = fileLoading || !isMarkdownFile(activeFile) || renderedFileRef.current !== activeFile
    ? []
    : (showSource ? sourceOutlineItems : outlineItems)
  const goToOutlineItem = item => {
    if (item.pos == null) return
    if (showSource) {
      sourceEditorRef.current?.goToPosition(item.pos)
      return
    }
    if (editor) editor.chain().focus().setTextSelection(Math.min(item.pos + 1, editor.state.doc.content.size)).scrollIntoView().run()
  }

  useEffect(() => {
    if (!editor) return
    refreshOutline()
    editor.on('update', refreshOutline)
    return () => editor.off('update', refreshOutline)
  }, [editor, refreshOutline, activeFile, savedContents[activeFile]])

  useEffect(() => {
    if (!editor) return
    const rerender = () => setSelectionEpoch(value => value + 1)
    editor.on('selectionUpdate', rerender)
    return () => editor.off('selectionUpdate', rerender)
  }, [editor])

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

  const loadTree = useCallback(async () => {
    const intent = createRecoveryIntent('refresh')
    if (!intent) return false
    try {
      const res = await axios.get(API, { params: { recursive: '1' } })
      if (!isRecoveryIntentCurrent(intent)) return false
      setTree(buildTree(res.data || []))
      setExpandedKeys(prev => prev.filter(key => findNode(buildTree(res.data || []), key)))
      return true
    } catch {
      return false
    }
  }, [createRecoveryIntent, isRecoveryIntentCurrent])

  // 搜索文件：输入立即更新，网络请求由 coordinator 防抖并忽略过期响应。
  const handleSearch = useCallback(q => {
    setSearchQuery(q)
    searchCoordinatorRef.current?.query(q)
  }, [])

  useEffect(() => {
    const coordinator = createSearchCoordinator({
      delayMs: 250,
      search: async q => {
        const res = await axios.get(`${API}/search`, { params: { q } })
        return res.data || []
      },
      onResults: setSearchResults,
      onLoading: setSearchLoading,
    })
    searchCoordinatorRef.current = coordinator
    return () => {
      coordinator.dispose()
      if (searchCoordinatorRef.current === coordinator) searchCoordinatorRef.current = null
    }
  }, [])

  const handleExpand = useCallback(keys => setExpandedKeys(keys), [])

  const handleFileTreeSelect = (keys, node) => {
    if (node?.type !== 'file') return
    setSelectedKey(node.path)
    setMobileSidebarOpen(false)
    handleFileOpen(node)
  }

  const handleFileTreeDrop = info => {
    const target = info.node
    const draggedKey = info.dragNodesKeys[0]
    const draggedNode = findNode(tree, draggedKey)
    const targetNode = findNode(tree, target.key)
    if (!draggedNode || !targetNode || targetNode.type !== 'dir') return
    if (draggedNode.path.startsWith(target.key + '/')) {
      message.warning('不能移动到自己的子目录')
      return
    }
    if (draggedNode.path !== target.key) handleMove(draggedNode, target.key)
  }

  const openNodeContextMenu = (node, event, restoreFocusTo) => {
    const position = menuAnchorPosition(event, restoreFocusTo)
    setTabMenu(menu => ({ ...menu, visible: false }))
    setContextMenu({ visible: true, node, ...position, restoreFocusTo })
  }

  const openTabContextMenu = (target, event) => {
    event.preventDefault()
    const restoreFocusTo = event.currentTarget?.querySelector?.('[role="tab"]') || event.currentTarget
    const position = menuAnchorPosition(event, restoreFocusTo)
    setContextMenu(menu => ({ ...menu, visible: false }))
    setTabMenu({ visible: true, target, ...position, restoreFocusTo })
  }

  const closeNodeContextMenu = useCallback(() => {
    setContextMenu(menu => ({ ...menu, visible: false }))
  }, [])

  const closeTabContextMenu = useCallback(() => {
    setTabMenu(menu => ({ ...menu, visible: false }))
  }, [])

  useEffect(() => { loadTree() }, [loadTree])

  const setEditorMarkdown = useCallback((content, documentPath = activeFileRef.current) => {
    if (!editor) return
    suppressEditorUpdateRef.current = true
    try {
      // The codec adapter feeds the editor's HTML representation into TipTap.
      // Keep the guard around replacement so no programmatic update becomes a draft.
      editor.commands.setContent(markdownCodec.toEditorHtml(content, {
        imageIdentity: workspaceInfoRef.current,
        documentPath,
      }), { emitUpdate: false })
    } finally {
      suppressEditorUpdateRef.current = false
    }
  }, [editor])

  const serializeCurrentEditor = useCallback(() => {
    if (!editor) return ''
    return markdownCodec.fromEditorHtml(editor.getHTML())
  }, [editor])

  const captureCurrentDraft = useCallback(() => {
    const path = activeFileRef.current
    if (!isMarkdownFile(path) || readOnlyMarkdownRef.current || saveBlockedRef.current.has(path) || loadingRef.current || renderedFileRef.current !== path) return undefined
    // Converting Markdown to editor HTML and back can normalize whitespace or
    // syntax even when the user has not touched the document. Keep the exact
    // loaded bytes for clean files; real edits are already marked by the
    // editor update handler (or the source textarea's change handler).
    if (!dirtyRef.current[path]) return draftContentsRef.current[path] ?? cleanContentsRef.current[path]
    const content = showSourceRef.current ? sourceContentRef.current : serializeCurrentEditor()
    setDraft(path, content, true)
    return content
  }, [saveBlockedRef, serializeCurrentEditor])

  // 编辑内容变化 → 将当前快照绑定到当前路径，再防抖保存。
  useEffect(() => {
    if (!editor) return
    const handler = () => {
      if (suppressEditorUpdateRef.current) return
      const path = activeFileRef.current
      if (!isMarkdownFile(path) || readOnlyMarkdownRef.current || saveBlockedRef.current.has(path) || showSourceRef.current || loadingRef.current || renderedFileRef.current !== path) return
      const content = serializeCurrentEditor()
      if (!isEditableMarkdownSize(content)) {
        const accepted = draftContentsRef.current[path] ?? cleanContentsRef.current[path] ?? ''
        setEditorMarkdown(accepted, path)
        message.warning('文档超过 5 MiB 可编辑上限，已撤销这次输入')
        return
      }
      clearMarkdownRepairProposal()
      setDraft(path, content, true)
      setSaveStatus(conflictsRef.current[path] ? 'conflict' : 'modified')
      scheduleSave(path, content)
    }
    editor.on('update', handler)
    return () => editor.off('update', handler)
  }, [clearMarkdownRepairProposal, editor, scheduleSave, serializeCurrentEditor, setDraft, setEditorMarkdown, saveBlockedRef])

  const loadFile = useCallback(async (path, requestId, workspaceKeyAtOpen) => {
    try {
      const res = await axios.get(`${API}/file`, { params: { path } })
      const payload = res.data || {}
      const fetched = typeof payload.content === 'string' ? payload.content : ''
      const size = Number.isSafeInteger(payload.size) ? payload.size : utf8ByteLength(fetched)
      const editable = payload.editable !== false && size <= MAX_EDITABLE_MARKDOWN_BYTES &&
        typeof payload.content === 'string' && isEditableMarkdownSize(fetched)
      if (!editable) {
        if (requestId !== openRequestRef.current || activeFileRef.current !== path) return
        setSaveBlocked(path, true)
        const hasUnsavedDraft = Boolean(dirtyRef.current[path] && draftContentsRef.current[path] !== undefined)
        if (hasUnsavedDraft) writePendingDrafts(collectDirtyDrafts())
        readOnlyMarkdownRef.current = true
        setLargeMarkdownView({
          path,
          size,
          content: payload.previewAvailable !== false && typeof payload.content === 'string' ? payload.content : null,
          maxEditableBytes: Number(payload.maxEditableBytes) || MAX_EDITABLE_MARKDOWN_BYTES,
          hasUnsavedDraft,
        })
        renderedFileRef.current = path
        loadingRef.current = false
        setFileLoading(false)
        setShowSource(false)
        showSourceRef.current = false
        sourceContentRef.current = ''
        setSourceContent('')
        setEditorMarkdown('', path)
        editor?.setEditable(false, false)
        setSaveStatus(hasUnsavedDraft ? 'error' : 'saved')
        if (window.matchMedia('(max-width: 768px)').matches) setMobileSidebarOpen(false)
        return
      }
      if (requestId !== openRequestRef.current || activeFileRef.current !== path || workspaceKeyAtOpen !== recoveryWorkspaceKeyRef.current) return
      setSaveBlocked(path, false)
      readOnlyMarkdownRef.current = false
      setLargeMarkdownView(null)
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
      if (requestId !== openRequestRef.current || activeFileRef.current !== path || workspaceKeyAtOpen !== recoveryWorkspaceKeyRef.current) return
      let proposedRepair = null
      if (!hasDirtyDraft && diskRevision) {
        try { proposedRepair = proposeSafeMarkdownRepair(fetched) } catch { proposedRepair = null }
      }
      const repairProposal = proposedRepair && typeof proposedRepair.content === 'string' &&
        proposedRepair.content !== fetched && isEditableMarkdownSize(proposedRepair.content)
        ? {
            ...proposedRepair,
            path,
            workspaceKey: workspaceKeyAtOpen,
            diskRevision,
            requestId,
            sourceContent: fetched,
          }
        : null
      if (
        repairProposal && requestId === openRequestRef.current &&
        activeFileRef.current === path && workspaceKeyAtOpen === recoveryWorkspaceKeyRef.current &&
        !dirtyRef.current[path] && !conflictsRef.current[path] &&
        !saveTimersRef.current.has(path) && !saveQueuesRef.current.has(path)
      ) updateMarkdownRepairProposal(repairProposal)
      else clearMarkdownRepairProposal()
      setEditorInteracted(false)
      const visible = draftContentsRef.current[path] ?? fetched
      sourceContentRef.current = visible
      renderedFileRef.current = path
      loadingRef.current = false
      setFileLoading(false)
      const keepSource = requiresSourceMode(visible)
      showSourceRef.current = keepSource
      setShowSource(keepSource)
      if (!keepSource) setEditorMarkdown(visible, path)
      setSourceContent(visible)
      setSaveStatus(conflictsRef.current[path] ? 'conflict' : (saveErrorsRef.current[path] ? 'error' : (dirtyRef.current[path] ? 'modified' : 'saved')))
      if (window.matchMedia('(max-width: 768px)').matches) setMobileSidebarOpen(false)
    } catch (error) {
      if (requestId !== openRequestRef.current || activeFileRef.current !== path) return
      loadingRef.current = false
      renderedFileRef.current = ''
      setFileLoading(false)
      setEditorMarkdown('')
      sourceContentRef.current = ''
      setSourceContent('')
      setSaveStatus('idle')
      readOnlyMarkdownRef.current = false
      setLargeMarkdownView(null)
      message.error('打开文件失败：' + (error.response?.data?.error || error.message))
    }
  }, [clearFileConflict, clearMarkdownRepairProposal, editor, setEditorMarkdown, setDraft, setFileConflict, setFileRevision, setSaveBlocked, updateMarkdownRepairProposal])

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
      editor?.setEditable(isMarkdownFile(node.name || path) && !readOnlyMarkdownRef.current, false)
      return
    }
    const requestId = ++openRequestRef.current
    const workspaceKeyAtOpen = recoveryWorkspaceKeyRef.current
    const previousPath = activeFileRef.current
    if (
      previousPath && previousPath !== path &&
      !loadingRef.current && renderedFileRef.current === previousPath &&
      !markdownRepairOperationRef.current
    ) captureCurrentDraft()
    setSelectedKey(path)
    if (!openFilesRef.current.includes(path)) {
      openFilesRef.current = [...openFilesRef.current, path]
      setOpenFiles(prev => prev.includes(path) ? prev : [...prev, path])
    }
    activeFileRef.current = path
    setActiveFile(path)
    clearMarkdownRepairProposal()
    readOnlyMarkdownRef.current = false
    setLargeMarkdownView(null)
    setShowSource(false)
    showSourceRef.current = false
    setImageViewer(null)
    setAttachmentViewer(null)
    loadingRef.current = true
    setFileLoading(true)
    editor?.setEditable(false, false)

    if (isImageFile(node.name || path)) {
      try {
        if (requestId !== openRequestRef.current || activeFileRef.current !== path) return
        const reference = createUploadedImageReference(path, path, workspaceInfoRef.current)
        if (!reference?.url) throw new Error('工作空间图片地址无效')
        loadingRef.current = false
        renderedFileRef.current = path
        setFileLoading(false)
        setImageViewer({ path, url: reference.url, name: node.name || path.split('/').pop() })
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
    await loadFile(path, requestId, workspaceKeyAtOpen)
  }, [captureCurrentDraft, clearMarkdownRepairProposal, collectDirtyDrafts, editor, loadFile, setSaveBlocked, waitForDraftRestore, writePendingDrafts])

  const handleConfirmMarkdownRepair = useCallback(async () => {
    const proposal = markdownRepairProposalRef.current
    if (!proposal || markdownRepairOperationRef.current) return
    const { path } = proposal
    const isCurrent = () => markdownRepairProposalRef.current === proposal &&
      activeFileRef.current === path &&
      openRequestRef.current === proposal.requestId &&
      recoveryWorkspaceKeyRef.current === proposal.workspaceKey &&
      renderedFileRef.current === path && !loadingRef.current &&
      fileRevisionsRef.current[path] === proposal.diskRevision &&
      cleanContentsRef.current[path] === proposal.sourceContent &&
      draftContentsRef.current[path] === proposal.sourceContent &&
      !dirtyRef.current[path] && !conflictsRef.current[path] &&
      !saveBlockedRef.current.has(path) &&
      !saveTimersRef.current.has(path) && !saveQueuesRef.current.has(path)

    if (!isCurrent()) {
      clearMarkdownRepairProposal(proposal)
      message.warning('修复建议已过期，原文未修改；请重新打开文件后再试')
      return
    }

    markdownRepairOperationRef.current = true
    setMarkdownRepairSaving(true)
    try {
      setDraft(path, proposal.content, true)
      sourceContentRef.current = proposal.content
      setSourceContent(proposal.content)
      const keepSource = requiresSourceMode(proposal.content)
      showSourceRef.current = keepSource
      setShowSource(keepSource)
      if (!keepSource) setEditorMarkdown(proposal.content, path)
      editor?.setEditable(!keepSource, false)
      setSaveStatus('modified')
      const saved = await doSave(path, proposal.content)
      if (!saved) throw new Error('保存操作未执行')

      const workspaceStillMatches = recoveryWorkspaceKeyRef.current === proposal.workspaceKey
      const currentDraft = draftContentsRef.current[path]
      if (workspaceStillMatches && currentDraft === proposal.content && !dirtyRef.current[path]) {
        if (activeFileRef.current === path && openRequestRef.current === proposal.requestId && renderedFileRef.current === path) {
          sourceContentRef.current = proposal.content
          setSourceContent(proposal.content)
          setSaveStatus('saved')
        }
        clearMarkdownRepairProposal(proposal)
        message.success('Markdown 已修复并保存')
      } else {
        clearMarkdownRepairProposal(proposal)
        if (activeFileRef.current === path) {
          setSaveStatus('modified')
          message.info('修复内容已保存；保存期间的新修改仍待保存')
        }
      }
    } catch (error) {
      const conflict = Boolean(conflictsRef.current[path]) ||
        error?.response?.data?.code === 'FILE_CONFLICT' || error?.response?.data?.error === 'FILE_CONFLICT'
      clearMarkdownRepairProposal(proposal)
      setMarkdownRepairError({
        path,
        message: conflict
          ? '磁盘版本已变化，修复没有覆盖文件；修复后的草稿仍已保留，可先比较版本。'
          : '修复没有保存；修复后的草稿仍已保留，可检查后重试保存。',
      })
      if (conflict) message.warning('磁盘版本已变化；修复未写入，修复后的草稿已保留')
      else message.error('修复未能保存；修复后的草稿已保留')
    } finally {
      markdownRepairOperationRef.current = false
      setMarkdownRepairSaving(false)
    }
  }, [clearMarkdownRepairProposal, doSave, editor, setDraft, setEditorMarkdown])

  const handleCancelMarkdownRepair = useCallback(() => {
    const proposal = markdownRepairProposalRef.current
    clearMarkdownRepairProposal(proposal)
  }, [clearMarkdownRepairProposal])

  const removeTabState = useCallback(path => {
    clearSaveTimer(path)
    setSaveBlocked(path, false)
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
  }, [clearSaveTimer, setSaveBlocked])

  const pathsUnder = useCallback(path => (
    [...new Set([
      ...openFilesRef.current.filter(file => file === path || file.startsWith(`${path}/`)),
      ...Object.entries(dirtyRef.current)
        .filter(([file, dirty]) => dirty && saveBlockedRef.current.has(file) && (file === path || file.startsWith(`${path}/`)))
        .map(([file]) => file),
    ])]
  ), [dirtyRef, saveBlockedRef])

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
    if (paths.includes(activeFileRef.current) && !markdownRepairOperationRef.current) captureCurrentDraft()
    await waitForPathSaves(paths)
    // A timer may have been installed by a stale render while the request was
    // being awaited. Clearing it here prevents an old path from coming back
    // after a successful move or delete.
    paths.forEach(clearSaveTimer)
  }, [captureCurrentDraft, clearSaveTimer, waitForPathSaves])

  const downloadLocalDraft = useCallback(path => {
    const content = draftContentsRef.current[path]
    if (!path || content === undefined) return false
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${path.split('/').pop()}.local-draft.md`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  }, [])

  const finishCloseTab = useCallback(async (path, { preserveDraft = false } = {}) => {
    const remaining = openFilesRef.current.filter(file => file !== path)
    if (!preserveDraft) removeTabState(path)
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
  }, [handleFileOpen, removeTabState, setEditorMarkdown])

  const handleClose = useCallback(async (path, e) => {
    e?.stopPropagation()
    const hasBlockedDraft = saveBlockedRef.current.has(path) &&
      dirtyRef.current[path] && draftContentsRef.current[path] !== undefined
    if (hasBlockedDraft) {
      if (!writePendingDrafts(collectDirtyDrafts(), [path])) {
        message.error('无法确认本地恢复草稿已写入；标签页仍保持打开')
        return
      }
      Modal.confirm({
        title: '关闭含有未保存草稿的只读文档？',
        content: '这个文件已超过可编辑上限，草稿无法保存到磁盘。继续会尝试下载草稿并关闭标签；浏览器中的恢复副本会保留，可稍后重新打开继续处理。',
        okText: '下载草稿并关闭',
        cancelText: '保留草稿',
        onOk: async () => {
          if (!downloadLocalDraft(path)) {
            message.error('未能下载本地草稿，标签页仍保持打开')
            throw new Error('local draft download failed')
          }
          await finishCloseTab(path, { preserveDraft: true })
        },
      })
      return
    }
    try {
      await flushPaths([path])
    } catch (error) {
      message.error(isPermissionDenied(error)
        ? `${requestErrorMessage(error)}；未保存内容已保留，标签页仍保持打开`
        : '保存失败，标签页仍保持打开')
      return
    }
    await finishCloseTab(path)
  }, [collectDirtyDrafts, downloadLocalDraft, finishCloseTab, flushPaths, saveBlockedRef, writePendingDrafts])

  const handleSave = useCallback(async () => {
    const path = activeFileRef.current
    if (markdownRepairOperationRef.current) return
    if (!isMarkdownFile(path) || readOnlyMarkdownRef.current || saveBlockedRef.current.has(path)) return
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
        : isPermissionDenied(error)
        ? `${requestErrorMessage(error)}；未保存内容已保留`
        : '保存失败，已保留未保存状态')
    }
  }, [captureCurrentDraft, doSave, saveBlockedRef])

  const handleRetrySave = useCallback(() => {
    const path = activeFileRef.current
    if (markdownRepairOperationRef.current) return
    if (!isMarkdownFile(path) || readOnlyMarkdownRef.current || saveBlockedRef.current.has(path) || conflictsRef.current[path]) return
    const content = showSourceRef.current ? sourceContentRef.current : captureCurrentDraft()
    if (content === undefined) return
    setSaveStatus('saving')
    doSave(path, content).catch(() => {})
  }, [captureCurrentDraft, doSave, saveBlockedRef])

  const handleShowConflictReview = useCallback(async (requestedPath = activeFileRef.current, suppliedConflict) => {
    const path = requestedPath
    if (!path || saveBlockedRef.current.has(path)) return
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
  }, [fileConflicts, setFileConflict, saveBlockedRef])

  const handleUseRecoveryAlternative = useCallback(async (path, entry) => {
    if (!isEditableMarkdownSize(entry?.snapshot?.content || '') || saveBlockedRef.current.has(path)) {
      message.warning('该恢复草稿超过 5 MiB 上限或当前文档为只读，不能载入编辑器')
      return
    }
    try {
      clearSaveTimer(path)
      if (markdownRepairProposalRef.current?.path === path) clearMarkdownRepairProposal(markdownRepairProposalRef.current)
      const pendingSave = saveQueuesRef.current.get(path)
      if (pendingSave) await pendingSave.catch(() => {})
      if (activeFileRef.current !== path) {
        await handleFileOpen({ path, name: path.split('/').pop(), type: 'file' })
      }
      applyRecoveryAlternative(path, entry)
      const content = entry.snapshot.content
      const keepSource = requiresSourceMode(content)
      sourceContentRef.current = content
      setSourceContent(content)
      showSourceRef.current = keepSource
      setShowSource(keepSource)
      if (!keepSource) setEditorMarkdown(content)
      setSaveStatus('conflict')
      setRecoveryModalOpen(false)
      await handleShowConflictReview(path, conflictsRef.current[path])
    } catch (error) {
      message.error('载入恢复草稿失败：' + (error.response?.data?.error || error.message))
    }
  }, [applyRecoveryAlternative, clearMarkdownRepairProposal, clearSaveTimer, handleFileOpen, handleShowConflictReview, saveBlockedRef, setEditorMarkdown])

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

  const handleExportConflictDraft = useCallback(targetPath => {
    const path = targetPath || conflictReview?.path || activeFileRef.current
    return downloadLocalDraft(path)
  }, [conflictReview?.path, downloadLocalDraft])

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
        if (markdownRepairProposalRef.current?.path === path) clearMarkdownRepairProposal(markdownRepairProposalRef.current)
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
  }, [clearFileConflict, clearMarkdownRepairProposal, clearPendingDraft, conflictReview, setDraft, setEditorMarkdown, setFileConflict, setFileRevision])

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
        if (markdownRepairProposalRef.current?.path === path) clearMarkdownRepairProposal(markdownRepairProposalRef.current)
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
  }, [clearMarkdownRepairProposal, clearPendingDraft, historyModal.path, setDraft, setEditorMarkdown, setFileConflict, setFileRevision])

  const handleToggleSource = useCallback(() => {
    const path = activeFileRef.current
    if (markdownRepairOperationRef.current) return
    if (!path || readOnlyMarkdownRef.current || saveBlockedRef.current.has(path) || loadingRef.current || renderedFileRef.current !== path) return
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
      setEditorMarkdown(content)
      setDraft(path, content, content !== cleanContentsRef.current[path])
      if (content !== cleanContentsRef.current[path]) setSaveStatus(conflictsRef.current[path] ? 'conflict' : 'modified')
      showSourceRef.current = false
      setShowSource(false)
    }
    if (requiresSourceMode(content)) {
      Modal.confirm({
        title: '此文档包含源码模式保护内容',
        content: '富文本编辑器无法完整保留 YAML、WikiLinks、嵌套列表、引用链接、脚注、转义语法、表格对齐、原始 HTML 或代码围栏附加信息。继续使用源码模式可以原样保存；仍切换后，下一次富文本编辑可能改写这些内容。',
        okText: '仍切换到富文本',
        cancelText: '继续源码模式',
        onOk: enterRichMode,
      })
      return
    }
    enterRichMode()
  }, [captureCurrentDraft, saveBlockedRef, setEditorMarkdown])

  const prepareWorkspaceSelection = useCallback(async () => {
    const retainedBlockedDrafts = Object.entries(dirtyRef.current)
      .filter(([path, dirty]) => dirty && saveBlockedRef.current.has(path))
      .map(([path]) => path)
    await flushPaths([...new Set([...openFilesRef.current, ...retainedBlockedDrafts])])
    return true
  }, [dirtyRef, flushPaths, saveBlockedRef])

  const handleChangeWorkspace = useCallback(() => {
    onRequestWorkspacePicker?.({
      initialPath: workspaceInfo?.workspace || workspace,
      beforeSelect: prepareWorkspaceSelection,
    })
  }, [onRequestWorkspacePicker, prepareWorkspaceSelection, workspace, workspaceInfo?.workspace])

  // Give the browser a last chance to transmit drafts when a tab/window is
  // closed. The confirmation keeps the page alive long enough for keepalive
  // requests to be queued; clean documents leave unload completely silent.
  useEffect(() => {
    const handler = event => {
      if (
        activeFileRef.current && !loadingRef.current &&
        renderedFileRef.current === activeFileRef.current &&
        isMarkdownFile(activeFileRef.current) &&
        !markdownRepairOperationRef.current
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
    if (!file || importLoading) return
    const requestedWorkspaceKey = recoveryWorkspaceKeyRef.current
    const formData = new FormData()
    formData.append('file', file)
    setImportLoading(true)
    try {
      const res = await axios.post(`${API}/import`, formData, { headers: { 'Content-Type': 'multipart/form-data' } })
      if (!importComponentMountedRef.current || requestedWorkspaceKey !== recoveryWorkspaceKeyRef.current) return
      const cleanupWarnings = [...new Set((Array.isArray(res.data?.cleanupWarnings) ? res.data.cleanupWarnings : [])
        .filter(value => typeof value === 'string' && value.length > 0))]
      const result = {
        workspaceKey: requestedWorkspaceKey,
        imported: Number.isFinite(res.data?.imported) ? res.data.imported : 0,
        message: res.data?.message || `已导入 ${res.data?.imported || 0} 个文件`,
        cleanupWarnings,
      }
      if (cleanupWarnings.length) {
        setImportResult(result)
        setImportWarningDismissed(false)
        setImportModal(true)
      } else {
        message.success(result.message)
        setImportResult(null)
        setImportModal(false)
      }
      const treeLoaded = await loadTree()
      if (!treeLoaded && importComponentMountedRef.current && requestedWorkspaceKey === recoveryWorkspaceKeyRef.current) {
        message.warning('导入成功，但目录刷新失败，请刷新目录。')
      }
    } catch (e) {
      if (importComponentMountedRef.current && requestedWorkspaceKey === recoveryWorkspaceKeyRef.current) {
        message.error('导入失败：' + (e.response?.data?.error || e.message))
      }
    } finally {
      if (importComponentMountedRef.current && requestedWorkspaceKey === recoveryWorkspaceKeyRef.current) setImportLoading(false)
    }
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
    const sourceModeAtUpload = showSourceRef.current
    const sourceEditorAtUpload = sourceEditorRef.current
    if (
      !isMarkdownFile(targetFile) || loadingRef.current ||
      renderedFileRef.current !== targetFile || readOnlyMarkdownRef.current ||
      saveBlockedRef.current.has(targetFile)
    ) {
      message.error('请先打开一个 Markdown 文件')
      return
    }
    if (!sourceModeAtUpload && !editor) return
    if (sourceModeAtUpload && !sourceEditorAtUpload) {
      message.error('源码编辑器尚未就绪，请稍后重试')
      return
    }
    const formData = new FormData()
    formData.append('file', file)
    formData.append('documentPath', targetFile)
    setUploading(true)
    try {
      const res = await axios.post(`${API}/upload`, formData)
      const cachedWorkspace = readJsonStorage('editor_workspace_info', null)
      const info = workspaceInfo || (cachedWorkspace.ok && cachedWorkspace.value) || {}
      const reference = createUploadedImageReference(res.data.path, targetFile, info)
      if (!reference) throw new Error('上传图片路径无效')
      if (
        activeFileRef.current === targetFile &&
        openRequestRef.current === requestId &&
        !loadingRef.current && renderedFileRef.current === targetFile &&
        !readOnlyMarkdownRef.current && !saveBlockedRef.current.has(targetFile) &&
        showSourceRef.current === sourceModeAtUpload &&
        (!sourceModeAtUpload || sourceEditorRef.current === sourceEditorAtUpload)
      ) {
        const inserted = sourceModeAtUpload
          ? sourceEditorAtUpload?.insertMarkdownImage(reference.markdownSrc)
          : editor?.chain().focus().setImage({ src: reference.url, markdownSrc: reference.markdownSrc }).run()
        if (inserted) message.success('图片已插入')
        else message.error('图片已上传，但未能插入当前文档')
      } else {
        message.info('图片已上传，但当前文档已变化，未插入')
      }
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
      await refreshTrashAndRecoveryStats()
      message.success(`已移入回收站：${node.path}。可从回收站恢复`)
    } catch (error) {
      message.error('移入回收站失败：' + (error.response?.data?.error || error.message))
    }
  }

  const handleDeleteHistory = useCallback(entry => {
    const path = historyModal.path
    if (!path || !entry?.id) return
    const intent = createRecoveryIntent('refresh')
    if (!intent) return
    const identityConfig = {
      headers: {
        'X-Workspace-Id': intent.workspaceId,
        'X-Workspace-Version': String(intent.workspaceVersion),
      },
    }
    Modal.confirm({
      title: '永久删除这个历史版本？',
      content: `将永久删除「${path}」的这条历史版本，无法从编辑器恢复。当前文档内容不会被删除或修改。`,
      okText: '永久删除历史版本',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!isRecoveryIntentCurrent(intent)) return
        setHistoryModal(current => current.path === path ? { ...current, loading: true } : current)
        try {
          await axios.delete(`${API}/file/history`, { params: { path, id: entry.id }, ...identityConfig })
          if (!isRecoveryIntentCurrent(intent)) return
          message.success('已永久删除这条历史版本；当前文档保持不变')
        } catch (error) {
          if (!isRecoveryIntentCurrent(intent)) return
          message.error('删除历史版本失败：' + requestErrorMessage(error, '请求失败'))
        }
        if (!isRecoveryIntentCurrent(intent)) return
        try {
          const [updated] = await Promise.all([
            axios.get(`${API}/file/history`, { params: { path }, ...identityConfig }),
            refreshTrashAndRecoveryStats(),
          ])
          if (!isRecoveryIntentCurrent(intent)) return
          setHistoryModal(current => current.path === path
            ? { ...current, entries: updated.data.history || [], loading: false }
            : current)
        } catch (error) {
          if (!isRecoveryIntentCurrent(intent)) return
          setHistoryModal(current => current.path === path ? { ...current, loading: false } : current)
          message.error('刷新版本历史失败：' + requestErrorMessage(error, '请求失败'))
        }
      },
    })
  }, [createRecoveryIntent, historyModal.path, isRecoveryIntentCurrent, refreshTrashAndRecoveryStats])

  const handleOpenTrash = useCallback(async () => {
    setTrashModalOpen(true)
    await refreshTrashAndRecoveryStats()
  }, [refreshTrashAndRecoveryStats])

  const handleRestoreTrashItem = useCallback(async item => {
    const intent = createRecoveryIntent('restore-trash', { id: item?.id })
    if (!intent) return
    const result = await runRecoveryIntent(intent)
    if (!isRecoveryIntentCurrent(intent) || result.currentWorkspace !== true) return
    if (!result.ok) {
      if (result.reason === 'busy') {
        message.warning('另一个回收站操作正在进行，请稍后重试')
      } else if (result.reason === 'request-failed') {
        message.error('恢复失败：' + requestErrorMessage(result.error, '请求失败'))
      }
      return
    }
    await loadTree()
    if (!isRecoveryIntentCurrent(intent)) return
    reportRecoveryRefresh(result.refresh, intent.workspaceKey)
    message.success(`已从回收站恢复：${item.path}`)
  }, [createRecoveryIntent, isRecoveryIntentCurrent, loadTree, reportRecoveryRefresh, runRecoveryIntent])

  const handlePurgeExpiredTrash = useCallback(() => {
    const intent = createRecoveryIntent('purge-expired')
    if (!intent) return
    Modal.confirm({
      title: '永久清理已过期回收站项目？',
      content: '只会清理已过期的项目。确认后会永久删除这些数据，无法从编辑器恢复；未过期项目会保留。',
      okText: '确认清理过期项目',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!isRecoveryIntentCurrent(intent)) return
        const result = await runRecoveryIntent(intent)
        if (!isRecoveryIntentCurrent(intent) || result.currentWorkspace !== true) return
        if (!result.ok) {
          if (result.reason === 'busy') message.warning('另一个回收站操作正在进行，请稍后重试')
          else if (result.reason === 'request-failed') {
            message.error('清理过期项目失败：' + requestErrorMessage(result.error, '请求失败'))
          }
          return
        }
        reportRecoveryRefresh(result.refresh, intent.workspaceKey)
        message.success(`已永久清理 ${Number(result.data?.purged || 0).toLocaleString()} 个过期项目`)
      },
    })
  }, [createRecoveryIntent, isRecoveryIntentCurrent, reportRecoveryRefresh, runRecoveryIntent])

  const handlePermanentlyDeleteTrashItem = useCallback(item => {
    if (!item?.id) return
    const intent = createRecoveryIntent('delete-trash', { id: item.id })
    if (!intent) return
    Modal.confirm({
      title: `永久删除「${item.path}」？`,
      content: `这会永久删除回收站中的「${item.path}」及其内容，无法从编辑器恢复。该路径已归档的历史版本会保留，可在“已删除文件的历史版本”中单独查看或删除。`,
      okText: '永久删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (!isRecoveryIntentCurrent(intent)) return
        const result = await runRecoveryIntent(intent)
        if (!isRecoveryIntentCurrent(intent) || result.currentWorkspace !== true) return
        if (!result.ok) {
          if (result.reason === 'busy') message.warning('另一个回收站操作正在进行，请稍后重试')
          else if (result.reason === 'request-failed') {
            message.error('永久删除回收站项目失败：' + requestErrorMessage(result.error, '请求失败'))
          }
          return
        }
        reportRecoveryRefresh(result.refresh, intent.workspaceKey)
        message.success(`已永久删除：${item.path}`)
      },
    })
  }, [createRecoveryIntent, isRecoveryIntentCurrent, reportRecoveryRefresh, runRecoveryIntent])

  const confirmMoveReferenceImpacts = async (oldPath, newPath) => {
    const loadingKey = 'move-reference-preflight'
    message.loading({ content: '正在检查 Markdown 相对引用…', key: loadingKey, duration: 0 })
    let data
    try {
      ({ data } = await axios.post(`${API}/move/preflight`, { old_path: oldPath, new_path: newPath }))
    } finally {
      message.destroy(loadingKey)
    }
    const impacts = data.impacts || []
    const dirtyMarkdownDrafts = Object.entries(dirtyRef.current)
      .filter(([filePath, dirty]) => dirty && isMarkdownFile(filePath))
      .map(([filePath]) => filePath)
    const unscanned = Array.from(new Set([
      ...(data.unscannedMarkdownFiles || []),
      ...dirtyMarkdownDrafts,
    ]))
    if (!impacts.length && !unscanned.length) return true

    return new Promise(resolve => {
      let settled = false
      const finish = accepted => {
        if (settled) return
        settled = true
        resolve(accepted)
      }
      Modal.confirm({
        title: '移动可能影响 Markdown 引用',
        content: (
          <div>
            <p>预检识别标准 Markdown 行内和引用式链接、图片；HTML 标签及其他扩展语法可能无法识别。</p>
            {impacts.length > 0 && <>
              <p>以下相对链接或图片移动后会指向其他位置或失效：</p>
              <ul style={{ maxHeight: 220, overflow: 'auto', paddingLeft: 20 }}>
                {impacts.slice(0, 10).map((impact, index) => (
                  <li key={`${impact.documentPath}-${impact.reference}-${index}`} style={{ marginBottom: 8 }}>
                    <div>{impact.kind === 'image' ? '图片' : '链接'}：<code>{impact.reference}</code></div>
                    <div style={{ color: 'var(--color-text-secondary)' }}>
                      {impact.documentPath}{impact.documentAfterPath !== impact.documentPath ? ` → ${impact.documentAfterPath}` : ''}
                    </div>
                    <div style={{ color: 'var(--color-text-secondary)' }}>
                      目标：{impact.targetPath} → {impact.expectedTargetPath}
                    </div>
                  </li>
                ))}
              </ul>
              {impacts.length > 10 && <p>还有 {impacts.length - 10} 处引用未展开。</p>}
            </>}
            {unscanned.length > 0 && <p>
              有 {unscanned.length} 个 Markdown 文件或未保存草稿无法检查；其中可能包含受影响的引用。
              {unscanned.slice(0, 5).map((filePath, index) => <span key={`${filePath}-${index}`}>
                {index === 0 ? '（' : '、'}{filePath}{index === Math.min(unscanned.length, 5) - 1 ? '）' : ''}
              </span>)}
              {unscanned.length > 5 ? `等 ${unscanned.length} 项` : ''}
            </p>}
            <p>继续移动可能需要之后手动修复引用。取消会保持文件原位，也不会先保存或移动已打开的文档。</p>
          </div>
        ),
        okText: '仍然移动',
        cancelText: '取消移动',
        closable: false,
        keyboard: false,
        maskClosable: false,
        onOk: () => finish(true),
        onCancel: () => finish(false),
        afterClose: () => finish(false),
      })
    })
  }

  const remapViewers = (oldPath, newPath) => {
    setImageViewer(current => {
      if (!current) return current
      const imagePath = remapPath(current.path, oldPath, newPath)
      if (imagePath === current.path) return current
      const reference = createUploadedImageReference(imagePath, imagePath, workspaceInfoRef.current)
      return reference?.url
        ? { ...current, path: imagePath, url: reference.url, name: imagePath.split('/').pop() || current.name }
        : null
    })
    setAttachmentViewer(current => {
      if (!current) return current
      const attachmentPath = remapPath(current.path, oldPath, newPath)
      return attachmentPath === current.path ? current : {
        ...current, path: attachmentPath, name: attachmentPath.split('/').pop() || current.name,
      }
    })
  }

  const handleMove = async (node, newParent) => {
    const parts = node.path.split('/')
    const oldName = parts.pop() || node.name
    const newPath = newParent ? `${newParent}/${oldName}` : oldName
    if (node.path === newPath) return true
    if (node.type === 'dir' && newPath.startsWith(`${node.path}/`)) {
      message.warning('不能移动到自己的子目录')
      return
    }
    const affected = pathsUnder(node.path)
    try {
      const confirmed = await confirmMoveReferenceImpacts(node.path, newPath)
      if (!confirmed) return false
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
      remapViewers(node.path, newPath)
      await loadTree()
      message.success('移动成功')
      return true
    } catch (error) {
      message.error('移动失败：' + (error.response?.data?.error || error.message))
      return false
    }
  }

  const handleClear = () => {
    if (!editor || showSourceRef.current) return
    Modal.confirm({
      title: '确定清空当前内容？', content: '清空后不可恢复。',
      okText: '清空', cancelText: '取消', okButtonProps: { danger: true },
      onOk: () => { editor.commands.clearContent(); message.success('已清空') },
    })
  }

  const handleInsertLink = () => {
    if (showSourceRef.current) return
    Modal.confirm({
      title: '插入链接',
      content: <Input placeholder="输入链接 URL" id="link-url-input" autoFocus style={{ marginTop: 8 }} />,
      onOk: () => {
        const url = document.getElementById('link-url-input')?.value
        if (url && !showSourceRef.current) editor?.chain().focus().setLink({ href: url }).run()
      },
    })
  }

  const handleRenameStart = (node) => {
    setRenamingPath(node.path)
    setRenameValue(node.name)
    setContextMenu(p => ({ ...p, visible: false }))
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const handleRenameCancel = () => {
    setRenameValue('')
    setRenamingPath(null)
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
      const confirmed = await confirmMoveReferenceImpacts(renamingPath, newPath)
      if (!confirmed) { setRenamingPath(null); return }
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
      remapViewers(renamingPath, newPath)
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

  const nodeContextItems = contextMenu.node ? [
    ...(contextMenu.node.type === 'dir' ? [
      { key: 'create-folder', label: '在此创建文件夹', icon: <FolderOpenOutlined />, onSelect: () => setCreateModal({ open: true, parent: contextMenu.node.path, type: 'dir' }) },
      { key: 'create-file', label: '在此创建文件', icon: <FileOutlined />, onSelect: () => setCreateModal({ open: true, parent: contextMenu.node.path, type: 'file' }) },
      { key: 'divider', type: 'divider' },
    ] : []),
    { key: 'rename', label: '重命名', icon: <EditOutlined />, onSelect: () => handleRenameStart(contextMenu.node) },
    { key: 'move', label: '移动到...', icon: <SwapOutlined />, onSelect: () => { setMoveModal({ open: true, node: contextMenu.node }); setMoveTarget('') } },
    {
      key: 'delete', label: '移入回收站', icon: <DeleteOutlined />, danger: true,
      onSelect: () => Modal.confirm({
        title: `将「${contextMenu.node.name}」移入回收站？`,
        content: contextMenu.node.type === 'dir' ? '整个文件夹及其中内容会一起移入回收站，可从回收站恢复。' : '文件会移入回收站，可从回收站恢复。',
        okText: '移入回收站', cancelText: '取消', okButtonProps: { danger: true },
        onOk: () => handleDelete(contextMenu.node),
      }),
    },
  ] : []

  const tabContextItems = [
    { key: 'close', label: '关闭当前', icon: <CloseOutlined />, onSelect: () => handleClose(tabMenu.target) },
    { key: 'close-others', label: '关闭其他', icon: <FileOutlined />, onSelect: async () => {
      const target = tabMenu.target
      await closeTabGroup(openFiles.filter(file => file !== target))
      await handleFileOpen({ path: target, name: target.split('/').pop(), type: 'file' })
    } },
    { key: 'close-left', label: '关闭左侧', icon: <SwapOutlined />, onSelect: async () => {
      const target = tabMenu.target
      const index = openFiles.indexOf(target)
      await closeTabGroup(openFiles.slice(0, index))
      await handleFileOpen({ path: target, name: target.split('/').pop(), type: 'file' })
    } },
    { key: 'close-right', label: '关闭右侧', icon: <EditOutlined />, onSelect: async () => {
      const target = tabMenu.target
      const index = openFiles.indexOf(target)
      await closeTabGroup(openFiles.slice(index + 1))
      await handleFileOpen({ path: target, name: target.split('/').pop(), type: 'file' })
    } },
  ]

  const moveFolderTree = useMemo(
    () => moveModal.node ? collectFolders(tree, moveModal.node.path) : [],
    [moveModal.node, tree],
  )
  useLayoutEffect(() => {
    fileTreeHandlersRef.current = {
      select: handleFileTreeSelect,
      drop: handleFileTreeDrop,
      contextMenu: openNodeContextMenu,
      renameStart: handleRenameStart,
      renameConfirm: handleRenameConfirm,
      renameCancel: handleRenameCancel,
      moveSelect: (_keys, node) => {
        if (node?.type === 'dir') setMoveTarget(node.path)
      },
    }
  })
  const activeConflict = activeFile ? fileConflicts[activeFile] : null
  const activeLargeMarkdown = largeMarkdownView?.path === activeFile ? largeMarkdownView : null
  const tabDirtyState = isDirty
  const activeMarkdownRepair = markdownRepairProposal?.path === activeFile &&
    markdownRepairProposal.workspaceKey === recoveryWorkspaceKey &&
    markdownRepairProposal.diskRevision === fileRevisions[activeFile] &&
    !fileLoading && !activeLargeMarkdown && !activeConflict && !isDirty[activeFile]
    ? markdownRepairProposal
    : null
  const markdownRepairChanges = (activeMarkdownRepair?.changes || []).map(repairChangeLabel).filter(Boolean)
  const markdownRepairExample = activeMarkdownRepair
    ? markdownRepairPreview(activeMarkdownRepair.sourceContent, activeMarkdownRepair.content)
    : null
  const markdownRepairDiagnostics = activeMarkdownRepair
    ? (Array.isArray(activeMarkdownRepair.remainingDiagnostics)
        ? activeMarkdownRepair.remainingDiagnostics
        : analyzeMarkdownSource(activeMarkdownRepair.content))
    : []
  const markdownRepairDiagnosticLabels = [...new Set(markdownRepairDiagnostics.map(repairDiagnosticLabel).filter(Boolean))]
  const activeMarkdownRepairError = markdownRepairError?.path === activeFile && !activeMarkdownRepair
    ? markdownRepairError.message
    : ''
  const sourceModeRequired = showSource && requiresSourceMode(sourceContent)
  const sourceDiagnostics = showSource ? analyzeMarkdownSource(sourceContent) : []
  const recoveryAlternativeCount = Object.values(recoveryAlternatives).reduce((count, entries) => count + entries.length, 0)
  const activeSaveStatus = activeLargeMarkdown ? (activeLargeMarkdown.hasUnsavedDraft ? 'error' : 'saved') : activeFile
    ? (activeConflict ? 'conflict' : (saveErrors[activeFile] ? 'error' : (saveStatus === 'idle' ? 'saved' : saveStatus)))
    : 'idle'
  const currentImportResult = importResult?.workspaceKey === recoveryWorkspaceKey ? importResult : null
  return (
    <div
      id="editor-root"
      className="editor-shell"
      style={{
        display: 'flex',
        ...(isMobile
          ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }
          : { height: '100dvh', padding: 0 }),
        gap: isMobile ? 0 : 0,
        overflow: 'hidden',
        background: 'var(--color-bg)',
      }}
    >
      <input ref={imageInputRef} id="img-up" type="file" accept="image/*" hidden aria-label="选择要插入的图片"
        onChange={event => { const file = event.target.files?.[0]; if (file) handleImageUpload(file); event.target.value = '' }} />
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
                    open={directoryMenuOpen}
                    onOpenChange={setDirectoryMenuOpen}
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
                        if (key === 'import') {
                          setImportResult(null)
                          setImportWarningDismissed(false)
                          setImportModal(true)
                        }
                        if (key === 'export') handleExport()
                        if (key === 'trash') handleOpenTrash()
                        if (key === 'recovery-drafts') setRecoveryModalOpen(true)
                      },
                    }}
                  >
                    <Tooltip title="更多目录操作"><Button size="small" icon={<MoreOutlined />} aria-label="更多目录操作" aria-haspopup="menu" aria-expanded={directoryMenuOpen} /></Tooltip>
                  </Dropdown>
                </div>
              </div>
              {/* 搜索框 */}
              <div className="sidebar-search" style={{ padding: '0 8px 8px' }}>
                <Input size="small" prefix={<SearchOutlined />} placeholder="搜索文件..." allowClear
                  value={searchQuery} onChange={e => handleSearch(e.target.value)} />
              </div>
              {/* 搜索结果 */}
              {searchQuery.trim() && (
                <div style={{ padding: '0 8px 8px', maxHeight: 200, overflow: 'auto' }} aria-live="polite" aria-busy={searchLoading}>
                  {searchLoading && searchResults.length === 0 && (
                    <div style={{ padding: '8px 4px', fontSize: 12, color: 'var(--color-text-secondary)' }}>搜索中…</div>
                  )}
                  {!searchLoading && searchResults.length === 0 && (
                    <div style={{ padding: '8px 4px', fontSize: 12, color: 'var(--color-text-secondary)' }}>无结果</div>
                  )}
                  {searchResults.map(r => (
                    <button type="button" className="search-result" key={r.path} onClick={() => handleFileOpen({ path: r.path, name: r.name, type: 'file' })}>
                      <FileOutlined style={{ color: 'var(--color-file)', marginRight: 6 }} />
                      <span className="search-result-copy">
                        <span className="search-result-name">{r.name}</span>
                        {r.preview && <span className="search-result-preview">{r.preview}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="tree-scroll" style={{ flex: '1 1 0%', minHeight: 0, minWidth: 0, overflowX: 'hidden', overflowY: 'auto', padding: '0 8px 8px' }}>
                <FileTree
                  aria-label="文件目录"
                  nodes={tree}
                  selectedKeys={selectedTreeKeys}
                  expandedKeys={expandedKeys}
                  onExpand={handleExpand}
                  draggable
                  onSelect={fileTreeSelect}
                  onContextMenu={fileTreeContextMenu}
                  onDrop={fileTreeDrop}
                  renamingPath={renamingPath}
                  renameValue={renameValue}
                  renameInputRef={renameInputRef}
                  onRenameChange={setRenameValue}
                  onRenameStart={fileTreeRenameStart}
                  onRenameConfirm={fileTreeRenameConfirm}
                  onRenameCancel={fileTreeRenameCancel}
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
              <OutlineList className="sidebar-outline-items" items={visibleOutlineItems} onSelect={goToOutlineItem} />
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
            writeStorage('sidebarWidth', String(sidebarWidthRef.current))
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
            <OutlineList
              className="mobile-outline-list"
              items={visibleOutlineItems}
              onSelect={item => {
                goToOutlineItem(item)
                setMobileSidebarOpen(false)
              }}
            />
          ) : (
            <FileTree
              aria-label="文件目录"
              nodes={tree}
              selectedKeys={selectedTreeKeys}
              expandedKeys={expandedKeys}
              onExpand={handleExpand}
              onSelect={fileTreeSelect}
              onContextMenu={fileTreeContextMenu}
              onDrop={fileTreeDrop}
              renamingPath={renamingPath}
              renameValue={renameValue}
              renameInputRef={renameInputRef}
              onRenameChange={setRenameValue}
              onRenameStart={fileTreeRenameStart}
              onRenameConfirm={fileTreeRenameConfirm}
              onRenameCancel={fileTreeRenameCancel}
            />
          )}
          <div style={{ marginTop: 4, padding: '4px 10px 6px', borderRadius: 8, background: 'var(--color-bg-muted)', border: '1px solid var(--color-border)' }}>
            <div title={workspace} aria-label={`当前目录：${workspace}`} style={{ fontSize: 11, lineHeight: '16px', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspace}</div>
          </div>
        </div>
      </Modal>

      <TrashModal
        open={trashModalOpen}
        onClose={() => setTrashModalOpen(false)}
        items={visibleTrashItems}
        statsLoading={recoveryStatsLoading}
        stats={recoveryStats}
        formatBytes={formatRecoveryBytes}
        onRetryStats={refreshTrashAndRecoveryStats}
        mutationBusy={trashMutationBusy}
        loading={trashLoading}
        onPurgeExpired={handlePurgeExpiredTrash}
        onOrphanHistoryChange={async change => {
          const requestedWorkspaceKey = recoveryWorkspaceKeyRef.current
          const result = await refreshTrashAndRecoveryStats()
          if (requestedWorkspaceKey !== recoveryWorkspaceKeyRef.current || result.currentWorkspace !== true) return
          if (change?.type === 'restore') await loadTree()
        }}
        onRestore={handleRestoreTrashItem}
        onPermanentlyDelete={handlePermanentlyDeleteTrashItem}
      />

      <RecoveryAlternativesModal
        open={recoveryModalOpen}
        onClose={() => setRecoveryModalOpen(false)}
        count={recoveryAlternativeCount}
        alternatives={recoveryAlternatives}
        savedContents={savedContents}
        draftContents={draftContentsRef.current}
        onUseAlternative={handleUseRecoveryAlternative}
      />

      <ConflictModal
        conflictReview={conflictReview}
        onClose={() => setConflictReview(null)}
        onExport={handleExportConflictDraft}
        onReload={handleReloadDiskAfterConflict}
        onSave={handleSaveLocalConflict}
      />

      <HistoryModal
        historyModal={historyModal}
        onClose={() => setHistoryModal({ open: false, path: '', entries: [], loading: false })}
        isDirty={isDirty}
        fileConflicts={fileConflicts}
        onRestore={handleRestoreHistory}
        onDelete={handleDeleteHistory}
      />

      {/* 主区域 */}
      <div className="editor-main" style={{ flex: '1 1 0%', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {/* 标签页 */}
        <DocumentTabs
          files={openFiles}
          activeFile={activeFile}
          saveErrors={saveErrors}
          isDirty={tabDirtyState}
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
          ) : activeLargeMarkdown ? (
            <div role="region" aria-label="Markdown 只读预览" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--color-bg-card)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', fontSize: 13 }}>
                <span style={{ flex: 1 }}>
                  此文档为只读状态（{(activeLargeMarkdown.size / (1024 * 1024)).toFixed(1)} MiB），超过 5 MiB 可编辑上限。下载后可在其他工具中查看或拆分。
                  {activeLargeMarkdown.hasUnsavedDraft && <strong role="alert" style={{ display: 'block', color: 'var(--color-danger)', marginTop: 4 }}>
                    此标签保留有未保存的本地草稿，无法写入此只读文件。关闭前会提示下载并确认丢弃。
                  </strong>}
                </span>
                {activeLargeMarkdown.hasUnsavedDraft && <Button aria-label="下载本地草稿" onClick={() => handleExportConflictDraft(activeFile)}>下载本地草稿</Button>}
                <Button type="primary" aria-label="下载 Markdown" onClick={() => handleExport(activeFile)}>下载 Markdown</Button>
              </div>
              {typeof activeLargeMarkdown.content === 'string' ? (
                <pre aria-label="Markdown 只读内容" style={{ flex: 1, overflow: 'auto', margin: 0, padding: '20px 32px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'monospace', fontSize: 14, lineHeight: 1.7, color: 'var(--color-text)' }}>{activeLargeMarkdown.content}</pre>
              ) : (
                <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24, color: 'var(--color-text-secondary)', textAlign: 'center' }}>
                  文档超过 10 MiB。为避免载入超大内容，编辑器只提供原始文件下载。
                </div>
              )}
            </div>
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
              <WorkbenchToolbar
                editor={editor}
                isMobile={isMobile}
                showToolbar={showToolbar}
                onToggleToolbar={() => setShowToolbar(value => !value)}
                showSource={showSource}
                fileLoading={fileLoading}
                uploading={uploading}
                onToggleSource={handleToggleSource}
                onInsertLink={handleInsertLink}
                onUploadImage={() => imageInputRef.current?.click()}
                onTableInsert={() => setEditorInteracted(true)}
                showOutline={showOutline}
                onToggleOutline={() => setShowOutline(value => !value)}
                editorFullscreen={editorFullscreen}
                onToggleFullscreen={() => setEditorFullscreen(value => !value)}
              />

              {/* 编辑区 */}
              {activeMarkdownRepair && (
                <div className="markdown-repair-banner" role="region" aria-label="Markdown 修复建议">
                  <div className="markdown-repair-copy">
                    <strong>发现可安全规范的 Markdown 写法</strong>
                    <span>先看一处预览。文件只会在确认后修复并保存；暂不修复会保留原文。</span>
                    {markdownRepairExample && (
                      <div className="markdown-repair-example" aria-label="修复前后预览">
                        <code>{markdownRepairExample.before}</code>
                        <span aria-hidden="true">→</span>
                        <code>{markdownRepairExample.after}</code>
                      </div>
                    )}
                    <details className="markdown-repair-details">
                      <summary>查看全部 {markdownRepairChanges.length} 项和修复后的保护状态</summary>
                      {markdownRepairChanges.length > 0 && (
                        <ul>
                          {markdownRepairChanges.map((change, index) => <li key={`${index}-${change}`}>{change}</li>)}
                        </ul>
                      )}
                      {markdownRepairDiagnostics.length > 0 ? (
                        <span className="markdown-repair-remaining">
                          修复后仍有 {markdownRepairDiagnostics.length} 处源码保护内容，保存后继续使用源码模式。
                          {markdownRepairDiagnosticLabels.length > 0 ? ` 包括：${markdownRepairDiagnosticLabels.slice(0, 3).join('、')}${markdownRepairDiagnosticLabels.length > 3 ? '等' : ''}。` : ''}
                        </span>
                      ) : (
                        <span className="markdown-repair-remaining">修复后没有剩余的源码保护内容，可使用富文本编辑。</span>
                      )}
                    </details>
                  </div>
                  <div className="markdown-repair-actions">
                    <Button size="small" disabled={markdownRepairSaving} onClick={handleCancelMarkdownRepair}>暂不修复</Button>
                    <Button size="small" type="primary" loading={markdownRepairSaving} onClick={handleConfirmMarkdownRepair}>确认修复并保存</Button>
                  </div>
                </div>
              )}
              {activeMarkdownRepairError && (
                <div role="alert" className="markdown-repair-result">{activeMarkdownRepairError}</div>
              )}
              {sourceModeRequired && (
                <div role="status" className="source-fidelity-warning">
                  <div className="source-fidelity-copy">
                    <span>{sourceDiagnostics.length} 处内容需要源码保护。波浪线标出具体片段；悬停可查看原因。</span>
                    <details>
                      <summary>为什么使用源码模式？</summary>
                      <p>这些可能是合法的 Markdown 写法，并不代表语法错误。源码模式保留原文，避免富文本转换改写内容。</p>
                    </details>
                  </div>
                  <Button size="small" onClick={() => sourceEditorRef.current?.nextProtected()} aria-label="跳转到下一个受保护位置">下一个位置（F8）</Button>
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
                <Suspense fallback={<div className="source-editor" aria-label="正在加载源码编辑器" />}>
                  <MarkdownSourceEditor
                    ref={sourceEditorRef}
                    value={sourceContent}
                    onChange={value => {
                      if (!isEditableMarkdownSize(value)) {
                        message.warning('文档超过 5 MiB 可编辑上限，已撤销这次输入')
                        return false
                      }
                      clearMarkdownRepairProposal()
                      sourceContentRef.current = value
                      setSourceContent(value)
                      const path = activeFileRef.current
                      if (path) {
                        setDraft(path, value, true)
                        setSaveStatus(conflictsRef.current[path] ? 'conflict' : 'modified')
                        scheduleSave(path, value)
                      }
                    }}
                  />
                </Suspense>
              ) : (
                <div className="editor-scroll" style={{ flex: 1, overflow: 'auto', padding: '20px 32px', background: 'var(--color-bg-card)' }}>
                  <TableContextTools editor={editor} visible={editorInteracted} />
                  <ImageControls editor={editor} visible={editorInteracted} />
                  <div className="prose-column">
                    <EditorContent editor={editor} style={{ height: '100%' }} />
                  </div>
                </div>
              )}
            </>
          )}
          {draftStorageError && (
            <div role="alert" className="draft-storage-warning" style={{ padding: '6px 12px', color: 'var(--color-warning)', background: 'var(--color-bg-muted)', borderBottom: '1px solid var(--color-border)', fontSize: 12 }}>
              {draftStorageError}。{activeLargeMarkdown ? '当前文档为只读。' : '服务端自动保存仍会继续。'}
            </div>
          )}
          {activeConflict && !activeLargeMarkdown && (
            <div role="alert" className="file-conflict-banner" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', color: 'var(--color-danger)', background: 'var(--color-bg-muted)', borderBottom: '1px solid var(--color-border)', fontSize: 12 }}>
              <WarningOutlined aria-hidden="true" />
              <span style={{ flex: '1 1 280px' }}>磁盘文件已变化；本地草稿已保留，自动保存已暂停。请比较版本后选择处理。</span>
              <Button size="small" onClick={() => handleShowConflictReview()}>查看磁盘版本</Button>
              <Button size="small" onClick={handleExportConflictDraft}>下载本地草稿</Button>
              <Button size="small" danger disabled={!activeConflict.diskRevision} onClick={handleReloadDiskAfterConflict}>丢弃草稿并重载</Button>
            </div>
          )}
          <div className={`editor-statusbar${isMobile || editorFullscreen ? ' editor-statusbar-theme-slot' : ''}`} aria-label="文档状态栏">
            <div className="editor-theme-slot">{themeToggle}</div>
            <div className="editor-file-location" title={activeFile || '尚未选择文件'}>
              <FileOutlined aria-hidden="true" />
              <span>{activeFile ? activeFile.split('/').pop() : '选择文件开始编辑'}</span>
            </div>
            <div className="editor-status-actions">
              {activeLargeMarkdown && <span role="status">{activeLargeMarkdown.hasUnsavedDraft ? '只读预览；有未保存草稿' : '只读预览'}</span>}
              {activeLargeMarkdown?.hasUnsavedDraft && (
                <Button aria-label="下载本地草稿" size="small" onClick={() => handleExportConflictDraft(activeFile)}>下载草稿</Button>
              )}
              {activeFile && isMarkdownFile(activeFile) && !activeLargeMarkdown && <SaveStatus status={activeSaveStatus} errorMessage={saveErrors[activeFile]} onRetry={handleRetrySave} />}
              {activeFile && isMarkdownFile(activeFile) && !activeLargeMarkdown && (
                <Button aria-label="查看版本历史" size="small" icon={<HistoryOutlined />} onClick={() => handleOpenHistory(activeFile)}>历史</Button>
              )}
              {activeFile && isMarkdownFile(activeFile) && !activeLargeMarkdown && (
                <Button aria-label="保存当前文件" size="small" icon={<SaveOutlined />} onClick={handleSave} className="save-button">保存</Button>
              )}
              {activeLargeMarkdown && (
                <Button aria-label="下载 Markdown" size="small" icon={<ApiOutlined />} onClick={() => handleExport(activeFile)}>下载</Button>
              )}
              {attachmentViewer && (
                <Button aria-label="下载附件" size="small" icon={<ApiOutlined />} onClick={() => handleExport(attachmentViewer.path)}>下载</Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {!isMobile && !editorFullscreen && showOutline && isMarkdownFile(activeFile) && (
        <OutlinePanel
          items={visibleOutlineItems}
          fileName={activeFile.split('/').pop()}
          onSelect={goToOutlineItem}
          onClose={() => setShowOutline(false)}
        />
      )}

      {/* 新建 */}
      <Modal title={createModal.type === 'dir' ? '新建文件夹' : '新建文件'} open={createModal.open}
        onOk={handleCreate}
        onCancel={() => { setCreateModal({ open: false, parent: '', type: 'file' }); setCreateName('') }}
        okText="创建" cancelText="取消">
        <Input placeholder="名称" value={createName} onChange={e => setCreateName(e.target.value)} onPressEnter={handleCreate} autoFocus />
      </Modal>

      {/* 导入 */}
      <Modal title={currentImportResult ? '导入完成' : '导入文件（支持 .zip）'} open={importModal}
        onCancel={() => {
          setImportModal(false)
          setImportResult(null)
          setImportWarningDismissed(false)
        }}
        footer={null} okText="导入" cancelText="取消">
        <div className="import-modal-content">
          {currentImportResult && (
            <div className="import-completion">
              <p className="import-completion-count" role="status" aria-live="polite">已导入 {currentImportResult.imported} 个文件</p>
              {currentImportResult.cleanupWarnings.length > 0 && !importWarningDismissed && (
                <section className="import-cleanup-warning" role="region" aria-live="polite" aria-labelledby="import-cleanup-warning-title">
                  <div className="import-cleanup-warning-heading">
                    <WarningOutlined aria-hidden="true" />
                    <strong id="import-cleanup-warning-title">部分暂存内容已保留</strong>
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      aria-label="关闭清理提醒"
                      onClick={() => setImportWarningDismissed(true)}
                    />
                  </div>
                  <p>以下暂存内容无法安全清理，已为避免误删而保留：</p>
                  <ul className="import-cleanup-warning-paths">
                    {currentImportResult.cleanupWarnings.map((warningPath, index) => (
                      <li key={`${warningPath}-${index}`}><span>{warningPath}</span></li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
          {!currentImportResult && (
            <>
              <input
                ref={importInputRef}
                type="file"
                accept=".zip"
                id="import-zip-input"
                disabled={importLoading}
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = '' }}
              />
              <button type="button" disabled={importLoading}
                aria-describedby="import-file-guidance"
                className={`import-file-picker${importLoading ? ' is-loading' : ''}`}
                onClick={() => importInputRef.current?.click()}>
                <UploadOutlined aria-hidden="true" />
                {importLoading ? '正在导入…' : '点击选择 .zip 文件'}
              </button>
              <div className="import-file-guidance" id="import-file-guidance">
                仅允许导入 <b>.md</b> 和 <b>图片</b>（.jpg/.png/.gif/.webp/.bmp/.svg）文件。
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* 移动 */}
      <Modal title={`移动「${moveModal.node?.name}」到...`} open={moveModal.open}
        onCancel={() => { if (!moveBusy) setMoveModal({ open: false, node: null }) }}
        closable={!moveBusy}
        maskClosable={!moveBusy}
        footer={[
          <Button key="cancel" disabled={moveBusy} onClick={() => setMoveModal({ open: false, node: null })}>取消</Button>,
          <Button key="move" type="primary" loading={moveBusy} onClick={async () => {
            if (!moveModal.node || moveBusy) return
            setMoveBusy(true)
            try {
              if (await handleMove(moveModal.node, moveTarget)) setMoveModal({ open: false, node: null })
            } finally {
              setMoveBusy(false)
            }
          }}>移动</Button>,
        ]}>
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: 8, maxHeight: 260, overflow: 'auto' }}>
          <button type="button" className="move-root-target" aria-pressed={moveTarget === ''} onClick={() => setMoveTarget('')}>
            <FolderOpenOutlined style={{ color: 'var(--color-warning)', marginRight: 4 }} />根目录
          </button>
          <FileTree
            aria-label="移动目标文件夹"
            nodes={moveFolderTree}
            selectedKeys={moveTreeSelectedKeys}
            showActions={false}
            onSelect={moveTreeSelect}
          />
        </div>
      </Modal>

      {contextMenu.visible && contextMenu.node && (
        <ContextActionMenu
          x={contextMenu.x}
          y={contextMenu.y}
          label={`${contextMenu.node.name} 操作`}
          items={nodeContextItems}
          restoreFocusTo={contextMenu.restoreFocusTo}
          onClose={closeNodeContextMenu}
        />
      )}
      {tabMenu.visible && (
        <ContextActionMenu
          x={tabMenu.x}
          y={tabMenu.y}
          label="文档标签操作"
          items={tabContextItems}
          restoreFocusTo={tabMenu.restoreFocusTo}
          onClose={closeTabContextMenu}
        />
      )}
    </div>
  )
}
