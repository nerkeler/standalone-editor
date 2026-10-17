// @ts-check
import {
  listFileHistory,
  deleteFileHistory,
  listOrphanFileHistory,
  deleteOrphanFileHistory,
  readOrphanFileHistory,
  reattachTrashFileHistory,
  archiveFileHistory,
} from './historyService.js'
import { restoreFileHistory, restoreOrphanFileHistory } from './fileService.js'
import { makeError } from './errors.js'

/**
 * Recovery-domain routes: file history, orphaned history and the trash.
 * Every mutating operation is serialized per workspace via withWorkspaceMutation.
 *
 * @param {import('express').Express} app
 * @param {{
 *   workspaceGuard: import('express').RequestHandler,
 *   workspaceFor: (req: unknown) => string,
 *   withWorkspaceMutation: <T>(ws: string, op: () => Promise<T>) => Promise<T>,
 *   workspaceTrashService: (ws: string) => {
 *     list(): Promise<any[]>,
 *     purgeExpired(): Promise<object>,
 *     remove(id: string): Promise<object>,
 *     restore(id: string): Promise<object>,
 *     trash(path: string): Promise<{ id: string, path: string, type?: string }>,
 *   },
 *   recoveryOptions: () => { root: string },
 *   workspaceRecoveryStats: (ws: string) => Promise<unknown>,
 *   recordHistoryCleanup: <T>(ws: string, path: string, result: T, expectedRevision: unknown) => T,
 *   reconcileWorkspaceRecovery: (ws: string) => Promise<{ restored: unknown[], completed: unknown[], issues: unknown[] }>,
 *   sendData: (res: import('express').Response, data: unknown, req: import('express').Request) => void,
 *   sendError: (res: import('express').Response, error: unknown, req?: import('express').Request) => void,
 * }} deps
 */
export function registerRecoveryRoutes(app, deps) {
  const {
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
  } = deps
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
            const failure = makeError(`文件已移入回收站；历史归档失败且恢复原路径也失败。回收站 ID：${deleted.id}`, 'TRASH_ROLLBACK_FAILED')
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

}
