# App Server 实时同步设计

## 架构边界

系统保留两类事实来源，不再尝试用一个来源覆盖全部场景：

| 场景 | 实时主来源 | 最终对账来源 | 目录来源 |
| --- | --- | --- | --- |
| 手机/Web 通过 Agent 发起回合 | Agent 持有的 App Server 通知 | JSONL | Desktop SQLite |
| 官方 Desktop 发起回合 | JSONL 变化事件 | JSONL | Desktop SQLite |

Agent App Server 与 Desktop 内部 App Server 相互独立。`thread/status/changed` 中的 `notLoaded` 只能说明 Agent 进程未加载该线程，不能推导 Desktop 页面是否空闲。

## JSON-RPC 客户端

`CodexAppServerClient` 按 JSON-RPC 2.0 消息形态分派：

1. `id` 且包含 `result` 或 `error`：响应本地待处理请求。
2. `method` 且不含 `id`：通知，进入事件规范化器。
3. `method` 且包含 `id`：App Server 主动请求，交给请求处理器并返回结果或明确错误。
4. 其他形态：协议错误，记录原始方法/ID 后拒绝处理。

启动顺序固定为：启动 Desktop 内置 `codex.exe app-server`、发送 `initialize`、校验响应、发送 `initialized`、标记就绪。未完成握手前禁止 `thread/resume`、`turn/start` 和 `turn/interrupt`。

主动请求采用显式处理表。已支持类型转发到 relay；暂不支持类型返回 JSON-RPC `Method not supported` 并将当前回合标记为需要处理，禁止忽略后继续显示“进行中”。不得用自动批准作为 fallback。

## 控制请求幂等

手机/Web 为每条用户消息生成 UUID，作为 `clientUserMessageId` 和云端控制请求 ID。relay 保存短期请求结果索引：

```text
token + threadId + clientUserMessageId -> accepted/running/completed/failed + turnId
```

Agent 维护同一进程内的已接收索引，并使用 App Server 回传的 user message `clientId` 对账。重复请求返回已有状态，不再次调用 `turn/start`。只有明确失败且服务端确认没有创建回合时才允许用户使用新的消息 ID 重发。

## 实时事件协议

Agent 规范化 App Server 通知后发送统一事件：

```json
{
  "seq": 1842,
  "eventId": "deviceId:1842",
  "threadId": "...",
  "turnId": "...",
  "source": "agent-app-server",
  "observedAt": "2026-08-09T12:00:00.000Z",
  "type": "turn.completed",
  "payload": {}
}
```

- `seq` 在单个 Agent 连接纪元内单调递增。
- `eventId` 全局唯一，用于 relay 和前端去重。
- relay 为每个设备保留有限事件窗口和最新序号，不承担永久历史存储。
- 手机/Web 保存最后确认序号；序号连续时增量应用，发现空洞或连接纪元改变时请求线程快照。
- `session-updated` 保留为快照变更信号，但不再用它代替具体回合事件。

## 状态模型

状态拆为五层，禁止合并成单一“在线/进行中”：

```text
relay: disconnected | connected
agent: offline | online | stale
appServer: starting | ready | error | stale
thread: unknown | notLoaded | idle | active | systemError
turn: unknown | queued | running | awaitingInput | completed | interrupted | failed
```

每层包含 `updatedAt`。UI 的等待时间只基于当前 `turn.startedAt`，回合终态、连接过期或对账失败立即停止计时。`notLoaded` 不映射为 `completed`。

## Desktop 来源同步

SQLite 仍是未归档线程集合的唯一目录来源。JSONL 观察增加“变化优先队列”：

1. 监听会话目录文件变化并解析对应线程 ID。
2. 将变化线程加入高优先队列并去重。
3. 每个同步周期先处理手机控制待确认线程，再处理变化线程，最后处理常规轮询线程。
4. 周期性重新读取 SQLite 目录，用于归档清理和发现文件监听遗漏。

文件监听与周期校验读取同一事实来源，后者只做一致性对账，不切换实现方案。

## 历史快照与分页

relay 的线程快照以 `turnId` 为稳定边界。接口返回：

```json
{
  "turns": [],
  "oldestTurnId": "...",
  "newestTurnId": "...",
  "hasMore": true,
  "snapshotVersion": 17
}
```

默认返回最新 5 轮；`beforeTurnId` 加载更早 5 轮。客户端按消息/回合 ID 合并，不能用数组索引覆盖当前窗口。快照版本倒退时拒绝覆盖并触发对账。

## 可观测性

所有关键日志使用结构化上下文：`requestId`、`clientUserMessageId`、`threadId`、`turnId`、`seq`、`source`、`reason`。管理器展示中文摘要，内存环形缓冲区最多 500 条。

必须记录：握手阶段、控制请求接收/去重/确认、App Server 主动请求、事件发送/确认、序号空洞、快照对账、文件变化调度、终态收敛和协议错误。

## 安全与失败策略

- 不自动批准危险操作或用户输入请求。
- 不以 CDP、DOM 自动化、旧 CLI 或重启 Desktop 作为失败替代路径。
- Schema 不兼容、主动请求未支持、事件序号异常均显式失败或进入待确认状态。
- 所有重试必须复用原请求 ID；无法证明幂等时停止重试并提示用户。
