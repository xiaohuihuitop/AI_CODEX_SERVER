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
- 正常发送和停止由 Codex Desktop 内置 `codex.exe app-server` 完成。Windows Agent 会自动从 `%LOCALAPPDATA%\OpenAI\Codex\bin` 选择最新安装版本，不能依赖 PATH 中的全局 CLI。
- CDP 不是本项目的产品能力，也不是同步和发送的前置条件。Windows 管理器不会为了调试端口关闭、重启或控制 Codex Desktop。

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
- 启动功能：启动或重连 Windows Agent。
- 停止功能：停止 Agent 并关闭自动启动。
- 会话服务：显示本机 App Server 是否已就绪，以及当前使用的内置 Codex 运行时版本。
- 最小化到系统托盘，托盘菜单可恢复窗口或退出管理器。

示例配置：

```text
云端服务器地址：http://example.com:8008
固定 Token：token_replace_with_random_value
设备名称：home-pc
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
npm run start:agent
```

可选同步参数：

```powershell
$env:CODEX_AGENT_SYNC_INTERVAL_MS="2000"
$env:CODEX_AGENT_DISCOVERY_INTERVAL_MS="10000"
$env:CODEX_AGENT_INITIAL_SYNC_LINES="1000"
$env:CODEX_AGENT_CONTROL_SYNC_TIMEOUT_MS="30000"
```

## 旧版 Web 管理入口

```powershell
npm run start:manager
```

该入口用于调试或兼容旧流程，正式使用推荐 Electron 图形管理器。

如果管理器显示 App Server 未就绪，先检查日志中的 `App Server 启动` 行：它必须指向 `%LOCALAPPDATA%\OpenAI\Codex\bin\<版本>\codex.exe`，而不是 npm 全局安装目录。排查手机/Web 展示异常时，应检查会话目录、JSONL 同步和 relay 状态，不能切换到 CDP 控制。

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

`npm run build:manager:win` 在 Electron 打包后会自动检查 `app.asar`，构建产物包含 CDP 控制代码、CDP 重启入口或旧控制脚本时会直接失败。
