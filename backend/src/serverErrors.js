// @ts-check
import multer from 'multer'
import { permissionErrorResponse } from './permissionErrors.js'

/** @typedef {import('./errors.js').DomainError} DomainError */

/**
 * Map a domain error to its HTTP status. Mirrors the error taxonomy shared by
 * every service: codes are declared in errors.js / historyService.js and
 * services may attach `details` alongside them.
 * @param {unknown} error
 * @returns {number}
 */
export function errorStatus(error) {
  const permissionFailure = permissionErrorResponse(error)
  if (permissionFailure) return permissionFailure.status
  const code = /** @type {DomainError} */ (error)?.code
  if (error instanceof multer.MulterError) {
    const multerCode = /** @type {import('multer').MulterError} */ (error).code
    return multerCode?.startsWith('LIMIT_') && multerCode !== 'LIMIT_UNEXPECTED_FILE' ? 413 : 400
  }
  if (
    code === 'CONFLICT' || code === 'FILE_CONFLICT' ||
    code === 'HISTORY_CONFLICT' || code === 'WORKSPACE_MISMATCH' ||
    code === 'TRASH_OPERATION_PENDING'
  ) return 409
  if (code === 'REVISION_REQUIRED') return 428
  if (code === 'ENOENT' || code === 'HISTORY_NOT_FOUND') return 404
  if (code === 'DOCUMENT_TOO_LARGE' || code === 'ZIP_LIMIT') return 413
  if (code === 'FILE_CHANGED') return 409
  if (
    code === 'RECOVERY_STORAGE_ERROR' || code === 'HISTORY_CORRUPT' ||
    code === 'HISTORY_ROLLBACK_FAILED' || code === 'HISTORY_ARCHIVE_ROLLBACK_FAILED' ||
    code === 'MOVE_ROLLBACK_FAILED' || code === 'TRASH_ROLLBACK_FAILED' ||
    code === 'WORKSPACE_CONFIG_SAVE_FAILED' ||
    code === 'UNSUPPORTED_UPLOAD_FILESYSTEM' || code === 'UPLOAD_INCOMPLETE' ||
    code === 'UPLOAD_VERIFY_FAILED' || code === 'TEMPORARY_IDENTITY_UNAVAILABLE'
  ) return 500
  if (code === 'ENOSPC' || code === 'EDQUOT') return 507
  if (
    code === 'EIO' || code === 'EFBIG' ||
    code === 'EMFILE' || code === 'ENFILE' || code === 'ENXIO' ||
    code === 'ENODEV'
  ) return 500
  return 400
}
