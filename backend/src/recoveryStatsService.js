import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const DEFAULT_RECOVERY_DIRECTORY = path.join(os.homedir(), '.standalone-editor', 'recovery')
const UUID_PATTERN = /^[0-9a-f-]{36}$/i
const HASH_PATTERN = /^[0-9a-f]{64}$/i

function serviceError(message, code = 'RECOVERY_STORAGE_ERROR') {
  const error = new Error(message)
  error.code = code
  return error
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isWithin(base, target) {
  const relative = path.relative(base, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function resolveHistoryRoot(options) {
  return path.resolve(options.historyRoot || options.recoveryRoot || process.env.EDITOR_RECOVERY_DIR || DEFAULT_RECOVERY_DIRECTORY)
}

function resolveTrashRoot(options) {
  return path.resolve(
    options.trashRoot || options.recoveryRoot || process.env.EDITOR_RECOVERY_DIR ||
    process.env.EDITOR_RECOVERY_ROOT || process.env.STANDALONE_EDITOR_RECOVERY_ROOT || DEFAULT_RECOVERY_DIRECTORY,
  )
}

async function projectCanonicalPath(target) {
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

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function directoryOrNull(target) {
  const stat = await lstatOrNull(target)
  return stat && !stat.isSymbolicLink() && stat.isDirectory() ? stat : null
}

async function entriesOrEmpty(target) {
  try {
    return await fs.readdir(target)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

// Sum bytes for regular files only. lstat is used at every level, so a
// symlink inside recovery storage never causes traversal into its target.
async function regularFileBytes(target, knownStat) {
  const stat = knownStat || await lstatOrNull(target)
  if (!stat || stat.isSymbolicLink()) return 0
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0

  let bytes = 0
  for (const name of await entriesOrEmpty(target)) {
    const child = path.join(target, name)
    const childStat = await lstatOrNull(child)
    if (!childStat || childStat.isSymbolicLink()) continue
    bytes += await regularFileBytes(child, childStat)
  }
  return bytes
}

async function countHistoryItems(workspaceHistory) {
  const workspaceStat = await directoryOrNull(workspaceHistory)
  if (!workspaceStat) return 0

  let items = 0
  for (const fileKey of await entriesOrEmpty(workspaceHistory)) {
    if (!HASH_PATTERN.test(fileKey)) continue
    const bucket = path.join(workspaceHistory, fileKey)
    if (!await directoryOrNull(bucket)) continue
    let ownerPath = null
    let ownerIsValid = true
    const ownerFile = path.join(bucket, '.owner.json')
    const ownerStat = await lstatOrNull(ownerFile)
    if (ownerStat && !ownerStat.isSymbolicLink() && ownerStat.isFile()) {
      try {
        const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'))
        if (owner?.version !== 1 || typeof owner.path !== 'string' || hash(owner.path) !== fileKey) {
          ownerIsValid = false
        } else {
          ownerPath = owner.path
        }
      } catch {
        ownerIsValid = false
      }
    }
    if (!ownerIsValid) continue

    for (const name of await entriesOrEmpty(bucket)) {
      if (!UUID_PATTERN.test(name.replace(/\.json$/, '')) || !name.endsWith('.json') || name === '.owner.json') continue
      const entryPath = path.join(bucket, name)
      const entryStat = await lstatOrNull(entryPath)
      if (!entryStat || entryStat.isSymbolicLink() || !entryStat.isFile()) continue
      try {
        const entry = JSON.parse(await fs.readFile(entryPath, 'utf8'))
        if (
          entry?.version === 1 && entry.id === name.slice(0, -'.json'.length) &&
          typeof entry.path === 'string' && hash(entry.path) === fileKey &&
          (ownerPath === null || ownerPath === entry.path) &&
          typeof entry.contentBase64 === 'string' && typeof entry.savedAt === 'string'
        ) items += 1
      } catch {
        // Bad history records still contribute to storage bytes, but they are
        // not counted as usable versions.
      }
    }
  }
  return items
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)) return false
  const parts = value.split('/')
  return parts.every(part => part && part !== '.' && part !== '..')
}

async function countTrashItems(workspaceTrash, workspaceId) {
  if (!await directoryOrNull(workspaceTrash)) return 0
  let items = 0
  for (const id of await entriesOrEmpty(workspaceTrash)) {
    if (!UUID_PATTERN.test(id)) continue
    const entryDirectory = path.join(workspaceTrash, id)
    if (!await directoryOrNull(entryDirectory)) continue
    const manifestPath = path.join(entryDirectory, 'entry.json')
    const manifestStat = await lstatOrNull(manifestPath)
    const payloadStat = await lstatOrNull(path.join(entryDirectory, 'payload'))
    if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()) continue
    if (!payloadStat || payloadStat.isSymbolicLink() || (!payloadStat.isFile() && !payloadStat.isDirectory())) continue
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
      if (
        manifest?.version === 1 && manifest.id === id && manifest.workspaceId === workspaceId &&
        safeRelativePath(manifest.originalPath) && typeof manifest.createdAt === 'string' &&
        ['staging', 'ready'].includes(manifest.state)
      ) items += 1
    } catch {
      // Invalid manifests remain part of byte usage but are not usable items.
    }
  }
  return items
}

async function sectionStats({ configuredRoot, workspace, directoryName, workspaceKey, countItems }) {
  const root = await projectCanonicalPath(configuredRoot)
  if (isWithin(workspace, root)) throw serviceError('恢复目录必须位于工作空间之外')
  const storageRoot = path.join(root, directoryName, workspaceKey)
  const storageStat = await directoryOrNull(storageRoot)
  if (!storageStat) return { items: 0, bytes: 0 }
  const [items, bytes] = await Promise.all([
    countItems(storageRoot, workspaceKey),
    regularFileBytes(storageRoot, storageStat),
  ])
  return { items, bytes }
}

export async function getRecoveryStats(workspace, options = {}) {
  if (typeof workspace !== 'string' || !workspace) throw serviceError('缺少工作空间', 'INVALID_WORKSPACE')
  const realWorkspace = await fs.realpath(workspace)
  const workspaceStat = await fs.stat(realWorkspace)
  if (!workspaceStat.isDirectory()) throw serviceError('工作空间不是目录', 'INVALID_WORKSPACE')
  const workspaceId = hash(realWorkspace)

  const [history, trash] = await Promise.all([
    sectionStats({
      configuredRoot: resolveHistoryRoot(options),
      workspace: realWorkspace,
      directoryName: 'history',
      workspaceKey: workspaceId,
      countItems: countHistoryItems,
    }),
    sectionStats({
      configuredRoot: resolveTrashRoot(options),
      workspace: realWorkspace,
      directoryName: 'trash',
      workspaceKey: workspaceId,
      countItems: countTrashItems,
    }),
  ])
  return {
    history,
    trash,
    total: { items: history.items + trash.items, bytes: history.bytes + trash.bytes },
    generatedAt: new Date().toISOString(),
  }
}
