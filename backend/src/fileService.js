import fs from 'fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'path'
import { Readable } from 'node:stream'
import { randomUUID } from 'crypto'
import {
  makeError,
  conflict,
  revisionRequired,
} from './errors.js'
import {
  MAX_EDITABLE_MARKDOWN_BYTES,
  MAX_MARKDOWN_PREVIEW_BYTES,
  markdownTooLarge,
  isMarkdownPath,
  assertMarkdownPath,
  decodeMarkdownBytes,
  encodeMarkdownContent,
  contentRevision,
} from './markdownBytes.js'
import {
  existingPath,
  parentPath,
  fileLocation,
  relativePath,
  assertInside,
  assertName,
  ensureDestinationDoesNotExist,
  openRegularFileHandle,
  readRegularFile,
} from './workspaceAccess.js'
import {
  archiveHistoryAtPath,
  storeHistory,
  pruneHistory,
  discardStoredHistory,
  reportRecoveryCleanupWarning,
  migrateHistoryForMove,
  reattachHistoryArchives,
  readHistoryEntry,
  readOrphanFileHistory,
  reattachTrashFileHistory,
} from './historyService.js'
import { extractMarkdownReferences, resolveWorkspaceReference } from './markdownMoveImpact.js'
import { assertSameEntry, moveEntryNoReplace, openWorkspaceParent } from './workspacePathGuard.js'

// The history module owns these APIs; re-exported here so existing importers
// (routes, tests, trash service) keep a stable import path.
export {
  archiveFileHistory,
  listOrphanFileHistory,
  deleteOrphanFileHistory,
  readOrphanFileHistory,
  reattachTrashFileHistory,
  listFileHistory,
  deleteFileHistory,
} from './historyService.js'

// Markdown byte/codec primitives moved to markdownBytes.js; the editable-size
// constants are part of fileService's established contract.
export {
  MAX_EDITABLE_MARKDOWN_BYTES,
  MAX_MARKDOWN_PREVIEW_BYTES,
} from './markdownBytes.js'

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
