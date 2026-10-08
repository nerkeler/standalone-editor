import { useCallback, useRef, useState } from 'react'
import { redoDepth, undoDepth } from '@tiptap/pm/history'
import { EditorState } from '@tiptap/pm/state'
import { isMarkdownFile } from './useEditorDrafts'

export default function useDocumentHistory({
  activeFile,
  activeFileRef,
  editor,
  fileLoading,
  loadingRef,
  markdownRepairOperationRef,
  markdownRepairSaving,
  readOnlyMarkdownRef,
  renderedFileRef,
  saveBlockedRef,
  showSource,
  showSourceRef,
}) {
  const [sourceHistoryGeneration, setSourceHistoryGeneration] = useState(0)
  const [sourceHistoryDepths, setSourceHistoryDepths] = useState({ undo: 0, redo: 0 })
  const [historyComposition, setHistoryComposition] = useState(false)
  const sourceHistoryGenerationRef = useRef(0)
  const sourceEditorRef = useRef(null)

  const resetSession = useCallback(() => {
    const nextGeneration = sourceHistoryGenerationRef.current + 1
    sourceHistoryGenerationRef.current = nextGeneration
    setSourceHistoryGeneration(nextGeneration)
    setSourceHistoryDepths({ undo: 0, redo: 0 })
  }, [])

  const resetRichSession = useCallback(currentEditor => {
    const { schema, doc, plugins } = currentEditor.state
    currentEditor.view.updateState(EditorState.create({ schema, doc, plugins }))
  }, [])

  const historyDocumentReady = Boolean(
    activeFile && isMarkdownFile(activeFile) && !fileLoading && !loadingRef.current &&
    renderedFileRef.current === activeFile && !readOnlyMarkdownRef.current &&
    !saveBlockedRef.current.has(activeFile) && !markdownRepairSaving && !historyComposition
  )
  const undoDisabled = !historyDocumentReady || (showSource
    ? !sourceEditorRef.current || sourceHistoryDepths.undo === 0
    : !editor || undoDepth(editor.state) === 0)
  const redoDisabled = !historyDocumentReady || (showSource
    ? !sourceEditorRef.current || sourceHistoryDepths.redo === 0
    : !editor || redoDepth(editor.state) === 0)

  const runHistoryCommand = useCallback(direction => {
    if (
      !activeFileRef.current || !isMarkdownFile(activeFileRef.current) ||
      loadingRef.current || readOnlyMarkdownRef.current ||
      saveBlockedRef.current.has(activeFileRef.current) || markdownRepairOperationRef.current ||
      historyComposition
    ) return false
    if (showSourceRef.current) return sourceEditorRef.current?.[direction]() || false
    const currentEditor = editor
    if (!currentEditor || currentEditor.isDestroyed || currentEditor.view.composing) return false
    const depth = direction === 'undo' ? undoDepth(currentEditor.state) : redoDepth(currentEditor.state)
    if (depth === 0) return false
    return currentEditor.chain().focus()[direction]().run()
  }, [activeFileRef, editor, historyComposition, loadingRef, markdownRepairOperationRef, readOnlyMarkdownRef, saveBlockedRef, showSourceRef])

  return {
    historyComposition,
    historyDocumentReady,
    onCompositionChange: setHistoryComposition,
    onSourceHistoryChange: setSourceHistoryDepths,
    redoDisabled,
    resetRichSession,
    resetSession,
    runHistoryCommand,
    sourceEditorRef,
    sourceHistoryDepths,
    sourceHistoryGeneration,
    undoDisabled,
  }
}
