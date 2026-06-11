# desktop 电脑端说明

## 定位

`desktop` 是 Windows 电脑端，包含三个入口：

- Electron 图形管理器：给普通用户配置和管理同步功能。
- Windows Agent：连接云端 relay，同步 Codex Desktop 当前打开对话。
- 本机网页服务：用于局域网调试或不经过云端的本机模式。

## 目录结构

```text
desktop/
  desktop-agent.js              Windows Agent 入口
  desktop-manager-server.js     旧版本地 Web 管理入口
  server.js                     本机局域网网页服务入口
  electron/                     Electron 图形管理器
  scripts/                      PowerShell CDP 控制脚本
  src/                          业务模块
  public/                       本机网页端静态文件
  package.json
```

## 前置条件

- Windows 10 或更高版本。
- Node.js 20 或更高版本。
- 已安装 Codex Desktop。
- Codex Desktop 需要通过 `127.0.0.1:9229` 开放 CDP 调试端口。

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
- 重启 Codex 生效 CDP：重启 Codex Desktop 并附加本机 CDP 参数。
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
```

## 本机局域网网页服务

```powershell
npm start
```

默认监听：

```text
0.0.0.0:8787
```

启动日志会输出本机和局域网访问地址。局域网模式主要用于调试，云端部署建议使用 `server`。

## 旧版 Web 管理入口

```powershell
npm run start:manager
```

该入口用于调试或兼容旧流程，正式使用推荐 Electron 图形管理器。

## CDP 控制

控制脚本位于：

```text
desktop/scripts/win-codex-control.ps1
```

它通过 Codex Desktop 的本机 CDP 端口读取当前打开窗口，并在对应线程里输入和发送消息。当前没有其他控制路径。

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

PowerShell 控制脚本语法检查：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$null = [scriptblock]::Create((Get-Content -LiteralPath '..\desktop\scripts\win-codex-control.ps1' -Raw)); 'ok'"
```
