// @ts-check
import fs from 'fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'path'
import { makeError, conflict } from './errors.js'

/**
 * Canonical workspace root as an absolute realpath.
 * @param {string} workspace
 * @returns {Promise<string>}
 */
export async function workspaceBase(workspace) {
  return fs.realpath(workspace)
}

/**
 * Convert an internal absolute path back to the forward-slash API-relative form.
 * @param {string} base
 * @param {string} full
 */
export function relativePath(base, full) {
  return path.relative(base, full).split(path.sep).join('/')
}

/** @param {string} base @param {string} target */
export function assertInside(base, target) {
  const relative = path.relative(base, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw makeError('路径超出工作空间')
  }
}

/**
 * Validate a single path component name; returns the validated name.
 * @param {string} name
 */
export function assertName(name) {
  if (typeof name !== 'string' || !name.trim()) throw makeError('名称不能为空')
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw makeError('名称只能是单个文件名或目录名')
  }
  return name
}

/**
 * Resolve a request path lexically inside the workspace, rejecting absolute
 * paths, backslashes and NUL before touching the filesystem.
 * @param {string} base
 * @param {string} [requestPath]
 */
export function lexicalPath(base, requestPath = '') {
  if (typeof requestPath !== 'string') throw makeError('路径必须是字符串')
  if (requestPath.includes('\0') || requestPath.includes('\\')) throw makeError('路径格式无效')
  if (path.isAbsolute(requestPath)) throw makeError('路径必须是工作空间内的相对路径')
  const full = path.resolve(base, requestPath || '.')
  assertInside(base, full)
  return full
}

// Resolve an existing path and reject symlinks in the requested path. This
// keeps every file operation inside the canonical workspace, even when a
// user-created symlink points outside it.
/**
 * @typedef {import('fs').Stats | import('fs').BigIntStats} PathStat
 */

/**
 * @param {string} workspace
 * @param {string} requestPath
 * @param {{ allowRoot?: boolean, bigintStat?: boolean }} [options]
 * @returns {Promise<{ base: string, full: string, stat: PathStat }>}
 */
export async function existingPath(workspace, requestPath, { allowRoot = true, bigintStat = false } = {}) {
  const base = await workspaceBase(workspace)
  const full = lexicalPath(base, requestPath)
  if (!allowRoot && full === base) throw makeError('不能操作工作空间根目录')
  const stat = bigintStat ? await fs.lstat(full, { bigint: true }) : await fs.lstat(full)
  if (stat.isSymbolicLink()) throw makeError('不支持通过符号链接访问文件')
  const real = await fs.realpath(full)
  assertInside(base, real)
  if (real !== full) throw makeError('不支持通过符号链接访问文件')
  return { base, full, stat }
}

/**
 * Resolve the parent directory of a request path (which itself must be valid).
 * @param {string} workspace
 * @param {string} requestPath
 */
export async function parentPath(workspace, requestPath) {
  const base = await workspaceBase(workspace)
  const full = lexicalPath(base, requestPath)
  const parent = path.dirname(full)
  // `path.relative` uses backslashes on Windows while API paths deliberately
  // use forward slashes. Convert the internal path before passing it through
  // lexicalPath, which also keeps this working when `base` is `C:\`.
  const parentResult = await existingPath(workspace, relativePath(base, parent), { allowRoot: true })
  if (!parentResult.stat.isDirectory()) throw makeError('目标目录无效')
  return { base, full, parent, parentStat: parentResult.stat }
}

/**
 * Resolve a regular-file location (existing or to be created), verifying the
 * target is not a symlink, directory or special file.
 * @param {string} workspace
 * @param {string} requestPath
 * @param {{ allowMissing?: boolean }} [options]
 */
export async function fileLocation(workspace, requestPath, { allowMissing = false } = {}) {
  const { base, full, parent } = await parentPath(workspace, requestPath)
  const name = assertName(path.basename(full))
  const target = path.join(parent, name)
  assertInside(base, target)
  try {
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink()) throw makeError('不支持通过符号链接访问文件')
    if (stat.isDirectory()) throw makeError('是目录不是文件')
    if (!stat.isFile()) throw makeError('不支持操作特殊文件', 'UNSUPPORTED_FILE_TYPE')
    const real = await fs.realpath(target)
    assertInside(base, real)
    if (real !== target) throw makeError('不支持通过符号链接访问文件')
    return { base, target, parent, stat }
  } catch (error) {
    if (error.code !== 'ENOENT' || !allowMissing) throw error
    return { base, target, parent, stat: null }
  }
}

/**
 * Open a read-only handle after verifying the file's identity did not change
 * since `stat` was observed. The caller owns the returned handle.
 * @param {{ base: string, target: string, stat: import('fs').Stats | import('fs').BigIntStats }} location
 */
export async function openRegularFileHandle({ base, target, stat }) {
  const flags = fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW || 0) |
    (fsConstants.O_NONBLOCK || 0)
  const handle = await fs.open(target, flags)
  try {
    const openedStat = await handle.stat()
    const real = await fs.realpath(target)
    assertInside(base, real)
    if (!openedStat.isFile()) {
      throw makeError('不支持操作特殊文件', 'UNSUPPORTED_FILE_TYPE')
    }
    if (openedStat.dev !== stat.dev || openedStat.ino !== stat.ino || real !== target) {
      throw makeError('文件在读取前已变化', 'INVALID_PATH')
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

/**
 * Read a regular file via an identity-checked handle.
 * @param {{ base: string, target: string, stat: import('fs').Stats | import('fs').BigIntStats }} location
 */
export async function readRegularFile(location) {
  const handle = await openRegularFileHandle(location)
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/**
 * Refuse any pre-existing destination at `filePath` (fail closed on other
 * stat errors).
 * @param {string} filePath
 */
export async function ensureDestinationDoesNotExist(filePath) {
  try {
    await fs.lstat(filePath)
    throw conflict()
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
}
