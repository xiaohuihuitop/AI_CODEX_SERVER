# 技术设计

## 1. 设计原则

- 手机端继续管理多个独立连接配置；服务器用 Token 完成鉴权后，统一解析为稳定 Key ID 作为设备路由键。
- 设备切换是一次有顺序的事务，不在新旧连接之间增加 fallback。
- 设备内部 ID 是本地状态主键；名称只用于展示，Token 只用于鉴权。
- 复用现有生命周期取消机制，不引入全局状态库。

## 2. 本地数据结构

使用新的 `codexMobile.devices.v1` 存储：

```js
{
  version: 1,
  activeDeviceId: 'device_xxx',
  devices: [
    {
      id: 'device_xxx',
      name: '办公室电脑',
      serverUrl: 'http://codex.example.com',
      token: '...',
      lastConnection: {
        online: true,
        agentOnline: true,
        checkedAt: '2026-08-12T08:00:00.000Z'
      }
    }
  ],
  selections: {
    device_xxx: { projectName: 'codex_temp', threadId: '...' }
  }
}
```

`lastConnection` 只表示最近一次检查结果。切换弹窗需显示“最近在线/最近离线/未检测”，不得将其解释为实时在线。

## 3. 旧配置迁移

`loadDeviceStore()` 首次读取新键失败时检查旧 `codexMobile.config` 与 `codexMobile.selection`：

1. 旧服务器地址和 Token 均为空：创建空设备仓库，不创建虚假设备。
2. 任一连接字段存在：规范化后创建一个设备，名称优先使用本机可读默认“我的电脑”。
3. 将旧项目和线程选择绑定到新设备 ID。
4. 写入新键后删除旧键，迁移只执行一次。
5. 新键存在但结构损坏时明确返回配置错误，不读取旧键兜底。

## 4. 配置模块接口

`app/utils/config.js` 收敛为以下职责：

- `loadDeviceStore()`：读取、迁移并校验仓库。
- `listDevices()`：返回设备安全副本。
- `getActiveDevice()`：返回当前设备或空。
- `saveDevice(input)`：新增或按 ID 更新设备。
- `removeDevice(deviceId)`：删除设备及设备级选择，返回新的当前设备。
- `setActiveDevice(deviceId)`：只接受已存在 ID。
- `loadSelection(deviceId)` / `saveSelection(deviceId, selection)`：按设备隔离选择。
- `saveDeviceConnectionState(deviceId, result)`：保存最近一次检查结果。

设备 ID 在新增时生成，编辑时保持不变。所有写操作先规范化完整仓库，再单次 `uni.setStorageSync()`，避免多键写入中断产生半状态。

## 5. 首页 UI

`pages.json` 将首页设置为自定义导航栏。`index.vue` 顶部新增稳定高度的设备标题栏：

- 左侧/中间主按钮：当前设备名称，右侧下拉图标。
- 设备为空时显示“未配置设备”，点击仍只打开空列表提示，不提供新增入口。
- 右侧保留设置图标按钮，进入设置页。
- 标题按钮使用固定最小宽度、文本省略和稳定高度，长设备名称不挤压状态区。

设备弹窗复用现有遮罩与弹层风格，但与对话弹窗独立：

- 每行显示设备名称、最近连接状态、当前选中标记。
- 点击其他设备调用 `switchDevice(deviceId)`。
- 弹窗关闭按钮只关闭，不改变连接。

## 6. 切换事务

`switchDevice(deviceId)` 的严格顺序：

1. 目标等于当前设备：关闭弹窗并返回。
2. `messageText.trim()` 非空：提示“请先发送或清空草稿”并返回。
3. 标记 `switchingDevice`，关闭设备弹窗。
4. 调用 `deactivateConnection()`：递增生命周期令牌、递增请求序号、停止定时器、关闭 Socket、取消请求。
5. 调用 `resetDeviceViewState()`：清除线程、历史、运行态、待发送、分页、滚动和旧提示。
6. 持久化新 `activeDeviceId`，装载目标设备的配置和选择。
7. 重新激活生命周期，依次获取 health、threads、history/status，并建立实时连接。
8. 无论成功失败均结束 `switchingDevice`；失败时保留目标设备并显示明确错误。

所有异步任务除现有生命周期令牌外，还捕获 `activeDeviceId`。回调仅在两个值都匹配时更新页面。

## 7. 设置页

设置页由单一表单改为：

- 设备列表：名称、服务器摘要、最近状态；每项提供编辑、测试、删除命令。
- “添加设备”按钮位于设置页。
- 新增/编辑使用同页表单区域或模态层；MVP 优先同页表单，减少页面和路由数量。
- Token 输入保持密码模式，列表不显示完整 Token。
- 删除使用 `uni.showModal()` 二次确认。

设置页无法直接读取首页内存草稿。首页导航至设置页时在本地写入短期 `draftGuard` 标识；首页草稿变化和页面退出时更新/清理。删除当前设备前读取该标识，存在草稿则拒绝。该标识只保存布尔值和当前设备 ID，不保存草稿正文。

## 8. 服务器与协议

每个请求和实时连接继续携带当前设备 Token，手机 API 形态不变。服务器鉴权后按稳定 Key ID 隔离：

- `agents`
- `mobileClients`
- `pending`
- `syncHealth`
- `eventStreams`
- 会话缓存

因此设备切换只需正确关闭旧连接并切换鉴权信息。

## 9. 测试策略

- 配置单元/源码契约测试：迁移、规范化、ID 稳定性、选择隔离、删除语义。
- 页面生命周期测试：切换顺序、草稿拒绝、请求取消、Socket 关闭、双重令牌校验。
- 设置页测试：增删改、表单校验、Token 隐藏、删除确认、当前设备草稿保护。
- Web 模拟：使用两个不同 Token 的设备配置，检查网络请求头和线程隔离。
- Android 真机：HBuilderX 调试基座验证自定义导航栏安全区、弹窗尺寸、切换和双设备消息发送。

## 10. 回滚

- 回滚代码不会自动恢复旧存储键；新版迁移后旧键已删除。
- 如需支持版本回滚，必须在发布前另行确认是否保留旧键。本任务默认不为旧版本回滚保留双写，避免两个模型成为长期兼容分支。
