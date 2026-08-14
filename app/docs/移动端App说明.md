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

默认不内置服务器地址和 token。首次启动后需要进入“设置”页填写自己的云端地址和 token，例如：

```text
服务器地址：http://example.com:8008
Token：token_replace_with_random_value
```

App 内可以在“设备设置”页管理多台电脑。每台电脑保存设备名称、服务器地址和独立 Token，配置只保存在手机本地。

旧版本保存的单设备配置会在首次启动时迁移为“我的电脑”，并保留最后选择的项目和对话。

## 首版功能

- 检测服务器和电脑 Agent 在线状态
- 首页顶部切换已保存设备
- 设置页新增、编辑、删除和测试设备连接
- 按文件夹和对话二级选择 Codex 线程
- 同步当前对话历史
- 渲染常用 Markdown
- 显示处理过程，完成后默认折叠
- 发送消息到电脑端 Codex
- 对话运行中允许停止
- 手动刷新时保留当前阅读位置

## 多设备切换规则

- 首页顶部弹窗只负责切换已有设备，设备管理统一放在设置页。
- 一台电脑使用一个 Token，同一个 Token 不同时连接多台 Agent。
- 每台设备独立保存最后选择的项目和对话。
- 切换设备时先终止旧设备请求、轮询和实时连接，再读取目标设备数据。
- 输入框存在未发送草稿时禁止切换，并提示“请先发送或清空草稿”。
- 切换失败时停留在目标设备的错误状态，不自动回退或尝试其他 Token。

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

当前 `manifest.json` 已配置 DCloud AppID `__UNI__EC972AA`。如复制为新的独立应用，需要在 HBuilderX 的 manifest 可视化页面获取自己的 AppID 后再发行。

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
