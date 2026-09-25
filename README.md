# 📝 独立本地 Markdown 编辑器

基于 TipTap 的本地 Markdown 编辑器，支持选择本机目录作为工作空间，通过浏览器编辑本地文件。工作空间路径会保存在后端配置中，启动时会先校验当前目录身份。

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

省略路径时使用后端已保存的工作空间。若上次目录暂时不可访问，服务仍会启动，页面会显示原路径并提供重试或重新选择目录；不会自动改用默认目录。`EDITOR_PORT`、`FRONTEND_PORT` 可分别修改前后端端口；脚本会等待两个服务健康后再报告启动成功，并在退出时回收它们。

## 项目结构

```
standalone-editor/
├── backend/
│   ├── package.json
│   ├── test/
│   │   ├── directoryPicker.test.js
│   │   ├── fileService.test.js
│   │   ├── fileApi.test.js
│   │   ├── trashService.test.js
│   │   └── zipImportService.test.js
│   └── src/
│       ├── index.js         # Express 服务入口
│       ├── directoryPicker.js # 跨平台目录选择路径规则
│       ├── fileService.js    # 文件操作、版本历史
│       ├── trashService.js   # 可恢复删除
│       └── zipImportService.js # ZIP 内容验证和导入
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
- [x] 常用 Markdown 富文本编辑（TipTap；并非完整 Markdown 语法实现）
- [x] 标题、列表、任务列表、引用、代码块
- [x] 插入图片（支持拖拽上传、右键缩放）
- [x] 插入链接、插入表格
- [x] 3 秒防抖自动保存
- [x] 手动保存
- [x] 源码模式查看/编辑；含 YAML front matter、WikiLinks、缩进列表、原始 HTML 或带额外选项的代码围栏等语法的文档会默认以源码模式打开。主动切换到富文本模式前会提示：富文本模式不能完整保留所有 Markdown 语法和元数据；需要保留原文时请继续使用源码模式。
- [x] 标签页多文件编辑
- [x] 浏览器记住当前工作目录，下次打开自动进入
- [x] 保存冲突提示和逐文件版本历史
- [x] 逐条恢复或永久删除历史版本，并查看当前工作区恢复空间统计
- [x] 已删除文件的历史单独归档，可预览、恢复到指定路径或永久删除；同名新文件不会继承旧历史
- [x] 浏览器本地草稿快照和恢复选项

### 文件管理
- [x] 文件树（树形结构）
- [x] 新建文件/文件夹
- [x] 重命名
- [x] 拖拽移动文件
- [x] 将文件/文件夹移入回收站，并可查看和恢复
- [x] 逐条永久删除回收站项目，或手动清理已过期项目
- [x] 全部折叠/展开

### 文件类型与下载
- 只有普通文件名以 `.md` 或 `.markdown` 结尾的有效 UTF-8 文本可以进入 Markdown 编辑器；含非法 UTF-8 或 NUL 字节的文件不会作为文本打开或保存。
- 支持的图片文件会在图片预览器中显示。
- 其他普通文件会保留在文件树中，可重命名、移动或删除，但不会进入 Markdown 编辑、自动保存、历史版本或草稿恢复流程；可下载原始字节。
- FIFO、socket、块设备、字符设备等特殊文件不会显示在文件树中，也不能通过文本 API 读取或写入。

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
| GET | `/api/health` | 检查后端进程是否可响应；工作空间离线时仍返回成功 |
| GET | `/api/workspace/file?path=...` | 读取文件内容 |
| GET | `/api/workspace/file/history?path=...` | 查看该文件的版本历史 |
| POST | `/api/workspace/file/restore` | 安全恢复该文件的历史版本 |
| DELETE | `/api/workspace/file/history?path=...&id=...` | 永久删除该文件的一条历史版本 |
| GET | `/api/workspace/recovery/history` | 列出已删除文件的孤儿历史 |
| GET | `/api/workspace/recovery/history/content?orphanId=...&historyId=...` | 只读预览孤儿历史版本 |
| POST | `/api/workspace/recovery/history/restore` | 按目标文件版本安全恢复孤儿历史 |
| DELETE | `/api/workspace/recovery/history?id=...` | 永久删除一组孤儿历史 |
| POST | `/api/workspace` | 新建文件或目录 |
| PUT | `/api/workspace` | 写入文件 |
| DELETE | `/api/workspace?path=...` | 将文件或目录移入回收站 |
| GET | `/api/workspace/trash` | 列出工作空间的回收站项目 |
| POST | `/api/workspace/trash/restore` | 恢复回收站项目 |
| DELETE | `/api/workspace/trash?id=...` | 永久删除一条回收站项目 |
| POST | `/api/workspace/trash/purge-expired` | 手动永久清理已过期的回收站项目 |
| GET | `/api/workspace/recovery/stats` | 查看当前工作区历史版本、回收站和合计的项目数及存储字节数 |
| POST | `/api/workspace/move` | 移动/重命名 |
| POST | `/api/workspace/upload` | 上传文件 |
| POST | `/api/upload/assets` | 上传图片到 `assets/`（兼容别名） |
| GET | `/api/workspace/assets/:filename` | 读取图片资源（使用 `workspaceId` / `workspaceVersion` query） |
| GET | `/api/workspace/search?q=...` | 搜索文件名和 Markdown 内容 |
| GET | `/api/workspace/export?path=...` | 导出 Markdown 文件 |
| GET | `/api/workspace/download?path=...` | 下载普通文件的原始字节，不进行文本解码 |
| POST | `/api/workspace/import` | 从 ZIP 导入 Markdown 和图片 |
| GET | `/api/dirs?path=...` | 浏览目录；返回平台路径、面包屑、父级、可选状态和真实 `roots` 入口 |

除 `/api/workspace/check`、`/api/workspace/set` 和目录浏览外，工作空间 API 需要 `X-Workspace-Id`，并建议同时发送 `X-Workspace-Version`。前端自动附带这些标识；图片 `<img>` URL 使用同名 query 参数，因为浏览器资源请求不能附加自定义请求头。

`GET /api/workspace/download?path=...` 受工作空间身份和路径校验保护，以附件形式流式返回普通文件的原始字节；它不会像 Markdown `/export` 那样将内容解码为文本。即使某个 `.md` 文件因非法 UTF-8 无法编辑，也可以用此接口无损下载。

读取文件会返回按文件内容计算的 SHA-256 `revision`。保存和恢复版本必须提交 `expectedRevision`：缺少时返回 HTTP `428`；磁盘文件或工作空间已变化时返回 HTTP `409`，响应会携带冲突信息，客户端应先处理冲突再保存。对尚不存在的文件，`expectedRevision: null` 表示仅在目标仍不存在时创建。每个文件最多保留最近 50 个被替换的版本；历史版本保存在工作空间之外，默认位于 `~/.standalone-editor/recovery`，可用 `EDITOR_RECOVERY_DIR` 更改。

删除会把项目移到工作空间之外的回收站，目录内的内容一并保存；可在编辑器中列出并恢复。恢复时若原路径已有同名项目，会报告冲突，不会覆盖它。回收站项目默认保留 30 天并记录到期时间，但不会自动清理。只有用户在编辑器中主动选择并确认“清理过期项目”后，系统才会永久删除已过期项目；每条历史版本和回收站项目也可单独永久删除。以上永久删除操作都需要明确确认，删除后无法在编辑器中恢复；删除历史版本不会改动当前文档。

文件移入回收站后，其版本历史会从当前路径移到独立的孤儿历史管理入口；永久删除回收站副本不会自动删除这些历史。新建、移动、上传或 ZIP 导入的同名 Markdown 文件也不会继承旧文件的历史。恢复孤儿版本到现有文件时必须确认覆盖并提交当前 `revision`，若目标随后变化则返回冲突。恢复空间统计包含孤儿历史。外部程序在编辑器观察到变化前直接删除并重建同一路径时，由于文件没有持久身份标识，仍可能无法区分两代文件。

`GET /api/workspace/recovery/stats` 返回当前工作区的 `history`、`trash` 和 `total`，每项包含 `items`、`bytes`，并带有 `generatedAt`。字节数按该工作区恢复存储中当前文件的实际字节长度统计，包含历史记录、回收站内容及其元数据；它表示恢复数据当前落盘占用，不是工作区原文件的总大小。

未保存的编辑会定期保存在当前浏览器配置的本地存储中，重新打开工作空间时可以恢复。其他标签页遗留的草稿会作为独立恢复选项显示，不会自动覆盖当前草稿。浏览器草稿保留 7 天；浏览器清理站点数据、禁用本地存储或存储空间不足时，草稿恢复可能不可用。

### ZIP 导入范围

ZIP 导入会保留压缩包中的相对目录结构，并只导入 `.md` 和支持的图片（`.jpg`、`.jpeg`、`.png`、`.gif`、`.webp`、`.bmp`、`.svg`、`.ico`、`.tif`、`.tiff`）。隐藏路径和 `__MACOSX` 元数据会跳过；导入目标已存在时不会覆盖。单个压缩包最大 100 MiB，最多 5,000 个压缩包条目、1,000 个可导入文件；解压后单文件最多 50 MiB、合计最多 250 MiB，压缩率上限为 500:1。支持常规 ZIP 的存储和 Deflate 压缩；不支持 ZIP64、多卷、加密、符号链接或特殊文件。文件名须为 ASCII 或标记 UTF-8；旧式 CP437/GBK 文件名暂不支持。导入路径也会校验 Windows 保留名称及非法字符；目录选择器支持 Windows 盘符和 UNC 路径。

### 本地运行边界

后端默认只监听 `127.0.0.1`，直接读写用户选择的工作区；版本历史和回收站默认保存在本机 `~/.standalone-editor/recovery`（可用 `EDITOR_RECOVERY_DIR` 改变）。应用不提供账号认证或云端同步。不要把监听地址改为局域网或公网可访问的地址，也不要把它当作多用户服务部署。

### 跨平台目录选择

目录选择器由后端主机决定路径规则。`/api/dirs` 返回 `platform`、当前 `path`、`parent`、`canGoUp`、`canSelect`、`breadcrumb`、`roots` 和 `entries`；条目和面包屑中的 `path` 都是完整的主机路径，前端应原样传回接口，不自行拼接 `/`、`\\` 或驱动器路径。Windows 的盘符根（例如 `C:\\`）和 UNC 根（例如 `\\\\server\\share\\`）也遵循同一规则。

可通过 `EDITOR_DIRECTORY_ROOTS`（别名 `DIRECTORY_ROOTS`）限制可选目录。POSIX 使用 `:` 分隔，Windows 使用 `;` 分隔；不存在、不可读或指向文件的配置会被忽略。白名单祖先目录可以浏览到允许根，但 `canSelect` 为 false；只有真实存在的根和可继续到允许根的目录会出现在列表中。未配置时，macOS 使用用户目录、`/Users`、`/Volumes` 等入口，Linux 使用用户目录和常见挂载点，Windows 使用用户目录、系统盘用户目录及实际存在的盘符。

只有从未保存过工作区配置时，后端才会创建默认目录。已保存目录不可访问、配置损坏或恢复数据目录与工作区互相包含时，`/api/workspace/check` 会给出错误，文件 API 暂停；目录浏览和选择仍可使用。选择新目录前会校验恢复数据目录的位置，配置通过同目录临时文件原子替换，保存失败不会切换当前工作区。

## 测试

CI 在每次 push 和 pull request 时运行后端测试、前端构建和浏览器回归测试。浏览器任务使用 Node.js 22 和 `ubuntu-24.04` runner，通过 `command -v google-chrome` 检测 Chrome 并显式设置 `CHROME_PATH`；runner 未提供 Chrome 时会直接报告错误。可在本地复现：

```bash
cd backend
npm ci
npm test
cd ../frontend
npm ci
npm run build
npm run test:browser
```

浏览器回归测试覆盖编辑器保存、历史恢复、工作区校验和 Markdown 保真。浏览器测试需要 Chrome 或 Chromium，且 Node.js 需支持内置 WebSocket；本地默认路径未检测到浏览器时，可设置 `CHROME_PATH` 指向浏览器可执行文件。测试文件在 CI 中串行运行，每次运行都会用独立临时目录创建笔记工作区和 Chrome 配置，并为前后端及 Chrome DevTools 选择临时回环端口。
