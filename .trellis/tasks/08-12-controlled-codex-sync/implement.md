# 受控 Codex 双端同步实施计划

## 阶段 1：建立红色反馈环

1. 在 `docs/temp` 建立 Windows E2E 驱动脚本，测试目标固定为 `codex_temp` 中的验收线程。
2. 脚本记录接管前后主进程、包版本、CDP 端口与目标页，并断言手机/Web 发送后官方桌面出现同一标识消息。
3. 先运行现有 App Server 链路，确认脚本能够稳定捕获“JSONL/手机有消息、官方桌面不显示”的红色结果。
4. 将可自动化部分沉淀为 `server/test` 集成测试；真实桌面操作保留为 Windows E2E 门禁。

## 阶段 2：修复受控实例生命周期

1. 重建包清单解析与主进程识别，支持当前 `ChatGPT.exe`，移除可执行名硬编码。
2. 实现包应用激活、进程树退出等待、端口冲突诊断、所有权状态文件和启动阶段日志。
3. 实现监控长连接 `CodexCdpClient`、独立命令会话与兼容性探针。
4. 测试连续 5 次接管/重启、未知端口占用、客户端升级入口变化和异常退出。

## 阶段 3：实现精确控制

1. 使用 `threadId` 和深链接切换线程，并验证当前线程。
2. 实现草稿检测、输入、发送和停止语义操作。
3. 将控制命令串行化并贯穿命令 ID。
4. 以 JSONL 新用户消息作为发送成功确认，贯穿幂等命令 ID；超时明确失败且不自动重放副作用命令。

## 阶段 4：切换单一控制面

1. 将 `DesktopAgentApi` 的发送和停止切到 CDP 控制器。
2. 停止生产 Agent 启动独立 App Server；删除其管理器状态与产品入口。
3. 线程列表改为受控侧栏线程 ID 与 JSONL 映射。
4. 保持 JSONL 历史/状态和 Relay WebSocket 推送，补齐终态触发的最终历史收敛。

## 阶段 5：跨端与构建验证

1. 单元测试：包入口、进程所有权、CDP 协议、线程验证、草稿保护、命令幂等和 JSONL 确认。
2. 集成测试：Relay -> Agent -> 控制队列 -> 会话读取器 -> Relay -> Web/App。
3. Web E2E：连续发送 3 轮、停止、同名线程、自动终态与自动最终回复。
4. Windows 真机 E2E：在官方桌面可见状态下重复同样流程，并截图/日志确认双端一致。
5. 运行 `npm test`、`npm run check`、PowerShell 语法检查、管理器构建和产物扫描。
6. 构建路径固定为 `desktop/dist`，文件名固定为 `Codex Desktop 管理器.exe`。

## 验证命令

具体命令在阶段 1 的红色反馈环建立后固化；至少包含：

```powershell
npm test
npm run check
npm run build:manager:win
```

真实 E2E 必须输出机器可判定的 PASS/FAIL 和关联命令 ID，不能只凭人工目视汇报完成。

## 风险文件

- `desktop/electron/main.js`：管理器生命周期和接管入口。
- `desktop/desktop-agent.js`：控制面启动与实时同步。
- `desktop/src/desktop-agent-api.js`：发送、停止和命令队列。
- 新的受控进程/CDP 模块：进程与误操作风险最高。
- `desktop/src/codex-session-reader.js`：侧栏目录映射与 JSONL 确认。
- `server/src/cloud-relay.js`、`server/public/index.html`、`app/pages/index/index.vue`：跨端确认和状态收敛。

## 回滚条件

- 接管启动不能连续 5 次成功：停止，不切换发送链路。
- 无法按 `threadId` 验证目标线程：停止，不允许标题 fallback。
- JSONL 无法确认发送：返回失败，不把点击当作成功。
- 官方升级导致兼容性探针失败：保持功能未就绪，不启动独立 App Server 兜底。
