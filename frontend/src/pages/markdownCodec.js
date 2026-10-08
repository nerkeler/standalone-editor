import { marked } from 'marked'
import Turndown from 'turndown'
import { parseImagePresentationComment, formatImagePresentationComment } from './imagePresentation'
import { isExternalImageReference, resolveMarkdownImageReference } from '../markdownImagePaths'

function markdownToHtml(markdown, imageIdentity, documentPath) {
  const html = marked.parse(markdown || '')
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const headingTokens = []
  const collectHeadings = tokens => {
    for (const token of tokens || []) {
      if (token.type === 'heading') headingTokens.push(token)
      collectHeadings(token.tokens)
      for (const item of token.items || []) collectHeadings(item.tokens)
    }
  }
  collectHeadings(marked.lexer(markdown || ''))
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

function createMarkdownSerializer() {
  const td = new Turndown({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
  })
  td.addRule('editorStrike', {
    filter: ['del', 's'],
    replacement: content => `~~${content}~~`,
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
          values: cells.map(cell =>
            td.turndown(cell.innerHTML).trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>')
          ),
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

function htmlToMarkdown(html) {
  return createMarkdownSerializer().turndown(html || '')
}

export function createMarkdownCodec() {
  return {
    toEditorHtml(markdown, { imageIdentity, documentPath } = {}) {
      return markdownToHtml(markdown, imageIdentity, documentPath)
    },
    fromEditorHtml(html) {
      return htmlToMarkdown(html)
    },
  }
}
