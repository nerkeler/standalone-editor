import fs from 'fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'path'
import os from 'os'
import { createHash, randomUUID } from 'crypto'

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

function makeError(message, code = 'INVALID_PATH') {
  const error = new Error(message)
  error.code = code
  return error
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
async function existingPath(workspace, requestPath, { allowRoot = true } = {}) {
  const base = await workspaceBase(workspace)
  const full = lexicalPath(base, requestPath)
  if (!allowRoot && full === base) throw makeError('不能操作工作空间根目录')
  const stat = await fs.lstat(full)
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
    const entries = await fs.readdir(dir, { withFileTypes: true })
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
  const { target, stat } = location
  if (!stat) throw makeError('文件不存在', 'ENOENT')
  const bytes = await readRegularFile(location)
  return { content: decodeMarkdownBytes(bytes), revision: contentRevision(bytes) }
}

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
export async function openBinaryFile(workspace, reqPath) {
  if (typeof reqPath !== 'string') throw makeError('路径必须是字符串')
  const { base, full, stat } = await existingPath(workspace, reqPath)
  if (!stat.isFile()) throw makeError('不是普通文件', 'UNSUPPORTED_FILE_TYPE')
  const handle = await openRegularFileHandle({ base, target: full, stat })
  const openedStat = await handle.stat()
  return {
    stream: handle.createReadStream({ autoClose: true }),
    size: openedStat.size,
    name: path.basename(full),
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
  await ensureDestinationDoesNotExist(newPath)
  if (type === 'file' && isMarkdownPath(cleanName)) {
    await archiveHistoryAtPath(base, newPath, { ...options, reason: 'path-reused' })
  }
  if (type === 'dir') {
    await fs.mkdir(newPath)
  } else {
    const handle = await fs.open(newPath, 'wx')
    await handle.close()
  }
  return { path: relativePath(base, newPath), type, name: cleanName }
}

// 删除文件或目录。工作空间根目录不可删除。
export async function deleteItem(workspace, reqPath) {
  const { full, stat } = await existingPath(workspace, reqPath, { allowRoot: false })
  if (stat.isDirectory()) {
    await archiveHistoryAtPath(await workspaceBase(workspace), full, { reason: 'deleted', includeDescendants: true })
  } else if (stat.isFile() && isMarkdownPath(full)) {
    await archiveHistoryAtPath(await workspaceBase(workspace), full, { reason: 'deleted' })
  }
  await fs.rm(full, { recursive: stat.isDirectory(), force: false })
  return { success: true }
}

// 移动/重命名，目标存在时返回冲突，不覆盖目标。
export async function moveItem(workspace, oldPath, newPath, options = {}) {
  const source = await existingPath(workspace, oldPath, { allowRoot: false })
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
  await ensureDestinationDoesNotExist(dest)
  const filesToMove = await collectRegularFiles(source.full, source.stat)
  const displacedHistory = await archiveHistoryAtPath(source.base, dest, {
    ...options,
    reason: 'path-reused',
    includeDescendants: source.stat.isDirectory(),
  })
  let itemMoved = false
  try {
    await fs.rename(source.full, dest)
    itemMoved = true
    await migrateHistoryForMove(source.base, source.full, dest, source.stat.isDirectory(), filesToMove, options)
  } catch (error) {
    if (itemMoved) {
      try {
        await fs.rename(dest, source.full)
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
      throw makeError(`恢复历史目录不可用：${error.message}`, 'RECOVERY_STORAGE_ERROR')
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
    throw makeError(`恢复历史目录不可用：${error.message}`, 'RECOVERY_STORAGE_ERROR')
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

  const savedAt = new Date().toISOString()
  const id = randomUUID()
  const entry = {
    version: 1,
    id,
    path: relative,
    revision: contentRevision(bytes),
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
    throw makeError(`无法保存文件恢复历史：${error.message}`, 'RECOVERY_STORAGE_ERROR')
  }

  const entries = []
  for (const name of (await fs.readdir(bucket)).filter(item => item.endsWith('.json'))) {
    try {
      const entry = JSON.parse(await fs.readFile(path.join(bucket, name), 'utf-8'))
      if (typeof entry.savedAt === 'string') entries.push({ name, savedAt: entry.savedAt })
    } catch {}
  }
  entries.sort((a, b) => a.savedAt.localeCompare(b.savedAt))
  const excess = entries.length - HISTORY_RETENTION_PER_FILE
  if (excess > 0) {
    await Promise.all(entries.slice(0, excess).map(entry => fs.unlink(path.join(bucket, entry.name))))
  }
  return { id, revision: entry.revision, savedAt, size: entry.size }
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
  const bytes = Buffer.from(entry.contentBase64, 'base64')
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
    throw makeError(`无法更新恢复历史归属：${error.message}`, 'RECOVERY_STORAGE_ERROR')
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
    throw makeError(`无法标记孤儿历史：${error.message}`, 'RECOVERY_STORAGE_ERROR')
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
    throw makeError(`无法归档旧路径历史：${error.message}`, 'RECOVERY_STORAGE_ERROR')
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
  const bytes = Buffer.from(entry.contentBase64, 'base64')
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
  decodeMarkdownBytes(bytes)
  validateExpectedRevision(expectedRevision)
  const location = await fileLocation(workspace, reqPath, { allowMissing: true })
  const { base, target, parent } = location
  const existing = await readCurrent(location, reqPath, expectedRevision)
  if (existing && existing.bytes.equals(bytes)) {
    return { success: true, path: relativePath(base, target), revision: contentRevision(existing.bytes) }
  }
  if (!existing) await archiveHistoryAtPath(base, target, { root: options.root, reason: 'path-reused' })
  const name = path.basename(target)
  const relative = relativePath(base, target)

  if (existing) await storeHistory(workspace, base, target, existing.bytes, options)

  const temporary = path.join(parent, `.${name}.${randomUUID()}.tmp`)
  const mode = existing ? existing.mode : 0o600
  try {
    const handle = await fs.open(temporary, 'wx', mode)
    try { await handle.writeFile(bytes) } finally { await handle.close() }
    await fs.chmod(temporary, mode)

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
        if (latestMode !== mode) await fs.chmod(temporary, latestMode)
      } catch (error) {
        if (error.code === 'ENOENT') throw fileConflict(reqPath, expectedRevision, null)
        throw error
      }
      if (contentRevision(latest) !== expectedRevision) throw fileConflict(reqPath, expectedRevision, latest)
      await fs.rename(temporary, target)
    } else {
      // The null revision means create-if-absent. link is an atomic exclusive
      // install, so another creator cannot be silently overwritten.
      await fs.link(temporary, target)
      await fs.unlink(temporary)
    }
  } catch (error) {
    try { await fs.unlink(temporary) } catch {}
    if (error.code === 'EEXIST' && expectedRevision === null) {
      let current = null
      try {
        const stat = await fs.lstat(target)
        if (stat.isFile() && !stat.isSymbolicLink()) current = await readRegularFile({ base, target, stat })
      } catch {}
      throw fileConflict(reqPath, expectedRevision, current)
    }
    throw error
  }
  return { success: true, path: relative, revision: contentRevision(bytes) }
}

// Versioned write. Existing files require the SHA-256 revision returned by
// readFile; null means create only if the destination does not exist.
export async function writeFile(workspace, reqPath, content, expectedRevision, options = {}) {
  if (typeof content !== 'string') throw makeError('content 必须是字符串', 'INVALID_CONTENT')
  assertMarkdownPath(reqPath)
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
    recordStat = await fs.lstat(entryPath)
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
    currentStat = await fs.lstat(entryPath)
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
  const current = await readCurrent(location, reqPath, expectedRevision)
  const { bytes } = await readHistoryEntry(workspace, location.base, location.target, historyId, options)
  // Restoring uses the same optimistic check, history capture and atomic write
  // path as a regular save. A stale restore request cannot overwrite newer data.
  const result = await writeBytesVersioned(workspace, reqPath, bytes, expectedRevision, options)
  return { ...result, restoredHistoryId: historyId, previousRevision: current?.bytes ? contentRevision(current.bytes) : null }
}

// 上传文件，永远不覆盖已有目标。
export async function uploadFile(workspace, reqPath, file, options = {}) {
  if (!file?.originalname) throw makeError('缺少文件')
  const cleanName = assertName(path.basename(file.originalname))
  if (cleanName !== file.originalname) throw makeError('文件名格式无效')
  const { base, full: targetDir } = await existingPath(workspace, reqPath || '')
  const dirStat = await fs.lstat(targetDir)
  if (!dirStat.isDirectory()) throw makeError('目标目录无效')
  const destPath = path.join(targetDir, cleanName)
  assertInside(base, destPath)
  await ensureDestinationDoesNotExist(destPath)
  if (isMarkdownPath(cleanName)) {
    await archiveHistoryAtPath(base, destPath, { ...options, reason: 'path-reused' })
  }
  const handle = await fs.open(destPath, 'wx')
  try {
    await handle.writeFile(file.buffer)
  } finally {
    await handle.close()
  }
  return { filename: cleanName, path: relativePath(base, destPath) }
}

// 列出所有文件（用于判断是否为空工作空间）
export async function listAll(workspace) {
  return (await listTree(workspace)).filter(item => item.type === 'file')
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
