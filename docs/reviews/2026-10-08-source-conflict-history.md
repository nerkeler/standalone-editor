# R07：源码冲突保存的撤销记录修复

日期：2026-10-08。基线为 `97e5d6a556fa8c4580c79c38f6f345c44134be6e` 加上一轮发布修复和撤销/重做的本地改动。本轮主代理复现、实施与生产验收，GPT-6 Luna / max 独立复核保存边界并验收隔离依赖安装。

## 结果与改动

R07 已修复。采用经过比较和确认的本地源码草稿保存成功后，编辑器保留原生撤销、重做记录。原实现再次调用 `replaceSourceContent`，递增 React key 中的 generation，重建 CodeMirror；本次删除这次多余的文档替换，只更新保存状态。

保存前的磁盘 revision 比较、后端条件写入、保存期间新编辑的保留与后续自动保存均沿用原实现。用户明确放弃草稿并载入磁盘版本、恢复历史版本、切换文件或编辑模式时，仍开启新的编辑记录。

- `frontend/src/pages/Editor.jsx`：冲突保存成功时保留当前文档视图，不再重置源码 history。
- `frontend/tests/editor-save.browser.test.js`：增加源码冲突覆盖保存与 undo/redo 的组合回归，同时验证主动重载磁盘不会跨越历史边界；强化历史恢复后记录为空、快捷键不能返回旧草稿的断言。
- `frontend/package.json`、`frontend/package-lock.json`：将直接导入的 `@codemirror/commands` 声明为直接依赖，沿用已锁定的 `6.11.1`，没有升级其他依赖。

## 复现与验收

修复前的新浏览器回归准确复现：磁盘保存内容正确，但 `sameView=false`、`undoDisabled=true`、`redoDisabled=true`。修复后保留同一个视图，撤销与重做同时可用；原来尚未执行的 redo 分支也能继续执行。

独立生产验收使用真实构建、Chrome 原生键盘事件与实际鼠标点击。验证 front matter 和尾随空白原字节、普通保存、外部磁盘改写、冲突比较及两次确认、保存后 Cmd+Z、Cmd+Shift+Z、Ctrl+Y，以及撤销/重做后的三秒自动保存。保存前后两按钮都可用，后续保存采用冲突解决后的 revision。

| 检查 | 本轮结果 |
| --- | --- |
| 原缺陷回归，修复前 | 1 项失败，准确复现 R07 |
| 定向保存与历史边界回归，修复后 | 4/4 通过，无跳过 |
| 前端单元 | 84/84 通过，无跳过 |
| 前端生产构建 | 通过；保留既有大 chunk 警告 |
| 独立 production 源码冲突与 history 验收 | 1/1 通过 |
| 既有 production smoke | 2/2 通过 |
| 完整浏览器回归 | 77/77 通过，无跳过；含源码冲突与 history 组合回归 |
| 临时副本干净 npm ci、npm ls | 通过；清单与当前仓库字节一致 |
| 前端全量及生产依赖审计 | 均 0 项漏洞 |
| Rollup 平台可选包 | 25 项锁记录完整，当前 Darwin/arm64 包安装成功 |
| git diff --check | 通过 |

本轮没有修改后端，上轮 R01–R06 已通过的后端修复仍保留；本轮不将上一轮的后端数字冒充新执行结果。

## 证据与边界

证据保存在本机临时目录 `/private/tmp/standalone-editor-r07-20261008/`，没有把中间截图和大日志加入 Git：

- `r07-before-product.log`：修复前准确失败；`r07-before.log` 是此前探针返回复杂对象的脚本错误，不作为产品复现证据。
- `targeted-final.log`、`frontend-unit.log`、`frontend-build.log`、`browser-full.log`、`production-smoke.log`。
- `production-source-conflict-acceptance.mjs`、`production-source-conflict.log`、`production-source-conflict-result.json`。
- `production-source-conflict-after-redo.png`：冲突保存后继续重做并完成自动保存的工作台截图；主代理已实际查看。
- `dependency-review/`：隔离安装、依赖树和审计日志。首次受沙箱网络限制的安装失败后，授权的隔离安装成功，随后从指定临时 cache 干净重装成功。
- `verified-file-sha256.json`：本轮四个变更文件的哈希，以及依赖验收清单与仓库一致的检查。

所有笔记、配置、恢复目录和浏览器 profile 均临时隔离，没有使用真实笔记。本报告的本地验收阶段尚未提交、推送或部署；远端 CI 应以最终提交对应的运行结果为准，不能借用旧 HEAD 的绿色结果。

既有大 chunk 告警仍在。当前验收为 macOS + Chrome，不替代原生 Windows、Safari、真实手机 IME、NAS、跨卷设备或掉电验证；此前已接受的外部文件系统竞态边界没有扩大保证。
