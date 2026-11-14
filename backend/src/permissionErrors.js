const FILESYSTEM_PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS'])

export const PERMISSION_DENIED_MESSAGE = '无权限访问或修改该路径'

function filesystemPermissionCode(error) {
  const candidates = [
    error?.code,
    error?.systemCode,
    error?.details?.causeCode,
    error?.cause?.code,
  ]
  return candidates.find(code => FILESYSTEM_PERMISSION_CODES.has(code)) || null
}

export function permissionErrorResponse(error) {
  const systemCode = filesystemPermissionCode(error)
  if (!systemCode && error?.code !== 'PERMISSION_DENIED') return null
  return {
    status: 403,
    body: {
      error: PERMISSION_DENIED_MESSAGE,
      code: 'PERMISSION_DENIED',
      ...(systemCode ? { systemCode } : {}),
    },
  }
}
