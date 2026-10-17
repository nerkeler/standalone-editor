// @ts-check
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { sha256 } from './hashing.js'
import {
  makeError,
  makeCausedError,
  historyNotFound,
  historyCorrupt,
} from './errors.js'
import {
  isMarkdownPath,
  assertMarkdownPath,
  contentRevision,
  decodeMarkdownBytes,
  decodeEditableHistoryBytes,
} from './markdownBytes.js'
import {
  workspaceBase,
  lexicalPath,
  relativePath,
  fileLocation,
} from './workspaceAccess.js'
import { projectCanonicalPath as canonicalProjectedPath } from './workspacePathGuard.js'

export function reportRecoveryCleanupWarning(options, reqPath, error, { saveCommitted = true } = {}) {
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

const HISTORY_RETENTION_PER_FILE = 50
const HISTORY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function recoveryRoot(override) {
  return path.resolve(override || process.env.EDITOR_RECOVERY_DIR || path.join(os.homedir(), '.standalone-editor', 'recovery'))
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

/**
 * Capture the replaced document version into the recovery bucket.
 * @param {string} workspace
 * @param {string} base
 * @param {string} target
 * @param {Buffer} bytes
 * @param {{ root?: string }} [options]
 */
export async function storeHistory(workspace, base, target, bytes, { root } = {}) {
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
/**
 * Enforce per-file retention after a successful replacement.
 * @param {string} workspace
 * @param {string} base
 * @param {string} target
 * @param {{ root?: string }} [options]
 * @param {string | null} [preserveId]
 */
export async function pruneHistory(workspace, base, target, { root } = {}, preserveId = null) {
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

export async function discardStoredHistory(stored) {
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

/**
 * Load and fully validate one history record for its owning path.
 * @param {string} workspace
 * @param {string} base
 * @param {string} target
 * @param {string} historyId
 * @param {{ root?: string }} [options]
 */
export async function readHistoryEntry(workspace, base, target, historyId, { root } = {}) {
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

/**
 * @param {string} workspace
 * @param {string} base
 * @param {string} target
 * @param {{ root?: string }} [options]
 */
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
export async function archiveHistoryAtPath(base, target, options = {}) {
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
/**
 * Move orphan history buckets back into the active namespace when their
 * original path again holds an identical regular file.
 * @param {string} base Canonical workspace root.
 * @param {string[]} orphanIds
 * @param {{ root?: string, moveHistoryBucket?: (a: string, b: string) => Promise<unknown> }} [options]
 * @param {(manifest: { trashEntryId?: string | null }) => boolean} [predicate]
 */
export async function reattachHistoryArchives(base, orphanIds, options = {}, predicate = () => true) {
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

/**
 * Reattach the orphan archives created when a trash entry was published.
 * @param {string} workspace
 * @param {string} trashEntryId
 * @param {{ root?: string }} [options]
 */
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

export async function migrateHistoryForMove(base, sourcePath, destinationPath, isDirectory, files, options = {}) {
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
