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
