# Codex 控制平面契约

## 场景：Windows Agent 跨端控制 Codex Desktop

### 1. 范围 / 触发条件

- 触发条件：修改手机/Web 发送、停止、线程目录、运行状态、桌面管理器或 Windows Agent 打包逻辑。
- 本契约只约束正式产品链路；不提供 CDP、DOM 自动化或自动重启 Codex 能力。

### 2. 签名

正式控制仅允许以下 App Server 调用顺序：

```js
await appServer.resumeThread(threadId);
const started = await appServer.startTurn(threadId, text, clientUserMessageId);
await appServer.interruptTurn(threadId);
```

- `resumeThread(threadId: string)`：恢复目标线程。
- `startTurn(threadId: string, text: string, clientUserMessageId: string)`：幂等创建回合，必须返回非空 `turn.id`。
- `interruptTurn(threadId: string)`：停止目标线程当前回合。

### 3. 契约

| 层 | 唯一数据源 / 责任 | 禁止行为 |
| --- | --- | --- |
| 控制 | Desktop 内置 `codex.exe app-server` stdio | CDP、DOM 输入、重启 Codex |
| 线程目录 | Desktop 本地会话目录与 JSONL 映射 | 用 App Server 列表或 UI 选择器替换目录 |
| 历史与状态 | JSONL -> Agent -> relay | 由 UI 图标或进程存在推断 |
| 管理器状态 | Agent App Server 心跳及运行时版本 | CDP 端口、GUI 进程存在 |

环境变量只允许通过管理器配置注入 `CODEX_CLOUD_URL`、`CODEX_DEVICE_TOKEN`、`CODEX_DEVICE_NAME` 和显式的 Agent 同步参数；不得注入 `CODEX_DEBUG_PORT`。

### 4. 校验与错误矩阵

| 条件 | 必须行为 |
| --- | --- |
| `threadId` 缺失 | 返回 `THREAD_ID_REQUIRED`，不调用 App Server |
| `clientUserMessageId` 缺失或复用于不同内容 | 返回 `CLIENT_USER_MESSAGE_ID_REQUIRED` 或 `CLIENT_USER_MESSAGE_ID_CONFLICT`，不创建新回合 |
| `resumeThread` 失败 | 返回 `THREAD_RESUME_FAILED`，不执行 `startTurn` |
| `startTurn` 失败或无 `turn.id` | 返回 `TURN_START_FAILED`，不伪造发送成功 |
| App Server 未就绪 | 管理器显示未就绪；不得尝试 CDP 或重启 Codex |
| 手机/Web 展示滞后 | 排查同步投影；不得改变控制平面 |

### 5. 正常 / 基准 / 异常案例

- 正常：手机发送到已同步线程，Agent 按 `resumeThread -> startTurn` 调用，JSONL 出现用户消息与回复，relay 回写状态。
- 基准：线程空闲且 App Server 就绪，管理器显示“已就绪”和实际使用的 Desktop 内置 Codex 版本。
- 异常：本地目录未收录线程或 JSONL 尚未落盘，返回真实错误或等待同步证据；不能转向 CDP 进行 UI 注入。

### 6. 必需测试

- `server/test/desktop-agent-api.test.js`：断言发送、停止的 App Server 调用次序及错误传播。
- `server/test/control-plane-contract.test.js`：断言产品源码、默认启动入口和打包清单不含 CDP 控制路径。
- `desktop/scripts/verify-manager-artifact.js`：构建后扫描 `app.asar`，发现旧控制模块、CDP 标识或缺少 App Server 调用即失败。
- 端到端：同一 `threadId` 从 Web 发送，验证本地 JSONL 的用户消息和回复均出现。

### 7. 错误与正确做法

#### 错误

手机页面没有立即刷新，因此将发送实现改为 CDP 点击桌面输入框。

#### 正确

先记录 App Server 回合标识和 JSONL 同步证据；若显示不一致，仅修复目录、状态或渲染投影。变更控制通道必须先完成能力矩阵、同线程端到端测试并获得明确审批。

## 场景：权威目录清理与手机回合实时同步

### 1. 范围 / 触发条件

- 触发条件：修改 `openThreadIds`、Relay 会话缓存、Agent 同步游标、手机发送确认或实时刷新。
- 电脑端侧栏是线程存在性的唯一权威来源；本地 JSONL 是已发送消息和完成状态的事实来源，未发送草稿不进入同步链路。

### 2. 签名

```js
cache.applySync(token, {
  openThreadIds: ['thread-id'],
  sessions: [],
  confirmedControlTurnIds: ['turn-id'],
});

inspectControlSyncEvidence(sessions, threadId, turnId);
advanceControlSyncState(state, evidence, now);
```

- `openThreadIds: string[]`：本 Key 当前未归档线程的完整集合；显式空数组表示清空。
- `sessions: object[]`：允许分批、增量或仅元数据，不能决定线程是否继续存在。
- `confirmedControlTurnIds: string[]`：只包含已在目标线程 JSONL 中观察到的精确 App Server `turn.id`。

### 3. 契约

- `applySync` 必须在同一次调用内删除不在显式 `openThreadIds` 中的 `bucket.sessions` 对象，并返回 `removedSessionCount`。
- 缺少 `openThreadIds` 的局部增量不得删除其他线程，也不得让已退出上一份权威集合的线程复活。
- Agent 每秒执行一次轻量 Desktop 目录成员检查；稳定目录不得周期性全量扫描全部 JSONL。
- 归档线程从同步目标移除时必须删除其本地同步游标，使重新打开后从完整快照重建。
- 手机发送分两阶段：目标 `turn.id` 的用户消息落盘后确认发送，但继续优先同步该线程；同一 `turn.id` 的 `task_complete` 出现后才解除优先同步。
- Relay 和手机/Web 不能用无关线程的 `syncVersion` 增长确认本次发送。

### 4. 校验与错误矩阵

| 条件 | 必须行为 |
| --- | --- |
| `openThreadIds: []` | 当前 Key 的 `sessions` 物理清空，返回同步确认 |
| 未提供 `openThreadIds` | 仅应用合法增量，不执行目录清理 |
| 增量线程不在当前权威集合 | 忽略该增量，不创建缓存对象 |
| 历史/状态/控制请求指向归档线程 | 返回不可用或 `THREAD_NOT_OPEN`，不得穿透在线 Agent |
| 同步包含其他回合或仅版本增长 | 不确认当前手机发送 |
| 目标用户消息已落盘但回合未完成 | 确认该 `turn.id`，继续每秒优先同步目标线程 |
| 目标回合完成 | 上传最终回复与完成状态，然后解除优先同步 |

### 5. 正常 / 基准 / 异常案例

- 正常：手机发送后约一个同步周期内看到用户消息，Codex 完成后下一个同步周期看到最终回复和完成状态。
- 基准：目录成员未变化时，Agent 只做 SQLite 目录检查和当前批次增量读取，不全量解析所有会话。
- 异常：线程归档后迟到的 JSONL 增量到达 Relay；Relay 忽略它，列表、历史、状态和控制接口仍不可访问该线程。

### 6. 必需测试

- `server/test/cloud-relay.test.js`：断言物理删除、空权威集合、字段缺失、迟到增量、Key 隔离、重开和在线 Agent 穿透阻断。
- `server/test/desktop-agent.test.js`：断言目录轻量重排、归档移除游标、精确回合落盘/完成证据及两阶段状态推进。
- `server/test/mobile-app.test.js`：断言手机只接受 `confirmedControlTurnIds` 中的精确 `turn.id`，并兼容 Android 调试基座。
- 端到端：Web 发送唯一标识，核对同一 JSONL 的用户消息、`task_complete`、最终回复、Relay 精确回合确认和无需手动刷新的页面回显。
- 端到端验收优先复用 Desktop 侧栏中已存在的测试线程；确需通过 App Server 新建隔离线程时，必须在 `finally` 中调用 `thread/archive`，并确认 SQLite 已归档、Relay 目录已清理、Web/手机列表已消失。禁止把未归档验收线程遗留在真实目录中。

### 7. 错误与正确做法

#### 错误

读到手机用户消息后立即清除 Agent 的优先同步目标，随后让最终回复等待普通轮转；或用任意 `syncVersion` 增长判定本次发送完成。

#### 正确

用户消息落盘只完成发送确认，Agent 仍保留同一线程为优先目标；只有读取到相同 `turn.id` 的完成证据后才解除优先同步。线程是否存在只由显式权威目录决定。

## 场景：有序事件、状态重连校验与客户端消息去重

### 1. 范围 / 触发条件

- 触发条件：修改 App Server 通知、Relay WebSocket、手机/Web 自动刷新、运行状态合并、历史分页或发送后的本地消息展示。
- Agent 自己发起的回合使用 App Server 事件实时更新；JSONL 负责最终历史对账。官方 Desktop 发起的回合继续使用 JSONL 变化观察，二者不能互相替换。

### 2. 签名

```js
const runtime = await appServer.refreshThreadRuntime(threadId);
client.sendAppServerEvent(event);
paginateMessagesByTurn(messages, 5, `turn:${oldestTurnId}`);
```

- `refreshThreadRuntime(threadId: string)`：调用 `thread/read({ threadId, includeTurns: true })`，以返回的线程状态和最后回合状态恢复运行态。
- `sendAppServerEvent(event)`：事件必须包含 `streamId`、单调 `seq`、唯一 `eventId`、`threadId`、`turnId`、`source`、`observedAt` 和 `payload`。
- `paginateMessagesByTurn(messages, limit, before)`：`before` 只能使用 `turn:<turnId>`；游标无效时返回 `invalidCursor: true`，禁止退回数组索引。

### 3. 契约

| 数据 | 主来源 | 对账行为 |
| --- | --- | --- |
| Agent 发起回合实时状态 | App Server 通知事件 | 事件空洞、重连或 JSONL 仍为运行中时执行 `thread/read` |
| Agent 发起回合最终历史 | JSONL | 以相同 `turnId` 合并，不复制用户消息或过程块 |
| Desktop 发起回合 | JSONL 文件变化 | 变化线程优先于普通轮转同步 |
| 可见线程目录 | Desktop SQLite | 显式 `openThreadIds` 物理清理 Relay 缓存 |

- `thread/read` 的 `completed`、`interrupted`、`failed` 必须立即结束页面等待；校验失败返回 `APP_SERVER_STATUS_FAILED`，不得继续显示猜测状态。
- `notLoaded` 只表示当前 Agent App Server 未加载线程，不能单独推断官方 Desktop 回合已完成。
- Relay 按 `eventId` 去重；`seq` 空洞或 `streamId` 改变必须广播 `resyncRequired`，客户端清除临时事件覆盖并读取权威快照。
- Relay 在线直读 Agent 后返回的 `cached: false` 终态是当前线程的权威裁决，必须立即清除客户端实时运行覆盖；不得用 WebSocket 事件的客户端接收时间否决该终态。
- `cached: true` 的终态只表示 Relay 缓存投影，清除实时运行覆盖前仍需满足同一 `turnId`、最终回复已出现或 `completedAt >= observedAt` 中至少一项。
- 手机初始加载和向上分页每次 5 轮；Web 可加载更大窗口，但必须使用相同稳定回合游标。
- 发送请求发出前保存 `baseMessageCount`。Agent 受理后才登记本地待确认消息；权威历史已包含相同用户文本时不再插入，本地用户气泡必须标记 `pending`，供历史到达后替换。

### 4. 校验与错误矩阵

| 条件 | 必须行为 |
| --- | --- |
| App Server 事件重复或倒序 | 忽略重复；倒序不得覆盖较新状态 |
| 事件序号空洞或连接纪元变化 | 标记需对账并读取目标线程历史/状态 |
| `cached: false` 直接状态为终态，但迟到事件仍为运行中 | 立即删除实时覆盖并结束等待，不比较客户端接收时间 |
| `cached: true` 缓存状态与实时状态冲突 | 保留实时覆盖，直到获得回合、最终回复或时间顺序证据 |
| JSONL 显示运行中且运行时未知/运行中 | 调用 `thread/read`，按同一 `turnId` 收敛 |
| `thread/read` 请求失败或返回其他线程 | 返回 `APP_SERVER_STATUS_FAILED`，记录线程 ID 与错误 |
| `before` 不是 `turn:<turnId>` 或目标不存在 | 返回空页和 `invalidCursor: true` |
| POST 等待期间历史先同步用户消息 | 使用发送前边界识别已有消息，只显示一次 |

### 5. 正常 / 基准 / 异常案例

- 正常：Web 发送唯一消息，页面只显示一个用户气泡，实时收到完成事件和最终回复，不需要手动刷新。
- 基准：Agent 重连后 JSONL 残留运行态，`thread/read` 返回最后回合 `interrupted`，页面立即停止计时并显示已结束。
- 异常：Relay 收到 `seq=8` 后直接收到 `seq=10`；不得猜测缺失事件，必须要求目标线程快照对账。

### 6. 必需测试

- `server/test/app-server-event-stream.test.js`：断言事件字段、序号单调和缺失线程事件拒绝。
- `server/test/cloud-relay.test.js`：断言事件去重、序号空洞、连接纪元和对账广播。
- `server/test/codex-app-server-client.test.js`：断言 `thread/read(includeTurns=true)` 与终态恢复。
- `server/test/desktop-agent-api.test.js`：断言 JSONL 运行态触发权威校验，失败显式传播。
- `server/test/codex-session-reader.test.js`：断言稳定 `turnId` 分页、新回合不会改变更早页。
- `server/test/mobile-app.test.js`：断言发送前边界、本地待确认消息替换和五轮分页。
- `server/test/mobile-app.test.js` 与 `server/test/cloud-relay.test.js`：必须构造 `completedAt < realtime.observedAt` 的迟到运行事件，并断言 `cached: false` 直接终态仍能清除覆盖。
- 真实 Web：连续发送、自动完成、Agent 重连状态恢复、停止和单消息去重均必须通过。

### 7. 错误与正确做法

#### 错误

App Server 事件缺失后继续依赖旧 JSONL 无限显示“进行中”，或用超时时间强制改成完成；POST 返回后无条件追加本地用户气泡。

#### 正确

事件缺失或重连时调用同一 App Server 的 `thread/read` 校验具体回合；协议失败明确报错。发送前保存历史边界，只有权威历史尚未出现消息时才插入待确认气泡。
