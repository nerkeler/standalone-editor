import { createServer } from 'node:http'

// Keep socket lifecycle separate from route registration so callers can mount
// the app in an isolated server or run the production listener explicitly.
export function createHttpServer(app) {
  return createServer(app)
}
