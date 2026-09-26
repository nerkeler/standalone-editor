export const MAX_EDITABLE_MARKDOWN_BYTES = 5 * 1024 * 1024

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value ?? '')).byteLength
}

export function isEditableMarkdownSize(value) {
  return utf8ByteLength(value) <= MAX_EDITABLE_MARKDOWN_BYTES
}
