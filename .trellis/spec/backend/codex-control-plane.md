# Codex 控制平面契约

## 场景：Windows Agent 跨端控制 Codex Desktop

### 1. 范围 / 触发条件

- 触发条件：修改手机/Web 发送、停止、线程目录、运行状态、桌面管理器或 Windows Agent 打包逻辑。
- 本契约只约束正式产品链路；不提供 CDP、DOM 自动化或自动重启 Codex 能力。

### 2. 签名

正式控制仅允许以下 App Server 调用顺序：

```js
await appServer.resumeThread(threadId);
const started = await appServer.startTurn(threadId, text);
await appServer.interruptTurn(threadId);
```

- `resumeThread(threadId: string)`：恢复目标线程。
- `startTurn(threadId: string, text: string)`：创建回合，必须返回非空 `turn.id`。
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

### 7. 错误与正确做法

#### 错误

读到手机用户消息后立即清除 Agent 的优先同步目标，随后让最终回复等待普通轮转；或用任意 `syncVersion` 增长判定本次发送完成。

#### 正确

用户消息落盘只完成发送确认，Agent 仍保留同一线程为优先目标；只有读取到相同 `turn.id` 的完成证据后才解除优先同步。线程是否存在只由显式权威目录决定。
