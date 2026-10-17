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
