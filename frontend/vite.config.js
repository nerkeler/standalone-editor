import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function envPort(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const frontendPort = envPort('FRONTEND_PORT', 5558)
const backendPort = envPort('EDITOR_PORT', 5557)

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: frontendPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
})
