import test from 'node:test'
import assert from 'node:assert/strict'
import { marked } from 'marked'
import domino from '@mixmark-io/domino'
import { createMarkdownCodec } from '../src/pages/markdownCodec.js'
import { detectListStyle } from '../src/pages/listStyle.js'

// The codec reads list tightness from a `data-md-loose` attribute produced by
// markdownToHtml, which needs a DOM. Domino provides one for the round trip.
let collectionsPatched = false
function patchCollections(document) {
  if (collectionsPatched) return
  collectionsPatched = true
  const proto = Object.getPrototypeOf(document.body.children)
  if (!proto[Symbol.iterator]) {
    proto[Symbol.iterator] = function* iterator() { for (let i = 0; i < this.length; i += 1) yield this[i] }
    proto.forEach = function forEach(fn, thisArg) { for (let i = 0; i < this.length; i += 1) fn.call(thisArg, this[i], i, this) }
  }
}
function wrapDocument(document) {
  patchCollections(document)
  return new Proxy(document, {
    get(target, prop) {
      if (prop === 'querySelectorAll') return selector => Array.from(target.querySelectorAll(selector))
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
if (typeof globalThis.DOMParser === 'undefined') {
  globalThis.DOMParser = class DOMParser {
    parseFromString(html) {
      return wrapDocument(domino.createDocument(html))
    }
  }
}
if (typeof globalThis.NodeFilter === 'undefined') {
  globalThis.NodeFilter = { SHOW_ALL: 0xFFFFFFFF, SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_COMMENT: 128 }
}

const codec = createMarkdownCodec()

function roundTrip(markdown) {
  const style = detectListStyle(markdown)
  return codec.fromEditorHtml(codec.toEditorHtml(markdown), { listStyle: style })
}

test('list style detection accepts uniform indentation and rejects lossy shapes', () => {
  const cases = [
    ['- a\n  - b\n', { bulletWidth: 2, step: 2, safe: true }],
    ['- a\n    - b\n', { bulletWidth: 2, step: 4, safe: true }],
    ['-   a\n    -   b\n', { bulletWidth: 4, step: 4, safe: true }],
    ['- a\n   - b\n', { bulletWidth: 2, step: 3, safe: true }],
    ['> - a\n>   - b\n', { safe: false }],
    ['- a\n\t- b\n', { safe: false }],
    ['* a\n    - b\n', { safe: false }],
    ['- a\n  - ## heading\n', { safe: false }],
    ['- - a\n    - b\n', { safe: false }],
    ['- a\n    - b\n      - c\n', { safe: false }],
  ]
  for (const [source, expected] of cases) {
    const actual = detectListStyle(source)
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(actual[key], value, `${JSON.stringify(source)} ${key}`)
    }
  }
})

test('tight nested lists round trip exactly in the document style', () => {
  const cases = [
    '- a\n  - b\n  - c\n',
    '- a\n    - b\n',
    '- **逻辑**:\n  1. 趋势确认\n  2. 位置与节奏\n- **评分**:\n  - 多头排列\n',
    '-   a\n    -   b\n',
  ]
  for (const source of cases) {
    assert.equal(roundTrip(source), source.trimEnd(), JSON.stringify(source))
  }
})

test('loose nested lists keep their blank lines', () => {
  const cases = [
    '-   **模型**:\n\n    -   qwen2.5:3b\n\n    -   nomic-embed-text\n',
    '- a\n\n  - b\n\n  - c\n',
  ]
  for (const source of cases) {
    assert.equal(roundTrip(source), source.trimEnd(), JSON.stringify(source))
  }
})

test('tight and loose lists in one document keep their own spacing', () => {
  const source = '- a\n- b\n\nSeparate paragraph.\n\n- c\n\n- d\n'
  const saved = roundTrip(source)
  assert.equal(saved, source.trimEnd())
  assert.equal(marked.parse(saved), marked.parse(source))
})

test('mixed indentation stays source-protected instead of being rewritten', () => {
  const source = '- a\n  - b\n   - c\n'
  assert.equal(detectListStyle(source).safe, false)
  const saved = roundTrip(source)
  assert.notEqual(saved, source.trimEnd())
  assert.equal(marked.parse(saved), marked.parse(source))
})
