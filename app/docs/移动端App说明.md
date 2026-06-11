# 移动端 App 说明

## 定位

`app` 是 Android-only 的 uni-app 手机端客户端。

服务器端网页入口暂时保留，App 不依赖服务器返回页面，只通过服务器数据接口连接云端 relay 和 Windows Agent。

## 三端目录

```text
app/      Android uni-app 手机端
server/          云端 relay 和网页入口
desktop/  Windows 桌面管理器和 Agent
```

修改 `app` 后只需要重新编译手机 App。只要接口协议不变，不需要更新服务器 Docker 镜像。

## 默认配置

- 服务器地址：`http://www.xiaohuihuitop.top:8008`
- Token：`xiaohuihui`

App 内可以在“连接设置”页修改服务器地址和 token，配置保存在手机本地。

## 首版功能

- 检测服务器和电脑 Agent 在线状态
- 按文件夹和对话二级选择 Codex 线程
- 同步当前对话历史
- 渲染常用 Markdown
- 显示处理过程，完成后默认折叠
- 发送消息到电脑端 Codex
- 对话运行中允许停止
- 手动刷新时保留当前阅读位置

## 目录结构

```text
app/
  App.vue
  main.js
  manifest.json
  pages.json
  pages/index/index.vue
  pages/settings/settings.vue
  utils/api.js
  utils/config.js
  utils/markdown.js
```

## HBuilderX 编译

`app` 使用 HBuilderX 原生 uni-app 目录结构，不需要 `npm install`。

在 HBuilderX 中导入 `app` 目录后，直接执行运行到 Android 或 Android App 打包。

当前 `manifest.json` 里的 AppID 是临时占位值 `__UNI__CODEXBRIDGE`。如果 HBuilderX 发行时报 `appid 不存在，请在 manifest.json 中重新获取`，需要在 HBuilderX 的 manifest 可视化页面重新获取真实 DCloud AppID 后再打包。

## 当前服务器接口

App 直接使用现有接口：

- `GET /codex/health`
- `GET /codex/threads?limit=120`
- `GET /codex/history?thread=<threadId>&limit=120`
- `GET /codex/status?thread=<threadId>&since=<since>`
- `POST /send`
- `POST /codex/stop`

鉴权使用请求头：

```text
x-mobile-typer-token: <token>
```
