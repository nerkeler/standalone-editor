// @ts-check

/**
 * An Error carrying a stable machine-readable code and optional structured
 * details. Every backend service factory produces this shape, and API error
 * mapping (see serverRuntime / index errorStatus) switches on `code`.
 *
 * @typedef {Error & {
 *   code?: string,
 *   details?: Record<string, unknown>,
 * }} DomainError
 */

/**
 * Create an Error tagged with a machine-readable code. The default matches the
 * historical catch-all used by workspace path helpers.
 * @param {string} message
 * @param {string} [code]
 * @returns {DomainError}
 */
export function makeError(message, code = 'INVALID_PATH') {
  const error = /** @type {DomainError} */ (new Error(message))
  error.code = code
  return error
}

/**
 * Create an Error that records the machine-readable code of the underlying
 * cause without leaking the full reason across the module boundary.
 * @param {string} message
 * @param {string} code
 * @param {unknown} cause
 * @returns {DomainError}
 */
export function makeCausedError(message, code, cause) {
  const error = makeError(message, code)
  error.details = { causeCode: /** @type {Error & { code?: string }} */ (cause)?.code }
  return error
}

/**
 * Generic destination-exists error shared by create/move/upload paths.
 * @param {string} [message]
 * @returns {DomainError}
 */
export function conflict(message = '目标已存在') {
  return makeError(message, 'CONFLICT')
}

/**
 * Versioned writes demand an explicit expectedRevision.
 * @returns {DomainError}
 */
export function revisionRequired() {
  return makeError('保存时必须提供 expectedRevision', 'REVISION_REQUIRED')
}

/**
 * A history record is absent or expired once its bucket can no longer prove
 * it belongs to the requested path.
 * @returns {DomainError}
 */
export function historyNotFound() {
  return makeError('历史版本不存在或已过期', 'HISTORY_NOT_FOUND')
}

/**
 * A history record exists but failed its content/ownership verification.
 * @returns {DomainError}
 */
export function historyCorrupt() {
  return makeError('历史版本校验失败', 'HISTORY_CORRUPT')
}
