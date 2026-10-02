export function isSupportedNodeVersion(version) {
  if (typeof version !== 'string') return false
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return Boolean(match && Number(match[1]) === 22 && Number(match[2]) >= 17)
}
