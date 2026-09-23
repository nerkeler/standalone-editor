# 📝 独立在线编辑器

基于 TipTap 的轻量级 Markdown 富文本编辑器，支持选择本地目录作为工作空间，通过浏览器编辑本地文件。工作空间路径会保存在后端配置中，启动时会先校验当前目录身份。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js + Express |
| 前端 | Vite + React + TipTap |
| 文件格式 | Markdown |
| 自动保存 | 3 秒防抖自动保存 |

## 快速启动

### 1. 启动后端

```bash
cd backend
npm install
node src/index.js --workspace /path/to/your/notes
```

参数说明：
- `--workspace /path` — 指定工作空间根目录；省略时读取已保存配置，首次启动使用 `~/Documents/standalone-editor-notes`
- `PORT` / `HOST` — 后端端口和监听地址，默认 `5557` / `127.0.0.1`

### 2. 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端访问：http://127.0.0.1:5558

### 3. 一键启动（前后端）

```bash
bash start.sh /path/to/your/notes
```

省略路径时使用后端已保存的工作空间。`EDITOR_PORT`、`FRONTEND_PORT` 可分别修改前后端端口；脚本会等待两个服务健康后再报告启动成功，并在退出时回收它们。

## 项目结构

```
standalone-editor/
├── backend/
│   ├── package.json
│   ├── test/
│   │   ├── directoryPicker.test.js
│   │   └── fileService.test.js
│   └── src/
│       ├── index.js         # Express 服务入口
│       ├── directoryPicker.js # 跨平台目录选择路径规则
│       └── fileService.js    # 文件 CRUD 核心逻辑
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx           # 工作空间选择 + 编辑器切换
│       ├── pages/
│       │   ├── Welcome.jsx   # 目录选择页
│       │   ├── Editor.jsx    # TipTap 编辑器
│       │   └── Editor.css    # 移动端样式
│       └── styles/
│           └── global.css    # 全局主题变量
├── start.sh                  # 一键启动脚本
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
- [x] 浏览器记住当前工作目录，下次打开自动进入

### 文件管理
- [x] 文件树（树形结构）
- [x] 新建文件/文件夹
- [x] 重命名
- [x] 拖拽移动文件
- [x] 删除文件/文件夹（右键菜单）
- [x] 全部折叠/展开

### 界面
- [x] 亮色/暗色主题（跟随系统）
- [x] 深色模式手动切换（记住用户选择）
- [x] 编辑器内显示当前目录并提供醒目的更改目录按钮
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
| POST | `/api/upload/assets` | 上传图片到 `assets/`（兼容别名） |
| GET | `/api/workspace/assets/:filename` | 读取图片资源（使用 `workspaceId` / `workspaceVersion` query） |
| GET | `/api/workspace/search?q=...` | 搜索文件名和 Markdown 内容 |
| GET | `/api/workspace/export?path=...` | 导出 Markdown 文件 |
| POST | `/api/workspace/import` | 从 ZIP 导入 Markdown 和图片 |
| GET | `/api/dirs?path=...` | 浏览目录；返回平台路径、面包屑、父级、可选状态和真实 `roots` 入口 |

除 `/api/workspace/check`、`/api/workspace/set` 和目录浏览外，工作空间 API 需要 `X-Workspace-Id`，并建议同时发送 `X-Workspace-Version`。前端自动附带这些标识；图片 `<img>` URL 使用同名 query 参数，因为浏览器资源请求不能附加自定义请求头。

### 跨平台目录选择

目录选择器由后端主机决定路径规则。`/api/dirs` 返回 `platform`、当前 `path`、`parent`、`canGoUp`、`canSelect`、`breadcrumb`、`roots` 和 `entries`；条目和面包屑中的 `path` 都是完整的主机路径，前端应原样传回接口，不自行拼接 `/`、`\\` 或驱动器路径。Windows 的盘符根（例如 `C:\\`）和 UNC 根（例如 `\\\\server\\share\\`）也遵循同一规则。

可通过 `EDITOR_DIRECTORY_ROOTS`（别名 `DIRECTORY_ROOTS`）限制可选目录。POSIX 使用 `:` 分隔，Windows 使用 `;` 分隔；不存在、不可读或指向文件的配置会被忽略。白名单祖先目录可以浏览到允许根，但 `canSelect` 为 false；只有真实存在的根和可继续到允许根的目录会出现在列表中。未配置时，macOS 使用用户目录、`/Users`、`/Volumes` 等入口，Linux 使用用户目录和常见挂载点，Windows 使用用户目录、系统盘用户目录及实际存在的盘符。

## 测试

```bash
cd backend
npm test
cd ../frontend
npm run build
npm run test:interaction
```

交互回归测试需要本机安装 Chrome 或 Chromium（Node.js 需支持内置 WebSocket）；默认路径未检测到浏览器时，可设置 `CHROME_PATH` 指向浏览器可执行文件。测试会在临时目录中创建笔记工作区和浏览器配置，并使用临时回环端口启动前后端。
