const { execFileSync } = require('node:child_process');

const DEFAULT_DEBUG_PORT = 9229;
const DEFAULT_WAIT_TIMEOUT_MS = 15000;
const CODEX_PACKAGE_NAME = 'OpenAI.Codex';
const CODEX_APP_ID = 'App';

function quotePowerShellString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (!/[ \t"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

function parsePowerShellJson(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed[0] || null : parsed;
}

/**
 * 执行 PowerShell 并返回文本。
 *
 * @param {string} script PowerShell 脚本。
 * @param {{timeoutMs?: number}} options 执行选项。
 * @returns {string} 标准输出。
 */
function runPowerShell(script, options = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 5000,
  }).trim();
}

/**
 * 查询 Codex Desktop 主进程。
 *
 * @returns {{pid: number, executablePath: string, commandLine: string}|null} Codex 主进程。
 */
function findCodexDesktopProcess() {
  if (process.platform !== 'win32') return null;
  const script = [
    'Get-CimInstance Win32_Process |',
    "Where-Object { $_.Name -eq 'Codex.exe' -and $_.ExecutablePath -and $_.ExecutablePath.EndsWith('\\app\\Codex.exe') -and $_.CommandLine -notmatch '--type=' } |",
    'Sort-Object ProcessId |',
    'Select-Object -First 1 ProcessId,ExecutablePath,CommandLine |',
    'ConvertTo-Json -Compress',
  ].join(' ');
  try {
    const raw = runPowerShell(script);
    if (!raw) return null;
    const parsed = parsePowerShellJson(raw);
    if (!parsed || !parsed.ProcessId || !parsed.ExecutablePath) return null;
    return {
      pid: Number(parsed.ProcessId),
      executablePath: String(parsed.ExecutablePath),
      commandLine: String(parsed.CommandLine || ''),
    };
  } catch {
    return null;
  }
}

/**
 * 查询已安装的 Codex Desktop 应用包。
 *
 * @returns {{appUserModelId: string, packageFamilyName: string, packageFullName: string, installLocation: string, executablePath: string}|null} Codex 应用包。
 */
function findCodexDesktopPackage() {
  if (process.platform !== 'win32') return null;
  const script = [
    `$pkg = Get-AppxPackage -Name ${quotePowerShellString(CODEX_PACKAGE_NAME)} -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1;`,
    'if ($null -eq $pkg) { return; }',
    '$exe = Join-Path $pkg.InstallLocation ' + quotePowerShellString('app\\Codex.exe') + ';',
    '[pscustomobject]@{',
    'AppUserModelId = "$($pkg.PackageFamilyName)!' + CODEX_APP_ID + '";',
    'PackageFamilyName = $pkg.PackageFamilyName;',
    'PackageFullName = $pkg.PackageFullName;',
    'InstallLocation = $pkg.InstallLocation;',
    'ExecutablePath = $exe',
    '} | ConvertTo-Json -Compress',
  ].join(' ');
  try {
    const raw = runPowerShell(script);
    const parsed = parsePowerShellJson(raw);
    if (!parsed?.AppUserModelId || !parsed?.ExecutablePath) return null;
    return {
      appUserModelId: String(parsed.AppUserModelId),
      packageFamilyName: String(parsed.PackageFamilyName || ''),
      packageFullName: String(parsed.PackageFullName || ''),
      installLocation: String(parsed.InstallLocation || ''),
      executablePath: String(parsed.ExecutablePath),
    };
  } catch {
    return null;
  }
}

/**
 * 结束当前 Codex Desktop 进程树。
 *
 * @returns {void}
 */
function stopCodexDesktopProcesses() {
  if (process.platform !== 'win32') return;
  const script = [
    'Get-CimInstance Win32_Process |',
    "Where-Object { $_.Name -eq 'Codex.exe' -and $_.ExecutablePath -and $_.ExecutablePath.EndsWith('\\app\\Codex.exe') } |",
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join(' ');
  runPowerShell(script);
}

/**
 * 通过 Windows 应用入口启动 Codex Desktop。
 *
 * @param {string} appUserModelId Codex 应用 AUMID。
 * @param {string[]} args 启动参数。
 * @returns {{pid: number}} 启动结果。
 */
function activateCodexDesktopApplication(appUserModelId, args) {
  const argumentLine = args.map(quoteWindowsArgument).join(' ');
  const script = `
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;

[Flags]
public enum ActivateOptions
{
    None = 0,
    DesignMode = 1,
    NoErrorUI = 2,
    NoSplashScreen = 4
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class ApplicationActivationManager
{
}

[ComImport]
[Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager
{
    int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, ActivateOptions options, out uint processId);
    int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
    int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, out uint processId);
}

public static class CodexActivationHelper
{
    public static uint Activate(string appUserModelId, string arguments)
    {
        var manager = new ApplicationActivationManager() as IApplicationActivationManager;
        if (manager == null) throw new InvalidOperationException("ApplicationActivationManager unavailable.");
        uint processId;
        int hr = manager.ActivateApplication(appUserModelId, arguments, ActivateOptions.NoErrorUI, out processId);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        return processId;
    }
}
'@
Add-Type -TypeDefinition $code
$activatedProcessId = [CodexActivationHelper]::Activate(${quotePowerShellString(appUserModelId)}, ${quotePowerShellString(argumentLine)})
[pscustomobject]@{ ProcessId = $activatedProcessId } | ConvertTo-Json -Compress
`;
  const parsed = parsePowerShellJson(runPowerShell(script, { timeoutMs: 15000 }));
  return { pid: Number(parsed?.ProcessId || 0) };
}

/**
 * 检查 Codex Desktop CDP 是否可用。
 *
 * @param {number} port CDP 端口。
 * @returns {Promise<{ok: boolean, targetCount: number, message: string}>} CDP 状态。
 */
async function probeCodexDesktopDebug(port = DEFAULT_DEBUG_PORT) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    const targets = await response.json();
    return {
      ok: Array.isArray(targets) && targets.some(target => target.url === 'app://-/index.html'),
      targetCount: Array.isArray(targets) ? targets.length : 0,
      message: '',
    };
  } catch (error) {
    return { ok: false, targetCount: 0, message: error.message };
  }
}

/**
 * 等待 Codex Desktop CDP 可用。
 *
 * @param {{port?: number, timeoutMs?: number, intervalMs?: number}} options 等待选项。
 * @returns {Promise<{ok: boolean, targetCount: number, message: string}>} 最终状态。
 */
async function waitForCodexDesktopDebug(options = {}) {
  const port = options.port || DEFAULT_DEBUG_PORT;
  const timeoutMs = options.timeoutMs || DEFAULT_WAIT_TIMEOUT_MS;
  const intervalMs = options.intervalMs || 500;
  const deadline = Date.now() + timeoutMs;
  let latest = { ok: false, targetCount: 0, message: '等待 Codex Desktop CDP。' };
  while (Date.now() < deadline) {
    latest = await probeCodexDesktopDebug(port);
    if (latest.ok) return latest;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return latest;
}

/**
 * 重启 Codex Desktop 并开放 CDP 调试端口。
 *
 * @param {{debugPort?: number, waitTimeoutMs?: number, processFinder?: Function, packageFinder?: Function, processKiller?: Function, launcher?: Function}} options 重启选项。
 * @returns {Promise<{ok: boolean, appUserModelId: string, executablePath: string, previousPid: number|null, launchedPid: number|null, debugPort: number, codex: object}>} 重启结果。
 */
async function restartCodexDesktopWithDebug(options = {}) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('当前功能仅支持 Windows。'), { code: 'WINDOWS_ONLY', status: 400 });
  }
  const debugPort = options.debugPort || DEFAULT_DEBUG_PORT;
  const processFinder = options.processFinder || findCodexDesktopProcess;
  const packageFinder = options.packageFinder || findCodexDesktopPackage;
  const processKiller = options.processKiller || (() => stopCodexDesktopProcesses());
  const launcher = options.launcher || ((launchTarget, args) => activateCodexDesktopApplication(launchTarget.appUserModelId, args));

  const current = processFinder();
  const appPackage = packageFinder();
  if (!appPackage?.appUserModelId) {
    throw Object.assign(new Error('未找到已安装的 Codex Desktop。请先从官方渠道安装 Windows 版 Codex。'), { code: 'CODEX_PACKAGE_NOT_FOUND', status: 404 });
  }

  if (current?.pid) {
    processKiller(current.pid);
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  const args = [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-allow-origins=http://127.0.0.1:${debugPort}`,
  ];
  const launchResult = launcher(appPackage, args) || {};
  const codex = await waitForCodexDesktopDebug({ port: debugPort, timeoutMs: options.waitTimeoutMs || DEFAULT_WAIT_TIMEOUT_MS });
  return {
    ok: codex.ok,
    appUserModelId: appPackage.appUserModelId,
    executablePath: appPackage.executablePath,
    previousPid: current?.pid || null,
    launchedPid: Number(launchResult.pid || 0) || null,
    debugPort,
    codex,
  };
}

module.exports = {
  DEFAULT_DEBUG_PORT,
  activateCodexDesktopApplication,
  findCodexDesktopProcess,
  findCodexDesktopPackage,
  probeCodexDesktopDebug,
  restartCodexDesktopWithDebug,
  stopCodexDesktopProcesses,
  waitForCodexDesktopDebug,
};
