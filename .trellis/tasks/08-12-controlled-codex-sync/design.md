# 受控 Codex 双端同步设计

## 架构决策

正式架构改为“单一受控官方客户端”：

```text
手机 App / Web
  -> Relay HTTP + WebSocket
  -> Windows Agent 控制队列
  -> 受控官方 ChatGPT/Codex Desktop（CDP，仅 127.0.0.1）
  -> 官方桌面内置 App Server
  -> 本地 JSONL
  -> Windows Agent 增量读取
  -> Relay 推送
  -> 手机 App / Web
```

独立 `codex.exe app-server` 从产品控制面移除。官方桌面内置 App Server 仍由官方客户端自己管理，但本项目不直接建立第二条 stdio 控制会话。

## 为什么旧 CDP 失败

| 类别 | 旧实现 | 后果 | 新约束 |
| --- | --- | --- | --- |
| 启动契约 | 硬编码 `Codex.exe` / `app\\Codex.exe` | 当前 `ChatGPT.exe` 未被退出，CDP 参数被旧实例吞掉 | 从 Appx 清单解析入口和进程树 |
| 权限边界 | 尝试直接启动 `WindowsApps` EXE | `Access denied`，关闭后无法恢复 | 只通过 `ApplicationActivationManager` 激活包应用 |
| 端口所有权 | 只探测端口是否响应 | 残留或其他程序被误认成 Codex | 绑定启动会话 nonce、PID 与目标页 |
| 线程身份 | 项目名 + 标题 | 重名、改名、分页后误发 | 全链路使用 `threadId`，深链接切换后验证 |
| 发送确认 | 输入框清空或图标变化 | 点击丢失仍返回成功 | 目标 JSONL 出现对应用户消息才确认 |
| 运行状态 | DOM 图标和 spinner | UI 改版后长时间运行或提前完成 | JSONL 事件是终态权威 |
| 测试 | Mock 仍使用过时 `Codex.exe` | 测试通过但真机失败 | 从真实包清单生成 fixture，并跑 Windows E2E |
| 控制面 | CDP 与独立 App Server 轮换 | 两个事件源，双端分裂 | 生产只允许受控官方实例 |

## 组件边界

### ControlledCodexProcess

- 读取 `OpenAI.Codex` 包清单中的 `Application.Id`、`Executable` 与 `EntryPoint`。
- 识别属于该包安装目录的主进程及其完整子进程树。
- 管理器确认框明确提示未发送草稿风险；用户确认后按 Appx 清单路径核对主进程，读取 `Win32_Process` 快照建立完整进程树，按深度从后代到主进程逐 PID 强制终止；仅忽略 Node 明确返回 `ESRCH` 的已退出 PID，其他 PID 错误立即失败并报告；随后等待主进程消失及 CDP 端口实际释放。不使用会被失效 CIM 子 PID 阻断整棵树的 `taskkill /T /F`，也不使用会被托盘行为拦截的窗口关闭消息或对 Packaged Win32 主进程无效的包生命周期终止调用。
- 用 `ApplicationActivationManager.ActivateApplication` 启动包应用并传入固定 CDP 参数。
- CDP 端口从配置读取，但不自动迁移；占用冲突直接失败。
- 启动成功条件：新主进程、正确命令行/会话标识、CDP `/json/list` 出现预期目标、WebSocket 握手与兼容性探针全部通过。

### CodexCdpClient

- 由 Node 单进程维护一条无副作用的 CDP 监控连接，集中处理就绪探测、请求 ID、超时和断线；发送、停止等有副作用命令必须各自创建独立 CDP 会话，命令结束后立即关闭，避免监控连接的排队或半开状态污染控制。
- 只连接 `127.0.0.1`，并验证目标 URL/标题/页面标识。
- 页面操作封装为语义 API：`activateThread(threadId)`、`inspectComposer()`、`sendText()`、`stopTurn()`、`listVisibleThreads()`。
- DOM 兼容性探针失败时整条控制面进入 `incompatible`，不猜测替代选择器。

### DesktopAgentApi

- 所有 UI 命令进入一个 FIFO 队列。
- 命令包含 `commandId/clientUserMessageId`、`threadId` 和内容摘要。
- 发送过程状态固定为 `accepted -> targeting -> injected -> confirmed`；只有 `confirmed` 返回成功。
- `confirmed` 由会话读取器观察目标线程的新用户消息产生；内容摘要、时间窗和命令 ID 用于幂等对账。

### CodexSessionReader

- 继续负责线程元数据、历史、过程和终态解析。
- 侧栏目录来自 CDP 的当前可见线程 ID，再映射本地 JSONL；不以全部 JSONL 反推侧栏。
- JSONL 的 `task_started`、`final_answer`、`task_complete`、`turn_aborted` 是运行状态权威。
- CDP 只提供交互可达性和可见线程，不提供终态判断。

### Relay 与手机/Web

- 保留既有鉴权、缓存和 WebSocket 推送协议。
- Token 仅用于鉴权；鉴权成功后立即解析为稳定 Key ID，Agent、缓存、移动连接和控制命令均使用 Key ID 路由。
- 控制确认扩展为阶段化状态，避免“Relay 已转发”等同于“桌面已发送”。
- Relay 以 `clientUserMessageId` 记录最近控制结果；重复请求只返回原状态，不再次转发。移动端实时断线后通过结果查询恢复，不重新提交副作用命令。
- 受控客户端离线或不兼容时禁用发送与停止并显示具体原因。
- 终态事件触发有限次历史重读，直到最终回复出现或返回明确同步错误；不使用超时伪造完成。

## 端口与所有权

- 默认端口保留配置值，但只允许一个管理器实例持有。
- 启动前通过 TCP 表、进程树和 CDP 目标三重校验。
- 未知 PID 占用时返回 `CDP_PORT_CONFLICT`，记录 PID、可执行路径和命令行，不结束它。
- 管理器启动受控实例时生成 nonce，并通过本机状态文件记录管理器 PID、受控主 PID、端口、目标 ID、启动时间和 Codex 包版本。
- 恢复现有实例时，状态文件、存活 PID、包路径和 CDP 目标必须全部匹配；任一不一致都重新接管或明确失败。

## 兼容性与迁移

1. 先增加受控进程启动和 CDP 探针，不切换手机发送。
2. 在 `codex_temp` 做仅诊断的接管验证：连续启动、线程深链接、草稿检测、JSONL 观察。
3. 验证通过后，将发送/停止从独立 App Server 切到 CDP，并删除独立 App Server 的生产启动。
4. 最后迁移管理器状态和构建门禁，禁止产品入口重新启动独立 App Server。

每一步都必须有可回滚提交。任何真实 E2E 未通过时不进入下一步，也不启用另一控制通道兜底。

兼容性由单一页面结构契约管理，不按官方版本号建立白名单。版本号只用于诊断；唯一主页面目标或 DOM 语义探针失败时，控制面保持未就绪，不猜测其他目标或选择器。

桌面诊断使用最多 500 条的结构化 JSONL，记录组件、事件、命令 ID、线程 ID、回合 ID 和错误码，不记录消息正文、草稿或附件内容。

## 安全

- CDP 仅监听 `127.0.0.1`，手机和服务器永远不能获得调试地址。
- Relay 日志不记录消息正文、草稿正文或附件内容。
- 管理器不结束不属于官方包实例的进程。
- 接管是显式用户动作；开机自启恢复受控模式时仍需满足所有权验证。

## 失败复盘分类

- **B 跨层契约**：控制成功、桌面显示和手机状态没有同一个端到端确认定义。
- **D 测试覆盖缺口**：Mock 使用过时可执行名，没有真实包清单和 Windows 启动测试。
- **E 隐式假设**：假定商店包入口、进程名、DOM 和单实例参数传递长期不变。

预防机制是单一控制面、运行时包清单解析、JSONL 确认、兼容性探针和真实 Windows E2E 门禁。

## 2026-08-14 官方客户端重启故障复盘

- **根因分类：D + E**。此前先后把窗口关闭请求、Appx 包生命周期调用和 `taskkill /T /F` 的命令返回当作进程退出证据，但 Packaged Win32/Electron 并不满足这些隐式假设。
- **直接根因**：`Win32_Process` 中存在已失效的后代 PID；`taskkill /T /F` 处理整棵树时被该 PID 阻断，官方 `ChatGPT.exe` 主进程从未收到终止请求。
- **最终机制**：先冻结完整进程快照，再按深度从后代到主进程逐 PID `SIGKILL`；仅将 Node 明确返回的 `ESRCH` 视为已经退出，其他错误必须携带 PID 失败。主进程消失和 CDP 端口可独占绑定仍是启动新实例前的双重门禁。
- **自动化证据**：进程树、失效 PID、权限错误和端口释放回归测试通过；v0.3.7 对真实管理器 Electron 两层进程树执行终止，7 个进程全部退出且无残留。
- **真实验收**：2026-08-14，用户在 v0.3.7 管理器中点击“重启 Codex 启用 CDP”，官方 Codex 成功退出并重新启动。
- **激活返回值约束**：PowerShell 变量不区分大小写，`$pid` 会命中只读自动变量 `$PID`。应用激活脚本必须使用非保留变量名保存 `ActivateApplication` 返回值，并以 JSON 返回；禁止把“应用已经出现”当作 IPC 调用成功。

## 2026-08-14 CDP 半开连接约束

- WebSocket 的 `readyState=OPEN` 只表示本地套接字未收到关闭帧，不能证明 Codex 页面仍会响应 `Runtime.evaluate`。
- 任一 CDP 请求超时后，当前连接必须立即失效并拒绝全部等待请求；禁止继续复用该套接字。
- 运行时就绪期间每 15 秒执行一次无副作用表达式探测。探测失败后只重建同一 CDP 主链路，不启动 App Server，也不切换控制通道。
- 发送、停止和点击等可能产生副作用的命令失败后不得自动重试，避免重复提交。
- 有副作用命令不得复用监控长连接；每条命令使用独立 CDP 会话，连接失败或命令失败均直接返回同一条业务错误。
- 断线、重连和停止必须共用单一重连定时器与单一健康探测定时器；`stopRuntime()` 必须清理两者。
