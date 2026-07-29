# Windows Agent 远程桥接优化设计

## 架构边界

Windows Agent 仍是唯一允许访问 Codex Desktop 会话文件与本机 CDP 的组件。云端 Relay 负责鉴权、缓存、命令转发和实时事件转发；手机端不直接访问 Windows 主机。

```text
手机 App -- HTTP / WebSocket --> Relay -- WebSocket --> Windows Agent -- CDP --> Codex Desktop
```

Relay 不接收草稿正文。草稿仅在 Windows Agent 的 CDP 控制脚本内用于决定是否拒绝发送。

## 控制命令

### 串行队列

`DesktopAgentApi` 为所有会触碰 UI 的控制操作维护单一 FIFO 队列。队列中的任务无论成功或失败都必须释放后续任务。读取会话文件和接收会话同步不进入该队列。

### 发送

1. Relay 将 `{threadId, text}` 转发给 Agent。
2. Agent 根据线程 ID 读取项目名与线程名，并进入控制队列。
3. PowerShell 脚本验证项目内目标标题唯一，定位到多条或零条时失败。
4. 脚本切换到目标线程，读取编辑器状态。
5. 编辑器存在非空草稿或发送按钮禁用时，脚本失败；不读取或上传草稿正文。
6. 脚本插入文本、再次验证可发送状态后点击发送。
7. Agent 回应命令结果，同时立即触发一次会话同步。

### 停止

`/codex/stop` 接收 `threadId`。Agent 使用同一控制队列定位该线程，切换到目标后再发送 Escape。缺失、歧义或不可定位的目标均明确失败。

## 实时状态

Relay 新增受 token 鉴权的手机 WebSocket 连接。每个 token 维护已连接手机集合。

- Agent 的 `session-sync` 成功应用缓存后，Relay 向该 token 的手机广播 `session-updated`，其中只包含状态版本、同步时间和 Agent 在线状态。
- Agent 连接、断开或被判定失活后，Relay 广播 `agent-status`。
- 手机收到事件后按需调用现有 `/codex/threads`、`/codex/history`、`/codex/status` 缓存 API 更新页面。
- 页面首次显示和用户主动刷新继续使用 HTTP；移除 0.9 秒状态轮询和 2 秒线程轮询。

## 连接存活

Relay 对 Agent WebSocket 使用 ping/pong 心跳，并在超时后关闭失活连接。断开时立即拒绝待转发命令并通知手机端。Agent 保留重连逻辑，避免旧的半断链连接长期占用 token。

## 状态收敛

线程执行状态不得只由 WebSocket 是否连接推断。Relay 为每个 token 的会话快照维护单调递增 `syncVersion` 和 `lastSyncedAt`，手机端以版本顺序消费快照，并将状态拆分为：

- Agent 连接：`online` 或 `offline`。
- 同步新鲜度：`fresh`、`stale` 或 `unknown`。在限定时间内未收到 `session-sync` 时，Relay 必须广播同步超时事件；连接仍在线也不得继续视为新鲜。
- 命令确认：发送/停止命令仅表示已投递；等待后续版本快照确认。等待超过限定窗口时变为未确认，不可无限保持运行中。
- 执行状态：只由最新会话快照中的运行、完成或停止事件产生。

客户端仅在同步新鲜且执行状态为 `running` 时递增等待时长；同步超时后按 `lastSyncedAt` 冻结时长，显示“状态未确认”，并清除本地等待占位。完成状态必须来自命令确认后的新快照，不能由旧 HTTP 响应覆盖。

## 过程与最终回复顺序

会话解析层必须以 `turnId` 产出过程和最终回复的关联。渲染层只消费该关联：`用户消息 → 同 turn 的过程 → 同 turn 的最终回复`。没有可验证关联的过程不得追加到最终回复之后；运行中可暂存为未关联过程，完成时仍无法关联则隐藏并记录为状态异常。

## 兼容与回滚

- 既有 HTTP API、token 鉴权、桌面管理器和 Android 配置格式保持不变。
- 实时连接断开时，页面明确展示连接状态，并在连接重建后继续接收事件；不自动恢复高频 HTTP 轮询。
- 任何控制验证失败都不执行输入或停止动作。
- 回滚仅需移除事件订阅和恢复原有轮询；控制安全校验和队列不回滚。

## 风险

- Codex Desktop UI 结构仍可能改变 CDP 选择器；脚本需返回结构化错误，不能猜测目标。
- `stop` 需要切换目标对话，仍可能短暂影响桌面前台；这是保留 Desktop App 的固有限制。
- WebSocket 鉴权必须沿用现有 token 校验，且不得把草稿正文写入 Relay 日志或缓存。
- `/codex/stop` 的请求体新增必填 `threadId`；Android App、云端网页和本机网页必须同时更新，不保留缺失线程 ID 时的全局停止行为。
