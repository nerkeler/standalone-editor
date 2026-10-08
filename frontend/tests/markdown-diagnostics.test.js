import test from 'node:test'
import assert from 'node:assert/strict'
import { marked } from 'marked'
import Turndown from 'turndown'
import { analyzeMarkdownSource } from '../src/pages/markdownDiagnostics.js'
import { proposeSafeMarkdownRepair } from '../src/pages/safeMarkdownNormalization.js'

const cases = [
  ['frontMatter', '---\ntitle: A\n---\n'],
  ['wikiLinks', 'See [[home|Home]].\n'],
  ['footnotes', 'Text[^a]\n\n[^a]: Footnote\n'],
  ['referenceLinks', '[guide][docs]\n\n[docs]: https://example.com\n'],
  ['escapedSyntax', 'A \\* literal\n'],
  ['tableAlignment', '| A | B |\n| :--- | ---: |\n| a | b |\n'],
  ['nestedLists', '- parent\n  - child\n'],
  ['taskListCompatibility', '- ordinary item\n- [x] completed task\n'],
  ['taskListCompatibility', '1. [x] completed task\n2. [ ] pending task\n'],
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

test('loose ordinary unordered sublists stay rich-safe while lossy nesting stays protected', () => {
  const screenshotList = [
    '-   **模型**:',
    '',
    '    -   qwen2.5:3b (1.9 GB) – 本地 LLM',
    '        ',
    '    -   nomic-embed-text (274 MB) – Embedding 模型',
    '        ',
    '',
  ].join('\n')
  assert.deepEqual(analyzeMarkdownSource(screenshotList), [])
  assert.equal(proposeSafeMarkdownRepair(screenshotList), null)

  const tight = '- parent\n  - child\n'
  assert.ok(analyzeMarkdownSource(tight).some(item => item.reason === 'nestedLists'))

  for (const source of [
    '1. parent\n\n   1. child\n',
    '- [ ] parent\n\n  - [ ] child\n',
    '- parent\n\n  - child\n  - sibling\n',
    '> - parent\n>   - child\n',
    '- outer\n  > - quoted only\n',
    '- parent\n\n  - child\n    - grandchild\n',
  ]) {
    assert.ok(analyzeMarkdownSource(source).some(item => item.reason === 'nestedLists'), source)
  }
})

test('loose-list markers are matched inside their own top-level token after indented code', () => {
  const source = [
    '    - parent',
    '    - child',
    '',
    '- parent',
    '',
    '  - child',
    '',
    '  - sibling',
  ].join('\n')
  assert.deepEqual(analyzeMarkdownSource(source), [])
})

test('aligned tables underline their actual delimiter rows, while paragraph lookalikes stay clear', () => {
  for (const [source, expected] of [
    ['| Left | Right |\n| :-- | --: |\n| a | b |\n', '| :-- | --: |'],
    ['> | Left | Right |\n> | :-- | --: |\n> | a | b |\n', '> | :-- | --: |'],
  ]) {
    const diagnostic = analyzeMarkdownSource(source).find(item => item.reason === 'tableAlignment')
    assert.ok(diagnostic)
    assert.equal(source.slice(diagnostic.from, diagnostic.to), expected)
  }
  for (const source of [':--- | plain text\n', '> :--- | plain text\n']) {
    assert.ok(!analyzeMarkdownSource(source).some(item => item.reason === 'tableAlignment'))
  }

  const explicitlyLeftAligned = '| API | 路径 | 说明 |\n|:---|:---|:---|\n| A | /a | alpha |\n'
  assert.ok(!analyzeMarkdownSource(explicitlyLeftAligned).some(item => item.reason === 'tableAlignment'))
  const quotedLeftAligned = '> | API | 路径 | 说明 |\n> |:---|:---|:---|\n> | A | /a | alpha |\n'
  assert.ok(analyzeMarkdownSource(quotedLeftAligned).some(item => item.reason === 'tableAlignment'))
  const mixedAlignment = '| API | 路径 | 说明 |\n|:---|:---:|---:|\n| A | /a | alpha |\n'
  assert.ok(analyzeMarkdownSource(mixedAlignment).some(item => item.reason === 'tableAlignment'))
})

test('angle URL and email autolinks are reported as fixable Markdown, not raw HTML', () => {
  for (const source of ['See <https://example.com/a?x=1>.\n', 'Mail <ada@example.com>.\n']) {
    const diagnostics = analyzeMarkdownSource(source)
    assert.ok(diagnostics.some(item => item.reason === 'autolinks'))
    assert.ok(!diagnostics.some(item => item.reason === 'rawHtml'))
  }
})

test('ordinary links with angle destinations and titles are not confused with autolinks or HTML', () => {
  const source = '[x](<https://example.com> "title")\n'
  const diagnostics = analyzeMarkdownSource(source)
  assert.ok(!diagnostics.some(item => item.reason === 'autolinks'))
  assert.ok(!diagnostics.some(item => item.reason === 'rawHtml'))
  const title = diagnostics.find(item => item.reason === 'inlineLinkTitle')
  assert.ok(title)
  assert.equal(source.slice(title.from, title.to), '[x](<https://example.com> "title")')
  assert.equal(proposeSafeMarkdownRepair(source), null)
})

test('escaped decimal dots in ATX heading numbers stay rich-safe without hiding HTML warnings', () => {
  const source = '### 1\\. 第一阶段\n\n### 2\\. 第二阶段\n'
  assert.equal(marked.parse(source), marked.parse(source.replaceAll('\\.', '.')))
  assert.ok(!analyzeMarkdownSource(source).some(item => item.reason === 'escapedSyntax'))

  const underlined = '### 1\\. <u>第一阶段</u>\n'
  const diagnostics = analyzeMarkdownSource(underlined)
  assert.ok(!diagnostics.some(item => item.reason === 'escapedSyntax'))
  assert.ok(diagnostics.some(item => item.reason === 'rawHtml'))
})

test('intraword escaped underscores stay rich-safe in paragraphs, quotes, tables, and Unicode text', () => {
  const source = [
    'Paragraph: stock\\_report and 学习\\_笔记.',
    '',
    '> Quoted stock\\_report and 学习\\_笔记.',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| Report | stock\\_report |',
    '| 笔记 | 学习\\_笔记 |',
    '',
    '## 1\\. fitness-tracker',
  ].join('\n')
  assert.deepEqual(analyzeMarkdownSource(source), [])
  assert.equal(marked.parse(source), marked.parse(source.replaceAll('\\_', '_').replaceAll('\\.', '.')))
})

test('escaped delimiters and boundary underscores remain protected when their meaning can change', () => {
  for (const source of [
    'Keep \\*literal* markers.\n',
    'Keep \\[label](https://example.com).\n',
    '\\_open\\_\n',
    'word\\\\_report\n',
    'word\\\\\\_report\n',
    'stock\\_report and \\*literal*\n',
  ]) {
    assert.ok(analyzeMarkdownSource(source).some(item => item.reason === 'escapedSyntax'), source)
  }
  assert.deepEqual(analyzeMarkdownSource('`\\_inline_`\n\n```md\n\\_fenced_\n```\n'), [])
})

test('intraword underscores in image tokens stay protected independently of nearby plain text', () => {
  const source = [
    'Text stock\\_report and ![stock\\_report](assets/x.png), plus ![stock\\_report](https://example.com/x.png).',
    '> Quoted ![stock\\_report](assets/quoted.png) and stock\\_report.',
    '',
    '| Plain text | First image | Repeated image |',
    '| --- | --- | --- |',
    '| stock\\_report | ![stock\\_report](assets/x.png) | ![stock\\_report](assets/x.png) |',
    '',
    '> | Plain text | Image |',
    '> | --- | --- |',
    '> | stock\\_report | ![stock\\_report](assets/x.png) |',
    '`![stock\\_report](assets/code-example.png)`',
  ].join('\n')
  const matches = analyzeMarkdownSource(source).filter(item => item.reason === 'escapedSyntax')
  assert.equal(matches.length, 6)
  for (const match of matches) assert.equal(source.slice(match.from, match.to), '\\_')
})

test('repeated image tokens in repeated list items retain each image source offset', () => {
  for (const source of [
    '- ![a\\_b](x.png)\n- ![a\\_b](x.png)\n',
    '- Parent\n\n  - ![a\\_b](x.png)\n\n  - ![a\\_b](x.png)\n',
  ]) {
    const matches = analyzeMarkdownSource(source).filter(item => item.reason === 'escapedSyntax')
    assert.equal(matches.length, 2, source)
    for (const match of matches) assert.equal(source.slice(match.from, match.to), '\\_')
  }
})

test('multiline image tokens with stripped quote and list prefixes remain source-protected', () => {
  for (const source of [
    '> ![stock\\_report\n> second](assets/x.png)\n',
    '- ![stock\\_report\n  second](assets/x.png)\n',
    '> ![stock\\_report](\n> assets/x.png)\n',
  ]) {
    const matches = analyzeMarkdownSource(source).filter(item => item.reason === 'escapedSyntax')
    assert.equal(matches.length, 1, source)
    assert.equal(source.slice(matches[0].from, matches[0].to), '\\_')
  }
})

test('non-autolink angle text is not classified as raw HTML or an autolink', () => {
  for (const source of ['<x:b>\n', '<example.com>\n', '<a@b..com>\n']) {
    const diagnostics = analyzeMarkdownSource(source)
    assert.ok(!diagnostics.some(item => item.reason === 'autolinks'), source)
    assert.ok(!diagnostics.some(item => item.reason === 'rawHtml'), source)
  }
})

test('inline link titles are protected, while image titles remain supported', () => {
  const link = '[guide](https://example.com "important title")\n'
  const linkTitle = analyzeMarkdownSource(link).find(item => item.reason === 'inlineLinkTitle')
  assert.ok(linkTitle)
  assert.equal(link.slice(linkTitle.from, linkTitle.to), '[guide](https://example.com "important title")')

  const image = '![photo](assets/photo.png "photo title")\n'
  assert.ok(!analyzeMarkdownSource(image).some(item => item.reason === 'inlineLinkTitle'))
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
  const proposal = proposeSafeMarkdownRepair(source)
  assert.equal(proposal.content, '[guide](https://example.com)\n')
  assert.deepEqual(proposal.remainingDiagnostics, [])
  assert.deepEqual(proposeSafeMarkdownRepair(proposal.content), null)
})

test('multiple simple and multiline reference links produce one byte-preserving proposal', () => {
  const source = '[guide][docs] and [spec][api]\n\n[docs]: https://example.com\n[api]: https://example.org\n'
  const proposal = proposeSafeMarkdownRepair(source)
  assert.equal(proposal.content, '[guide](https://example.com) and [spec](https://example.org)\n')
  assert.equal(proposal.changes[0], '将 2 处引用式链接改为普通链接')
  assert.deepEqual(proposal.remainingDiagnostics, [])

  const multiline = '[link\n][ref]\n\n[ref]:\n  https://example.com\n'
  const multilineProposal = proposeSafeMarkdownRepair(multiline)
  assert.equal(multilineProposal.content, '[link\n](https://example.com)\n')
  assert.deepEqual(multilineProposal.remainingDiagnostics, [])
})

test('nested-label reference links are diagnosed and repaired only with equivalent Marked output', () => {
  const source = '[an [inner] label][docs]\n\n[docs]: https://example.com\n'
  const diagnostic = analyzeMarkdownSource(source).find(item => item.reason === 'referenceLinks')
  assert.ok(diagnostic)
  assert.equal(source.slice(diagnostic.from, diagnostic.to), '[an [inner] label][docs]')

  const proposal = proposeSafeMarkdownRepair(source)
  assert.equal(proposal?.content, '[an [inner] label](https://example.com)\n')
  assert.equal(marked.parse(proposal.content), marked.parse(source))
  assert.deepEqual(proposal.remainingDiagnostics, [])
  assert.equal(proposeSafeMarkdownRepair(proposal.content), null)
})

test('collapsed, shortcut, image and relative references repair only resolved safe forms', () => {
  const cases = [
    ['[guide][]\n\n[guide]: https://example.com\n', '[guide](https://example.com)\n'],
    ['[guide]\n\n[guide]: https://example.com\n', '[guide](https://example.com)\n'],
    ['![diagram][img]\n\n[img]: ../assets/diagram.png\n', '![diagram](../assets/diagram.png)\n'],
    ['[doc][id]\n\n[id]: ../docs/a.md\n', '[doc](../docs/a.md)\n'],
  ]
  for (const [source, expected] of cases) {
    const proposal = proposeSafeMarkdownRepair(source)
    assert.equal(proposal?.content, expected, source)
    assert.deepEqual(proposal.remainingDiagnostics, [])
  }
})

test('automatic URI and email links are proposed without changing rendered HTML', () => {
  const source = 'See <https://example.com/a?x=1>. Mail <ada@example.com>.\n'
  const proposal = proposeSafeMarkdownRepair(source)
  assert.equal(proposal.content, 'See [https://example.com/a?x=1](<https://example.com/a?x=1>). Mail [ada@example.com](mailto:ada@example.com).\n')
  assert.deepEqual(proposal.remainingDiagnostics, [])
  assert.equal(proposeSafeMarkdownRepair(proposal.content), null)
  assert.equal(proposeSafeMarkdownRepair('<ftp://example.com/file>\n'), null)
})

test('unsafe references and unused definitions keep their source bytes', () => {
  for (const source of [
    '[guide][docs]\n\n[docs]: https://example.com "title"\n',
    '[guide][docs]\n\n[docs]: https://example.com/path_(section)\n',
    '[docs]: https://example.com\n',
  ]) assert.equal(proposeSafeMarkdownRepair(source), null)

  const source = '[guide][docs]\n\n[docs]: https://example.com\n[unused]: https://unused.example/path\n'
  const proposal = proposeSafeMarkdownRepair(source)
  assert.equal(proposal.content, '[guide](https://example.com)\n\n[unused]: https://unused.example/path\n')
  assert.ok(proposal.remainingDiagnostics.some(item => item.reason === 'referenceLinks'))
})

test('safe repairs preserve unrelated YAML and report it as a remaining diagnostic', () => {
  const source = '---\na: b\n---\n[guide][docs]\n\n[docs]: https://example.com\n'
  const proposal = proposeSafeMarkdownRepair(source)
  assert.ok(proposal.content.startsWith('---\na: b\n---\n'))
  assert.equal(proposal.content.slice('---\na: b\n---\n'.length), '[guide](https://example.com)\n')
  assert.deepEqual(proposal.remainingDiagnostics.map(item => item.reason), ['frontMatter'])
})

test('dangling footnote-style text gets a stable escaped proposal; real definitions stay protected', () => {
  const source = 'Text[^missing]\n'
  const diagnostics = analyzeMarkdownSource(source)
  assert.ok(diagnostics.some(item => item.reason === 'literalFootnoteMarker'))
  assert.ok(!diagnostics.some(item => item.reason === 'footnotes'))
  const proposal = proposeSafeMarkdownRepair(source)
  assert.equal(proposal.content, 'Text\\[^missing\\]\n')
  assert.deepEqual(proposal.remainingDiagnostics, [])
  assert.equal(marked.parse(source), marked.parse(proposal.content))
  const turndown = new Turndown()
  assert.equal(turndown.turndown(marked.parse(proposal.content)), proposal.content.trimEnd())
  assert.equal(proposeSafeMarkdownRepair(proposal.content), null)

  const paired = 'Text[^note]\n\n[^note]: Footnote text.\n'
  assert.ok(analyzeMarkdownSource(paired).some(item => item.reason === 'footnotes'))
  assert.equal(proposeSafeMarkdownRepair(paired), null)
})
