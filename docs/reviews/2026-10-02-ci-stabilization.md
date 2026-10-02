# 跨平台 CI 稳定化验收

日期：2026-10-02。基线 `06cd7a6`。实施由 GPT-6 Luna（max）完成，主代理独立审查并执行验收。全部文件操作和浏览器测试使用隔离的临时工作区，没有访问真实笔记或更新局域网服务。

## 基线与修复范围

[基线 CI](https://github.com/nerkeler/standalone-editor/actions/runs/36955480156) 的前端构建缺少 Linux Rollup 包；Ubuntu 后端 131 通过、1 失败；Windows 62 通过、54 失败、16 跳过。此前本地通过的验收记录仍有效，但不能证明该版本可发布；原报告已明确撤回发布成熟度的 9 分判断。

- 恢复 Rollup 4.60.2 缺失的 24 个同版本平台锁节点，核对官方 registry 的版本、integrity、OS 与 CPU；不添加 Linux 专属直接依赖，也不附带依赖升级。新增测试检查全部 25 个平台包。
- ZIP 回滚记录写入完成后的纳秒时间、类型、大小和 SHA-256，使用暂存硬链接保留原始 inode，防止其在回滚前被复用。部分写入失败也记录实际内容。没有锚点或指纹已变化时保留目标并返回诊断；硬链接不可用不阻断正常导入。
- 暂存清理逐项校验，只对已知空目录使用 `rmdir`，不递归删除未知内容。某个父目录变化不会中断其他安全路径的回滚，也不会隐藏原始失败。
- Windows 配置断言解析 JSON 后比较路径；增加真实路径/句柄文件身份探针。保留现有路径、符号链接和文件身份检查。
- 支持运行时限定为 Node.js `>=22.17.0 <23.0.0`；启动脚本、后端入口、engines、锁文件和文档一致，CI 使用 22.22.3。[Node.js 22.17.0](https://nodejs.org/en/blog/release/v22.17.0) 包含 libuv 1.51.0，其[变更记录](https://github.com/libuv/libuv/blob/v1.51.0/ChangeLog)修复 Windows 卷序列号一致性。实际跨平台验收运行在 22.22.3，不把最低版本声明写成对所有版本的实测证明。
- CI 截图写入 runner 临时目录，由 Actions artifacts 保留 14 天。中间截图和日志不再新增到 Git 历史。
- 修复真实 Linux runner 暴露的 Chrome 测试清理竞争：浏览器级 `Browser.close`、有界退出及 TERM/KILL、仅对瞬时删除错误做有限重试，最终失败仍抛出。全部业务断言保留，并新增同步退出与拒绝退出回归。
- 移动及回收站恢复从首次读取起保留 BigInt 文件身份；复制降级同时核对句柄、路径和初始快照，拒绝不安全的 Number 身份。权限只在掩码后转换，读写长度只在安全整数范围内转换；保留 `wx` 排他创建和符号链接限制。

## 验收记录

初版修复分支的 [run 36969726076](https://github.com/nerkeler/standalone-editor/actions/runs/36969726076) 因 job 级 env 引用了不可用的 runner context，未创建测试 job；改为 step 级后正常运行。没有把这次失败当作业务测试已执行。

[run 36969988065](https://github.com/nerkeler/standalone-editor/actions/runs/36969988065) 的 Ubuntu 后端 143/143，Windows 后端 125 通过、18 条平台条件跳过，均无失败。Linux 前端安装、单元与构建通过；生产 smoke 中 Chrome profile 清理报 `ENOTEMPTY`，促成本轮有界退出与清理修复。没有把后端通过写成整轮 CI 通过。

后续 [run 36971223159](https://github.com/nerkeler/standalone-editor/actions/runs/36971223159) 的 Linux 前端已通过，包括生产 smoke 与完整浏览器；Ubuntu 后端通过。Windows 又出现一项复制降级失败：`copyFileNoReplace` 把 Number stat 的 inode 转成 BigInt 后比较，存在超出安全整数范围时的精度缺口。主代理用同一真实移动流程及合成大 inode 独立复现了相同 `INVALID_PATH`；修复后同一脚本成功移动内容，源路径消失，目标内容完整。该 Windows runner 未输出具体 inode 值，因此不把合成探针的编号称为远端实测编号。

独立 macOS 验收已通过：干净安装后的前端单元 76/76 与构建；Chrome 清理最后一次改动后浏览器 57/57、生产 smoke 2/2。BigInt 最后一次源码改动后完整后端 144 通过、2 跳过，移动与恢复浏览器交互 3/3。另用修复前后同一脚本证明：同 inode、同长度的外部修改，修复前被回滚误删，修复后内容保留。

最终源码验收基准为 `8974b09250490f756b3a3e36f8ba4b1434c98f82`。[修复分支 CI 36972730176](https://github.com/nerkeler/standalone-editor/actions/runs/36972730176) 的三个 job 全部通过；核对了真实步骤和日志，没有把配置存在或测试跳过当作执行成功。

| 验证 | 通过 | 跳过 | 失败 |
| --- | ---: | ---: | ---: |
| Ubuntu 后端 | 146 | 0 | 0 |
| Windows 后端 | 128 | 18 | 0 |
| Linux 前端单元 | 76 | 0 | 0 |
| Linux 生产 smoke | 2 | 0 | 0 |
| Linux Chrome 浏览器回归 | 57 | 0 | 0 |
| macOS 后端 | 144 | 2 | 0 |
| macOS Chrome 浏览器回归 | 57 | 0 | 0 |
| macOS 生产 smoke | 2 | 0 | 0 |
| macOS 最后源码改动后的移动/恢复交互 | 3 | 0 | 0 |

Linux 与 macOS 前端构建通过，macOS 另验证隔离目录中的干净 `npm ci`、单元与构建。Windows 跳过项为 POSIX 权限、POSIX 启动脚本、Linux 目录策略及需要额外权限的符号链接用例；同类安全约束仍在 Ubuntu 执行。macOS 两项跳过是 Linux 目录策略。CI 截图 artifact 实际上传成功，没有新增截图二进制到本次提交。

这次关闭的是已观察到的 CI 发布阻断，并证明上述代码在列出的平台和测试范围内通过；不把它重新换算为所有产品维度均已达到 9 分。

## 真实限制

Node 的 pathname 检查与最后一次 `unlink` 之间仍有无法完全消除的跨进程竞态窗口；这次没有引入持久文件身份系统或跨进程锁。无硬链接支持的文件系统在失败回滚时可能保留部分导入文件，错误会列出路径。平台跳过项不计为通过，NAS、突然掉电和真实手机设备仍没有在本轮实测。局域网运行服务未部署或重启。
