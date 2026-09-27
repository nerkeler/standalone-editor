import { analyzeMarkdownSource } from './markdownDiagnostics.js'

export function getMarkdownSourceModeReasons(markdown) {
  return [...new Set(analyzeMarkdownSource(markdown).map(item => item.reason))]
}

export function requiresSourceMode(markdown) {
  return analyzeMarkdownSource(markdown).length > 0
}
