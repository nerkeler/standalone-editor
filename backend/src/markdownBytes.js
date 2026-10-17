// @ts-check
import path from 'path'
import { sha256 } from './hashing.js'
import { makeError, historyCorrupt } from './errors.js'

/** Largest Markdown document the editor will open for editing. */
export const MAX_EDITABLE_MARKDOWN_BYTES = 5 * 1024 * 1024
/** Largest Markdown document eligible for preview/restore listing. */
export const MAX_MARKDOWN_PREVIEW_BYTES = 10 * 1024 * 1024
const MAX_EDITABLE_HISTORY_BASE64_LENGTH = Math.ceil(MAX_EDITABLE_MARKDOWN_BYTES / 3) * 4

/**
 * @param {number} size
 * @returns {import('./errors.js').DomainError}
 */
export function markdownTooLarge(size) {
  const error = makeError('Markdown 文件超过 5 MiB 可编辑上限，请下载或拆分后再编辑', 'DOCUMENT_TOO_LARGE')
  error.details = { size, maxEditableBytes: MAX_EDITABLE_MARKDOWN_BYTES }
  return error
}

/**
 * Decode the base-64 content of a history record, bounding the allocation by
 * both the recorded size and the encoded length before Buffer allocation.
 * @param {string|unknown} contentBase64
 * @param {number|undefined} recordedSize
 * @returns {Buffer}
 */
export function decodeEditableHistoryBytes(contentBase64, recordedSize) {
  if (Number.isSafeInteger(recordedSize) && recordedSize > MAX_EDITABLE_MARKDOWN_BYTES) {
    throw markdownTooLarge(recordedSize)
  }
  if (typeof contentBase64 !== 'string') throw historyCorrupt()
  // Check before Buffer.from: legacy/corrupt history records may omit `size`,
  // so the JSON metadata alone cannot bound the decoded allocation.
  if (contentBase64.length > MAX_EDITABLE_HISTORY_BASE64_LENGTH) {
    throw markdownTooLarge(Math.ceil(contentBase64.length * 3 / 4))
  }
  const bytes = Buffer.from(contentBase64, 'base64')
  if (bytes.byteLength > MAX_EDITABLE_MARKDOWN_BYTES) throw markdownTooLarge(bytes.byteLength)
  return bytes
}

/** Revision hash identity for document content. */
export function contentRevision(content) {
  return sha256(content)
}

/** @param {string} filePath */
export function isMarkdownPath(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return extension === '.md' || extension === '.markdown'
}

/** @param {string} filePath */
export function assertMarkdownPath(filePath) {
  if (!isMarkdownPath(filePath)) {
    throw makeError('只有 .md 和 .markdown 文件可以作为 Markdown 编辑', 'UNSUPPORTED_FILE_TYPE')
  }
}

/**
 * Decode document bytes as strict UTF-8 text, refusing NUL and invalid UTF-8.
 * @param {Buffer|Uint8Array} bytes
 * @returns {string}
 */
export function decodeMarkdownBytes(bytes) {
  let content
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw makeError('Markdown 文件不是有效的 UTF-8 文本', 'INVALID_UTF8')
  }
  if (content.includes('\0')) {
    throw makeError('Markdown 文件包含 NUL 字节，拒绝按文本编辑', 'INVALID_TEXT_FILE')
  }
  return content
}

/**
 * Encode validated document content back to UTF-8 bytes without lossy
 * surrogate replacement.
 * @param {string} content
 * @returns {Buffer}
 */
export function encodeMarkdownContent(content) {
  const bytes = Buffer.from(content, 'utf-8')
  // Buffer replaces unpaired UTF-16 surrogates with U+FFFD. Refuse that
  // lossy conversion so the browser cannot silently alter source text.
  if (bytes.toString('utf-8') !== content) {
    throw makeError('Markdown 内容无法无损编码为 UTF-8', 'INVALID_UTF8')
  }
  if (content.includes('\0')) {
    throw makeError('Markdown 内容不能包含 NUL 字符', 'INVALID_TEXT_FILE')
  }
  return bytes
}
