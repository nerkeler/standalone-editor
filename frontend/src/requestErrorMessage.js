const permissionCodes = new Set(['PERMISSION_DENIED', 'EACCES', 'EPERM', 'EROFS'])

export const PERMISSION_DENIED_MESSAGE = '无权限访问或修改该路径'

export function isPermissionDenied(error) {
  const response = error?.response?.data || error?.data || {}
  return [
    response.code,
    response.systemCode,
    response.causeCode,
    error?.code,
    error?.systemCode,
  ].some(code => permissionCodes.has(code))
}

export function requestErrorMessage(error, fallback = '请求失败') {
  if (isPermissionDenied(error)) return PERMISSION_DENIED_MESSAGE
  return error?.response?.data?.error || error?.message || fallback
}
