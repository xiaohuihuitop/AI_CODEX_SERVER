# server 云端服务说明

## 定位

`server` 是云端 relay 服务，负责：

- 维护手机端和 Windows Agent 的连接。
- 管理多台电脑的设备 Key，并校验设备 Key。
- 接收 Windows Agent 上传的 Codex 会话增量。
- 在服务端解析并缓存线程、历史和状态。
- 把手机端发送和停止指令转发给对应 Agent。
- 提供保留的网页端访问入口。

## 目录结构

```text
server/
  cloud-server.js          云端服务入口
  Dockerfile               Docker 镜像构建文件
  docker-compose.yml       部署示例
  .env.example             环境变量模板
  public/                  云端网页端静态文件
  src/                     relay、鉴权、缓存等业务模块
  scripts/check.js         语法检查脚本
  test/                    Node.js 测试
  package.json
```

## 环境变量

```text
CODEX_CLOUD_HTTP_PORT=8008
PORT=8787
HOST=0.0.0.0
```

说明：

- `CODEX_CLOUD_HTTP_PORT`：Docker Compose 映射到宿主机的端口。
- `PORT`：容器或 Node 进程内部监听端口，默认 `8787`。
- `HOST`：监听地址，默认 `0.0.0.0`。
- 管理后台密码固定为 `xiaohuihui`，不从环境变量读取。

设备 Key 存储在 Docker Compose 挂载的 `server/data/keys.json`，不写入环境变量。后台创建时必须填写自定义 Key 和备注，随后会完整展示并支持复制。Key 原文会随该数据文件保存；请限制 `data/keys.json` 的宿主机访问权限。

## 本地启动

```powershell
cd server
npm install
npm start
```

启动后先访问管理后台创建设备 Key：

```powershell
Start-Process http://127.0.0.1:8787/admin
```

## Docker 部署

复制环境变量模板：

```sh
cp .env.example .env
```

编辑 `.env`：

```text
CODEX_CLOUD_HTTP_PORT=8008
```

启动：

```sh
docker compose up -d
```

验证：

```sh
curl http://127.0.0.1:8008/admin
```

## 群晖部署建议

建议目录：

```text
/volume1/SSD/docker/codex_server
```

目录内放置：

```text
docker-compose.yml
.env
ai-codex-server-build-v1.0.tar
```

导入 Release 里的镜像 tar：

```sh
sudo docker load -i ai-codex-server-build-v1.0.tar
sudo docker-compose up -d
```

当前 compose 不设置 `cpus`、`mem_limit`，避免依赖群晖内核的 CPU CFS/cgroup 能力。

## GitHub Actions 镜像构建

推送 `build-*` tag 后自动构建 Docker 镜像：

```powershell
git tag build-v1.0
git push origin build-v1.0
```

Release 产物：

```text
ai-codex-server-build-v1.0.tar
docker-compose.yml
env.example
```

## API

管理后台：

- `GET /admin`：Key 管理页面。
- `POST /admin/api/login`：登录管理后台。
- `GET /admin/api/keys`：列出完整 Key、备注和状态。
- `POST /admin/api/keys`：使用自定义 Key 和备注创建设备记录。
- `POST /admin/api/keys/<id>/disable`：禁用 Key，并立即断开该 Key 的客户端连接。
- `DELETE /admin/api/keys/<id>`：删除 Key，并立即断开该 Key 的客户端连接。

手机端接口：

- `GET /codex/health`
- `GET /codex/threads?limit=120`
- `GET /codex/history?thread=<threadId>&limit=10&before=<消息索引>`：默认读取最新 5 轮，携带 `before` 可继续读取更早记录。
- `GET /codex/status?thread=<threadId>&since=<since>`
- `POST /send`
- `POST /codex/stop`

Agent 接口：

- `GET /agent?token=<token>`：WebSocket 连接入口。

设备鉴权方式：

- Query：`?token=<token>`
- Header：`x-mobile-typer-token: <token>`
- Cookie：`codexBridgeToken=<token>`

### 从旧部署迁移

若首次启动时仍配置了旧的 `CODEX_CLOUD_TOKENS` 或 `CODEX_CLOUD_TOKEN`，服务会仅在 `keys.json` 为空时把它们迁移为可管理 Key；运行时不再直接使用该环境变量。迁移完成后可从 `.env` 删除旧变量。

## 验证

```powershell
npm test
npm run check
```
