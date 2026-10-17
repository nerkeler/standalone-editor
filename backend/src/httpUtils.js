// @ts-check

/**
 * Decode a multipart filename when Busboy's Latin-1 default parameter charset
 * carried UTF-8 bytes from the browser. Genuine Latin-1 names and names
 * already decoded via RFC 5987 are preserved.
 * @param {string} filename
 */
export function normalizeMultipartFilename(filename) {
  if (typeof filename !== 'string' || [...filename].some(char => char.codePointAt(0) > 0xff)) return filename
  const latin1Bytes = Buffer.from(filename, 'latin1')
  const utf8 = latin1Bytes.toString('utf8')
  return Buffer.from(utf8, 'utf8').equals(latin1Bytes) ? utf8 : filename
}

/**
 * Content-Disposition value for a download. Node's HTTP header layer only
 * accepts Latin-1 in the quoted `filename` fallback, so the original UTF-8
 * name travels in the RFC 5987 `filename*` parameter.
 * @param {string} filename
 */
export function contentDispositionFilename(filename) {
  const fallback = filename.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/[\\"\r\n]/g, '_') || 'download'
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
