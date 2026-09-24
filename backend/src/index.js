import express from 'express'
import cors from 'cors'
import multer from 'multer'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import {
  listDir,
  listTree,
  readFile,
  readFileBase64,
  createItem,
  moveItem,
  writeFile,
  listFileHistory,
  restoreFileHistory,
  uploadFile,
  listAll,
  searchWorkspace,
} from './fileService.js'
import { createTrashService } from './trashService.js'
import { importZip } from './zipImportService.js'
import {
  configuredRootValues,
  defaultRootCandidates,
  breadcrumbFor,
  isDirectoryNavigable,
  isDirectorySelectable,
  isWithinPath,
  parentPath,
  pathModuleFor,
  rootEntry,
} from './directoryPicker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function envNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const configuredPort = process.env.PORT ?? process.env.EDITOR_PORT
const PORT = configuredPort === '0' ? 0 : envNumber('PORT', envNumber('EDITOR_PORT', 5557))
const HOST = process.env.HOST || process.env.EDITOR_HOST || '127.0.0.1'
const CONFIG_FILE = process.env.WORKSPACE_CONFIG_FILE
  || process.env.EDITOR_CONFIG_FILE
  || path.join(os.homedir(), '.standalone-editor', 'workspace.json')
const DEFAULT_WORKSPACE = process.env.EDITOR_DEFAULT_WORKSPACE
  || path.join(os.homedir(), 'Documents', 'standalone-editor-notes')
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif'])

let workspace
let workspaceVersion = 1
const workspaceMutationTails = new Map()

function errorStatus(error) {
  if (
    error?.code === 'CONFLICT' || error?.code === 'FILE_CONFLICT' ||
    error?.code === 'HISTORY_CONFLICT' || error?.code === 'WORKSPACE_MISMATCH'
  ) return 409
  if (error?.code === 'REVISION_REQUIRED') return 428
  if (error?.code === 'ENOENT' || error?.code === 'HISTORY_NOT_FOUND') return 404
  if (
    error?.code === 'RECOVERY_STORAGE_ERROR' || error?.code === 'HISTORY_CORRUPT' ||
    error?.code === 'HISTORY_ROLLBACK_FAILED' || error?.code === 'MOVE_ROLLBACK_FAILED'
  ) return 500
  if (error?.code === 'ZIP_LIMIT') return 413
  return 400
}

function sendError(res, error, req = res.req) {
  console.error(`[${res.req.method} ${res.req.originalUrl}]`, error?.message || error)
  if (req?.workspaceSnapshot) setWorkspaceHeaders(res, req.workspaceSnapshot)
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

function currentWorkspaceInfo() {
  return {
    workspace,
    workspaceId: workspaceIdFor(workspace),
    workspaceVersion,
  }
}

function setWorkspaceHeaders(res, info = currentWorkspaceInfo()) {
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

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8')
    const cfg = JSON.parse(data)
    if (cfg.workspace) return await canonicalDirectory(cfg.workspace)
  } catch {}
  return null
}

async function saveConfig(ws) {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, JSON.stringify({ workspace: ws }, null, 2), 'utf-8')
}

function commandWorkspace() {
  const args = process.argv.slice(2)
  const index = args.indexOf('--workspace')
  if (index === -1 || !args[index + 1]) return null
  return path.resolve(args[index + 1])
}

// A directory selected in the picker must be below one of these roots. The
// command-line workspace remains useful for explicit deployments and tests.
async function allowedDirectoryRoots() {
  const configured = process.env.EDITOR_DIRECTORY_ROOTS || process.env.DIRECTORY_ROOTS
  const values = configured
    ? configuredRootValues(configured, process.platform)
    : defaultRootCandidates({ platform: process.platform, home: os.homedir(), env: process.env })
  const roots = []
  for (const value of values) {
    try {
      const resolved = await canonicalDirectory(value)
      // A stat-able mount can still deny directory enumeration. Exclude it
      // here so the picker never advertises a root that cannot be opened.
      await fs.readdir(resolved)
      if (!roots.some(root => isWithinPath(root, resolved, process.platform))) roots.push(resolved)
    } catch {}
  }
  return roots
}

async function defaultDirectoryPickerPath() {
  const roots = await allowedDirectoryRoots()
  if (roots.some(root => isWithinPath(root, os.homedir(), process.platform))) return os.homedir()
  return roots[0] || os.homedir()
}

async function assertDirectoryAllowed(realPath, { allowFilesystemRoot = false } = {}) {
  if (process.env.ALLOW_ANY_WORKSPACE === '1') return
  const roots = await allowedDirectoryRoots()
  if (isDirectorySelectable(realPath, roots, process.platform)) return
  if (allowFilesystemRoot && isDirectoryNavigable(realPath, roots, { platform: process.platform })) return
  if (!roots.length && allowFilesystemRoot && realPath === path.parse(realPath).root) return
  const error = new Error('只能选择允许范围内的目录')
  error.code = 'INVALID_DIRECTORY'
  throw error
}

const cliWorkspace = commandWorkspace()
workspace = await canonicalDirectory(cliWorkspace || await loadConfig() || DEFAULT_WORKSPACE, { create: true })

const app = express()
const configuredOrigins = (process.env.CORS_ORIGINS || process.env.EDITOR_CORS_ORIGINS || '')
  .split(',').map(item => item.trim()).filter(Boolean)
const defaultOrigins = new Set([
  `http://localhost:${process.env.FRONTEND_PORT || 5558}`,
  `http://127.0.0.1:${process.env.FRONTEND_PORT || 5558}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
])

app.use(cors({
  origin(origin, callback) {
    if (!origin || configuredOrigins.includes('*') || configuredOrigins.includes(origin) || defaultOrigins.has(origin)) {
      callback(null, true)
    } else {
      callback(new Error('请求来源不被允许'))
    }
  },
}))
app.use((req, res, next) => {
  setWorkspaceHeaders(res)
  if (req.path.startsWith('/assets/') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
  }
  next()
})
app.use(express.json({ limit: '10mb' }))

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } })

// Every editor operation carries the workspace identity obtained from
// /api/workspace/check or /api/workspace/set. A window left on an old
// workspace therefore receives 409 instead of writing into a newly selected
// directory.
function workspaceGuard(req, res, next) {
  const info = setWorkspaceHeaders(res)
  // An <img> element cannot attach custom headers. The read-only assets route
  // accepts the same identity in its query string; every mutating route still
  // requires request headers.
  const allowQueryIdentity = req.method === 'GET' && req.path.startsWith('/api/workspace/assets/')
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
  setWorkspaceHeaders(res, req ? workspaceInfoFor(req) : currentWorkspaceInfo())
  res.json(data)
}

// ---------- 工作空间选择 ----------

app.get('/api/workspace/check', async (req, res) => {
  try {
    const info = currentWorkspaceInfo()
    const files = await listAll(info.workspace)
    setWorkspaceHeaders(res, info)
    res.json({ ...info, empty: files.length === 0 })
  } catch (error) { sendError(res, error) }
})

app.post('/api/workspace/set', async (req, res) => {
  try {
    const { path: newPath } = req.body || {}
    if (!newPath || typeof newPath !== 'string') {
      const error = new Error('缺少 path 参数')
      error.code = 'INVALID_DIRECTORY'
      throw error
    }
    const resolved = await canonicalDirectory(newPath)
    await assertDirectoryAllowed(resolved)
    if (resolved !== workspace) workspaceVersion += 1
    workspace = resolved
    await saveConfig(workspace)
    sendData(res, { success: true, ...currentWorkspaceInfo() })
  } catch (error) { sendError(res, error) }
})

// GET /api/dirs — 浏览目录选择器允许的根目录
app.get('/api/dirs', async (req, res) => {
  try {
    const requested = req.query.path || await defaultDirectoryPickerPath()
    const resolved = await canonicalDirectory(requested)
    const roots = await allowedDirectoryRoots()
    // The picker needs to display the filesystem root on macOS/Linux so that
    // users can reach an allowed mount. Selecting a workspace still goes
    // through the stricter allow-list in /api/workspace/set.
    if (!isDirectoryNavigable(resolved, roots, { platform: process.platform })) {
      await assertDirectoryAllowed(resolved, { allowFilesystemRoot: true })
    }
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const result = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const entryPath = path.join(resolved, entry.name)
      let stat
      try {
        stat = await fs.lstat(entryPath)
      } catch {
        // A mount can disappear or become unreadable while the picker is
        // open. Keep the directory listing useful instead of failing all of
        // the other entries for one stale item.
        continue
      }
      if (stat.isSymbolicLink()) continue
      const canNavigate = stat.isDirectory()
        && isDirectoryNavigable(entryPath, roots, { platform: process.platform })
      // At a filesystem root or an allow-list ancestor, hide directories that
      // cannot lead to an allowed location instead of showing dead-end items.
      if (stat.isDirectory() && !canNavigate) continue
      result.push({
        name: entry.name,
        type: stat.isDirectory() ? 'dir' : 'file',
        path: entryPath,
        parent: resolved,
        canNavigate,
        canSelect: stat.isDirectory() && isDirectorySelectable(entryPath, roots, process.platform),
      })
    }
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    const parent = parentPath(resolved, process.platform)
    const canGoUp = Boolean(parent && isDirectoryNavigable(parent, roots, { platform: process.platform }))
    const breadcrumbs = breadcrumbFor(resolved, process.platform).map(item => ({
      ...item,
      canNavigate: isDirectoryNavigable(item.path, roots, { platform: process.platform }),
      canSelect: isDirectorySelectable(item.path, roots, process.platform),
    }))
    const rootEntries = roots.map(root => rootEntry(root, process.platform))
    res.json({
      platform: process.platform,
      separator: pathModuleFor(process.platform).sep,
      path: resolved,
      parent: canGoUp ? parent : null,
      canGoUp,
      canSelect: isDirectorySelectable(resolved, roots, process.platform),
      breadcrumb: breadcrumbs,
      roots: rootEntries,
      rootPaths: roots,
      entries: result,
    })
  } catch (error) { sendError(res, error) }
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
    sendData(res, await listFileHistory(workspaceFor(req), reqPath), req)
  } catch (error) { sendError(res, error, req) }
})

app.get('/api/workspace/trash', workspaceGuard, async (req, res) => {
  try {
    const ws = workspaceFor(req)
    const items = await createTrashService(ws).list()
    sendData(res, { items }, req)
  } catch (error) { sendError(res, error, req) }
})

app.post('/api/workspace/trash/restore', workspaceGuard, async (req, res) => {
  try {
    const { id } = req.body || {}
    if (!id) throw new Error('缺少 id 参数')
    const ws = workspaceFor(req)
    const result = await withWorkspaceMutation(ws, () => createTrashService(ws).restore(id))
    sendData(res, result, req)
  } catch (error) { sendError(res, error, req) }
})

app.post('/api/workspace/file/restore', workspaceGuard, async (req, res) => {
  try {
    const { path: reqPath, historyId, expectedRevision } = req.body || {}
    if (!reqPath || !historyId) throw new Error('缺少 path 或 historyId 参数')
    const ws = workspaceFor(req)
    const result = await withWorkspaceMutation(ws, () => restoreFileHistory(ws, reqPath, historyId, expectedRevision))
    sendData(res, result, req)
  } catch (error) { sendError(res, error, req) }
})

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
    const result = await withWorkspaceMutation(ws, () => createItem(ws, reqPath || '', type, name))
    sendData(res, result, req)
  } catch (error) { sendError(res, error, req) }
})

app.put('/api/workspace', workspaceGuard, async (req, res) => {
  try {
    const { path: reqPath, content, expectedRevision } = req.body || {}
    if (!reqPath) throw new Error('缺少 path 参数')
    const ws = workspaceFor(req)
    const result = await withWorkspaceMutation(ws, () => writeFile(ws, reqPath, content ?? '', expectedRevision))
    sendData(res, result, req)
  } catch (error) { sendError(res, error, req) }
})

app.delete('/api/workspace', workspaceGuard, async (req, res) => {
  try {
    const reqPath = req.query.path
    if (!reqPath) throw new Error('缺少 path 参数')
    const ws = workspaceFor(req)
    const result = await withWorkspaceMutation(ws, () => createTrashService(ws).trash(reqPath))
    sendData(res, result, req)
  } catch (error) { sendError(res, error, req) }
})

app.post('/api/workspace/move', workspaceGuard, async (req, res) => {
  try {
    const { old_path: oldPath, new_path: newPath } = req.body || {}
    if (!oldPath || !newPath) throw new Error('缺少 old_path 或 new_path')
    const ws = workspaceFor(req)
    const result = await withWorkspaceMutation(ws, () => moveItem(ws, oldPath, newPath))
    sendData(res, result, req)
  } catch (error) { sendError(res, error, req) }
})

async function handleWorkspaceUpload(req, res, { assetsOnly = false } = {}) {
  try {
    if (!req.file) throw new Error('缺少文件')
    const extension = path.extname(req.file.originalname).toLowerCase().slice(1)
    if (assetsOnly && !IMAGE_EXTENSIONS.has(extension)) throw new Error('只允许上传图片文件')
    const ws = workspaceFor(req)
    const targetPath = assetsOnly ? 'assets' : (req.body?.path || '')
    const result = await withWorkspaceMutation(ws, async () => {
      // Image uploads always use the same assets directory, while the generic
      // endpoint can target any existing workspace directory.
      if (assetsOnly || targetPath === 'assets') await fs.mkdir(path.join(ws, 'assets'), { recursive: true })
      return uploadFile(ws, targetPath, req.file)
    })
    sendData(res, result, req)
  } catch (error) { sendError(res, error, req) }
}

// The workspace upload route is canonical. Keep the short assets alias for
// existing clients while both routes share the same implementation.
app.post('/api/workspace/upload', workspaceGuard, upload.single('file'), (req, res) => handleWorkspaceUpload(req, res))
app.post('/api/upload/assets', workspaceGuard, upload.single('file'), (req, res) => handleWorkspaceUpload(req, res, { assetsOnly: true }))

app.get('/api/workspace/assets/:filename', workspaceGuard, async (req, res) => {
  try {
    const filename = req.params.filename
    if (!filename || path.basename(filename) !== filename || filename.includes('\\')) {
      return res.status(404).send('Not found')
    }
    const result = await readFileBase64(workspaceFor(req), `assets/${filename}`)
    setWorkspaceHeaders(res, workspaceInfoFor(req))
    res.type(result.mime).send(Buffer.from(result.data, 'base64'))
  } catch (error) {
    if (error?.code === 'WORKSPACE_MISMATCH') return sendError(res, error, req)
    res.status(errorStatus(error) === 409 ? 409 : 404).send('Not found')
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
  const fallback = filename.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/[\\"\r\n]/g, '_') || 'download.md'
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

// 导出当前文件为下载响应。
app.get('/api/workspace/export', workspaceGuard, async (req, res) => {
  try {
    const reqPath = req.query.path
    if (!reqPath) throw new Error('缺少 path 参数')
    const result = await readFile(workspaceFor(req), reqPath)
    const filename = path.basename(reqPath).replace(/[\r\n"\\]/g, '_')
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.setHeader('Content-Disposition', contentDispositionFilename(filename))
    res.send(result.content)
  } catch (error) { sendError(res, error, req) }
})

// 从 ZIP 导入 Markdown 和图片。服务会先验证并暂存全部内容，再排他写入；
// 路径、父目录和目标冲突都在工作空间变更锁内检查。
app.post('/api/workspace/import', workspaceGuard, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('缺少导入文件')
    if (path.extname(req.file.originalname).toLowerCase() !== '.zip') throw new Error('只允许导入 .zip 文件')
    const ws = workspaceFor(req)
    const result = await withWorkspaceMutation(ws, () => importZip(ws, req.file.buffer))
    sendData(res, {
      success: true,
      imported: result.imported,
      files: result.files,
      message: `已导入 ${result.imported} 个文件`,
    }, req)
  } catch (error) { sendError(res, error, req) }
})

// ---------- 静态资源 ----------

app.use(express.static(path.join(__dirname, '../../frontend/dist')))

const server = app.listen(PORT, HOST, async () => {
  try {
    await saveConfig(workspace)
    console.log('✅ 编辑器后端已启动')
    console.log(`📁 工作空间：${workspace}`)
    console.log(`🌐 http://${HOST}:${server.address()?.port ?? PORT}`)
  } catch (error) {
    console.error('保存工作空间配置失败：', error.message)
  }
})

server.on('error', error => {
  console.error(`后端启动失败：${error.message}`)
  process.exitCode = 1
})

export { app, currentWorkspaceInfo, server }
