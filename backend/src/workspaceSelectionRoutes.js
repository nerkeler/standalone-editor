import fs from 'node:fs/promises'
import path from 'node:path'
import {
  breadcrumbFor,
  isDirectoryNavigable,
  parentPath,
  pathModuleFor,
  rootEntry,
} from './directoryPicker.js'

/**
 * Register the workspace bootstrap, selection, and directory-picker endpoints.
 * Mutable workspace state stays in the backend factory and is supplied through
 * callbacks, so separate app instances never share selection or config state.
 */
export function registerWorkspaceSelectionRoutes(app, {
  withWorkspaceSelection,
  currentWorkspaceInfo,
  workspaceIsSelected,
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
}) {
  app.get('/api/health', (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  app.get('/api/workspace/check', async (_req, res) => {
    try {
      const result = await withWorkspaceSelection(async () => {
        if (!workspaceIsSelected()) await reloadWorkspaceFromConfig()
        const info = currentWorkspaceInfo()
        await ensureCurrentWorkspaceAccessible(info.workspace)
        const hasFiles = await hasWorkspaceFiles(info.workspace)
        return { ...info, empty: !hasFiles }
      })
      setWorkspaceHeaders(res, result)
      res.json(result)
    } catch (error) {
      if (!workspaceIsSelected()) sendWorkspaceUnavailable(res, error)
      else sendError(res, error)
    }
  })

  app.post('/api/workspace/set', async (req, res) => {
    try {
      const result = await withWorkspaceSelection(async () => {
        const newPath = req.body?.path
        if (!newPath || typeof newPath !== 'string') {
          const error = new Error('缺少 path 参数')
          error.code = 'INVALID_DIRECTORY'
          throw error
        }
        return selectWorkspace(newPath)
      })
      setWorkspaceHeaders(res, result)
      res.json(result)
    } catch (error) { sendError(res, error) }
  })

  // GET /api/dirs — browse roots available to the workspace directory picker.
  app.get('/api/dirs', async (req, res) => {
    try {
      const requested = req.query.path || await defaultDirectoryPickerPath()
      const resolved = await canonicalDirectory(requested)
      const roots = await allowedDirectoryRoots()
      const canSelectDirectory = await directorySelectionPolicy(roots)
      // The picker needs filesystem roots and configured-root ancestors so
      // users can navigate to allowed directories.
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
          // open. Keep other entries useful if one item is stale.
          continue
        }
        if (stat.isSymbolicLink()) continue
        const canNavigate = stat.isDirectory()
          && isDirectoryNavigable(entryPath, roots, { platform: process.platform })
        // At a filesystem root or allow-list ancestor, hide directories that
        // cannot lead to an allowed location instead of showing dead ends.
        if (stat.isDirectory() && !canNavigate) continue
        if (stat.isDirectory()) {
          try {
            const mode = fs.constants.R_OK | (process.platform === 'win32' ? 0 : fs.constants.X_OK)
            await fs.access(entryPath, mode)
          } catch {
            // The picker follows the backend account's effective permissions.
            // A readable, read-only directory remains selectable.
            continue
          }
        }
        result.push({
          name: entry.name,
          type: stat.isDirectory() ? 'dir' : 'file',
          path: entryPath,
          parent: resolved,
          canNavigate,
          canSelect: stat.isDirectory() && canSelectDirectory(entryPath, roots),
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
        canSelect: canSelectDirectory(item.path, roots),
      }))
      const rootEntries = roots.map(root => ({
        ...rootEntry(root, process.platform),
        canSelect: canSelectDirectory(root, roots),
      }))
      const locationEntries = (await directoryPickerLocations(roots)).map(location => ({
        ...rootEntry(location, process.platform),
        canSelect: canSelectDirectory(location, roots),
      }))
      res.json({
        platform: process.platform,
        separator: pathModuleFor(process.platform).sep,
        path: resolved,
        parent: canGoUp ? parent : null,
        canGoUp,
        canSelect: canSelectDirectory(resolved, roots),
        breadcrumb: breadcrumbs,
        roots: rootEntries,
        locations: locationEntries,
        rootPaths: roots,
        entries: result,
      })
    } catch (error) { sendError(res, error) }
  })
}
