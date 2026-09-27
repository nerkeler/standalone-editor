import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeMarkdownSource } from '../src/pages/markdownDiagnostics.js'
import { normalizeSafeMarkdown } from '../src/pages/safeMarkdownNormalization.js'

const cases = [
  ['frontMatter', '---\ntitle: A\n---\n'],
  ['wikiLinks', 'See [[home|Home]].\n'],
  ['footnotes', 'Text[^a]\n\n[^a]: Footnote\n'],
  ['referenceLinks', '[guide][docs]\n\n[docs]: https://example.com\n'],
  ['escapedSyntax', 'A \\* literal\n'],
  ['tableAlignment', '| A | B |\n| :--- | ---: |\n| a | b |\n'],
  ['nestedLists', '- parent\n  - child\n'],
  ['rawHtml', '<details>text</details>\n'],
  ['codeFenceMetadata', '```js title="a.js"\ncode\n```\n'],
]

for (const [reason, source] of cases) {
  test(`${reason} points at its actual source span`, () => {
    const matches = analyzeMarkdownSource(source).filter(item => item.reason === reason)
    assert.ok(matches.length, source)
    for (const match of matches) {
      assert.ok(source.slice(match.from, match.to).trim())
      assert.ok(match.message.includes('源码'))
    }
  })
}

test('code examples do not get compatibility warnings', () => {
  assert.deepEqual(analyzeMarkdownSource('```md\n[[a]]\\*\n```\n`[[b]]`\n'), [])
})

test('blockquote diagnostics underline the original nested-list, table, and fence metadata text', () => {
  const cases = [
    ['nestedLists', '> - parent\n>   - child\n', '- child'],
    ['tableAlignment', '> | Left | Right |\n> | :-- | --: |\n> | a | b |\n', '> | :-- | --: |'],
    ['codeFenceMetadata', '> ```js title=sample.js\n> code\n> ```\n', 'js title=sample.js'],
    ['nestedLists', '> > - parent\n> >   - child\n', '- child'],
  ]
  for (const [reason, source, excerpt] of cases) {
    const diagnostic = analyzeMarkdownSource(source).find(item => item.reason === reason)
    assert.ok(diagnostic, reason + ': ' + source)
    assert.ok(source.slice(diagnostic.from, diagnostic.to).includes(excerpt), reason)
  }
})

test('Marked fallback protects quote structures nested under list indentation', () => {
  const source = [
    '- outer',
    '    > - parent',
    '    >   - child',
    '    > | Left | Right |',
    '    > | :-- | --: |',
    '    > | a | b |',
    '    > ```js title=deep.js',
    '    > code',
    '    > ```',
    '',
  ].join('\n')
  const diagnostics = analyzeMarkdownSource(source)
  for (const [reason, excerpt] of [
    ['nestedLists', '>   - child'],
    ['tableAlignment', '> | :-- | --: |'],
    ['codeFenceMetadata', 'title=deep.js'],
  ]) {
    const diagnostic = diagnostics.find(item => item.reason === reason)
    assert.ok(diagnostic, reason)
    assert.ok(source.slice(diagnostic.from, diagnostic.to).includes(excerpt), reason)
  }
})

test('multiline reference links and definitions receive source diagnostics', () => {
  const cases = [
    ['[link\n][ref]\n\n[ref]:\n  https://example.com\n', '[link\n][ref]'],
    ['[ref]:\n  https://example.com\n', '[ref]:\n  https://example.com'],
    ['[ref]:\n  https://example.com\n  "Reference title"\n', '"Reference title"'],
  ]
  for (const [source, excerpt] of cases) {
    const diagnostic = analyzeMarkdownSource(source).find(item => item.reason === 'referenceLinks')
    assert.ok(diagnostic, source)
    assert.ok(source.slice(diagnostic.from, diagnostic.to).includes(excerpt))
  }
})

test('multiline void HTML tags receive source diagnostics', () => {
  for (const [source, excerpt] of [
    ['<img\n  src="photo.png"\n  alt="photo"\n  data-custom="keep">\n', 'data-custom="keep"'],
    ['<hr\n  data-custom="keep">\n', '<hr\n  data-custom="keep">'],
  ]) {
    const diagnostic = analyzeMarkdownSource(source).find(item => item.reason === 'rawHtml')
    assert.ok(diagnostic, source)
    assert.ok(source.slice(diagnostic.from, diagnostic.to).includes(excerpt))
  }
})

test('multiline references and raw HTML inside code remain unmarked', () => {
  for (const source of [
    '~~~~md\n<img\n  src="photo.png"\n  data-custom="keep">\n[link\n][ref]\n[ref]:\n  https://example.com\n~~~~\n',
    '`<img\n  src="photo.png"\n  data-custom="keep">`\n',
    '`[link\n][ref]`\n',
  ]) assert.deepEqual(analyzeMarkdownSource(source), [])
})

test('quote fences and ordinary fences keep Markdown examples source-safe', () => {
  for (const source of [
    '> ~~~~md\n> - parent\n>   - child\n> | A | B |\n> | :-- | --: |\n> ```js title=sample.js\n> [[wiki]]\n> ~~~~\n',
    '> > ~~~~md\n> > - parent\n> >   - child\n> > | A | B |\n> > | :-- | --: |\n> > ```js title=sample.js\n> > [[wiki]]\n> > ~~~~\n',
    '~~~~md\n> - parent\n>   - child\n> | A | B |\n> | :-- | --: |\n> ```js title=sample.js\n~~~~\n',
  ]) assert.deepEqual(analyzeMarkdownSource(source), [])
})

test('closing a quote fence keeps following Markdown diagnostics visible', () => {
  const source = '> ```md\n> code\n> ```\nOutside [[wiki]]\n'
  const diagnostic = analyzeMarkdownSource(source).find(item => item.reason === 'wikiLinks')
  assert.ok(diagnostic)
  assert.ok(source.slice(diagnostic.from, diagnostic.to).includes('[[wiki]]'))
})

test('editor-owned image presentation comment remains rich-safe', () => {
  assert.deepEqual(analyzeMarkdownSource('![a](assets/a.png)<!-- se-image:width=50;align=center -->'), [])
})

test('a single simple reference link normalizes once without changing rendered HTML', () => {
  const source = '[guide][docs]\n\n[docs]: https://example.com\n'
  const fixed = normalizeSafeMarkdown(source)
  assert.equal(fixed, '[guide](https://example.com)\n')
  assert.equal(normalizeSafeMarkdown(fixed), null)
})

test('mixed, titled and unsupported source remains byte-for-byte unchanged', () => {
  for (const source of [
    '---\na: b\n---\n[guide][docs]\n\n[docs]: https://example.com\n',
    '[guide][docs]\n\n[docs]: https://example.com "title"\n',
    'Hello [guide][docs]\n\n[docs]: https://example.com\n',
  ]) assert.equal(normalizeSafeMarkdown(source), null)
})
