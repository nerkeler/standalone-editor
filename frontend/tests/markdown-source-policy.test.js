import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { getMarkdownSourceModeReasons, requiresSourceMode } from '../src/pages/markdownSourcePolicy.js'

const fixtureDirectory = new URL('./fixtures/', import.meta.url)
const richSafeFixture = await readFile(new URL('markdown-rich-safe.md', fixtureDirectory), 'utf8')
const sourceRequiredFixture = await readFile(new URL('markdown-source-required.md', fixtureDirectory), 'utf8')

test('rich-safe fixture uses only syntax supported by the editor conversion chain', () => {
  assert.deepEqual(getMarkdownSourceModeReasons(richSafeFixture), [])
  assert.equal(requiresSourceMode(richSafeFixture), false)
})

test('source-required fixture covers every lossy syntax category', () => {
  const reasons = getMarkdownSourceModeReasons(sourceRequiredFixture)
  for (const reason of [
    'frontMatter',
    'wikiLinks',
    'escapedSyntax',
    'referenceLinks',
    'footnotes',
    'tableAlignment',
    'nestedLists',
    'rawHtml',
    'codeFenceMetadata',
  ]) {
    assert.ok(reasons.includes(reason), 'expected source mode for ' + reason + '; got ' + reasons.join(', '))
  }
  assert.equal(requiresSourceMode(sourceRequiredFixture), true)
})

test('Markdown examples inside code and inline code do not trigger source mode', () => {
  const examples = [
    '```md\n[[wiki]]\n<details>\n```',
    '`[[inline wiki]] <tag> \\\\*literal\\\\*`',
  ].join('\n\n')
  assert.deepEqual(getMarkdownSourceModeReasons(examples), [])
})

test('the editor-owned zoom annotation remains allowed while other HTML comments are guarded', () => {
  const zoom = '![diagram](diagram.svg)<!-- zoom:125 -->'
  assert.deepEqual(getMarkdownSourceModeReasons(zoom), [])
  assert.ok(getMarkdownSourceModeReasons('<!-- retain me -->').includes('rawHtml'))
})

test('table alignment is identified from Marked table tokens', () => {
  const markdown = '| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |'
  assert.deepEqual(getMarkdownSourceModeReasons(markdown), ['tableAlignment'])
})

test('footnote definitions and references remain in source mode', () => {
  assert.ok(getMarkdownSourceModeReasons('A note[^one].\n\n[^one]: Footnote text.').includes('footnotes'))
})
