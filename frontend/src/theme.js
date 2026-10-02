import { readStorage } from './safeStorage.js'

export const THEME_KEY = 'editor_theme'

export function getInitialTheme() {
  const saved = readStorage(THEME_KEY)
  if (saved.ok && (saved.value === 'light' || saved.value === 'dark')) return saved.value
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function applyTheme(theme) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}
