// @ts-check
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import {
  hasWorkspaceFiles,
} from './fileService.js'
import { createTrashService } from './trashService.js'
import { getRecoveryStats } from './recoveryStatsService.js'
import { isSupportedNodeVersion } from './runtimeVersion.js'
import { makeError } from './errors.js'
import { errorStatus } from './serverErrors.js'
import { registerDocumentRoutes } from './documentRoutes.js'
import { registerRecoveryRoutes } from './recoveryRoutes.js'
import { registerMediaRoutes } from './mediaRoutes.js'
import { reattachTrashFileHistory } from './historyService.js'
import { registerAuthRoutes, loadPasswordRecord } from './authRoutes.js'
import { resolveAuthFile } from './authService.js'
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
  let workspace
  let workspaceVersion = 1
  let workspaceStartupError = null
  let workspaceCandidate = null
  let configWasMissingAtStartup = false
  const workspaceMutationTails = new Map()
  const recoveryMaintenance = new Map()
  const historyCleanupWarnings = new Map()
  let workspaceSelectionTail = Promise.resolve()

  const AUTH_FILE = options.authFile || resolveAuthFile({ env, configFile: CONFIG_FILE })
  /** Filled in by initializeBackend before any request is accepted. */
  const authState = { record: null, enabled: false }

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
      throw makeError('不是有效目录', 'INVALID_DIRECTORY')
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
    throw makeError('只能选择允许范围内的目录', 'INVALID_DIRECTORY')
  }

  const cliWorkspace = commandWorkspace()

  function asWorkspaceUnavailable(error, configuredPath = workspaceCandidate) {
    const candidate = error?.details?.workspace || configuredPath || null
    const unavailable = makeError(error?.message || (candidate
      ? `上次工作空间当前不可访问：${candidate}`
      : '工作空间尚未就绪，请重试或选择新的工作目录'), error?.code || 'WORKSPACE_UNAVAILABLE')
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
    const failure = makeError(`无法保存工作空间配置：${error?.message || '未知错误'}`, 'WORKSPACE_CONFIG_SAVE_FAILED')
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
          const error = makeError(
            `工作空间配置已指向其他目录：${config.workspace}。请显式选择工作目录后继续。`,
            'WORKSPACE_CONFIG_CHANGED')
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
        const error = makeError('工作空间配置文件已不存在；为避免切换到其他目录，请选择新的工作目录', 'WORKSPACE_CONFIG_MISSING')
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
      const error = makeError('工作空间已变化，请刷新后重新打开', 'WORKSPACE_MISMATCH')
      const info = currentWorkspaceInfo()
      error.details = info ? { ...info } : {}
      return error
    }
    if (workspace !== previous) throw changedError()
    try {
      const resolved = await canonicalDirectory(previous)
      if (resolved !== previous) {
        throw makeError('工作空间路径解析已变化', 'WORKSPACE_PATH_CHANGED')
      }
      await fs.readdir(resolved)
    } catch (error) {
      if (workspace !== previous) throw changedError()
      workspaceCandidate = previous
      workspace = null
      const unavailable = makeError(`上次工作空间当前不可访问：${previous}`, 'SAVED_WORKSPACE_UNAVAILABLE')
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
    }).then(async () => {
      // An explicit EDITOR_PASSWORD always (re)writes the auth file. A missing
      // file runs without password protection and prints a startup warning; a
      // corrupted file is a startup error to avoid silently unauthenticated runs.
      const loaded = await loadPasswordRecord(AUTH_FILE, { password: env.EDITOR_PASSWORD })
      authState.record = loaded.record
      authState.enabled = loaded.enabled
    })
    return workspaceInitialization
  }

  const app = express()
  // Honor X-Forwarded-* only when the operator explicitly declares a proxy, so
  // a Secure cookie is set while the deployment retains full control.
  if (options.trustProxy || env.EDITOR_TRUST_PROXY === '1') app.set('trust proxy', true)

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
  // Auth routes self-exempt their own paths; the guard below protects every
  // later-registered API route and leaves static hosting public.
  const authInstance = registerAuthRoutes(app, {
    state: authState,
    sendError,
    secure: req => /** @type {import('express').Request} */ (req)?.secure,
  })
  app.use(authInstance.authGuard)

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
      const error = makeError('工作空间已变化，请刷新后重新打开', 'WORKSPACE_MISMATCH')
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
      const error = makeError('工作空间已变化，请刷新后重新打开', 'WORKSPACE_MISMATCH')
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

  // ---------- 文件与恢复 API ----------

  registerDocumentRoutes(app, {
    workspaceGuard,
    parseUpload,
    workspaceFor,
    withWorkspaceMutation,
    recoveryOptions,
    recordHistoryCleanup,
    setWorkspaceHeaders,
    workspaceInfoFor,
    sendData,
    sendError,
  })

  registerRecoveryRoutes(app, {
    workspaceGuard,
    workspaceFor,
    withWorkspaceMutation,
    workspaceTrashService,
    recoveryOptions,
    workspaceRecoveryStats,
    recordHistoryCleanup,
    reconcileWorkspaceRecovery,
    sendData,
    sendError,
  })

  registerMediaRoutes(app, {
    workspaceGuard,
    workspaceFor,
    workspaceInfoFor,
    setWorkspaceHeaders,
    sendError,
  })

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
  const argv = process.argv.slice(2)
  const authCommand = argv.includes('--set-password')
    ? 'set'
    : argv.includes('--clear-password') ? 'clear' : null
  if (authCommand) {
    const authCommandModule = await import('./authCommands.js')
    process.exitCode = await authCommandModule.handleAuthCommand(authCommand, {
      env: process.env,
      write: process.stderr.write.bind(process.stderr),
    })
  } else if (!isSupportedNodeVersion(process.versions.node)) {
    console.error(`❌ 需要 Node.js 22.17.0 或更新的 22.x 版本（当前：v${process.versions.node}）`)
    process.exitCode = 1
  } else {
    await startBackendServer(createBackend())
  }
}
