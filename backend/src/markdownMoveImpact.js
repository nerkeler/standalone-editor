function isEscaped(value, index) {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

function maskRange(value) {
  return value.replace(/[^\r\n]/g, ' ')
}

function maskFencedCode(source) {
  const lines = source.split(/(?<=\n)/)
  let fence = null
  return lines.map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (!fence && marker) {
      fence = { char: marker[1][0], length: marker[1].length }
      return maskRange(line)
    }
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*\r?\n?$/)
      const closes = closing && closing[1][0] === fence.char && closing[1].length >= fence.length
      const masked = maskRange(line)
      if (closes) fence = null
      return masked
    }
    return line
  }).join('')
}

function maskInlineCode(source) {
  let result = ''
  for (let cursor = 0; cursor < source.length;) {
    if (source[cursor] !== '`' || isEscaped(source, cursor)) {
      result += source[cursor]
      cursor += 1
      continue
    }
    let runEnd = cursor + 1
    while (source[runEnd] === '`') runEnd += 1
    const delimiter = source.slice(cursor, runEnd)
    let closing = source.indexOf(delimiter, runEnd)
    while (closing !== -1 && source[closing - 1] === '`' && source[closing + delimiter.length] === '`') {
      closing = source.indexOf(delimiter, closing + delimiter.length)
    }
    if (closing === -1) {
      result += delimiter
      cursor = runEnd
      continue
    }
    const end = closing + delimiter.length
    result += maskRange(source.slice(cursor, end))
    cursor = end
  }
  return result
}

function maskHtmlComments(source) {
  let result = ''
  for (let cursor = 0; cursor < source.length;) {
    const start = source.indexOf('<!--', cursor)
    if (start === -1) return result + source.slice(cursor)
    result += source.slice(cursor, start)
    const markerEnd = source.indexOf('-->', start + 4)
    const end = markerEnd === -1 ? source.length : markerEnd + 3
    result += maskRange(source.slice(start, end))
    cursor = end
  }
  return result
}

function unescapeMarkdown(value) {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1')
}

function parseDestination(value, start) {
  let cursor = start
  while (/[ \t\r\n]/.test(value[cursor] || '') && cursor < value.length) cursor += 1
  if (cursor >= value.length) return null

  if (value[cursor] === '<') {
    cursor += 1
    let destination = ''
    while (cursor < value.length) {
      const char = value[cursor]
      if (char === '\\' && cursor + 1 < value.length) {
        destination += char + value[cursor + 1]
        cursor += 2
      } else if (char === '>') {
        return { destination: unescapeMarkdown(destination), cursor: cursor + 1 }
      } else if (char === '\n' || char === '\r') {
        return null
      } else {
        destination += char
        cursor += 1
      }
    }
    return null
  }

  let destination = ''
  let depth = 0
  while (cursor < value.length) {
    const char = value[cursor]
    if (char === '\\' && cursor + 1 < value.length) {
      destination += char + value[cursor + 1]
      cursor += 2
    } else if (char === '(') {
      depth += 1
      destination += char
      cursor += 1
    } else if (char === ')') {
      if (depth === 0) break
      depth -= 1
      destination += char
      cursor += 1
    } else if (/[ \t\r\n]/.test(char)) {
      break
    } else {
      destination += char
      cursor += 1
    }
  }
  if (!destination || depth !== 0) return null
  return { destination: unescapeMarkdown(destination), cursor }
}

function skipLinkTitleAndClose(value, cursor) {
  while (/[ \t\r\n]/.test(value[cursor] || '') && cursor < value.length) cursor += 1
  const titleStart = value[cursor]
  if (titleStart === '"' || titleStart === "'" || titleStart === '(') {
    const titleEnd = titleStart === '(' ? ')' : titleStart
    cursor += 1
    while (cursor < value.length) {
      if (value[cursor] === '\\') cursor += 2
      else if (value[cursor] === titleEnd) { cursor += 1; break }
      else cursor += 1
    }
    while (/[ \t\r\n]/.test(value[cursor] || '') && cursor < value.length) cursor += 1
  }
  return value[cursor] === ')' ? cursor + 1 : -1
}

function closingBracket(value, start) {
  let depth = 1
  for (let cursor = start + 1; cursor < value.length; cursor += 1) {
    if (isEscaped(value, cursor)) continue
    if (value[cursor] === '[') depth += 1
    else if (value[cursor] === ']') {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  return -1
}

function normalizedLabel(value) {
  return unescapeMarkdown(value).trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase()
}

function parseReferenceDefinitions(source) {
  const definitions = new Map()
  const maskedLines = source.split(/(?<=\n)/)
  for (let index = 0; index < maskedLines.length; index += 1) {
    const line = maskedLines[index]
    const match = line.match(/^ {0,3}\[([^\]\n]+)\]:[ \t]*/)
    if (match) {
      const destination = parseDestination(line, match[0].length)
      if (destination?.destination) {
        const key = normalizedLabel(match[1])
        if (key && !definitions.has(key)) definitions.set(key, destination.destination)
        maskedLines[index] = maskRange(line)
      }
    }
  }
  return { definitions, source: maskedLines.join('') }
}

// Find standard inline and reference-style Markdown links and images. This is
// intentionally read-only: move preflight reports affected references and
// never rewrites Markdown source.
export function extractMarkdownReferences(markdown) {
  const withoutFences = maskFencedCode(String(markdown || ''))
  const withoutComments = maskHtmlComments(withoutFences)
  const withoutCodeSpans = maskInlineCode(withoutComments)
  const { definitions, source } = parseReferenceDefinitions(withoutCodeSpans)
  const references = []

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] !== '[' || isEscaped(source, cursor)) continue
    const image = cursor > 0 && source[cursor - 1] === '!' && !isEscaped(source, cursor - 1)
    const close = closingBracket(source, cursor)
    if (close === -1) continue
    const label = source.slice(cursor + 1, close)
    let next = close + 1
    if (source[next] === '(') {
      const parsed = parseDestination(source, next + 1)
      if (parsed) {
        const end = skipLinkTitleAndClose(source, parsed.cursor)
        if (end !== -1) {
          references.push({ destination: parsed.destination, kind: image ? 'image' : 'link' })
          cursor = end - 1
          continue
        }
      }
    }

    let referenceLabel = ''
    if (source[next] === '[') {
      const referenceEnd = closingBracket(source, next)
      if (referenceEnd !== -1) {
        referenceLabel = source.slice(next + 1, referenceEnd) || label
        cursor = referenceEnd
      }
    } else {
      referenceLabel = label
    }
    const destination = definitions.get(normalizedLabel(referenceLabel))
    if (destination) references.push({ destination, kind: image ? 'image' : 'link' })
  }

  return references
}

function decodedPathSegments(pathname) {
  const result = []
  try {
    for (const segment of pathname.split('/')) {
      const decoded = decodeURIComponent(segment)
      if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return null
      result.push(decoded)
    }
  } catch {
    return null
  }
  return result
}

// Resolve only relative references inside the workspace. External URLs and
// absolute paths are intentionally left alone.
export function resolveWorkspaceReference(documentPath, destination) {
  const value = String(destination || '').trim()
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(value)) return null
  const suffixIndex = value.search(/[?#]/)
  const pathname = suffixIndex === -1 ? value : value.slice(0, suffixIndex)
  if (!pathname) return documentPath
  if (pathname.includes('\\')) return null
  const segments = decodedPathSegments(pathname)
  if (!segments) return null

  const directory = documentPath.includes('/') ? documentPath.slice(0, documentPath.lastIndexOf('/')) : ''
  const resolved = directory ? directory.split('/') : []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!resolved.length) return null
      resolved.pop()
    } else {
      resolved.push(segment)
    }
  }
  return resolved.join('/') || null
}
