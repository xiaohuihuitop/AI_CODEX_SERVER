# server 云端服务说明

## 定位

`server` 是云端 relay 服务，负责：

- 维护手机端和 Windows Agent 的连接。
- 校验 token。
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
CODEX_CLOUD_TOKENS=token_replace_with_random_value
CODEX_CLOUD_HTTP_PORT=8008
PORT=8787
HOST=0.0.0.0
```

说明：

- `CODEX_CLOUD_TOKENS`：允许连接的 token，多个 token 用英文逗号分隔。
- `CODEX_CLOUD_HTTP_PORT`：Docker Compose 映射到宿主机的端口。
- `PORT`：容器或 Node 进程内部监听端口，默认 `8787`。
- `HOST`：监听地址，默认 `0.0.0.0`。

生产部署必须使用强随机 token，不要使用文档示例值。

## 本地启动

```powershell
cd server
npm install
$env:CODEX_CLOUD_TOKENS="token_replace_with_random_value"
npm start
```

访问健康检查：

```powershell
curl "http://127.0.0.1:8787/codex/health?token=token_replace_with_random_value"
```

## Docker 部署

复制环境变量模板：

```sh
cp .env.example .env
```

编辑 `.env`：

```text
CODEX_CLOUD_TOKENS=token_replace_with_random_value
CODEX_CLOUD_HTTP_PORT=8008
```

启动：

```sh
docker compose up -d
```

验证：

```sh
curl "http://127.0.0.1:8008/codex/health?token=token_replace_with_random_value"
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

手机端接口：

- `GET /codex/health`
- `GET /codex/threads?limit=120`
- `GET /codex/history?thread=<threadId>&limit=120`
- `GET /codex/status?thread=<threadId>&since=<since>`
- `POST /send`
- `POST /codex/stop`

Agent 接口：

- `GET /agent?token=<token>`：WebSocket 连接入口。

鉴权方式：

- Query：`?token=<token>`
- Header：`x-mobile-typer-token: <token>`
- Cookie：`codexBridgeToken=<token>`

## 验证

```powershell
npm test
npm run check
```
