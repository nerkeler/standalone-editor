import fs from 'node:fs/promises'
import { constants as fsConstants, createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { assertSameEntry, moveEntryNoReplace, openWorkspaceParent } from './workspacePathGuard.js'

const MANIFEST_NAME = 'entry.json'
const PAYLOAD_NAME = 'payload'
const COPY_NAME = 'payload.copying'
const DEFAULT_RETENTION_DAYS = 30
const PENDING_SOURCE_PHASES = new Set(['prepared', 'quarantined', 'cleanup'])
const entryLocks = new Map()

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

async function canonicalDirectory(value, label, { create = true } = {}) {
  let real
  try {
    real = await fs.realpath(value)
  } catch (error) {
    if (label === '工作空间') throw error
    if (!create && error.code === 'ENOENT') return null
    await fs.mkdir(value, { recursive: true, mode: 0o700 })
    real = await fs.realpath(value)
  }
  const stat = await fs.stat(real)
  if (!stat.isDirectory()) throw serviceError(`${label}不是目录`, label === '工作空间' ? 'INVALID_WORKSPACE' : 'INVALID_RECOVERY_ROOT')
  return real
}

async function existingDirectory(directory, label) {
  const stat = await existsNoFollow(directory)
  if (!stat) return false
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw serviceError(`${label}目录无效`, label === '回收站' ? 'INVALID_RECOVERY_ROOT' : 'INVALID_TRASH_ENTRY')
  }
  const real = await fs.realpath(directory)
  if (real !== directory) throw serviceError(`${label}路径不能经过符号链接`, 'INVALID_RECOVERY_ROOT')
  return true
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
  return { fullPath, relativePath: slashPath(relative), stat: await fs.lstat(fullPath, { bigint: true }) }
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
  return before
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(temporary, filePath)
    // The source quarantine rename must never begin until its recovery intent
    // is durable. Sync the directory after atomically publishing the manifest.
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(filePath), fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0))
      try { await directory.sync() } finally { await directory.close() }
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.unlink(temporary).catch(() => {})
    throw error
  }
}

function treeFingerprint(snapshot) {
  const hash = createHash('sha256')
  for (const entry of snapshot) {
    hash.update(JSON.stringify([
      entry.path,
      entry.type,
      entry.size ?? null,
      entry.mode,
      entry.sha256 ?? null,
    ]))
    hash.update('\n')
  }
  return { entries: snapshot.length, sha256: hash.digest('hex') }
}

function serializeIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unsupported',
    mode: Number(stat.mode & 0o777n),
  }
}

function matchesIdentity(stat, expected) {
  const mode = typeof stat?.mode === 'bigint' ? Number(stat.mode & 0o777n) : (stat?.mode & 0o777)
  return Boolean(stat && !stat.isSymbolicLink() &&
    String(stat.dev) === expected.dev && String(stat.ino) === expected.ino &&
    (stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unsupported') === expected.type &&
    mode === expected.mode)
}

function expectedQuarantineRelativePath(manifest) {
  const sourcePath = cleanRelativePath(manifest.originalPath)
  const quarantinePath = path.join(path.dirname(sourcePath), `.trash-pending-${manifest.id}`)
  return slashPath(quarantinePath)
}

function validateSourceRemoval(manifest) {
  const removal = manifest.sourceRemoval
  if (removal === undefined) return null
  if (!removal || removal.version !== 1 || !PENDING_SOURCE_PHASES.has(removal.phase) ||
    typeof removal.sourceQuarantinePath !== 'string' ||
    removal.sourceQuarantinePath !== expectedQuarantineRelativePath(manifest)) {
    throw serviceError('回收站恢复日志无效', 'INVALID_TRASH_JOURNAL')
  }
  const validIdentity = identity => identity &&
    typeof identity.dev === 'string' && /^\d+$/.test(identity.dev) &&
    typeof identity.ino === 'string' && /^\d+$/.test(identity.ino) &&
    ['file', 'directory'].includes(identity.type) && Number.isInteger(identity.mode) &&
    identity.mode >= 0 && identity.mode <= 0o777
  const fingerprint = removal.treeFingerprint
  if (!validIdentity(removal.sourceIdentity) || !validIdentity(removal.payloadIdentity) ||
    !fingerprint || !Number.isInteger(fingerprint.entries) || fingerprint.entries < 1 ||
    typeof fingerprint.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint.sha256)) {
    throw serviceError('回收站恢复日志无效', 'INVALID_TRASH_JOURNAL')
  }
  return removal
}

async function treeMatchesFingerprint(rootPath, expected) {
  try {
    const actual = treeFingerprint(await assertTreeCopyable(rootPath))
    return actual.entries === expected.entries && actual.sha256 === expected.sha256
  } catch {
    return false
  }
}

async function acquireEntryLock(key) {
  const previous = entryLocks.get(key) || Promise.resolve()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const queued = previous.then(() => gate)
  entryLocks.set(key, queued)
  await previous
  return () => {
    release()
    if (entryLocks.get(key) === queued) entryLocks.delete(key)
  }
}

async function withEntryLock(key, operation) {
  const release = await acquireEntryLock(key)
  try { return await operation() } finally { release() }
}

function lockKey(trashDirectory, id) {
  return `${trashDirectory}${path.sep}${id}`
}

async function readManifest(entryDirectory, expectedId, workspaceId) {
  const directoryStat = await fs.lstat(entryDirectory)
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw serviceError('回收站记录无效', 'INVALID_TRASH_ENTRY')
  }
  const realDirectory = await fs.realpath(entryDirectory)
  if (realDirectory !== entryDirectory) throw serviceError('回收站路径不能经过符号链接', 'INVALID_TRASH_ENTRY')
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

async function existsNoFollow(filePath, options) {
  try {
    return await fs.lstat(filePath, options)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function regularFileBytes(rootPath) {
  const rootStat = await existsNoFollow(rootPath)
  if (!rootStat || rootStat.isSymbolicLink()) return 0
  if (rootStat.isFile()) return rootStat.size
  if (!rootStat.isDirectory()) return 0

  let bytes = 0
  for (const name of await fs.readdir(rootPath)) {
    bytes += await regularFileBytes(path.join(rootPath, name))
  }
  return bytes
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
  const linkFile = options.linkFile || fs.link
  const copyFile = options.copyFile || fs.copyFile
  const now = options.now || (() => new Date())

  async function locations({ createRecovery = true } = {}) {
    const realWorkspace = await fs.realpath(workspace)
    const workspaceStat = await fs.stat(realWorkspace)
    if (!workspaceStat.isDirectory()) throw serviceError('工作空间不是目录', 'INVALID_WORKSPACE')

    const configuredRoot = path.resolve(recoveryRootOption)
    const recoveryRoot = await canonicalDirectory(configuredRoot, '回收站', { create: createRecovery })
    if (!recoveryRoot) return { realWorkspace, workspaceId: hashWorkspace(realWorkspace), trashDirectory: null }
    const workspaceId = hashWorkspace(realWorkspace)
    const trashRoot = path.join(recoveryRoot, 'trash')
    const workspaceRecovery = path.join(trashRoot, workspaceId)
    const trashDirectory = workspaceRecovery
    assertNotWithin(realWorkspace, trashDirectory)
    if (createRecovery) {
      await ensurePrivateDirectory(trashRoot)
      await ensurePrivateDirectory(workspaceRecovery)
    } else {
      const hasTrashRoot = await existingDirectory(trashRoot, '回收站')
      const hasWorkspaceRecovery = hasTrashRoot && await existingDirectory(workspaceRecovery, '回收站')
      if (!hasWorkspaceRecovery) return { realWorkspace, workspaceId, trashDirectory: null }
    }
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
        pendingRecovery: Boolean(manifest.sourceRemoval),
      })
    }
    return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async function reconcileOne(realWorkspace, workspaceId, trashDirectory, id) {
    const entryDirectory = path.join(trashDirectory, id)
    const manifest = await readManifest(entryDirectory, id, workspaceId)
    const removal = validateSourceRemoval(manifest)
    if (!removal) return { kind: 'none' }

    const sourcePath = path.resolve(realWorkspace, cleanRelativePath(manifest.originalPath))
    const quarantinePath = path.resolve(realWorkspace, cleanRelativePath(removal.sourceQuarantinePath))
    const payloadPath = path.join(entryDirectory, PAYLOAD_NAME)
    const makeIssue = (code, message) => ({
      id,
      path: manifest.originalPath,
      code,
      message,
      sourceQuarantinePath: removal.sourceQuarantinePath,
    })

    try {
      await assertSafeRestorationParent(realWorkspace, manifest.originalPath)
      await assertSafeRestorationParent(realWorkspace, removal.sourceQuarantinePath)
    } catch (error) {
      return { kind: 'issue', issue: makeIssue(error.code || 'INVALID_PATH', '原路径或隔离路径经过了不安全的目录，相关内容已保留') }
    }

    const payloadStat = await existsNoFollow(payloadPath, { bigint: true })
    if (!matchesIdentity(payloadStat, removal.payloadIdentity) ||
      !(await treeMatchesFingerprint(payloadPath, removal.treeFingerprint))) {
      return { kind: 'issue', issue: makeIssue('RECOVERY_COPY_CHANGED', '已验证的回收站副本发生变化，隔离内容已保留') }
    }

    let sourceStat
    let quarantineStat
    try {
      ;[sourceStat, quarantineStat] = await Promise.all([
        existsNoFollow(sourcePath, { bigint: true }),
        existsNoFollow(quarantinePath, { bigint: true }),
      ])
    } catch (error) {
      return { kind: 'issue', issue: makeIssue(error.code || 'PATH_CHECK_FAILED', '无法安全检查原路径和隔离路径，内容已保留') }
    }

    if (quarantineStat) {
      if (!matchesIdentity(quarantineStat, removal.sourceIdentity) ||
        !(await treeMatchesFingerprint(quarantinePath, removal.treeFingerprint))) {
        return { kind: 'issue', issue: makeIssue('QUARANTINE_CHANGED', '隔离内容与中断前记录不一致，原内容和回收站副本均已保留') }
      }
      if (sourceStat) {
        return { kind: 'issue', issue: makeIssue('RESTORE_PATH_OCCUPIED', '原路径已有内容，隔离内容未覆盖且仍保留') }
      }

      let guard
      try {
        guard = await openWorkspaceParent(realWorkspace, sourcePath, serviceError)
        await guard.check()
        await assertSafeRestorationParent(realWorkspace, manifest.originalPath)
        const currentQuarantine = await fs.lstat(quarantinePath, { bigint: true })
        const currentPayload = await existsNoFollow(payloadPath, { bigint: true })
        if (!matchesIdentity(currentQuarantine, removal.sourceIdentity) ||
          !(await treeMatchesFingerprint(quarantinePath, removal.treeFingerprint))) {
          return { kind: 'issue', issue: makeIssue('QUARANTINE_CHANGED', '隔离内容在恢复前发生变化，内容已保留') }
        }
        if (!matchesIdentity(currentPayload, removal.payloadIdentity) ||
          !(await treeMatchesFingerprint(payloadPath, removal.treeFingerprint))) {
          return { kind: 'issue', issue: makeIssue('RECOVERY_COPY_CHANGED', '回收站副本在恢复前发生变化，隔离内容已保留') }
        }
        await moveEntryNoReplace(quarantinePath, sourcePath, currentQuarantine, {
          check: () => guard.check(),
          errorFactory: serviceError,
          conflictFactory: () => serviceError('原位置已有同名项目，隔离内容仍保留', 'CONFLICT'),
          rename,
          link: linkFile,
        })
        if (!(await treeMatchesFingerprint(sourcePath, removal.treeFingerprint))) {
          return { kind: 'issue', issue: makeIssue('SOURCE_CHANGED', '隔离内容在恢复期间发生变化；原路径与回收站副本均已保留') }
        }
        const cleared = { ...manifest }
        delete cleared.sourceRemoval
        await writeJsonAtomic(path.join(entryDirectory, MANIFEST_NAME), cleared)
        return { kind: 'restored', item: { id, path: manifest.originalPath } }
      } catch (error) {
        return { kind: 'issue', issue: makeIssue(error.code || 'RESTORE_FAILED', '无法安全恢复隔离内容，原内容和回收站副本均已保留') }
      } finally {
        await guard?.close()
      }
    }

    if (sourceStat) {
      if (matchesIdentity(sourceStat, removal.sourceIdentity) &&
        await treeMatchesFingerprint(sourcePath, removal.treeFingerprint)) {
        const cleared = { ...manifest }
        delete cleared.sourceRemoval
        try {
          await writeJsonAtomic(path.join(entryDirectory, MANIFEST_NAME), cleared)
        } catch (error) {
          return { kind: 'issue', issue: makeIssue(error.code || 'JOURNAL_UPDATE_FAILED', '原内容完整保留，但恢复日志清理失败') }
        }
        if (removal.phase !== 'prepared') {
          return { kind: 'restored', item: { id, path: manifest.originalPath } }
        }
        return {
          kind: 'issue',
          issue: makeIssue('SOURCE_UNCHANGED', '原内容仍在原路径，完整回收站副本也已保留'),
        }
      }
      if (matchesIdentity(sourceStat, removal.sourceIdentity) && removal.phase === 'cleanup') {
        // A recursive cleanup may have failed after deleting some children and
        // the live process may have moved the remaining tree back. Preserve it
        // alongside the verified payload and stop treating it as an active move.
        const cleared = { ...manifest }
        delete cleared.sourceRemoval
        try {
          await writeJsonAtomic(path.join(entryDirectory, MANIFEST_NAME), cleared)
        } catch (error) {
          return { kind: 'issue', issue: makeIssue(error.code || 'JOURNAL_UPDATE_FAILED', '原路径内容与完整副本不同，恢复日志清理失败，内容已保留') }
        }
        return {
          kind: 'issue',
          issue: makeIssue('SOURCE_CHANGED', '原路径内容与完整回收站副本不同；两份内容均已保留'),
        }
      }
      return { kind: 'issue', issue: makeIssue('RESTORE_PATH_OCCUPIED', '原路径已有不同内容，隔离操作未自动修改任何内容') }
    }

    if (removal.phase === 'cleanup') {
      const cleared = { ...manifest }
      delete cleared.sourceRemoval
      try {
        await writeJsonAtomic(path.join(entryDirectory, MANIFEST_NAME), cleared)
      } catch (error) {
        return { kind: 'issue', issue: makeIssue(error.code || 'JOURNAL_UPDATE_FAILED', '原内容清理已完成，但恢复日志清理失败') }
      }
      return { kind: 'completed', item: { id, path: manifest.originalPath } }
    }
    return { kind: 'issue', issue: makeIssue('SOURCE_MISSING', '原路径和隔离路径都不存在，已验证的回收站副本仍保留') }
  }

  async function reconcilePending() {
    const result = { restored: [], completed: [], issues: [] }
    let current
    try {
      current = await locations({ createRecovery: false })
    } catch (error) {
      result.issues.push({
        code: error.code || 'RECOVERY_UNAVAILABLE',
        message: '无法检查回收站中的中断操作',
      })
      return result
    }
    if (!current.trashDirectory) return result

    let names
    try {
      names = (await fs.readdir(current.trashDirectory)).sort()
    } catch (error) {
      result.issues.push({ code: error.code || 'RECOVERY_UNAVAILABLE', message: '无法读取回收站中的中断操作' })
      return result
    }
    for (const id of names) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) continue
      const entryDirectory = path.join(current.trashDirectory, id)
      let entryStat
      try {
        entryStat = await existsNoFollow(entryDirectory)
      } catch (error) {
        result.issues.push({
          id,
          code: error.code || 'PATH_CHECK_FAILED',
          message: '无法检查回收站恢复日志目录；相关内容已保留',
        })
        continue
      }
      if (!entryStat || entryStat.isSymbolicLink() || !entryStat.isDirectory()) continue
      const manifestPath = path.join(entryDirectory, MANIFEST_NAME)
      let manifestStat
      try {
        manifestStat = await existsNoFollow(manifestPath)
      } catch (error) {
        result.issues.push({
          id,
          code: error.code || 'MANIFEST_CHECK_FAILED',
          message: '无法检查回收站恢复日志；相关内容已保留',
        })
        continue
      }
      if (!manifestStat) continue

      const outcome = await withEntryLock(lockKey(current.trashDirectory, id), async () => {
        try {
          return await reconcileOne(current.realWorkspace, current.workspaceId, current.trashDirectory, id)
        } catch (error) {
          return {
            kind: 'issue',
            issue: {
              id,
              code: error.code || 'INVALID_TRASH_JOURNAL',
              message: '回收站恢复日志无效或无法读取；相关内容已保留',
            },
          }
        }
      })
      if (outcome.kind === 'restored') result.restored.push(outcome.item)
      else if (outcome.kind === 'completed') result.completed.push(outcome.item)
      else if (outcome.kind === 'issue') result.issues.push(outcome.issue)
    }
    return result
  }

  async function trash(requestPath) {
    const { realWorkspace, workspaceId, trashDirectory } = await locations()
    const item = await resolveWorkspaceItem(realWorkspace, requestPath)
    if (!item.stat.isDirectory() && !item.stat.isFile()) throw serviceError('回收站不支持特殊文件')
    const sourceGuard = await openWorkspaceParent(realWorkspace, item.fullPath, serviceError)
    let entryRolledBack = false
    let preserveExdevEntry = false
    let releaseEntryLock = () => {}
    try {
      // Refuse a directory containing a symlink or special file. This operation
      // moves hidden children too; it never follows links outside the workspace.
      await assertTreeCopyable(item.fullPath)

      const id = randomUUID()
      releaseEntryLock = await acquireEntryLock(lockKey(trashDirectory, id))
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
          await sourceGuard.check()
          await assertSameEntry(item.fullPath, item.stat, serviceError)
          await rename(item.fullPath, payloadPath)
        } catch (error) {
          if (error.code !== 'EXDEV') throw error
          const temporaryPath = path.join(entryDirectory, COPY_NAME)
          const verifiedCopySnapshot = await copyAndVerify(item.fullPath, temporaryPath, copyFile)
          // Keep the original until a verified copy is durably staged; it is
          // removed only after a same-volume quarantine and a final comparison.
          const [sourceSnapshot, stagedSnapshot] = await Promise.all([
            assertTreeCopyable(item.fullPath),
            assertTreeCopyable(temporaryPath),
          ])
          if (
            !snapshotsEqual(verifiedCopySnapshot, sourceSnapshot) ||
            !snapshotsEqual(verifiedCopySnapshot, stagedSnapshot)
          ) {
            throw serviceError('文件在暂存期间发生变化，未移动到回收站', 'FILE_CHANGED')
          }
          await fs.rename(temporaryPath, payloadPath)
          await writeJsonAtomic(manifestPath, { ...manifest, state: 'ready' })

          // A recursive rm at the original pathname can erase edits made
          // after copy verification. First move the source to a unique sibling
          // on its own volume, then compare that moved tree with the published
          // recovery payload. Path-based writers can no longer reach the old
          // name during this check. If it changed, put it back and roll back
          // the just-published recovery entry.
          const quarantinePath = path.join(
            path.dirname(item.fullPath),
            `.trash-pending-${id}`,
          )
          const sourceBeforeQuarantine = await fs.lstat(item.fullPath, { bigint: true })
          const [sourceBeforeSnapshot, payloadBeforeSnapshot] = await Promise.all([
            assertTreeCopyable(item.fullPath),
            assertTreeCopyable(payloadPath),
          ])
          if (!snapshotsEqual(verifiedCopySnapshot, sourceBeforeSnapshot) ||
            !snapshotsEqual(verifiedCopySnapshot, payloadBeforeSnapshot)) {
            throw serviceError('文件在暂存期间发生变化，未移动到回收站', 'FILE_CHANGED')
          }
          const payloadBeforeIdentity = serializeIdentity(await fs.lstat(payloadPath, { bigint: true }))
          let sourceRemoval = {
            version: 1,
            phase: 'prepared',
            sourceQuarantinePath: slashPath(path.relative(realWorkspace, quarantinePath)),
            sourceIdentity: serializeIdentity(sourceBeforeQuarantine),
            payloadIdentity: payloadBeforeIdentity,
            treeFingerprint: treeFingerprint(verifiedCopySnapshot),
          }
          await sourceGuard.check()
          await assertSameEntry(item.fullPath, item.stat, serviceError)
          await writeJsonAtomic(manifestPath, { ...manifest, state: 'ready', sourceRemoval })

          let sourceQuarantined = false
          let sourceCleanupFailedWithResidue = false
          try {
            await sourceGuard.check()
            await assertSameEntry(item.fullPath, item.stat, serviceError)
            const sourceStat = await fs.lstat(item.fullPath, { bigint: true })
            await moveEntryNoReplace(item.fullPath, quarantinePath, sourceStat, {
              check: () => sourceGuard.check(),
              errorFactory: serviceError,
              conflictFactory: () => serviceError('暂存目录已存在，未移动原文件', 'CONFLICT'),
              rename,
              link: linkFile,
            })
            sourceQuarantined = true
            sourceRemoval = { ...sourceRemoval, phase: 'quarantined' }
            await writeJsonAtomic(manifestPath, { ...manifest, state: 'ready', sourceRemoval })
            const quarantineStat = await fs.lstat(quarantinePath, { bigint: true })
            const [quarantinedSnapshot, publishedSnapshot] = await Promise.all([
              assertTreeCopyable(quarantinePath),
              assertTreeCopyable(payloadPath),
            ])
            if (
              !snapshotsEqual(verifiedCopySnapshot, quarantinedSnapshot) ||
              !snapshotsEqual(verifiedCopySnapshot, publishedSnapshot)
            ) {
              throw serviceError('文件在暂存期间发生变化，原内容已恢复且未移动到回收站', 'FILE_CHANGED')
            }
            await sourceGuard.check()
            await assertSameEntry(quarantinePath, quarantineStat, serviceError)
            sourceRemoval = { ...sourceRemoval, phase: 'cleanup' }
            await writeJsonAtomic(manifestPath, { ...manifest, state: 'ready', sourceRemoval })
            await sourceGuard.check()
            await assertSameEntry(quarantinePath, quarantineStat, serviceError)
            try {
              await fs.rm(quarantinePath, { recursive: true, force: false })
            } catch (error) {
              // Some filesystems can report a late cleanup error after the
              // directory has already disappeared. Treat that as committed;
              // if anything remains, preserve the verified recovery payload
              // even if the partially removed source can be moved back.
              let quarantineRemains = true
              try { quarantineRemains = Boolean(await existsNoFollow(quarantinePath)) } catch {}
              if (quarantineRemains) {
                sourceCleanupFailedWithResidue = true
                throw error
              }
            }
            await writeJsonAtomic(manifestPath, { ...manifest, state: 'ready' })
            sourceQuarantined = false
          } catch (error) {
            if (sourceQuarantined) {
              let sourceRestored = false
              let rollbackError
              try {
                const currentQuarantineStat = await fs.lstat(quarantinePath, { bigint: true })
                await moveEntryNoReplace(quarantinePath, item.fullPath, currentQuarantineStat, {
                  check: () => sourceGuard.check(),
                  errorFactory: serviceError,
                  conflictFactory: () => serviceError('原位置已有项目，隔离的原内容仍保留', 'CONFLICT'),
                  rename,
                  link: linkFile,
                })
                sourceQuarantined = false
                sourceRestored = true
              } catch (rollbackFailure) {
                rollbackError = rollbackFailure
                // An injected or filesystem rename can finish and then report
                // an error. Recognize that only when the quarantine name is
                // gone and the original path again has the original root inode.
                try {
                  if (!await existsNoFollow(quarantinePath)) {
                    await assertSameEntry(item.fullPath, item.stat, serviceError)
                    sourceQuarantined = false
                    sourceRestored = true
                  }
                } catch {}
              }
              if (!sourceRestored) {
                // Do not let the outer rollback discard either copy if the
                // original cannot be put back. Keep the ready recovery entry
                // and report the sibling path holding the moved source.
                preserveExdevEntry = true
                const quarantineRetained = Boolean(await existsNoFollow(quarantinePath).catch(() => null))
                const failure = serviceError('回收站暂存失败，恢复副本与隔离状态已保留', 'TRASH_ROLLBACK_FAILED')
                failure.cause = error
                failure.details = {
                  trashEntryId: id,
                  ...(quarantineRetained ? {
                    sourceQuarantinePath: slashPath(path.relative(realWorkspace, quarantinePath)),
                  } : {}),
                  rollbackCode: rollbackError?.code || 'ROLLBACK_FAILED',
                }
                throw failure
              }
              if (sourceCleanupFailedWithResidue) {
                // The quarantine may now be incomplete because rm can unlink
                // children before returning EIO. Keep the fully verified
                // payload and identify it in the original filesystem error.
                preserveExdevEntry = true
                await writeJsonAtomic(manifestPath, { ...manifest, state: 'ready' }).catch(() => {})
                error.details = {
                  ...(error.details || {}),
                  trashEntryId: id,
                  restoredSourcePath: item.relativePath,
                  recoveryCopyRetained: true,
                }
              } else {
                try {
                  await fs.rm(entryDirectory, { recursive: true, force: false })
                  entryRolledBack = true
                } catch (cleanupError) {
                  preserveExdevEntry = true
                  const failure = serviceError('原内容已恢复，但回收站元数据清理失败', 'TRASH_METADATA_CLEANUP_FAILED')
                  failure.cause = error
                  failure.details = { trashEntryId: id, cleanupCode: cleanupError.code || 'CLEANUP_FAILED' }
                  throw failure
                }
              }
            }
            throw error
          }
          return { id, path: item.relativePath, type: manifest.type, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt }
        }
        await writeJsonAtomic(manifestPath, { ...manifest, state: 'ready' })
        return { id, path: item.relativePath, type: manifest.type, createdAt: manifest.createdAt, expiresAt: manifest.expiresAt }
      } catch (error) {
        if (entryRolledBack || preserveExdevEntry) throw error
        // If a post-move metadata update fails, put the payload back whenever
        // the original name remains free. A staged payload stays visible through
        // list() if rollback cannot be completed.
        let payloadRetained = false
        if (await existsNoFollow(payloadPath)) {
          try {
            const original = path.resolve(realWorkspace, item.relativePath.split('/').join(path.sep))
            const payloadStat = await fs.lstat(payloadPath, { bigint: true })
            await moveEntryNoReplace(payloadPath, original, payloadStat, {
              check: () => sourceGuard.check(),
              errorFactory: serviceError,
              conflictFactory: () => serviceError('原位置已有同名项目', 'CONFLICT'),
              link: linkFile,
            })
          } catch {
            payloadRetained = true
          }
        }
        if (!payloadRetained) await fs.rm(entryDirectory, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    } finally {
      releaseEntryLock()
      await sourceGuard.close()
    }
  }

  async function restore(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw serviceError('回收站项目无效', 'INVALID_TRASH_ENTRY')
    const { trashDirectory } = await locations()
    return withEntryLock(lockKey(trashDirectory, id), () => restoreUnlocked(id))
  }

  async function restoreUnlocked(id) {
    const { realWorkspace, workspaceId, trashDirectory } = await locations()
    const entryDirectory = path.join(trashDirectory, id)
    const entryStat = await fs.lstat(entryDirectory)
    if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) throw serviceError('回收站项目不存在', 'ENOENT')
    const manifest = await readManifest(entryDirectory, id, workspaceId)
    if (manifest.sourceRemoval !== undefined) {
      throw serviceError('回收站项目仍有未完成的原文件隔离操作，请先恢复检查', 'TRASH_OPERATION_PENDING')
    }
    const payloadPath = path.join(entryDirectory, PAYLOAD_NAME)
    const payloadStat = await fs.lstat(payloadPath, { bigint: true })
    if (payloadStat.isSymbolicLink()) throw serviceError('回收站内容无效', 'INVALID_TRASH_ENTRY')
    const target = await assertSafeRestorationParent(realWorkspace, manifest.originalPath)
    const workspaceGuard = await openWorkspaceParent(realWorkspace, target, serviceError)
    let payloadGuard
    try {
      payloadGuard = await openWorkspaceParent(trashDirectory, payloadPath, serviceError)
    } catch (error) {
      await workspaceGuard.close()
      throw error
    }
    const conflictFactory = () => serviceError('原位置已有同名项目，无法恢复', 'CONFLICT')
    const checkParents = async () => {
      await workspaceGuard.check()
      await payloadGuard.check()
    }
    try {
      if (typeof options.beforeRestoreCommit === 'function') {
        await options.beforeRestoreCommit(manifest.originalPath)
      }
      try {
        await moveEntryNoReplace(payloadPath, target, payloadStat, {
          check: checkParents,
          errorFactory: serviceError,
          conflictFactory,
          rename,
          link: linkFile,
        })
        await payloadGuard.check()
        await fs.rm(entryDirectory, { recursive: true, force: false })
        return { success: true, path: manifest.originalPath }
      } catch (error) {
        if (error.code !== 'EXDEV') throw error
      }

      // Recovery storage may live on another volume. Copy to a sibling staging
      // path, verify the complete tree, then publish it at the original name.
      const temporaryTarget = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.restoring`)
      let temporaryStat
      try {
        await checkParents()
        await copyAndVerify(payloadPath, temporaryTarget, copyFile)
        temporaryStat = await fs.lstat(temporaryTarget, { bigint: true })
        await moveEntryNoReplace(temporaryTarget, target, temporaryStat, {
          check: checkParents,
          errorFactory: serviceError,
          conflictFactory,
          link: linkFile,
        })
        await payloadGuard.check()
        await fs.rm(entryDirectory, { recursive: true, force: false })
        return { success: true, path: manifest.originalPath }
      } catch (error) {
        try {
          await checkParents()
          if (temporaryStat) await assertSameEntry(temporaryTarget, temporaryStat, serviceError)
          if (await existsNoFollow(temporaryTarget)) await fs.rm(temporaryTarget, { recursive: true, force: true })
        } catch {}
        throw error
      }
    } finally {
      await payloadGuard.close()
      await workspaceGuard.close()
    }
  }

  async function remove(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw serviceError('回收站项目无效', 'INVALID_TRASH_ENTRY')
    }
    const { trashDirectory } = await locations()
    return withEntryLock(lockKey(trashDirectory, id), () => removeUnlocked(id))
  }

  async function removeUnlocked(id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw serviceError('回收站项目无效', 'INVALID_TRASH_ENTRY')
    }
    const { workspaceId, trashDirectory } = await locations()
    const entryDirectory = path.join(trashDirectory, id)
    const entryStat = await existsNoFollow(entryDirectory)
    if (!entryStat || entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
      throw serviceError('回收站项目不存在', 'ENOENT')
    }

    const manifest = await readManifest(entryDirectory, id, workspaceId)
    if (manifest.sourceRemoval !== undefined) {
      throw serviceError('回收站项目仍有未完成的原文件隔离操作，无法永久删除', 'TRASH_OPERATION_PENDING')
    }
    if (manifest.state !== 'ready') {
      throw serviceError('回收站项目尚未准备好，无法永久删除', 'TRASH_ENTRY_NOT_READY')
    }
    const payloadStat = await existsNoFollow(path.join(entryDirectory, PAYLOAD_NAME))
    if (!payloadStat || payloadStat.isSymbolicLink() || (!payloadStat.isFile() && !payloadStat.isDirectory())) {
      throw serviceError('回收站内容无效', 'INVALID_TRASH_ENTRY')
    }

    const bytes = await regularFileBytes(entryDirectory)
    // fs.rm removes a symlink itself rather than traversing its target. The
    // entry's identity and top-level directory were verified above.
    await fs.rm(entryDirectory, { recursive: true, force: false })
    return { success: true, id, bytes }
  }

  async function purgeExpired({ at = now() } = {}) {
    const { trashDirectory, workspaceId } = await locations()
    const entries = await list()
    const expiredIds = entries.filter(item => Date.parse(item.expiresAt) <= at.getTime()).map(item => item.id)
    let purged = 0
    let bytes = 0
    for (const id of expiredIds) {
      const entryDirectory = path.join(trashDirectory, id)
      const manifest = await readManifest(entryDirectory, id, workspaceId)
      // Expiration cleanup is an explicit maintenance operation, separate
      // from the user-facing trash and restore flows.
      if (manifest.state === 'ready' && Date.parse(manifest.expiresAt) <= at.getTime()) {
        if (manifest.sourceRemoval !== undefined) continue
        const removed = await remove(id)
        bytes += removed.bytes
        purged += 1
      }
    }
    return { purged, bytes }
  }

  return { trash, list, restore, remove, purgeExpired, reconcilePending }
}
