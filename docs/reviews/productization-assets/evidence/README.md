# 验收证据说明

这组记录对应 `dc5da9dafe136649f74676613fc5a6322ce54257` 之后的本地产品化改动。运行环境是 macOS、Node.js 22.22.3 与本机 Chrome；所有文件操作使用临时目录。日志不是 GitHub Actions 运行结果。

| 记录 | 验证层级 |
|---|---|
| `backend-final.txt` | 后端自动化，包含文件故障注入、实例隔离和服务生命周期 |
| `frontend-unit-verified.txt` | Markdown、存储异常、工作区意图和迟到响应的单元测试 |
| `build-verified.txt` | 最终 Vite 生产构建与包体；大包警告保留 |
| `production-verified.txt` | 仅 Express 提供构建产物的 Chrome 验收；另测 lazy chunk 404 |
| `browser-final-verified.txt` | 55 项浏览器回归与两类可选截图一起连续执行 |
| `frontend-audit-after.json` / `backend-audit-after.json` | 获授权的 npm 在线审计，描述该时刻的依赖树 |
| `performance.json` | 3,000 个合成小笔记的五次暖 API 请求；包含无命中全文扫描 |
| `large-workspace-ui-before.json` / `large-workspace-ui.json` | 生产 UI 优化前后各三轮新 profile，展开全部、滚动、打开、输入和真实落盘 |

常规复验命令：

```bash
cd backend
npm test
cd ../frontend
npm run test:unit
npm run build
npm run test:production-smoke
npm run test:browser
```

连续截图验收还需为 `EDITOR_REVIEW_DIR` 与 `EDITOR_REVIEW_INTERACTION_DIR` 分别设置输出目录后执行 `test:browser`。两个可选截图项必须一起进入同一轮全套执行，不能用各自单独成功代替。

生产交互的额外尺寸、任务对齐、焦点、触控目标与正文不相交检查在 `../round-3/production/acceptance.json`。截图 `observed-34px-target.png` 是修正前发现的按钮命中区不足，不属于最终通过截图。

浏览器视口模拟不等于真实手机或读屏验收。API 暖缓存耗时不等于笔记库完整前端冷加载耗时。构建的 gzip 数字不等于服务器已启用 gzip。
