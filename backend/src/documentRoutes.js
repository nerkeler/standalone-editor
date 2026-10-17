// @ts-check
import fs from 'fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'path'
import {
  listDir,
  listTree,
  readFile,
  readFileBase64,
  createItem,
  getMoveReferenceImpacts,
  moveItem,
  writeFile,
  ensureAdjacentAssetsDirectory,
  uploadFile,
  searchWorkspace,
} from './fileService.js'
import { makeError } from './errors.js'
import { archiveFileHistory } from './historyService.js'
import { openBinaryFile } from './fileService.js'
import { importZip } from './zipImportService.js'
import { normalizeMultipartFilename, contentDispositionFilename } from './httpUtils.js'

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif'])

/**
 * Workspace document routes: listing, reading, versioned writes, moves,
 * uploads, full-text search, export and ZIP import.
 *
 * @param {import('express').Express} app
 * @param {{
 *   workspaceGuard: import('express').RequestHandler,
 *   parseUpload: import('express').RequestHandler,
 *   workspaceFor: (req: unknown) => string,
 *   withWorkspaceMutation: <T>(ws: string, op: () => Promise<T>) => Promise<T>,
 *   recoveryOptions: () => { root: string },
 *   recordHistoryCleanup: <T>(ws: string, path: string, result: T, expectedRevision: unknown) => T,
 *   setWorkspaceHeaders: (res: import('express').Response, info?: unknown) => unknown,
 *   workspaceInfoFor: (req: unknown) => unknown,
 *   sendData: (res: import('express').Response, data: unknown, req: import('express').Request) => void,
 *   sendError: (res: import('express').Response, error: unknown, req?: import('express').Request) => void,
 * }} deps
 */
export function registerDocumentRoutes(app, deps) {
  const {
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
  } = deps
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
      if (!req.file) throw makeError('缺少文件')
      const file = { ...req.file, originalname: normalizeMultipartFilename(req.file.originalname) }
      const extension = path.extname(file.originalname).toLowerCase().slice(1)
      if (assetsOnly && !IMAGE_EXTENSIONS.has(extension)) throw makeError('只允许上传图片文件')
      const ws = workspaceFor(req)
      const documentPath = assetsOnly ? '' : req.body?.documentPath
      if (documentPath && !IMAGE_EXTENSIONS.has(extension)) throw makeError('文档同级 assets 只允许上传图片')
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

  // 递归搜索文件名和 Markdown 文本。
  app.get('/api/workspace/search', workspaceGuard, async (req, res) => {
    try {
      const ws = workspaceFor(req)
      sendData(res, await searchWorkspace(ws, req.query.q), req)
    } catch (error) { sendError(res, error, req) }
  })

  // 导出当前文件为下载响应。
  app.get('/api/workspace/export', workspaceGuard, async (req, res) => {
    try {
      const reqPath = req.query.path
      if (!reqPath) throw makeError('缺少 path 参数')
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
      if (!reqPath) throw makeError('缺少 path 参数')
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
      if (!req.file) throw makeError('缺少导入文件')
      if (path.extname(req.file.originalname).toLowerCase() !== '.zip') throw makeError('只允许导入 .zip 文件')
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
}
