import { Button, Tooltip } from 'antd'
import { MoonOutlined, SunOutlined } from '@ant-design/icons'

export default function ThemeToggle({ theme, onToggle }) {
  const dark = theme === 'dark'
  return (
    <Tooltip title={dark ? '切换到浅色模式' : '切换到深色模式'}>
      <Button
        className="theme-toggle"
        type="text"
        shape="circle"
        aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}
        onClick={onToggle}
        icon={dark ? <SunOutlined /> : <MoonOutlined />}
      />
    </Tooltip>
  )
}
