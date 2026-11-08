import test from 'node:test'
import assert from 'node:assert/strict'
import { marked } from 'marked'
import { createMarkdownCodec } from '../src/pages/markdownCodec.js'

// Symbol compatibility through the Markdown → HTML → Markdown chain. The
// serializer must keep ordinary punctuation literal instead of escaping it,
// while never changing how the document renders.
const codec = createMarkdownCodec()
const roundTrip = markdown => codec.fromEditorHtml(marked.parse(markdown))

const preserved = [
  ['intraword underscores', '| report_id | trade_date |\n| --- | --- |\n| factor_ic | 0.85 |\n'],
  ['underscored identifiers in prose', 'Set factor_ic_analysis and pos_ratio to 100%.\n'],
  ['spaced multiplication', '2 * 3 = 6 and 4 * 5 = 20\n'],
  ['lone asterisk between spaces', 'a * b * c\n'],
  ['square brackets without a link', 'array[0] and array[1]\n'],
  ['angle comparison text', 'a < b > c\n'],
  ['arrow text', 'a -> b <- c\n'],
  ['tilde range without a partner', '40~60% of the time\n'],
  ['dotted abbreviations', 'e.g. v1.2.3 and i.e. notes\n'],
  ['thematic break dashes', 'above\n\n---\n\nbelow\n'],
  ['table cell leading minus', '| A | B |\n| --- | --- |\n| -30 | +12 |\n'],
  ['literal plus inside a cell', '| A |\n| --- |\n| a<br>+ 200 units |\n'],
  ['math backslashes', 'ratio = \\frac{a}{b}\n'],
]

for (const [name, source] of preserved) {
  test(`symbol round trip keeps ${name}`, () => {
    const saved = roundTrip(source)
    assert.equal(saved.trimEnd(), source.trimEnd())
    assert.equal(marked.parse(saved), marked.parse(source))
  })
}

test('entity and tag-like text keeps its literal characters', () => {
  const source = 'a &lt;b&gt; c and &amp; d\n'
  const saved = roundTrip(source)
  assert.equal(saved.trimEnd(), 'a \\<b> c and & d')
  assert.equal(marked.parse(saved), marked.parse(source))
})

test('a hash that could start a heading stays escaped', () => {
  const source = '\\# not a heading\n'
  const saved = roundTrip(source)
  assert.equal(saved.trimEnd(), '\\# not a heading')
  assert.equal(marked.parse(saved), marked.parse(source))
})

test('an inert escape is dropped instead of kept', () => {
  const source = 'x \\# y\n'
  const saved = roundTrip(source)
  assert.equal(saved.trimEnd(), 'x # y')
  assert.equal(marked.parse(saved), marked.parse(source))
})

test('a single tilde stays a range separator instead of becoming strikethrough', () => {
  const saved = roundTrip('a ~b~ c and 60~120\n')
  assert.equal(saved.trimEnd(), 'a ~b~ c and 60~120')
  assert.equal(marked.parse(saved), marked.parse('a ~b~ c and 60~120\n'))
  assert.equal(roundTrip('a ~~b~~ c\n').trimEnd(), 'a ~~b~~ c')
})

test('every audited symbol case renders the same document after a round trip', () => {
  const cases = [
    'a * b', 'a_b', 'a*b*c', 'a _ b', '__x__', '[a](b)', '![a](b.png)',
    'a \\* b', 'a \\_ b', 'x | y', '`a|b`', 'a & b', 'a &amp; b',
    '1. x', '- x', '+ x', '> x', '# x', 'a  \nb', 'a\\\nb', 'x ^ y', 'x $ y',
    'x % y', 'x = y', 'x + y', 'x - y', 'x ! y', 'x ? y', 'x @ y', 'x : y',
    'x ; y', 'x , y', 'x . y', 'x ( y', 'x ) y', 'x { y', 'x } y', 'x ~ y',
  ]
  for (const source of cases) {
    const markdown = `${source}\n`
    const saved = roundTrip(markdown)
    assert.equal(
      marked.parse(saved),
      marked.parse(markdown),
      `round trip changed rendering for ${JSON.stringify(source)}: ${JSON.stringify(saved)}`,
    )
  }
})
