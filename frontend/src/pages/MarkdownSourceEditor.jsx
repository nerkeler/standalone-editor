import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { linter, lintKeymap, nextDiagnostic } from '@codemirror/lint'
import { analyzeMarkdownSource } from './markdownDiagnostics'

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

const MarkdownSourceEditor = forwardRef(function MarkdownSourceEditor({ value, onChange }, ref) {
  const host = useRef(null)
  const viewRef = useRef(null)
  const onChangeRef = useRef(onChange)
  const revertingRef = useRef(false)
  onChangeRef.current = onChange

  useImperativeHandle(ref, () => ({
    nextProtected() { if (viewRef.current) nextDiagnostic(viewRef.current) },
    focus() { viewRef.current?.focus() },
  }), [])

  useEffect(() => {
    if (!host.current) return undefined
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          markdown(),
          syntaxHighlighting(sourceHighlight),
          sourceTheme,
          EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源文本' }),
          keymap.of(lintKeymap),
          linter(editor => analyzeMarkdownSource(editor.state.doc.toString()).map(item => ({
            from: item.from,
            to: item.to,
            severity: 'info',
            message: item.message,
            markClass: 'cm-protected-range',
          })), { delay: 250 }),
          EditorView.updateListener.of(update => {
            if (!update.docChanged || revertingRef.current) return
            if (onChangeRef.current?.(update.state.doc.toString()) === false) {
              revertingRef.current = true
              update.view.dispatch({ changes: { from: 0, to: update.state.doc.length, insert: update.startState.doc.toString() } })
              revertingRef.current = false
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} className="source-editor" role="region" aria-label="Markdown 源码编辑器" />
})

export default MarkdownSourceEditor
