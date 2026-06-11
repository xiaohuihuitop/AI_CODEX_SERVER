# Codex Windows Bridge

## 项目定位

Codex Windows Bridge 用于把 Windows 上的 Codex Desktop 对话同步到手机端，并允许手机通过云端 relay 控制电脑端 Codex Desktop。

项目按三端拆分：

```text
desktop/  Windows 桌面管理器、Agent、本机网页和 CDP 控制脚本
server/   云端 relay、网页入口、Docker 部署和 GitHub Actions 构建
app/      Android-only uni-app 手机端
```

## 核心链路

```text
手机 App / 手机网页
        |
        | HTTP API
        v
云端 relay server
        |
        | WebSocket
        v
Windows desktop-agent
        |
        | 本机 CDP 127.0.0.1:9229
        v
Codex Desktop
```

云端只保存会话同步缓存和转发控制指令，不直接访问电脑上的 Codex Desktop。Codex Desktop 的 CDP 端口只监听 Windows 本机 `127.0.0.1:9229`。

## 功能概览

- 手机端查看 Codex Desktop 当前打开的对话。
- 按“文件夹 -> 对话”二级列表选择线程。
- 同步用户消息、最终回复和公开处理过程。
- 手机端支持 Markdown 渲染。
- 手机端可发送消息和停止当前回复。
- Windows 桌面管理器可配置服务器、token、设备名，并启动/停止后台同步。
- 云端 Docker 可通过 `build-*` tag 自动构建镜像 tar 包。

## 开源前隐私说明

当前仓库不内置真实服务器地址、真实 token 或个人域名。文档中的值均为示例：

```text
http://example.com:8008
token_replace_with_random_value
```

部署时必须自行生成 token，并写入服务端 `.env`、桌面端管理器和手机端设置页。不要复用文档里的示例 token。

如果你曾经把带有真实域名或 token 的历史提交推送到公开仓库，请更换旧 token。仅修改当前文件不能清理已经公开过的 Git 历史。

## 快速开始

### 1. 启动云端 relay

```powershell
cd server
npm install
$env:CODEX_CLOUD_TOKENS="token_replace_with_random_value"
$env:PORT="8787"
npm start
```

访问：

```text
http://127.0.0.1:8787/?token=token_replace_with_random_value
```

### 2. 启动 Windows 桌面管理器

```powershell
cd desktop
npm install
npm run start:manager:gui
```

在窗口里填写：

```text
云端服务器地址：http://example.com:8008
固定 Token：token_replace_with_random_value
设备名称：home-pc
```

然后点击“启动功能”。如果 Codex 控制显示不可用，点击“重启 Codex 生效 CDP”。

### 3. 启动 Android 手机端

用 HBuilderX 导入 `app` 目录，运行到 Android 或打包 APK。首次打开后进入“设置”页填写服务器地址和 token。

## Docker 发布

推送 `build-*` tag 会触发 GitHub Actions：

```powershell
git tag build-v1.0
git push origin build-v1.0
```

工作流会构建 `server/` Docker 镜像，并把镜像 tar、`docker-compose.yml`、`env.example` 上传到 GitHub Release。

## 验证

```powershell
cd server
npm install
npm test
npm run check
```

## 目录文档

- [desktop/README.md](desktop/README.md)：Windows 桌面端说明。
- [server/README.md](server/README.md)：云端 relay 和 Docker 部署说明。
- [app/README.md](app/README.md)：Android uni-app 手机端说明。

## 注意事项

- 当前控制链路依赖 Codex Desktop UI 和 CDP，Codex Desktop 版本变化可能影响控制脚本。
- 云端 relay 建议只暴露必要端口，并使用强随机 token。
- 手机端和桌面端必须使用同一个 token 才能打通同一台电脑。
- 多台电脑建议每台电脑使用不同 token。
