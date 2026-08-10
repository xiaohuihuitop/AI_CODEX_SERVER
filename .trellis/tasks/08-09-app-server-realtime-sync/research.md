# 上游项目与协议调研摘要

## OpenAI Codex App Server

- 官方握手要求 `initialize` 成功后发送 `initialized` 通知。
- App Server 会向客户端发送携带 `id` 的主动请求，用于审批和用户输入，客户端必须返回响应。
- `turn/start` 支持 `clientUserMessageId`，可作为跨层幂等键并在用户消息事件中回显。
- 官方提供 `generate-ts` 和 `generate-json-schema`，应基于 Desktop 内置版本生成契约。
- 线程状态包含 `notLoaded`、`idle`、`systemError`、`active`；`notLoaded` 不是完成状态。

参考：<https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>

## codexUI / codex-mobile

可借鉴：

- 完整 JSON-RPC 握手、主动请求分类和通知转发。
- 事件作为实时主链路，`thread/read` 作为重连后的对账。
- 使用 `beforeTurnId` 的稳定历史分页。
- 线程列表先加载小页，再后台增量加载。
- WebSocket 断线指数重连及备用传输设计。

不直接采用：

- 它以自己的 App Server 作为唯一前端后端，不控制官方 Desktop；与本项目保留官方 Desktop 的目标不同。
- 默认高权限和自动批准不符合本项目安全要求。
- 大型单体 Bridge 和前端状态文件不符合 KISS、SRP。

## codex-web

可借鉴：

- 单 App Server 服务多个前端的边界清晰。
- 执行引擎与网络网关可分离，便于长期进程和重连。
- 复用官方 UI 可以减少 Markdown、消息类型和历史渲染偏差。

不直接采用：

- 通过提取并修改官方 Desktop `app.asar` 模拟 Electron IPC，升级脆弱且偏向 macOS。
- 替换官方客户端违背本项目“电脑继续使用官方 Desktop”的核心需求。
- 当前认证和重连能力不足，不适合作为公网多设备网关基础。

## 结论

本项目不切换产品形态，也不复制上游 UI。只吸收协议完整性、事件实时化、稳定游标、断线对账和分层状态设计，并继续保留 Desktop SQLite 目录与 JSONL 持久化事实。
