# 技术设计

## 1. 设计原则

1. 官方 Codex Desktop 负责执行，JSONL 是消息与终态事实源。
2. Agent 负责把 JSONL 增量投影为可传输快照。
3. Relay 是手机/Web 的唯一读模型；手机普通读取不等待 Agent。
4. WebSocket 只通知“哪个版本、哪个线程变了”，HTTP 读取对应版本快照。
5. 发送和停止不重试；读取异常不触发控制通道 fallback。

## 2. 目标数据流

```text
Codex Desktop
  -> JSONL 追加
  -> Agent 尾部增量读取
  -> session-sync(changedThreadIds, catalogChanged, snapshots)
  -> Relay 原子应用并生成 syncVersion
  -> session-updated(syncVersion, changedThreadIds, catalogChanged)
  -> 手机/Web 只刷新受影响的当前线程
```

发送链路保持：

```text
手机/Web POST /send
  -> Relay 202 accepted
  -> Agent CDP 精确发送
  -> JSONL task_started 确认
  -> control-result accepted
  -> Agent 增量快照
  -> Relay session-updated
  -> 手机/Web 渲染最终回复和终态
```

## 3. 协议与边界

### 3.1 Agent 同步

- 心跳与数据同步分离。
- `syncProvider()` 返回“无变化”时不发 `session-sync`。
- 同步负载携带 `changedThreadIds`、`catalogChanged`、目标线程快照和确认回合。
- 同步执行期间再次变脏时设置 dirty latch；当前同步结束后立即再执行一次，不等待下一周期。

### 3.2 Relay 读模型

- 仅在实际应用目录变化、线程快照变化或控制确认变化时递增 `syncVersion`。
- 新增原子当前线程视图接口，单次返回最近 5 轮、线程状态、分页游标和同步版本。
- 普通历史/状态读取不再 `forwardToAgent()`。
- 快照不存在或同步陈旧时返回明确的未就绪状态，不执行直穿 Agent 的 fallback。

### 3.3 JSONL 增量读取

- 每个线程维护 `{file, size, mtime, byteOffset, tailBuffer, recentTurns, runtime}`。
- 文件正常追加时只解析新增字节。
- 文件截断、替换或游标失效时重建该线程索引，并记录可诊断原因。
- 最近 5 轮和状态来自有界内存投影；更早分页使用反向字节游标或稀疏偏移索引。
- 缓存按线程有界淘汰，正文不得写入运行日志。

### 3.4 手机/Web 刷新

- 当前线程视图使用 single-flight；事件期间只合并一次待刷新意图。
- `catalogChanged=false` 时不重拉线程列表。
- 无关线程变化只更新列表中的轻量状态，不加载当前历史。
- 删除 4 秒一次的列表+历史+状态全刷新；保留 30 秒轻量健康和版本核对。
- 版本落后时按版本读取一次当前线程视图；不得用固定次数重试最终回复。

## 4. 一致性规则

- Relay 应用快照后才广播对应 `syncVersion`。
- 客户端忽略旧版本和重复事件。
- 回合状态只能从 `running -> complete|interrupted|error`，旧事件不得覆盖新终态。
- `threadId + turnId` 是回合关联键；标题、项目名和时间不能代替。
- 目录版本和线程快照版本分开，避免一个无关线程触发当前页面全量刷新。

## 5. 发布方式

- 协议字段采用新增字段方式，服务端先部署，随后更新桌面 Agent 和手机 App。
- 不保留旧路径的运行时双读或自动切换；旧客户端仍能访问既有接口，但不获得新性能路径。
- 每一阶段先通过自动化和本地集成门禁；完整端到端通过后才提交、打 Tag、推送和触发镜像构建。

