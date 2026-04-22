# 📝 独立在线编辑器

基于 Stock Report 交易心得编辑器的独立版本，支持任意本地目录作为工作空间。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js + Express |
| 前端 | Vite + React + TipTap |
| 文件格式 | Markdown（支持图片、代码高亮、表格） |
| 自动保存 | 3 秒防抖自动保存 |

## 快速启动

### 1. 启动后端

```bash
cd backend
npm install
node src/index.js --workspace /path/to/your/notes
```

参数说明：
- `--workspace /path` — 指定工作空间根目录（必填）

### 2. 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端访问：http://localhost:5558

### 3. 一键启动（前后端）

```bash
# 终端1：后端
cd backend && node src/index.js --workspace /tmp/my-notes

# 终端2：前端
cd frontend && npm run dev
```

## 项目结构

```
standalone-editor/
├── backend/
│   ├── package.json
│   └── src/
│       ├── index.js         # Express 服务入口
│       └── fileService.js   # 文件 CRUD 核心逻辑
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx          # 工作空间选择 + 编辑器切换
│       ├── pages/
│       │   ├── Welcome.jsx  # 目录选择/创建页
│       │   ├── Editor.jsx   # TipTap 编辑器（核心）
│       │   └── Editor.css   # 移动端样式
│       └── styles/
│           └── global.css   # 全局主题变量
└── README.md
```

## 功能清单

### 编辑器
- [x] Markdown 富文本编辑（TipTap）
- [x] 标题、列表、任务列表、引用、代码块
- [x] 插入图片（支持拖拽上传、右键缩放）
- [x] 插入链接、插入表格
- [x] 3 秒防抖自动保存
- [x] 手动保存
- [x] 源码模式查看/编辑
- [x] 标签页多文件编辑

### 文件管理
- [x] 文件树（树形结构）
- [x] 新建文件/文件夹
- [x] 重命名
- [x] 拖拽移动文件
- [x] 删除文件/文件夹（右键菜单）
- [x] 全部折叠/展开

### 界面
- [x] 亮色/暗色主题（跟随系统）
- [x] 移动端适配（边距压缩、全屏编辑）
- [x] 响应式设计

## API 文档

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspace` | 列出目录文件 |
| GET | `/api/workspace/check` | 检查工作空间状态 |
| GET | `/api/workspace/file?path=...` | 读取文件内容 |
| POST | `/api/workspace` | 新建文件或目录 |
| PUT | `/api/workspace` | 写入文件 |
| DELETE | `/api/workspace?path=...` | 删除文件或目录 |
| POST | `/api/workspace/move` | 移动/重命名 |
| POST | `/api/workspace/upload` | 上传文件 |

## 与 Stock Report 的区别

| 功能 | Stock Report | 独立编辑器 |
|---|---|---|
| 工作空间 | 固定目录 | 启动时指定 |
| 股票搜索 | ✅ | ❌ |
| K线图 | ✅ | ❌ |
| 用户认证 | ✅ | ❌ |
| 编辑器 | 交易心得专用 | 通用 Markdown |
