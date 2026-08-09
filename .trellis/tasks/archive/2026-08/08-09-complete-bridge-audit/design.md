# 技术设计

## 1. 数据流与所有权

```text
Codex Desktop 侧栏目录
  -> Windows Agent 全量 openThreadIds + 分批会话增量
  -> Relay CloudSessionCache
  -> 手机/Web 列表、历史、状态

手机/Web 控制
  -> Relay 转发
  -> Windows Agent
  -> App Server resumeThread/startTurn/interruptTurn
  -> 本地 JSONL
  -> Agent 增量同步
  -> Relay/Web/App
```

- `openThreadIds` 是线程存在性的唯一权威集合。
- `payload.sessions` 可以是分批、局部或仅元数据数据，不能单独决定删除。
- 本地 JSONL 是历史与完成状态的事实来源；App Server 运行通知只修正当前活动状态。
- Relay 缓存是可丢弃投影，不得保留已从权威集合移除的内容。

## 2. 缓存清理契约

`CloudSessionCache.applySync(token, payload)` 在 `payload.openThreadIds` 为数组时：

1. 规范化并去重得到权威集合。
2. 删除 `bucket.sessions` 中所有不在权威集合内的线程。
3. 更新 `bucket.openThreadIds`。
4. 在当前调用返回前完成删除，使列表、历史和状态立即一致。

`openThreadIds` 字段缺失时只应用增量，不执行删除。空数组是有效权威集合，表示清空全部会话。

## 3. 诊断反馈环

- 第一条红灯：缓存先同步 A/B，再上传权威列表 `[B]`，断言 A 的历史仍存在时失败。
- 扩展矩阵：空列表、字段缺失、Key 隔离、重新加入、局部批次、重复 ID。
- 状态机矩阵：Agent 在线/离线、同步新鲜/过期、运行/完成/错误、版本乱序。
- 历史矩阵：首次 5 轮、向上分页、快照缩短、重复最终回复、附件元数据。
- 控制矩阵：恢复失败、启动失败、缺失回合 ID、停止失败、控制后无 JSONL 证据。

## 4. 真实端到端验收

- 使用现有测试 Key 和 `codex_temp` 中已授权的测试线程发送唯一标识消息。
- 记录 Web 请求结果、Agent 确认、同一线程 JSONL 写入、最终回复及页面自动更新。
- 不关闭、不重启、不自动操作 Codex Desktop；若无法无侵入读取当前窗口内容，该项明确标为人工可视验收，不伪报自动通过。

## 5. 兼容与风险

- 服务器更新后，旧 Agent 若不上传 `openThreadIds`，不会触发删除，避免误删；这是协议语义，不是错误兜底。
- 当前 Agent 已上传完整 `openThreadIds`，因此新服务器可立即执行清理。
- 会话重新打开时按普通新快照重新建立缓存，不恢复已删除的旧缓存对象。
- 不改变 Key 数据、控制通道、手机草稿或多设备 UI。
