const { execFile } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_DEBUG_PORT = 9229;
const DEFAULT_WAIT_TIMEOUT_MS = 20000;
const DEFAULT_PORT_RELEASE_TIMEOUT_MS = 10000;

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
  return runExecutable('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], options);
}

function runExecutable(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
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

/**
 * AI:从 Windows 进程快照中筛选受控主进程及其全部后代，并保留终止深度。
 *
 * @param {Array<object>} allProcesses Win32_Process 快照。
 * @param {Array<object>} rootProcesses 已核对的官方 Codex 主进程。
 * @returns {Array<object>} 按快照顺序返回的受控进程树。
 */
function buildProcessTreeSnapshot(allProcesses, rootProcesses) {
  const rows = Array.isArray(allProcesses) ? allProcesses : [];
  const normalized = rows.map(item => ({
    pid: Number(item.pid ?? item.ProcessId),
    parentPid: Number(item.parentPid ?? item.ParentProcessId),
    name: String(item.name ?? item.Name ?? ''),
    executablePath: String(item.executablePath ?? item.ExecutablePath ?? ''),
    commandLine: String(item.commandLine ?? item.CommandLine ?? ''),
  })).filter(item => Number.isInteger(item.pid) && item.pid > 0);
  const byParent = new Map();
  for (const item of normalized) {
    const children = byParent.get(item.parentPid) || [];
    children.push(item);
    byParent.set(item.parentPid, children);
  }
  const rootPids = new Set((Array.isArray(rootProcesses) ? rootProcesses : [])
    .map(item => Number(typeof item === 'number' ? item : item.pid ?? item.ProcessId))
    .filter(pid => Number.isInteger(pid) && pid > 0));
  const tree = [];
  const visited = new Set();
  const queue = normalized.filter(item => rootPids.has(item.pid)).map(item => ({ item, depth: 0 }));
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current.item.pid)) continue;
    visited.add(current.item.pid);
    tree.push({ ...current.item, depth: current.depth });
    for (const child of byParent.get(current.item.pid) || []) {
      if (!visited.has(child.pid)) queue.push({ item: child, depth: current.depth + 1 });
    }
  }
  return tree;
}

async function resolveCodexProcessTree(app, processes) {
  const script = [
    'Get-CimInstance Win32_Process |',
    'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine |',
    'ConvertTo-Json -Compress',
  ].join('\n');
  const raw = await runPowerShell(script);
  if (!raw) return [];
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const snapshot = Array.isArray(parsed) ? parsed : [parsed];
  return buildProcessTreeSnapshot(snapshot, processes);
}

function terminateProcessByPid(pid) {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw processError(`Codex Desktop 进程 PID 无效：${pid}`, 'CODEX_PROCESS_ID_INVALID');
  }
  process.kill(normalized, 'SIGKILL');
}

async function terminateProcessTree(tree, terminator = terminateProcessByPid) {
  const processes = (Array.isArray(tree) ? tree : [])
    .slice()
    .sort((left, right) => Number(right.depth || 0) - Number(left.depth || 0) || Number(right.pid) - Number(left.pid));
  const terminatedPids = [];
  const missingPids = [];
  for (const process of processes) {
    const pid = Number(process.pid);
    try {
      await terminator(pid);
      terminatedPids.push(pid);
    } catch (error) {
      if (error && error.code === 'ESRCH') {
        missingPids.push(pid);
        continue;
      }
      throw processError(`无法终止 Codex Desktop 进程 PID ${pid}（${process.name || '未知进程'}）：${error && error.message || error}`, 'CODEX_PROCESS_TREE_TERMINATION_FAILED');
    }
  }
  return { terminatedPids, missingPids };
}

async function stopCodexProcesses(app, processes) {
  if (!processes.length) return;
  const tree = await resolveCodexProcessTree(app, processes);
  await terminateProcessTree(tree);
}

function probePortAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    let settled = false;
    const finish = available => {
      if (settled) return;
      settled = true;
      resolve(available);
    };
    server.unref();
    server.once('error', () => finish(false));
    server.listen({ host: '127.0.0.1', port: Number(port), exclusive: true }, () => {
      server.close(error => finish(!error));
    });
  });
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
 * AI:负责受控官方 Codex Desktop 的发现、进程树终止和 CDP 启动。
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
    this.portAvailabilityProbe = options.portAvailabilityProbe || probePortAvailable;
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
    await this.waitForPortRelease(debugPort, Number(options.portReleaseTimeoutMs) || DEFAULT_PORT_RELEASE_TIMEOUT_MS);
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

  async waitForPortRelease(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.portAvailabilityProbe(port)) return;
      await this.sleep(250);
    }
    throw processError(`CDP 端口 ${port} 未能在超时时间内释放。`, 'CDP_PORT_RELEASE_TIMEOUT');
  }
}

module.exports = {
  DEFAULT_DEBUG_PORT,
  buildProcessTreeSnapshot,
  ControlledCodexProcess,
  activateCodexApplication,
  parsePowerShellJson,
  probePortAvailable,
  probeCdp,
  resolveCodexDesktopPackage,
  resolveCodexProcessTree,
  resolveCodexProcesses,
  resolvePortOwner,
  terminateProcessByPid,
  terminateProcessTree,
};
