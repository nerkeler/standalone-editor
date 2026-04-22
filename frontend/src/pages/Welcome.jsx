import React, { useState, useRef } from 'react'
import { Button, Input, message } from 'antd'
import { FolderOpenOutlined, EditOutlined } from '@ant-design/icons'
import axios from 'axios'

const API = '/api/workspace'

export default function Welcome({ onEnter }) {
  const [inputPath, setInputPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState('picker') // 'picker' | 'manual'
  const dirInputRef = useRef(null)

  const handleSelectFolder = async (dir) => {
    setLoading(true)
    try {
      const res = await axios.get(`${API}/check`)
      onEnter(res.data.workspace)
    } catch {
      message.error('无法访问该目录，请确认路径存在且有权限')
    } finally {
      setLoading(false)
    }
  }

  const handlePickDirectory = () => {
    // 使用隐藏的 file input（webkitdirectory）选择文件夹
    if (!dirInputRef.current) return
    dirInputRef.current.click()
  }

  const handleFileChange = async (e) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    // 取第一个文件的路径（Chrome 会给出完整路径）
    const file = files[0]
    // 文件的 path 在 Chrome 中包含完整目录路径
    const fullPath = file.webkitRelativePath || file.name
    const dirPath = fullPath.split('/')[0]

    if (!dirPath) {
      message.error('无法识别目录路径，请尝试手动输入')
      setMode('manual')
      return
    }

    setLoading(true)
    try {
      const res = await axios.get(`${API}/check`)
      onEnter(res.data.workspace)
    } catch {
      // fallback: 直接使用路径
      onEnter('/' + dirPath)
    } finally {
      setLoading(false)
      e.target.value = ''
    }
  }

  const handleManualOpen = async () => {
    const dir = inputPath.trim()
    if (!dir) { message.warning('请输入目录路径'); return }
    setLoading(true)
    try {
      onEnter(dir)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100vh', gap: 32, padding: 24,
    }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-text)' }}>📝 在线编辑器</h1>

      <div style={{
        background: 'var(--color-bg-card)', borderRadius: 16,
        padding: '32px 40px', boxShadow: 'var(--shadow-lg)',
        display: 'flex', flexDirection: 'column', gap: 20, minWidth: 340,
      }}>
        {/* 模式切换 */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <Button
            type={mode === 'picker' ? 'primary' : 'default'}
            icon={<FolderOpenOutlined />}
            onClick={() => setMode('picker')}
            style={{ borderRadius: 8 }}
          >
            选择目录
          </Button>
          <Button
            type={mode === 'manual' ? 'primary' : 'default'}
            icon={<EditOutlined />}
            onClick={() => setMode('manual')}
            style={{ borderRadius: 8 }}
          >
            手动输入
          </Button>
        </div>

        {mode === 'picker' ? (
          <>
            {/* 目录选择器 */}
            <div
              onClick={handlePickDirectory}
              style={{
                border: '2px dashed var(--color-border)',
                borderRadius: 12,
                padding: '40px 24px',
                textAlign: 'center',
                cursor: 'pointer',
                transition: 'all 0.2s',
                background: 'rgba(0,0,0,0.02)',
              }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'var(--color-primary)'
                e.currentTarget.style.background = 'rgba(26,115,232,0.05)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--color-border)'
                e.currentTarget.style.background = 'rgba(0,0,0,0.02)'
              }}
            >
              <FolderOpenOutlined style={{ fontSize: 40, color: 'var(--color-primary)', marginBottom: 12, display: 'block' }} />
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)', marginBottom: 4 }}>
                点击选择本地文件夹
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                建议选择空目录，方便管理笔记
              </div>
            </div>

            {/* 隐藏的目录选择 input */}
            <input
              ref={dirInputRef}
              type="file"
              // @ts-ignore
              webkitdirectory="true"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />

            {/* 使用后端指定目录 */}
            <Button
              block
              loading={loading}
              onClick={() => handleSelectFolder()}
              style={{ height: 44, borderRadius: 8 }}
            >
              使用后端配置的目录
            </Button>
          </>
        ) : (
          <>
            <Input
              placeholder="/home/user/my-notes"
              value={inputPath}
              onChange={e => setInputPath(e.target.value)}
              onPressEnter={handleManualOpen}
              size="large"
              style={{ borderRadius: 8 }}
              prefix={<FolderOpenOutlined style={{ color: 'var(--color-text-secondary)' }} />}
            />
            <Button
              type="primary"
              size="large"
              loading={loading}
              onClick={handleManualOpen}
              block
              style={{ height: 44, borderRadius: 8 }}
            >
              打开目录
            </Button>
          </>
        )}
      </div>

      <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'center' }}>
        启动后端：<code style={{ background: 'rgba(0,0,0,0.08)', padding: '2px 6px', borderRadius: 4 }}>node src/index.js --workspace /path/to/dir</code>
      </p>
    </div>
  )
}
