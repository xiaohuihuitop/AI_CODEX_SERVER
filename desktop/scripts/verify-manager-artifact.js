const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const artifactPath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');

const forbiddenProductPaths = [
  'server.js',
  'src/windows-codex-controller.js',
  'src/codex-desktop-process.js',
  'src/codex-app-server-client.js',
  'src/app-server-event-stream.js',
  'src/app-server-status.js',
  'scripts/win-codex-control.ps1',
];

const forbiddenSourcePatterns = [
  /WindowsCodexController/,
  /restartCodexDesktopWithDebug/,
  /createCodexAppServerClient/,
  /\.resumeThread\(/,
  /\.startTurn\(/,
  /\.interruptTurn\(/,
  /win-codex-control\.ps1/,
];

/**
 * AI:以统一错误前缀终止不符合控制平面约束的构建。
 *
 * @param {string} message 失败原因。
 * @returns {never} 始终抛出异常。
 */
function fail(message) {
  throw new Error(`管理器构建产物控制平面校验失败：${message}`);
}

/**
 * AI:仅扫描本项目打包的业务源码，避免第三方依赖中的无关字符串导致误报。
 *
 * @param {string} filePath app.asar 内相对路径。
 * @returns {boolean} 是否为需要检查的业务源码。
 */
function isProductSource(filePath) {
  return /^(desktop-agent\.js|electron\/.+\.(?:js|html)|src\/.+\.js)$/.test(filePath);
}

/**
 * AI:读取 app.asar 内的 UTF-8 业务源码。
 *
 * @param {string} filePath app.asar 内相对路径。
 * @returns {string} 文件文本。
 */
function readArtifactText(filePath) {
  return Buffer.from(asar.extractFile(artifactPath, filePath)).toString('utf8');
}

/**
 * AI:验证 Windows 管理器产物只携带受控官方 Codex Desktop 控制路径。
 *
 * @returns {void} 校验通过后输出构建产物路径，失败时抛出异常并终止构建。
 */
function verifyManagerArtifact() {
  if (!fs.existsSync(artifactPath)) fail(`未找到 app.asar：${artifactPath}`);

  const files = asar.listPackage(artifactPath)
    .map(filePath => String(filePath).replace(/^[/\\]+/, '').replaceAll('\\', '/'));
  for (const filePath of forbiddenProductPaths) {
    if (files.includes(filePath)) {
      fail(`包含旧控制文件：${filePath}`);
    }
  }

  for (const filePath of files.filter(isProductSource)) {
    const source = readArtifactText(filePath);
    for (const pattern of forbiddenSourcePatterns) {
      if (pattern.test(source)) fail(`${filePath} 包含禁止标识 ${pattern}`);
    }
  }

  const agent = readArtifactText('desktop-agent.js');
  const api = readArtifactText('src/desktop-agent-api.js');
  const runtimeSource = readArtifactText('src/controlled-codex-runtime.js');
  const processSource = readArtifactText('src/controlled-codex-process.js');
  const controllerSource = readArtifactText('src/codex-desktop-ui-controller.js');
  const electronMain = readArtifactText('electron/main.js');
  const electronPreload = readArtifactText('electron/preload.js');
  const electronHtml = readArtifactText('electron/renderer.html');
  if (!/new ControlledCodexRuntime\(\{ debugPort, reader \}\)/.test(agent)) fail('desktop-agent.js 未创建受控 Codex 运行时');
  if (!/desktopController: controlledCodex/.test(agent)) fail('桌面 API 未绑定受控 Codex 运行时');
  if (!/desktopController\.sendMessage\(threadId, text\)/.test(api)) fail('桌面 API 未通过官方界面发送消息');
  if (!/desktopController\.stop\(threadId\)/.test(api)) fail('桌面 API 未通过官方界面停止回合');
  if (!/ApplicationActivationManager/.test(processSource)) fail('未使用 Windows 应用激活接口启动官方 Codex');
  if (/\$pid\s*=/i.test(processSource)) fail('应用激活脚本覆盖了 PowerShell 只读 PID 自动变量');
  if (!/\$activatedProcessId\s*=\s*\[CodexActivationHelper\]::Activate/.test(processSource)) fail('应用激活脚本未使用独立变量保存进程 ID');
  if (!/buildProcessTreeSnapshot/.test(processSource) || !/terminateProcessTree/.test(processSource) || !/SIGKILL/.test(processSource)) fail('未按进程树逐 PID 终止官方 Codex');
  if (/taskkill\.exe|PackageDebugSettings|CloseMainWindow|Stop-Process/.test(processSource)) fail('受控重启仍包含不可靠的进程退出方式');
  if (!/request\('Browser\.close', \{\}\)/.test(processSource)) fail('健康 CDP 实例缺少 Browser.close 优雅退出');
  if (!/findAvailableLoopbackPort/.test(processSource) || !/portChangeReason/.test(processSource)) fail('受控重启缺少空闲端口选择与迁移诊断');
  if (!/waitForPortRelease/.test(processSource) || !/exclusive: true/.test(processSource)) fail('受控重启缺少 CDP 端口释放门禁');
  if (!/remote-debugging-port/.test(processSource)) fail('受控 Codex 启动未配置 CDP 端口');
  if (/readCodexDraft|CODEX_DRAFT_(?:UNKNOWN|EXISTS)/.test(processSource)) fail('受控重启仍包含不可靠的草稿自动检查');
  if (/processManager\.restart\(/.test(runtimeSource)) fail('Agent 运行时仍会隐式重启官方 Codex');
  if (!/manager:restart-codex/.test(electronMain)) fail('管理器缺少独立 Codex 重启操作');
  if (!/丢弃未发送草稿/.test(electronMain)) fail('Codex 重启确认框未明确提示草稿风险');
  if (!/debugPort: result\.debugPort/.test(electronMain) || !/agentController\.start\(config\)/.test(electronMain)) fail('管理器未保存实际 CDP 端口并用于 Agent');
  if (!/restartCodex/.test(electronPreload)) fail('渲染层未暴露独立 Codex 重启操作');
  if (!/重启 Codex 启用 CDP/.test(electronHtml)) fail('管理器缺少独立 Codex 重启按钮');
  if (!/data-app-action-sidebar-thread-id/.test(controllerSource)) fail('官方界面控制未按 threadId 精确定位');
  if (!/sessionConfirmer/.test(controllerSource)) fail('官方界面发送缺少 JSONL 证据确认');

  console.log(`控制平面产物校验通过：${artifactPath}`);
}

verifyManagerArtifact();
