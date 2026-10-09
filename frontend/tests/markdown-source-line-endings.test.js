import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import {
  getUniformLineSeparator,
  normalizeLineEndings,
  serializeSourceDocument,
  sourceOffsetToDocumentOffset,
} from '../src/pages/markdownSourceLineEndings.js'

test('uniform LF and CRLF sources round-trip through CodeMirror text', () => {
  const crlf = '---\r\nkind: 示例\r\n---\r\n\r\n正文\r\n'
  const lf = crlf.replaceAll('\r\n', '\n')
  const crlfSeparator = getUniformLineSeparator(crlf)
  const lfSeparator = getUniformLineSeparator(lf)
  assert.equal(crlfSeparator, '\r\n')
  assert.equal(lfSeparator, '\n')

  const crlfState = EditorState.create({ doc: crlf, extensions: [EditorState.lineSeparator.of(crlfSeparator)] })
  const lfState = EditorState.create({ doc: lf, extensions: [EditorState.lineSeparator.of(lfSeparator)] })
  assert.equal(crlfState.doc.toString(), lf)
  assert.equal(serializeSourceDocument(crlfState.doc, crlfSeparator), crlf)
  assert.equal(serializeSourceDocument(lfState.doc, lfSeparator), lf)
  assert.equal(normalizeLineEndings('new\r\nline\n', crlfSeparator), 'new\r\nline\r\n')
})

test('raw source positions map to CodeMirror offsets across CRLF in uniform and mixed sources', () => {
  const crlf = 'a\r\n中\r\nb'
  const mixed = 'a\r\n中\nb'
  assert.equal(sourceOffsetToDocumentOffset(crlf, crlf.indexOf('中')), 2)
  assert.equal(sourceOffsetToDocumentOffset(crlf, crlf.indexOf('b')), 4)
  assert.equal(sourceOffsetToDocumentOffset(mixed, mixed.indexOf('b')), 4)
  assert.equal(sourceOffsetToDocumentOffset(crlf, crlf.indexOf('\n')), 1)
})

test('mixed line endings take the documented LF fallback instead of claiming byte preservation', () => {
  const mixed = 'first\r\nsecond\nthird\r\nfourth'
  assert.equal(getUniformLineSeparator(mixed), undefined)
  const state = EditorState.create({ doc: mixed })
  assert.equal(serializeSourceDocument(state.doc, undefined), 'first\nsecond\nthird\nfourth')
  assert.equal(normalizeLineEndings(mixed), 'first\nsecond\nthird\nfourth')
})
