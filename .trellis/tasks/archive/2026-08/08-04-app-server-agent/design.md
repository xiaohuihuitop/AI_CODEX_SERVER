# app-server Agent 设计

## 架构

Windows Agent 新增 `CodexAppServerClient`，长驻启动 `codex app-server` 并维护一条 JSON-RPC stdio 连接。该客户端是 app-server 协议唯一解码点，向现有 Agent 暴露线程、回合和状态投影。

```text
手机/Web -> Relay -> DesktopAgentApi -> CodexAppServerClient -> codex app-server
                                  |                                |
                                  +-> CodexSessionReader <--- .codex JSONL
```

## 责任划分

- `CodexAppServerClient`：子进程生命周期、initialize、请求 ID、超时、JSON-RPC 响应、通知归一化。
- `DesktopAgentApi`：校验 `threadId` 和用户文本；使用 `thread/resume` 与 `turn/start` 发送，使用 `turn/interrupt` 停止。
- `desktop-agent.js`：同步 app-server 未归档线程和实时回合状态；将客户端状态写入有限日志。
- `CodexSessionReader`：继续从同一 JSONL 会话文件生成手机/Web 已使用的消息、过程和分页快照。
- 管理器：展示 app-server 而非 CDP 健康状态；重启 Codex 仅保留为 GUI 操作，不作为 Agent 启动条件。

## 协议契约

- 初始化：`initialize`，声明客户端名称、版本和实验 API 能力。
- 列表：`thread/list`，固定 `archived:false`，按 `updated_at desc` 请求有限页；将 `id/sessionId/name/cwd/updatedAt` 映射为同步目标。
- 发送：`thread/resume(threadId)` 成功后调用 `turn/start`；返回的 `turnId` 作为手机端等待和状态归属键。
- 停止：`turn/interrupt(threadId, turnId)`；缺少活动 turn 时返回明确的不可停止错误。
- 通知：`turn/started`、`turn/completed`、`thread/status/changed` 更新客户端运行态；通知只更新运行态，不直接重写 JSONL 历史。

## 兼容与失败处理

- app-server 启动、初始化或协议请求失败时，Agent 发送明确错误并标记离线；不回退到 CDP/UI 自动化。
- 任何 `thread/resume` 失败都会阻止 `turn/start`，防止新建替代对话。
- app-server 退出后客户端清理待请求并记录退出码；Agent 重启后重新初始化并重建运行态。
- app-server 仅监听 stdio，不开放额外 TCP 端口；云端仍只通过既有 Relay + 设备 Key 访问。

## 上线验证

先在本机读取目标会话、续接并执行一次受控手机发送；确认 JSONL 新增同一 thread 的记录且桌面 GUI 出现同一轮消息，再移除 CDP 运行依赖。若桌面 GUI 不同步，停止迁移并保留现有生产链路，不自动切换。
