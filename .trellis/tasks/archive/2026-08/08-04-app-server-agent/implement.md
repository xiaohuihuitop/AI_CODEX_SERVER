# 实施计划

1. 为 app-server JSON-RPC 子进程实现请求/响应/通知客户端，并以单元测试覆盖初始化、超时、异常退出与通知归一化。
2. 为客户端线程列表与现有 JSONL 读取器增加映射层，确保仅同步未归档会话并保留 `threadId`。
3. 将 `DesktopAgentApi` 的发送和停止改为 app-server 回合操作，覆盖恢复失败不启动回合、活动回合停止和返回 watch 键。
4. 将桌面 Agent 同步改为读取 app-server 列表与状态；添加日志和状态转移测试。
5. 将管理器状态从 CDP 改为 app-server，移除 CDP 对功能状态的影响并保留故障诊断日志。
6. 运行单元、集成、静态检查和 Windows 管理器构建。
7. 在本机对既有 thread 执行受控发送，检查 app-server 通知、JSONL、Relay/Web 和桌面 GUI 是否全部指向同一 thread；不通过则回滚本次迁移。

## 验证命令

- `cd server && npm test`
- `cd server && npm run check`
- `cd desktop && npm run build:manager:win`
- 使用 app-server JSON-RPC 探针执行 `initialize`、`thread/list`、`thread/read`。
- 受控手机发送后核对 threadId、JSONL 增量、桌面 GUI 与 Relay 状态。

## 风险与回滚

- app-server 是实验协议，升级 Codex 后可能变更字段；客户端必须集中解码并在初始化日志中记录协议错误。
- 若 GUI 不接收由 app-server 续接的会话更新，则不启用 app-server 发送；保留当前已构建管理器和源码改动，按 Git 提交回滚。
