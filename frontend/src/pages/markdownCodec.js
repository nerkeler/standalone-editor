import { marked } from './markedSetup.js'
import Turndown from 'turndown'
import { parseImagePresentationComment, formatImagePresentationComment } from './imagePresentation.js'
import { isExternalImageReference, resolveMarkdownImageReference } from '../markdownImagePaths.js'

// Turndown collapses every whitespace run in a text node, which reflows
// paragraphs and drops the source line break after an explicit <br>. Replace
// soft newlines with a private-use marker before serializing, then restore
// them in the Markdown output.
const SOFT_BREAK_MARKER = '\uE000'

function protectSoftBreaks(html) {
  // Only the newline that follows an explicit <br> is a meaningful source
  // break; the collapse pass would otherwise glue the next line onto it.
  return html.replace(/(<br\s*\/?>)\n/gi, `$1${SOFT_BREAK_MARKER}`)
}

function restoreSoftBreaks(markdown) {
  return markdown.split(SOFT_BREAK_MARKER).join('\n')
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/
const WORD_CHARACTER = /[\p{L}\p{N}]/u

function isSpace(character) {
  return character === undefined || /\s/.test(character)
}

function isPunctuation(character) {
  return character !== undefined && ASCII_PUNCTUATION.test(character)
}

function isWord(character) {
  return character !== undefined && WORD_CHARACTER.test(character)
}

// CommonMark flanking rules decide whether a delimiter can open or close
// emphasis. A delimiter that is neither left- nor right-flanking is literal
// text and needs no backslash, so `2 * 3` and `a * b * c` stay readable.
function isEmphasisDelimiter(text, index) {
  const previous = text[index - 1]
  const next = text[index + 1]
  if (isSpace(previous) && isSpace(next)) return false
  const leftFlanking = !isSpace(next) && (!isPunctuation(next) || isSpace(previous) || isPunctuation(previous))
  const rightFlanking = !isSpace(previous) && (!isPunctuation(previous) || isSpace(next) || isPunctuation(next))
  return leftFlanking || rightFlanking
}

// Turndown escapes every `*`, `_`, `[`, `]` and backtick in a text node. That
// is safe but rewrites ordinary prose (`report_id`, `2 * 3`, `array[0]`) into
// backslash-heavy Markdown. The minimal variant only escapes characters that
// could change the parsed document; htmlToMarkdown verifies the result by
// re-parsing it, so an incorrect guess can never reach disk.
function escapeMarkdownText(text, { minimal = false, inline = false } = {}) {
  let output = ''
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      // A backslash only needs escaping before an escapable character; before
      // a letter or digit it stays literal in CommonMark.
      const next = text[index + 1]
      output += next === undefined || next === '\n' || ASCII_PUNCTUATION.test(next) ? '\\\\' : '\\'
      continue
    }
    if (character === '`') { output += '\\`'; continue }
    // `<b>` and `&amp;` are literal text here (the editor already decoded the
    // entity or tag), so they must not turn back into HTML when re-parsed.
    if (character === '<') {
      output += /[A-Za-z/!?]/.test(text[index + 1] || '') ? '\\<' : '<'
      continue
    }
    if (character === '&') {
      output += /#?[A-Za-z0-9]+;/.test(text.slice(index + 1)) ? '\\&' : '&'
      continue
    }
    if (character === '~') {
      // Only a doubled run can be a strikethrough now, so a lone tilde
      // (`40~60%`) is always literal.
      output += text[index - 1] === '~' || text[index + 1] === '~' ? '\\~' : '~'
      continue
    }
    if (character === '*') {
      output += !minimal || isEmphasisDelimiter(text, index) ? '\\*' : '*'
      continue
    }
    if (character === '_') {
      // Intraword underscores never open emphasis in CommonMark.
      const intraword = isWord(text[index - 1]) && isWord(text[index + 1])
      output += !minimal || (!intraword && isEmphasisDelimiter(text, index)) ? '\\_' : '_'
      continue
    }
    if (character === '[') {
      const opensLink = text.indexOf('](', index + 1) !== -1 || text.indexOf('][', index + 1) !== -1
      output += !minimal || opensLink ? '\\[' : '['
      continue
    }
    if (character === ']') {
      output += minimal ? ']' : '\\]'
      continue
    }
    output += character
  }
  // Line-start escapes are only meaningful at a real block boundary. The
  // minimal variant drops them and lets the round-trip verification decide;
  // the conservative variant always keeps them.
  if (inline || minimal) return output
  return output
    .replace(/^-/g, '\\-')
    .replace(/^\+ /g, '\\+ ')
    .replace(/^(=+)/g, '\\$1')
    .replace(/^(#{1,6}) /g, '\\$1 ')
    .replace(/^~~~/g, '\\~~~')
    .replace(/^>/g, '\\>')
    .replace(/^(\d+)\. /g, '$1\\. ')
}

function markdownToHtml(markdown, imageIdentity, documentPath) {
  const html = marked.parse(markdown || '')
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const headingTokens = []
  const listTokens = []
  const collectHeadings = tokens => {
    for (const token of tokens || []) {
      if (token.type === 'heading') headingTokens.push(token)
      if (token.type === 'list') listTokens.push(token)
      collectHeadings(token.tokens)
      for (const item of token.items || []) collectHeadings(item.tokens)
    }
  }
  collectHeadings(marked.lexer(markdown || ''))
  // Tight/loose spacing is not represented in the editor model (TipTap wraps
  // every item in a paragraph), so carry it as an attribute the serializer can
  // read back. The token walk and the DOM list order are both pre-order.
  const renderedLists = Array.from(doc.querySelectorAll('ul,ol'))
  if (renderedLists.length === listTokens.length) {
    listTokens.forEach((token, index) => {
      renderedLists[index].setAttribute('data-md-loose', token.loose ? 'true' : 'false')
    })
  }
  const renderedHeadings = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6'))
  headingTokens.forEach((token, index) => {
    const sourceLine = String(token.raw || '').split(/\r?\n/, 1)[0]
    if (/^ {0,3}#{1,6}[\t ]+\d+\\\./.test(sourceLine)) {
      renderedHeadings[index]?.setAttribute('data-markdown-escaped-numbering-dot', 'true')
    }
  })
  const directTaskCheckbox = item => {
    // Marked emits a task checkbox directly in the item, or directly in its
    // first paragraph for a loose item. Do not search through nested lists:
    // a child task must not turn its ordinary parent item into a task.
    for (const child of item.children) {
      if (child.matches('ul, ol')) break
      if (child.matches('input[type="checkbox"][disabled]')) return child
      if (child.nodeName === 'P') {
        const checkbox = Array.from(child.children).find(node => node.matches('input[type="checkbox"][disabled]'))
        if (checkbox) return checkbox
      }
    }
    return null
  }
  doc.querySelectorAll('ul').forEach(list => {
    const items = Array.from(list.children).filter(node => node.nodeName === 'LI')
    const taskCheckboxes = items.map(directTaskCheckbox)
    if (!items.length || !taskCheckboxes.every(Boolean)) return
    list.setAttribute('data-type', 'taskList')
    items.forEach(item => {
      const checkbox = directTaskCheckbox(item)
      item.setAttribute('data-type', 'taskItem')
      item.setAttribute('data-checked', String(Boolean(checkbox?.checked)))
      checkbox?.remove()
    })
  })
  // Markdown image paths stay relative on disk. Resolve them against the
  // document directory only while rendering; the image endpoint validates
  // that the requested path is an image inside the active workspace.
  doc.querySelectorAll('img[src]').forEach(image => {
    const source = image.getAttribute('src') || ''
    // Only attributes generated below may carry the Markdown source value;
    // do not trust similarly named attributes from raw HTML in the document.
    image.removeAttribute('data-markdown-src')
    image.removeAttribute('data-markdown-title')
    if (isExternalImageReference(source)) return
    const reference = resolveMarkdownImageReference(source, documentPath, imageIdentity)
    image.setAttribute('data-markdown-src', reference?.markdownSrc || source)
    const title = image.getAttribute('title')
    if (title) image.setAttribute('data-markdown-title', title)
    image.setAttribute('src', reference?.url || 'about:blank')
  })
  // A newline right after <br> is source formatting; TipTap would drop it, so
  // carry it as an attribute the serializer can turn back into a line break.
  doc.querySelectorAll('br').forEach(breakNode => {
    const next = breakNode.nextSibling
    if (!next || next.nodeType !== 3 || !next.nodeValue.startsWith('\n')) return
    breakNode.setAttribute('data-md-newline', '1')
    next.nodeValue = next.nodeValue.replace(/^\n/, '')
    if (!next.nodeValue) next.parentNode?.removeChild(next)
  })
  // Metadata belongs to the immediately preceding image node, not its URL.
  // Duplicate image paths therefore retain independent display settings.
  const comments = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT)
  const imageComments = []
  while (comments.nextNode()) imageComments.push(comments.currentNode)
  imageComments.forEach(comment => {
    const metadata = parseImagePresentationComment(comment.nodeValue)
    const legacy = String(comment.nodeValue || '').trim().match(/^zoom:(\d+)$/)
    const image = comment.previousSibling
    if (image?.nodeName !== 'IMG' || (!metadata && !legacy)) return
    if (metadata) {
      image.setAttribute('data-image-width', String(metadata.width))
      image.setAttribute('data-image-align', metadata.align)
    } else image.setAttribute('data-legacy-zoom', legacy[1])
    comment.remove()
  })
  return doc.body.innerHTML
}

// Marked percent-encodes non-ASCII characters in link destinations. Decode
// those runs again so the Markdown keeps the author's Chinese anchors; ASCII
// escapes such as %20 are left untouched.
function decodeHref(href) {
  return String(href || '').replace(/(?:%[0-9A-Fa-f]{2})+/g, sequence => {
    try {
      const decoded = decodeURIComponent(sequence)
      return /[^\x00-\x7F]/.test(decoded) ? decoded : sequence
    } catch {
      return sequence
    }
  })
}

function createMarkdownSerializer({ minimal = false, inline = false, listStyle = { bulletWidth: 4, orderedPadding: 2, step: 2 }, emDelimiter = '*', strongDelimiter = '**' } = {}) {
  const td = new Turndown({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter,
    strongDelimiter,
  })
  td.escape = text => escapeMarkdownText(text, { minimal, inline })
  // Lists are re-indented and re-spaced in the document's own style so a tight
  // 2-space list stays tight and a loose 4-space list stays loose.
  td.addRule('editorList', {
    filter: ['ul', 'ol'],
    replacement: (content, node) => {
      const parent = node.parentNode
      if (parent && parent.nodeName === 'LI') return `\n${content}`
      return `\n\n${content}\n\n`
    },
  })
  td.addRule('editorListItem', {
    filter: 'li',
    replacement: (content, node, options) => {
      const parent = node.parentNode
      let marker = options.bulletListMarker
      if (parent.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') || 1)
        const index = Array.prototype.indexOf.call(parent.children, node)
        marker = `${start + index}.`
      }
      const prefix = marker === '-'
        ? marker.padEnd(listStyle.bulletWidth, ' ')
        : marker + ' '.repeat(listStyle.orderedPadding)
      const indent = ' '.repeat(Math.max(listStyle.step, prefix.length))
      const loose = parent.getAttribute?.('data-md-loose') === 'true'
      let body = content.replace(/^\n+/, '')
      if (loose) {
        body = body.replace(/\n+$/, '\n')
      } else {
        body = body.replace(/\n+$/, '').replace(/\n{2,}(?=(?:[-*+]|\d+[.)])\s)/g, '\n')
      }
      body = body.split('\n')
        .map((line, index) => (index === 0 || !line ? line : indent + line))
        .join('\n')
      return prefix + body + (node.nextSibling ? '\n' : '')
    },
  })
  // Keep the thematic break on `---`. Turndown's default `* * *` changes the
  // marker the author wrote even though both forms render the same rule.
  td.addRule('editorBlockquote', {
    filter: 'blockquote',
    replacement: content => {
      const restored = restoreSoftBreaks(content).replace(/^\n+/, '').replace(/\n+$/, '')
      return `\n\n${restored.replace(/^/gm, '> ')}\n\n`
    },
  })
  td.addRule('editorLink', {
    filter: node => node.nodeName === 'A' && node.getAttribute('href'),
    replacement: (content, node) => {
      const href = decodeHref(node.getAttribute('href'))
      const title = (node.getAttribute('title') || '').trim()
      const formattedTitle = title ? ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''
      return `[${content}](${href}${formattedTitle})`
    },
  })
  td.addRule('editorThematicBreak', {
    filter: 'hr',
    replacement: () => '\n\n---\n\n',
  })
  td.addRule('editorStrike', {
    filter: ['del', 's'],
    replacement: content => `~~${content}~~`,
  })
  // Keep each explicit line break as a Markdown-compatible HTML break. The
  // default Turndown rule turns breaks into whitespace; later cleanup can
  // turn paragraph breaks into separate paragraphs or trim cell boundaries.
  // TipTap represents these as individual hardBreak nodes, so serialize every
  // node individually instead of losing intentional blank lines in a cell.
  td.addRule('editorHardBreak', {
    filter: 'br',
    replacement: (_content, node) => (node.getAttribute?.('data-md-newline') ? `<br>${SOFT_BREAK_MARKER}` : '<br>'),
  })
  td.addRule('editorImagePath', {
    filter: node => node.nodeName === 'IMG' && node.hasAttribute('data-markdown-src'),
    replacement: (_content, node) => {
      const source = node.getAttribute('data-markdown-src') || ''
      const alt = (node.getAttribute('alt') || '').replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
      const title = node.getAttribute('data-markdown-title')
      const formattedTitle = title ? ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''
      const presentation = formatImagePresentationComment(node.getAttribute('data-image-width'), node.getAttribute('data-image-align'))
      const legacy = node.getAttribute('data-legacy-zoom')
        ? `<!-- zoom:${node.getAttribute('data-legacy-zoom')} -->` : ''
      return source ? `![${alt}](${source}${formattedTitle})${legacy}${presentation}` : ''
    },
  })
  td.addRule('editorTaskItem', {
    filter: node => node.nodeName === 'LI' && node.parentNode?.getAttribute('data-type') === 'taskList',
    replacement: (content, node) => {
      const checked = node.getAttribute('data-checked') === 'true' ? 'x' : ' '
      return `- [${checked}] ${content.trim()}\n`
    },
  })
  td.addRule('editorTaskList', {
    filter: node => node.nodeName === 'UL' && node.getAttribute('data-type') === 'taskList',
    replacement: content => `\n${content.trim()}\n`,
  })
  td.addRule('editorNumberedHeading', {
    filter: node => /^H[1-6]$/.test(node.nodeName) && /^\s*\d+\./.test(node.textContent || ''),
    replacement: (content, node) => {
      const level = Number(node.nodeName.slice(1))
      const plainNumbering = content.replace(/^(\s*\d+)\\\./, '$1.')
      const numbering = node.hasAttribute('data-markdown-escaped-numbering-dot')
        ? plainNumbering.replace(/^(\s*\d+)\./, '$1\\.')
        : plainNumbering
      return `${'#'.repeat(level)} ${numbering}\n\n`
    },
  })
  td.addRule('editorTable', {
    filter: 'table',
    replacement: (content, node) => {
      const rows = Array.from(node.querySelectorAll('tr')).map(row => {
        const cells = Array.from(row.querySelectorAll('th,td'))
        return {
          cells,
          values: cells.map(cell => {
            // A table cell is inline content: a leading `-`, `#` or `>` cannot
            // start a list or heading there, so keep those characters literal.
            const previousEscape = td.escape
            td.escape = text => escapeMarkdownText(text, { minimal, inline: true })
            let value
            try {
              value = td.turndown(cell.innerHTML).trim()
            } finally {
              td.escape = previousEscape
            }
            return restoreSoftBreaks(value).replace(/\|/g, '\\|').replace(/\n+/g, '<br>')
          }),
        }
      }).filter(row => row.values.length)
      if (!rows.length) return ''
      const columns = Math.max(...rows.map(row => row.values.length))
      const normalized = rows.map(row => Array.from({ length: columns }, (_, index) => row.values[index] || ''))
      const alignments = Array.from({ length: columns }, (_, index) => {
        const values = rows
          .map(row => row.cells[index]?.getAttribute('align')?.toLowerCase())
          .filter(value => ['left', 'center', 'right'].includes(value))
        return values.length && values.every(value => value === values[0]) ? values[0] : null
      })
      const separator = alignments.map(alignment => {
        if (alignment === 'left') return ':---'
        if (alignment === 'right') return '---:'
        if (alignment === 'center') return ':---:'
        return '---'
      })
      const lines = [
        `| ${normalized[0].join(' | ')} |`,
        `| ${separator.join(' | ')} |`,
        ...normalized.slice(1).map(row => `| ${row.join(' | ')} |`),
      ]
      return `\n${lines.join('\n')}\n`
    },
  })
  return td
}

const serializers = new Map()

function getSerializer({ minimal, listStyle, emphasisStyle }) {
  const key = `${minimal ? 1 : 0}:${listStyle.bulletWidth}:${listStyle.orderedPadding}:${listStyle.step}:${emphasisStyle.emDelimiter}:${emphasisStyle.strongDelimiter}`
  let serializer = serializers.get(key)
  if (!serializer) {
    serializer = createMarkdownSerializer({ minimal, listStyle, ...emphasisStyle })
    serializers.set(key, serializer)
  }
  return serializer
}

// Documents above this size are rare and already expensive to serialize; keep
// the conservative escaping instead of paying for a verification parse.
const MINIMAL_ESCAPE_LIMIT = 200_000

function htmlToMarkdown(html, { listStyle, emphasisStyle } = {}) {
  const source = protectSoftBreaks(html || '')
  // Without a safe detected style, keep the legacy Turndown list shape
  // (`-   ` bullets, `N.  ` ordered items, four-column content indent).
  const style = listStyle?.safe ? listStyle : { bulletWidth: 4, orderedPadding: 2, step: 2 }
  const emphasis = emphasisStyle || { emDelimiter: '*', strongDelimiter: '**' }
  const safe = getSerializer({ minimal: false, listStyle: style, emphasisStyle: emphasis })
  const minimal = getSerializer({ minimal: true, listStyle: style, emphasisStyle: emphasis })
  const safeMarkdown = restoreSoftBreaks(safe.turndown(source))
  if (source.length > MINIMAL_ESCAPE_LIMIT) return safeMarkdown
  const minimalMarkdown = restoreSoftBreaks(minimal.turndown(source))
  if (minimalMarkdown === safeMarkdown) return safeMarkdown
  try {
    // The conservative output is Turndown's own round-trip guarantee. Accept
    // the lighter escaping only when it renders exactly the same document.
    return marked.parse(minimalMarkdown) === marked.parse(safeMarkdown)
      ? minimalMarkdown
      : safeMarkdown
  } catch {
    return safeMarkdown
  }
}

export function createMarkdownCodec() {
  return {
    toEditorHtml(markdown, { imageIdentity, documentPath } = {}) {
      return markdownToHtml(markdown, imageIdentity, documentPath)
    },
    fromEditorHtml(html, options) {
      return htmlToMarkdown(html, options)
    },
  }
}
