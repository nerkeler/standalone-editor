// @ts-check
import path from 'path'
import { pipeline } from 'node:stream/promises'
import { openBinaryFile } from './fileService.js'
import { errorStatus } from './serverErrors.js'

/**
 * Streaming routes for Markdown image references and adjacent assets. These
 * reuse the file service's MIME allowlist, workspace boundary checks and
 * symlink rejection, and accept the workspace identity via query string
 * because <img> elements cannot attach custom headers.
 *
 * @param {import('express').Express} app
 * @param {{
 *   workspaceGuard: import('express').RequestHandler,
 *   workspaceFor: (req: unknown) => string,
 *   workspaceInfoFor: (req: unknown) => unknown,
 *   setWorkspaceHeaders: (res: import('express').Response, info?: unknown) => unknown,
 *   sendError: (res: import('express').Response, error: unknown, req?: import('express').Request) => void,
 * }} deps
 */
export function registerMediaRoutes(app, deps) {
  const {
    workspaceGuard,
    workspaceFor,
    workspaceInfoFor,
    setWorkspaceHeaders,
    sendError,
  } = deps

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
}
