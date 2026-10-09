export function getUniformLineSeparator(value) {
  const separators = String(value ?? '').match(/\r\n|\r|\n/g) || []
  if (!separators.length) return undefined
  const first = separators[0]
  return separators.every(separator => separator === first) ? first : undefined
}

export function normalizeLineEndings(value, separator = '\n') {
  return String(value ?? '').replace(/\r\n|\r|\n/g, separator)
}

export function serializeSourceDocument(doc, separator) {
  return separator ? doc.sliceString(0, doc.length, separator) : doc.toString()
}

export function sourceOffsetToDocumentOffset(value, offset) {
  const source = String(value ?? '')
  const rawOffset = Math.max(0, Math.min(source.length, Number.isFinite(offset) ? Math.trunc(offset) : 0))
  let extraCarriageReturns = 0
  for (let index = 0; index < rawOffset; index += 1) {
    if (source[index] === '\r' && source[index + 1] === '\n') {
      extraCarriageReturns += 1
      index += 1
    }
  }
  return rawOffset - extraCarriageReturns
}
