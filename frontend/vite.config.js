import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function envPort(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const frontendPort = envPort('FRONTEND_PORT', 5558)
const backendPort = envPort('EDITOR_PORT', 5557)
const allowedHosts = (process.env.FRONTEND_ALLOWED_HOSTS || '')
  .split(',').map(host => host.trim()).filter(Boolean)

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Both editing engines load lazily. Prebundle their history entry points
    // so opening source mode does not trigger a dependency-discovery reload.
    include: ['@tiptap/core', '@tiptap/pm/state', '@tiptap/pm/history', '@codemirror/commands'],
  },
  server: {
    host: '127.0.0.1',
    port: frontendPort,
    strictPort: true,
    allowedHosts,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        // Preserve the browser-facing Host so the backend can validate the
        // same-origin request even when accessed by a LAN IP or domain.
        changeOrigin: false,
      },
    },
  },
})
