export function parseImagePresentationComment(text) {
  const match = String(text || '').trim().match(/^se-image:width=(\d{2,3});align=(left|center)$/)
  if (!match) return null
  const width = Number(match[1])
  if (width < 25 || width > 100) return null
  return { width, align: match[2] }
}

export function formatImagePresentationComment(width, align) {
  const safeWidth = Math.max(25, Math.min(100, Number(width) || 100))
  const safeAlign = align === 'center' ? 'center' : 'left'
  if (safeWidth === 100 && safeAlign === 'left') return ''
  return `<!-- se-image:width=${safeWidth};align=${safeAlign} -->`
}
