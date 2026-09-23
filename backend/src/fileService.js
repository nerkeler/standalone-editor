import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

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
  const { full, stat } = await existingPath(workspace, reqPath)
  if (stat.isDirectory()) throw makeError('是目录不是文件')
  const content = await fs.readFile(full, 'utf-8')
  return { content }
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
export async function moveItem(workspace, oldPath, newPath) {
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
  await fs.rename(source.full, dest)
  return { success: true }
}

// 写入文件。写入本身允许更新已有文件，但会使用同目录临时文件原子替换。
export async function writeFile(workspace, reqPath, content) {
  const { base, full, parent } = await parentPath(workspace, reqPath)
  const name = assertName(path.basename(full))
  const target = path.join(parent, name)
  let existing
  try {
    existing = await fs.lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (existing?.isSymbolicLink()) throw makeError('不支持写入符号链接')
  if (existing?.isDirectory()) throw makeError('是目录不是文件')
  const temporary = path.join(parent, `.${name}.${randomUUID()}.tmp`)
  // The temporary file is atomically renamed over the target. Explicitly
  // carry the existing permission bits across that replacement; otherwise a
  // private 0600 note silently becomes the process umask's usual 0644 file.
  const mode = existing ? (existing.mode & 0o777) : 0o600
  try {
    await fs.writeFile(temporary, content ?? '', { encoding: 'utf-8', flag: 'wx', mode })
    await fs.rename(temporary, target)
  } catch (error) {
    try { await fs.unlink(temporary) } catch {}
    throw error
  }
  return { success: true, path: relativePath(base, target) }
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
