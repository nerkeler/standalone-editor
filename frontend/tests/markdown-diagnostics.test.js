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
