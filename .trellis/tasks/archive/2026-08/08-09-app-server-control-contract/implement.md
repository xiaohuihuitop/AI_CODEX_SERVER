# 实施与验证计划

1. 删除旧 CDP 控制入口、模块、脚本和相应的历史测试。
2. 收紧 `desktop/package.json` 的默认启动命令和 Electron 打包白名单。
3. 新增控制平面契约测试，先覆盖源码入口和打包配置，再覆盖构建产物。
4. 新增/更新 Trellis 后端规范和跨层检查项。
5. 运行 `npm test`、`npm run check`、Windows 管理器构建，并检查 `desktop/dist/win-unpacked/resources/app.asar`。
6. 使用 `codex_temp` 的已打开线程执行一次 Web -> App Server -> 本地 JSONL -> 回复的端到端验证；不操作用户正在运行的 Codex UI。

## 回滚点

- 删除旧路径前后均运行控制平面契约测试。
- 构建产物不满足约束时停止，不将产物视为可用。
