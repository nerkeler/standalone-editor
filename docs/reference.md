# Standalone Editor 技术参考

[返回 README](../README.md)

这份文档保留接口、文件安全、导入范围与测试细节。

## API 文档

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspace` | 列出目录文件 |
| GET | `/api/workspace/check` | 检查工作空间状态 |
| POST | `/api/workspace/set` | 校验并切换工作空间，body 使用主机路径 `path` |
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
| POST | `/api/workspace/recovery/reconcile` | 检查当前工作区已记录的回收站中断操作，校验后恢复或保留并报告原因 |
| POST | `/api/workspace/move` | 移动/重命名 |
| POST | `/api/workspace/upload` | 上传文件；提交 Markdown 的 `documentPath` 时图片进入该文档同级 `assets/` |
| POST | `/api/upload/assets` | 兼容接口：上传图片到工作区根目录 `assets/` |
| GET | `/api/workspace/assets/:filename` | 读取图片资源（使用 `workspaceId` / `workspaceVersion` query） |
| GET | `/api/workspace/media/*` | 按工作区相对路径读取图片，供 Markdown 相对图片引用渲染 |
| GET | `/api/workspace/search?q=...` | 搜索文件名和 Markdown 内容 |
| GET | `/api/workspace/export?path=...` | 导出 Markdown 文件 |
| GET | `/api/workspace/download?path=...` | 下载普通文件的原始字节，不进行文本解码 |
| POST | `/api/workspace/import` | 从 ZIP 导入 Markdown 和图片 |
| GET | `/api/dirs?path=...` | 浏览目录；返回平台路径、面包屑、父级、可选状态和真实 `roots` 入口 |

除 `/api/workspace/check`、`/api/workspace/set` 和目录浏览外，工作空间 API 需要 `X-Workspace-Id`，并建议同时发送 `X-Workspace-Version`。前端自动附带这些标识；图片 `<img>` URL 使用同名 query 参数，因为浏览器资源请求不能附加自定义请求头。

Markdown 中的 `![图片](../images/a.png)` 相对当前文档目录解析。编辑器通过 `/api/workspace/upload` 上传图片时会提交 `documentPath`，图片保存在当前文档同级的 `assets/`，Markdown 保存相对路径。旧客户端可继续使用 `/api/upload/assets` 将图片上传到工作区根目录 `assets/`；旧版 `/api/workspace/assets/...` 图片引用仍可读取，并会在富文本编辑保存后转换为相对路径。外部图片 URL 保持原样；媒体接口只读取工作区内支持的图片类型，并拒绝符号链接路径。

`GET /api/workspace/download?path=...` 受工作空间身份和路径校验保护，以附件形式流式返回普通文件的原始字节；它不会像 Markdown `/export` 那样将内容解码为文本。即使某个 `.md` 文件因非法 UTF-8 无法编辑，也可以用此接口无损下载。

读取文件会返回按文件内容计算的 SHA-256 `revision`。保存和恢复版本必须提交 `expectedRevision`：缺少时返回 HTTP `428`；磁盘文件或工作空间已变化时返回 HTTP `409`，响应会携带冲突信息，客户端应先处理冲突再保存。对尚不存在的文件，`expectedRevision: null` 表示仅在目标仍不存在时创建。历史保留以最近 50 个被替换的版本为目标，在文档成功替换后执行清理；清理失败不改变保存成功结果，会保留额外记录并返回 `recoveryCleanupWarning`，后续内容发生变化的保存会重试。历史版本保存在工作空间之外，默认位于 `~/.standalone-editor/recovery`，可用 `EDITOR_RECOVERY_DIR` 更改。

删除会把项目移到工作空间之外的回收站，目录内的内容一并保存；可在编辑器中列出并恢复。恢复时若原路径已有同名项目，会报告冲突，不会覆盖它。回收站项目默认保留 30 天并记录到期时间，但不会自动清理。只有用户在编辑器中主动选择并确认“清理过期项目”后，系统才会永久删除已过期项目；每条历史版本和回收站项目也可单独永久删除。以上永久删除操作都需要明确确认，删除后无法在编辑器中恢复；删除历史版本不会改动当前文档。

文件移入回收站后，其版本历史会从当前路径移到独立的孤儿历史管理入口；永久删除回收站副本不会自动删除这些历史。新建、移动、上传或 ZIP 导入的同名 Markdown 文件也不会继承旧文件的历史。恢复孤儿版本到现有文件时必须确认覆盖并提交当前 `revision`，若目标随后变化则返回冲突。恢复空间统计包含孤儿历史。外部程序在编辑器观察到变化前直接删除并重建同一路径时，由于文件没有持久身份标识，仍可能无法区分两代文件。

`GET /api/workspace/recovery/stats` 返回当前工作区的 `history`、`trash` 和 `total`，每项包含 `items`、`bytes`，并带有 `generatedAt`。字节数按该工作区恢复存储中当前文件的实际字节长度统计，包含历史记录、回收站内容及其元数据；它表示恢复数据当前落盘占用，不是工作区原文件的总大小。

统计响应还包含 `maintenance.historyCleanupWarnings` 和 `maintenance.trash`，供界面展示历史清理提示及中断恢复结果。历史清理提示汇总保存在当前服务实例内存中，重启后不保留；错误同时写服务日志，恢复记录仍在磁盘。

跨卷移入回收站会在同卷隔离移动前持久化中断 journal。启动、重新选择工作区或调用 `POST /api/workspace/recovery/reconcile` 时，只检查可信记录中的路径；原路径空闲且身份、源内容与完整回收站副本一致时恢复原项目，回收站副本继续保留。路径占用、内容变化或校验失败时报告原因和保留位置，不覆盖已有内容。带 `pendingRecovery` 的回收站项目暂不可恢复、永久删除或过期清理，对应请求返回 `409/TRASH_OPERATION_PENDING`。同进程锁不提供跨进程文件锁保证；缺少 journal 的旧 `.trash-pending-*` 不会通过扫描猜测处理。

未保存的编辑会定期保存在当前浏览器配置的本地存储中，重新打开工作空间时可以恢复。其他标签页遗留的草稿会作为独立恢复选项显示，不会自动覆盖当前草稿。浏览器草稿保留 7 天；浏览器清理站点数据、禁用本地存储或存储空间不足时，草稿恢复可能不可用，界面会显示本地恢复受影响的提示。工作区缓存只用于启动上下文；后端校验失败仍按真实服务端错误显示，本地缓存读写失败不会阻止服务端自动保存。

### ZIP 导入范围

ZIP 导入会保留压缩包中的相对目录结构，并只导入 `.md` 和支持的图片（`.jpg`、`.jpeg`、`.png`、`.gif`、`.webp`、`.bmp`、`.svg`、`.ico`、`.tif`、`.tiff`）。隐藏路径和 `__MACOSX` 元数据会跳过；导入目标已存在时不会覆盖。单个压缩包最大 100 MiB，最多 5,000 个压缩包条目、1,000 个可导入文件；解压后单文件最多 50 MiB、合计最多 250 MiB，压缩率上限为 500:1。支持常规 ZIP 的存储和 Deflate 压缩；不支持 ZIP64、多卷、加密、符号链接或特殊文件。文件名须为 ASCII 或标记 UTF-8；旧式 CP437/GBK 文件名暂不支持。导入路径也会校验 Windows 保留名称及非法字符；目录选择器支持 Windows 盘符和 UNC 路径。

### 本地运行边界

后端默认只监听 `127.0.0.1`，直接读写用户选择的工作区；版本历史和回收站默认保存在本机 `~/.standalone-editor/recovery`（可用 `EDITOR_RECOVERY_DIR` 改变）。应用不提供账号认证或云端同步。当前适用于本机使用；如需在可信局域网临时使用，必须由使用者控制网络边界和服务生命周期。不要向非可信网络或公网开放，也不要把它当作多用户服务部署。

前端经 Vite 或反向代理以同一访问地址调用 `/api` 时，代理须保留浏览器请求的完整 `Host`（包括非标准端口）；后端会将 `Origin` 与该主机匹配，无需写死某个 IP 或域名。Vite 默认接受 IP 和 localhost；使用自定义域名运行 Vite 时，以 `FRONTEND_ALLOWED_HOSTS=editor.example.com` 配置允许的主机名（多个名称用逗号分隔）。前后端分属不同来源时，可用 `CORS_ORIGINS`（或 `EDITOR_CORS_ORIGINS`）配置逗号分隔的完整来源，例如 `https://editor.example.com`。CORS 只约束浏览器请求，不是身份认证。未经认证时，仅应在可信网络内开放服务。

### 跨平台目录选择

目录选择器由后端主机决定路径规则。`/api/dirs` 返回 `platform`、当前 `path`、`parent`、`canGoUp`、`canSelect`、`breadcrumb`、受策略限制的 `roots`、便于快速跳转的 `locations` 和 `entries`；条目和面包屑中的 `path` 都是完整的主机路径，前端应原样传回接口，不自行拼接 `/`、`\\` 或驱动器路径。Windows 的盘符根（例如 `C:\\`）和 UNC 根（例如 `\\\\server\\share\\`）也遵循同一规则。

可通过 `EDITOR_DIRECTORY_ROOTS`（别名 `DIRECTORY_ROOTS`）限制可选目录。POSIX 使用 `:` 分隔，Windows 使用 `;` 分隔；不存在、不可读或指向文件的配置会被忽略。白名单祖先目录可以浏览到允许根，但 `canSelect` 为 false；只有真实存在的根和可继续到允许根的目录会出现在列表中。

未配置 roots 时，macOS 和 Linux 都从 `/` 浏览；目录项按后端运行账号实际的读和进入权限显示，直接访问无权限目录会返回 `403/PERMISSION_DENIED`。可读但只读的目录仍可作为工作区，保存等写操作由操作系统权限决定，失败时返回 `403/PERMISSION_DENIED`。Windows 继续使用现有盘符和 UNC 路径规则。`canSelect` 与设置工作区共用恢复数据目录的嵌套约束：例如默认 recovery 位于 `/` 内，因此 `/` 会显示为不可选并由设置接口以恢复目录冲突原因拒绝。显式 roots 是可选的管理员范围限制，不会覆盖操作系统本身的权限检查。

只有从未保存过工作区配置时，后端才会创建默认目录。已保存目录不可访问、配置损坏或恢复数据目录与工作区互相包含时，`/api/workspace/check` 会给出错误，文件 API 暂停；目录浏览和选择仍可使用。选择新目录前会校验恢复数据目录的位置，配置通过同目录临时文件原子替换，保存失败不会切换当前工作区。

## 测试

CI 在每次 push 和 pull request 时于 Ubuntu、Windows 和 macOS 运行后端测试，并于 Ubuntu 运行前端单元测试、构建、生产 smoke 和浏览器回归测试。CI 固定使用 Node.js 22.22.3；项目支持 Node.js 22.x 的 22.17.0 或更高版本。浏览器任务运行在 `ubuntu-24.04` runner，通过 `command -v google-chrome` 检测 Chrome 并显式设置 `CHROME_PATH`；runner 未提供 Chrome 时会直接报告错误。可在本地复现：

```bash
cd backend
npm ci
npm test
cd ../frontend
npm ci
npm run test:unit
npm run build
npm run test:browser
npm run test:production-smoke
```

Vite 浏览器回归测试覆盖编辑器保存、历史恢复、工作区校验、Markdown 富文本支持边界和图片相对路径。`test:production-smoke` 则只启动后端，从 `frontend/dist` 打开构建产物并验证三秒保存、相对图片读取和附件原字节下载，不依赖 Vite。浏览器测试需要 Chrome 或 Chromium，且 Node.js 需支持内置 WebSocket；本地默认路径未检测到浏览器时，可设置 `CHROME_PATH` 指向浏览器可执行文件。测试文件在 CI 中串行运行，每次运行都会用独立临时目录创建笔记工作区和 Chrome 配置，并为前后端及 Chrome DevTools 选择临时回环端口。依赖维护和支持版本见[前端依赖维护记录](dependency-maintenance.md)；构建产物和服务生命周期见[运行、更新与回退说明](release-runtime.md)。
