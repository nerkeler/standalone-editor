import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { redo as redoHistoryCommand, redoDepth, undo as undoHistoryCommand, undoDepth } from '@codemirror/commands'
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { linter, lintKeymap, nextDiagnostic } from '@codemirror/lint'
import { analyzeMarkdownSource } from './markdownDiagnostics'

const externalValueSync = Annotation.define()
const platformDescription = typeof navigator === 'undefined' ? '' : `${navigator.platform || ''} ${navigator.userAgent || ''}`
const isApplePlatform = /Mac|iPhone|iPad|iPod/i.test(platformDescription)
const isWindowsPlatform = /Win/i.test(platformDescription)

const sourceTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--color-bg-card)', color: 'var(--color-text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  '.cm-content': { maxWidth: '900px', margin: '0 auto', padding: '22px 32px', lineHeight: '1.8', fontSize: '14px', caretColor: 'var(--color-text)' },
  '.cm-focused': { outline: 'none' },
  '.cm-gutters': { backgroundColor: 'var(--color-bg-card)', border: 'none', color: 'var(--color-text-secondary)' },
  '.cm-line': { padding: '0' },
  '.cm-protected-range': { textDecoration: 'underline wavy var(--color-warning)', textUnderlineOffset: '3px', textDecorationThickness: '1px' },
  '.cm-tooltip-lint': { backgroundColor: 'var(--color-bg-card)', color: 'var(--color-text)', borderColor: 'var(--color-border)' },
})

const sourceHighlight = HighlightStyle.define([
  { tag: [tags.link, tags.url], color: 'var(--color-primary)', textDecoration: 'underline' },
  { tag: [tags.heading, tags.strong], color: 'var(--color-text)', fontWeight: '600' },
  { tag: tags.emphasis, color: 'var(--color-text)' },
  { tag: [tags.comment, tags.meta], color: 'var(--color-text-secondary)' },
])

const MarkdownSourceEditor = forwardRef(function MarkdownSourceEditor({
  value,
  onChange,
  onHistoryChange,
  onCompositionChange,
  editable = true,
}, ref) {
  const host = useRef(null)
  const viewRef = useRef(null)
  const onChangeRef = useRef(onChange)
  const onHistoryChangeRef = useRef(onHistoryChange)
  const onCompositionChangeRef = useRef(onCompositionChange)
  const editableRef = useRef(editable)
  const editableCompartment = useRef(new Compartment())
  const revertingRef = useRef(false)
  onChangeRef.current = onChange
  onHistoryChangeRef.current = onHistoryChange
  onCompositionChangeRef.current = onCompositionChange
  editableRef.current = editable

  const reportHistoryDepths = view => onHistoryChangeRef.current?.({
    undo: undoDepth(view.state),
    redo: redoDepth(view.state),
  })

  useImperativeHandle(ref, () => ({
    nextProtected() { if (viewRef.current) nextDiagnostic(viewRef.current) },
    focus() { viewRef.current?.focus() },
    undo() {
      const view = viewRef.current
      if (!view || view.composing || view.state.readOnly || undoDepth(view.state) === 0) return false
      const changed = undoHistoryCommand(view)
      if (changed) view.focus()
      return changed
    },
    redo() {
      const view = viewRef.current
      if (!view || view.composing || view.state.readOnly || redoDepth(view.state) === 0) return false
      const changed = redoHistoryCommand(view)
      if (changed) view.focus()
      return changed
    },
    goToPosition(position) {
      const view = viewRef.current
      if (!view || !Number.isInteger(position)) return false
      view.dispatch({ selection: { anchor: Math.max(0, Math.min(position, view.state.doc.length)) }, scrollIntoView: true })
      view.focus()
      return true
    },
    insertMarkdownImage(markdownSrc) {
      const view = viewRef.current
      if (!view || !markdownSrc) return false
      const { from, to } = view.state.selection.main
      const image = `![](${markdownSrc})`
      const original = view.state.doc.toString()
      const expected = original.slice(0, from) + image + original.slice(to)
      view.dispatch({ changes: { from, to, insert: image }, selection: { anchor: from + image.length }, scrollIntoView: true })
      if (view.state.doc.toString() !== expected) return false
      view.focus()
      return true
    },
  }), [])

  useEffect(() => {
    if (!host.current) return undefined
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          editableCompartment.current.of([
            EditorState.readOnly.of(!editableRef.current),
            EditorView.editable.of(editableRef.current),
          ]),
          markdown(),
          syntaxHighlighting(sourceHighlight),
          sourceTheme,
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源文本' }),
          keymap.of([
            ...lintKeymap,
            ...(isApplePlatform ? [{
              key: 'Ctrl-y',
              run: view => !view.composing && redoHistoryCommand(view),
            }] : []),
            ...(isWindowsPlatform ? [{
              key: 'Ctrl-Shift-z',
              run: view => !view.composing && redoHistoryCommand(view),
            }] : []),
          ]),
          EditorView.domEventHandlers({
            compositionstart() {
              onCompositionChangeRef.current?.(true)
              return false
            },
            compositionend() {
              onCompositionChangeRef.current?.(false)
              return false
            },
          }),
          linter(editor => analyzeMarkdownSource(editor.state.doc.toString()).map(item => ({
            from: item.from,
            to: item.to,
            severity: 'info',
            message: item.message,
            markClass: 'cm-protected-range',
          })), { delay: 250 }),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !revertingRef.current) {
              const externalChange = update.transactions.every(transaction => (
                !transaction.docChanged || transaction.annotation(externalValueSync)
              ))
              if (!externalChange && onChangeRef.current?.(update.state.doc.toString()) === false) {
                revertingRef.current = true
                update.view.dispatch({
                  changes: { from: 0, to: update.state.doc.length, insert: update.startState.doc.toString() },
                  annotations: [externalValueSync.of(true), Transaction.addToHistory.of(false)],
                })
                revertingRef.current = false
              }
            }
            reportHistoryDepths(update.view)
          }),
        ],
      }),
    })
    viewRef.current = view
    reportHistoryDepths(view)
    return () => {
      onCompositionChangeRef.current?.(false)
      view.destroy()
      viewRef.current = null
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: editableCompartment.current.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    })
  }, [editable])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: [externalValueSync.of(true), Transaction.addToHistory.of(false)],
    })
  }, [value])

  return <div ref={host} className="source-editor" role="region" aria-label="Markdown 源码编辑器" />
})

export default MarkdownSourceEditor
