# desktop 电脑端说明

## 定位

`desktop` 是 Windows 电脑端，包含两个正式入口：

- Electron 图形管理器：给普通用户配置和管理同步功能。
- Windows Agent：连接云端 relay，同步 Codex Desktop 当前打开对话。

## 目录结构

```text
  desktop/
  desktop-agent.js              Windows Agent 入口
  desktop-manager-server.js     旧版本地 Web 管理入口
  electron/                     Electron 图形管理器
  scripts/                      仅保留开发期管理器辅助脚本
  src/                          业务模块
  public/                       本机网页端静态文件
  package.json
```

## 前置条件

- Windows 10 或更高版本。
- Node.js 20 或更高版本。
- 已安装 Codex Desktop。
- Windows Agent 通过受控官方 Codex Desktop 完成发送和停止，手机与电脑操作同一个官方界面和同一份会话状态。
- 管理器通过 Appx manifest 识别官方应用，通过 AUMID 启动并注入本机 CDP 参数，不依赖 PATH 中的全局 CLI。
- 受控官方 Codex Desktop 是唯一会话控制面；项目不会启动独立 `codex.exe app-server`，也不会在 CDP 异常时自动回退到另一套实现。

## 安装依赖

```powershell
cd desktop
npm install
```

## 启动图形管理器

```powershell
npm run start:manager:gui
```

图形管理器功能：

- 配置云端服务器地址。
- 配置固定 token。
- 配置设备名。
- 配置 Codex 控制端口，默认 `9230`。
- 启动功能：只启动或重连 Windows Agent、云端连接和会话同步，并连接已经存在的 CDP；不会关闭或重启官方 Codex Desktop。
- 停止功能：停止 Agent 并关闭自动启动。
- 重启 Codex 启用 CDP：明确确认草稿风险后，正常关闭并重新启动官方 Codex Desktop，使配置的 CDP 端口生效；操作结束后恢复原来的 Agent 开启状态。
- 官方客户端：显示受控 Codex Desktop 是否连接，以及当前官方应用版本。
- 最小化到系统托盘，托盘菜单可恢复窗口或退出管理器。

示例配置：

```text
云端服务器地址：http://example.com:8008
固定 Token：token_replace_with_random_value
设备名称：home-pc
Codex 控制端口：9230
```

## 构建 Windows 可执行文件

```powershell
npm run build:manager:win
```

输出目录：

```text
desktop/dist/win-unpacked/
```

可直接运行：

```text
desktop/dist/win-unpacked/Codex Desktop 管理器.exe
```

## 直接启动 Agent

图形管理器是推荐入口。如需命令行调试 Agent：

```powershell
$env:CODEX_CLOUD_URL="http://example.com:8008"
$env:CODEX_DEVICE_TOKEN="token_replace_with_random_value"
$env:CODEX_DEVICE_NAME="home-pc"
$env:CODEX_DEBUG_PORT="9230"
npm run start:agent
```

可选同步参数：

```powershell
$env:CODEX_AGENT_SYNC_INTERVAL_MS="1000"
$env:CODEX_AGENT_CATALOG_CHECK_INTERVAL_MS="1000"
$env:CODEX_AGENT_DISCOVERY_INTERVAL_MS="10000"
$env:CODEX_AGENT_INITIAL_SYNC_LINES="1000"
$env:CODEX_AGENT_CONTROL_SYNC_TIMEOUT_MS="30000"
```

## 旧版 Web 管理入口

```powershell
npm run start:manager
```

该入口用于调试或兼容旧流程，正式使用推荐 Electron 图形管理器。

如果管理器显示官方客户端未连接，应检查日志中的明确错误：

- 控制端口被其他进程占用时直接报错，不会自动更换端口或终止未知进程。
- 官方 Codex 没有启用配置的 CDP 端口时，Agent 只报告 `CDP_NOT_READY`，不会隐式关闭官方应用。用户需要显式点击“重启 Codex 启用 CDP”。
- 显式重启确认框会提示未发送草稿风险；确认后直接执行，不再使用不可靠的 UI Automation 猜测草稿状态。
- CDP 断开后状态会立即变为未连接；Agent 只会按固定间隔重连同一 CDP 目标，恢复后自动写回已连接，不会关闭官方应用、换端口或用独立 App Server 掩盖故障。
- Agent 初次接管失败后会保持运行并定时重试，不再退出为“Agent 未运行”；重试只连接现有 CDP，不涉及官方客户端进程生命周期。
- CDP 实际可访问时直接复用，不依赖 Windows Appx 主进程命令行是否显示启动参数。显式启用 CDP 时仅请求官方窗口正常关闭，不强制终止进程。

## 配置保存位置

图形管理器配置保存到当前 Windows 用户目录：

```text
%USERPROFILE%\.codex-windows-bridge\manager-config.json
```

不要把这个文件提交到 Git，它可能包含真实服务器地址和 token。

## 验证

桌面端主要通过 `server` 下的统一测试覆盖：

```powershell
cd ../server
npm test
npm run check
```

`npm run build:manager:win` 在 Electron 打包后会自动检查 `app.asar`：产物必须包含受控进程、持久 CDP、按 threadId 精确定位和 JSONL 证据确认；包含独立 App Server 控制客户端或旧控制脚本时会直接失败。
