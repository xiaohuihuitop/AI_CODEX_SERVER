# App Server 控制通道固化设计

## 架构决策

| 能力 | 唯一责任方 | 禁止替代方案 |
| --- | --- | --- |
| 发送、停止、回合运行态 | Desktop 内置 `codex.exe app-server` | CDP、DOM 自动化、重启 Codex |
| 未归档线程目录 | Desktop 本地会话目录与 JSONL 映射 | App Server `thread/list` 直接替代侧栏目录 |
| 历史与状态投影 | 本地 JSONL -> Agent -> relay -> Web/App | 通过桌面 UI 推断消息或运行态 |
| 管理器会话服务状态 | Agent 写入的 App Server 心跳 | 进程存在、CDP 端口存在 |

## 删除边界

以下文件属于旧 CDP 控制路径，不再打包或保留为产品入口：

- `desktop/server.js`
- `desktop/src/windows-codex-controller.js`
- `desktop/src/codex-desktop-process.js`
- `desktop/scripts/win-codex-control.ps1`

管理器的 `codex-desktop-manager-gui.ps1` 仅用于旧 GUI 外壳，不得读取 CDP、启动/关闭 Codex 或控制线程。

## 防回归策略

1. 静态入口测试检查 Agent、API、Electron 主进程、预加载脚本、渲染器和打包清单。
2. 测试禁止以下标识进入正式路径：`WindowsCodexController`、`restartCodexDesktopWithDebug`、`CODEX_DEBUG_PORT`、`remote-debugging-port`、`win-codex-control.ps1`。
3. 测试要求正式路径保留 `createCodexAppServerClient`、`resumeThread`、`startTurn`、`interruptTurn`。
4. 构建后检查 `app.asar`；这是发布验证而非仅源码检查。

## 兼容性

- `npm start` 统一启动 `desktop-agent.js`，不再启动旧本地 CDP 桥接服务。
- 已配置的管理器不需要迁移配置；旧 `debugPort` 配置继续被忽略。
- 发生手机/Web 展示异常时，只允许排查同步、目录或状态投影层，不能替换控制通道。
