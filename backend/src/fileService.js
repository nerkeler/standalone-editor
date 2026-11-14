import fs from 'fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'path'
import os from 'os'
import { Readable } from 'node:stream'
import { createHash, randomUUID } from 'crypto'
import { extractMarkdownReferences, resolveWorkspaceReference } from './markdownMoveImpact.js'
import { assertSameEntry, moveEntryNoReplace, openWorkspaceParent } from './workspacePathGuard.js'

const IMAGE_MIMES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  tif: 'image/tiff',
}

export const MAX_EDITABLE_MARKDOWN_BYTES = 5 * 1024 * 1024
export const MAX_MARKDOWN_PREVIEW_BYTES = 10 * 1024 * 1024
const MAX_EDITABLE_HISTORY_BASE64_LENGTH = Math.ceil(MAX_EDITABLE_MARKDOWN_BYTES / 3) * 4

function markdownTooLarge(size) {
  const error = makeError('Markdown 文件超过 5 MiB 可编辑上限，请下载或拆分后再编辑', 'DOCUMENT_TOO_LARGE')
  error.details = { size, maxEditableBytes: MAX_EDITABLE_MARKDOWN_BYTES }
  return error
}

function decodeEditableHistoryBytes(contentBase64, recordedSize) {
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

function makeError(message, code = 'INVALID_PATH') {
  const error = new Error(message)
  error.code = code
  return error
}

function makeCausedError(message, code, cause) {
  const error = makeError(message, code)
  error.details = { causeCode: cause?.code }
  return error
}

function reportRecoveryCleanupWarning(options, reqPath, error, { saveCommitted = true } = {}) {
  const code = typeof error?.code === 'string' ? error.code : 'RECOVERY_CLEANUP_FAILED'
  const warning = {
    code,
    message: saveCommitted
      ? '恢复历史清理未完成，当前保存已成功。后续保存时会再次尝试清理。'
      : '未能清理恢复历史记录，原记录已保留以避免误删。',
  }
  const logger = typeof options?.logger?.warn === 'function' ? options.logger : console
  try {
    const logged = logger.warn({ event: 'recovery_history_cleanup_failed', path: reqPath, code })
    if (logged && typeof logged.catch === 'function') logged.catch(() => {})
  } catch {
    // Logging is diagnostic only. It must not change the result of a save that
    // has already committed to disk.
  }
  return warning
}

function recoveryCleanupFailure(message, code = 'RECOVERY_CLEANUP_FAILED') {
  return makeError(message, code)
}

function conflict(message = '目标已存在') {
  return makeError(message, 'CONFLICT')
}

function revisionRequired() {
  return makeError('保存时必须提供 expectedRevision', 'REVISION_REQUIRED')
}

function fileConflict(reqPath, expectedRevision, currentBytes) {
  const error = makeError('文件已在其他位置修改，请先处理版本冲突', 'FILE_CONFLICT')
  error.details = {
    path: reqPath,
    expectedRevision,
    currentRevision: currentBytes == null ? null : contentRevision(currentBytes),
    currentContent: currentBytes == null ? null : decodeMarkdownBytes(currentBytes),
  }
  return error
}

function contentRevision(content) {
  return createHash('sha256').update(content).digest('hex')
}

function isMarkdownPath(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return extension === '.md' || extension === '.markdown'
}

function assertMarkdownPath(filePath) {
  if (!isMarkdownPath(filePath)) {
    throw makeError('只有 .md 和 .markdown 文件可以作为 Markdown 编辑', 'UNSUPPORTED_FILE_TYPE')
  }
}

function decodeMarkdownBytes(bytes) {
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

function encodeMarkdownContent(content) {
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

function assertInside(base, target) {
  const relative = path.relative(base, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw makeError('路径超出工作空间')
  }
}

function assertName(name) {
  if (typeof name !== 'string' || !name.trim()) throw makeError('名称不能为空')
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw makeError('名称只能是单个文件名或目录名')
  }
  return name
}

function lexicalPath(base, requestPath = '') {
  if (typeof requestPath !== 'string') throw makeError('路径必须是字符串')
  if (requestPath.includes('\0') || requestPath.includes('\\')) throw makeError('路径格式无效')
  if (path.isAbsolute(requestPath)) throw makeError('路径必须是工作空间内的相对路径')
  const full = path.resolve(base, requestPath || '.')
  assertInside(base, full)
  return full
}

async function workspaceBase(workspace) {
  return fs.realpath(workspace)
}

// Resolve an existing path and reject symlinks in the requested path. This
// keeps every file operation inside the canonical workspace, even when a
// user-created symlink points outside it.
async function existingPath(workspace, requestPath, { allowRoot = true, bigintStat = false } = {}) {
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

async function parentPath(workspace, requestPath) {
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

async function fileLocation(workspace, requestPath, { allowMissing = false } = {}) {
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

async function openRegularFileHandle({ base, target, stat }) {
  const flags = fsConstants.O_RDONLY |
    (fsConstants.O_NONBLOCK || 0) |
    (fsConstants.O_NOFOLLOW || 0)
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

async function readRegularFile(location) {
  const handle = await openRegularFileHandle(location)
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function ensureDestinationDoesNotExist(filePath) {
  try {
    await fs.lstat(filePath)
    throw conflict()
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
}

function relativePath(base, full) {
  return path.relative(base, full).split(path.sep).join('/')
}

// 列出目录树的一层（扁平列表，附带 type 和 path）
export async function listDir(workspace, reqPath = '') {
  const { base, full } = await existingPath(workspace, reqPath)
  const entries = await fs.readdir(full, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const entryPath = path.join(full, entry.name)
    const stat = await fs.lstat(entryPath)
    // Symlinks are intentionally omitted from the tree. Following one would
    // make a later read or delete depend on a path outside the workspace.
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue
    result.push({
      name: entry.name,
      type: stat.isDirectory() ? 'dir' : 'file',
      path: relativePath(base, entryPath),
    })
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return result
}

// 列出完整目录树，供刷新和“全部展开”使用。
export async function listTree(workspace) {
  const { base, full } = await existingPath(workspace, '')
  const result = []
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      // A child that cannot be read should not make the entire workspace
      // appear unavailable. Root access still needs to fail visibly.
      if (dir !== full && ['EACCES', 'EPERM'].includes(error.code)) return
      throw error
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const entryPath = path.join(dir, entry.name)
      // Dirent already carries the common file types from readdir. Avoid a
      // separate lstat for every regular file; unknown and special entries are
      // checked below and omitted from the user-facing tree.
      if (entry.isSymbolicLink()) continue
      let type
      if (entry.isDirectory()) {
        // Recheck directories just before descending: if a directory was
        // replaced with a symlink after readdir, do not traverse its target.
        const stat = await fs.lstat(entryPath)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) type = 'dir'
        else if (stat.isFile()) type = 'file'
        else continue
      } else if (entry.isFile()) {
        type = 'file'
      } else {
        const stat = await fs.lstat(entryPath)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) type = 'dir'
        else if (stat.isFile()) type = 'file'
        else continue
      }
      const item = {
        name: entry.name,
        type,
        path: relativePath(base, entryPath),
      }
      result.push(item)
      if (type === 'dir') await walk(entryPath)
    }
  }
  await walk(full)
  return result
}

// 读取文件内容
export async function readFile(workspace, reqPath) {
  assertMarkdownPath(reqPath)
  const location = await fileLocation(workspace, reqPath)
  const { stat } = location
  if (!stat) throw makeError('文件不存在', 'ENOENT')
  const handle = await openRegularFileHandle(location)
  try {
    const openedStat = await handle.stat()
    const size = openedStat.size
    const editable = size <= MAX_EDITABLE_MARKDOWN_BYTES
    if (size > MAX_MARKDOWN_PREVIEW_BYTES) {
      return {
        content: null,
        revision: null,
        size,
        editable: false,
        previewAvailable: false,
        maxEditableBytes: MAX_EDITABLE_MARKDOWN_BYTES,
      }
    }

    // Allocate at most one byte beyond the read-only preview boundary. This
    // detects a file that grew after lstat without allowing that race to turn
    // a bounded preview into an unbounded read.
    const buffer = Buffer.allocUnsafe(Math.min(size + 1, MAX_MARKDOWN_PREVIEW_BYTES + 1))
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!result.bytesRead) break
      bytesRead += result.bytesRead
    }
    const latestStat = await handle.stat()
    if (bytesRead > MAX_MARKDOWN_PREVIEW_BYTES || latestStat.size > MAX_MARKDOWN_PREVIEW_BYTES) {
      return {
        content: null,
        revision: null,
        size: latestStat.size,
        editable: false,
        previewAvailable: false,
        maxEditableBytes: MAX_EDITABLE_MARKDOWN_BYTES,
      }
    }
    const bytes = buffer.subarray(0, bytesRead)
    if (latestStat.size !== bytesRead) throw makeError('文件在读取时已变化，请重新打开', 'FILE_CHANGED')
    return {
      content: decodeMarkdownBytes(bytes),
      revision: contentRevision(bytes),
      size: bytes.byteLength,
      editable,
      previewAvailable: true,
      maxEditableBytes: MAX_EDITABLE_MARKDOWN_BYTES,
    }
  } finally {
    await handle.close()
  }
}

// Compatibility for older clients of /api/workspace/image. The editor uses
// the streaming media endpoint; this JSON shape remains available to clients
// that still expect { mime, data, name }.
export async function readFileBase64(workspace, reqPath) {
  const location = await existingPath(workspace, reqPath)
  const { base, full, stat } = location
  if (!stat.isFile()) throw makeError('不是普通文件', 'UNSUPPORTED_FILE_TYPE')
  const ext = path.extname(full).toLowerCase().slice(1)
  const mime = IMAGE_MIMES[ext]
  if (!mime) throw makeError('只允许读取图片文件', 'UNSUPPORTED_FILE_TYPE')
  const buffer = await readRegularFile({ base, target: full, stat })
  return { mime, data: buffer.toString('base64'), name: path.basename(full) }
}

// Open a regular workspace file as a byte stream. Workspace identity is
// checked by the route and the path is resolved here without following a
// symlink. Keeping the file handle open also lets the route stream large files.
export async function openBinaryFile(workspace, reqPath, { imagesOnly = false } = {}) {
  if (typeof reqPath !== 'string') throw makeError('路径必须是字符串')
  const { base, full, stat } = await existingPath(workspace, reqPath)
  if (!stat.isFile()) throw makeError('不是普通文件', 'UNSUPPORTED_FILE_TYPE')
  const extension = path.extname(full).toLowerCase().slice(1)
  const mime = IMAGE_MIMES[extension]
  if (imagesOnly && !mime) throw makeError('只允许读取图片文件', 'UNSUPPORTED_FILE_TYPE')
  const handle = await openRegularFileHandle({ base, target: full, stat })
  try {
    const openedStat = await handle.stat()
    if (openedStat.size === 0) {
      // A regular read stream with end: 0 may read a byte appended after this
      // stat. Close the descriptor now and return a genuinely empty stream.
      await handle.close()
      return {
        stream: Readable.from([]),
        size: 0,
        name: path.basename(full),
        ...(imagesOnly ? { mime } : {}),
      }
    }
    return {
      // FileHandle streams use an inclusive end offset. Bound reads to the
      // size observed on the opened descriptor so a concurrent append cannot
      // exceed the response's Content-Length.
      stream: handle.createReadStream({ autoClose: true, start: 0, end: openedStat.size - 1 }),
      size: openedStat.size,
      name: path.basename(full),
      ...(imagesOnly ? { mime } : {}),
    }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

// 创建文件或目录，永远不覆盖已有目标。
export async function createItem(workspace, reqPath, type, name, options = {}) {
  const cleanName = assertName(name)
  if (type !== 'file' && type !== 'dir') throw makeError('type 必须是 file 或 dir')
  const { base, full: targetDir } = await existingPath(workspace, reqPath || '')
  const targetDirStat = await fs.lstat(targetDir)
  if (!targetDirStat.isDirectory()) throw makeError('目标目录无效')
  const newPath = path.join(targetDir, cleanName)
  assertInside(base, newPath)
  const guard = await openWorkspaceParent(base, newPath, makeError)
  try {
    await ensureDestinationDoesNotExist(newPath)
    if (type === 'file' && isMarkdownPath(cleanName)) {
      await archiveHistoryAtPath(base, newPath, { ...options, reason: 'path-reused' })
    }
    await guard.check()
    await assertSameEntry(targetDir, targetDirStat, makeError)
    if (type === 'dir') {
      await fs.mkdir(newPath)
    } else {
      const handle = await fs.open(newPath, 'wx')
      await handle.close()
    }
    return { path: relativePath(base, newPath), type, name: cleanName }
  } finally {
    await guard.close()
  }
}

// 删除文件或目录。工作空间根目录不可删除。
export async function deleteItem(workspace, reqPath) {
  const { base, full, stat } = await existingPath(workspace, reqPath, { allowRoot: false })
  const guard = await openWorkspaceParent(base, full, makeError)
  try {
    if (stat.isDirectory()) {
      await archiveHistoryAtPath(base, full, { reason: 'deleted', includeDescendants: true })
    } else if (stat.isFile() && isMarkdownPath(full)) {
      await archiveHistoryAtPath(base, full, { reason: 'deleted' })
    }
    await guard.check()
    await assertSameEntry(full, stat, makeError)
    await fs.rm(full, { recursive: stat.isDirectory(), force: false })
    return { success: true }
  } finally {
    await guard.close()
  }
}

// 移动/重命名，目标存在时返回冲突，不覆盖目标。
export async function moveItem(workspace, oldPath, newPath, options = {}) {
  const source = await existingPath(workspace, oldPath, { allowRoot: false, bigintStat: true })
  const destination = await parentPath(workspace, newPath)
  const newName = assertName(path.basename(destination.full))
  const dest = path.join(destination.parent, newName)
  assertInside(destination.base, dest)
  if (dest === source.full) return { success: true }
  const sourceRelative = path.relative(source.full, dest)
  const destInsideSource = sourceRelative !== '' &&
    sourceRelative !== '..' &&
    !sourceRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(sourceRelative)
  if (source.stat.isDirectory() && destInsideSource) {
    throw makeError('不能移动到自己的子目录')
  }
  const sourceGuard = await openWorkspaceParent(source.base, source.full, makeError)
  let destinationGuard
  try {
    destinationGuard = await openWorkspaceParent(destination.base, dest, makeError)
    await ensureDestinationDoesNotExist(dest)
    const filesToMove = await collectRegularFiles(source.full, source.stat)
    const displacedHistory = await archiveHistoryAtPath(source.base, dest, {
      ...options,
      reason: 'path-reused',
      includeDescendants: source.stat.isDirectory(),
    })
    const checkParents = async () => {
      await sourceGuard.check()
      await destinationGuard.check()
    }
    let itemMoved = false
    try {
      await moveEntryNoReplace(source.full, dest, source.stat, {
        check: checkParents, errorFactory: makeError, conflictFactory: conflict, link: options.linkFile,
      })
      itemMoved = true
      await migrateHistoryForMove(source.base, source.full, dest, source.stat.isDirectory(), filesToMove, options)
    } catch (error) {
      if (itemMoved) {
        try {
          const movedStat = await fs.lstat(dest, { bigint: true })
          await moveEntryNoReplace(dest, source.full, movedStat, {
            check: checkParents, errorFactory: makeError, conflictFactory: conflict, link: options.linkFile,
          })
        } catch (rollbackError) {
          const rollbackFailure = makeError(
            `文件已移动，但恢复原路径失败：${rollbackError.message}`,
            'MOVE_ROLLBACK_FAILED',
          )
          rollbackFailure.cause = error
          throw rollbackFailure
        }
      }
      if (displacedHistory.length) {
        const historyRollback = await reattachHistoryArchives(source.base, displacedHistory.map(item => item.id), options)
        if (historyRollback.retained > 0) {
          const failure = makeError(
            '移动失败；目标路径旧历史已安全保留在孤儿历史中，无法自动重挂',
            'HISTORY_ARCHIVE_ROLLBACK_FAILED',
          )
          failure.cause = error
          failure.details = { orphanHistoryIds: displacedHistory.map(item => item.id) }
          throw failure
        }
      }
      throw error
    }
    return { success: true }
  } finally {
    await destinationGuard?.close()
    await sourceGuard.close()
  }
}

function remapMovedPath(value, oldPath, newPath) {
  if (value === oldPath) return newPath
  if (value.startsWith(`${oldPath}/`)) return `${newPath}${value.slice(oldPath.length)}`
  return value
}

async function collectMarkdownPaths(workspace, directory, paths) {
  const { base, full } = await existingPath(workspace, directory)
  const entries = await fs.readdir(full, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(full, entry.name)
    let stat
    try {
      stat = await fs.lstat(entryPath)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      await collectMarkdownPaths(workspace, relativePath(base, entryPath), paths)
    } else if (stat.isFile() && isMarkdownPath(entryPath)) {
      paths.push(relativePath(base, entryPath))
    }
  }
}

async function workspaceTargetExists(workspace, targetPath) {
  try {
    const { stat } = await existingPath(workspace, targetPath)
    return stat.isFile() || stat.isDirectory()
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'INVALID_PATH') return false
    throw error
  }
}

// Read-only preflight for a move. It reports Markdown links and images whose
// workspace-relative target changes after the move. Markdown bytes are never
// rewritten here; callers must ask before carrying out any reported move.
export async function getMoveReferenceImpacts(workspace, oldPath, newPath) {
  const source = await existingPath(workspace, oldPath, { allowRoot: false })
  const destination = await parentPath(workspace, newPath)
  const newName = assertName(path.basename(destination.full))
  const dest = path.join(destination.parent, newName)
  assertInside(destination.base, dest)
  if (dest === source.full) return { impacts: [], unscannedMarkdownFiles: [] }

  const sourceRelative = path.relative(source.full, dest)
  const destInsideSource = sourceRelative !== '' && sourceRelative !== '..' &&
    !sourceRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(sourceRelative)
  if (source.stat.isDirectory() && destInsideSource) throw makeError('不能移动到自己的子目录')
  await ensureDestinationDoesNotExist(dest)

  const oldRelative = relativePath(source.base, source.full)
  const newRelative = relativePath(source.base, dest)
  const markdownPaths = []
  await collectMarkdownPaths(workspace, '', markdownPaths)
  markdownPaths.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  const impacts = []
  const unscannedMarkdownFiles = []

  for (const documentPath of markdownPaths) {
    let content
    try {
      ({ content } = await readFile(workspace, documentPath))
    } catch (error) {
      if (error.code === 'INVALID_UTF8' || error.code === 'INVALID_TEXT_FILE') {
        unscannedMarkdownFiles.push(documentPath)
        continue
      }
      throw error
    }
    if (typeof content !== 'string') {
      unscannedMarkdownFiles.push(documentPath)
      continue
    }
    const documentAfterPath = remapMovedPath(documentPath, oldRelative, newRelative)
    for (const reference of extractMarkdownReferences(content)) {
      const targetPath = resolveWorkspaceReference(documentPath, reference.destination)
      if (!targetPath || !(await workspaceTargetExists(workspace, targetPath))) continue
      const expectedTargetPath = remapMovedPath(targetPath, oldRelative, newRelative)
      const actualTargetPath = resolveWorkspaceReference(documentAfterPath, reference.destination)
      if (actualTargetPath === expectedTargetPath) continue
      impacts.push({
        documentPath,
        documentAfterPath,
        kind: reference.kind,
        reference: reference.destination,
        targetPath,
        expectedTargetPath,
      })
    }
  }

  return { impacts, unscannedMarkdownFiles }
}

const HISTORY_RETENTION_PER_FILE = 50
const HISTORY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function recoveryRoot(override) {
  return path.resolve(override || process.env.EDITOR_RECOVERY_DIR || path.join(os.homedir(), '.standalone-editor', 'recovery'))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function canonicalProjectedPath(target) {
  let current = path.resolve(target)
  const missingParts = []
  while (true) {
    try {
      const canonical = await fs.realpath(current)
      return path.resolve(canonical, ...missingParts)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missingParts.unshift(path.basename(current))
      current = parent
    }
  }
}

async function historyBucket(base, target, root) {
  const relative = relativePath(base, target)
  const recovery = await canonicalProjectedPath(recoveryRoot(root))
  const recoveryRelative = path.relative(base, recovery)
  const isInsideWorkspace = recoveryRelative === '' || (
    recoveryRelative !== '..' &&
    !recoveryRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(recoveryRelative)
  )
  if (isInsideWorkspace) throw makeError('恢复历史目录必须位于工作空间之外', 'RECOVERY_STORAGE_ERROR')
  const workspaceKey = sha256(base)
  const fileKey = sha256(relative)
  return { relative, recovery, bucket: path.join(recovery, 'history', workspaceKey, fileKey) }
}

// History lives outside the workspace, but its bucket hierarchy is still
// mutable filesystem state. Check each component without following symlinks
// before a destructive operation so a redirected bucket cannot target a
// different workspace's records.
async function historyBucketIsSafe(recovery, bucket) {
  const relative = path.relative(recovery, bucket)
  if (
    !relative || relative === '..' || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw makeError('恢复历史目录路径无效', 'RECOVERY_STORAGE_ERROR')
  }

  const components = relative.split(path.sep)
  let current = recovery
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component)
    let stat
    try {
      stat = await fs.lstat(current)
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw makeCausedError(`恢复历史目录不可用：${error.message}`, 'RECOVERY_STORAGE_ERROR', error)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw makeError('恢复历史目录不可用：路径包含非目录或符号链接', 'RECOVERY_STORAGE_ERROR')
    }
  }
  return true
}

function historyNotFound() {
  return makeError('历史版本不存在或已过期', 'HISTORY_NOT_FOUND')
}

function historyCorrupt() {
  return makeError('历史版本校验失败', 'HISTORY_CORRUPT')
}

function isWorkspaceRelativeHistoryPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) return false
  if (value.startsWith('/') || path.posix.isAbsolute(value)) return false
  const normalized = path.posix.normalize(value)
  return normalized === value && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../')
}

async function ensurePrivateDirectory(dir) {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('不是普通目录')
    await fs.chmod(dir, 0o700)
  } catch (error) {
    throw makeCausedError(`恢复历史目录不可用：${error.message}`, 'RECOVERY_STORAGE_ERROR', error)
  }
}

async function storeHistory(workspace, base, target, bytes, { root } = {}) {
  const { relative, bucket, recovery } = await historyBucket(base, target, root)
  const historyRoot = path.dirname(path.dirname(bucket))
  const workspaceDir = path.dirname(bucket)
  await ensurePrivateDirectory(recovery)
  await ensurePrivateDirectory(historyRoot)
  await ensurePrivateDirectory(workspaceDir)
  await ensurePrivateDirectory(bucket)
  if (!await historyBucketIsSafe(recovery, bucket)) {
    throw makeError('恢复历史目录不可用', 'RECOVERY_STORAGE_ERROR')
  }

  const revision = contentRevision(bytes)
  // Recovery stores content snapshots, so reuse an already-validated copy of
  // the current bytes only when it is the newest valid snapshot. That covers
  // a prior failed write whose cleanup could not safely remove its entry,
  // without making an older A snapshot stand in for a newer A -> B -> A save.
  for (const prior of await listHistoryInBucket(bucket, relative)) {
    try {
      const validated = await readHistoryEntry(workspace, base, target, prior.id, { root })
      if (validated.bytes.equals(bytes) && prior.revision === revision) {
        return { ...prior, bucket, recovery, relative, created: false }
      }
    } catch (error) {
      if (!['HISTORY_NOT_FOUND', 'HISTORY_CORRUPT', 'DOCUMENT_TOO_LARGE'].includes(error.code)) throw error
      continue
    }
    break
  }

  const savedAt = new Date().toISOString()
  const id = randomUUID()
  const entry = {
    version: 1,
    id,
    path: relative,
    revision,
    savedAt,
    size: bytes.byteLength,
    contentBase64: bytes.toString('base64'),
  }
  const temporary = path.join(bucket, `.${id}.tmp`)
  const destination = path.join(bucket, `${id}.json`)
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(entry), 'utf-8') } finally { await handle.close() }
    await fs.chmod(temporary, 0o600)
    // link provides exclusive creation, unlike rename which could replace an
    // existing history record if its destination were ever reused.
    await fs.link(temporary, destination)
    await fs.unlink(temporary)
  } catch (error) {
    try { await fs.unlink(temporary) } catch {}
    throw makeCausedError(`无法保存文件恢复历史：${error.message}`, 'RECOVERY_STORAGE_ERROR', error)
  }

  return { id, revision: entry.revision, savedAt, size: entry.size, bucket, recovery, relative, created: true }
}

// Retention is a post-commit operation. The previous file must be captured
// before replacement, but pruning before replacement can destroy an older
// recovery point even when opening or syncing the replacement later fails.
async function pruneHistory(workspace, base, target, { root } = {}, preserveId = null) {
  const { bucket, recovery } = await historyBucket(base, target, root)
  if (!await historyBucketIsSafe(recovery, bucket)) {
    throw recoveryCleanupFailure('恢复历史目录安全性无法确认')
  }
  const entries = []
  for (const name of (await fs.readdir(bucket)).filter(item =>
    item.endsWith('.json') && HISTORY_ID_PATTERN.test(item.slice(0, -'.json'.length)))) {
    const entryPath = path.join(bucket, name)
    let stat
    try {
      stat = await fs.lstat(entryPath, { bigint: true })
    } catch (error) {
      // Another cleanup can remove an entry after readdir; that is already
      // the desired result. Other per-record failures must remain visible.
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw recoveryCleanupFailure('恢复历史目录包含无法安全清理的记录', 'RECOVERY_HISTORY_RECORD_INVALID')
    }

    let bytes
    let entry
    try {
      bytes = await fs.readFile(entryPath)
      entry = JSON.parse(bytes.toString('utf-8'))
    } catch (error) {
      throw makeCausedError('恢复历史记录无法读取或解析', 'RECOVERY_HISTORY_RECORD_INVALID', error)
    }
    if (typeof entry?.savedAt !== 'string' || !Number.isFinite(Date.parse(entry.savedAt))) {
      throw recoveryCleanupFailure('恢复历史记录的保存时间无效', 'RECOVERY_HISTORY_RECORD_INVALID')
    }
    entries.push({ name, savedAt: entry.savedAt, stat, bytes })
  }
  entries.sort((a, b) => a.savedAt.localeCompare(b.savedAt))
  const excess = entries.length - HISTORY_RETENTION_PER_FILE
  if (excess > 0) {
    const oldest = entries.filter(entry => entry.name !== `${preserveId}.json`)
    for (const entry of oldest.slice(0, excess)) {
      if (!await historyBucketIsSafe(recovery, bucket)) {
        throw recoveryCleanupFailure('恢复历史目录在清理时已变化')
      }
      const entryPath = path.join(bucket, entry.name)
      const currentStat = await fs.lstat(entryPath, { bigint: true }).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!currentStat) continue
      if (
        !currentStat.isFile() || currentStat.isSymbolicLink() ||
        currentStat.dev !== entry.stat.dev || currentStat.ino !== entry.stat.ino
      ) {
        throw recoveryCleanupFailure('恢复历史记录在清理时已变化', 'RECOVERY_RECORD_CHANGED')
      }
      const currentBytes = await fs.readFile(entryPath)
      if (!currentBytes.equals(entry.bytes)) {
        throw recoveryCleanupFailure('恢复历史记录在清理时已变化', 'RECOVERY_RECORD_CHANGED')
      }
      await fs.unlink(entryPath)
    }
  }
}

async function discardStoredHistory(stored) {
  if (!stored?.created) return null
  const entryPath = path.join(stored.bucket, `${stored.id}.json`)
  try {
    if (!await historyBucketIsSafe(stored.recovery, stored.bucket)) {
      throw recoveryCleanupFailure('恢复历史目录安全性无法确认')
    }
    let recordStat
    let recordBytes
    try {
      recordStat = await fs.lstat(entryPath, { bigint: true })
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    if (!recordStat.isFile() || recordStat.isSymbolicLink()) {
      throw recoveryCleanupFailure('恢复历史记录类型无法安全清理', 'RECOVERY_HISTORY_RECORD_INVALID')
    }
    try {
      recordBytes = await fs.readFile(entryPath)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    let entry
    try {
      entry = JSON.parse(recordBytes.toString('utf-8'))
    } catch (error) {
      throw makeCausedError('恢复历史记录无法解析', 'RECOVERY_HISTORY_RECORD_INVALID', error)
    }
    if (
      entry?.version !== 1 || entry.id !== stored.id || entry.path !== stored.relative ||
      entry.revision !== stored.revision || !Number.isSafeInteger(entry.size) ||
      typeof entry.contentBase64 !== 'string'
    ) {
      throw recoveryCleanupFailure('恢复历史记录内容无效', 'RECOVERY_HISTORY_RECORD_INVALID')
    }
    const bytes = decodeEditableHistoryBytes(entry.contentBase64, entry.size)
    if (contentRevision(bytes) !== stored.revision) {
      throw recoveryCleanupFailure('恢复历史记录校验失败', 'HISTORY_CORRUPT')
    }

    // Mirror deleteFileHistory's fail-closed unlink checks: validate the
    // complete bucket path again and refuse to unlink if either the entry
    // inode or its bytes changed while cleanup was preparing.
    if (!await historyBucketIsSafe(stored.recovery, stored.bucket)) {
      throw recoveryCleanupFailure('恢复历史目录在清理时已变化')
    }
    let currentStat
    let currentBytes
    try {
      currentStat = await fs.lstat(entryPath, { bigint: true })
      currentBytes = await fs.readFile(entryPath)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    if (
      !currentStat.isFile() || currentStat.isSymbolicLink() ||
      currentStat.dev !== recordStat.dev || currentStat.ino !== recordStat.ino
    ) {
      throw recoveryCleanupFailure('恢复历史记录在清理时已变化', 'RECOVERY_RECORD_CHANGED')
    }
    if (!currentBytes.equals(recordBytes)) {
      throw recoveryCleanupFailure('恢复历史记录在清理时已变化', 'RECOVERY_RECORD_CHANGED')
    }
    await fs.unlink(entryPath)
    await cleanupEmptyHistoryBucket(stored.recovery, stored.bucket).catch(() => {})
    return null
  } catch (error) {
    // The replacement failure remains primary. If exact cleanup cannot be
    // verified, retain the recovery point rather than risking another record.
    return error
  }
}

async function readHistoryEntry(workspace, base, target, historyId, { root } = {}) {
  if (typeof historyId !== 'string' || !/^[0-9a-f-]{36}$/.test(historyId)) {
    throw makeError('历史版本 ID 无效', 'INVALID_HISTORY_ID')
  }
  const { relative, bucket } = await historyBucket(base, target, root)
  const entryPath = path.join(bucket, `${historyId}.json`)
  let entry
  try {
    const stat = await fs.lstat(entryPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw makeError('历史版本不可用', 'HISTORY_NOT_FOUND')
    entry = JSON.parse(await fs.readFile(entryPath, 'utf-8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw makeError('历史版本不存在或已过期', 'HISTORY_NOT_FOUND')
    throw error
  }
  const owner = await readHistoryOwner(bucket)
  const belongsToPath = owner.path === relative || (!owner.path && entry?.path === relative)
  if (entry?.version !== 1 || entry.id !== historyId || !belongsToPath || typeof entry.contentBase64 !== 'string') {
    throw makeError('历史版本记录无效', 'HISTORY_NOT_FOUND')
  }
  const bytes = decodeEditableHistoryBytes(entry.contentBase64, entry.size)
  if (contentRevision(bytes) !== entry.revision) throw makeError('历史版本校验失败', 'HISTORY_CORRUPT')
  return { entry, bytes }
}

async function listHistory(workspace, base, target, { root } = {}) {
  const { relative, bucket } = await historyBucket(base, target, root)
  return listHistoryInBucket(bucket, relative)
}

async function listHistoryInBucket(bucket, relative) {
  let names
  try {
    names = await fs.readdir(bucket)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const owner = await readHistoryOwner(bucket)
  const entries = []
  for (const name of names.filter(item => item.endsWith('.json') && HISTORY_ID_PATTERN.test(item.slice(0, -'.json'.length)))) {
    try {
      const stat = await fs.lstat(path.join(bucket, name))
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const entry = JSON.parse(await fs.readFile(path.join(bucket, name), 'utf-8'))
      const belongsToPath = owner.path === relative || (!owner.path && entry?.path === relative)
      if (
        entry?.version !== 1 || entry.id !== name.slice(0, -'.json'.length) || !belongsToPath ||
        typeof entry.contentBase64 !== 'string' || typeof entry.revision !== 'string' ||
        !Number.isSafeInteger(entry.size) || typeof entry.savedAt !== 'string'
      ) continue
      entries.push({
        id: entry.id,
        revision: entry.revision,
        savedAt: entry.savedAt,
        size: entry.size,
        ...(entry.path && entry.path !== relative ? { sourcePath: entry.path } : {}),
      })
    } catch {
      // A single malformed record should not hide valid recovery points. It is
      // never returned and cannot be used by the restore endpoint.
    }
  }
  return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

async function readHistoryOwner(bucket) {
  try {
    const markerPath = path.join(bucket, '.owner.json')
    const stat = await fs.lstat(markerPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw makeError('恢复历史目录所有权标记无效', 'RECOVERY_STORAGE_ERROR')
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf-8'))
    if (marker?.version !== 1 || typeof marker.path !== 'string') {
      throw makeError('恢复历史目录所有权标记无效', 'RECOVERY_STORAGE_ERROR')
    }
    return { path: marker.path, bytes: await fs.readFile(markerPath) }
  } catch (error) {
    if (error.code === 'ENOENT') return { path: null, bytes: null }
    throw error
  }
}

async function writeHistoryOwner(bucket, ownerPath) {
  const markerPath = path.join(bucket, '.owner.json')
  const temporary = path.join(bucket, `.${randomUUID()}.owner.tmp`)
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify({ version: 1, path: ownerPath }), 'utf-8')
    } finally { await handle.close() }
    await fs.chmod(temporary, 0o600)
    await fs.rename(temporary, markerPath)
  } catch (error) {
    try { await fs.unlink(temporary) } catch {}
    throw makeCausedError(`无法更新恢复历史归属：${error.message}`, 'RECOVERY_STORAGE_ERROR', error)
  }
}

function historyWorkspaceDirectory(recovery, base) {
  return path.join(recovery, 'history', sha256(base))
}

async function writeOrphanManifest(bucket, manifest) {
  const destination = path.join(bucket, '.orphan.json')
  const temporary = path.join(bucket, `.${manifest.id}.orphan.tmp`)
  try {
    // A previous best-effort reattach may have left a stale managed marker in
    // an otherwise active bucket. Windows rename does not replace an existing
    // destination, so remove only that reserved regular metadata file first.
    const oldStat = await fs.lstat(destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (oldStat) {
      if (!oldStat.isFile() || oldStat.isSymbolicLink()) throw new Error('孤儿历史标记不是普通文件')
      await fs.unlink(destination)
    }
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(manifest), 'utf-8') } finally { await handle.close() }
    await fs.chmod(temporary, 0o600)
    await fs.rename(temporary, destination)
  } catch (error) {
    await fs.unlink(temporary).catch(() => {})
    throw makeCausedError(`无法标记孤儿历史：${error.message}`, 'RECOVERY_STORAGE_ERROR', error)
  }
}

async function readOrphanManifest(bucket, expectedId, workspaceKey) {
  if (!HISTORY_ID_PATTERN.test(expectedId)) throw historyNotFound()
  const manifestPath = path.join(bucket, '.orphan.json')
  let stat
  try { stat = await fs.lstat(manifestPath) } catch (error) {
    if (error.code === 'ENOENT') throw historyNotFound()
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw historyNotFound()
  let manifest
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) } catch { throw historyCorrupt() }
  if (
    manifest?.version !== 1 || manifest.id !== expectedId || manifest.workspaceKey !== workspaceKey ||
    !isWorkspaceRelativeHistoryPath(manifest.path) || !isMarkdownPath(manifest.path) ||
    typeof manifest.reason !== 'string' || typeof manifest.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    (manifest.trashEntryId !== null && !HISTORY_ID_PATTERN.test(manifest.trashEntryId))
  ) throw historyNotFound()
  return manifest
}

async function activeHistoryCandidates(base, recovery, { rootPath = '', includeDescendants = false } = {}) {
  const workspaceHistory = historyWorkspaceDirectory(recovery, base)
  if (!await historyBucketIsSafe(recovery, workspaceHistory)) return []
  const wanted = rootPath ? `${rootPath}/` : ''
  const candidates = []
  for (const key of await fs.readdir(workspaceHistory)) {
    if (!/^[0-9a-f]{64}$/.test(key)) continue
    const bucket = path.join(workspaceHistory, key)
    if (!await historyBucketIsSafe(recovery, bucket)) continue
    const owner = await readHistoryOwner(bucket)
    let relative = owner.path
    if (!relative) {
      for (const name of await fs.readdir(bucket)) {
        if (!name.endsWith('.json') || !HISTORY_ID_PATTERN.test(name.slice(0, -'.json'.length))) continue
        try {
          const stat = await fs.lstat(path.join(bucket, name))
          if (!stat.isFile() || stat.isSymbolicLink()) continue
          const entry = JSON.parse(await fs.readFile(path.join(bucket, name), 'utf-8'))
          if (
            entry?.version === 1 && entry.id === name.slice(0, -'.json'.length) &&
            isWorkspaceRelativeHistoryPath(entry.path) && sha256(entry.path) === key
          ) {
            relative = entry.path
            break
          }
        } catch {}
      }
    }
    if (
      !isWorkspaceRelativeHistoryPath(relative) || !isMarkdownPath(relative) || sha256(relative) !== key ||
      (includeDescendants ? !(relative === rootPath || relative.startsWith(wanted)) : relative !== rootPath)
    ) continue
    const history = await listHistoryInBucket(bucket, relative)
    if (history.length) candidates.push({ bucket, path: relative })
  }
  return candidates
}

// Move path-keyed history out of the active namespace before a path is reused.
// Each move is atomic within recovery storage; a failed batch is rolled back in
// reverse order so the caller (trash/create) can safely abort its file change.
async function archiveHistoryAtPath(base, target, options = {}) {
  const relative = relativePath(base, target)
  const recovery = await canonicalProjectedPath(recoveryRoot(options.root))
  const workspaceHistory = historyWorkspaceDirectory(recovery, base)
  const candidates = await activeHistoryCandidates(base, recovery, {
    rootPath: relative,
    includeDescendants: options.includeDescendants === true,
  })
  if (!candidates.length) return []

  const orphanRoot = path.join(workspaceHistory, 'orphans')
  await ensurePrivateDirectory(recovery)
  await ensurePrivateDirectory(path.join(recovery, 'history'))
  await ensurePrivateDirectory(workspaceHistory)
  await ensurePrivateDirectory(orphanRoot)
  if (!await historyBucketIsSafe(recovery, orphanRoot)) {
    throw makeError('孤儿历史目录不可用', 'RECOVERY_STORAGE_ERROR')
  }

  const moved = []
  const archive = options.moveHistoryBucket || fs.rename
  try {
    for (const candidate of candidates) {
      const id = randomUUID()
      const destination = path.join(orphanRoot, id)
      const manifest = {
        version: 1,
        id,
        workspaceKey: sha256(base),
        path: candidate.path,
        reason: options.reason || 'path-reused',
        trashEntryId: options.trashEntryId || null,
        createdAt: new Date().toISOString(),
      }
      await writeOrphanManifest(candidate.bucket, manifest)
      try {
        await archive(candidate.bucket, destination)
      } catch (error) {
        await fs.unlink(path.join(candidate.bucket, '.orphan.json')).catch(() => {})
        throw error
      }
      moved.push({ source: candidate.bucket, destination, manifest })
    }
  } catch (error) {
    const rollbackErrors = []
    for (const item of moved.reverse()) {
      try {
        await fs.rename(item.destination, item.source)
        await fs.unlink(path.join(item.source, '.orphan.json'))
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) {
      const failure = makeError('孤儿历史归档失败，部分记录仍保留在恢复目录', 'HISTORY_ARCHIVE_ROLLBACK_FAILED')
      failure.cause = error
      throw failure
    }
    throw makeCausedError(`无法归档旧路径历史：${error.message}`, 'RECOVERY_STORAGE_ERROR', error)
  }
  return moved.map(item => ({ id: item.manifest.id, path: item.manifest.path }))
}

// Public hook used by the trash service and file creation path. For directory
// trash, all active Markdown histories rooted below the directory are detached.
export async function archiveFileHistory(workspace, reqPath, options = {}) {
  const base = await workspaceBase(workspace)
  const target = lexicalPath(base, reqPath)
  return archiveHistoryAtPath(base, target, options)
}

export async function listOrphanFileHistory(workspace, options = {}) {
  const base = await workspaceBase(workspace)
  const recovery = await canonicalProjectedPath(recoveryRoot(options.root))
  const workspaceKey = sha256(base)
  const orphanRoot = path.join(historyWorkspaceDirectory(recovery, base), 'orphans')
  if (!await historyBucketIsSafe(recovery, orphanRoot)) return { items: [] }
  const items = []
  for (const id of await fs.readdir(orphanRoot)) {
    if (!HISTORY_ID_PATTERN.test(id)) continue
    const bucket = path.join(orphanRoot, id)
    if (!await historyBucketIsSafe(recovery, bucket)) continue
    try {
      const manifest = await readOrphanManifest(bucket, id, workspaceKey)
      const history = await listHistoryInBucket(bucket, manifest.path)
      if (!history.length) continue
      let pathExists = false
      try {
        const location = await fileLocation(workspace, manifest.path, { allowMissing: true })
        pathExists = Boolean(location.stat)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      items.push({
        id,
        path: manifest.path,
        reason: manifest.reason,
        trashEntryId: manifest.trashEntryId,
        createdAt: manifest.createdAt,
        pathExists,
        history,
      })
    } catch (error) {
      if (error.code === 'RECOVERY_STORAGE_ERROR') throw error
      // Hide only the malformed archive. Other workspaces and valid archives
      // remain available in the list.
    }
  }
  items.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return { items }
}

export async function deleteOrphanFileHistory(workspace, orphanId, options = {}) {
  if (typeof orphanId !== 'string' || !HISTORY_ID_PATTERN.test(orphanId)) throw historyNotFound()
  const base = await workspaceBase(workspace)
  const recovery = await canonicalProjectedPath(recoveryRoot(options.root))
  const workspaceKey = sha256(base)
  const orphanRoot = path.join(historyWorkspaceDirectory(recovery, base), 'orphans')
  const bucket = path.join(orphanRoot, orphanId)
  if (!await historyBucketIsSafe(recovery, bucket)) throw historyNotFound()
  const manifest = await readOrphanManifest(bucket, orphanId, workspaceKey)
  const history = await listHistoryInBucket(bucket, manifest.path)
  if (!history.length) throw historyNotFound()
  // `rm` unlinks nested symlinks instead of following them, and the archive
  // directory itself has been checked component by component above.
  await fs.rm(bucket, { recursive: true, force: false })
  return { success: true, id: orphanId, deletedHistory: history.length }
}

export async function readOrphanFileHistory(workspace, orphanId, historyId, options = {}) {
  if (typeof orphanId !== 'string' || !HISTORY_ID_PATTERN.test(orphanId)) throw historyNotFound()
  if (typeof historyId !== 'string' || !HISTORY_ID_PATTERN.test(historyId)) throw historyNotFound()
  const base = await workspaceBase(workspace)
  const recovery = await canonicalProjectedPath(recoveryRoot(options.root))
  const workspaceKey = sha256(base)
  const orphanRoot = path.join(historyWorkspaceDirectory(recovery, base), 'orphans')
  const bucket = path.join(orphanRoot, orphanId)
  if (!await historyBucketIsSafe(recovery, bucket)) throw historyNotFound()
  const manifest = await readOrphanManifest(bucket, orphanId, workspaceKey)
  const entryPath = path.join(bucket, `${historyId}.json`)
  let stat
  let entry
  try {
    stat = await fs.lstat(entryPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw historyNotFound()
    entry = JSON.parse(await fs.readFile(entryPath, 'utf-8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw historyNotFound()
    if (error.code === 'HISTORY_NOT_FOUND') throw error
    throw historyCorrupt()
  }
  const owner = await readHistoryOwner(bucket)
  const belongsToPath = owner.path === manifest.path || (!owner.path && entry?.path === manifest.path)
  if (
    entry?.version !== 1 || entry.id !== historyId || !belongsToPath ||
    !isWorkspaceRelativeHistoryPath(entry.path) || typeof entry.contentBase64 !== 'string' ||
    typeof entry.revision !== 'string' || !/^[0-9a-f]{64}$/.test(entry.revision) ||
    !Number.isSafeInteger(entry.size) || entry.size < 0 ||
    typeof entry.savedAt !== 'string' || !Number.isFinite(Date.parse(entry.savedAt))
  ) throw historyNotFound()
  const bytes = decodeEditableHistoryBytes(entry.contentBase64, entry.size)
  if (
    bytes.toString('base64') !== entry.contentBase64 || bytes.byteLength !== entry.size ||
    contentRevision(bytes) !== entry.revision
  ) throw historyCorrupt()
  const content = decodeMarkdownBytes(bytes)
  return { manifest, entry, bytes, content }
}

export async function restoreOrphanFileHistory(workspace, orphanId, historyId, reqPath, expectedRevision, options = {}) {
  validateExpectedRevision(expectedRevision)
  const { manifest, bytes } = await readOrphanFileHistory(workspace, orphanId, historyId, options)
  const targetPath = reqPath || manifest.path
  assertMarkdownPath(targetPath)
  const location = await fileLocation(workspace, targetPath, { allowMissing: true })
  const current = await readCurrent(location, targetPath, expectedRevision)
  const result = await writeBytesVersioned(workspace, targetPath, bytes, expectedRevision, options)
  return {
    ...result,
    restoredHistoryId: historyId,
    sourcePath: manifest.path,
    previousRevision: current?.bytes ? contentRevision(current.bytes) : null,
  }
}

async function reattachHistoryArchives(base, orphanIds, options = {}, predicate = () => true) {
  const recovery = await canonicalProjectedPath(recoveryRoot(options.root))
  const workspaceKey = sha256(base)
  const orphanRoot = path.join(historyWorkspaceDirectory(recovery, base), 'orphans')
  if (!await historyBucketIsSafe(recovery, orphanRoot)) return { reattached: 0, retained: 0 }
  let reattached = 0
  let retained = 0
  for (const id of orphanIds) {
    if (!HISTORY_ID_PATTERN.test(id)) continue
    const orphanBucket = path.join(orphanRoot, id)
    if (!await historyBucketIsSafe(recovery, orphanBucket)) continue
    let manifest
    try { manifest = await readOrphanManifest(orphanBucket, id, workspaceKey) } catch { continue }
    if (!predicate(manifest)) continue
    const target = lexicalPath(base, manifest.path)
    let targetExists = false
    try {
      const targetStat = await fs.lstat(target)
      targetExists = targetStat.isFile() && !targetStat.isSymbolicLink()
    } catch (error) {
      if (error.code !== 'ENOENT') {
        retained += 1
        continue
      }
    }
    if (!targetExists) {
      retained += 1
      continue
    }
    try {
      const { bucket: activeBucket, recovery: activeRecovery } = await historyBucket(base, target, options.root)
      if (!await historyBucketIsSafe(activeRecovery, path.dirname(activeBucket))) {
        retained += 1
        continue
      }
      const activeStat = await fs.lstat(activeBucket).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (activeStat) {
        if (
          activeStat.isSymbolicLink() || !activeStat.isDirectory() ||
          !await historyBucketIsSafe(activeRecovery, activeBucket) ||
          await historyBucketExists(activeBucket)
        ) {
          retained += 1
          continue
        }
        const names = await fs.readdir(activeBucket)
        if (names.some(name => name !== '.owner.json' && name !== '.orphan.json')) {
          retained += 1
          continue
        }
        for (const name of names) await fs.unlink(path.join(activeBucket, name))
        await fs.rmdir(activeBucket)
      }
      await fs.rename(orphanBucket, activeBucket)
      await fs.unlink(path.join(activeBucket, '.orphan.json')).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      reattached += 1
    } catch {
      retained += 1
    }
  }
  return { reattached, retained }
}

export async function reattachTrashFileHistory(workspace, trashEntryId, options = {}) {
  if (typeof trashEntryId !== 'string' || !HISTORY_ID_PATTERN.test(trashEntryId)) return { reattached: 0, retained: 0 }
  const base = await workspaceBase(workspace)
  const recovery = await canonicalProjectedPath(recoveryRoot(options.root))
  const workspaceKey = sha256(base)
  const orphanRoot = path.join(historyWorkspaceDirectory(recovery, base), 'orphans')
  if (!await historyBucketIsSafe(recovery, orphanRoot)) return { reattached: 0, retained: 0 }
  const ids = []
  for (const id of await fs.readdir(orphanRoot)) {
    if (!HISTORY_ID_PATTERN.test(id)) continue
    const bucket = path.join(orphanRoot, id)
    if (!await historyBucketIsSafe(recovery, bucket)) continue
    try {
      const manifest = await readOrphanManifest(bucket, id, workspaceKey)
      if (manifest.trashEntryId === trashEntryId) ids.push(id)
    } catch {}
  }
  return reattachHistoryArchives(base, ids, options, manifest => manifest.trashEntryId === trashEntryId)
}

async function collectRegularFiles(target, knownStat) {
  const stat = knownStat || await fs.lstat(target)
  if (stat.isSymbolicLink()) return []
  if (stat.isFile()) return [target]
  if (!stat.isDirectory()) return []
  const files = []
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name)
    const childStat = await fs.lstat(child)
    if (childStat.isSymbolicLink()) continue
    if (childStat.isDirectory()) files.push(...await collectRegularFiles(child, childStat))
    else if (childStat.isFile()) files.push(child)
  }
  return files
}

async function historyBucketExists(bucket) {
  let stat
  try { stat = await fs.lstat(bucket) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw makeError('恢复历史目录无效', 'RECOVERY_STORAGE_ERROR')
  const names = await fs.readdir(bucket)
  for (const name of names) {
    if (!HISTORY_ID_PATTERN.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue
    try {
      const entryPath = path.join(bucket, name)
      const entryStat = await fs.lstat(entryPath)
      if (!entryStat.isFile() || entryStat.isSymbolicLink()) continue
      const entry = JSON.parse(await fs.readFile(entryPath, 'utf-8'))
      if (
        entry?.version === 1 && entry.id === name.slice(0, -'.json'.length) &&
        typeof entry.path === 'string' && isWorkspaceRelativeHistoryPath(entry.path) &&
        typeof entry.contentBase64 === 'string' && typeof entry.revision === 'string'
      ) return true
    } catch {}
  }
  return false
}

async function cleanupEmptyHistoryBucket(recovery, bucket) {
  if (!await historyBucketIsSafe(recovery, bucket)) return
  const names = await fs.readdir(bucket)
  const hasVersionFile = names.some(name => name.endsWith('.json') && HISTORY_ID_PATTERN.test(name.slice(0, -'.json'.length)))
  if (hasVersionFile) return
  const managedMarkers = new Set(['.owner.json', '.orphan.json'])
  for (const name of names) {
    if (!managedMarkers.has(name)) return
    const stat = await fs.lstat(path.join(bucket, name))
    if (!stat.isFile() || stat.isSymbolicLink()) return
  }
  for (const name of names) await fs.unlink(path.join(bucket, name))
  await fs.rmdir(bucket).catch(error => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
  })
}

async function migrateHistoryForMove(base, sourcePath, destinationPath, isDirectory, files, options = {}) {
  const plans = []
  for (const sourceFile of files) {
    const destinationFile = isDirectory
      ? path.join(destinationPath, path.relative(sourcePath, sourceFile))
      : destinationPath
    const oldRelative = relativePath(base, sourceFile)
    const newRelative = relativePath(base, destinationFile)
    const sourceLocation = await historyBucket(base, sourceFile, options.root)
    const sourceHistory = sourceLocation.bucket
    if (!await historyBucketIsSafe(sourceLocation.recovery, sourceHistory)) continue
    if (!await historyBucketExists(sourceHistory)) continue
    const destinationLocation = await historyBucket(base, destinationFile, options.root)
    const destinationHistory = destinationLocation.bucket
    // A missing destination bucket is expected; existing components are still
    // walked without following symlinks before testing for a path conflict.
    await historyBucketIsSafe(destinationLocation.recovery, destinationHistory)
    if (await historyBucketExists(destinationHistory)) {
      throw makeError('目标路径已有恢复历史，无法安全移动文件', 'HISTORY_CONFLICT')
    }
    await cleanupEmptyHistoryBucket(destinationLocation.recovery, destinationHistory)
    const owner = await readHistoryOwner(sourceHistory)
    if (owner.path && owner.path !== oldRelative) {
      throw makeError('源路径恢复历史归属不匹配', 'RECOVERY_STORAGE_ERROR')
    }
    plans.push({ sourceHistory, destinationHistory, oldRelative, newRelative, oldOwner: owner.bytes })
  }

  const moved = []
  try {
    for (const plan of plans) {
      const recovery = await canonicalProjectedPath(recoveryRoot(options.root))
      await ensurePrivateDirectory(recovery)
      await ensurePrivateDirectory(path.join(recovery, 'history'))
      await ensurePrivateDirectory(path.dirname(plan.destinationHistory))
      if (options.moveHistoryBucket) await options.moveHistoryBucket(plan.sourceHistory, plan.destinationHistory)
      else await fs.rename(plan.sourceHistory, plan.destinationHistory)
      moved.push(plan)
      await writeHistoryOwner(plan.destinationHistory, plan.newRelative)
    }
  } catch (error) {
    const rollbackErrors = []
    for (const plan of moved.reverse()) {
      try {
        await fs.rename(plan.destinationHistory, plan.sourceHistory)
        if (plan.oldOwner) {
          const markerPath = path.join(plan.sourceHistory, '.owner.json')
          const temporary = path.join(plan.sourceHistory, `.${randomUUID()}.owner.tmp`)
          await fs.writeFile(temporary, plan.oldOwner, { flag: 'wx', mode: 0o600 })
          await fs.chmod(temporary, 0o600)
          await fs.rename(temporary, markerPath)
        } else {
          await fs.unlink(path.join(plan.sourceHistory, '.owner.json')).catch(markerError => {
            if (markerError.code !== 'ENOENT') throw markerError
          })
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) {
      const failure = makeError('恢复历史迁移失败，部分历史可能仍位于临时路径', 'HISTORY_ROLLBACK_FAILED')
      failure.cause = error
      throw failure
    }
    throw error
  }
}

function validateExpectedRevision(expectedRevision) {
  if (expectedRevision === undefined) throw revisionRequired()
  if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(expectedRevision))) {
    throw makeError('expectedRevision 必须是文件版本哈希或 null', 'INVALID_REVISION')
  }
}

async function readCurrent(location, reqPath, expectedRevision) {
  if (!location.stat) {
    if (expectedRevision !== null) throw fileConflict(reqPath, expectedRevision, null)
    return null
  }
  const bytes = await readRegularFile(location)
  decodeMarkdownBytes(bytes)
  const currentRevision = contentRevision(bytes)
  if (expectedRevision !== currentRevision) throw fileConflict(reqPath, expectedRevision, bytes)
  return { bytes, mode: location.stat.mode & 0o777 }
}

async function writeBytesVersioned(workspace, reqPath, bytes, expectedRevision, options = {}) {
  assertMarkdownPath(reqPath)
  if (bytes.byteLength > MAX_EDITABLE_MARKDOWN_BYTES) throw markdownTooLarge(bytes.byteLength)
  decodeMarkdownBytes(bytes)
  validateExpectedRevision(expectedRevision)
  const location = await fileLocation(workspace, reqPath, { allowMissing: true })
  const { base, target, parent } = location
  // Keeping filesystem operations local to this write also lets failure-path
  // tests inject an individual syscall without changing process-wide fs state.
  const io = options.fileSystem || fs
  const guard = await openWorkspaceParent(base, target, makeError)
  try {
    if (location.stat && location.stat.size > MAX_EDITABLE_MARKDOWN_BYTES) {
      throw markdownTooLarge(location.stat.size)
    }
    const existing = await readCurrent(location, reqPath, expectedRevision)
    if (existing && existing.bytes.equals(bytes)) {
      return { success: true, path: relativePath(base, target), revision: contentRevision(existing.bytes) }
    }
    // This service atomically replaces files via rename, which can succeed for
    // a read-only file when the parent directory is writable. Preserve the
    // current account's file-level write permission semantics explicitly.
    if (existing) await fs.access(target, fsConstants.W_OK)
    if (!existing) await archiveHistoryAtPath(base, target, { root: options.root, reason: 'path-reused' })
    const name = path.basename(target)
    const relative = relativePath(base, target)

    const storedHistory = existing
      ? await storeHistory(workspace, base, target, existing.bytes, options)
      : null

    const temporary = path.join(parent, `.${name}.${randomUUID()}.tmp`)
    const mode = existing ? existing.mode : 0o600
    let temporaryStat = null
    let temporaryCreated = false
    try {
      await guard.check()
      const handle = await io.open(temporary, 'wx', mode)
      temporaryCreated = true
      try {
        // Always close the descriptor even if fstat itself fails. Without a
        // verified identity the cleanup path will deliberately leave the
        // pathname untouched instead of risking deletion of a replacement.
        temporaryStat = await handle.stat()
        await handle.writeFile(bytes)
        await handle.chmod(mode)
        // Flush the new contents and mode before making the pathname visible.
        // Parent-directory syncing is intentionally omitted because opening
        // and syncing directories is not portable across the supported OSes.
        await handle.sync()
      } finally {
        await handle.close()
      }

      if (existing) {
        // Recheck immediately before the atomic replacement. The workspace
        // mutation queue excludes other API writes; this second read also catches
        // most external edits that race the history write or temp-file creation.
        let latest
        try {
          const latestStat = await fs.lstat(target)
          if (latestStat.isSymbolicLink() || !latestStat.isFile()) throw makeError('目标文件已变化', 'FILE_CONFLICT')
          latest = await readRegularFile({ base, target, stat: latestStat })
          const latestMode = latestStat.mode & 0o777
          if (latestMode !== mode) {
            await guard.check()
            const temporaryHandle = await io.open(temporary, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
            try {
              const opened = await temporaryHandle.stat()
              if (opened.dev !== temporaryStat.dev || opened.ino !== temporaryStat.ino) {
                throw makeError('临时文件已变化')
              }
              await temporaryHandle.chmod(latestMode)
            } finally {
              await temporaryHandle.close()
            }
          }
        } catch (error) {
          if (error.code === 'ENOENT') throw fileConflict(reqPath, expectedRevision, null)
          throw error
        }
        if (contentRevision(latest) !== expectedRevision) throw fileConflict(reqPath, expectedRevision, latest)
        // Recheck after the optimistic revision read so a mode change during
        // history capture cannot turn atomic rename into a permission bypass.
        await fs.access(target, fsConstants.W_OK)
        await guard.check()
        await assertSameEntry(temporary, temporaryStat, makeError)
        await io.rename(temporary, target)
      } else {
        // The null revision means create-if-absent. link is an atomic exclusive
        // install, so another creator cannot be silently overwritten.
        await guard.check()
        await assertSameEntry(temporary, temporaryStat, makeError)
        await io.link(temporary, target)
        await guard.check()
        await assertSameEntry(temporary, temporaryStat, makeError)
        await io.unlink(temporary)
      }
    } catch (error) {
      if (temporaryStat) {
        try {
          await guard.check()
          await assertSameEntry(temporary, temporaryStat, makeError)
          await io.unlink(temporary)
        } catch (cleanupError) {
          // Preserve the write failure as the primary error while exposing
          // why cleanup could not remove this operation's exact inode.
          error.details = {
            ...(error.details || {}),
            temporaryCleanupError: {
              code: cleanupError.code || 'TEMPORARY_CLEANUP_FAILED',
              message: cleanupError.message || '临时文件清理失败',
            },
          }
        }
      } else if (temporaryCreated) {
        error.details = {
          ...(error.details || {}),
          temporaryCleanupError: {
            code: 'TEMPORARY_IDENTITY_UNAVAILABLE',
            message: '无法确认临时文件身份，为避免删除其他文件，已保留该路径供诊断',
          },
        }
      }
      if (error.code === 'EEXIST' && expectedRevision === null) {
        let current = null
        try {
          const stat = await fs.lstat(target)
          if (stat.isFile() && !stat.isSymbolicLink()) current = await readRegularFile({ base, target, stat })
        } catch {}
        throw fileConflict(reqPath, expectedRevision, current)
      }
      if (storedHistory?.created && existing) {
        // Failed temp creation/write/sync/rename must not add a duplicate of
        // the still-current version or push an older recovery point out of
        // retention. Keep the record if the path no longer names the exact
        // original inode and bytes; that is the conservative choice when an
        // external edit or an ambiguous post-rename error raced this write.
        let originalStillPresent = false
        try {
          const latestStat = await fs.lstat(target)
          if (
            latestStat.isFile() && !latestStat.isSymbolicLink() &&
            latestStat.dev === location.stat.dev && latestStat.ino === location.stat.ino
          ) {
            const latestBytes = await readRegularFile({ base, target, stat: latestStat })
            originalStillPresent = latestBytes.equals(existing.bytes)
          }
        } catch {}
        if (originalStillPresent) {
          const cleanupError = await discardStoredHistory(storedHistory)
          if (cleanupError) {
            const warning = reportRecoveryCleanupWarning(options, relativePath(base, target), cleanupError, { saveCommitted: false })
            error.details = { ...(error.details || {}), recoveryCleanupWarning: warning }
          }
        }
      }
      throw error
    }
    let cleanupWarning
    if (storedHistory) {
      // File replacement has committed. Retention cleanup is best effort so a
      // pruning error cannot make the API report that the already-written
      // document failed to save.
      try {
        await pruneHistory(workspace, base, target, options, storedHistory.id)
      } catch (error) {
        cleanupWarning = reportRecoveryCleanupWarning(options, relative, error)
      }
    }
    const result = { success: true, path: relative, revision: contentRevision(bytes) }
    if (cleanupWarning) result.recoveryCleanupWarning = cleanupWarning
    return result
  } finally {
    await guard.close()
  }
}

// Versioned write. Existing files require the SHA-256 revision returned by
// readFile; null means create only if the destination does not exist.
export async function writeFile(workspace, reqPath, content, expectedRevision, options = {}) {
  if (typeof content !== 'string') throw makeError('content 必须是字符串', 'INVALID_CONTENT')
  assertMarkdownPath(reqPath)
  const size = Buffer.byteLength(content, 'utf8')
  if (size > MAX_EDITABLE_MARKDOWN_BYTES) throw markdownTooLarge(size)
  return writeBytesVersioned(workspace, reqPath, encodeMarkdownContent(content), expectedRevision, options)
}

export async function listFileHistory(workspace, reqPath, options = {}) {
  assertMarkdownPath(reqPath)
  const location = await fileLocation(workspace, reqPath, { allowMissing: true })
  return { path: relativePath(location.base, location.target), history: await listHistory(workspace, location.base, location.target, options) }
}

// Delete exactly one validated recovery record. The current workspace file is
// only used to resolve the bucket and is never read or changed.
export async function deleteFileHistory(workspace, reqPath, historyId, options = {}) {
  assertMarkdownPath(reqPath)
  if (typeof historyId !== 'string' || !HISTORY_ID_PATTERN.test(historyId)) {
    throw makeError('历史版本 ID 无效', 'INVALID_HISTORY_ID')
  }

  const location = await fileLocation(workspace, reqPath, { allowMissing: true })
  const { relative, recovery, bucket } = await historyBucket(
    location.base,
    location.target,
    options.root,
  )
  if (!await historyBucketIsSafe(recovery, bucket)) throw historyNotFound()

  const entryPath = path.join(bucket, `${historyId}.json`)
  let recordStat
  let recordBytes
  try {
    recordStat = await fs.lstat(entryPath, { bigint: true })
    if (!recordStat.isFile() || recordStat.isSymbolicLink()) throw historyNotFound()
    recordBytes = await fs.readFile(entryPath)
  } catch (error) {
    if (error.code === 'ENOENT') throw historyNotFound()
    throw error
  }

  let entry
  try {
    entry = JSON.parse(recordBytes.toString('utf8'))
  } catch {
    throw historyCorrupt()
  }

  const owner = await readHistoryOwner(bucket)
  const ownerMatches = owner.path === relative || (!owner.path && entry?.path === relative)
  if (
    entry?.version !== 1 || entry.id !== historyId || !ownerMatches ||
    !isWorkspaceRelativeHistoryPath(entry.path)
  ) {
    throw historyNotFound()
  }

  if (
    typeof entry.revision !== 'string' || !/^[0-9a-f]{64}$/.test(entry.revision) ||
    typeof entry.contentBase64 !== 'string' || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
    typeof entry.savedAt !== 'string' || !Number.isFinite(Date.parse(entry.savedAt))
  ) {
    throw historyCorrupt()
  }
  const bytes = Buffer.from(entry.contentBase64, 'base64')
  if (
    bytes.toString('base64') !== entry.contentBase64 || bytes.byteLength !== entry.size ||
    contentRevision(bytes) !== entry.revision
  ) {
    throw historyCorrupt()
  }

  // Recheck the bucket and exact record immediately before unlinking. This
  // makes a replaced symlink or record fail closed and keeps failures from
  // removing a different UUID's entry.
  if (!await historyBucketIsSafe(recovery, bucket)) throw historyNotFound()
  let currentStat
  let currentBytes
  try {
    currentStat = await fs.lstat(entryPath, { bigint: true })
    if (
      !currentStat.isFile() || currentStat.isSymbolicLink() ||
      currentStat.dev !== recordStat.dev || currentStat.ino !== recordStat.ino
    ) {
      throw historyNotFound()
    }
    currentBytes = await fs.readFile(entryPath)
  } catch (error) {
    if (error.code === 'ENOENT') throw historyNotFound()
    throw error
  }
  if (!currentBytes.equals(recordBytes)) throw historyNotFound()

  try {
    await fs.unlink(entryPath)
  } catch (error) {
    if (error.code === 'ENOENT') throw historyNotFound()
    throw error
  }
  await cleanupEmptyHistoryBucket(recovery, bucket)
  return { success: true, path: relative, deletedHistoryId: historyId }
}

export async function restoreFileHistory(workspace, reqPath, historyId, expectedRevision, options = {}) {
  assertMarkdownPath(reqPath)
  validateExpectedRevision(expectedRevision)
  const location = await fileLocation(workspace, reqPath, { allowMissing: true })
  if (location.stat && location.stat.size > MAX_EDITABLE_MARKDOWN_BYTES) {
    throw markdownTooLarge(location.stat.size)
  }
  const current = await readCurrent(location, reqPath, expectedRevision)
  const { bytes } = await readHistoryEntry(workspace, location.base, location.target, historyId, options)
  // Restoring uses the same optimistic check, history capture and atomic write
  // path as a regular save. A stale restore request cannot overwrite newer data.
  const result = await writeBytesVersioned(workspace, reqPath, bytes, expectedRevision, options)
  return { ...result, restoredHistoryId: historyId, previousRevision: current?.bytes ? contentRevision(current.bytes) : null }
}

// 上传文件，永远不覆盖已有目标。
export async function ensureAdjacentAssetsDirectory(workspace, documentPath) {
  if (!isMarkdownPath(documentPath)) throw makeError('只能为 Markdown 文档上传同级图片')
  const { base, full: document } = await existingPath(workspace, documentPath)
  const documentStat = await fs.lstat(document)
  if (!documentStat.isFile()) throw makeError('目标文档不是普通文件')
  const assets = path.join(path.dirname(document), 'assets')
  assertInside(base, assets)
  const guard = await openWorkspaceParent(base, assets, makeError)
  try {
    await guard.check()
    await fs.mkdir(assets)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  } finally {
    await guard.close()
  }
  const assetsStat = await fs.lstat(assets)
  if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink()) throw makeError('同级 assets 不是安全目录')
  return relativePath(base, assets)
}

export async function uploadFile(workspace, reqPath, file, options = {}) {
  if (!file?.originalname) throw makeError('缺少文件')
  const cleanName = assertName(path.basename(file.originalname))
  if (cleanName !== file.originalname) throw makeError('文件名格式无效')
  const bytes = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || [])
  const { base, full: targetDir } = await existingPath(workspace, reqPath || '')
  const dirStat = await fs.lstat(targetDir)
  if (!dirStat.isDirectory()) throw makeError('目标目录无效')
  const destPath = path.join(targetDir, cleanName)
  assertInside(base, destPath)
  const guard = await openWorkspaceParent(base, destPath, makeError)
  const io = options.fileSystem || fs
  const temporary = path.join(path.dirname(destPath), `.${cleanName}.${randomUUID()}.upload.tmp`)
  let handle = null
  let temporaryCreated = false
  let temporaryStat = null
  let publicationAttempted = false
  try {
    await ensureDestinationDoesNotExist(destPath)
    if (isMarkdownPath(cleanName)) {
      await archiveHistoryAtPath(base, destPath, { ...options, reason: 'path-reused' })
    }
    await guard.check()
    await assertSameEntry(targetDir, dirStat, makeError)

    // Write into a private same-directory path. The final name is installed
    // only after the complete bytes have been checked and synced.
    handle = await io.open(temporary, 'wx+')
    temporaryCreated = true
    try {
      temporaryStat = await handle.stat({ bigint: true })
      if (!isUploadIdentity(temporaryStat)) {
        throw makeError('无法确认上传临时文件身份', 'TEMPORARY_IDENTITY_UNAVAILABLE')
      }
      await handle.writeFile(bytes)
      temporaryStat = await handle.stat({ bigint: true })
      if (!isUploadIdentity(temporaryStat) || temporaryStat.size !== BigInt(bytes.byteLength)) {
        throw makeError('上传临时文件内容不完整', 'UPLOAD_INCOMPLETE')
      }
      await verifyUploadBytes(handle, bytes)
      await handle.sync()
      temporaryStat = await handle.stat({ bigint: true })
      if (!isUploadIdentity(temporaryStat) || temporaryStat.size !== BigInt(bytes.byteLength)) {
        throw makeError('上传临时文件同步后内容不完整', 'UPLOAD_INCOMPLETE')
      }
    } catch (error) {
      // A write can fail after storing only part of the multipart buffer. Get
      // the current descriptor identity before cleanup so we never use a
      // stale, numeric inode snapshot to decide which path to unlink.
      try {
        const current = await handle.stat({ bigint: true })
        if (sameUploadIdentity(current, temporaryStat)) temporaryStat = current
      } catch {}
      throw error
    }

    // A close error is a failed upload too, so detect it before publishing the
    // final name. The identity snapshot remains BigInt for guarded cleanup.
    await handle.close()
    handle = null

    await guard.check()
    await assertUploadPath(temporary, temporaryStat, bytes.byteLength)
    try {
      // link is an atomic create-if-absent operation. Do not fall back to a
      // copy into the final name: that would expose a partial upload again.
      publicationAttempted = true
      await io.link(temporary, destPath)
    } catch (error) {
      if (error.code === 'EEXIST') throw makeError('目标已存在', 'CONFLICT')
      if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) {
        const unsupported = makeError('当前工作空间文件系统不支持安全的上传发布', 'UNSUPPORTED_UPLOAD_FILESYSTEM')
        unsupported.cause = error
        unsupported.details = { causeCode: error.code }
        throw unsupported
      }
      throw error
    }

    // Verify publication separately from best-effort temporary cleanup. A
    // changed parent or final file must not be reported as upload success.
    await guard.check()
    const publishedStat = await verifyUploadPathBytes(destPath, temporaryStat, bytes)
    await guard.check()
    const linkedTemporaryStat = await verifyUploadPathBytes(temporary, temporaryStat, bytes)
    if (!sameUploadSnapshot(publishedStat, linkedTemporaryStat)) {
      throw makeError('发布目标与已校验的上传临时文件不一致', 'FILE_CHANGED')
    }
    temporaryStat = linkedTemporaryStat
    await guard.check()
    await assertUploadPath(destPath, publishedStat, bytes.byteLength)

    let cleanupWarning
    try {
      await guard.check()
      await assertUploadPath(temporary, temporaryStat, bytes.byteLength)
      await io.unlink(temporary)
      temporaryCreated = false
    } catch (error) {
      // Publication already succeeded and the final file is complete. Keep a
      // hidden residual if its cleanup cannot be proven safe, and make that
      // condition visible to the caller.
      cleanupWarning = {
        code: error.code || 'UPLOAD_TEMPORARY_CLEANUP_FAILED',
        message: error.message || '上传成功，但隐藏临时文件清理失败',
      }
    }
    return {
      filename: cleanName,
      path: relativePath(base, destPath),
      ...(cleanupWarning ? { temporaryCleanupWarning: cleanupWarning } : {}),
    }
  } catch (error) {
    const cleanupErrors = {}
    if (publicationAttempted && !['CONFLICT', 'UNSUPPORTED_UPLOAD_FILESYSTEM'].includes(error?.code)) {
      try {
        await guard.check()
        const destinationIdentity = await fs.lstat(destPath, { bigint: true })
        if (!sameUploadIdentity(destinationIdentity, temporaryStat)) {
          throw makeError('发布目标已被其他文件替换，已保留该文件', 'FILE_CHANGED')
        }
        // The temporary path must still resolve to our original inode and the
        // final path must still contain every uploaded byte before rollback.
        // This avoids deleting a same-length external rewrite through the
        // hard link's shared inode.
        const currentTemporary = await verifyUploadPathBytes(temporary, temporaryStat, bytes)
        const currentDestination = await verifyUploadPathBytes(destPath, temporaryStat, bytes)
        if (sameUploadSnapshot(currentTemporary, currentDestination)) {
          await guard.check()
          await assertUploadPath(destPath, currentDestination, bytes.byteLength)
          await io.unlink(destPath)
        }
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          cleanupErrors.publishedFileCleanupError = {
            code: cleanupError.code || 'UPLOAD_PUBLISHED_FILE_CLEANUP_FAILED',
            message: cleanupError.message || '上传失败后无法安全撤回最终文件',
          }
        }
      }
    }
    if (temporaryCreated) {
      try {
        if (handle) {
          try {
            const current = await handle.stat({ bigint: true })
            if (sameUploadIdentity(current, temporaryStat)) temporaryStat = current
          } catch {
            // A close error may already have released the descriptor. The
            // last verified BigInt snapshot still permits conservative path
            // cleanup if it remains unchanged.
          }
        } else {
          if (publicationAttempted) {
            temporaryStat = await verifyUploadPathBytes(temporary, temporaryStat, bytes)
          } else {
            const current = await fs.lstat(temporary, { bigint: true })
            if (sameUploadIdentity(current, temporaryStat)) temporaryStat = current
          }
        }
        if (!temporaryStat || typeof temporaryStat.dev !== 'bigint' || typeof temporaryStat.ino !== 'bigint') {
          throw makeError('无法确认上传临时文件身份，为避免删除其他文件，已保留隐藏路径', 'TEMPORARY_IDENTITY_UNAVAILABLE')
        }
        await guard.check()
        await assertUploadPath(temporary, temporaryStat, Number(temporaryStat.size))
        await io.unlink(temporary)
        temporaryCreated = false
      } catch (cleanupError) {
        cleanupErrors.temporaryCleanupError = {
          code: cleanupError.code || 'UPLOAD_TEMPORARY_CLEANUP_FAILED',
          message: cleanupError.message || '上传失败后无法安全清理隐藏临时文件',
        }
      }
    }
    if (handle) {
      try {
        await handle.close()
      } catch (closeError) {
        cleanupErrors.temporaryCloseError = {
          code: closeError.code || 'UPLOAD_TEMPORARY_CLOSE_FAILED',
          message: closeError.message || '上传临时文件句柄关闭失败',
        }
      }
    }
    if (Object.keys(cleanupErrors).length) {
      try {
        if (error && typeof error === 'object') {
          error.details = { ...(error.details || {}), ...cleanupErrors }
        }
      } catch {
        // Cleanup diagnostics must never replace the original storage error.
      }
    }
    throw error
  } finally {
    await guard.close()
  }
}

function sameUploadIdentity(left, right) {
  return isUploadIdentity(left) && isUploadIdentity(right) &&
    left.dev === right.dev && left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs
}

function isUploadIdentity(stat) {
  return Boolean(stat?.isFile() && !stat.isSymbolicLink() &&
    typeof stat.dev === 'bigint' && typeof stat.ino === 'bigint' &&
    typeof stat.birthtimeNs === 'bigint')
}

function sameUploadSnapshot(left, right) {
  return sameUploadIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode
}

async function assertUploadPath(target, expected, expectedSize) {
  await assertSameEntry(target, expected, makeError)
  const current = await fs.lstat(target, { bigint: true })
  if (!sameUploadSnapshot(current, expected) || current.size !== BigInt(expectedSize)) {
    throw makeError('上传临时文件在操作期间发生变化', 'FILE_CHANGED')
  }
}

async function verifyUploadPathBytes(target, expected, bytes) {
  let handle
  try {
    const beforePath = await fs.lstat(target, { bigint: true })
    if (!sameUploadIdentity(beforePath, expected) || beforePath.size !== BigInt(bytes.byteLength)) {
      throw makeError('上传路径已不再指向已校验的文件', 'FILE_CHANGED')
    }
    await assertSameEntry(target, beforePath, () => makeError('上传路径在校验期间发生变化', 'FILE_CHANGED'))
    handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
    const opened = await handle.stat({ bigint: true })
    if (!sameUploadSnapshot(opened, beforePath) || opened.size !== BigInt(bytes.byteLength)) {
      throw makeError('上传文件身份在打开时发生变化', 'FILE_CHANGED')
    }
    await verifyUploadBytes(handle, bytes)
    const afterHandle = await handle.stat({ bigint: true })
    const afterPath = await fs.lstat(target, { bigint: true })
    if (!sameUploadSnapshot(opened, afterHandle) || !sameUploadSnapshot(afterHandle, afterPath)) {
      throw makeError('上传文件在内容校验期间发生变化', 'FILE_CHANGED')
    }
    await assertSameEntry(target, afterPath, () => makeError('上传路径在校验期间发生变化', 'FILE_CHANGED'))
    return afterHandle
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) {
      throw makeError('上传路径在发布期间发生变化', 'FILE_CHANGED')
    }
    throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function verifyUploadBytes(handle, bytes) {
  const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, bytes.byteLength)))
  let position = 0
  while (position < bytes.byteLength) {
    const length = Math.min(scratch.byteLength, bytes.byteLength - position)
    const { bytesRead } = await handle.read(scratch, 0, length, position)
    if (!bytesRead || !scratch.subarray(0, bytesRead).equals(bytes.subarray(position, position + bytesRead))) {
      throw makeError('上传临时文件内容校验失败', 'UPLOAD_VERIFY_FAILED')
    }
    position += bytesRead
  }
}

// 列出所有文件（用于判断是否为空工作空间）
export async function listAll(workspace) {
  return (await listTree(workspace)).filter(item => item.type === 'file')
}

// Startup only needs a yes/no answer for the welcome screen. Stop at the first
// visible regular file instead of allocating and sorting the complete tree.
export async function hasWorkspaceFiles(workspace) {
  const { full } = await existingPath(workspace, '')

  async function walk(directory, isRoot = false) {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (!isRoot && ['EACCES', 'EPERM'].includes(error.code)) return false
      throw error
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const entryPath = path.join(directory, entry.name)
      if (entry.isFile()) return true
      if (entry.isDirectory()) {
        const stat = await fs.lstat(entryPath)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory() && await walk(entryPath)) return true
        if (stat.isFile()) return true
        continue
      }

      const stat = await fs.lstat(entryPath)
      if (stat.isSymbolicLink()) continue
      if (stat.isFile()) return true
      if (stat.isDirectory() && await walk(entryPath)) return true
    }
    return false
  }

  return walk(full, true)
}

const SEARCH_READ_CONCURRENCY = 4
const SEARCH_RESULT_LIMIT = 100

// Search names in tree order and Markdown text in bounded batches. Batches
// preserve the old deterministic result order while allowing disk reads to
// overlap; resolving every entry in a batch before moving on also preserves
// the first-100-results behavior. At most SEARCH_READ_CONCURRENCY - 1 files
// can be read beyond the item that fills the result limit.
export async function searchWorkspace(workspace, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase()
  if (!normalizedQuery) return []

  const files = await listAll(workspace)
  const results = []
  let pendingMarkdown = []

  async function flushMarkdownBatch() {
    if (!pendingMarkdown.length) return true
    const batch = pendingMarkdown
    pendingMarkdown = []
    const matches = await Promise.all(batch.map(async item => {
      try {
        const content = (await readFile(workspace, item.path)).content
        const index = content.toLowerCase().indexOf(normalizedQuery)
        if (index === -1) return null
        return {
          ...item,
          preview: content.slice(Math.max(0, index - 40), index + 120).replace(/\s+/g, ' '),
        }
      } catch {
        // Files can disappear or become unreadable after the tree snapshot.
        return null
      }
    }))

    for (const match of matches) {
      if (match) results.push(match)
      if (results.length >= SEARCH_RESULT_LIMIT) return false
    }
    return true
  }

  for (const item of files) {
    if (item.name.toLowerCase().includes(normalizedQuery)) {
      if (!await flushMarkdownBatch()) return results
      results.push({ ...item })
      if (results.length >= SEARCH_RESULT_LIMIT) return results
      continue
    }
    if (!isMarkdownPath(item.name)) continue

    pendingMarkdown.push(item)
    if (pendingMarkdown.length >= SEARCH_READ_CONCURRENCY && !await flushMarkdownBatch()) {
      return results
    }
  }

  await flushMarkdownBatch()
  return results
}

export { makeError }
