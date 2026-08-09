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
  'scripts/win-codex-control.ps1',
];

const forbiddenSourcePatterns = [
  /WindowsCodexController/,
  /restartCodexDesktopWithDebug/,
  /CODEX_DEBUG_PORT/,
  /remote-debugging-port/,
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
 * AI:验证 Windows 管理器产物只携带 App Server 控制路径。
 *
 * @returns {void} 校验通过后输出构建产物路径，失败时抛出异常并终止构建。
 */
function verifyManagerArtifact() {
  if (!fs.existsSync(artifactPath)) fail(`未找到 app.asar：${artifactPath}`);

  const files = asar.listPackage(artifactPath)
    .map(filePath => String(filePath).replace(/^[/\\]+/, '').replaceAll('\\', '/'));
  for (const filePath of forbiddenProductPaths) {
    if (files.includes(filePath)) {
      fail(`包含旧 CDP 文件：${filePath}`);
    }
  }

  for (const filePath of files.filter(isProductSource)) {
    const source = readArtifactText(filePath);
    for (const pattern of forbiddenSourcePatterns) {
      if (pattern.test(source)) fail(`${filePath} 包含禁止标识 ${pattern}`);
    }
  }

  const agent = readArtifactText('desktop-agent.js');
  const api = readArtifactText(path.join('src', 'desktop-agent-api.js'));
  if (!/createCodexAppServerClient/.test(agent)) fail('desktop-agent.js 未使用 App Server 客户端');
  if (!/resumeThread\(threadId\)/.test(api)) fail('桌面 API 未恢复目标线程');
  if (!/startTurn\(threadId, text\)/.test(api)) fail('桌面 API 未通过 App Server 发起回合');
  if (!/interruptTurn\(threadId\)/.test(api)) fail('桌面 API 未通过 App Server 停止回合');

  console.log(`控制平面产物校验通过：${artifactPath}`);
}

verifyManagerArtifact();
