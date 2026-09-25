const MEDIA_API_PREFIX = '/api/workspace/media/'
const LEGACY_ASSET_PREFIX = '/api/workspace/assets/'

function decodePathname(pathname) {
  const segments = pathname.split('/')
  if (!segments.length || segments.some(segment => segment === '')) return null

  const decoded = []
  try {
    for (const segment of segments) {
      const value = decodeURIComponent(segment)
      if (value.includes('/') || value.includes('\\') || value.includes('\0')) return null
      decoded.push(value)
    }
  } catch {
    return null
  }
  return decoded
}

function isInsideWorkspace(pathname) {
  return pathname !== '.' && pathname !== '..' &&
    !pathname.startsWith('../') && !pathname.startsWith('/')
}

function encodePathname(pathname) {
  return pathname.split('/').map(segment => encodeURIComponent(segment)
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
}

function splitSuffix(reference) {
  const hashIndex = reference.indexOf('#')
  const beforeHash = hashIndex === -1 ? reference : reference.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : reference.slice(hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  return {
    pathname: queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex),
    query: queryIndex === -1 ? '' : beforeHash.slice(queryIndex),
    hash,
  }
}

function canonicalRelativePath(workspacePath, documentPath) {
  const relative = pathRelative(pathDirectory(documentPath), workspacePath)
  return encodePathname(relative || '.')
}

function pathDirectory(documentPath) {
  const value = String(documentPath || '').replaceAll('\\', '/')
  const slash = value.lastIndexOf('/')
  return slash === -1 ? '' : value.slice(0, slash)
}

function pathRelative(from, to) {
  const fromParts = from ? from.split('/').filter(Boolean) : []
  const toParts = to.split('/').filter(Boolean)
  let common = 0
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common += 1
  return [...Array(fromParts.length - common).fill('..'), ...toParts.slice(common)].join('/')
}

function mediaUrl(workspacePath, identity, suffix = { query: '', hash: '' }) {
  const params = new URLSearchParams(suffix.query.replace(/^\?/, ''))
  if (identity?.workspaceId) params.set('workspaceId', identity.workspaceId)
  if (identity?.workspaceVersion != null) params.set('workspaceVersion', String(identity.workspaceVersion))
  const query = params.toString()
  return `${MEDIA_API_PREFIX}${encodePathname(workspacePath)}${query ? `?${query}` : ''}${suffix.hash || ''}`
}

function createReference(workspacePath, documentPath, identity, suffix) {
  const cleanPath = String(workspacePath || '')
  if (cleanPath.includes('\\') || cleanPath.includes('\0') || cleanPath.startsWith('/')) return null
  const segments = cleanPath.split('/')
  if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..')) return null
  const normalizedPath = segments.join('/')
  if (!isInsideWorkspace(normalizedPath)) return null
  return {
    workspacePath: normalizedPath,
    markdownSrc: `${canonicalRelativePath(normalizedPath, documentPath)}${suffix?.query || ''}${suffix?.hash || ''}`,
    url: mediaUrl(normalizedPath, identity, suffix),
  }
}

function legacyAssetPath(pathname) {
  if (!pathname.startsWith(LEGACY_ASSET_PREFIX)) return null
  const segments = decodePathname(pathname.slice(LEGACY_ASSET_PREFIX.length))
  if (!segments || segments.length !== 1 || segments[0] === '.' || segments[0] === '..') return null
  return `assets/${segments[0]}`
}

function removeWorkspaceIdentity(query) {
  const params = new URLSearchParams(query.replace(/^\?/, ''))
  params.delete('workspaceId')
  params.delete('workspaceVersion')
  const remaining = params.toString()
  return remaining ? `?${remaining}` : ''
}

export function isExternalImageReference(source) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(String(source || ''))
}

export function resolveMarkdownImageReference(source, documentPath, identity) {
  const raw = String(source || '')
  if (!raw || isExternalImageReference(raw)) return null
  const { pathname, query, hash } = splitSuffix(raw)

  const legacyPath = legacyAssetPath(pathname)
  if (legacyPath) {
    return createReference(legacyPath, documentPath, identity, { query: removeWorkspaceIdentity(query), hash })
  }
  if (!pathname || pathname.startsWith('/') || pathname.includes('\\')) return null

  const referenceSegments = decodePathname(pathname)
  if (!referenceSegments) return null
  const directory = pathDirectory(documentPath)
  const target = [...(directory ? directory.split('/').filter(Boolean) : []), ...referenceSegments]
  const normalized = []
  for (const segment of target) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!normalized.length) return null
      normalized.pop()
      continue
    }
    normalized.push(segment)
  }
  const workspacePath = normalized.join('/')
  if (!isInsideWorkspace(workspacePath)) return null
  return createReference(workspacePath, documentPath, identity, { query, hash })
}

export function createUploadedImageReference(workspacePath, documentPath, identity) {
  return createReference(workspacePath, documentPath, identity, { query: '', hash: '' })
}
