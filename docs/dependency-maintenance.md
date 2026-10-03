# 前端依赖维护

此记录先对应 2026-10-01 的前端锁文件更新，后补充 2026-10-02 的跨平台 CI 稳定化和 2026-10-03 的 Actions runtime 维护。前后端当前支持 Node.js `22.17.0` 或更高版本，范围限定在 `22.x`（`>=22.17.0 <23.0.0`）。Vite 7 本身支持从 Node.js 22.12 开始的 22.x；项目要求提高到 22.17，是因为 [Node.js 22.17.0 LTS](https://nodejs.org/en/blog/release/v22.17.0) 更新至 libuv 1.51.0，而 [libuv 1.51.0 变更记录](https://github.com/libuv/libuv/blob/v1.51.0/ChangeLog)包含 Windows 文件系统卷序列号一致性修复。这个修复让同一文件的路径 `lstat` 与文件句柄 `fstat` 能提供一致的设备身份，避免合法保存被误判为文件变化。[Vite 7 发布说明](https://vite.dev/blog/announcing-vite7)

## 本次更新

| 依赖 | 更新前 | 当前范围 | 处理 |
|---|---:|---:|---|
| `@tiptap/*` 编辑器扩展、React 绑定与 StarterKit | `2.27.2` | `^3.31.4` | 同步升至 v3；把表格行、单元格和表头改为 `@tiptap/extension-table` 的导出。 |
| `axios` | `1.15.2` | `^1.20.0` | 升级到包含后续修复的常规版本。[Axios 1.20.0 发布说明](https://github.com/axios/axios/releases/tag/v1.20.0) |
| `vite` | `5.4.21` | `^7.3.6` | 升级到仍受支持的 7.3 系列；没有直接跳到新的主版本。[Vite 支持版本](https://vite.dev/releases) |
| `@vitejs/plugin-react` | `4.7.0` | `^5.2.0` | 与 Vite 7 配套升级。 |

Tiptap v3 是主版本迁移。StarterKit 现在包含 Link 和 Underline，所以本项目继续在配置中关闭这两项，再注册独立的 Link 扩展；设置文档内容时显式使用 `setContent(content, { emitUpdate: false })`，避免读盘操作变成编辑。表格子扩展现由 `@tiptap/extension-table` 导出。后续 Tiptap 更新应参考[官方 v2 到 v3 迁移指南](https://tiptap.dev/docs/guides/upgrade-tiptap-v2)。本次也处理了该项目原先使用的 Tiptap 版本范围涉及的[官方安全公告](https://github.com/ueberdosis/tiptap/security/advisories/GHSA-cp6q-959q-f8rh)。

直接依赖更新后，npm 审计还报告了传递依赖问题：`@babel/core`、`baseline-browser-mapping`、Browserslist、`postcss` 和 `nanoid`。通过普通的 `npm audit fix` 在现有 semver 范围内更新这些传递依赖，没有使用 `--force` 或 `--legacy-peer-deps`。最终锁文件实际解析为 `@babel/core 7.29.7`、`baseline-browser-mapping 2.11.26`、Browserslist `4.29.3`、`postcss 8.5.28` 和 `nanoid 3.3.19`。这些版本高于审计时对应公告的受影响范围：[Babel](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8)、[Baseline browser mapping](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv)、[Browserslist](https://github.com/advisories/GHSA-c83g-rgw3-j3cx)、[PostCSS](https://github.com/advisories/GHSA-6g55-p6wh-862q)、[nanoid](https://github.com/advisories/GHSA-28wg-ghj8-5hjv)。

完成更新后，`npm audit` 对当前前端依赖树报告 **0 个漏洞**。该结果描述本次锁文件和审计时间，不代表后续依赖版本不会出现新公告。

## 维护步骤

从 `frontend/` 目录执行下列命令，按顺序审查锁文件变化并验证行为：

```bash
npm ci
npm audit
npm run test:unit
npm run build
npm run test:browser
npm run test:production-smoke
```

升级主版本时，同时检查运行时与开发依赖、Node.js 最低版本、导入路径和默认行为。发现审计结果后先确认公告的受影响范围与修复版本，再升级直接依赖；传递依赖只有在兼容 semver 范围内时使用普通 `npm audit fix`。不要为消除审计数字强行接受主版本迁移。

## 离线运行约束

前端当前没有从远程地址加载 CSS。保持字体、样式表和图标由仓库内依赖或本地源码提供，避免新增远程 `@import`、外链样式表或 CDN 字体；应用在本机服务可用时应能断开外网使用。

## GitHub Actions runtime 与 runner（2026-10-03）

GitHub 于 2026-09-23 移除了 Actions 中的 Node.js 20 runtime，因此 CI 将旧 v4 action 升至已声明 Node.js 24 的稳定发布线。Node.js 24 在这里仅运行 Actions 本身；项目命令仍由 `setup-node` 安装的 Node.js `22.22.3` 执行，应用支持范围仍是 `>=22.17.0 <23.0.0`。

| Action | CI 版本 | 官方依据 |
|---|---|---|
| `actions/checkout` | `v6` | [v6.0.0 action.yml](https://raw.githubusercontent.com/actions/checkout/v6.0.0/action.yml) 声明 `runs.using: node24`；[v6.0.0 release](https://github.com/actions/checkout/releases/tag/v6.0.0) 与[官方 README](https://github.com/actions/checkout/blob/v6/README.md)记录 Node.js 24 runtime 要求。 |
| `actions/setup-node` | `v6` | [v6.0.0 action.yml](https://raw.githubusercontent.com/actions/setup-node/v6.0.0/action.yml) 声明 `runs.using: node24`；[v6.0.0 release](https://github.com/actions/setup-node/releases/tag/v6.0.0) 与[官方 README](https://github.com/actions/setup-node/blob/v6/README.md)记录 Node.js 24 runtime 要求。 |
| `actions/upload-artifact` | `v6` | [v6.0.0 action.yml](https://raw.githubusercontent.com/actions/upload-artifact/v6.0.0/action.yml) 声明 `runs.using: node24`；[v6.0.0 release](https://github.com/actions/upload-artifact/releases/tag/v6.0.0) 记录 runner 最低版本，并修复 artifact 依赖中的 `punycode` 弃用告警。 |

这些 Node.js 24 action 的官方说明给出的最低 Actions runner 版本为 `2.327.1`。`checkout@v6` 另要求从 Docker 容器 action 运行认证 Git 命令时使用 runner `2.329.0` 或更新版本；当前 workflow 不调用这种容器 action。[官方 README](https://github.com/actions/checkout/blob/v6/README.md)

CI 使用 GitHub-hosted runners，后端矩阵增加固定的 `macos-15` 标签。GitHub 当前 [hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 列出 `macos-15`，且 [macos-15 runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md)仍由官方维护。浏览器测试仍运行在 `ubuntu-24.04`，截图继续写入 `runner.temp` 并保留 14 天。
