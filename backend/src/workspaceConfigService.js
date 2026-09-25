import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

function serviceError(message, code, details = {}) {
  const error = new Error(message)
  error.code = code
  error.details = details
  return error
}

function isWithin(base, target) {
  const relative = path.relative(base, target)
  return relative === '' || (
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  )
}

async function canonicalDirectory(input, fileSystem) {
  const real = await fileSystem.realpath(path.resolve(input))
  const stat = await fileSystem.stat(real)
  if (!stat.isDirectory()) {
    throw serviceError('工作空间不是目录', 'INVALID_WORKSPACE')
  }
  // A mount may pass realpath/stat but still reject enumeration. Treat that as
  // unavailable so startup cannot silently proceed with a partially usable
  // saved workspace.
  await fileSystem.readdir(real)
  return real
}

async function canonicalOrProjectedDirectory(input, fileSystem) {
  const resolved = path.resolve(input)
  let real
  try {
    real = await fileSystem.realpath(resolved)
  } catch (error) {
    if (error?.code === 'ENOENT') return projectCanonicalPath(resolved, { fileSystem })
    throw error
  }
  const stat = await fileSystem.stat(real)
  if (!stat.isDirectory()) {
    throw serviceError('工作空间不是目录', 'INVALID_WORKSPACE')
  }
  await fileSystem.readdir(real)
  return real
}

function configuredWorkspacePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw serviceError('工作空间配置缺少有效的 workspace 路径', 'WORKSPACE_CONFIG_INVALID')
  }
  return path.resolve(value)
}

/**
 * Read the persisted workspace choice.
 *
 * Only a missing config file is considered a first launch. Any other read,
 * parse, schema, or configured-directory failure is surfaced as a coded error
 * so callers can keep the API available without choosing a different folder.
 */
export async function loadWorkspaceConfig(configFile, { fileSystem = fs } = {}) {
  const resolvedConfigFile = path.resolve(configFile)
  let contents
  try {
    contents = await fileSystem.readFile(resolvedConfigFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', configFile: resolvedConfigFile }
    throw serviceError(
      `无法读取工作空间配置：${error?.message || '未知错误'}`,
      'WORKSPACE_CONFIG_UNREADABLE',
      { configFile: resolvedConfigFile, causeCode: error?.code },
    )
  }

  let config
  try {
    config = JSON.parse(contents)
  } catch (error) {
    throw serviceError(
      `工作空间配置无法解析：${error.message}`,
      'WORKSPACE_CONFIG_INVALID',
      { configFile: resolvedConfigFile },
    )
  }

  let configuredPath
  try {
    configuredPath = configuredWorkspacePath(config?.workspace)
  } catch (error) {
    error.details = { configFile: resolvedConfigFile }
    throw error
  }

  try {
    const workspace = await canonicalDirectory(configuredPath, fileSystem)
    return { kind: 'configured', configFile: resolvedConfigFile, configuredPath, workspace }
  } catch (error) {
    throw serviceError(
      `上次工作空间当前不可访问：${configuredPath}`,
      'SAVED_WORKSPACE_UNAVAILABLE',
      { configFile: resolvedConfigFile, workspace: configuredPath, causeCode: error?.code },
    )
  }
}

/**
 * Persist a selected workspace using a sibling temporary file and rename.
 * The file itself is synced before rename; the sibling location keeps rename
 * on the same filesystem and therefore atomic on supported filesystems.
 */
export async function saveWorkspaceConfig(configFile, workspace, {
  fileSystem = fs,
  makeId = randomUUID,
} = {}) {
  const resolvedConfigFile = path.resolve(configFile)
  const resolvedWorkspace = configuredWorkspacePath(workspace)
  const directory = path.dirname(resolvedConfigFile)
  const temporaryFile = path.join(
    directory,
    `.${path.basename(resolvedConfigFile)}.${makeId()}.tmp`,
  )

  let handle
  try {
    await fileSystem.mkdir(directory, { recursive: true })
    handle = await fileSystem.open(temporaryFile, 'wx', 0o600)
    await handle.writeFile(JSON.stringify({ workspace: resolvedWorkspace }, null, 2), 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fileSystem.rename(temporaryFile, resolvedConfigFile)
    return resolvedWorkspace
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fileSystem.unlink(temporaryFile).catch(() => {})
    throw error
  }
}

/**
 * Resolve a path through existing symlinked ancestors without creating any
 * missing components. This allows safe containment checks for a recovery
 * directory that has not been created yet.
 */
export async function projectCanonicalPath(target, { fileSystem = fs } = {}) {
  let current = path.resolve(target)
  const missingParts = []
  while (true) {
    try {
      const canonical = await fileSystem.realpath(current)
      return path.resolve(canonical, ...missingParts)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missingParts.unshift(path.basename(current))
      current = parent
    }
  }
}

/**
 * Refuse either directory being nested inside the other. No recovery path is
 * created during this preflight.
 */
export async function assertWorkspaceRecoveryRootsDisjoint(workspacePath, recoveryRoot, {
  fileSystem = fs,
} = {}) {
  const workspace = await canonicalOrProjectedDirectory(workspacePath, fileSystem)
  const recovery = await projectCanonicalPath(recoveryRoot, { fileSystem })

  if (isWithin(workspace, recovery)) {
    throw serviceError(
      '恢复数据目录不能位于工作空间内部',
      'RECOVERY_ROOT_INSIDE_WORKSPACE',
      { workspace, recoveryRoot: recovery },
    )
  }
  if (isWithin(recovery, workspace)) {
    throw serviceError(
      '工作空间不能位于恢复数据目录内部',
      'WORKSPACE_INSIDE_RECOVERY_ROOT',
      { workspace, recoveryRoot: recovery },
    )
  }

  return { workspace, recoveryRoot: recovery }
}

export function defaultRecoveryRoot({ env = process.env, home = os.homedir() } = {}) {
  return path.resolve(
    env.EDITOR_RECOVERY_DIR || env.EDITOR_RECOVERY_ROOT ||
    env.STANDALONE_EDITOR_RECOVERY_ROOT || path.join(home, '.standalone-editor', 'recovery'),
  )
}
