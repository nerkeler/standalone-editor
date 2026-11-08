import { marked } from 'marked'

// GFM lets a single `~` open a strikethrough, which turns ordinary ranges
// (`60~120`, `38.2%~61.8%`) into struck-through text. A lone tilde is a range
// separator in prose, so only `~~` is treated as strikethrough here.
const singleTildeAsText = {
  name: 'singleTildeAsText',
  level: 'inline',
  start(source) {
    const index = source.indexOf('~')
    return index < 0 ? undefined : index
  },
  tokenizer(source) {
    const match = /^~(?!~)/.exec(source)
    if (!match) return undefined
    return { type: 'text', raw: match[0], text: match[0] }
  },
}

marked.use({ extensions: [singleTildeAsText] })

export { marked }
