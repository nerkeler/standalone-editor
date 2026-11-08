// Markdown list style detection for the rich-text round trip.
//
// TipTap normalizes every list item to a paragraph inside <li>, so the
// serializer cannot recover the author's indentation from the editor model.
// We detect the document's indent unit once at load and serialize lists back
// with that unit. Tight/loose spacing is carried separately by a
// `data-md-loose` attribute that the codec annotates and the editor preserves.
// Documents whose lists are not uniform keep the conservative source
// protection instead of being silently rewritten.

const LIST_LINE = /^(\s*)([-+*]|\d+[.)])([ \t]+)(.*)$/
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/
const QUOTED_LIST_LINE = /^\s*>.*(?:[-+*]|\d+[.)])[ \t]/

function normalizeIndent(indent) {
  return indent.replace(/\t/g, '    ').length
}

function collectListLines(lines) {
  const listLines = []
  let fence = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceMatch = line.match(FENCE_LINE)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length &&
          !line.slice(fenceMatch[0].length).trim()) {
        fence = null
      }
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      continue
    }
    const match = line.match(LIST_LINE)
    if (!match) continue
    listLines.push({
      index,
      indent: normalizeIndent(match[1]),
      rawIndent: match[1],
      marker: match[2],
      width: match[2].length + match[3].replace(/\t/g, '    ').length,
      text: match[4],
    })
  }
  return listLines
}

function isCanonicalMarker(marker) {
  return marker === '-' || /^\d+\.$/.test(marker)
}

function modeOf(values, fallback) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
  let result = fallback
  let best = -1
  for (const [value, count] of counts) {
    if (count > best || (count === best && value < result)) {
      result = value
      best = count
    }
  }
  return result
}

// Bullets and ordered markers carry separate widths: a document may use `- `
// bullets together with `1. ` ordered items.
function markerWidthsOf(listLines) {
  const bulletWidth = modeOf(listLines.filter(line => line.marker === '-').map(line => line.width), 2)
  const orderedPadding = modeOf(
    listLines.filter(line => line.marker !== '-').map(line => line.width - line.marker.length),
    2,
  )
  return { bulletWidth, orderedPadding }
}

// Returns { indent, safe }. `safe` is true only when the document's nested
// lists are uniform enough for the serializer to reproduce them.
export function detectListStyle(markdown) {
  const source = String(markdown || '')
  const lines = source.split(/\r?\n/)
  if (lines.some(line => QUOTED_LIST_LINE.test(line))) {
    return { bulletWidth: 2, orderedPadding: 1, step: 0, safe: false }
  }
  const listLines = collectListLines(lines)
  const nested = listLines.filter(line => line.indent > 0)
  if (!nested.length) {
    // Flat lists still need their marker width preserved (`- ` vs `-   `).
    if (!listLines.length) return { bulletWidth: 4, orderedPadding: 2, step: 2, safe: false }
    if (listLines.some(line => !isCanonicalMarker(line.marker))) return { bulletWidth: 4, orderedPadding: 2, step: 2, safe: false }
    return { ...markerWidthsOf(listLines), step: 0, safe: true }
  }

  if (nested.some(line => line.rawIndent.includes('\t'))) return { bulletWidth: 2, orderedPadding: 1, step: 0, safe: false }
  const step = Math.min(...nested.map(line => line.indent))
  if (![2, 3, 4].includes(step)) return { bulletWidth: 2, orderedPadding: 1, step, safe: false }
  if (nested.some(line => line.indent % step !== 0)) return { bulletWidth: 2, orderedPadding: 1, step, safe: false }
  if (listLines.some(line => !isCanonicalMarker(line.marker))) return { bulletWidth: 2, orderedPadding: 1, step, safe: false }
  const { bulletWidth, orderedPadding } = markerWidthsOf(listLines)
  if (![2, 3, 4].includes(bulletWidth) || ![1, 2, 3].includes(orderedPadding)) {
    return { bulletWidth: 4, orderedPadding: 2, step, safe: false }
  }
  if (nested.some(line => /^\[[ xX]\][ \t]/.test(line.text))) return { bulletWidth: 2, orderedPadding: 1, step, safe: false }
  // Headings inside a list item still take a different serialization path, and
  // `- - text` style markers are normalized differently; keep them protected.
  if (nested.some(line => /^#{1,6}[ \t]/.test(line.text))) return { bulletWidth: 2, orderedPadding: 1, step, safe: false }
  if (listLines.some(line => /^(?:[-+*]|\d+[.)])[ \t]/.test(line.text))) return { bulletWidth: 2, orderedPadding: 1, step, safe: false }

  // Every nested line must sit exactly at its parent's content column, because
  // that is what the serializer reproduces from the list depth.
  let parent = null
  for (const line of listLines) {
    while (parent && parent.indent >= line.indent) parent = parent.parent
    if (line.indent > 0) {
      if (!parent) return { bulletWidth, orderedPadding, step, safe: false }
      const parentWidth = parent.marker === '-' ? bulletWidth : parent.marker.length + orderedPadding
      const expected = parent.indent + Math.max(step, parentWidth)
      if (line.indent !== expected) return { bulletWidth, orderedPadding, step, safe: false }
    }
    line.parent = parent
    parent = line
  }

  return { bulletWidth, orderedPadding, step, safe: true }
}
