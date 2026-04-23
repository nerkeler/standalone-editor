import React, { useState, useEffect, useCallback } from 'react'
import { Button, message, Modal, Breadcrumb, Spin } from 'antd'
import { FolderOpenOutlined, EditOutlined, HomeOutlined, ArrowLeftOutlined, LoadingOutlined } from '@ant-design/icons'
import axios from 'axios'

const DIRS_API = '/api/dirs'
const WS_API = '/api/workspace'

export default function Welcome({ onEnter }) {
  const [currentWorkspace, setCurrentWorkspace] = useState('')
  const [loading, setLoading] = useState(true)
  const [pickerVisible, setPickerVisible] = useState(false)
  const [pickerPath, setPickerPath] = useState('/home')
  const [pickerEntries, setPickerEntries] = useState([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // 先尝试从 localStorage 恢复上次的工作目录
    const saved = localStorage.getItem('editor_workspace')
    if (saved) {
      setCurrentWorkspace(saved)
      setLoading(false)
      return
    }
    // 没有缓存再请求后端
    axios.get(`${WS_API}/check`)
      .then(res => {
        const ws = res.data.workspace
        setCurrentWorkspace(ws)
        localStorage.setItem('editor_workspace', ws)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const loadPickerDir = useCallback((dir) => {
    console.log('[DEBUG loadPickerDir] dir =', dir)
    setError('')
    setPickerLoading(true)
    setPickerPath(dir)
    axios.get(`${DIRS_API}?path=${encodeURIComponent(dir)}`)
      .then(res => {
        console.log('[DEBUG loadPickerDir] got entries:', res.data.entries?.length, res.data.entries?.map(e => e.name))
        setPickerEntries(res.data.entries || [])
        setPickerLoading(false)
      })
      .catch(err => {
        console.error('[DEBUG loadPickerDir] error:', err)
        setError(String(err.response?.data?.error || err.message || 'unknown error'))
        setPickerEntries([])
        setPickerLoading(false)
      })
  }, [])

  const openPicker = () => {
    console.log('[DEBUG openPicker]')
    setPickerPath('/home')
    setPickerEntries([])
    setPickerVisible(true)
    loadPickerDir('/home')
  }

  const enterDir = (entry) => {
    console.log('[DEBUG enterDir] entry =', entry)
    if (entry.type !== 'dir') {
      console.log('[DEBUG enterDir] not a dir, skipping')
      return
    }
    const fullPath = `${entry.path}/${entry.name}`
    console.log('[DEBUG enterDir] fullPath =', fullPath)
    loadPickerDir(fullPath)
  }

  const goUp = () => {
    const parts = pickerPath.split('/').filter(Boolean)
    const parent = parts.slice(0, -1).join('/')
    const newPath = parent ? `/${parent}` : '/'
    loadPickerDir(newPath)
  }

  const confirmSelection = () => {
    console.log('[DEBUG confirmSelection] pickerPath =', pickerPath)
    setPickerLoading(true)
    axios.post(`${WS_API}/set`, { path: pickerPath })
      .then(res => {
        console.log('[DEBUG confirmSelection] success:', res.data)
        const ws = res.data.workspace
        setCurrentWorkspace(ws)
        localStorage.setItem('editor_workspace', ws)
        setPickerVisible(false)
        message.success(`已切换到：${ws}`)
        onEnter(ws)
      })
      .catch(err => {
        console.error('[DEBUG confirmSelection] error:', err)
        message.error(err.response?.data?.error || '切换目录失败')
        setPickerLoading(false)
      })
  }

  const pathParts = pickerPath.split('/').filter(Boolean)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100vh', gap: 32, padding: 24,
    }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>📝 在线编辑器</h1>

      <div style={{
        background: 'var(--color-bg-card)', borderRadius: 16,
        padding: '32px 40px', boxShadow: 'var(--shadow-lg)',
        display: 'flex', flexDirection: 'column', gap: 20, minWidth: 380,
      }}>
        {loading ? (
          <Spin indicator={<LoadingOutlined spin />} />
        ) : (
          <>
            <div style={{
              background: 'rgba(0,0,0,0.04)', borderRadius: 10,
              padding: '12px 16px', fontSize: 13,
              color: 'var(--color-text-secondary)',
              wordBreak: 'break-all',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                当前工作目录
              </div>
              <div style={{ fontWeight: 600, fontFamily: 'monospace' }}>
                {currentWorkspace || '/tmp/my-notes'}
              </div>
            </div>

            <Button
              size="large"
              icon={<FolderOpenOutlined />}
              onClick={openPicker}
              block
              style={{ height: 52, borderRadius: 10, fontSize: 15 }}
            >
              选择工作目录
            </Button>

            <Button
              size="large"
              icon={<EditOutlined />}
              onClick={() => onEnter(currentWorkspace)}
              block
              style={{ height: 52, borderRadius: 10, fontSize: 15 }}
            >
              打开当前目录
            </Button>
          </>
        )}
      </div>

      {/* 目录选择器弹窗 */}
      <Modal
        title="选择工作目录"
        open={pickerVisible}
        onCancel={() => setPickerVisible(false)}
        onOk={confirmSelection}
        okText="确认选择"
        cancelText="取消"
        width={560}
      >
        {/* 调试信息 */}
        <div style={{ padding: '6px 8px', fontSize: 11, color: '#f5222d', background: '#fffbe6', borderRadius: 4, marginBottom: 8, fontFamily: 'monospace' }}>
          🔍 path={pickerPath} | entries={pickerEntries.length} | loading={String(pickerLoading)}
          {error && <div style={{ color: '#f5222d', marginTop: 4 }}>❌ error: {error}</div>}
        </div>

        {/* 面包屑 + 返回按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Button size="small" icon={<ArrowLeftOutlined />} onClick={goUp} disabled={pickerPath === '/'}>返回</Button>
          <Breadcrumb
            separator="/"
            items={[
              { key: '/', title: <a onClick={() => loadPickerDir('/')}><HomeOutlined /> 根目录</a> },
              ...pathParts.map((part, i) => ({
                key: i,
                title: (
                  <a
                    style={{ fontWeight: i === pathParts.length - 1 ? 700 : 400 }}
                    onClick={() => loadPickerDir('/' + pathParts.slice(0, i + 1).join('/'))}
                  >
                    {part}
                  </a>
                ),
              })),
            ]}
          />
        </div>

        {/* 目录列表 */}
        <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 8, padding: '4px 0' }}>
          {pickerLoading ? (
            <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
          ) : pickerEntries.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 32, color: '#999' }}>空目录</div>
          ) : (
            pickerEntries.map(entry => (
              <div
                key={entry.name}
                onClick={() => enterDir(entry)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 12px', cursor: 'pointer',
                  fontSize: 14,
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#f5f5f5'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <FolderOpenOutlined style={{ color: entry.type === 'dir' ? '#faad14' : '#999', fontSize: 18 }} />
                <span style={{ flex: 1, color: 'var(--color-text)' }}>{entry.name}</span>
                {entry.type === 'file' && <span style={{ fontSize: 11, color: '#ccc' }}>文件</span>}
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  )
}
