import { marked } from 'marked'
import { analyzeMarkdownSource } from './markdownDiagnostics.js'

const MAX_REPAIR_PATCHES = 128

function isSafeDestination(url) {
  if (/^https?:\/\//.test(url)) return true
  return /^(?:\.\.?\/)?[A-Za-z0-9._~/-]+(?:[?#][A-Za-z0-9._~:/?&=%+-]*)?$/.test(url)
}

function normalizeReferenceLabel(label) {
  return String(label || '')
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function parseSafeReferenceDefinition(sourceRange, links) {
  const singleLine = sourceRange.match(/^ {0,3}\[([A-Za-z0-9_-]+)\]:[\t ]+([^\s<>"'`()\\]+)[\t ]*$/)
  const multiline = sourceRange.match(/^ {0,3}\[([A-Za-z0-9_-]+)\]:[\t ]*\r?\n[\t ]{1,3}([^\s<>"'`()\\]+)[\t ]*$/)
  const match = singleLine || multiline
  if (!match || !isSafeDestination(match[2])) return null
  const label = normalizeReferenceLabel(match[1])
  const token = links[label]
  if (!token?.href || token.title) return null
  return { label, url: match[2] }
}

function parseReferenceUse(sourceRange, safeDefinitions) {
  const prefix = sourceRange.startsWith('!') ? '!' : ''
  const open = prefix.length
  if (sourceRange[open] !== '[') return null

  const closeBracket = start => {
    let depth = 0
    for (let index = start + 1; index < sourceRange.length; index += 1) {
      const char = sourceRange[index]
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '[') depth += 1
      else if (char === ']') {
        if (depth === 0) return index
        depth -= 1
      }
    }
    return -1
  }

  const labelEnd = closeBracket(open)
  if (labelEnd < 0) return null
  const label = sourceRange.slice(open + 1, labelEnd)
  const suffix = sourceRange.slice(labelEnd + 1)
  let referenceLabel = label
  if (suffix.startsWith('[')) {
    const referenceEnd = closeBracket(labelEnd + 1)
    if (referenceEnd !== sourceRange.length - 1) return null
    referenceLabel = sourceRange.slice(labelEnd + 2, referenceEnd) || label
  } else if (suffix) {
    return null
  }
  if (!/^[A-Za-z0-9_-]+$/.test(referenceLabel)) return null
  const key = normalizeReferenceLabel(referenceLabel)
  const definition = safeDefinitions.get(key)
  if (!definition) return null
  return { prefix, label, url: definition.url, key }
}

function expandDefinitionRemoval(source, patch) {
  let to = patch.to
  const following = source.slice(to).match(/^\r?\n/)
  if (following) to += following[0].length
  return { ...patch, to }
}

function collapseTrailingDefinitionBlock(source, allDefinitions, removableDefinitions) {
  if (!removableDefinitions.length || removableDefinitions.length !== allDefinitions.length) {
    return removableDefinitions
  }
  const ordered = [...removableDefinitions].sort((left, right) => left.from - right.from)
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = source.slice(ordered[index - 1].to, ordered[index].from)
    if (!/^[\t ]*(?:\r?\n[\t ]*)*$/.test(gap)) return removableDefinitions
  }
  if (!/^\s*$/.test(source.slice(ordered.at(-1).to))) return removableDefinitions

  let from = ordered[0].from
  const preceding = source.slice(0, from).match(/(\r?\n)([\t ]*)(\r?\n)$/)
  if (preceding) from -= preceding[2].length + preceding[3].length
  return [{ from, to: source.length, replacement: '', definitionCount: ordered.length }]
}

function parseAutolink(sourceRange) {
  const uri = sourceRange.match(/^<(https?:\/\/[^<>\s]*)>$/i)
  if (uri) return { text: uri[1], href: `<${uri[1]}>` }
  const email = sourceRange.match(/^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>$/)
  if (email) return { text: email[1], href: `mailto:${email[1]}` }
  return null
}

function applyPatches(source, patches) {
  const ordered = [...patches].sort((left, right) => right.from - left.from || right.to - left.to)
  let previousStart = source.length + 1
  let result = source
  for (const patch of ordered) {
    if (patch.from < 0 || patch.to > source.length || patch.to > previousStart) return null
    result = result.slice(0, patch.from) + patch.replacement + result.slice(patch.to)
    previousStart = patch.from
  }
  return result
}

function hasNoNewDiagnostics(source, candidate, beforeDiagnostics, afterDiagnostics) {
  const counts = (text, diagnostics) => {
    const result = new Map()
    for (const item of diagnostics) {
      const key = `${item.reason}\0${text.slice(item.from, item.to)}`
      result.set(key, (result.get(key) || 0) + 1)
    }
    return result
  }
  const before = counts(source, beforeDiagnostics)
  const after = counts(candidate, afterDiagnostics)
  for (const [key, count] of after) {
    if (count > (before.get(key) || 0)) return false
  }
  return true
}

function buildRepairCandidate(markdown) {
  const source = String(markdown || '')
  const diagnostics = analyzeMarkdownSource(source)
  if (!diagnostics.length) return null

  let links
  try { links = marked.lexer(source).links || Object.create(null) } catch { return null }
  const safeDefinitions = new Map()
  const definitionPatches = []
  for (const item of diagnostics) {
    if (item.reason !== 'referenceLinks') continue
    const sourceRange = source.slice(item.from, item.to)
    const definition = parseSafeReferenceDefinition(sourceRange, links)
    if (!definition) continue
    const previous = safeDefinitions.get(definition.label)
    if (previous) {
      // Duplicate labels make resolution order-sensitive. Leave them intact.
      safeDefinitions.delete(definition.label)
      continue
    }
    safeDefinitions.set(definition.label, definition)
    definitionPatches.push({
      ...expandDefinitionRemoval(source, { from: item.from, to: item.to, replacement: '' }),
      label: definition.label,
    })
  }
  const definitionCounts = new Map()
  for (const patch of definitionPatches) {
    definitionCounts.set(patch.label, (definitionCounts.get(patch.label) || 0) + 1)
  }
  for (const [label, count] of definitionCounts) {
    if (count > 1) safeDefinitions.delete(label)
  }

  const usePatches = []
  let referenceUseCount = 0
  let autolinkCount = 0
  let literalFootnoteMarkerCount = 0
  const convertedLabels = new Set()
  for (const item of diagnostics) {
    const sourceRange = source.slice(item.from, item.to)
    if (item.reason === 'referenceLinks') {
      if (parseSafeReferenceDefinition(sourceRange, links)) continue
      const reference = parseReferenceUse(sourceRange, safeDefinitions)
      if (!reference) continue
      usePatches.push({
        from: item.from,
        to: item.to,
        replacement: `${reference.prefix}[${reference.label}](${reference.url})`,
      })
      referenceUseCount += 1
      convertedLabels.add(reference.key)
    } else if (item.reason === 'autolinks') {
      const autolink = parseAutolink(sourceRange)
      if (!autolink) continue
      usePatches.push({
        from: item.from,
        to: item.to,
        replacement: `[${autolink.text}](${autolink.href})`,
      })
      autolinkCount += 1
    } else if (item.reason === 'literalFootnoteMarker' && /^\[\^[^\]]+\]$/.test(sourceRange)) {
      usePatches.push({
        from: item.from,
        to: item.to,
        replacement: `\\${sourceRange.slice(0, 1)}${sourceRange.slice(1, -1)}\\]`,
      })
      literalFootnoteMarkerCount += 1
    }
  }

  const removableDefinitions = definitionPatches.filter(patch => {
    return convertedLabels.has(patch.label) && safeDefinitions.has(patch.label)
  })
  const definitionRemovalPatches = collapseTrailingDefinitionBlock(source, definitionPatches, removableDefinitions)
  if (!usePatches.length && !definitionRemovalPatches.length) return null
  if (usePatches.length + definitionRemovalPatches.length > MAX_REPAIR_PATCHES) return null

  let candidate = applyPatches(source, usePatches)
  if (candidate === null) return null
  const originalHtml = marked.parse(source)
  if (usePatches.length && marked.parse(candidate) !== originalHtml) return null

  // Batch definition removals into one equivalence check. This keeps opening
  // a large document from reparsing the whole file once per link definition.
  let removedDefinitionCount = 0
  if (definitionRemovalPatches.length) {
    const withDefinitionsRemoved = applyPatches(source, [...usePatches, ...definitionRemovalPatches])
    if (withDefinitionsRemoved === null) return null
    if (marked.parse(withDefinitionsRemoved) === originalHtml) {
      candidate = withDefinitionsRemoved
      removedDefinitionCount = removableDefinitions.length
    }
  }

  if (candidate === source) return null
  const remainingDiagnostics = analyzeMarkdownSource(candidate)
  if (!hasNoNewDiagnostics(source, candidate, diagnostics, remainingDiagnostics)) return null
  const repairableReasons = new Set(['referenceLinks', 'autolinks', 'literalFootnoteMarker'])
  const beforeRepairable = diagnostics.filter(item => repairableReasons.has(item.reason)).length
  const afterRepairable = remainingDiagnostics.filter(item => repairableReasons.has(item.reason)).length
  if (afterRepairable >= beforeRepairable) return null

  return {
    content: candidate,
    referenceUseCount,
    autolinkCount,
    literalFootnoteMarkerCount,
    removedDefinitionCount,
    remainingDiagnostics,
  }
}

/** Return a confirmed-safe repair proposal without changing the input source. */
export function proposeSafeMarkdownRepair(markdown) {
  const source = String(markdown || '')
  const proposal = buildRepairCandidate(source)
  if (!proposal) return null
  const repeated = buildRepairCandidate(proposal.content)
  if (repeated) return null

  const changes = []
  if (proposal.referenceUseCount) {
    changes.push(`将 ${proposal.referenceUseCount} 处引用式链接改为普通链接`)
  }
  if (proposal.removedDefinitionCount) {
    changes.push(`移除 ${proposal.removedDefinitionCount} 条已转换的链接定义`)
  }
  if (proposal.autolinkCount) {
    changes.push(`将 ${proposal.autolinkCount} 个自动链接改为普通链接写法`)
  }
  if (proposal.literalFootnoteMarkerCount) {
    changes.push(`将 ${proposal.literalFootnoteMarkerCount} 个无定义的脚注样式标记转义为普通文本`)
  }

  return {
    content: proposal.content,
    changes,
    remainingDiagnostics: proposal.remainingDiagnostics,
  }
}
