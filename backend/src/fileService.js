import fs from 'fs/promises'
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
    currentContent: currentBytes == null ? null : currentBytes.toString('utf8'),
  }
  return error
}

function contentRevision(content) {
  return createHash('sha256').update(content).digest('hex')
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
    const real = await fs.realpath(target)
    assertInside(base, real)
    if (real !== target) throw makeError('不支持通过符号链接访问文件')
    return { base, target, parent, stat }
  } catch (error) {
    if (error.code !== 'ENOENT' || !allowMissing) throw error
    return { base, target, parent, stat: null }
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
    if (stat.isSymbolicLink()) continue
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
      // separate lstat for every normal file and directory; only unusual file
      // systems that report an unknown type need the slower fallback.
      if (entry.isSymbolicLink()) continue
      let type
      if (entry.isDirectory()) {
        // Recheck directories just before descending: if a directory was
        // replaced with a symlink after readdir, do not traverse its target.
        const stat = await fs.lstat(entryPath)
        if (stat.isSymbolicLink()) continue
        type = stat.isDirectory() ? 'dir' : 'file'
      } else if (
        entry.isFile() || entry.isBlockDevice() || entry.isCharacterDevice() ||
        entry.isFIFO() || entry.isSocket()
      ) {
        type = 'file'
      } else {
        const stat = await fs.lstat(entryPath)
        if (stat.isSymbolicLink()) continue
        type = stat.isDirectory() ? 'dir' : 'file'
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
  const { target, stat } = await fileLocation(workspace, reqPath)
  if (!stat) throw makeError('文件不存在', 'ENOENT')
  const bytes = await fs.readFile(target)
  return { content: bytes.toString('utf-8'), revision: contentRevision(bytes) }
}

export async function readFileBase64(workspace, reqPath) {
  const { full, stat } = await existingPath(workspace, reqPath)
  if (stat.isDirectory()) throw makeError('是目录不是文件')
  const ext = path.extname(full).toLowerCase().slice(1)
  const mime = IMAGE_MIMES[ext] || 'application/octet-stream'
  const buffer = await fs.readFile(full)
  return { mime, data: buffer.toString('base64'), name: path.basename(full) }
}

// 创建文件或目录，永远不覆盖已有目标。
export async function createItem(workspace, reqPath, type, name) {
  const cleanName = assertName(name)
  if (type !== 'file' && type !== 'dir') throw makeError('type 必须是 file 或 dir')
  const { base, full: targetDir } = await existingPath(workspace, reqPath || '')
  const targetDirStat = await fs.lstat(targetDir)
  if (!targetDirStat.isDirectory()) throw makeError('目标目录无效')
  const newPath = path.join(targetDir, cleanName)
  assertInside(base, newPath)
  await ensureDestinationDoesNotExist(newPath)
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
  await fs.rename(source.full, dest)
  try {
    await migrateHistoryForMove(source.base, source.full, dest, source.stat.isDirectory(), filesToMove, options)
  } catch (error) {
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
  let names
  try {
    names = await fs.readdir(bucket)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const owner = await readHistoryOwner(bucket)
  const entries = []
  for (const name of names.filter(item => item.endsWith('.json'))) {
    try {
      const stat = await fs.lstat(path.join(bucket, name))
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const entry = JSON.parse(await fs.readFile(path.join(bucket, name), 'utf-8'))
      const belongsToPath = owner.path === relative || (!owner.path && entry?.path === relative)
      if (entry?.version !== 1 || !belongsToPath || typeof entry.id !== 'string') continue
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
  try {
    const stat = await fs.lstat(bucket)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw makeError('恢复历史目录无效', 'RECOVERY_STORAGE_ERROR')
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function migrateHistoryForMove(base, sourcePath, destinationPath, isDirectory, files, options = {}) {
  const plans = []
  for (const sourceFile of files) {
    const destinationFile = isDirectory
      ? path.join(destinationPath, path.relative(sourcePath, sourceFile))
      : destinationPath
    const sourceHistory = (await historyBucket(base, sourceFile, options.root)).bucket
    if (!await historyBucketExists(sourceHistory)) continue
    const destinationHistory = (await historyBucket(base, destinationFile, options.root)).bucket
    if (await historyBucketExists(destinationHistory)) {
      throw makeError('目标路径已有恢复历史，无法安全移动文件', 'HISTORY_CONFLICT')
    }
    const oldRelative = relativePath(base, sourceFile)
    const newRelative = relativePath(base, destinationFile)
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
  const bytes = await fs.readFile(location.target)
  const currentRevision = contentRevision(bytes)
  if (expectedRevision !== currentRevision) throw fileConflict(reqPath, expectedRevision, bytes)
  return { bytes, mode: location.stat.mode & 0o777 }
}

async function writeBytesVersioned(workspace, reqPath, bytes, expectedRevision, options = {}) {
  validateExpectedRevision(expectedRevision)
  const location = await fileLocation(workspace, reqPath, { allowMissing: true })
  const { base, target, parent } = location
  const existing = await readCurrent(location, reqPath, expectedRevision)
  if (existing && existing.bytes.equals(bytes)) {
    return { success: true, path: relativePath(base, target), revision: contentRevision(existing.bytes) }
  }
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
        if (latestStat.isSymbolicLink() || latestStat.isDirectory()) throw makeError('目标文件已变化', 'FILE_CONFLICT')
        latest = await fs.readFile(target)
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
      try { current = await fs.readFile(target) } catch {}
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
  return writeBytesVersioned(workspace, reqPath, Buffer.from(content, 'utf-8'), expectedRevision, options)
}

export async function listFileHistory(workspace, reqPath, options = {}) {
  const location = await fileLocation(workspace, reqPath, { allowMissing: true })
  return { path: relativePath(location.base, location.target), history: await listHistory(workspace, location.base, location.target, options) }
}

// Delete exactly one validated recovery record. The current workspace file is
// only used to resolve the bucket and is never read or changed.
export async function deleteFileHistory(workspace, reqPath, historyId, options = {}) {
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
  return { success: true, path: relative, deletedHistoryId: historyId }
}

export async function restoreFileHistory(workspace, reqPath, historyId, expectedRevision, options = {}) {
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
export async function uploadFile(workspace, reqPath, file) {
  if (!file?.originalname) throw makeError('缺少文件')
  const cleanName = assertName(path.basename(file.originalname))
  if (cleanName !== file.originalname) throw makeError('文件名格式无效')
  const { base, full: targetDir } = await existingPath(workspace, reqPath || '')
  const dirStat = await fs.lstat(targetDir)
  if (!dirStat.isDirectory()) throw makeError('目标目录无效')
  const destPath = path.join(targetDir, cleanName)
  assertInside(base, destPath)
  await ensureDestinationDoesNotExist(destPath)
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
    if (!item.name.toLowerCase().endsWith('.md')) continue

    pendingMarkdown.push(item)
    if (pendingMarkdown.length >= SEARCH_READ_CONCURRENCY && !await flushMarkdownBatch()) {
      return results
    }
  }

  await flushMarkdownBatch()
  return results
}

export { makeError }
