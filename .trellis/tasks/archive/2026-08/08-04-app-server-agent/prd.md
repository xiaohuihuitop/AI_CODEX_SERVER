# 迁移桌面 Agent 到 app-server

## 目标

移除 Windows Agent 对 Codex Desktop TCP CDP 的依赖，改由本机官方 `codex app-server` JSON-RPC 管理会话，使手机端能够可靠读取会话、发送消息、停止回复并获得运行状态。

## 已确认事实

- Windows 商店版 Codex 26.707.3748.0 虽接受 `--remote-debugging-port=9229`，但不会监听 TCP CDP 端口。
- 当前 CDP 控制层依赖 PowerShell 驱动桌面 UI，承担列表读取、消息发送、停止和运行态读取。
- 已实测独立 `codex app-server` 能读取 `C:\\Users\\admin\\.codex` 会话库；协议提供 `thread/list`、`thread/read`、`thread/resume`、`turn/start`、`turn/interrupt` 和状态通知。
- 已实测 `codex app-server proxy` 无法附着桌面 App 的控制 socket，不能把桌面 GUI 的现有后端作为可复用代理。

## 需求

- Windows Agent 启动并管理本机 `codex app-server` 子进程。
- 使用 app-server 协议替换 CDP/UI 自动化的会话列表、发送、停止和运行态读取。
- 保留服务端、网页端和手机端现有的固定 Key、缓存与消息展示协议。
- 管理器显示 app-server 连接状态和详细故障日志，不再把 CDP 可用性作为功能前提。
- 仅保留最近日志 500 条，日志不得包含 Token 或会话正文。

## 范围与关键决定

- 移动端会话列表改为 app-server 返回的未归档会话，按更新时间分页；不再依赖无法访问的桌面侧栏 DOM。
- 手机发送必须先按目标 `threadId` 恢复会话，再启动该会话的新回合；不得创建替代会话。
- CDP 仅作为管理器中的历史诊断信息，不参与 Agent 运行，不再提供“重启 Codex 生效 CDP”作为功能前提。
- 保留 JSONL 读取器用于当前手机/网页端消息格式、处理过程和历史分页，避免把未经验证的 app-server 原始事件直接泄漏到前端。

## 验收条件

- [ ] Codex GUI 未开放 CDP 时，Windows Agent 仍能上线并向 Relay 同步未归档会话。
- [ ] 手机选择既有 `threadId` 后发送消息，app-server 以该 `threadId` 续接并开始回合，不创建新 thread。
- [ ] 停止按钮针对同一 thread 的活动回合调用 app-server 中断，并在状态同步中结束等待状态。
- [ ] app-server 通知和 JSONL 增量同步共同驱动运行/完成状态，手机端不再需要手动刷新确认状态。
- [ ] 实测手机发送后的用户消息与回复出现在桌面 GUI 的同一会话；若不成立，迁移不得替换当前生产控制链路。
- [ ] Agent、管理器和移动端现有错误协议保持兼容，日志可区分 app-server 启动、连接、协议错误、会话同步和回合状态。
