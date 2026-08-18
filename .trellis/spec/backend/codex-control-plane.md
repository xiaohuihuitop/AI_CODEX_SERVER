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
await inspectCodexDesktopCompatibility({ debugPort });
```

- `start()`：只连接已经存在的 CDP。当前官方主进程持有配置端口且 `/json/list` 返回目标页面时直接复用；不得依赖 Appx 主进程命令行是否保留 CDP 参数，也不得关闭或重启官方客户端。
- 管理器“启动功能”：只启动或重连 Agent、Relay 和会话同步，并调用上述连接逻辑。
- 管理器“重启 Codex 启用 CDP”：唯一允许重启官方客户端的显式入口；确认框必须明确提示未发送草稿风险，用户确认后直接执行，不再使用 UI Automation 猜测草稿状态。
- `ControlledCodexProcess.restart({ debugPort })`：官方客户端未运行且端口可独占绑定时直接通过 AUMID 激活；已有可用 CDP 时先发送 `Browser.close` 并确认主进程退出；已有官方进程但 CDP 不可用时才终止已核对的官方进程树。任何关闭方式完成后，都必须确认主进程消失且端口可独占绑定，再允许激活新实例。
- `sendMessage(threadId, text)`：为该命令创建独立 CDP 控制会话，按 `threadId` 精确选择官方侧栏线程，点击前精确核对编辑器正文，点击后等待目标 JSONL 新 `task_started/turnId` 证据；命令结束后关闭该控制会话。
- `stop(threadId)`：为该命令创建独立 CDP 控制会话，按 `threadId` 精确选择线程，点击官方停止按钮，并等待目标 JSONL `turn_aborted` 证据；命令结束后关闭该控制会话。
- `getThreadRuntime(threadId)`：只读取当前已选线程的官方运行态；不得为了状态轮询切换电脑界面。
- `inspectCodexDesktopCompatibility({ debugPort })`：管理器使用固定页面结构契约执行只读 CDP 和 DOM 检测，返回官方版本、PID、契约 ID、侧栏线程数、编辑器及动作按钮结果；版本号只用于诊断，不参与控制结论。
- 长连接 CDP 只负责就绪探测和无副作用状态读取，不得承载发送、停止等有副作用命令；命令失败不得自动重放。

### 3. 契约

| 层 | 唯一数据源 / 责任 | 禁止行为 |
| --- | --- | --- |
| 会话执行 | 受控官方 Codex Desktop | 独立 App Server、CLI 或第二实例执行手机回合 |
| 线程定位 | `[data-app-action-sidebar-thread-id="local:<threadId>"]` | 按标题、项目名或列表位置猜测 |
| 发送/停止成功 | 发送使用目标线程新 `task_started/turnId`；停止使用目标线程中断记录 | 仅凭点击成功、按钮变化或超时猜测 |
| 历史/最终状态 | JSONL -> Agent -> Relay | 用 UI 文本替代历史事实 |
| 当前线程实时状态 | 官方编辑器发送/停止按钮 | 查询非当前线程时切换电脑界面 |
| 线程存在性 | Desktop SQLite 侧栏目录 | 扫描所有 JSONL 后把归档线程重新上传 |
| 会话文件解析 | 专用 Worker 线程 | 在 CDP、Agent WebSocket 所在主线程解析大型 JSONL |

Desktop 会话可长期增长到数百 MB。目录映射只能读取文件名、索引、`session_meta` 头部和文件
元数据；后台快照、完整历史和状态解析必须在专用 Worker 中执行，禁止阻塞 CDP 与 Agent
WebSocket 所在事件循环。发送和停止的落盘确认只允许从文件尾部查找控制开始时间后的目标事件，
不得为确认一次控制动作重放完整历史。

环境变量：

- `CODEX_CLOUD_URL`：Relay 地址，必填。
- `CODEX_DEVICE_TOKEN`：设备 Key，必填。
- `CODEX_DEVICE_NAME`：设备名称。
- `CODEX_DEBUG_PORT`：官方客户端本机 CDP 端口，默认 `9230`。

严禁运行时 fallback：CDP、线程定位或 JSONL 确认失败时必须返回明确错误，不得改用独立 App Server、在后台自动换端口、按标题猜线程或伪造完成状态。只有用户确认“重启 Codex 启用 CDP”后，启动事务才允许在首选端口不可用时选择空闲回环端口。

Relay 路由不变量：Token 只用于入口鉴权。鉴权成功后必须解析为稳定 Key ID，Agent、会话缓存、移动连接和控制结果均以 Key ID 为内部主键；不得把可修改的 Token 字符串作为跨层设备身份。

Relay Key 持久化不变量：`/data/keys.json` 必须挂载到名称固定为 `codex-relay-data` 的 Docker 数据卷。不得使用相对发布目录的 `./data:/data`，否则更换 Compose 项目名或发布目录会创建新的空 Key 仓库。镜像更新和容器重建不得删除该卷；禁止在常规更新中执行 `docker-compose down -v`。从旧绑定目录首次迁移时，必须先显式备份当前容器的 `/data/keys.json`，新卷创建后恢复文件并重启容器，不得把环境变量迁移当作已有 Key 数据的备份。

兼容性不变量：CDP 连接前只允许一个匹配配置端口、URL 精确等于 `app://-/index.html` 的主页面。带 `initialRoute` 等查询参数的快捷窗口、头像浮层及其他辅助页面不得计入主页面候选；出现多个精确主页面仍必须拒绝。连接后必须验证线程行、可见编辑器和动作按钮；任何一项不满足都返回明确不兼容错误，不猜测备用目标或选择器。官方版本号只记录到诊断报告，不得作为放行或拒绝条件。

当前控制契约：`codex-desktop-structural-v1`。契约只包含唯一主页面 URL 和已验证的语义选择器；官方客户端更新后，只要结构探针通过即可控制。

兼容性检测报告字段固定包含 `checkedAt`、`debugPort`、`version`、`pid`、`contractId`、`cdpConnected`、`threadRows`、`editor`、`action`、`pageCompatible`、`compatible`、`status`、`stage`、`errorCode` 和 `message`。检测只允许 `Runtime.evaluate` 读取页面，不得点击、输入或切换线程。

### 4. 校验与错误矩阵

| 条件 | 必须行为 |
| --- | --- |
| 非 Windows 平台 | `WINDOWS_ONLY` |
| 未安装官方 Codex 包或 manifest 无入口 | `CODEX_PACKAGE_NOT_FOUND` |
| 显式重启时首选端口被非目标进程占用 | 不终止未知进程；由系统选择空闲回环端口，启动成功后记录原 PID 并保存实际端口 |
| 显式重启时首选端口有监听但监听 PID 已不存在 | 不等待或终止孤儿监听；由系统选择空闲回环端口，启动成功后记录残留 PID 并保存实际端口 |
| 官方客户端未运行且配置端口可绑定 | 直接通过 AUMID 携带 CDP 参数启动，不执行任何关闭逻辑 |
| 官方客户端正在运行且配置端口为健康 CDP | 发送 `Browser.close` 优雅退出并等待；不得直接强制终止健康 CDP 实例 |
| 官方进程树无法终止或主进程未退出 | `CODEX_PROCESS_TREE_TERMINATION_FAILED` / `CODEX_STOP_TIMEOUT`；不得继续启动新实例 |
| 显式重启中旧实例退出后首选端口仍不可绑定 | 选择空闲回环端口继续启动；只有空闲端口选择或复核失败时返回 `CDP_PORT_SELECTION_FAILED` |
| 官方实例无正确 CDP 参数 | `CDP_NOT_READY`；Agent 保持运行并继续探测，提示用户显式点击“重启 Codex 启用 CDP” |
| 当前官方实例持有可用 CDP，但命令行未显示参数 | 直接复用，不得重启 |
| 任意官方版本且页面结构契约匹配 | 检测报告返回 `status=compatible`、`compatible=true`；版本号仅供诊断 |
| 兼容性检测无法连接 CDP | 报告保留 `stage=cdp`、具体 `errorCode` 和错误信息；不得重启 Codex 或切换控制通道 |
| AUMID 启动后 CDP 未就绪 | `CDP_START_FAILED` |
| 侧栏无精确 `threadId` | `THREAD_ROW_NOT_FOUND`；不得按标题选择 |
| 切换后选中 ID 不一致 | `THREAD_SELECTION_FAILED` |
| 编辑器有草稿或线程运行中 | `LOCAL_DRAFT_EXISTS` / `THREAD_ALREADY_RUNNING` |
| 点击发送但目标 JSONL 未出现新回合 | `TURN_START_CONFIRM_TIMEOUT`；不得返回成功 |
| 点击停止但目标 JSONL 未出现中断证据 | `STOP_CONFIRM_TIMEOUT`；不得返回成功 |
| CDP 连接断开 | Agent 和管理器立即显示未连接；仅重连现有 CDP 目标，恢复后再显示已连接；不得重启官方进程、换端口或切换控制面 |
| CDP WebSocket 保持 `OPEN` 但请求超时 | 将当前连接整体标记失效并拒绝全部等待请求；重新连接同一目标，不得继续复用半开连接 |

### 5. 正常 / 基准 / 异常案例

- 正常：Web 向 `threadId=A` 发送唯一文本，官方 Desktop 自动选中 A 并显示用户消息和回复，JSONL 出现同一回合，Web 自动刷新到完成。
- 基准：官方实例已由管理器以配置端口启动，Agent 复用进程和持久 CDP，不重启、不创建第二控制服务。
- 初次接管：先用 Appx 清单路径核对官方主进程。若官方客户端未运行，端口可绑定后直接激活；若配置端口已有健康 CDP，通过标准 `Browser.close` 退出，避免强杀 Electron 后遗留继承的监听句柄；只有官方进程正在运行但 CDP 不可用时，才读取 `Win32_Process` 快照建立完整子树并按深度从后代到主进程逐 PID 终止。进程树终止仅忽略 Node 明确返回 `ESRCH` 的已退出 PID，其他 PID 错误必须中止并报告。任一路径都必须同时确认主进程消失且配置端口能够在 `127.0.0.1` 独占绑定，才允许重新激活。不得使用会被失效 CIM 子 PID 阻断整棵树的 `taskkill /T /F`，也不得使用会被托盘行为拦截的 `CloseMainWindow()` 或对 Packaged Win32 主进程无效的 `IPackageDebugSettings.TerminateAllProcesses()`。
- 初始化异常：Agent 保持运行并定时重试连接，不因一次失败退出；所有自动重试均不得关闭或重启官方客户端。
- 短暂异常：CDP WebSocket 收到 `1006` 等断线事件，或任一 CDP 请求超时时，Agent 立即写入不可控状态并使当前连接整体失效，再按固定间隔重连同一端口；重连成功后写回 ready 心跳并通知 relay。`readyState=OPEN` 只代表本地套接字未收到关闭帧，不能作为页面可响应的证据。
- 空闲探测：运行时处于 `ready` 时每 15 秒执行一次无副作用的 `Runtime.evaluate`。探测失败只重建同一 CDP 连接；发送、停止和点击等有副作用的业务命令失败后不得自动重放，避免重复提交。
- 兼容检测：新版页面仍满足唯一主页面、线程、编辑器和动作按钮契约时，管理器显示“兼容，可以控制”，Agent 正常进入就绪。
- 异常：两个项目存在同名线程。只能选择属性中精确匹配的 `threadId`；找不到时显式失败。
- 异常：端口已被其他进程监听。管理器显示占用 PID，用户修改配置或处理占用后重试，不做隐式恢复。

### 6. 必需测试

- `server/test/controlled-codex-process.test.js`：Appx 发现、端口所有权、孤儿监听诊断、未运行直接启动、健康 CDP `Browser.close`、进程树终止、AUMID 启动和 CDP 参数。
- `server/test/codex-cdp-client.test.js`：持久连接、请求 ID、断线、协议错误，以及半开连接请求超时后的整体失效。
- `server/test/codex-desktop-ui-controller.test.js`：精确 threadId、草稿、发送、停止及不切换式状态读取。
- `server/test/codex-session-evidence.test.js`：目标消息时间边界和停止证据。
- `server/test/codex-session-reader-worker.test.js`：Worker 历史、状态、同步快照与游标回写。
- `server/test/controlled-codex-runtime.test.js`：连接决策和唯一控制器委托；必须覆盖命令行参数不可见但 CDP 可用时复用、CDP 未就绪和重复探测时重启调用次数始终为零，以及空闲半开连接由健康探测识别并自动重连。
- `server/test/control-plane-contract.test.js`：禁止独立 App Server 控制模块重新进入正式源码。
- `desktop/scripts/verify-manager-artifact.js`：对实际 `app.asar` 执行相同控制面约束。
- Windows 生命周期门禁：必须先用同一产物算法终止一个真实 Electron 两层进程树并确认零残留，再由用户对官方 Codex 执行一次显式重启，核对主 PID 已更换、CDP 端口可访问；只看到窗口消失或命令返回成功不得判定通过。
- 真实 E2E：在 `codex_temp` 线程从 Web 连续发送至少 3 轮；逐轮核对官方 UI、JSONL、Web 回复和完成状态。另执行 1 轮 Web 停止及 1 轮官方 Desktop 手动停止。
- 大文件性能门禁：使用真实或等价的数百 MB 会话执行后台快照时，主线程 100ms 探针的最大附加延迟
  不得超过 100ms，且同期间 CDP `/json/list` 必须正常返回；只验证解析最终完成不算通过。

### 7. 错误与正确做法

#### 错误

```js
// 手机回合由独立进程执行，官方 Desktop 仅共享 JSONL。
await appServer.startTurn(threadId, text);
// 或 CDP 失败后自动回退到上述路径。
```

这会制造两个进程内状态源：手机可能收到回复，但官方 Desktop 不显示；停止和完成状态也会分叉。

```js
// 错误：健康 CDP 已经可控时仍直接强制终止整个 Electron 进程树。
await processStopper(app, processes);
```

强制终止可能让被继承或复制的 CDP socket 句柄残留，表现为监听 PID 已不存在、端口仍无法绑定。

```js
// 错误：只看版本号，不验证实际可控结构。
if (knownVersions.includes(version)) allowControl();
```

#### 正确

```js
const result = await controlledCodex.sendMessage(threadId, text);
if (!result.turnId) throw new Error('目标 JSONL 未确认官方发送');

// 正确：版本只用于诊断，正式控制由实际页面结构决定。
const report = await inspectCodexDesktopCompatibility({ debugPort });
if (!report.compatible) throw new Error('官方页面结构不满足控制契约');

// 正确：进程不存在时直接启动；健康 CDP 先优雅退出。
if (processes.length === 0) await activateCodexApplication(app, args);
else if ((await probeCdp(debugPort)).ok) await closeCodexThroughCdp(debugPort);
```

控制动作、官方 UI、JSONL 和 Relay 必须形成同一条可验证证据链。

## 场景：权威目录与手机实时同步

### 1. 范围 / 触发条件

- 触发条件：修改 `openThreadIds`、Relay 缓存、同步游标、移动端分页或实时状态合并。

### 2. 签名

```js
cache.applySync(token, { openThreadIds, sessions, confirmedControlTurnIds });
cache.threadView(token, threadId, limit, since);
inspectControlSyncEvidence(sessions, threadId, turnId);
advanceControlSyncState(state, evidence, now);
```

### 3. 契约

- `openThreadIds` 是当前侧栏未归档线程的完整集合；显式空数组表示清空。
- `sessions` 可分批或仅含元数据，不能决定线程是否仍存在。
- 手机发送分两阶段：编辑器正文精确核对且目标 JSONL 出现新回合后确认受理；同一回合最终回复/终态同步后才解除优先同步。
- 手机 `/send` 使用传输与业务两阶段确认：Relay 校验 Agent 在线并将命令写入 Agent WebSocket 后立即返回 `202 accepted`；Agent 形成目标 JSONL 新回合或明确失败后，Relay 必须通过 `/mobile` 实时通道发送带同一 `clientUserMessageId` 的 `control-result`。客户端不得让 HTTP 请求等待整个 CDP 控制过程，也不得因 HTTP 超时把已提交文本恢复到输入框。
- Relay 必须为 `clientUserMessageId` 保存有界结果记录。相同 ID 与相同内容重复请求只返回既有状态，不再次发送给 Agent；相同 ID 与不同内容返回冲突。移动端重连或确认超时后只查询该记录，不重新提交发送。
- 控制结果记录至少包含状态、命令 ID、线程 ID、回合 ID 和错误码；不得包含消息正文。当前实现保留 30 分钟、每台设备最多 500 条，Relay 进程重启后不承诺保留。
- 手机首次读取最近 5 轮，向上分页继续读取 5 轮，使用稳定 `turn:<turnId>` 游标。
- Relay 与客户端不得用无关线程的版本增长或固定等待时长推断完成。
- Agent 心跳与数据同步是两个协议：`session-heartbeat` 只刷新在线新鲜度；`session-sync` 只在 `catalogChanged`、`sessions`、`changedThreadIds` 或 `confirmedControlTurnIds` 至少一项非空时发送。
- Relay 仅在目录、线程快照或新控制确认真实变化时递增 `syncVersion` 并广播 `session-updated`。重复快照和心跳不得升版本，也不得触发历史刷新。
- `GET /codex/thread-view?thread=<id>&limit=5&since=<timestamp>` 必须从同一个 Relay 缓存版本返回 `messages`、`status`、`active`、`turns`、`hasMore`、`nextBefore`、`updatedAt` 和 Relay 同步字段；普通当前历史和状态读取不得同步等待 Agent。
- `session-updated` 必须携带 `catalogChanged` 和 `changedThreadIds`。目录未变化时客户端不得重拉线程列表；当前线程不在变化集合时不得重拉正文。
- 最近历史与状态必须从有界尾部投影读取。更早分页可以携带明确的 `before` 游标请求 Agent，但不得把该路径用作当前视图的自动 fallback。

### 4. 校验与错误矩阵

| 条件 | 必须行为 |
| --- | --- |
| `openThreadIds: []` | 物理清空当前 Key 会话缓存 |
| 缺少 `openThreadIds` | 仅应用增量，不删除其他线程 |
| 增量线程不在权威集合 | 忽略，不复活归档线程 |
| 目标新回合已开始但未结束 | 确认受理并继续优先同步 |
| 目标回合终止 | 上传最终状态并立即清除移动端运行覆盖 |
| Agent 心跳过期 | 移动端显示离线，不继续累计等待时长 |
| 同一 `clientUserMessageId` 重复发送相同内容 | 返回既有受理或终态，不再次转发 |
| 同一 `clientUserMessageId` 对应不同内容 | `CLIENT_USER_MESSAGE_ID_CONFLICT` |
| 实时确认丢失但结果记录存在 | 客户端查询并应用结果，不重发消息 |
| `session-heartbeat` 到达且缓存已初始化 | 只刷新同步新鲜度；版本和正文保持不变 |
| 重复 `session-sync` 没有语义变化 | 返回确认但 `changed=false`，不广播 `session-updated` |
| 当前线程快照尚未同步 | 原子视图明确返回不可用/未就绪状态，不直穿 Agent |
| `session-updated.changedThreadIds` 不含当前线程 | 只合并轻量目录状态，不请求当前正文 |

### 5. 正常 / 基准 / 异常案例

- 正常：手机发送后自动出现用户消息、过程和最终回复，无需手动刷新。
- 基准：目录稳定时只做轻量成员检查及当前批次增量读取。
- 基准：首轮最近 5 轮快照在专用 Worker 解析；建立偏移后仅上传新增 JSONL 行，不得为每次文件
  追加重新解析最近历史。
- 异常：归档线程的迟到增量到达 Relay；缓存不得重建该线程。
- 基准：空闲 60 秒内允许心跳，不允许产生 `session-updated`、历史请求或状态请求。
- 基准：同线程实时事件突发时，客户端最多一个当前视图请求在途；在途期间的事件合并为一次后续刷新。
- 异常：Relay 已有当前线程快照但 Agent 查询阻塞；原子线程视图仍必须只读缓存并立即返回。

### 6. 必需测试

- `server/test/cloud-relay.test.js`：权威清理、迟到增量、Key 隔离、控制结果、重复命令、实时终态、重复同步不升版本，以及原子线程视图不请求 Agent。
- `server/test/entrypoints.test.js`：部署入口必须将 `/data` 挂载到固定命名卷 `codex-relay-data`，禁止恢复为相对发布目录绑定。
- `server/test/desktop-agent.test.js`：轻量目录、目标优先同步、两阶段确认、空闲不发送 `session-sync`、独立心跳和同步 dirty latch。
- `server/test/mobile-app.test.js`：五轮分页、消息去重、自动终态、single-flight、变化范围合并，以及 30 秒健康核对不读取历史。
- `server/test/codex-desktop-compatibility.test.js`：单一结构契约、唯一主页面、端口匹配，以及真实 `initialRoute=%2Favatar-overlay` 辅助页面与主页面并存时的目标选择。
- `server/test/codex-desktop-compatibility-report.test.js`：任意版本通过结构检测后放行、版本诊断字段、CDP 失败阶段和错误码保留。
- `server/test/desktop-manager.test.js`：兼容性检测 IPC、检测按钮、结果展示和复制入口完整。
- `server/test/structured-diagnostics.test.js`：结构化字段、敏感正文排除和 500 条上限。
- 真实 E2E：确认回复与停止都能在 Web 自动出现，状态不需要手动刷新。

### 7. 错误与正确做法

#### 错误

新回合开始后立即取消目标线程优先同步，或定时强制将“运行中”改成“完成”。

```js
// 错误：心跳被当成正文变化，所有手机反复重读目录、历史和状态。
broadcast({ type: 'session-updated' });
```

#### 正确

持续优先读取同一线程，直到观察到同一回合的真实终态；超时只报告异常，不伪造业务状态。

```js
// 正确：只广播已经原子应用到缓存的真实变化范围。
if (result.changed) {
  broadcast({
    type: 'session-updated',
    catalogChanged: result.catalogChanged,
    changedThreadIds: result.changedThreadIds,
  });
}
```
