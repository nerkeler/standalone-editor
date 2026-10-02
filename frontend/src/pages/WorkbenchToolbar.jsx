import { useState } from 'react'
import { Button, Dropdown, Tooltip } from 'antd'
import {
  AlignLeftOutlined,
  BoldOutlined,
  CheckSquareOutlined,
  CodeOutlined,
  CommentOutlined,
  DownOutlined,
  EditOutlined,
  ExpandOutlined,
  ItalicOutlined,
  LinkOutlined,
  MoreOutlined,
  OrderedListOutlined,
  ReadOutlined,
  ShrinkOutlined,
  StrikethroughOutlined,
  UnorderedListOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { TableInsertButton } from './TableControls'

const headingItems = [
  { key: 'paragraph', label: '正文' },
  { key: 'heading-1', label: '标题 1' },
  { key: 'heading-2', label: '标题 2' },
  { key: 'heading-3', label: '标题 3' },
  { key: 'heading-4', label: '标题 4' },
  { key: 'heading-5', label: '标题 5' },
  { key: 'heading-6', label: '标题 6' },
]

const mobileFormatItems = [
  { key: 'strike', label: '删除线', icon: <StrikethroughOutlined /> },
  { key: 'bullet-list', label: '无序列表', icon: <UnorderedListOutlined /> },
  { key: 'ordered-list', label: '有序列表', icon: <OrderedListOutlined /> },
  { key: 'task-list', label: '任务列表', icon: <CheckSquareOutlined /> },
  { type: 'divider' },
  { key: 'blockquote', label: '引用', icon: <CommentOutlined /> },
  { key: 'code-block', label: '代码块', icon: <CodeOutlined /> },
  { key: 'link', label: '插入链接', icon: <LinkOutlined /> },
  { key: 'image', label: '上传图片', icon: <UploadOutlined /> },
]

function toolbarButtonProps(active, color, { pressed = true } = {}) {
  return {
    'aria-pressed': pressed ? Boolean(active) : undefined,
    size: 'small',
    style: {
      fontWeight: 700,
      fontSize: 13,
      borderRadius: 6,
      height: 34,
      minWidth: 34,
      padding: '0 8px',
      background: active ? 'var(--color-surface-selected)' : 'transparent',
      color: active ? 'var(--color-primary)' : (color || 'var(--color-text)'),
      border: 'none',
      transition: 'all 0.15s',
    },
  }
}

export default function WorkbenchToolbar({
  editor,
  isMobile,
  showToolbar,
  onToggleToolbar,
  showSource,
  fileLoading,
  uploading,
  onToggleSource,
  onInsertLink,
  onUploadImage,
  onTableInsert,
  showOutline,
  onToggleOutline,
  editorFullscreen,
  onToggleFullscreen,
}) {
  const [headingMenuOpen, setHeadingMenuOpen] = useState(false)
  const [formatMenuOpen, setFormatMenuOpen] = useState(false)
  const activeHeading = [1, 2, 3, 4, 5, 6].find(level => editor?.isActive('heading', { level }))
  const activeHeadingLabel = activeHeading ? `标题 ${activeHeading}` : '正文'
  const buttonProps = (active, color, options) => toolbarButtonProps(active, color, options)

  const applyHeading = ({ key }) => {
    const chain = editor?.chain().focus()
    if (!chain) return
    if (key === 'paragraph') chain.setParagraph().run()
    else chain.toggleHeading({ level: Number(key.split('-')[1]) }).run()
  }

  const applyMobileFormat = ({ key }) => {
    const chain = editor?.chain().focus()
    if (key === 'strike') chain?.toggleStrike().run()
    if (key === 'bullet-list') chain?.toggleBulletList().run()
    if (key === 'ordered-list') chain?.toggleOrderedList().run()
    if (key === 'task-list') chain?.toggleTaskList().run()
    if (key === 'blockquote') chain?.toggleBlockquote().run()
    if (key === 'code-block') chain?.toggleCodeBlock().run()
    if (key === 'link') onInsertLink?.()
    if (key === 'image') onUploadImage?.()
  }

  if (isMobile) {
    if (!showToolbar) return null
    return (
      <div className="mobile-toolbar" role="toolbar" aria-label="移动端编辑工具栏">
        {!showSource && <>
          <Tooltip title="加粗"><Button aria-label="加粗" {...buttonProps(editor?.isActive('bold'))} onClick={() => editor?.chain().focus().toggleBold().run()} icon={<BoldOutlined />} /></Tooltip>
          <Tooltip title="斜体"><Button aria-label="斜体" {...buttonProps(editor?.isActive('italic'))} onClick={() => editor?.chain().focus().toggleItalic().run()} icon={<ItalicOutlined />} /></Tooltip>
          <Dropdown
            trigger={['click']}
            open={headingMenuOpen}
            onOpenChange={setHeadingMenuOpen}
            menu={{ items: headingItems, selectable: false, onClick: applyHeading }}
          >
            <Button className="heading-picker" aria-label={`当前段落样式：${activeHeadingLabel}`} aria-haspopup="menu" aria-expanded={headingMenuOpen} {...buttonProps(Boolean(activeHeading))}>
              <span>{activeHeadingLabel}</span><DownOutlined aria-hidden="true" />
            </Button>
          </Dropdown>
          <Dropdown
            trigger={['click']}
            open={formatMenuOpen}
            onOpenChange={setFormatMenuOpen}
            menu={{ items: mobileFormatItems, selectable: false, onClick: applyMobileFormat }}
          >
            <Button className="mobile-more-formats" aria-label="更多格式" aria-haspopup="menu" aria-expanded={formatMenuOpen} {...buttonProps(false, 'var(--color-text-secondary)', { pressed: false })} icon={<MoreOutlined />}>更多格式</Button>
          </Dropdown>
          <TableInsertButton editor={editor} buttonProps={buttonProps(false, undefined, { pressed: false })} onInsert={onTableInsert} />
        </>}
        {showSource && <Tooltip title="上传图片"><Button aria-label="上传图片" {...buttonProps(false, undefined, { pressed: false })} icon={<UploadOutlined />} loading={uploading} onClick={onUploadImage} /></Tooltip>}
        <span className="toolbar-spacer" />
        <Tooltip title={showSource ? '编辑' : '源码'}>
          <Button aria-label={showSource ? '切换到富文本编辑' : '切换到源码编辑'} aria-pressed={showSource} disabled={fileLoading} {...buttonProps(showSource, 'var(--color-text-secondary)')} onClick={onToggleSource} icon={showSource ? <EditOutlined /> : <CodeOutlined />}>
            <span className="mode-button-label">{showSource ? '编辑' : '源码'}</span>
          </Button>
        </Tooltip>
        <Tooltip title="隐藏工具栏"><Button aria-label="隐藏工具栏" {...buttonProps(false, 'var(--color-text-secondary)', { pressed: false })} onClick={onToggleToolbar} icon={<AlignLeftOutlined />} /></Tooltip>
      </div>
    )
  }

  if (!showToolbar) {
    return (
      <Button
        className="toolbar-restore-button"
        size="small"
        icon={<AlignLeftOutlined />}
        onClick={onToggleToolbar}
        title="显示工具栏"
        aria-label="显示工具栏"
      />
    )
  }

  return (
    <div className="editor-toolbar" role="toolbar" aria-label="编辑工具栏">
      {!showSource && <>
        <div className="toolbar-group toolbar-format-group">
          <Tooltip title="加粗 (⌘/Ctrl+B)"><Button aria-label="加粗" {...buttonProps(editor?.isActive('bold'))} onClick={() => editor?.chain().focus().toggleBold().run()} icon={<BoldOutlined />} /></Tooltip>
          <Tooltip title="斜体 (⌘/Ctrl+I)"><Button aria-label="斜体" {...buttonProps(editor?.isActive('italic'))} onClick={() => editor?.chain().focus().toggleItalic().run()} icon={<ItalicOutlined />} /></Tooltip>
          <Tooltip title="删除线"><Button aria-label="删除线" {...buttonProps(editor?.isActive('strike'))} onClick={() => editor?.chain().focus().toggleStrike().run()} icon={<StrikethroughOutlined />} /></Tooltip>
          <Dropdown
            trigger={['click']}
            open={headingMenuOpen}
            onOpenChange={setHeadingMenuOpen}
            menu={{ items: headingItems, selectable: false, onClick: applyHeading }}
          >
            <Button className="heading-picker" aria-label={`当前段落样式：${activeHeadingLabel}`} aria-haspopup="menu" aria-expanded={headingMenuOpen} {...buttonProps(Boolean(activeHeading), 'var(--color-text)')}>
              <span>{activeHeadingLabel}</span><DownOutlined aria-hidden="true" />
            </Button>
          </Dropdown>
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-group">
          <Tooltip title="无序列表"><Button aria-label="无序列表" {...buttonProps(editor?.isActive('bulletList'))} onClick={() => editor?.chain().focus().toggleBulletList().run()} icon={<UnorderedListOutlined />} /></Tooltip>
          <Tooltip title="有序列表"><Button aria-label="有序列表" {...buttonProps(editor?.isActive('orderedList'))} onClick={() => editor?.chain().focus().toggleOrderedList().run()} icon={<OrderedListOutlined />} /></Tooltip>
          <Tooltip title="任务列表"><Button aria-label="任务列表" {...buttonProps(editor?.isActive('taskList'))} onClick={() => editor?.chain().focus().toggleTaskList().run()} icon={<CheckSquareOutlined />} /></Tooltip>
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div className="toolbar-group">
          <Tooltip title="引用"><Button aria-label="引用" {...buttonProps(editor?.isActive('blockquote'))} onClick={() => editor?.chain().focus().toggleBlockquote().run()} icon={<CommentOutlined />} /></Tooltip>
          <Tooltip title="代码块"><Button aria-label="代码块" {...buttonProps(editor?.isActive('codeBlock'))} onClick={() => editor?.chain().focus().toggleCodeBlock().run()} icon={<CodeOutlined />} /></Tooltip>
          <Tooltip title="插入链接"><Button aria-label="插入链接" {...buttonProps(editor?.isActive('link'))} onClick={onInsertLink} icon={<LinkOutlined />} /></Tooltip>
          <TableInsertButton editor={editor} buttonProps={buttonProps(false, undefined, { pressed: false })} onInsert={onTableInsert} />
        </div>
      </>}
      <div className="toolbar-group">
        <Tooltip title="上传图片"><Button aria-label="上传图片" {...buttonProps(false, undefined, { pressed: false })} icon={<UploadOutlined />} loading={uploading} onClick={onUploadImage} /></Tooltip>
      </div>
      <span className="toolbar-spacer" />
      <div className="toolbar-group toolbar-view-group">
        <Tooltip title={showSource ? '编辑' : '源码'}>
          <Button aria-label={showSource ? '切换到富文本编辑' : '切换到源码编辑'} aria-pressed={showSource} disabled={fileLoading} {...buttonProps(showSource, 'var(--color-text-secondary)')} onClick={onToggleSource} icon={showSource ? <EditOutlined /> : <CodeOutlined />}>
            <span className="mode-button-label">{showSource ? '编辑' : '源码'}</span>
          </Button>
        </Tooltip>
        <Tooltip title={showOutline ? '隐藏右侧大纲' : '显示右侧大纲'}>
          <Button aria-label={showOutline ? '隐藏右侧大纲' : '显示右侧大纲'} aria-expanded={showOutline} {...buttonProps(showOutline, 'var(--color-text-secondary)', { pressed: false })} onClick={onToggleOutline} icon={<ReadOutlined />} />
        </Tooltip>
        <Tooltip title={editorFullscreen ? '退出专注模式' : '专注模式'}>
          <Button aria-label={editorFullscreen ? '退出专注模式' : '进入专注模式'} aria-pressed={editorFullscreen} {...buttonProps(editorFullscreen, 'var(--color-text-secondary)')} onClick={onToggleFullscreen} icon={editorFullscreen ? <ShrinkOutlined /> : <ExpandOutlined />} />
        </Tooltip>
        <Tooltip title="隐藏工具栏"><Button aria-label="隐藏工具栏" {...buttonProps(false, 'var(--color-text-secondary)', { pressed: false })} onClick={onToggleToolbar} icon={<AlignLeftOutlined />} /></Tooltip>
      </div>
    </div>
  )
}
