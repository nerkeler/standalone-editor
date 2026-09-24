import fs from 'node:fs/promises'
import { constants as fsConstants, createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const MANIFEST_NAME = 'entry.json'
const PAYLOAD_NAME = 'payload'
const COPY_NAME = 'payload.copying'
const DEFAULT_RETENTION_DAYS = 30

function serviceError(message, code = 'INVALID_PATH') {
  const error = new Error(message)
  error.code = code
  return error
}

function isWithin(base, target) {
  const relative = path.relative(base, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function assertNotWithin(base, target) {
  if (isWithin(base, target)) throw serviceError('回收站必须位于工作空间之外', 'INVALID_RECOVERY_ROOT')
}

function cleanRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)) {
    throw serviceError('路径必须是工作空间内的相对路径')
  }
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) throw serviceError('路径格式无效')
  return parts.join(path.sep)
}

function slashPath(value) {
  return value.split(path.sep).join('/')
}

function hashWorkspace(realWorkspace) {
  return createHash('sha256').update(realWorkspace).digest('hex')
}

async function canonicalDirectory(value, label) {
  let real
  try {
    real = await fs.realpath(value)
  } catch (error) {
    if (label === '工作空间') throw error
    await fs.mkdir(value, { recursive: true, mode: 0o700 })
    real = await fs.realpath(value)
  }
  const stat = await fs.stat(real)
  if (!stat.isDirectory()) throw serviceError(`${label}不是目录`, label === '工作空间' ? 'INVALID_WORKSPACE' : 'INVALID_RECOVERY_ROOT')
  return real
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw serviceError('回收站目录无效', 'INVALID_RECOVERY_ROOT')
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700)
  const real = await fs.realpath(directory)
  if (real !== directory) throw serviceError('回收站路径不能经过符号链接', 'INVALID_RECOVERY_ROOT')
}

async function resolveWorkspaceItem(realWorkspace, requestPath, { allowRoot = false } = {}) {
  const relative = cleanRelativePath(requestPath)
  const fullPath = path.resolve(realWorkspace, relative)
  if (!isWithin(realWorkspace, fullPath)) throw serviceError('路径超出工作空间')
  if (!allowRoot && fullPath === realWorkspace) throw serviceError('不能操作工作空间根目录')
  const segments = relative.split(path.sep)
  let cursor = realWorkspace
  for (const segment of segments) {
    cursor = path.join(cursor, segment)
    const stat = await fs.lstat(cursor)
    if (stat.isSymbolicLink()) throw serviceError('不支持通过符号链接访问文件')
  }
  const real = await fs.realpath(fullPath)
  if (!isWithin(realWorkspace, real) || real !== fullPath) throw serviceError('路径超出工作空间')
  return { fullPath, relativePath: slashPath(relative), stat: await fs.lstat(fullPath) }
}

async function assertSafeRestorationParent(realWorkspace, relativePath) {
  const clean = cleanRelativePath(relativePath)
  const fullPath = path.resolve(realWorkspace, clean)
  if (!isWithin(realWorkspace, fullPath) || fullPath === realWorkspace) throw serviceError('恢复路径无效')
  const parent = path.dirname(fullPath)
  const relativeParent = path.relative(realWorkspace, parent)
  let cursor = realWorkspace
  if (relativeParent) {
    for (const segment of relativeParent.split(path.sep)) {
      cursor = path.join(cursor, segment)
      const stat = await fs.lstat(cursor)
      if (stat.isSymbolicLink()) throw serviceError('不支持通过符号链接恢复文件')
      if (!stat.isDirectory()) throw serviceError('原目录不存在')
    }
  }
  const parentReal = await fs.realpath(parent)
  if (parentReal !== parent || !isWithin(realWorkspace, parentReal)) throw serviceError('恢复路径超出工作空间')
  return fullPath
}

async function assertTreeCopyable(rootPath) {
  const entries = []
  async function walk(fullPath, relative = '') {
    const stat = await fs.lstat(fullPath)
    if (stat.isSymbolicLink()) throw serviceError('回收站不支持包含符号链接的项目')
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 })
      const names = (await fs.readdir(fullPath)).sort()
      for (const name of names) {
        await walk(path.join(fullPath, name), relative ? path.join(relative, name) : name)
      }
      return
    }
    if (!stat.isFile()) throw serviceError('回收站不支持特殊文件')
    entries.push({
      path: relative,
      type: 'file',
      size: stat.size,
      mode: stat.mode & 0o777,
      sha256: await sha256(fullPath),
    })
  }
  await walk(rootPath)
  return entries
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function snapshotsEqual(left, right) {
  if (left.length !== right.length) return false
  return left.every((entry, index) => {
    const other = right[index]
    return entry.path === other.path && entry.type === other.type && entry.mode === other.mode &&
      entry.size === other.size && entry.sha256 === other.sha256
  })
}

async function copyTree(source, destination, copyFile = fs.copyFile) {
  const rootStat = await fs.lstat(source)
  if (rootStat.isDirectory()) {
    await fs.mkdir(destination, { mode: rootStat.mode & 0o777 })
    const names = (await fs.readdir(source)).sort()
    for (const name of names) await copyTree(path.join(source, name), path.join(destination, name), copyFile)
    await fs.chmod(destination, rootStat.mode & 0o777).catch(() => {})
    await fs.utimes(destination, rootStat.atime, rootStat.mtime).catch(() => {})
    return
  }
  if (rootStat.isSymbolicLink() || !rootStat.isFile()) throw serviceError('回收站不支持特殊文件')
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
  await fs.chmod(destination, rootStat.mode & 0o777).catch(() => {})
  await fs.utimes(destination, rootStat.atime, rootStat.mtime).catch(() => {})
}

async function copyAndVerify(source, destination, copyFile = fs.copyFile) {
  const before = await assertTreeCopyable(source)
  await copyTree(source, destination, copyFile)
  const [afterSource, copied] = await Promise.all([
    assertTreeCopyable(source),
    assertTreeCopyable(destination),
  ])
  if (!snapshotsEqual(before, afterSource) || !snapshotsEqual(before, copied)) {
    throw serviceError('文件在暂存期间发生变化，未移动到回收站', 'FILE_CHANGED')
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, filePath)
  } catch (error) {
    await fs.unlink(temporary).catch(() => {})
    throw error
  }
}

async function readManifest(entryDirectory, expectedId, workspaceId) {
  const manifestPath = path.join(entryDirectory, MANIFEST_NAME)
  const stat = await fs.lstat(manifestPath)
  if (stat.isSymbolicLink() || !stat.isFile()) throw serviceError('回收站记录无效', 'INVALID_TRASH_ENTRY')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (
    manifest.version !== 1 || manifest.id !== expectedId || manifest.workspaceId !== workspaceId ||
    typeof manifest.originalPath !== 'string' || typeof manifest.createdAt !== 'string' ||
    !['staging', 'ready'].includes(manifest.state)
  ) throw serviceError('回收站记录无效', 'INVALID_TRASH_ENTRY')
  cleanRelativePath(manifest.originalPath)
  return manifest
}

async function existsNoFollow(filePath) {
  try {
    return await fs.lstat(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function createTrashService(workspace, options = {}) {
  if (typeof workspace !== 'string' || !workspace) throw serviceError('缺少工作空间', 'INVALID_WORKSPACE')
  const recoveryRootOption = options.recoveryRoot || process.env.EDITOR_RECOVERY_DIR ||
    process.env.EDITOR_RECOVERY_ROOT || process.env.STANDALONE_EDITOR_RECOVERY_ROOT ||
    path.join(os.homedir(), '.standalone-editor', 'recovery')
  const retentionDays = Number.isFinite(options.retentionDays) && options.retentionDays >= 0
    ? options.retentionDays
    : DEFAULT_RETENTION_DAYS
  const rename = options.rename || fs.rename
  const copyFile = options.copyFile || fs.copyFile
  const now = options.now || (() => new Date())

  async function locations() {
    const realWorkspace = await fs.realpath(workspace)
    const workspaceStat = await fs.stat(realWorkspace)
    if (!workspaceStat.isDirectory()) throw serviceError('工作空间不是目录', 'INVALID_WORKSPACE')

    const configuredRoot = path.resolve(recoveryRootOption)
    const recoveryRoot = await canonicalDirectory(configuredRoot, '回收站')
    const workspaceId = hashWorkspace(realWorkspace)
    const trashRoot = path.join(recoveryRoot, 'trash')
    const workspaceRecovery = path.join(trashRoot, workspaceId)
    const trashDirectory = workspaceRecovery
    assertNotWithin(realWorkspace, trashDirectory)
    await ensurePrivateDirectory(trashRoot)
    await ensurePrivateDirectory(workspaceRecovery)
    return { realWorkspace, workspaceId, trashDirectory }
  }

  async function list() {
    const { trashDirectory, workspaceId } = await locations()
    const names = (await fs.readdir(trashDirectory)).sort()
    const entries = []
    for (const id of names) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) continue
      const entryDirectory = path.join(trashDirectory, id)
      const entryStat = await existsNoFollow(entryDirectory)
      if (!entryStat || entryStat.isSymbolicLink() || !entryStat.isDirectory()) continue
      let manifest
      try {
        manifest = await readManifest(entryDirectory, id, workspaceId)
        const payloadStat = await existsNoFollow(path.join(entryDirectory, PAYLOAD_NAME))
        if (!payloadStat || payloadStat.isSymbolicLink()) continue
      } catch {
        continue
      }
      entries.push({
        id: manifest.id,
        path: manifest.originalPath,
        name: path.posix.basename(manifest.originalPath),
        type: manifest.type,
        createdAt: manifest.createdAt,
        expiresAt: manifest.expiresAt,
        state: manifest.state,
      })
    }
    return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async function trash(requestPath) {
    const { realWorkspace, workspaceId, trashDirectory } = await locations()
    const item = await resolveWorkspaceItem(realWorkspace, requestPath)
    if (!item.stat.isDirectory() && !item.stat.isFile()) throw serviceError('回收站不支持特殊文件')
    // Refuse a directory containing a symlink or special file. This operation
    // moves hidden children too; it never follows links outside the workspace.
    await assertTreeCopyable(item.fullPath)

    const id = randomUUID()
    const entryDirectory = path.join(trashDirectory, id)
    const payloadPath = path.join(entryDirectory, PAYLOAD_NAME)
    await fs.mkdir(entryDirectory, { mode: 0o700 })
    const created = now()
    const manifest = {
      version: 1,
      id,
      workspaceId,
      originalPath: item.relativePath,
      type: item.stat.isDirectory() ? 'directory' : 'file',
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString(),
      state: 'staging',
    }
    const manifestPath = path.join(entryDirectory, MANIFEST_NAME)
    try {
      await writeJsonAtomic(manifestPath, manifest)
      try {
        await rename(item.fullPath, payloadPath)
      } catch (error) {
        if (error.code !== 'EXDEV') throw error
        const temporaryPath = path.join(entryDirectory, COPY_NAME)
        await copyAndVerify(item.fullPath, temporaryPath, copyFile)
        // Keep the original until a verified copy is durably staged. The
        // helper only removes the source after that condition holds.
        const [sourceSnapshot, stagedSnapshot] = await Promise.all([
          assertTreeCopyable(item.fullPath),
          assertTreeCopyable(temporaryPath),
        ])
        if (!snapshotsEqual(sourceSnapshot, stagedSnapshot)) {
          throw serviceError('文件在暂存期间发生变化，未移动到回收站', 'FILE_CHANGED')
        }
        await fs.rename(temporaryPath, payloadPath)
        await writeJsonAtomic(manifestPath, { ...manifest, state: 'ready' })
        await fs.rm(item.fullPath, { recursive: true, force: false })
        return { id, path: item.relativePath, type: manifest.type, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt }
      }
      await writeJsonAtomic(manifestPath, { ...manifest, state: 'ready' })
      return { id, path: item.relativePath, type: manifest.type, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt }
    } catch (error) {
      // If a post-move metadata update fails, put the payload back whenever
      // the original name remains free. A staged payload stays visible through
      // list() if rollback cannot be completed.
      let payloadRetained = false
      if (await existsNoFollow(payloadPath)) {
        try {
          const original = path.resolve(realWorkspace, item.relativePath.split('/').join(path.sep))
          if (!(await existsNoFollow(original))) {
            await rename(payloadPath, original)
          } else {
            payloadRetained = true
          }
        } catch {
          payloadRetained = true
        }
      }
      if (!payloadRetained) await fs.rm(entryDirectory, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async function restore(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw serviceError('回收站项目无效', 'INVALID_TRASH_ENTRY')
    const { realWorkspace, workspaceId, trashDirectory } = await locations()
    const entryDirectory = path.join(trashDirectory, id)
    const entryStat = await fs.lstat(entryDirectory)
    if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) throw serviceError('回收站项目不存在', 'ENOENT')
    const manifest = await readManifest(entryDirectory, id, workspaceId)
    const payloadPath = path.join(entryDirectory, PAYLOAD_NAME)
    const payloadStat = await fs.lstat(payloadPath)
    if (payloadStat.isSymbolicLink()) throw serviceError('回收站内容无效', 'INVALID_TRASH_ENTRY')
    const target = await assertSafeRestorationParent(realWorkspace, manifest.originalPath)
    if (await existsNoFollow(target)) throw serviceError('原位置已有同名项目，无法恢复', 'CONFLICT')

    if (typeof rename === 'function') {
      try {
        await rename(payloadPath, target)
        await fs.rm(entryDirectory, { recursive: true, force: false })
        return { success: true, path: manifest.originalPath }
      } catch (error) {
        if (error.code !== 'EXDEV') throw error
      }
    }

    // Recovery storage may live on another volume. Copy to a sibling staging
    // path, verify the complete tree, then publish it at the original name.
    const temporaryTarget = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.restoring`)
    try {
      await copyAndVerify(payloadPath, temporaryTarget, copyFile)
      if (await existsNoFollow(target)) throw serviceError('原位置已有同名项目，无法恢复', 'CONFLICT')
      await fs.rename(temporaryTarget, target)
      await fs.rm(entryDirectory, { recursive: true, force: false })
      return { success: true, path: manifest.originalPath }
    } catch (error) {
      if (await existsNoFollow(temporaryTarget)) await fs.rm(temporaryTarget, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async function purgeExpired({ at = now() } = {}) {
    const { trashDirectory, workspaceId } = await locations()
    const entries = await list()
    const expiredIds = entries.filter(item => Date.parse(item.expiresAt) <= at.getTime()).map(item => item.id)
    let purged = 0
    for (const id of expiredIds) {
      const entryDirectory = path.join(trashDirectory, id)
      const manifest = await readManifest(entryDirectory, id, workspaceId)
      // Expiration cleanup is an explicit maintenance operation, separate
      // from the user-facing trash and restore flows.
      if (manifest.state === 'ready' && Date.parse(manifest.expiresAt) <= at.getTime()) {
        await fs.rm(entryDirectory, { recursive: true, force: false })
        purged += 1
      }
    }
    return { purged }
  }

  return { trash, list, restore, purgeExpired }
}
