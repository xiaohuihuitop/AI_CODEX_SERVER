# 固化 App Server 控制通道

## 目标

将 Windows Agent 的正式控制通道固定为 Codex Desktop 内置 `codex.exe app-server` 的 JSON-RPC stdio，防止因手机/Web 展示、同步或状态异常而再次把 CDP 当作发送、停止或重启方案。

## 已确认事实

- `4a2389c` 已将正式控制迁移至 App Server；`66e835b` 修复了 App Server 使用全局旧 CLI 而非 Desktop 内置运行时的问题。
- `4a2389c` 后不存在切回 CDP 的 Git 提交；之后出现的 CDP 构建产物来自未提交的本地试验。
- Windows Store 版 Codex 不支持由外部进程稳定注入 CDP 启动参数，已发生过关闭后无法重启和 `Access is denied`。
- 当前正式 Agent 已使用 `createCodexAppServerClient`，但仓库仍保留可被误用的 CDP 旧桥接入口、控制器和打包脚本。

## 范围

- 删除旧 CDP 控制实现及其产品入口、打包配置和过时测试。
- 将 `desktop` 的默认启动命令指向正式 Agent。
- 增加控制平面回归测试：生产入口和打包清单不得重新引入 CDP 控制、重启 Codex 或调试端口环境变量。
- 在 Trellis 规范中记录控制平面、线程目录、历史同步和展示状态的职责边界及变更门禁。

## 非范围

- 不改变云端 relay 协议、手机/Web UI 和已有 App Server JSON-RPC 语义。
- 不实现新的 CDP 诊断、自动重启 Codex 或 UI 自动化能力。
- 不修改用户正在运行的 Codex Desktop 进程。

## 验收标准

- [ ] 生产代码、`npm start` 入口和 Windows 管理器打包清单均不再包含 CDP 控制器、CDP 重启或 `CODEX_DEBUG_PORT`。
- [ ] 正式发送、停止路径仍先 `resumeThread`，再 `startTurn`，停止使用 `interruptTurn`，且使用 Desktop 内置 `codex.exe`。
- [ ] 构建后的 `app.asar` 不包含旧 CDP 控制模块、控制脚本或 CDP 重启入口。
- [ ] 自动化测试能在未来重新引入上述行为时失败。
- [ ] `.trellis/spec` 明确规定：展示或同步症状不得触发控制平面切换；变更控制通道前必须有能力矩阵、同线程端到端证据和明确审批。

## 风险与回滚

- 移除旧 `npm start` 本地桥接后，历史 CDP 使用方式不再可用；正式远程能力统一由桌面管理器或 `npm run start:agent` 提供。
- 回滚仅允许通过版本控制恢复，不允许在运行中的管理器中临时恢复 CDP 控制。
