import fs from 'fs/promises'
import path from 'path'

// 判断路径是否在 workspace 内，防止路径穿越
function safePath(workspace, requestPath) {
  const base = path.resolve(workspace)
  const full = path.resolve(base, requestPath || '')
  if (!full.startsWith(base)) {
    throw new Error('路径超出工作空间')
  }
  return full
}

// 列出目录树（扁平列表，附带 type 和 path）
export async function listDir(workspace, reqPath = '') {
  const dir = safePath(workspace, reqPath)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue  // 过滤隐藏文件
    const relativePath = reqPath ? `${reqPath}/${entry.name}` : entry.name
    result.push({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      path: relativePath,
    })
  }
  // 文件夹排前面
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return result
}

// 读取文件内容
export async function readFile(workspace, reqPath) {
  const file = safePath(workspace, reqPath)
  const stat = await fs.stat(file)
  if (stat.isDirectory()) throw new Error('是目录不是文件')
  const content = await fs.readFile(file, 'utf-8')
  return { content }
}

export async function readFileBase64(workspace, reqPath) {
  const file = safePath(workspace, reqPath)
  const stat = await fs.stat(file)
  if (stat.isDirectory()) throw new Error('是目录不是文件')
  const ext = path.extname(reqPath).toLowerCase().slice(1)
  const mimeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    ico: 'image/x-icon', tiff: 'image/tiff',tif: 'image/tiff',
  }
  const mime = mimeMap[ext] || 'application/octet-stream'
  const buffer = await fs.readFile(file)
  return { mime, data: buffer.toString('base64'), name: path.basename(reqPath) }
}

// 创建文件或目录
export async function createItem(workspace, reqPath, type, name) {
  const targetDir = safePath(workspace, reqPath)
  const newPath = path.join(targetDir, name)
  if (type === 'dir') {
    await fs.mkdir(newPath, { recursive: true })
  } else {
    // 写一个空文件
    await fs.writeFile(newPath, '')
  }
  const relativePath = reqPath ? `${reqPath}/${name}` : name
  return { path: relativePath, type, name }
}

// 删除文件或目录
export async function deleteItem(workspace, reqPath) {
  const target = safePath(workspace, reqPath)
  const stat = await fs.stat(target)
  if (stat.isDirectory()) {
    await fs.rm(target, { recursive: true })
  } else {
    await fs.unlink(target)
  }
  return { success: true }
}

// 移动/重命名
export async function moveItem(workspace, oldPath, newPath) {
  const src = safePath(workspace, oldPath)
  const destDir = safePath(workspace, path.dirname(newPath))
  const dest = path.join(destDir, path.basename(newPath))
  await fs.rename(src, dest)
  return { success: true }
}

// 写入文件
export async function writeFile(workspace, reqPath, content) {
  const file = safePath(workspace, reqPath)
  await fs.writeFile(file, content, 'utf-8')
  return { success: true }
}

// 上传文件
export async function uploadFile(workspace, reqPath, file) {
  const targetDir = safePath(workspace, reqPath)
  const destPath = path.join(targetDir, file.originalname)
  await fs.writeFile(destPath, file.buffer)
  const relativePath = reqPath ? `${reqPath}/${file.originalname}` : file.originalname
  return { filename: file.originalname, path: relativePath }
}

// 列出所有文件树（用于判断是否为空工作空间）
export async function listAll(workspace) {
  const flat = []
  async function walk(dir, parent = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = parent ? `${parent}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relativePath)
      } else {
        flat.push({ name: entry.name, type: 'file', path: relativePath })
      }
    }
  }
  await walk(workspace)
  return flat
}
