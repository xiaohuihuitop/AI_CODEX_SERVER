# app Android 手机端说明

## 定位

`app` 是 Android-only 的 uni-app 手机端客户端。它不依赖服务器返回页面，只通过 `server` 提供的数据接口连接云端 relay 和 Windows Agent。

## 目录结构

```text
app/
  App.vue
  main.js
  manifest.json
  pages.json
  pages/index/index.vue        主界面
  pages/settings/settings.vue  设备设置
  utils/api.js                 接口请求封装
  utils/config.js              本地配置读写
  utils/markdown.js            Markdown 渲染
  docs/                        旧版说明文档
```

## 功能

- 显示服务器、Agent、当前对话三种状态。
- 在首页顶部切换多台已保存电脑。
- 在设置页新增、编辑、删除和测试设备连接。
- 通过弹出列表按“文件夹 -> 对话”选择线程。
- 同步当前对话历史。
- 支持 Markdown 渲染。
- 按每轮对话显示处理过程，默认折叠。
- 发送消息到电脑端 Codex Desktop。
- 对话运行中可发送停止指令。
- 自动轮询状态，并在切换对话时先刷新线程列表。

## 默认配置

App 默认不内置服务器地址和 Token。首次启动后需要进入“设置”页添加设备：

```text
服务器地址：http://example.com:8008
Token：token_replace_with_random_value
```

每台电脑需要使用独立 Token。真实使用时请替换成自己的服务器地址和强随机 Token，设备配置只保存在手机本地。

## HBuilderX 编译

`app` 是 HBuilderX 原生 uni-app 目录结构，不需要 `npm install`。

步骤：

1. 打开 HBuilderX。
2. 导入 `app` 目录。
3. 在 `manifest.json` 可视化页面设置自己的 DCloud AppID。
4. 运行到 Android 真机，或执行 Android App 打包。

当前 `manifest.json` 的 Android 包名是开源占位：

```text
io.github.codexbridge.mobile
```

发布自己的 APK 前建议改成自己的包名。

## 接口

手机端调用以下接口：

- `GET /codex/health`
- `GET /codex/threads?limit=120`
- `GET /codex/history?thread=<threadId>&limit=120`
- `GET /codex/status?thread=<threadId>&since=<since>`
- `POST /send`
- `POST /codex/stop`

请求头：

```text
x-mobile-typer-token: <token>
```

## 页面说明

主界面：

- 顶部显示当前设备名称，点击后只切换已保存设备。
- 顶部紧凑显示服务器、Agent、对话状态。
- “刷新”按钮用于主动刷新当前对话。
- 对话选择按钮打开当前 Agent 上报的线程列表。
- 消息区显示用户消息、处理过程和最终回复。
- 底部输入框用于发送新消息。

设置页：

- 新增、编辑和删除设备。
- 为每台设备保存名称、服务器地址和独立 Token。
- 测试指定设备连接，不改变首页当前设备。

存在未发送草稿时，App 禁止切换设备，也禁止修改或删除当前设备，并提示“请先发送或清空草稿”。每台设备独立保存最后选择的项目和对话。

## 注意事项

- 只做 Android，未适配 iOS。
- 允许 HTTP 明文访问，便于局域网和群晖端口部署。
- 如果没有填写服务器地址和 token，主界面不会发起网络请求。
- 设备切换会先关闭旧设备的请求、轮询和 WebSocket，再连接目标设备；失败时不会自动回退或尝试其他 Token。
- 如果修改了接口协议，需要同步更新 `server` 和相关测试。
