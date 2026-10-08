# 编辑撤销与重做：实施与验收

日期：2026-10-08。基线：`97e5d6a556fa8c4580c79c38f6f345c44134be6e` 之后的本地工作树，包含上一轮 Release 问题修复。Luna 实施初版及回归测试；执行额度用尽后，主代理完成编辑器生命周期修正和最终验收。

富文本与源码模式均已加入撤销、重做按钮及快捷键。没有可用记录时按钮禁用；撤销或重做产生的内容继续通过原来的三秒自动保存、草稿快照和 revision 冲突检测保存。

## 操作与记录边界

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 撤销 | ⌘+Z | Ctrl+Z |
| 重做 | ⌘+Shift+Z；也支持 Ctrl+Y | Ctrl+Shift+Z 或 Ctrl+Y |

快捷键作用于获得焦点的正文编辑器。搜索框等输入控件保留自己的原生编辑历史。桌面、手机工具栏均有带可访问名称的按钮；手机点击区域至少 44px。

保存成功不会清空当前撤销记录。撤销后输入新内容会清空旧重做分支。切换文件、切换编辑模式、重新加载文件或恢复历史版本会开启新的撤销记录；这些记录不跨浏览器刷新持久保存，较早的保存内容通过版本历史找回。

富文本使用 TipTap 已有的原生 history，源码使用 CodeMirror 已有的原生 history，没有叠加第二套撤销引擎。程序化替换文档时保留 TipTap 实例与已挂载视图，同步重置文档和插件状态，避免把文件加载当成可撤销编辑，也避免图片菜单因视图被重建而失效。源码文档会话单独重置。

## 验收中补齐的手机表格行为

失败现场确认：真实触控命中了新增的空白单元格，但 DOM 光标仍停在原有下一行。现在仅对空段落单元格的短距离、短时单次点击显式放置光标；移动手势、长按、多指、文档变化及输入法组合状态不走该处理。选区变化不修改内容，也不增加撤销记录。

原手机表格用例及其单次真实触控、行列增删、相邻表格保全、离屏按钮隐藏和精确保存断言均保留，没有用重试点击或放宽断言换取通过。

## 最终验证

所有测试工作区、配置、恢复目录及 Chrome profile 均临时隔离，未使用真实笔记样本。本报告的本地验收阶段尚未提交、推送或部署，远端 CI 应以最终提交对应的运行结果为准。

| 检查 | 结果 |
| --- | --- |
| 前端单元测试 | 84/84，无跳过 |
| 前端构建 | 通过，保留既有大 chunk 警告 |
| 完整浏览器回归 | 76/76，无跳过；自动保存、恢复、冲突、历史及图表交互通过 |
| 官方 production smoke | 2/2，真实构建页面、保存、相对图片、附件和懒加载错误界面通过 |
| 独立 production 撤销验收 | 1/1；连续多步文字编辑、表格插入的撤销/重做、保存后记录、源码原字节和文件隔离通过 |
| Win32 键盘映射探针 | 1/1；Chrome 模拟平台下源码 Ctrl+Z、Ctrl+Shift+Z、Ctrl+Y 和保存字节通过，运行主机仍是 macOS |
| 最终截图探针 | 1/1；浅色、深色颜色稳定，390px 手机按钮 44px 且无横向溢出 |
| git diff --check | 通过 |

独立截图复核确认按钮排列与原工具栏一致，浅色与深色状态可区分，手机正文和底部状态栏没有被新增按钮挤出视口。

## 证据与限制

日志、探针及截图位于本机临时目录 `/private/tmp/standalone-editor-undo-redo-20261008/`，不把整批截图加入 Git：

- `frontend-unit-final.log`、`frontend-build-final.log`、`browser-full-final.log`、`production-smoke-final.log`。
- `production-history-final.log`、`windows-keyboard-compatibility-final.log`、`toolbar-visual-final.log`。
- `history-final-desktop-light.png`、`history-final-desktop-dark.png`、`history-final-mobile-dark.png`。
- `table-selection-sequence.log` 和 `mobile-table-selection-failure.png` 保留空白单元格触控失败证据；`table-selection-fixed.log` 保留原失败前序修复后的完整通过结果。

早期失败日志保留，最终结果以带 `final` 的完整日志为准。原生 Windows、Safari 和真实手机软键盘未验收；平台模拟和 Chrome 触控模拟不替代真实设备验证。既有 Markdown 支持边界与大 chunk 警告没有在本次任务中扩展处理。

后续复评发现的 R07（源码冲突覆盖保存清空记录）已单独修复，新增组合回归及生产验收通过。最新结果见 [R07 修复报告](2026-10-08-source-conflict-history.md)，不以本轮原有 76 项用例代替新增边界验证。
