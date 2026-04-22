import React, { useState, useEffect } from 'react'
import { Button, message, Modal, Breadcrumb, Spin } from 'antd'
import { FolderOpenOutlined, EditOutlined, HomeOutlined, ArrowLeftOutlined, LoadingOutlined } from '@ant-design/icons'
import axios from 'axios'

const API = '/api'
const DIRS_API = '/api/dirs'
const WS_API = '/api/workspace'

export default function Welcome({ onEnter }) {
  const [currentWorkspace, setCurrentWorkspace] = useState('')
  const [loading, setLoading] = useState(true)
  const [pickerVisible, setPickerVisible] = useState(false)
  const [pickerPath, setPickerPath] = useState('/home')
  const [pickerEntries, setPickerEntries] = useState([])
  const [pickerLoading, setPickerLoading] = useState(false)

  useEffect(() => {
    // 加载当前工作空间
    axios.get(`${WS_API}/check`)
      .then(res => {
        setCurrentWorkspace(res.data.workspace)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // 打开目录选择器
  const openPicker = () => {
    setPickerPath('/home')
    setPickerEntries([])
    setPickerVisible(true)
    // loadPickerDir is called by afterOpenChange
  }

  // 加载目录内容
  const loadPickerDir = (dir) => {
    setPickerLoading(true)
    setPickerPath(dir)
    axios.get(`${DIRS_API}?path=${encodeURIComponent(dir)}`)
      .then(res => {
        setPickerEntries(res.data.entries || [])
        setPickerLoading(false)
      })
      .catch(err => {
        message.error(err.response?.data?.error || '无法读取目录')
        setPickerLoading(false)
      })
  }

  // 进入目录
  const enterDir = (entry) => {
    if (entry.type !== 'dir') return
    // 构造完整路径
    const base = entry.path === '/' ? '' : entry.path
    const fullPath = base ? `${base}/${entry.name}` : `/${entry.name}`
    setPickerLoading(true)
    axios.get(`${DIRS_API}?path=${encodeURIComponent(fullPath)}`)
      .then(res => {
        setPickerEntries(res.data.entries || [])
        setPickerPath(fullPath)
        setPickerLoading(false)
      })
      .catch(err => {
        message.error(err.response?.data?.error || '无法打开目录')
        setPickerLoading(false)
      })
  }

  // 确认选择
  const confirmSelection = () => {
    setPickerLoading(true)
    axios.post(`${WS_API}/set`, { path: pickerPath })
      .then(res => {
        setCurrentWorkspace(res.data.workspace)
        setPickerVisible(false)
        message.success(`已切换到：${res.data.workspace}`)
        onEnter(res.data.workspace)
      })
      .catch(err => {
        message.error(err.response?.data?.error || '切换目录失败')
        setPickerLoading(false)
      })
  }

  // 返回上级
  const goUp = () => {
    const parent = pickerPath.split('/').filter(Boolean).slice(0, -1).join('/')
    loadPickerDir(parent ? `/${parent}` : '/')
  }

  // 路径切片
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
            {/* 当前工作目录 */}
            <div style={{
              background: 'rgba(0,0,0,0.04)', borderRadius: 10,
              padding: '12px 16px', fontSize: 13,
              color: 'var(--color-text-secondary)',
              wordBreak: 'break-all',
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>
                当前工作目录
              </div>
              <div style={{ fontWeight: 600, color: 'var(--color-text)', fontFamily: 'monospace' }}>
                {currentWorkspace || '/tmp/my-notes'}
              </div>
            </div>

            {/* 操作按钮 */}
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
              onClick={() => { onEnter(currentWorkspace) }}
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
        bodyStyle={{ padding: '8px 12px' }}
        afterOpenChange={open => { if (open) { setPickerPath('/home'); setPickerEntries([]); loadPickerDir('/home') } }}
      >
        {/* 面包屑导航 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 0', fontSize: 13, flexWrap: 'wrap', marginBottom: 8,
          borderBottom: '1px solid var(--color-border)',
        }}>
          {pathParts.length > 0 && (
            <ArrowLeftOutlined
              onClick={goUp}
              style={{ cursor: 'pointer', marginRight: 4 }}
            />
          )}
          <Breadcrumb
            separator="/"
            items={[
              { key: '/', title: <HomeOutlined onClick={() => loadPickerDir('/')} style={{ cursor: 'pointer' }} /> },
              ...pathParts.map((part, i) => ({
                key: '/' + pathParts.slice(0, i + 1).join('/'),
                title: (
                  <span
                    style={{ cursor: 'pointer', fontWeight: i === pathParts.length - 1 ? 600 : 400 }}
                    onClick={() => loadPickerDir('/' + pathParts.slice(0, i + 1).join('/'))}
                  >
                    {part}
                  </span>
                ),
              })),
            ]}
          />
        </div>

        {/* 目录列表 */}
        <div style={{ maxHeight: 340, overflowY: 'auto' }}>
          {pickerLoading ? (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <Spin />
            </div>
          ) : (
            pickerEntries.map(entry => (
              <div
                key={entry.name}
                onClick={() => enterDir(entry)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '9px 8px', borderRadius: 6, cursor: 'pointer',
                  fontSize: 14,
                  background: entry.type === 'dir' ? 'rgba(0,0,0,0.03)' : 'transparent',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.07)'}
                onMouseLeave={e => e.currentTarget.style.background = entry.type === 'dir' ? 'rgba(0,0,0,0.03)' : 'transparent'}
              >
                <FolderOpenOutlined style={{ color: entry.type === 'dir' ? '#faad14' : '#999', fontSize: 16 }} />
                <span style={{ color: 'var(--color-text)' }}>{entry.name}</span>
                {entry.type === 'file' && (
                  <span style={{ fontSize: 11, color: '#ccc', marginLeft: 4 }}>文件</span>
                )}
              </div>
            ))
          )}
          {!pickerLoading && pickerEntries.length === 0 && (
            <div style={{ textAlign: 'center', padding: 32, color: '#999' }}>空目录</div>
          )}
        </div>
      </Modal>
    </div>
  )
}
