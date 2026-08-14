const { execFile } = require('node:child_process');
const path = require('node:path');

const DEFAULT_DEBUG_PORT = 9229;
const DEFAULT_WAIT_TIMEOUT_MS = 20000;

function processError(message, code) {
  return Object.assign(new Error(message), { code });
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (!/[ \t"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

function parsePowerShellJson(raw) {
  if (!String(raw || '').trim()) return null;
  const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  return Array.isArray(parsed) ? parsed[0] || null : parsed;
}

function runPowerShell(script, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: Number(options.timeoutMs) || 10000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = String(stderr || error.message).trim();
        reject(error);
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function resolveCodexDesktopPackage() {
  const script = [
    "$pkg = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1",
    "if ($null -eq $pkg) { throw 'CODEX_PACKAGE_NOT_FOUND' }",
    '$manifest = Get-AppxPackageManifest -Package $pkg.PackageFullName',
    "$app = @($manifest.Package.Applications.Application | Where-Object { $_.Id -eq 'App' })[0]",
    "if ($null -eq $app -or -not $app.Executable) { throw 'CODEX_APP_MANIFEST_INVALID' }",
    '$executablePath = Join-Path $pkg.InstallLocation ([string]$app.Executable)',
    '[pscustomobject]@{',
    'AppUserModelId = "$($pkg.PackageFamilyName)!$($app.Id)";',
    'PackageFamilyName = $pkg.PackageFamilyName;',
    'PackageFullName = $pkg.PackageFullName;',
    'InstallLocation = $pkg.InstallLocation;',
    'ExecutablePath = $executablePath;',
    'ExecutableName = [IO.Path]::GetFileName($executablePath);',
    'Version = [string]$pkg.Version',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  let parsed;
  try {
    parsed = parsePowerShellJson(await runPowerShell(script));
  } catch (error) {
    throw processError(`无法读取 Codex Desktop 应用包：${error.message}`, 'CODEX_PACKAGE_NOT_FOUND');
  }
  return {
    appUserModelId: String(parsed.AppUserModelId),
    packageFamilyName: String(parsed.PackageFamilyName),
    packageFullName: String(parsed.PackageFullName),
    installLocation: String(parsed.InstallLocation),
    executablePath: String(parsed.ExecutablePath),
    executableName: String(parsed.ExecutableName),
    version: String(parsed.Version),
  };
}

async function resolveCodexProcesses(app) {
  const script = [
    `$path = ${quotePowerShell(app.executablePath)}`,
    'Get-CimInstance Win32_Process |',
    'Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($path, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch \'--type=\' } |',
    'Sort-Object ProcessId | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
  ].join('\n');
  const raw = await runPowerShell(script);
  if (!raw) return [];
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({
    pid: Number(item.ProcessId),
    executablePath: String(item.ExecutablePath || ''),
    commandLine: String(item.CommandLine || ''),
  }));
}

async function resolvePortOwner(port) {
  const script = [
    `$row = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq ${Number(port)} } | Select-Object -First 1)[0]`,
    "if ($null -eq $row) { Write-Output ''; exit 0 }",
    '$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($row.OwningProcess)" -ErrorAction SilentlyContinue',
    "if ($null -eq $proc) { Write-Output ''; exit 0 }",
    '[pscustomobject]@{ ProcessId = $row.OwningProcess; ExecutablePath = $proc.ExecutablePath; CommandLine = $proc.CommandLine } | ConvertTo-Json -Compress',
  ].join('\n');
  const parsed = parsePowerShellJson(await runPowerShell(script));
  return parsed ? {
    pid: Number(parsed.ProcessId),
    executablePath: String(parsed.ExecutablePath || ''),
    commandLine: String(parsed.CommandLine || ''),
  } : null;
}

async function stopCodexProcesses(_app, processes) {
  const ids = processes.map(item => Number(item.pid)).filter(Number.isInteger);
  if (!ids.length) return;
  const script = [
    `$ids = @(${ids.join(',')})`,
    'foreach ($id in $ids) {',
    '  $process = Get-Process -Id $id -ErrorAction SilentlyContinue',
    '  if ($null -eq $process) { continue }',
    "  if ($process.MainWindowHandle -eq 0) { throw \"CODEX_MAIN_WINDOW_NOT_FOUND:$id\" }",
    "  if (-not $process.CloseMainWindow()) { throw \"CODEX_GRACEFUL_CLOSE_REJECTED:$id\" }",
    '}',
  ].join('\n');
  try {
    await runPowerShell(script, { timeoutMs: 15000 });
  } catch (error) {
    throw processError(`无法安全关闭 Codex Desktop：${error.message}`, 'CODEX_GRACEFUL_STOP_FAILED');
  }
}

async function activateCodexApplication(app, args) {
  const argumentLine = args.map(quoteWindowsArgument).join(' ');
  const script = `
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
[Flags] public enum ActivateOptions { None = 0, DesignMode = 1, NoErrorUI = 2, NoSplashScreen = 4 }
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")] public class ApplicationActivationManager { }
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
  int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, ActivateOptions options, out uint processId);
  int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, [MarshalAs(UnmanagedType.LPWStr)] string verb, out uint processId);
  int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, IntPtr itemArray, out uint processId);
}
public static class CodexActivationHelper {
  public static uint Activate(string appUserModelId, string arguments) {
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
$pid = [CodexActivationHelper]::Activate(${quotePowerShell(app.appUserModelId)}, ${quotePowerShell(argumentLine)})
[pscustomobject]@{ ProcessId = $pid } | ConvertTo-Json -Compress
`;
  const parsed = parsePowerShellJson(await runPowerShell(script, { timeoutMs: 20000 }));
  return { pid: Number(parsed && parsed.ProcessId || 0) };
}

async function probeCdp(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
    const targets = await response.json();
    return {
      ok: Array.isArray(targets) && targets.some(target => target && target.url === 'app://-/index.html'),
      targetCount: Array.isArray(targets) ? targets.length : 0,
      message: '',
    };
  } catch (error) {
    return { ok: false, targetCount: 0, message: error.message };
  }
}

/**
 * AI:负责受控官方 Codex Desktop 的发现、草稿保护、关闭和 CDP 启动。
 */
class ControlledCodexProcess {
  /**
   * @param {object} options 可替换的 Windows 系统依赖。
   */
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.packageResolver = options.packageResolver || resolveCodexDesktopPackage;
    this.processResolver = options.processResolver || resolveCodexProcesses;
    this.portOwnerResolver = options.portOwnerResolver || resolvePortOwner;
    this.processStopper = options.processStopper || stopCodexProcesses;
    this.launcher = options.launcher || activateCodexApplication;
    this.cdpProbe = options.cdpProbe || probeCdp;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  ensureWindows() {
    if (this.platform !== 'win32') throw processError('受控 Codex Desktop 仅支持 Windows。', 'WINDOWS_ONLY');
  }

  async inspect() {
    this.ensureWindows();
    const app = await this.packageResolver();
    const processes = await this.processResolver(app);
    return { app, processes, mainProcess: processes[0] || null };
  }

  async restart(options = {}) {
    this.ensureWindows();
    const debugPort = Number(options.debugPort) || DEFAULT_DEBUG_PORT;
    const state = await this.inspect();
    const owner = await this.portOwnerResolver(debugPort);
    const ownerIsCodex = owner && path.normalize(owner.executablePath || '').toLowerCase() === path.normalize(state.app.executablePath).toLowerCase();
    if (owner && !ownerIsCodex) {
      throw processError(`CDP 端口 ${debugPort} 已被其他进程占用：PID ${owner.pid}`, 'CDP_PORT_OCCUPIED');
    }
    if (state.processes.length) {
      await this.processStopper(state.app, state.processes);
      await this.waitForExit(state.app, Number(options.exitTimeoutMs) || 10000);
    }
    const args = [
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-allow-origins=http://127.0.0.1:${debugPort}`,
    ];
    const launched = await this.launcher(state.app, args);
    const cdp = await this.waitForCdp(debugPort, Number(options.waitTimeoutMs) || DEFAULT_WAIT_TIMEOUT_MS);
    if (!cdp.ok) throw processError(`Codex Desktop 已启动但 CDP ${debugPort} 未就绪：${cdp.message || '未发现页面目标'}`, 'CDP_START_FAILED');
    const current = await this.processResolver(state.app);
    return {
      ok: true,
      debugPort,
      app: state.app,
      previousPid: state.mainProcess && state.mainProcess.pid || null,
      launchedPid: Number(launched && launched.pid || 0) || null,
      mainProcess: current[0] || null,
      cdp,
    };
  }

  async waitForExit(app, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.processResolver(app)).length) return;
      await this.sleep(250);
    }
    throw processError('Codex Desktop 未能在超时时间内退出。', 'CODEX_STOP_TIMEOUT');
  }

  async waitForCdp(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let latest = { ok: false, targetCount: 0, message: '等待 CDP。' };
    while (Date.now() < deadline) {
      latest = await this.cdpProbe(port);
      if (latest.ok) return latest;
      await this.sleep(300);
    }
    return latest;
  }
}

module.exports = {
  DEFAULT_DEBUG_PORT,
  ControlledCodexProcess,
  activateCodexApplication,
  parsePowerShellJson,
  probeCdp,
  resolveCodexDesktopPackage,
  resolveCodexProcesses,
  resolvePortOwner,
};
