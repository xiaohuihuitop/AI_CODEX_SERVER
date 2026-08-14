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
- 管理器确认框明确提示未发送草稿风险；用户确认后通过 `IPackageDebugSettings.TerminateAllProcesses` 终止目标 Appx 包并等待整个实例退出，不使用会被托盘行为拦截的窗口关闭消息，也不使用 UI Automation 猜测 Electron 编辑器内容。
- 用 `ApplicationActivationManager.ActivateApplication` 启动包应用并传入固定 CDP 参数。
- CDP 端口从配置读取，但不自动迁移；占用冲突直接失败。
- 启动成功条件：新主进程、正确命令行/会话标识、CDP `/json/list` 出现预期目标、WebSocket 握手与兼容性探针全部通过。

### CodexCdpClient

- 由 Node 单进程长连接管理 CDP，请求 ID、超时、断线和事件集中处理，不再每条命令启动 PowerShell 与临时 WebSocket。
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
- 控制确认扩展为阶段化状态，避免“Relay 已转发”等同于“桌面已发送”。
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
