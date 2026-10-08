import { marked } from 'marked'

const MESSAGES = {
  frontMatter: 'YAML 元数据不能无损进入富文本；请在源码模式编辑。',
  wikiLinks: 'WikiLink 目标和别名可能被改写；请保留源码。',
  footnotes: '脚注引用和定义暂不支持富文本往返；请保留源码。',
  literalFootnoteMarker: '无定义的脚注样式文本会被富文本转义；可先确认修复。',
  referenceLinks: '引用式链接会改变源文件写法；请保留源码。',
  autolinks: '自动链接写法可能被富文本改写；支持的地址可确认修复。',
  inlineLinkTitle: '链接标题属性不会由富文本完整保留；请保留源码。',
  escapedSyntax: '转义符可能丢失；请保留源码。',
  tableAlignment: '表格列对齐信息可能丢失；请保留源码。',
  nestedLists: '嵌套列表的缩进可能改变；请保留源码。',
  taskListCompatibility: '混合普通项与任务项或有序任务列表无法由富文本无损保留；请保留源码。',
  rawHtml: '原始 HTML 可能被过滤或重排；请保留源码。',
  codeFenceMetadata: '代码围栏附加信息可能丢失；请保留源码。',
  unparseableMarkdown: 'Markdown 无法解析；请保留源码并检查内容。',
}

function stripBlockquotePrefixes(line, limit = Infinity) {
  let prefixLength = 0
  let depth = 0
  while (depth < limit) {
    const prefix = line.slice(prefixLength).match(/^ {0,3}>[\t ]?/)
    if (!prefix) break
    prefixLength += prefix[0].length
    depth += 1
  }
  return { text: line.slice(prefixLength), prefixLength, depth }
}

function isSafeIntrawordEscapedUnderscore(text, match) {
  if (match[0] !== '\\_') return false
  // Inspect at most two UTF-16 code units on either side so astral Unicode
  // letters/numbers work without copying the whole line for every escape.
  const before = text.slice(Math.max(0, match.index - 2), match.index)
  const after = text.slice(match.index + 2, match.index + 4)
  return /[\p{L}\p{N}]$/u.test(before) && /^[\p{L}\p{N}]/u.test(after)
}

function isWithinRanges(ranges, position) {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [start, end] = ranges[middle]
    if (position < start) high = middle - 1
    else if (position >= end) low = middle + 1
    else return true
  }
  return false
}

function normalizeReferenceLabel(label) {
  return String(label || '')
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function hasMultilineHtmlTag(value) {
  const source = String(value || '')
  for (const match of source.matchAll(/<\/?[A-Za-z][A-Za-z0-9-]*(?=[\t\n\f />])/g)) {
    let quote = null
    let multiline = false
    for (let index = match.index + match[0].length; index < source.length; index += 1) {
      const char = source[index]
      if (quote) {
        if (char === quote) quote = null
        if (char === '\n' || char === '\r') multiline = true
        continue
      }
      if (char === '"' || char === "'") quote = char
      else if (char === '>') {
        if (multiline) return true
        break
      } else if (char === '\n' || char === '\r') multiline = true
    }
  }
  return false
}

function collectImageRanges(tokens, source, scopeStart, scopeEnd, output) {
  let cursor = scopeStart
  for (const token of tokens || []) {
    const raw = String(token.raw || '')
    let from = raw ? source.indexOf(raw, cursor) : -1
    if (from < scopeStart || from + raw.length > scopeEnd) from = raw ? source.indexOf(raw, scopeStart) : -1
    const found = from >= scopeStart && from + raw.length <= scopeEnd
    // Keep all escapes in image Markdown protected. The codec handles alt text
    // through a separate serializer path, so text-node underscore guarantees
    // do not apply there.
    if (token.type === 'image') {
      // Container token raw text may omit quote/list prefixes. If an image's
      // exact raw span cannot be found, conservatively protect its nearest
      // located source container instead of assuming its escapes are plain text.
      const start = found ? from : scopeStart
      const end = found ? from + raw.length : scopeEnd
      if (end > start) output.push([start, end])
    }
    if (found) cursor = Math.max(cursor, from + raw.length)

    if (token.tokens?.length) {
      collectImageRanges(
        token.tokens,
        source,
        found ? from : scopeStart,
        found ? from + raw.length : scopeEnd,
        output,
      )
    }
    if (token.type === 'table') {
      const cellTokens = [...(token.header || []), ...(token.rows || []).flat()]
        .flatMap(cell => cell.tokens || [])
      if (cellTokens.length) {
        // Flatten all cells into one scan so repeated identical image Markdown
        // advances through the table source instead of resolving to cell one.
        collectImageRanges(
          cellTokens,
          source,
          found ? from : scopeStart,
          found ? from + raw.length : scopeEnd,
          output,
        )
      }
    }
    let itemCursor = found ? from : scopeStart
    for (const item of token.items || []) {
      const itemRaw = String(item.raw || '')
      const itemFrom = itemRaw ? source.indexOf(itemRaw, itemCursor) : -1
      const itemFound = itemFrom >= scopeStart && itemFrom + itemRaw.length <= scopeEnd
      if (itemFound) itemCursor = itemFrom + itemRaw.length
      if (!item.tokens?.length) continue
      collectImageRanges(
        item.tokens,
        source,
        itemFound ? itemFrom : scopeStart,
        itemFound ? itemFrom + itemRaw.length : scopeEnd,
        output,
      )
    }
  }
}

function collectTitledLinkRanges(tokens, source, scopeStart, scopeEnd, output) {
  let cursor = scopeStart
  const visit = token => {
    const raw = String(token.raw || '')
    let from = raw ? source.indexOf(raw, cursor) : -1
    if (from < scopeStart || from + raw.length > scopeEnd) from = raw ? source.indexOf(raw, scopeStart) : -1
    const found = from >= scopeStart && from + raw.length <= scopeEnd
        if (token.type === 'link' && token.title && found && /\]\([\s\S]*\)$/.test(raw)) {
      output.push([from, from + raw.length])
    }
    if (found) cursor = Math.max(cursor, from + raw.length)

    const childTokens = token.tokens || []
    if (childTokens.length) {
      const childStart = found ? from : scopeStart
      const childEnd = found ? from + raw.length : scopeEnd
      collectTitledLinkRanges(childTokens, source, childStart, childEnd, output)
    }
    for (const item of token.items || []) {
      if (item.tokens?.length) {
        const itemRaw = String(item.raw || '')
        const itemFrom = itemRaw ? source.indexOf(itemRaw, found ? from : scopeStart) : -1
        const itemStart = itemFrom >= 0 && itemFrom + itemRaw.length <= scopeEnd ? itemFrom : scopeStart
        const itemEnd = itemStart === scopeStart ? scopeEnd : itemStart + itemRaw.length
        collectTitledLinkRanges(item.tokens, source, itemStart, itemEnd, output)
      }
    }
  }
  for (const token of tokens || []) visit(token)
}

function isMultilineReferenceLink(token, links) {
  if (token.type !== 'link' || !/[\r\n]/.test(token.raw || '')) return false
  const raw = String(token.raw || '')
  if (/^\[[\s\S]*\]\s*\[[^\]]*\]$/.test(raw)) return true
  const shortcut = raw.match(/^\[([\s\S]+)\]$/)
  return Boolean(shortcut && Object.hasOwn(links, normalizeReferenceLabel(shortcut[1])))
}

function collectListItemMarkers(tokens, output = [], parentItem = null, insideBlockquote = false, simpleBulletPath = true) {
  for (const token of tokens || []) {
    if (token.type === 'list') {
      const simpleBulletList = token.ordered === false
      for (const item of token.items || []) {
        const firstLine = String(item.raw || '').split(/\r?\n/, 1)[0].trimStart().trimEnd()
        output.push({
          firstLine,
          safeLooseNestedBullet: Boolean(
            parentItem &&
            !insideBlockquote &&
            simpleBulletPath &&
            simpleBulletList &&
            parentItem.loose === true &&
            token.loose === true &&
            !parentItem.task &&
            !item.task &&
            item.loose === true
          ),
        })
        collectListItemMarkers(
          item.tokens,
          output,
          item,
          insideBlockquote,
          simpleBulletPath && simpleBulletList && !item.task,
        )
      }
      continue
    }
    collectListItemMarkers(
      token.tokens,
      output,
      parentItem,
      insideBlockquote || token.type === 'blockquote',
      simpleBulletPath,
    )
  }
  return output
}

function hasUnsupportedTaskList(token) {
  if (token.type === 'list') {
    const taskStates = (token.items || []).map(item => Boolean(item.task))
    const containsTask = taskStates.some(Boolean)
    if (containsTask && (token.ordered || taskStates.some(isTask => !isTask))) return true
  }
  for (const child of token.tokens || []) {
    if (hasUnsupportedTaskList(child)) return true
  }
  for (const item of token.items || []) {
    for (const child of item.tokens || []) {
      if (hasUnsupportedTaskList(child)) return true
    }
  }
  return false
}

function hasUnsupportedTableAlignment(token, nested = false) {
  return token.type === 'table' && token.align?.some(Boolean) &&
    (nested || !token.align.every(value => value === 'left'))
}

export function analyzeMarkdownSource(markdown) {
  const source = String(markdown || '')
  const items = []
  const add = (reason, from, to) => {
    if (to > from && !items.some(item => item.reason === reason && item.from === from)) {
      items.push({ reason, from, to, message: MESSAGES[reason] })
    }
  }
  const front = source.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  if (front) add('frontMatter', 0, front[0].length)
  let tokens
  try { tokens = marked.lexer(source) } catch {
    add('unparseableMarkdown', 0, Math.max(1, source.length))
    return items
  }
  const linkDefinitions = tokens.links || Object.create(null)
  // The rich editor represents homogeneous unordered task lists. It cannot
  // represent ordinary items mixed into that list or tasks under an ordered
  // marker, so protect those complete source list blocks before opening it.
  let taskListSourceCursor = 0
  for (const token of tokens) {
    const raw = String(token.raw || '')
    const from = raw ? source.indexOf(raw, taskListSourceCursor) : -1
    if (from >= 0) {
      const to = Math.min(source.length, from + raw.length)
      if (hasUnsupportedTaskList(token)) add('taskListCompatibility', from, to)
      taskListSourceCursor = to
    }
  }
  let imageRanges = []
  collectImageRanges(tokens, source, 0, source.length, imageRanges)
  imageRanges.sort((left, right) => left[0] - right[0])
  const mergedImageRanges = []
  for (const range of imageRanges) {
    const previous = mergedImageRanges.at(-1)
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
    else mergedImageRanges.push([...range])
  }
  imageRanges = mergedImageRanges
  let offset = 0
  let fence = null
  let fenceStart = -1
  const fencedRanges = []
  const listIndentByQuoteDepth = new Map()
  const logicalLines = []
  for (const line of source.match(/[^\n]*(?:\n|$)/g) || []) {
    if (!line) continue
    const raw = line.replace(/\r?\n$/, '')
    if (fence) {
      // A blockquote fence needs its quote prefix on each code line. Strip only
      // the prefix depth where that fence began; a literal `>` in ordinary
      // fenced code must stay code, and a deeper quote inside code must stay
      // part of the code text.
      const fenceLine = fence.quoteDepth
        ? stripBlockquotePrefixes(raw, fence.quoteDepth)
        : { text: raw, depth: 0 }
      if (fenceLine.depth < fence.quoteDepth) {
        // The source left the blockquote container before closing the fence.
        // End the protected range before this line, then scan it normally.
        fencedRanges.push([fenceStart, offset])
        fence = null
        fenceStart = -1
      } else {
        const marker = fenceLine.text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
          fencedRanges.push([fenceStart, offset + line.length])
          fence = null
          fenceStart = -1
        }
        offset += line.length
        continue
      }
    }

    const quote = stripBlockquotePrefixes(raw)
    const logical = quote.text
    const logicalStart = offset + quote.prefixLength
    logicalLines.push({ text: logical, sourceStart: offset, sourceEnd: offset + raw.length, logicalStart })
    const marker = logical.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      const info = marker[2].trim()
      if (info && !/^[\w.+#-]+$/.test(info)) {
        add('codeFenceMetadata', logicalStart + logical.indexOf(info), offset + raw.length)
      }
      fence = { char: marker[1][0], length: marker[1].length, quoteDepth: quote.depth }
      fenceStart = offset
      offset += line.length
      continue
    }
    if (offset < (front?.[0].length || 0)) { offset += line.length; continue }
    for (const depth of listIndentByQuoteDepth.keys()) {
      if (depth > quote.depth) listIndentByQuoteDepth.delete(depth)
    }
    const listIndent = listIndentByQuoteDepth.get(quote.depth) ?? null
    const list = logical.match(/^(\s*)(?:[-+*]|\d+[.)])\s/)
    if (list) {
      if (listIndent !== null && list[1].length > listIndent) {
        add('nestedLists', logicalStart + list[1].length, offset + raw.length)
      }
      if (listIndent === null || list[1].length < listIndent) listIndentByQuoteDepth.set(quote.depth, list[1].length)
    } else if (logical.trim() && !/^\s/.test(logical)) {
      listIndentByQuoteDepth.delete(quote.depth)
    }
    const code = [...logical.matchAll(/(`+)(.*?)\1/g)].map(match => [match.index, match.index + match[0].length])
    const escapedLiteralFootnotes = [...logical.matchAll(/\\\[\^[^\]\n]+\\\]/g)]
      .map(match => [match.index, match.index + match[0].length])
    // CommonMark does not treat underscores between letters or numbers as
    // emphasis delimiters. Turndown escapes text underscores on serialization,
    // so these intraword escapes survive the complete rich-text round trip.
    // Keep boundary underscores protected: there they can open or close emphasis.
    const numberedHeading = logical.match(/^ {0,3}#{1,6}[\t ]+\d+\\\./)
    const safeNumberedHeadingDot = numberedHeading
      ? [numberedHeading[0].length - 2, numberedHeading[0].length]
      : null
    const scan = (reason, regex) => {
      for (const match of logical.matchAll(regex)) {
        const trailingLinkTitle = /^[\t ]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\)\r\n]*\))[\t ]*\)/
        const closesInlineLink = /^[\t ]*\)/
        const inImage = reason === 'escapedSyntax' && isWithinRanges(imageRanges, logicalStart + match.index)
        const insideLinkDestination = reason === 'autolinks' &&
          /\]\([\t ]*$/.test(logical.slice(0, match.index)) &&
          (closesInlineLink.test(logical.slice(match.index + match[0].length)) ||
            trailingLinkTitle.test(logical.slice(match.index + match[0].length)))
        if (!code.some(([start, end]) => match.index >= start && match.index < end) &&
            !insideLinkDestination &&
            !(reason === 'escapedSyntax' && (
              escapedLiteralFootnotes.some(([start, end]) => match.index >= start && match.index < end) ||
              (!inImage && isSafeIntrawordEscapedUnderscore(logical, match)) ||
              (safeNumberedHeadingDot && match.index >= safeNumberedHeadingDot[0] && match.index < safeNumberedHeadingDot[1])
            )) &&
            !(reason === 'rawHtml' && /^(?:<https?:\/\/|<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@)/i.test(match[0]))) {
          add(reason, logicalStart + match.index, logicalStart + match.index + match[0].length)
        }
      }
    }
    scan('wikiLinks', /!?\[\[[^\]\n]+\]\]/g)
    scan('referenceLinks', /!?\[(?!\^)(?:\\.|[^\]\n]|\[[^\]\n]*\])+\]\[[^\]\n]*\]|^\s{0,3}\[(?!\^)[^\]\n]+\]:\s*\S+/g)
    for (const match of logical.matchAll(/\[((?:\\.|[^\]])+)\](?:\[([^\]]*)\])?/g)) {
      const after = logical[match.index + match[0].length]
      const before = logical[match.index - 1]
      if (before === ']' || after === '(' || after === ':' || after === ']') continue
      if (match[1].startsWith('^')) continue
      if (code.some(([start, end]) => match.index >= start && match.index < end)) continue
      const label = normalizeReferenceLabel(match[2] || match[1])
      if (Object.hasOwn(linkDefinitions, label)) {
        const start = before === '!' ? match.index - 1 : match.index
        add('referenceLinks', logicalStart + start, logicalStart + match.index + match[0].length)
      }
    }
    scan('autolinks', /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>|<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+>/g)
    scan('escapedSyntax', /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g)
    scan('rawHtml', /<!--(?!(?:[ \t]*zoom:\d+[ \t]*-->|[ \t]*se-image:width=(?:2[5-9]|[3-9]\d|100);align=(?:left|center)[ \t]*-->)).*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?=[\t\n\f />])[^>]*>/g)
    offset += line.length
  }
  if (fence) fencedRanges.push([fenceStart, source.length])
  const inFence = index => fencedRanges.some(([start, end]) => index >= start && index < end)

  // The editor preserves ordinary unordered sublists when both the parent
  // item and child-list items are already paragraphs. Tight items gain or lose
  // paragraph spacing when serialized; ordered/task and quote nesting remain
  // protected until their round-trip behavior is verified separately.
  const safeLooseNestedBulletOffsets = new Set()
  let listTokenOffset = 0
  let markerLineCursor = 0
  for (const token of tokens) {
    const tokenRaw = String(token.raw || '')
    const tokenStart = tokenRaw ? source.indexOf(tokenRaw, listTokenOffset) : -1
    if (tokenStart < 0) continue
    const tokenEnd = Math.min(source.length, tokenStart + tokenRaw.length)
    for (const marker of collectListItemMarkers([token])) {
      if (!marker.firstLine) continue
      for (let index = markerLineCursor; index < logicalLines.length; index += 1) {
        const line = logicalLines[index]
        if (line.sourceStart < tokenStart) continue
        if (line.sourceStart >= tokenEnd) break
        if (line.sourceStart < (front?.[0].length || 0) || inFence(line.sourceStart)) continue
        if (line.text.trimStart().trimEnd() !== marker.firstLine) continue
        if (marker.safeLooseNestedBullet) {
          const indentLength = line.text.length - line.text.trimStart().length
          safeLooseNestedBulletOffsets.add(line.logicalStart + indentLength)
        }
        markerLineCursor = index + 1
        break
      }
    }
    listTokenOffset = tokenEnd
  }

  let titledLinkOffset = 0
  for (const token of tokens) {
    const raw = String(token.raw || '')
    const from = raw ? source.indexOf(raw, titledLinkOffset) : -1
    if (from < 0) continue
    const to = Math.min(source.length, from + raw.length)
    const ranges = []
    collectTitledLinkRanges([token], source, from, to, ranges)
    for (const [start, end] of ranges) add('inlineLinkTitle', start, end)
    titledLinkOffset = to
  }

  const footnoteDefinitions = new Set()
  for (const line of logicalLines) {
    if (line.sourceStart < (front?.[0].length || 0) || inFence(line.sourceStart)) continue
    const definition = line.text.match(/^ {0,3}\[\^([^\]\n]+)\]:/)
    if (definition) footnoteDefinitions.add(normalizeReferenceLabel(definition[1]))
  }
  for (const line of logicalLines) {
    if (line.sourceStart < (front?.[0].length || 0) || inFence(line.sourceStart)) continue
    const code = [...line.text.matchAll(/(`+)(.*?)\1/g)].map(match => [match.index, match.index + match[0].length])
    for (const match of line.text.matchAll(/\\?\[\^([^\]\n]+)\\?\]/g)) {
      if (code.some(([start, end]) => match.index >= start && match.index < end)) continue
      const escapedOpen = match[0].startsWith('\\[')
      const escapedClose = match[0].endsWith('\\]')
      if (escapedOpen && escapedClose) continue
      if (escapedOpen || escapedClose) continue
      const reason = footnoteDefinitions.has(normalizeReferenceLabel(match[1]))
        ? 'footnotes'
        : 'literalFootnoteMarker'
      add(reason, line.logicalStart + match.index, line.logicalStart + match.index + match[0].length)
    }
  }

  // Marked's token tree tells us whether a delimiter-looking row is actually
  // part of a table. The rich editor preserves explicit all-left delimiters
  // for ordinary tables; nested containers and other alignments stay protected.
  const alignedTableTokens = (token, nested = false) => {
    const found = []
    if (hasUnsupportedTableAlignment(token, nested)) found.push(token)
    for (const child of token.tokens || []) found.push(...alignedTableTokens(child, true))
    for (const item of token.items || []) {
      for (const child of item.tokens || []) found.push(...alignedTableTokens(child, true))
    }
    return found
  }
  let tableTokenOffset = 0
  for (const token of tokens) {
    const tokenRaw = String(token.raw || '')
    const tokenStart = tokenRaw ? source.indexOf(tokenRaw, tableTokenOffset) : -1
    if (tokenStart < 0) continue
    const tokenEnd = Math.min(source.length, tokenStart + tokenRaw.length)
    for (const table of alignedTableTokens(token)) {
      const delimiter = String(table.raw || '').split(/\r?\n/)[1]?.trim()
      if (!delimiter) continue
      let lineStart = tokenStart
      while (lineStart < tokenEnd) {
        let lineEnd = source.indexOf('\n', lineStart)
        if (lineEnd < 0 || lineEnd > tokenEnd) lineEnd = tokenEnd
        const rawLine = source.slice(lineStart, lineEnd).replace(/\r$/, '')
        if (stripBlockquotePrefixes(rawLine).text.trim() === delimiter && !inFence(lineStart)) {
          add('tableAlignment', lineStart, lineStart + rawLine.length)
        }
        lineStart = lineEnd + 1
      }
    }
    tableTokenOffset = Math.max(tableTokenOffset, tokenEnd)
  }

  // Marked consumes reference definitions into its links table instead of
  // exposing them as block tokens. Match a source definition whose destination
  // starts on the following line against that table so unused definitions are
  // still protected from being dropped during rich-text serialization.
  const normalizedLinkDefinitions = new Map()
  for (const [key, value] of Object.entries(linkDefinitions)) {
    const label = normalizeReferenceLabel(key)
    if (!normalizedLinkDefinitions.has(label)) normalizedLinkDefinitions.set(label, value)
  }
  for (let index = 0; index < logicalLines.length; index += 1) {
    const line = logicalLines[index]
    if (line.sourceStart < (front?.[0].length || 0) || inFence(line.sourceStart)) continue
    const definition = line.text.match(/^ {0,3}\[([^\]\n]+)\]:[\t ]*$/)
    if (!definition) continue
    const label = normalizeReferenceLabel(definition[1])
    const link = normalizedLinkDefinitions.get(label)
    const destination = logicalLines[index + 1]
    if (!link || !destination || inFence(destination.sourceStart) || !/^\s{1,3}\S/.test(destination.text)) continue
    let to = destination.sourceEnd
    const title = logicalLines[index + 2]
    if (link.title && title && !inFence(title.sourceStart) && /^\s{1,3}["'(]/.test(title.text)) to = title.sourceEnd
    add('referenceLinks', line.logicalStart + definition[0].indexOf('['), to)
  }

  // The line scanner above keeps exact ranges for ordinary quote prefixes.
  // Marked removes list-container indentation from nested blockquote tokens,
  // so use its token tree as a conservative fallback for those deeper forms.
  const collectQuotedLossyReasons = (token, inBlockquote = false, listDepth = 0) => {
    const reasons = new Set()
    const insideQuote = inBlockquote || token.type === 'blockquote'
    if (hasUnsupportedTableAlignment(token, insideQuote || listDepth > 0)) reasons.add('tableAlignment')
    if (token.type === 'code' && insideQuote && token.lang?.trim() && !/^[\w.+#-]+$/.test(token.lang.trim())) {
      reasons.add('codeFenceMetadata')
    }
    if (token.type === 'html' && hasMultilineHtmlTag(token.text || token.raw)) reasons.add('rawHtml')
    if (isMultilineReferenceLink(token, linkDefinitions)) reasons.add('referenceLinks')
    if (token.type === 'list') {
      if (insideQuote && listDepth > 0) reasons.add('nestedLists')
      for (const item of token.items || []) {
        for (const child of item.tokens || []) {
          for (const reason of collectQuotedLossyReasons(child, insideQuote, listDepth + 1)) reasons.add(reason)
        }
      }
      return reasons
    }
    for (const child of token.tokens || []) {
      for (const reason of collectQuotedLossyReasons(child, insideQuote, listDepth)) reasons.add(reason)
    }
    return reasons
  }
  let tokenOffset = 0
  for (const token of tokens) {
    const tokenRaw = String(token.raw || '')
    const found = tokenRaw ? source.indexOf(tokenRaw, tokenOffset) : tokenOffset
    const from = found >= 0 ? found : tokenOffset
    const to = Math.min(source.length, from + tokenRaw.length)
    if (to > from) {
      for (const reason of collectQuotedLossyReasons(token)) {
        const hasPreciseRange = items.some(item => item.reason === reason && item.from >= from && item.to <= to)
        if (!hasPreciseRange) add(reason, from, to)
      }
    }
    tokenOffset = Math.max(tokenOffset, to)
  }

  for (const match of source.matchAll(/<!--[\s\S]*?-->/g)) {
    if (inFence(match.index) || match.index < (front?.[0].length || 0)) continue
    if (/^<!--[ \t]*zoom:\d+[ \t]*-->$/.test(match[0])) continue
    if (/^<!--[ \t]*se-image:width=(?:2[5-9]|[3-9]\d|100);align=(?:left|center)[ \t]*-->$/.test(match[0])) continue
    add('rawHtml', match.index, match.index + match[0].length)
  }
  return items
    .filter(item => !(item.reason === 'nestedLists' && safeLooseNestedBulletOffsets.has(item.from)))
    .sort((a, b) => a.from - b.from || a.to - b.to)
}
