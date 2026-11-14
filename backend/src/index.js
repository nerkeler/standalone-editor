import express from 'express'
import cors from 'cors'
import multer from 'multer'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import { pipeline } from 'node:stream/promises'
import {
  listDir,
  listTree,
  readFile,
  readFileBase64,
  openBinaryFile,
  createItem,
  moveItem,
  getMoveReferenceImpacts,
  writeFile,
  listFileHistory,
  restoreFileHistory,
  deleteFileHistory,
  archiveFileHistory,
  listOrphanFileHistory,
  deleteOrphanFileHistory,
  readOrphanFileHistory,
  restoreOrphanFileHistory,
  reattachTrashFileHistory,
  uploadFile,
  ensureAdjacentAssetsDirectory,
  hasWorkspaceFiles,
  searchWorkspace,
} from './fileService.js'
import { createTrashService } from './trashService.js'
import { getRecoveryStats } from './recoveryStatsService.js'
import { importZip } from './zipImportService.js'
import { isSupportedNodeVersion } from './runtimeVersion.js'
import {
  configuredRootValues,
  defaultRootCandidates,
  isDirectoryNavigable,
  isDirectoryPickerSelectionAllowed,
  isWithinPath,
} from './directoryPicker.js'
import { permissionErrorResponse } from './permissionErrors.js'
import {
  assertWorkspaceRecoveryRootsDisjoint,
  defaultRecoveryRoot,
  loadWorkspaceConfig,
  projectCanonicalPath,
  saveWorkspaceConfig,
} from './workspaceConfigService.js'
import { startBackendServer } from './serverRuntime.js'
import { registerWorkspaceSelectionRoutes } from './workspaceSelectionRoutes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createBackend(options = {}) {
  const env = options.env || process.env

  function envNumber(name, fallback) {
    const value = Number(env[name])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  const configuredPort = env.PORT ?? env.EDITOR_PORT
  const PORT = options.port !== undefined
    ? Number(options.port)
    : configuredPort === '0' ? 0 : envNumber('PORT', envNumber('EDITOR_PORT', 5557))
  if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65_535) {
    throw new RangeError('Backend port must be an integer from 0 to 65535')
  }
  const HOST = options.host || env.HOST || env.EDITOR_HOST || '127.0.0.1'
  const CONFIG_FILE = options.configFile || env.WORKSPACE_CONFIG_FILE
    || env.EDITOR_CONFIG_FILE
    || path.join(os.homedir(), '.standalone-editor', 'workspace.json')
  const DEFAULT_WORKSPACE = options.defaultWorkspace || env.EDITOR_DEFAULT_WORKSPACE
    || path.join(os.homedir(), 'Documents', 'standalone-editor-notes')
  const RECOVERY_ROOT = path.resolve(options.recoveryRoot || defaultRecoveryRoot({ env }))
  const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif'])

  let workspace
  let workspaceVersion = 1
  let workspaceStartupError = null
  let workspaceCandidate = null
  let configWasMissingAtStartup = false
  const workspaceMutationTails = new Map()
  const recoveryMaintenance = new Map()
  const historyCleanupWarnings = new Map()
  let workspaceSelectionTail = Promise.resolve()

  function errorStatus(error) {
    const permissionFailure = permissionErrorResponse(error)
    if (permissionFailure) return permissionFailure.status
    if (error instanceof multer.MulterError) {
      return error.code?.startsWith('LIMIT_') && error.code !== 'LIMIT_UNEXPECTED_FILE' ? 413 : 400
    }
    if (
      error?.code === 'CONFLICT' || error?.code === 'FILE_CONFLICT' ||
      error?.code === 'HISTORY_CONFLICT' || error?.code === 'WORKSPACE_MISMATCH' ||
      error?.code === 'TRASH_OPERATION_PENDING'
    ) return 409
    if (error?.code === 'REVISION_REQUIRED') return 428
    if (error?.code === 'ENOENT' || error?.code === 'HISTORY_NOT_FOUND') return 404
    if (error?.code === 'DOCUMENT_TOO_LARGE' || error?.code === 'ZIP_LIMIT') return 413
    if (error?.code === 'FILE_CHANGED') return 409
    if (
      error?.code === 'RECOVERY_STORAGE_ERROR' || error?.code === 'HISTORY_CORRUPT' ||
      error?.code === 'HISTORY_ROLLBACK_FAILED' || error?.code === 'HISTORY_ARCHIVE_ROLLBACK_FAILED' ||
      error?.code === 'MOVE_ROLLBACK_FAILED' || error?.code === 'TRASH_ROLLBACK_FAILED' ||
      error?.code === 'WORKSPACE_CONFIG_SAVE_FAILED' ||
      error?.code === 'UNSUPPORTED_UPLOAD_FILESYSTEM' || error?.code === 'UPLOAD_INCOMPLETE' ||
      error?.code === 'UPLOAD_VERIFY_FAILED' || error?.code === 'TEMPORARY_IDENTITY_UNAVAILABLE'
    ) return 500
    if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') return 507
    if (
      error?.code === 'EIO' || error?.code === 'EFBIG' ||
      error?.code === 'EMFILE' || error?.code === 'ENFILE' || error?.code === 'ENXIO' ||
      error?.code === 'ENODEV'
    ) return 500
    return 400
  }

  function normalizeMultipartFilename(filename) {
    if (typeof filename !== 'string' || [...filename].some(char => char.codePointAt(0) > 0xff)) return filename
    const latin1Bytes = Buffer.from(filename, 'latin1')
    const utf8 = latin1Bytes.toString('utf8')
    // Busboy's default multipart parameter charset is Latin-1, while browsers
    // send UTF-8 filename bytes. Decode only when those bytes form valid UTF-8;
    // preserve genuine Latin-1 names and filenames already decoded by RFC 5987.
    return Buffer.from(utf8, 'utf8').equals(latin1Bytes) ? utf8 : filename
  }

  function workspaceTrashService(ws) {
    return createTrashService(ws, { recoveryRoot: RECOVERY_ROOT })
  }

  function recoveryOptions() {
    return { root: RECOVERY_ROOT }
  }

  async function workspaceRecoveryStats(ws) {
    const stats = await getRecoveryStats(ws, { recoveryRoot: RECOVERY_ROOT })
    return {
      ...stats,
      maintenance: {
        historyCleanupWarnings: [...(historyCleanupWarnings.get(ws)?.values() || [])],
        trash: recoveryMaintenance.get(ws) || { restored: [], completed: [], issues: [] },
      },
    }
  }

  function recordHistoryCleanup(ws, documentPath, result, previousRevision) {
    const warningPath = result.path || documentPath
    let warnings = historyCleanupWarnings.get(ws)
    if (result.recoveryCleanupWarning) {
      if (!warnings) historyCleanupWarnings.set(ws, warnings = new Map())
      warnings.set(warningPath, { path: warningPath, ...result.recoveryCleanupWarning })
    } else if (result.revision && result.revision !== previousRevision) {
      // An unchanged save does not retry retention cleanup, so it cannot clear
      // an earlier warning. A completed replacement does attempt that cleanup.
      warnings?.delete(warningPath)
    }
    return result
  }

  async function reconcileWorkspaceRecovery(ws) {
    return withWorkspaceMutation(ws, async () => {
      let report
      try {
        report = await workspaceTrashService(ws).reconcilePending()
        for (const restored of report.restored) {
          try {
            const history = await reattachTrashFileHistory(ws, restored.id, recoveryOptions())
            if (history.retained > 0) report.issues.push({
              id: restored.id, path: restored.path, code: 'HISTORY_ARCHIVES_RETAINED',
              message: '原项目已恢复，部分历史仍保留在已删除文件历史中，可在那里查看。',
            })
          } catch (error) {
            report.issues.push({
              id: restored.id, path: restored.path,
              code: error.code || 'HISTORY_REATTACH_FAILED',
              message: '原项目已恢复，但历史记录未能重新关联；请在已删除文件历史中查看。',
            })
          }
        }
      } catch (error) {
        // Recovery storage can be offline or read-only independently of the
        // notes. Keep a readable workspace available and report this separately.
        report = { restored: [], completed: [], issues: [{
          code: error.code || 'RECOVERY_RECONCILE_FAILED',
          message: '未能检查上次中断的回收站操作；已保留现有数据，请稍后重试。',
        }] }
      }
      recoveryMaintenance.set(ws, report)
      for (const issue of report.issues) {
        console.warn('恢复检查未完成：', { workspace: ws, path: issue.path, code: issue.code })
      }
      return report
    })
  }

  function sendError(res, error, req = res.req) {
    console.error(`[${res.req.method} ${res.req.originalUrl}]`, error?.message || error)
    if (req?.workspaceSnapshot) setWorkspaceHeaders(res, req.workspaceSnapshot)
    const permissionFailure = permissionErrorResponse(error)
    if (permissionFailure) {
      return res.status(permissionFailure.status).json({
        ...(error?.details || {}),
        ...permissionFailure.body,
      })
    }
    res.status(errorStatus(error)).json({ error: error?.message || '请求失败', code: error?.code, ...(error?.details || {}) })
  }

  function workspaceIdFor(realPath) {
    return crypto.createHash('sha256').update(realPath).digest('hex').slice(0, 24)
  }

  async function canonicalDirectory(input, { create = false } = {}) {
    const resolved = path.resolve(input)
    if (create) await fs.mkdir(resolved, { recursive: true })
    const real = await fs.realpath(resolved)
    const stat = await fs.stat(real)
    if (!stat.isDirectory()) {
      const error = new Error('不是有效目录')
      error.code = 'INVALID_DIRECTORY'
      throw error
    }
    return real
  }

  async function assertDirectoryReadable(directory) {
    // Workspace browsing and selection need read + traversal access, but do not
    // require write permission. Windows does not expose POSIX execute bits.
    const mode = fs.constants.R_OK | (process.platform === 'win32' ? 0 : fs.constants.X_OK)
    await fs.access(directory, mode)
    await fs.readdir(directory)
  }

  function currentWorkspaceInfo() {
    if (!workspace) return null
    return {
      workspace,
      workspaceId: workspaceIdFor(workspace),
      workspaceVersion,
      ...(recoveryMaintenance.has(workspace) ? { recoveryMaintenance: recoveryMaintenance.get(workspace) } : {}),
    }
  }

  function setWorkspaceHeaders(res, info = currentWorkspaceInfo()) {
    if (!info) return null
    res.setHeader('X-Workspace-Id', info.workspaceId)
    res.setHeader('X-Workspace-Version', String(info.workspaceVersion))
    return info
  }

  function workspaceFor(req) {
    return req.workspaceSnapshot?.workspace || workspace
  }

  function workspaceInfoFor(req) {
    return req.workspaceSnapshot || currentWorkspaceInfo()
  }

  // Requests may overlap a workspace switch or another mutation. Capture the
  // selected workspace before any body parsing/other awaited work, then serialize
  // mutations per canonical workspace so a preflight check cannot race a rename
  // or upload that targets the same file.
  async function withWorkspaceMutation(workspacePath, operation) {
    const previous = workspaceMutationTails.get(workspacePath) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    workspaceMutationTails.set(workspacePath, current)
    try {
      return await current
    } finally {
      if (workspaceMutationTails.get(workspacePath) === current) {
        workspaceMutationTails.delete(workspacePath)
      }
    }
  }

  function withWorkspaceSelection(operation) {
    const current = workspaceSelectionTail.catch(() => {}).then(operation)
    workspaceSelectionTail = current
    return current
  }

  function commandWorkspace() {
    if (options.workspace) return path.resolve(options.workspace)
    const args = options.argv || process.argv.slice(2)
    const index = args.indexOf('--workspace')
    if (index === -1 || !args[index + 1]) return null
    return path.resolve(args[index + 1])
  }

  // A directory selected in the picker must be below one of these roots. The
  // command-line workspace remains useful for explicit deployments and tests.
  async function allowedDirectoryRoots() {
    const configured = env.EDITOR_DIRECTORY_ROOTS || env.DIRECTORY_ROOTS
    const values = configured
      ? configuredRootValues(configured, process.platform)
      : defaultRootCandidates({ platform: process.platform, home: os.homedir(), env })
    const roots = []
    for (const value of values) {
      try {
        const resolved = await canonicalDirectory(value)
        // A stat-able mount can still deny directory enumeration. Exclude it
        // here so the picker never advertises a root that cannot be opened.
        await assertDirectoryReadable(resolved)
        if (!roots.some(root => isWithinPath(root, resolved, process.platform))) roots.push(resolved)
      } catch {}
    }
    return roots
  }

  async function directorySelectionPolicy(roots) {
    // Match the canonical/projected recovery path used by workspace selection,
    // including a recovery directory reached through a symlinked parent.
    const recovery = await projectCanonicalPath(RECOVERY_ROOT)
    return target => {
      if (!isDirectoryPickerSelectionAllowed(target, roots, { platform: process.platform })) return false
      const normalizedTarget = path.resolve(target)
      // Never allow a workspace to contain recovery data or be inside it. This
      // makes `/` non-selectable under the default recovery location while leaving
      // other readable directories governed by their roots and OS permissions.
      return !isWithinPath(normalizedTarget, recovery, process.platform)
        && !isWithinPath(recovery, normalizedTarget, process.platform)
    }
  }

  async function defaultDirectoryPickerPath() {
    const roots = await allowedDirectoryRoots()
    if (roots.some(root => isWithinPath(root, os.homedir(), process.platform))) {
      try {
        const home = await canonicalDirectory(os.homedir())
        await assertDirectoryReadable(home)
        return home
      } catch {}
    }
    return roots[0] || os.homedir()
  }

  async function directoryPickerLocations(roots) {
    const configured = env.EDITOR_DIRECTORY_ROOTS || env.DIRECTORY_ROOTS
    if (process.platform === 'win32' || configured) return roots

    // Keep common places one click away while `/` remains the effective default
    // browsing root. These are navigation shortcuts, not extra allow-list roots.
    const candidates = process.platform === 'darwin'
      ? [...roots, os.homedir(), '/Users', '/Volumes', '/tmp']
      : [...roots, os.homedir(), '/mnt', '/media', path.join('/run/media', path.basename(os.homedir())), '/tmp']
    const locations = []
    for (const candidate of candidates) {
      try {
        const location = await canonicalDirectory(candidate)
        await assertDirectoryReadable(location)
        if (!locations.includes(location)) locations.push(location)
      } catch {}
    }
    return locations
  }

  async function assertDirectoryAllowed(realPath, { allowFilesystemRoot = false } = {}) {
    if (env.ALLOW_ANY_WORKSPACE === '1') return
    const roots = await allowedDirectoryRoots()
    if (isDirectoryPickerSelectionAllowed(realPath, roots, { platform: process.platform })) return
    if (allowFilesystemRoot && isDirectoryNavigable(realPath, roots, { platform: process.platform })) return
    if (!roots.length && allowFilesystemRoot && realPath === path.parse(realPath).root) return
    const error = new Error('只能选择允许范围内的目录')
    error.code = 'INVALID_DIRECTORY'
    throw error
  }

  const cliWorkspace = commandWorkspace()

  function asWorkspaceUnavailable(error, configuredPath = workspaceCandidate) {
    const candidate = error?.details?.workspace || configuredPath || null
    const unavailable = new Error(error?.message || (candidate
      ? `上次工作空间当前不可访问：${candidate}`
      : '工作空间尚未就绪，请重试或选择新的工作目录'))
    unavailable.code = error?.code || 'WORKSPACE_UNAVAILABLE'
    unavailable.details = {
      ...(error?.details || {}),
      ...(candidate ? { workspace: candidate } : {}),
      canRetry: true,
      canSelectWorkspace: true,
    }
    return unavailable
  }

  function sendWorkspaceUnavailable(res, error = workspaceStartupError) {
    const unavailable = asWorkspaceUnavailable(error)
    res.status(503).json({
      error: unavailable.message,
      code: unavailable.code,
      ...(unavailable.details || {}),
    })
  }

  function wrapConfigSaveError(error) {
    const failure = new Error(`无法保存工作空间配置：${error?.message || '未知错误'}`)
    failure.code = 'WORKSPACE_CONFIG_SAVE_FAILED'
    failure.details = { configFile: CONFIG_FILE, causeCode: error?.code }
    return failure
  }

  async function activateConfiguredWorkspace(config) {
    await assertWorkspaceRecoveryRootsDisjoint(config.workspace, RECOVERY_ROOT)
    workspace = config.workspace
    workspaceCandidate = config.workspace
    workspaceStartupError = null
    configWasMissingAtStartup = false
  }

  async function initializeWorkspace() {
    if (cliWorkspace) {
      workspaceCandidate = cliWorkspace
      try {
        await assertWorkspaceRecoveryRootsDisjoint(cliWorkspace, RECOVERY_ROOT)
        workspace = await canonicalDirectory(cliWorkspace, { create: true })
        await fs.readdir(workspace)
        await assertWorkspaceRecoveryRootsDisjoint(workspace, RECOVERY_ROOT)
        workspaceCandidate = workspace
        workspaceStartupError = null
        // The command line is an explicit workspace choice. Preserve the legacy
        // persisted preference, while keeping the explicitly selected directory
        // available if the config location itself cannot be written.
        await saveWorkspaceConfig(CONFIG_FILE, workspace).then(() => {
          configWasMissingAtStartup = false
        }).catch(error => {
          console.error('保存工作空间配置失败：', error.message)
        })
      } catch (error) {
        workspace = null
        workspaceStartupError = asWorkspaceUnavailable(error, cliWorkspace)
      }
      return
    }

    let config
    try {
      config = await loadWorkspaceConfig(CONFIG_FILE)
    } catch (error) {
      workspace = null
      workspaceCandidate = error?.details?.workspace || null
      workspaceStartupError = asWorkspaceUnavailable(error, workspaceCandidate)
      return
    }

    if (config.kind === 'configured') {
      workspaceCandidate = config.workspace
      try {
        await activateConfiguredWorkspace(config)
      } catch (error) {
        workspace = null
        workspaceStartupError = asWorkspaceUnavailable(error, config.workspace)
      }
      return
    }

    // A missing file is the only first-run signal that may create the default.
    configWasMissingAtStartup = true
    workspaceCandidate = DEFAULT_WORKSPACE
    try {
      // Project missing components first so an illegal default cannot create a
      // directory inside recovery storage before the containment check runs.
      await assertWorkspaceRecoveryRootsDisjoint(DEFAULT_WORKSPACE, RECOVERY_ROOT)
      const resolved = await canonicalDirectory(DEFAULT_WORKSPACE, { create: true })
      await fs.readdir(resolved)
      await assertWorkspaceRecoveryRootsDisjoint(resolved, RECOVERY_ROOT)
      try {
        await saveWorkspaceConfig(CONFIG_FILE, resolved)
      } catch (error) {
        throw wrapConfigSaveError(error)
      }
      configWasMissingAtStartup = false
      workspace = resolved
      workspaceCandidate = resolved
      workspaceStartupError = null
    } catch (error) {
      workspace = null
      workspaceStartupError = asWorkspaceUnavailable(error, DEFAULT_WORKSPACE)
    }
  }

  async function reloadWorkspaceFromConfig() {
    try {
      const config = await loadWorkspaceConfig(CONFIG_FILE)
      if (config.kind === 'configured') {
        if (workspaceCandidate && config.workspace !== workspaceCandidate) {
          const error = new Error(
            `工作空间配置已指向其他目录：${config.workspace}。请显式选择工作目录后继续。`,
          )
          error.code = 'WORKSPACE_CONFIG_CHANGED'
          error.details = {
            configFile: CONFIG_FILE,
            workspace: workspaceCandidate,
            configuredWorkspace: config.workspace,
          }
          throw error
        }
        await activateConfiguredWorkspace(config)
        await reconcileWorkspaceRecovery(workspace)
        return
      }
      if (!configWasMissingAtStartup) {
        const error = new Error('工作空间配置文件已不存在；为避免切换到其他目录，请选择新的工作目录')
        error.code = 'WORKSPACE_CONFIG_MISSING'
        error.details = { configFile: CONFIG_FILE }
        throw error
      }

      await assertWorkspaceRecoveryRootsDisjoint(DEFAULT_WORKSPACE, RECOVERY_ROOT)
      const resolved = await canonicalDirectory(DEFAULT_WORKSPACE, { create: true })
      await fs.readdir(resolved)
      await assertWorkspaceRecoveryRootsDisjoint(resolved, RECOVERY_ROOT)
      try {
        await saveWorkspaceConfig(CONFIG_FILE, resolved)
      } catch (error) {
        throw wrapConfigSaveError(error)
      }
      configWasMissingAtStartup = false
      workspace = resolved
      workspaceCandidate = resolved
      workspaceStartupError = null
      await reconcileWorkspaceRecovery(resolved)
    } catch (error) {
      workspace = null
      workspaceStartupError = asWorkspaceUnavailable(error, error?.details?.workspace || workspaceCandidate)
      throw workspaceStartupError
    }
  }

  async function ensureCurrentWorkspaceAccessible(previous = workspace) {
    if (!previous) throw workspaceStartupError || asWorkspaceUnavailable(null)
    const changedError = () => {
      const error = new Error('工作空间已变化，请刷新后重新打开')
      error.code = 'WORKSPACE_MISMATCH'
      const info = currentWorkspaceInfo()
      error.details = info ? { ...info } : {}
      return error
    }
    if (workspace !== previous) throw changedError()
    try {
      const resolved = await canonicalDirectory(previous)
      if (resolved !== previous) {
        const error = new Error('工作空间路径解析已变化')
        error.code = 'WORKSPACE_PATH_CHANGED'
        throw error
      }
      await fs.readdir(resolved)
    } catch (error) {
      if (workspace !== previous) throw changedError()
      workspaceCandidate = previous
      workspace = null
      const unavailable = new Error(`上次工作空间当前不可访问：${previous}`)
      unavailable.code = 'SAVED_WORKSPACE_UNAVAILABLE'
      unavailable.details = { workspace: previous, causeCode: error?.code }
      workspaceStartupError = asWorkspaceUnavailable(unavailable, previous)
      throw workspaceStartupError
    }
    if (workspace !== previous) throw changedError()
  }

  let workspaceInitialization

  // Loading the Express application should be side-effect free. The process
  // entry point and isolated API tests initialize saved workspace configuration
  // explicitly before accepting requests.
  function initializeBackend() {
    if (!workspaceInitialization) workspaceInitialization = initializeWorkspace().then(async () => {
      if (workspace) await reconcileWorkspaceRecovery(workspace)
    })
    return workspaceInitialization
  }

  const app = express()
  const configuredOrigins = new Set((env.CORS_ORIGINS || env.EDITOR_CORS_ORIGINS || '')
    .split(',').map(item => item.trim()).filter(Boolean))
  const defaultOrigins = new Set([
    `http://localhost:${env.FRONTEND_PORT || 5558}`,
    `http://127.0.0.1:${env.FRONTEND_PORT || 5558}`,
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
  ])
  const localBackendHosts = new Set([
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
  ])

  function allowedRequestOrigin(origin, requestHost) {
    if (!origin || configuredOrigins.has('*') || configuredOrigins.has(origin)) return true
    if (defaultOrigins.has(origin) && localBackendHosts.has(String(requestHost || '').toLowerCase())) return true
    try {
      const parsed = new URL(origin)
      // A same-origin frontend proxy keeps the browser's Host header. This
      // accepts any LAN address or domain without trusting arbitrary origins.
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && parsed.origin === origin
        && parsed.host.toLowerCase() === String(requestHost || '').toLowerCase()
    } catch {
      return false
    }
  }

  app.use((req, res, next) => {
    if (!allowedRequestOrigin(req.get('origin'), req.get('host'))) {
      return res.status(403).json({ error: '请求来源不被允许', code: 'ORIGIN_NOT_ALLOWED' })
    }
    next()
  })
  app.use(cors({ origin: true }))
  app.use((req, res, next) => {
    if (workspace) setWorkspaceHeaders(res)
    if (req.path.startsWith('/assets/') || req.path === '/') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    }
    next()
  })
  // A 5 MiB UTF-8 Markdown document can expand to roughly 30 MiB in JSON when
  // its control characters are escaped. Allow that only on the Markdown write
  // route; other JSON APIs keep their existing 10 MiB parser limit.
  const defaultJsonParser = express.json({ limit: '10mb' })
  const markdownWriteJsonParser = express.json({ limit: '32mb' })
  app.use((req, res, next) => {
    const parser = req.method === 'PUT' && req.path === '/api/workspace'
      ? markdownWriteJsonParser
      : defaultJsonParser
    parser(req, res, next)
  })

  // Uploads contain one file and at most the path and documentPath text fields.
  // Keep the 100 MiB file ceiling used by ZIP import, while bounding every
  // multipart dimension that can otherwise consume parser time or memory.
  const uploadSingleFile = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 100 * 1024 * 1024,
      files: 1,
      fields: 2,
      parts: 3,
      fieldNameSize: 32,
      fieldSize: 8 * 1024,
      fieldNestingDepth: 0,
      fieldArrayIndexLimit: 0,
      headerPairs: 16,
    },
  }).single('file')

  function parseUpload(req, res, next) {
    uploadSingleFile(req, res, error => error ? sendError(res, error, req) : next())
  }

  // Every editor operation carries the workspace identity obtained from
  // /api/workspace/check or /api/workspace/set. A window left on an old
  // workspace therefore receives 409 instead of writing into a newly selected
  // directory.
  async function workspaceGuard(req, res, next) {
    const info = currentWorkspaceInfo()
    if (!info) {
      sendWorkspaceUnavailable(res)
      return
    }
    try {
      await ensureCurrentWorkspaceAccessible(info.workspace)
    } catch (error) {
      if (error?.code === 'WORKSPACE_MISMATCH') {
        const current = currentWorkspaceInfo()
        if (current) setWorkspaceHeaders(res, current)
        res.status(409).json({ error: error.message, code: error.code, ...(current || {}) })
        return
      }
      sendWorkspaceUnavailable(res, error)
      return
    }
    const current = currentWorkspaceInfo()
    if (!current || current.workspace !== info.workspace || current.workspaceVersion !== info.workspaceVersion) {
      if (current) setWorkspaceHeaders(res, current)
      const error = new Error('工作空间已变化，请刷新后重新打开')
      error.code = 'WORKSPACE_MISMATCH'
      res.status(409).json({ error: error.message, code: error.code, ...(current || {}) })
      return
    }
    setWorkspaceHeaders(res, info)
    // An <img> element cannot attach custom headers. The read-only image routes
    // accept the same identity in their query string; mutating routes still
    // require request headers.
    const allowQueryIdentity = req.method === 'GET' && (
      req.path.startsWith('/api/workspace/assets/') || req.path.startsWith('/api/workspace/media/')
    )
    const requestId = req.get('X-Workspace-Id') || (allowQueryIdentity ? req.query.workspaceId : null)
    const versionHeader = req.get('X-Workspace-Version')
      ?? (allowQueryIdentity ? req.query.workspaceVersion : null)
    const requestVersion = versionHeader == null || versionHeader === '' ? null : Number(versionHeader)
    if (!requestId || requestId !== info.workspaceId || (requestVersion != null && requestVersion !== info.workspaceVersion)) {
      const error = new Error('工作空间已变化，请刷新后重新打开')
      error.code = 'WORKSPACE_MISMATCH'
      res.status(409).json({ error: error.message, code: error.code, ...info })
      return
    }
    req.workspaceSnapshot = info
    next()
  }

  function sendData(res, data, req) {
    const info = req ? workspaceInfoFor(req) : currentWorkspaceInfo()
    if (info) setWorkspaceHeaders(res, info)
    res.json(data)
  }

  // ---------- 工作空间选择 ----------

  async function selectWorkspace(newPath) {
    const resolved = await canonicalDirectory(newPath)
    await assertDirectoryAllowed(resolved)
    await assertDirectoryReadable(resolved)
    await assertWorkspaceRecoveryRootsDisjoint(resolved, RECOVERY_ROOT)
    const previousWorkspace = workspace || workspaceCandidate
    const nextWorkspaceVersion = resolved !== previousWorkspace
      ? workspaceVersion + 1
      : workspaceVersion
    try {
      await saveWorkspaceConfig(CONFIG_FILE, resolved)
    } catch (error) {
      throw wrapConfigSaveError(error)
    }
    configWasMissingAtStartup = false
    workspace = resolved
    workspaceCandidate = resolved
    workspaceVersion = nextWorkspaceVersion
    workspaceStartupError = null
    await reconcileWorkspaceRecovery(resolved)
    return { success: true, ...currentWorkspaceInfo() }
  }

  registerWorkspaceSelectionRoutes(app, {
    withWorkspaceSelection,
    currentWorkspaceInfo,
    workspaceIsSelected: () => Boolean(workspace),
    reloadWorkspaceFromConfig,
    ensureCurrentWorkspaceAccessible,
    hasWorkspaceFiles,
    setWorkspaceHeaders,
    sendWorkspaceUnavailable,
    sendError,
    selectWorkspace,
    defaultDirectoryPickerPath,
    canonicalDirectory,
    allowedDirectoryRoots,
    directorySelectionPolicy,
    assertDirectoryAllowed,
    directoryPickerLocations,
  })

  // ---------- 文件 API ----------

  app.get('/api/workspace', workspaceGuard, async (req, res) => {
    try {
      const ws = workspaceFor(req)
      const files = req.query.recursive === '1' || req.query.recursive === 'true'
        ? await listTree(ws)
        : await listDir(ws, req.query.path || '')
      sendData(res, files, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.get('/api/workspace/file', workspaceGuard, async (req, res) => {
    try {
      const reqPath = req.query.path
      if (!reqPath) throw new Error('缺少 path 参数')
      sendData(res, await readFile(workspaceFor(req), reqPath), req)
    } catch (error) { sendError(res, error, req) }
  })

  app.get('/api/workspace/file/history', workspaceGuard, async (req, res) => {
    try {
      const reqPath = req.query.path
      if (!reqPath) throw new Error('缺少 path 参数')
      sendData(res, await listFileHistory(workspaceFor(req), reqPath, recoveryOptions()), req)
    } catch (error) { sendError(res, error, req) }
  })

  app.delete('/api/workspace/file/history', workspaceGuard, async (req, res) => {
    try {
      const reqPath = req.query.path
      const historyId = req.query.id
      if (!reqPath || !historyId) throw new Error('缺少 path 或 id 参数')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, async () => {
        const deleted = await deleteFileHistory(ws, reqPath, historyId, recoveryOptions())
        const stats = await workspaceRecoveryStats(ws)
        return { ...deleted, stats }
      })
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.get('/api/workspace/recovery/history', workspaceGuard, async (req, res) => {
    try {
      sendData(res, await listOrphanFileHistory(workspaceFor(req), recoveryOptions()), req)
    } catch (error) { sendError(res, error, req) }
  })

  app.get('/api/workspace/recovery/history/content', workspaceGuard, async (req, res) => {
    try {
      const { orphanId, historyId } = req.query
      if (!orphanId || !historyId) throw new Error('缺少 orphanId 或 historyId 参数')
      const { manifest, entry, content } = await readOrphanFileHistory(
        workspaceFor(req), orphanId, historyId, recoveryOptions(),
      )
      sendData(res, {
        content,
        revision: entry.revision,
        savedAt: entry.savedAt,
        sourcePath: manifest.path,
      }, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.delete('/api/workspace/recovery/history', workspaceGuard, async (req, res) => {
    try {
      const { id } = req.query
      if (!id) throw new Error('缺少 id 参数')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, async () => {
        const deleted = await deleteOrphanFileHistory(ws, id, recoveryOptions())
        const stats = await workspaceRecoveryStats(ws)
        return { ...deleted, stats }
      })
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.post('/api/workspace/recovery/history/restore', workspaceGuard, async (req, res) => {
    try {
      const { orphanId, historyId, path: reqPath, expectedRevision } = req.body || {}
      if (!orphanId || !historyId) throw new Error('缺少 orphanId 或 historyId 参数')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, async () => {
        const restored = await restoreOrphanFileHistory(ws, orphanId, historyId, reqPath, expectedRevision, recoveryOptions())
        return recordHistoryCleanup(ws, restored.path, restored, expectedRevision)
      })
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.get('/api/workspace/trash', workspaceGuard, async (req, res) => {
    try {
      const ws = workspaceFor(req)
      const items = await workspaceTrashService(ws).list()
      sendData(res, { items }, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.get('/api/workspace/recovery/stats', workspaceGuard, async (req, res) => {
    try {
      sendData(res, await workspaceRecoveryStats(workspaceFor(req)), req)
    } catch (error) { sendError(res, error, req) }
  })

  app.post('/api/workspace/recovery/reconcile', workspaceGuard, async (req, res) => {
    try {
      const ws = workspaceFor(req)
      const result = await reconcileWorkspaceRecovery(ws)
      sendData(res, { ...result, stats: await workspaceRecoveryStats(ws) }, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.post('/api/workspace/trash/purge-expired', workspaceGuard, async (req, res) => {
    try {
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, async () => {
        const purged = await workspaceTrashService(ws).purgeExpired()
        const stats = await workspaceRecoveryStats(ws)
        return { ...purged, stats }
      })
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.delete('/api/workspace/trash', workspaceGuard, async (req, res) => {
    try {
      const { id } = req.query
      if (!id) throw new Error('缺少 id 参数')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, async () => {
        const deleted = await workspaceTrashService(ws).remove(id)
        const stats = await workspaceRecoveryStats(ws)
        return { ...deleted, stats }
      })
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.post('/api/workspace/trash/restore', workspaceGuard, async (req, res) => {
    try {
      const { id } = req.body || {}
      if (!id) throw new Error('缺少 id 参数')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, async () => {
        const restored = await workspaceTrashService(ws).restore(id)
        const history = await reattachTrashFileHistory(ws, id, recoveryOptions())
        return { ...restored, historyReattached: history.reattached, historyOrphaned: history.retained }
      })
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.post('/api/workspace/file/restore', workspaceGuard, async (req, res) => {
    try {
      const { path: reqPath, historyId, expectedRevision } = req.body || {}
      if (!reqPath || !historyId) throw new Error('缺少 path 或 historyId 参数')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, async () => recordHistoryCleanup(ws, reqPath,
        await restoreFileHistory(ws, reqPath, historyId, expectedRevision, recoveryOptions()), expectedRevision))
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  async function streamWorkspaceImage(req, res, reqPath) {
    const file = await openBinaryFile(workspaceFor(req), reqPath, { imagesOnly: true })
    setWorkspaceHeaders(res, workspaceInfoFor(req))
    res.setHeader('Content-Type', file.mime)
    res.setHeader('Content-Length', String(file.size))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, no-store')
    if (file.mime === 'image/svg+xml') {
      // SVG can contain active content when opened as a document. Serve it with
      // a restrictive policy while still allowing it to render as an image.
      res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; form-action 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
    }
    await pipeline(file.stream, res)
  }

  app.get('/api/workspace/image', workspaceGuard, async (req, res) => {
    try {
      const reqPath = req.query.path
      if (!reqPath) throw new Error('缺少 path 参数')
      sendData(res, await readFileBase64(workspaceFor(req), reqPath), req)
    } catch (error) { sendError(res, error, req) }
  })

  app.post('/api/workspace', workspaceGuard, async (req, res) => {
    try {
      const { path: reqPath, name, type } = req.body || {}
      if (!name || !type) throw new Error('缺少 name 或 type')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, () => createItem(ws, reqPath || '', type, name, recoveryOptions()))
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.put('/api/workspace', workspaceGuard, async (req, res) => {
    try {
      const { path: reqPath, content, expectedRevision } = req.body || {}
      if (!reqPath) throw new Error('缺少 path 参数')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, async () => recordHistoryCleanup(ws, reqPath,
        await writeFile(ws, reqPath, content ?? '', expectedRevision, recoveryOptions()), expectedRevision))
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.delete('/api/workspace', workspaceGuard, async (req, res) => {
    try {
      const reqPath = req.query.path
      if (!reqPath) throw new Error('缺少 path 参数')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, async () => {
        const trash = workspaceTrashService(ws)
        const deleted = await trash.trash(reqPath)
        try {
          await archiveFileHistory(ws, deleted.path, {
            ...recoveryOptions(),
            reason: 'trash',
            trashEntryId: deleted.id,
            includeDescendants: deleted.type === 'directory',
          })
        } catch (error) {
          try {
            await trash.restore(deleted.id)
            await reattachTrashFileHistory(ws, deleted.id, recoveryOptions())
          } catch (rollbackError) {
            const failure = new Error(`文件已移入回收站；历史归档失败且恢复原路径也失败。回收站 ID：${deleted.id}`)
            failure.code = 'TRASH_ROLLBACK_FAILED'
            failure.cause = error
            failure.details = { trashEntryId: deleted.id, rollbackError: rollbackError.message }
            throw failure
          }
          throw error
        }
        return deleted
      })
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.post('/api/workspace/move/preflight', workspaceGuard, async (req, res) => {
    try {
      const { old_path: oldPath, new_path: newPath } = req.body || {}
      if (!oldPath || !newPath) throw new Error('缺少 old_path 或 new_path')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, () => getMoveReferenceImpacts(ws, oldPath, newPath))
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  app.post('/api/workspace/move', workspaceGuard, async (req, res) => {
    try {
      const { old_path: oldPath, new_path: newPath } = req.body || {}
      if (!oldPath || !newPath) throw new Error('缺少 old_path 或 new_path')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, () => moveItem(ws, oldPath, newPath, recoveryOptions()))
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  })

  async function handleWorkspaceUpload(req, res, { assetsOnly = false } = {}) {
    try {
      if (!req.file) throw new Error('缺少文件')
      const file = { ...req.file, originalname: normalizeMultipartFilename(req.file.originalname) }
      const extension = path.extname(file.originalname).toLowerCase().slice(1)
      if (assetsOnly && !IMAGE_EXTENSIONS.has(extension)) throw new Error('只允许上传图片文件')
      const ws = workspaceFor(req)
      const documentPath = assetsOnly ? '' : req.body?.documentPath
      if (documentPath && !IMAGE_EXTENSIONS.has(extension)) throw new Error('文档同级 assets 只允许上传图片')
      const targetPath = assetsOnly ? 'assets' : (req.body?.path || '')
      const result = await withWorkspaceMutation(ws, async () => {
        const destination = documentPath
          ? await ensureAdjacentAssetsDirectory(ws, documentPath)
          : targetPath
        if (!documentPath && (assetsOnly || targetPath === 'assets')) await fs.mkdir(path.join(ws, 'assets'), { recursive: true })
        return uploadFile(ws, destination, file, recoveryOptions())
      })
      sendData(res, result, req)
    } catch (error) { sendError(res, error, req) }
  }

  // The workspace upload route is canonical. Keep the short assets alias for
  // existing clients while both routes share the same implementation.
  app.post('/api/workspace/upload', workspaceGuard, parseUpload, (req, res) => handleWorkspaceUpload(req, res))
  app.post('/api/upload/assets', workspaceGuard, parseUpload, (req, res) => handleWorkspaceUpload(req, res, { assetsOnly: true }))

  app.get('/api/workspace/assets/:filename', workspaceGuard, async (req, res) => {
    try {
      const filename = req.params.filename
      if (!filename || path.basename(filename) !== filename || filename.includes('\\')) {
        return res.status(404).send('Not found')
      }
      await streamWorkspaceImage(req, res, `assets/${filename}`)
    } catch (error) {
      if (error?.code === 'WORKSPACE_MISMATCH') return sendError(res, error, req)
      if (res.headersSent || res.destroyed) {
        if (!res.destroyed) res.destroy()
      } else res.status(errorStatus(error) === 409 ? 409 : 404).send('Not found')
    }
  })

  // Relative Markdown image references can point anywhere inside the workspace.
  // Reuse the file service's image MIME allowlist, workspace boundary checks and
  // symlink rejection rather than serving arbitrary workspace files.
  app.get('/api/workspace/media/*', workspaceGuard, async (req, res) => {
    try {
      const workspacePath = req.params[0]
      if (!workspacePath) return res.status(404).send('Not found')
      await streamWorkspaceImage(req, res, workspacePath)
    } catch (error) {
      if (error?.code === 'WORKSPACE_MISMATCH') return sendError(res, error, req)
      if (res.headersSent || res.destroyed) {
        if (!res.destroyed) res.destroy()
      } else res.status(errorStatus(error) === 409 ? 409 : 404).send('Not found')
    }
  })

  // 递归搜索文件名和 Markdown 文本。
  app.get('/api/workspace/search', workspaceGuard, async (req, res) => {
    try {
      const ws = workspaceFor(req)
      sendData(res, await searchWorkspace(ws, req.query.q), req)
    } catch (error) { sendError(res, error, req) }
  })

  function contentDispositionFilename(filename) {
    // Node's HTTP header implementation only accepts latin-1 in the fallback
    // filename. RFC 5987 filename* carries the original UTF-8 name safely.
    const fallback = filename.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/[\\"\r\n]/g, '_') || 'download'
    const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
  }

  // 导出当前文件为下载响应。
  app.get('/api/workspace/export', workspaceGuard, async (req, res) => {
    try {
      const reqPath = req.query.path
      if (!reqPath) throw new Error('缺少 path 参数')
      const file = await openBinaryFile(workspaceFor(req), reqPath)
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Content-Length', String(file.size))
      res.setHeader('Content-Disposition', contentDispositionFilename(file.name))
      setWorkspaceHeaders(res, workspaceInfoFor(req))
      await pipeline(file.stream, res)
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        if (!res.destroyed) res.destroy()
      } else sendError(res, error, req)
    }
  })

  // Attachments are streamed as their original bytes. This route deliberately
  // does not pass through the UTF-8 Markdown reader used by /export.
  app.get('/api/workspace/download', workspaceGuard, async (req, res) => {
    try {
      const reqPath = req.query.path
      if (!reqPath) throw new Error('缺少 path 参数')
      const file = await openBinaryFile(workspaceFor(req), reqPath)
      setWorkspaceHeaders(res, workspaceInfoFor(req))
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Content-Length', String(file.size))
      res.setHeader('Content-Disposition', contentDispositionFilename(file.name))
      await pipeline(file.stream, res)
    } catch (error) {
      if (res.headersSent || res.destroyed) res.destroy(error)
      else sendError(res, error, req)
    }
  })

  // 从 ZIP 导入 Markdown 和图片。服务会先验证并暂存全部内容，再排他写入；
  // 路径、父目录和目标冲突都在工作空间变更锁内检查。
  app.post('/api/workspace/import', workspaceGuard, parseUpload, async (req, res) => {
    try {
      if (!req.file) throw new Error('缺少导入文件')
      if (path.extname(req.file.originalname).toLowerCase() !== '.zip') throw new Error('只允许导入 .zip 文件')
      const ws = workspaceFor(req)
      const result = await withWorkspaceMutation(ws, () => importZip(ws, req.file.buffer, {
        // ZIP import is another path-creation entry point. Detach any surviving
        // history for a previously deleted path before publishing the new file.
        // If a later ZIP entry fails, importZip rolls back published files while
        // these records remain available in the orphan history manager.
        async beforeCommitFile(entryName) {
          const extension = path.extname(entryName).toLowerCase()
          if (extension === '.md' || extension === '.markdown') {
            await archiveFileHistory(ws, entryName, { ...recoveryOptions(), reason: 'path-reused' })
          }
        },
      }))
      sendData(res, {
        success: true,
        imported: result.imported,
        files: result.files,
        cleanupWarnings: result.cleanupWarnings,
        message: `已导入 ${result.imported} 个文件`,
      }, req)
    } catch (error) { sendError(res, error, req) }
  })

  // ---------- 静态资源 ----------

  app.use(express.static(path.join(__dirname, '../../frontend/dist')))

  return {
    app,
    initialize: initializeBackend,
    currentWorkspaceInfo,
    workspaceStartupError: () => workspaceStartupError,
    host: HOST,
    port: PORT,
    workspace: () => workspace,
    recoveryRoot: RECOVERY_ROOT,
  }
}

// Preserve `node src/index.js` as a supported development and production
// entrypoint while imports used by tests only construct an app on demand.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!isSupportedNodeVersion(process.versions.node)) {
    console.error(`❌ 需要 Node.js 22.17.0 或更新的 22.x 版本（当前：v${process.versions.node}）`)
    process.exitCode = 1
  } else {
    await startBackendServer(createBackend())
  }
}
