import { markdownLanguage } from '@codemirror/lang-markdown'
import { marked } from 'marked'

function inlineText(tokens) {
  return tokens.map(token => {
    if (token.type === 'html') return ''
    if (token.tokens) return inlineText(token.tokens)
    return token.text || ''
  }).join('')
}

export function getMarkdownSourceOutline(source) {
  const text = String(source || '')
  const items = []
  const frontMatterEnd = text.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)?.[0].length || 0
  markdownLanguage.parser.parse(text).iterate({
    enter(node) {
      if (node.from < frontMatterEnd) return
      const atx = /^ATXHeading([1-6])$/.exec(node.name)
      const setext = /^SetextHeading([1-2])$/.exec(node.name)
      if (!atx && !setext) return
      const raw = text.slice(node.from, node.to)
      const heading = atx
        ? raw.replace(/^#{1,6}(?:[ \t]+|$)/, '').replace(/[ \t]+#+[ \t]*$/, '').trim()
        : raw.replace(/\r?\n[^\r\n]*$/, '').replace(/\r?\n/g, ' ').trim()
      items.push({
        level: Number((atx || setext)[1]),
        text: inlineText(marked.Lexer.lexInline(heading)).trim(),
        pos: node.from,
      })
    },
  })
  return items
}
