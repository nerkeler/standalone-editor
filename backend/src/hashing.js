// @ts-check
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * Hex-encoded SHA-256 digest of an in-memory buffer or string.
 * @param {string | Buffer | Uint8Array} value
 * @returns {string}
 */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Hex-encoded SHA-256 digest of a file read in streaming chunks.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
