import { marked } from 'marked'
import { analyzeMarkdownSource } from './markdownDiagnostics.js'

/** Deliberately narrow: a single simple reference link and its definition.
 * Both renderings must be byte-for-byte identical HTML before a CAS save. */
export function normalizeSafeMarkdown(markdown) {
  const source = String(markdown || '')
  const reasons = analyzeMarkdownSource(source)
  if (!reasons.length || reasons.some(item => item.reason !== 'referenceLinks')) return null
  const match = source.match(/^(\[[^\]\n]+\])\[([A-Za-z0-9_-]+)\](\r?\n\r?\n)\[\2\]:[ \t]*(https?:\/\/[^\s<>"']+)[ \t]*(\r?\n?)$/)
  if (!match) return null
  const candidate = `${match[1]}(${match[4]})${match[5]}`
  if (candidate === source || analyzeMarkdownSource(candidate).length) return null
  if (marked.parse(candidate) !== marked.parse(source)) return null
  return candidate
}
