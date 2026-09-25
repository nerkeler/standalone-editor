import { marked } from 'marked'

const WIKI_LINK = /!?\[\[[^\]\n]+\]\]/
const FOOTNOTE = /\[\^[^\]\n]+\]/
const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/
const LANGUAGE_ONLY = /^[\w.+#-]+$/

function isSupportedZoomMarker(token) {
  return /^<!--[ \t]*zoom:\d+[ \t]*-->$/.test(String(token.raw || '').trim())
}

function inspectInlineTokens(token, reasons) {
  if (!token || typeof token !== 'object') return
  if (token.type === 'code' || token.type === 'codespan') return

  if (token.type === 'escape') reasons.add('escapedSyntax')
  if (token.type === 'html' && !isSupportedZoomMarker(token)) reasons.add('rawHtml')

  if (token.type === 'text' && !Array.isArray(token.tokens)) {
    const raw = String(token.raw ?? token.text ?? '')
    if (WIKI_LINK.test(raw)) reasons.add('wikiLinks')
    if (FOOTNOTE.test(raw)) reasons.add('footnotes')
    if (/^\s{0,3}\[\^[^\]\n]+\]:/m.test(raw)) reasons.add('footnotes')
  }

  if (Array.isArray(token.tokens)) {
    for (const child of token.tokens) inspectInlineTokens(child, reasons)
  }
  if (Array.isArray(token.header)) {
    for (const cell of token.header) inspectInlineTokens(cell, reasons)
  }
  if (Array.isArray(token.rows)) {
    for (const row of token.rows) {
      for (const cell of row) inspectInlineTokens(cell, reasons)
    }
  }
}

function inspectBlockTokens(tokens, reasons, listDepth = 0) {
  for (const token of tokens || []) {
    if (!token || typeof token !== 'object') continue

    if (token.type === 'code') {
      const language = String(token.lang || '').trim()
      if (language && !LANGUAGE_ONLY.test(language)) reasons.add('codeFenceMetadata')
      continue
    }

    if (token.type === 'list') {
      if (listDepth > 0) reasons.add('nestedLists')
      for (const item of token.items || []) {
        inspectBlockTokens(item.tokens, reasons, listDepth + 1)
      }
      continue
    }

    if (token.type === 'table' && token.align?.some(Boolean)) reasons.add('tableAlignment')
    inspectInlineTokens(token, reasons)

    // Recurse through block containers such as blockquotes to find lists/code.
    if (Array.isArray(token.tokens)) inspectBlockTokens(token.tokens, reasons, listDepth)
  }
}

/**
 * Return constructs whose meaning or source form the current conversion chain
 * cannot reliably preserve. The editor-owned zoom comment is intentionally
 * exempt because rich-text mode strips and reapplies it around conversion.
 */
export function getMarkdownSourceModeReasons(markdown) {
  const content = String(markdown || '')
  const reasons = new Set()
  if (FRONT_MATTER.test(content)) reasons.add('frontMatter')

  let tokens
  try {
    tokens = marked.lexer(content)
  } catch {
    return [...reasons, 'unparseableMarkdown']
  }

  if (Object.keys(tokens.links || {}).length > 0) reasons.add('referenceLinks')
  inspectBlockTokens(tokens, reasons)
  return [...reasons]
}

export function requiresSourceMode(markdown) {
  return getMarkdownSourceModeReasons(markdown).length > 0
}
