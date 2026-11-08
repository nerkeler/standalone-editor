import { marked } from './markedSetup.js'

// Turndown uses one emphasis delimiter for the whole document. Detect the
// author's dominant style so `_emphasis_` documents keep underscores instead
// of being rewritten to `*emphasis*`.
export function detectEmphasisStyle(markdown) {
  const em = { '*': 0, '_': 0 }
  const strong = { '**': 0, '__': 0 }
  const walk = tokens => {
    for (const token of tokens || []) {
      if (token.type === 'em' && token.raw) em[token.raw[0] === '_' ? '_' : '*'] += 1
      if (token.type === 'strong' && token.raw) strong[token.raw.startsWith('__') ? '__' : '**'] += 1
      walk(token.tokens)
      for (const item of token.items || []) walk(item.tokens)
    }
  }
  try {
    walk(marked.lexer(String(markdown || '')))
  } catch {
    // Unparseable sources keep the default delimiters.
  }
  return {
    emDelimiter: em['_'] > em['*'] ? '_' : '*',
    strongDelimiter: strong['__'] > strong['**'] ? '__' : '**',
  }
}
