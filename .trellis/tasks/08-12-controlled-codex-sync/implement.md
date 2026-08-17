# 受控 Codex 双端同步实施计划

## 阶段 1：建立红色反馈环

1. 在 `docs/temp` 建立 Windows E2E 驱动脚本，测试目标固定为 `codex_temp` 中的验收线程。
2. 脚本记录接管前后主进程、包版本、CDP 端口与目标页，并断言手机/Web 发送后官方桌面出现同一标识消息。
3. 先运行现有 App Server 链路，确认脚本能够稳定捕获“JSONL/手机有消息、官方桌面不显示”的红色结果。
4. 将可自动化部分沉淀为 `server/test` 集成测试；真实桌面操作保留为 Windows E2E 门禁。

## 阶段 2：修复受控实例生命周期

1. 重建包清单解析与主进程识别，支持当前 `ChatGPT.exe`，移除可执行名硬编码。
2. 实现包应用激活、进程树退出等待、端口冲突诊断、所有权状态文件和启动阶段日志。
3. 实现监控长连接 `CodexCdpClient`、独立命令会话与兼容性探针。
4. 测试连续 5 次接管/重启、未知端口占用、客户端升级入口变化和异常退出。

## 阶段 3：实现精确控制

1. 使用 `threadId` 和深链接切换线程，并验证当前线程。
2. 实现草稿检测、输入、发送和停止语义操作。
3. 将控制命令串行化并贯穿命令 ID。
4. 以 JSONL 新用户消息作为发送成功确认，贯穿幂等命令 ID；超时明确失败且不自动重放副作用命令。
5. Relay 记录有界控制结果，支持断线后的结果查询与实时重放；同一命令 ID 不得二次转发。

## 阶段 4：切换单一控制面

1. 将 `DesktopAgentApi` 的发送和停止切到 CDP 控制器。
2. 停止生产 Agent 启动独立 App Server；删除其管理器状态与产品入口。
3. 线程列表改为受控侧栏线程 ID 与 JSONL 映射。
4. 保持 JSONL 历史/状态和 Relay WebSocket 推送，补齐终态触发的最终历史收敛。
5. 增加官方版本、唯一主页面和 DOM 结构三层兼容性门禁，以及桌面结构化诊断日志。

## 阶段 5：跨端与构建验证

1. 单元测试：包入口、进程所有权、CDP 协议、线程验证、草稿保护、命令幂等和 JSONL 确认。
2. 集成测试：Relay -> Agent -> 控制队列 -> 会话读取器 -> Relay -> Web/App。
3. Web E2E：连续发送 3 轮、停止、同名线程、自动终态与自动最终回复。
4. Windows 真机 E2E：在官方桌面可见状态下重复同样流程，并截图/日志确认双端一致。
5. 运行 `npm test`、`npm run check`、PowerShell 语法检查、管理器构建和产物扫描。
6. 构建路径固定为 `desktop/dist`，文件名固定为 `Codex Desktop 管理器.exe`。

## 验证命令

具体命令在阶段 1 的红色反馈环建立后固化；至少包含：

```powershell
npm test
npm run check
npm run build:manager:win
```

真实 E2E 必须输出机器可判定的 PASS/FAIL 和关联命令 ID，不能只凭人工目视汇报完成。

## 风险文件

- `desktop/electron/main.js`：管理器生命周期和接管入口。
- `desktop/desktop-agent.js`：控制面启动与实时同步。
- `desktop/src/desktop-agent-api.js`：发送、停止和命令队列。
- 新的受控进程/CDP 模块：进程与误操作风险最高。
- `desktop/src/codex-session-reader.js`：侧栏目录映射与 JSONL 确认。
- `server/src/cloud-relay.js`、`server/public/index.html`、`app/pages/index/index.vue`：跨端确认和状态收敛。

## 回滚条件

- 接管启动不能连续 5 次成功：停止，不切换发送链路。
- 无法按 `threadId` 验证目标线程：停止，不允许标题 fallback。
- JSONL 无法确认发送：返回失败，不把点击当作成功。
- 官方升级导致兼容性探针失败：保持功能未就绪，不启动独立 App Server 兜底。

## 2026-08-15 验证记录

- Relay 结果恢复链路：浏览器在发送后断开实时连接，Agent 在断线期间完成命令；重连后自动恢复最终回复，无需手动刷新，也未二次转发发送。
- 当前官方 Codex Desktop `26.707.3748.0`：只读 CDP 探针通过，唯一主页面、线程行、可见编辑器和动作按钮均匹配兼容档案。
- 自动化测试：`npm test` 通过，232/232。
- 静态检查：`npm run check` 与 `git diff --check` 通过。
- Windows 管理器：固定目录构建成功，`app.asar` 控制平面扫描通过；产物名称为 `Codex Desktop 管理器.exe`，版本为 `0.3.15`。
- 兼容性检测：真实打包产物点击检测后读取当前官方 Codex `26.707.3748.0`、CDP `9235`、19 条侧栏线程、编辑器和动作按钮，结论为兼容。
- Android 真机仍需用户使用 HBuilderX 调试基座验证本轮自动恢复行为；未以 Web 验证替代真机结论。
- 官方 Codex `26.810.7004.0` 会同时暴露精确主页面与 `initialRoute=%2Favatar-overlay` 辅助页面；目标选择现只接受 URL 精确等于 `app://-/index.html` 的唯一主页面。真实双目标 fixture 已加入回归测试，避免辅助页面再次造成 `CDP_TARGET_NOT_FOUND`。
- 官方 Codex `26.810.7004.0` 在另一台 Windows 电脑完成只读兼容检测：CDP 连接成功，识别 24 条侧栏线程，编辑器与发送/停止按钮均通过。
- 2026-08-16 起取消官方版本白名单：版本号仅保留在诊断报告中，正式控制只由唯一主页面、线程行、可见编辑器和动作按钮组成的 `codex-desktop-structural-v1` 契约决定。

## 2026-08-17 CDP 端口残留复发分析

### 根因分类

- 分类：隐式假设 + 测试覆盖缺口。
- 具体原因：显式重启无条件强制终止 Electron 进程树，默认假设 Windows 会同步释放 CDP socket。现场出现 `127.0.0.1:9235` 持续监听、记录 PID `316936` 已不存在、HTTP 连接超时的反例；该形态与继承或复制的 socket 句柄未随原进程退出一致。
- 之前修复只加强了进程树枚举、退出等待和端口等待，能阻止重叠启动，但没有改变“健康 CDP 也被强杀”的根因，因此最终只是把错误稳定暴露为 `CDP_PORT_RELEASE_TIMEOUT`。

### 预防机制

- 架构：已有健康 CDP 时使用标准 `Browser.close` 优雅退出；只有旧实例没有可用 CDP 时才终止已核对的官方进程树。
- 运行时：监听 PID 无法查询时返回 `CDP_PORT_ORPHANED`，不再丢弃所有权证据后空等。
- 测试：覆盖 Codex 未运行直接启动、`Browser.close` 协议、健康 CDP 不进入强杀路径、孤儿监听拒绝启动。
- 规范：`.trellis/spec/backend/codex-control-plane.md` 已固化上述分支和错误矩阵；运行时仍禁止换端口，用户确认的显式重启允许迁移到系统空闲回环端口。

### 验证结果

- 定向生命周期测试：17/17 通过。
- 全量自动化测试：239/239 通过。
- `npm run check`、`node --check desktop/src/controlled-codex-process.js`、`git diff --check` 通过。
- 固定目录管理器构建和 `app.asar` 扫描通过，版本 `0.3.17`；打包源码包含 `Browser.close` 和 `CDP_PORT_ORPHANED`。
- 本机只读复核确认 `9235` 为真实系统残留监听；本轮未自动换端口，也未重启官方 Codex Desktop。

## 2026-08-17 显式重启端口自愈

- 参考 CodexPlusPlus 的启动器职责划分：配置端口作为首选端口；Windows 无法绑定且该端口不是有效 Codex CDP 时，由系统分配空闲回环端口。本项目仅借鉴思路，保留自身的包进程归属、用户确认和 Agent 生命周期契约。
- 只有“重启 Codex 启用 CDP”允许端口迁移；Agent 日常重连不得换端口或重启官方客户端。
- 覆盖三条现场路径：启动前其他进程占用、启动前孤儿监听、旧实例退出后端口仍未释放。
- 新 Codex 的 CDP 目标验证成功后，管理器保存实际端口并用同一配置启动 Agent；失败前不得写入新端口。
