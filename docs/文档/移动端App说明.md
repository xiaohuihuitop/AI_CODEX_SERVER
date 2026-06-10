# 移动端 App 说明

## 定位

`mobile-app` 是 Android-only 的 uni-app 手机端客户端。

服务器端网页入口暂时保留，App 不依赖服务器返回页面，只通过服务器数据接口连接云端 relay 和 Windows Agent。

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
mobile-app/
  package.json
  src/
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

## 本地运行

```powershell
cd C:\Users\admin\Desktop\codex_temp\codex-windows-bridge\mobile-app
npm install
npm run dev:app
```

## Android 构建

```powershell
cd C:\Users\admin\Desktop\codex_temp\codex-windows-bridge\mobile-app
npm run build:app
```

如需生成可直接安装的 APK，使用本机已有的 HBuilderX/uni-app Android 打包环境打开 `mobile-app` 工程后执行 Android App 打包。

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
