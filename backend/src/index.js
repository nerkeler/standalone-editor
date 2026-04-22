import express from 'express'
import cors from 'cors'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import {
  listDir,
  readFile,
  createItem,
  deleteItem,
  moveItem,
  writeFile,
  uploadFile,
  listAll,
} from './fileService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 从命令行参数读取工作空间目录
const args = process.argv.slice(2)
let workspaceIndex = args.indexOf('--workspace')
let workspace = workspaceIndex !== -1 && args[workspaceIndex + 1]
  ? path.resolve(args[workspaceIndex + 1])
  : null

// workspace 优先级：命令行 > 保存的配置 > /tmp/my-notes
if (!workspace) {
  const saved = await loadConfig()
  workspace = saved || '/tmp/my-notes'
}

const app = express()
const PORT = 5557
const CONFIG_FILE = path.join(__dirname, '../../workspace.json')

// 加载保存的工作空间配置
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8')
    const cfg = JSON.parse(data)
    if (cfg.workspace) {
      const stat = await fs.stat(cfg.workspace)
      if (stat.isDirectory()) return cfg.workspace
    }
  } catch {}
  return null
}

// 保存工作空间配置
async function saveConfig(ws) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify({ workspace: ws }), 'utf-8')
}

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// 解析 multipart（上传文件）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } })

// ---------- 路由 ----------

// GET /api/workspace — 列出根目录（或指定子目录）
app.get('/api/workspace', async (req, res) => {
  try {
    const reqPath = req.query.path || ''
    const files = await listDir(workspace, reqPath)
    res.json(files)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// GET /api/workspace/check — 检查工作空间是否有效、是否为空
app.get('/api/workspace/check', async (req, res) => {
  try {
    const files = await listAll(workspace)
    res.json({ workspace, empty: files.length === 0 })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})


// POST /api/workspace/set — 动态切换工作空间目录
app.post('/api/workspace/set', async (req, res) => {
  try {
    const { path: newPath } = req.body
    if (!newPath) return res.status(400).json({ error: '缺少 path 参数' })
    const resolved = path.resolve(newPath)
    const stat = await fs.stat(resolved)
    if (!stat.isDirectory()) return res.status(400).json({ error: '不是有效目录' })
    workspace = resolved
    await saveConfig(workspace)
    res.json({ workspace, success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// GET /api/dirs — 浏览服务器任意目录（只允许 /home 和 /tmp）
app.get('/api/dirs', async (req, res) => {
  try {
    const rawPath = req.query.path || '/'
    const resolved = path.resolve(rawPath)
    // 只允许浏览 /home 和 /tmp
    if (!resolved.startsWith('/home') && !resolved.startsWith('/tmp')) {
      return res.status(400).json({ error: '只能浏览 /home 和 /tmp 目录' })
    }
    const stat = await fs.stat(resolved)
    if (!stat.isDirectory()) return res.status(400).json({ error: '不是目录' })
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const result = []
    for (const entry of entries) {
      // 跳过 . 开头的隐藏文件
      if (entry.name.startsWith('.')) continue
      result.push({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        path: resolved,
      })
    }
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    res.json({ path: resolved, entries: result })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// GET /api/workspace/file — 读取文件内容
app.get('/api/workspace/file', async (req, res) => {
  try {
    const { path: reqPath } = req.query
    if (!reqPath) return res.status(400).json({ error: '缺少 path 参数' })
    const result = await readFile(workspace, reqPath)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// POST /api/workspace — 新建文件或目录
app.post('/api/workspace', async (req, res) => {
  try {
    const { path: reqPath, name, type } = req.body
    if (!name || !type) return res.status(400).json({ error: '缺少 name 或 type' })
    const result = await createItem(workspace, reqPath || '', type, name)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// PUT /api/workspace — 写入/更新文件
app.put('/api/workspace', async (req, res) => {
  try {
    const { path: reqPath, content } = req.body
    if (!reqPath) return res.status(400).json({ error: '缺少 path 参数' })
    await writeFile(workspace, reqPath, content)
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// DELETE /api/workspace — 删除文件或目录
app.delete('/api/workspace', async (req, res) => {
  try {
    const { path: reqPath } = req.query
    if (!reqPath) return res.status(400).json({ error: '缺少 path 参数' })
    await deleteItem(workspace, reqPath)
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// POST /api/workspace/move — 移动/重命名
app.post('/api/workspace/move', async (req, res) => {
  try {
    const { old_path, new_path } = req.body
    if (!old_path || !new_path) return res.status(400).json({ error: '缺少 old_path 或 new_path' })
    await moveItem(workspace, old_path, new_path)
    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// POST /api/workspace/upload — 上传文件
app.post('/api/workspace/upload', upload.single('file'), async (req, res) => {
  try {
    const { path: reqPath } = req.body
    if (!req.file) return res.status(400).json({ error: '缺少文件' })
    const result = await uploadFile(workspace, reqPath || '', req.file)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ---------- 静态资源（前端构建产物）----------
app.use(express.static(path.join(__dirname, '../../frontend/dist')))

app.listen(PORT, async () => {
  await saveConfig(workspace)
  console.log(`✅ 编辑器后端已启动`)
  console.log(`📁 工作空间：${workspace}`)
  console.log(`🌐 http://localhost:${PORT}`)
})
