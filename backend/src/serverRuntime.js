import { createHttpServer } from './httpServer.js'

export function formatBackendUrl(host, port) {
  const addressHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${addressHost}:${port}`
}

export async function startBackendServer(backend) {
  await backend.initialize()
  const server = createHttpServer(backend.app)
  let shuttingDown = false

  server.on('error', error => {
    console.error(`后端启动失败：${error.message}`)
    process.exitCode = 1
    if (server.listening) server.close()
  })

  server.listen(backend.port, backend.host, () => {
    console.log('✅ 编辑器后端已启动')
    const info = backend.currentWorkspaceInfo()
    if (info) console.log(`📁 工作空间：${info.workspace}`)
    else console.error('工作空间不可用：请重试或选择新的工作目录')
    console.log(`🌐 ${formatBackendUrl(backend.host, server.address()?.port ?? backend.port)}`)
  })

  function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`收到 ${signal}，正在停止后端…`)
    const forceClose = setTimeout(() => server.closeAllConnections?.(), 5000)
    forceClose.unref()
    server.close(error => {
      clearTimeout(forceClose)
      if (error) {
        console.error(`后端关闭失败：${error.message}`)
        process.exitCode = 1
      }
    })
  }

  const onInterrupt = () => shutdown('SIGINT')
  const onTerminate = () => shutdown('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  server.once('close', () => {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  })
  return server
}
