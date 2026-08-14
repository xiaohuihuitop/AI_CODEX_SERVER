# Codex 控制平面契约

## 场景：手机/Web 控制官方 Windows Codex Desktop

### 1. 范围 / 触发条件

- 触发条件：修改手机/Web 发送、停止、线程选择、运行状态、Windows Agent、桌面管理器或打包逻辑。
- 产品不变量：官方 Codex Desktop 是唯一会话执行者。Agent 只控制该官方实例并同步其 JSONL，不得启动第二个 `codex.exe app-server` 执行回合。
- 本次根因：独立 App Server 与官方 Desktop 同时读写会话，导致两套进程内状态和事件流分叉；此前缺少唯一控制面规范及真实双端验收，使实现反复切换。

### 2. 签名

```js
const runtime = new ControlledCodexRuntime({ debugPort, reader });
await runtime.start();
await runtime.sendMessage(threadId, text);
await runtime.stop(threadId);
await runtime.getThreadRuntime(threadId);
```

- `start()`：只连接已经存在的 CDP。当前官方主进程持有配置端口且 `/json/list` 返回目标页面时直接复用；不得依赖 Appx 主进程命令行是否保留 CDP 参数，也不得关闭或重启官方客户端。
- 管理器“启动功能”：只启动或重连 Agent、Relay 和会话同步，并调用上述连接逻辑。
- 管理器“重启 Codex 启用 CDP”：唯一允许重启官方客户端的显式入口；确认框必须明确提示未发送草稿风险，用户确认后直接执行，不再使用 UI Automation 猜测草稿状态。
- `sendMessage(threadId, text)`：按 `threadId` 精确选择官方侧栏线程，点击前精确核对编辑器正文，点击后等待目标 JSONL 新 `task_started/turnId` 证据。
- `stop(threadId)`：按 `threadId` 精确选择线程，点击官方停止按钮，并等待目标 JSONL `turn_aborted` 证据。
- `getThreadRuntime(threadId)`：只读取当前已选线程的官方运行态；不得为了状态轮询切换电脑界面。

### 3. 契约

| 层 | 唯一数据源 / 责任 | 禁止行为 |
| --- | --- | --- |
| 会话执行 | 受控官方 Codex Desktop | 独立 App Server、CLI 或第二实例执行手机回合 |
| 线程定位 | `[data-app-action-sidebar-thread-id="local:<threadId>"]` | 按标题、项目名或列表位置猜测 |
| 发送/停止成功 | 发送使用目标线程新 `task_started/turnId`；停止使用目标线程中断记录 | 仅凭点击成功、按钮变化或超时猜测 |
| 历史/最终状态 | JSONL -> Agent -> Relay | 用 UI 文本替代历史事实 |
| 当前线程实时状态 | 官方编辑器发送/停止按钮 | 查询非当前线程时切换电脑界面 |
| 线程存在性 | Desktop SQLite 侧栏目录 | 扫描所有 JSONL 后把归档线程重新上传 |

环境变量：

- `CODEX_CLOUD_URL`：Relay 地址，必填。
- `CODEX_DEVICE_TOKEN`：设备 Key，必填。
- `CODEX_DEVICE_NAME`：设备名称。
- `CODEX_DEBUG_PORT`：官方客户端本机 CDP 端口，默认 `9230`。

严禁 fallback：CDP、线程定位或 JSONL 确认失败时必须返回明确错误，不得改用独立 App Server、自动换端口、按标题猜线程或伪造完成状态。

### 4. 校验与错误矩阵

| 条件 | 必须行为 |
| --- | --- |
| 非 Windows 平台 | `WINDOWS_ONLY` |
| 未安装官方 Codex 包或 manifest 无入口 | `CODEX_PACKAGE_NOT_FOUND` |
| 配置端口被非目标官方进程占用 | `CDP_PORT_OCCUPIED`；不得终止未知进程或自动换端口 |
| 官方实例无正确 CDP 参数 | `CDP_NOT_READY`；Agent 保持运行并继续探测，提示用户显式点击“重启 Codex 启用 CDP” |
| 当前官方实例持有可用 CDP，但命令行未显示参数 | 直接复用，不得重启 |
| AUMID 启动后 CDP 未就绪 | `CDP_START_FAILED` |
| 侧栏无精确 `threadId` | `THREAD_ROW_NOT_FOUND`；不得按标题选择 |
| 切换后选中 ID 不一致 | `THREAD_SELECTION_FAILED` |
| 编辑器有草稿或线程运行中 | `LOCAL_DRAFT_EXISTS` / `THREAD_ALREADY_RUNNING` |
| 点击发送但目标 JSONL 未出现新回合 | `TURN_START_CONFIRM_TIMEOUT`；不得返回成功 |
| 点击停止但目标 JSONL 未出现中断证据 | `STOP_CONFIRM_TIMEOUT`；不得返回成功 |
| CDP 连接断开 | Agent 和管理器立即显示未连接；仅重连现有 CDP 目标，恢复后再显示已连接；不得重启官方进程、换端口或切换控制面 |

### 5. 正常 / 基准 / 异常案例

- 正常：Web 向 `threadId=A` 发送唯一文本，官方 Desktop 自动选中 A 并显示用户消息和回复，JSONL 出现同一回合，Web 自动刷新到完成。
- 基准：官方实例已由管理器以配置端口启动，Agent 复用进程和持久 CDP，不重启、不创建第二控制服务。
- 初次接管：关闭旧实例时只调用主窗口 `CloseMainWindow()`，不得使用 `Stop-Process -Force`。无法正常退出时显式失败，避免产生 System 持有的残留监听端口。
- 初始化异常：Agent 保持运行并定时重试连接，不因一次失败退出；所有自动重试均不得关闭或重启官方客户端。
- 短暂异常：CDP WebSocket 收到 `1006` 等断线事件时，Agent 立即写入不可控状态并按固定间隔重连同一端口；重连成功后写回 ready 心跳并通知 relay。重连期间不得把 JSONL 同步正常误报为官方客户端可控。
- 异常：两个项目存在同名线程。只能选择属性中精确匹配的 `threadId`；找不到时显式失败。
- 异常：端口已被其他进程监听。管理器显示占用 PID，用户修改配置或处理占用后重试，不做隐式恢复。

### 6. 必需测试

- `server/test/controlled-codex-process.test.js`：Appx 发现、端口所有权、显式确认后的直接重启、AUMID 启动和 CDP 参数。
- `server/test/codex-cdp-client.test.js`：持久连接、请求 ID、断线和协议错误。
- `server/test/codex-desktop-ui-controller.test.js`：精确 threadId、草稿、发送、停止及不切换式状态读取。
- `server/test/codex-session-evidence.test.js`：目标消息时间边界和停止证据。
- `server/test/controlled-codex-runtime.test.js`：连接决策和唯一控制器委托；必须覆盖命令行参数不可见但 CDP 可用时复用，以及 CDP 未就绪和重复探测时重启调用次数始终为零。
- `server/test/control-plane-contract.test.js`：禁止独立 App Server 控制模块重新进入正式源码。
- `desktop/scripts/verify-manager-artifact.js`：对实际 `app.asar` 执行相同控制面约束。
- 真实 E2E：在 `codex_temp` 线程从 Web 连续发送至少 3 轮；逐轮核对官方 UI、JSONL、Web 回复和完成状态。另执行 1 轮 Web 停止及 1 轮官方 Desktop 手动停止。

### 7. 错误与正确做法

#### 错误

```js
// 手机回合由独立进程执行，官方 Desktop 仅共享 JSONL。
await appServer.startTurn(threadId, text);
// 或 CDP 失败后自动回退到上述路径。
```

这会制造两个进程内状态源：手机可能收到回复，但官方 Desktop 不显示；停止和完成状态也会分叉。

#### 正确

```js
const result = await controlledCodex.sendMessage(threadId, text);
if (!result.turnId) throw new Error('目标 JSONL 未确认官方发送');
```

控制动作、官方 UI、JSONL 和 Relay 必须形成同一条可验证证据链。

## 场景：权威目录与手机实时同步

### 1. 范围 / 触发条件

- 触发条件：修改 `openThreadIds`、Relay 缓存、同步游标、移动端分页或实时状态合并。

### 2. 签名

```js
cache.applySync(token, { openThreadIds, sessions, confirmedControlTurnIds });
inspectControlSyncEvidence(sessions, threadId, turnId);
advanceControlSyncState(state, evidence, now);
```

### 3. 契约

- `openThreadIds` 是当前侧栏未归档线程的完整集合；显式空数组表示清空。
- `sessions` 可分批或仅含元数据，不能决定线程是否仍存在。
- 手机发送分两阶段：编辑器正文精确核对且目标 JSONL 出现新回合后确认受理；同一回合最终回复/终态同步后才解除优先同步。
- 手机首次读取最近 5 轮，向上分页继续读取 5 轮，使用稳定 `turn:<turnId>` 游标。
- Relay 与客户端不得用无关线程的版本增长或固定等待时长推断完成。

### 4. 校验与错误矩阵

| 条件 | 必须行为 |
| --- | --- |
| `openThreadIds: []` | 物理清空当前 Key 会话缓存 |
| 缺少 `openThreadIds` | 仅应用增量，不删除其他线程 |
| 增量线程不在权威集合 | 忽略，不复活归档线程 |
| 目标新回合已开始但未结束 | 确认受理并继续优先同步 |
| 目标回合终止 | 上传最终状态并立即清除移动端运行覆盖 |
| Agent 心跳过期 | 移动端显示离线，不继续累计等待时长 |

### 5. 正常 / 基准 / 异常案例

- 正常：手机发送后自动出现用户消息、过程和最终回复，无需手动刷新。
- 基准：目录稳定时只做轻量成员检查及当前批次增量读取。
- 异常：归档线程的迟到增量到达 Relay；缓存不得重建该线程。

### 6. 必需测试

- `server/test/cloud-relay.test.js`：权威清理、迟到增量、Key 隔离、在线穿透和实时终态。
- `server/test/desktop-agent.test.js`：轻量目录、目标优先同步及两阶段确认。
- `server/test/mobile-app.test.js`：五轮分页、消息去重、自动刷新和终态覆盖。
- 真实 E2E：确认回复与停止都能在 Web 自动出现，状态不需要手动刷新。

### 7. 错误与正确做法

#### 错误

新回合开始后立即取消目标线程优先同步，或定时强制将“运行中”改成“完成”。

#### 正确

持续优先读取同一线程，直到观察到同一回合的真实终态；超时只报告异常，不伪造业务状态。
