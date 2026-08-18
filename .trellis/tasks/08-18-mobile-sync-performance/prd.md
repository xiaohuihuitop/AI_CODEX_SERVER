# 优化移动端同步时延

## Goal

在不改变“官方 Codex Desktop 是唯一会话执行者”的前提下，消除移动端加载、发送和最终回复同步中的秒级排队，使手机、Web 与电脑端围绕同一线程、同一回合和同一终态稳定同步。

## Background

- Agent 当前每秒调用 `syncSessions()`；只要 `syncProvider()` 返回对象就发送 `session-sync`（`desktop/src/desktop-agent-client.js:113`）。
- Relay 收到每个 `session-sync` 都递增同步版本并广播 `session-updated`（`server/src/cloud-relay.js:194`、`server/src/cloud-relay.js:327`）。
- 手机收到 `session-updated` 后重新读取线程列表、历史和状态，并且前台每 4 秒重复同样的全量刷新（`app/pages/index/index.vue:1683`、`app/pages/index/index.vue:1720`、`app/pages/index/index.vue:1855`）。
- 在线线程的历史和状态请求会从 Relay 直穿 Agent（`server/src/cloud-relay.js:714`、`server/src/cloud-relay.js:727`）。
- `parseHistory()` 和 `parseStatus()` 当前分别完整读取 JSONL（`desktop/src/codex-session-reader.js:1010`、`desktop/src/codex-session-reader.js:1117`）。
- 当前目标会话 JSONL 约 411 MB；基线实测最近 5 轮历史约 2.97 秒、状态约 3.09 秒，单次进程 RSS 约 1.35 GB。现有尾部快照路径约 0.95 秒、RSS 约 105 MB。
- 公网 Relay 的普通 HTTP 往返约 80 至 166 ms；主要瓶颈是重复刷新、同步等待和大文件整读，而不是服务器规格。

## Requirements

- R1：空闲时 Agent 不得每秒上传无变化会话，Relay 不得广播无变化的 `session-updated`。
- R2：手机只响应当前线程或目录真实变化；同一时刻最多存在一个当前线程刷新事务，后续事件只合并一次。
- R3：手机读取最近历史和当前状态时只访问 Relay 已确认快照，不同步等待 Windows Agent。
- R4：Relay 为当前线程提供同一版本下的历史、状态和同步信息，避免多个接口返回不同版本。
- R5：Agent 使用文件尾部增量读取和稳定游标生成最近 5 轮、状态及更早分页；禁止为普通查询完整解析数百 MB JSONL。
- R6：同一回合的开始、增量、完成和中止必须按线程 ID、回合 ID、序号和快照版本去重、排序和确认。
- R7：手机发送继续采用 `202 accepted + control-result` 两阶段协议；不得因等待最终回复阻塞发送请求，也不得自动重发有副作用命令。
- R8：Web 与 Android 真机必须在真实公网 Relay、真实官方 Codex Desktop 和 `codex_temp` 对话上完成端到端验收。
- R9：不得新增任何运行时 fallback。Relay 快照缺失或过期时明确显示“同步中/数据未就绪”，不得静默直穿 Agent、猜测完成或切换控制通道。
- R10：只做同步链路性能和一致性治理，不修改公网凭据安全、不重做视觉界面、不改变多设备产品模型。

## Acceptance Criteria

- [ ] AC1：Agent 与手机空闲 60 秒时，`session-updated=0`、历史请求 `=0`、状态请求 `=0`；心跳仍能证明 Agent 在线。
- [ ] AC2：Relay 本地缓存的当前线程视图 P95 小于 200 ms；公网 Web P95 小于 500 ms。
- [ ] AC3：411 MB 真实或等价会话冷启动最近 5 轮小于 1.2 秒、热读取小于 200 ms、峰值 RSS 小于 200 MB。
- [ ] AC4：更早历史每次 5 轮，连续加载 20 页无重复、无丢失、游标稳定，页面滚动位置不跳变。
- [ ] AC5：100 个同线程实时事件突发时，手机最多一个请求在途，完成后最多补一次合并刷新。
- [ ] AC6：手机发送接口响应小于 500 ms，官方 Desktop 在 2 秒内出现同一条用户消息；同一 `clientUserMessageId` 恰好执行一次。
- [ ] AC7：官方 JSONL 写入终态后 2 秒内，Web 与 Android 真机均显示最终回复和“已完成/已停止”，无需手动刷新。
- [ ] AC8：在 `codex_temp` 连续完成 3 轮手机/Web 发送、1 轮手机停止、1 轮电脑手动停止；逐轮核对官方 UI、JSONL、Relay 快照、Web 和手机。
- [ ] AC9：断开 WebSocket 后 5 秒内显示离线；恢复后仅做一次版本核对，不自动发送、不伪造完成、不产生重复消息。
- [ ] AC10：现有自动化测试、静态检查、桌面管理器构建、Web 实测和 Android 真机实测全部通过后才允许提交与发布。

## Out Of Scope

- 公网 Token、管理密码和凭据安全改造。
- 替换 CDP 控制面、引入独立 App Server 或 CLI 执行回合。
- 移动端视觉改版和图片附件传输。
- 为兼容旧客户端增加双路读取或自动降级。

## Risks

- JSONL 可能被追加、截断或出现尾部半行，增量游标必须显式检测并重建该文件索引；这属于主读取算法，不是 fallback。
- Relay 进程重启会丢失内存快照；Agent 重连后必须先完成一次初始快照，手机在此之前明确显示数据未就绪。
- Android 网络栈与 Web 行为不同，必须以真机结果作为最终门禁，Web 结果不能替代真机。

