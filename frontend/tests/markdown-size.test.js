import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_EDITABLE_MARKDOWN_BYTES, isEditableMarkdownSize, utf8ByteLength } from '../src/markdownSize.js'

test('editable Markdown limit measures UTF-8 bytes at the inclusive boundary', () => {
  const exact = 'x'.repeat(MAX_EDITABLE_MARKDOWN_BYTES)
  assert.equal(utf8ByteLength(exact), MAX_EDITABLE_MARKDOWN_BYTES)
  assert.equal(isEditableMarkdownSize(exact), true)
  assert.equal(isEditableMarkdownSize(`${exact}x`), false)
})

test('multibyte Markdown is limited by encoded bytes rather than JavaScript characters', () => {
  const emoji = '😀'
  const under = emoji.repeat(Math.floor(MAX_EDITABLE_MARKDOWN_BYTES / 4))
  assert.ok(under.length < MAX_EDITABLE_MARKDOWN_BYTES)
  assert.equal(utf8ByteLength(under), Math.floor(MAX_EDITABLE_MARKDOWN_BYTES / 4) * 4)
  assert.equal(isEditableMarkdownSize(`${under}${'x'.repeat(MAX_EDITABLE_MARKDOWN_BYTES - utf8ByteLength(under))}`), true)
  assert.equal(isEditableMarkdownSize(`${under}${'x'.repeat(MAX_EDITABLE_MARKDOWN_BYTES - utf8ByteLength(under) + 1)}`), false)
})
