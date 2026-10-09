import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { marked } from 'marked'
import { isAllowedUri } from '@tiptap/extension-link'
import { analyzeMarkdownSource } from '../src/pages/markdownDiagnostics.js'
import { getMarkdownSourceModeReasons, requiresSourceMode } from '../src/pages/markdownSourcePolicy.js'

const fixtureDirectory = new URL('./fixtures/', import.meta.url)
const richSafeFixture = await readFile(new URL('markdown-rich-safe.md', fixtureDirectory), 'utf8')
const sourceRequiredFixture = await readFile(new URL('markdown-source-required.md', fixtureDirectory), 'utf8')

test('rich-safe fixture uses only syntax supported by the editor conversion chain', () => {
  assert.deepEqual(getMarkdownSourceModeReasons(richSafeFixture), [])
  assert.equal(requiresSourceMode(richSafeFixture), false)
})

test('the installed TipTap URI policy keeps supported destinations rich-safe and protects rejected schemes', () => {
  const supported = [
    'https://example.com/docs',
    '../notes/linked-note.md',
    'mailto:person@example.com',
  ]
  for (const href of supported) {
    assert.ok(isAllowedUri(href), `TipTap should allow ${href}`)
    assert.deepEqual(analyzeMarkdownSource(`[link](${href})\n`), [])
    assert.equal(requiresSourceMode(`[link](${href})\n`), false)
  }

  for (const href of [
    'file:///private/tmp/synthetic-note.md',
    'obsidian://open?vault=Demo&file=Note',
    'unknown-note://open/target',
    'javascript:window.__n01Executed=true',
  ]) {
    assert.equal(Boolean(isAllowedUri(href)), false, `TipTap should reject ${href}`)
    const markdown = `[link](${href})\n`
    assert.equal(requiresSourceMode(markdown), true, `${href} must remain in source mode`)
    const diagnostic = analyzeMarkdownSource(markdown).find(item => item.reason === 'unsupportedLinkUri')
    assert.ok(diagnostic, href)
    assert.equal(markdown.slice(diagnostic.from, diagnostic.to), markdown.trimEnd())
  }
})

test('mixed and ordered task lists stay in source mode while homogeneous unordered tasks remain rich-safe', () => {
  const unsupported = [
    '- ordinary item\n- [x] completed task\n- [ ] pending task\n',
    '1. [x] completed task\n2. [ ] pending task\n',
    '> - ordinary item\n> - [x] completed task\n',
    '> 1. [x] completed task\n> 2. [ ] pending task\n',
  ]
  for (const source of unsupported) {
    const diagnostics = analyzeMarkdownSource(source).filter(item => item.reason === 'taskListCompatibility')
    assert.equal(diagnostics.length, 1)
    assert.equal(source.slice(diagnostics[0].from, diagnostics[0].to), source)
    assert.ok(getMarkdownSourceModeReasons(source).includes('taskListCompatibility'))
    assert.equal(requiresSourceMode(source), true)
  }

  const supported = [
    '- [ ] pending task\n- [x] completed task\n',
    '- ordinary item\n\nSpacer paragraph.\n\n- [x] completed task\n- [ ] pending task\n',
  ]
  for (const source of supported) {
    assert.ok(!getMarkdownSourceModeReasons(source).includes('taskListCompatibility'), source)
    assert.equal(requiresSourceMode(source), false)
  }
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
  const markdown = '> | Left | Right |\n> | :-- | --: |\n> | a | b |'
  const quote = marked.lexer(markdown).find(token => token.type === 'blockquote')
  const table = quote?.tokens?.find(token => token.type === 'table')
  assert.deepEqual(table?.align, ['left', 'right'])
  assert.deepEqual(getMarkdownSourceModeReasons(markdown), ['tableAlignment'])

  const allLeft = '| API | Path | Note |\n|:---|:---|:---|\n| A | /a | alpha |'
  assert.deepEqual(marked.lexer(allLeft).find(token => token.type === 'table')?.align, ['left', 'left', 'left'])
  assert.deepEqual(getMarkdownSourceModeReasons(allLeft), [])
})

test('quoted lossy structures and conservative nested-list fallback require source mode', () => {
  const cases = [
    ['nestedLists', '> - parent\n>   - child\n'],
    ['tableAlignment', '> | Left | Right |\n> | :-- | --: |\n> | a | b |\n'],
    ['codeFenceMetadata', '> ```js title=sample.js\n> code\n> ```\n'],
    ['nestedLists', '> > - parent\n> >   - child\n'],
    // This token tree is list → blockquote → list. Protecting it also guards
    // list indentation when the source is serialized through rich text.
    ['nestedLists', '- outer\n  > - quoted only\n'],
  ]
  for (const [reason, markdown] of cases) {
    const reasons = getMarkdownSourceModeReasons(markdown)
    assert.ok(reasons.includes(reason), 'expected ' + reason + '; got ' + reasons.join(', '))
    assert.equal(requiresSourceMode(markdown), analyzeMarkdownSource(markdown).length > 0)
  }
})

test('plain blockquote structures and Markdown examples inside quote fences stay rich-safe', () => {
  const safe = [
    '> - first\n> - second\n',
    '> | Left | Right |\n> | --- | --- |\n> | a | b |\n',
    '> ```js\n> code\n> ```\n',
    '> ~~~~md\n> - parent\n>   - child\n> | A | B |\n> | :-- | --: |\n> ```js title=sample.js\n> [[wiki]]\n> ~~~~\n',
  ]
  for (const markdown of safe) {
    assert.deepEqual(getMarkdownSourceModeReasons(markdown), [])
    assert.equal(requiresSourceMode(markdown), false)
  }
})

test('multiline reference forms and void HTML require source mode', () => {
  const cases = [
    ['referenceLinks', '[link\n][ref]\n\n[ref]:\n  https://example.com\n'],
    ['referenceLinks', '[ref]:\n  https://example.com\n'],
    ['rawHtml', '<img\n  src="photo.png"\n  alt="photo"\n  data-custom="keep">\n'],
    ['rawHtml', '<hr\n  data-custom="keep">\n'],
  ]
  for (const [reason, markdown] of cases) {
    const reasons = getMarkdownSourceModeReasons(markdown)
    assert.ok(reasons.includes(reason), 'expected ' + reason + '; got ' + reasons.join(', '))
    assert.equal(requiresSourceMode(markdown), analyzeMarkdownSource(markdown).length > 0)
  }
})

test('multiline references and void HTML inside inline or fenced code stay rich-safe', () => {
  const examples = [
    '~~~~md\n<img\n  src="photo.png"\n  data-custom="keep">\n[link\n][ref]\n[ref]:\n  https://example.com\n~~~~\n',
    '`<img\n  src="photo.png"\n  data-custom="keep">`\n',
    '`[link\n][ref]`\n',
  ]
  for (const markdown of examples) {
    assert.deepEqual(getMarkdownSourceModeReasons(markdown), [])
    assert.equal(requiresSourceMode(markdown), false)
  }
})

test('footnote definitions and references remain in source mode', () => {
  assert.ok(getMarkdownSourceModeReasons('A note[^one].\n\n[^one]: Footnote text.').includes('footnotes'))
})
