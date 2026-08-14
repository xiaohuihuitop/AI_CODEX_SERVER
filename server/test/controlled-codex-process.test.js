const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildActivateCodexApplicationScript,
  buildProcessTreeSnapshot,
  ControlledCodexProcess,
  parsePowerShellJson,
  terminateProcessTree,
} = require('../../desktop/src/controlled-codex-process');

const APP = {
  appUserModelId: 'OpenAI.Codex_2p2nqsd0c76g0!App',
  packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0',
  packageFullName: 'OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0',
  installLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0',
  executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe',
  executableName: 'ChatGPT.exe',
  version: '26.707.3748.0',
};

test('PowerShell 单对象和数组输出均规范为单对象', () => {
  assert.deepEqual(parsePowerShellJson('{"ProcessId":42}'), { ProcessId: 42 });
  assert.deepEqual(parsePowerShellJson('[{"ProcessId":42}]'), { ProcessId: 42 });
  assert.equal(parsePowerShellJson(''), null);
});

test('端口探测脚本不把已退出且无法查询进程的 PID 当作占用者', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../desktop/src/controlled-codex-process.js'), 'utf8');
  assert.match(source, /if \(\$null -eq \$proc\) \{ Write-Output ''; exit 0 \}/);
});

test('受控重启从系统快照建立完整进程树并保留深度', () => {
  const tree = buildProcessTreeSnapshot([
    { ProcessId: 138132, ParentProcessId: 748, Name: 'ChatGPT.exe' },
    { ProcessId: 50268, ParentProcessId: 138132, Name: 'codex.exe' },
    { ProcessId: 147504, ParentProcessId: 138132, Name: 'git.exe' },
    { ProcessId: 423920, ParentProcessId: 147504, Name: 'conhost.exe' },
    { ProcessId: 99, ParentProcessId: 1, Name: 'other.exe' },
  ], [138132]);

  assert.deepEqual(tree.map(item => [item.pid, item.parentPid, item.depth, item.name]), [
    [138132, 748, 0, 'ChatGPT.exe'],
    [50268, 138132, 1, 'codex.exe'],
    [147504, 138132, 1, 'git.exe'],
    [423920, 147504, 2, 'conhost.exe'],
  ]);
});

test('失效子 PID 不阻断终止且主进程最后退出', async () => {
  const calls = [];
  const result = await terminateProcessTree([
    { pid: 138132, parentPid: 748, depth: 0, name: 'ChatGPT.exe' },
    { pid: 50268, parentPid: 138132, depth: 1, name: 'codex.exe' },
    { pid: 147504, parentPid: 138132, depth: 1, name: 'git.exe' },
    { pid: 423920, parentPid: 147504, depth: 2, name: 'conhost.exe' },
  ], async pid => {
    calls.push(pid);
    if (pid === 423920 || pid === 147504) throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
  });

  assert.deepEqual(calls, [423920, 147504, 50268, 138132]);
  assert.deepEqual(result.terminatedPids, [50268, 138132]);
  assert.deepEqual(result.missingPids, [423920, 147504]);
});

test('非 ESRCH 的进程终止错误必须报告具体 PID', async () => {
  await assert.rejects(
    () => terminateProcessTree([{ pid: 50268, depth: 1, name: 'codex.exe' }], async () => {
      throw Object.assign(new Error('access denied'), { code: 'EPERM' });
    }),
    error => error.code === 'CODEX_PROCESS_TREE_TERMINATION_FAILED' && /PID 50268/.test(error.message),
  );
});

test('应用激活脚本不覆盖 PowerShell 只读 PID 自动变量', () => {
  const script = buildActivateCodexApplicationScript(APP, [
    '--remote-debugging-port=9230',
    '--remote-debugging-address=127.0.0.1',
  ]);

  assert.doesNotMatch(script, /\$pid\s*=/i);
  assert.match(script, /\$activatedProcessId\s*=\s*\[CodexActivationHelper\]::Activate/);
  assert.match(script, /ProcessId\s*=\s*\$activatedProcessId/);
});

test('受控进程从 Appx manifest 结果识别当前 ChatGPT 主进程', async () => {
  const process = new ControlledCodexProcess({
    platform: 'win32',
    packageResolver: async () => APP,
    processResolver: async app => {
      assert.equal(app.executableName, 'ChatGPT.exe');
      return [{ pid: 120, executablePath: APP.executablePath, commandLine: `"${APP.executablePath}"` }];
    },
  });

  const state = await process.inspect();

  assert.equal(state.app.executablePath, APP.executablePath);
  assert.equal(state.mainProcess.pid, 120);
});

test('受控启动拒绝非 Codex 进程占用配置端口', async () => {
  const process = new ControlledCodexProcess({
    platform: 'win32',
    packageResolver: async () => APP,
    processResolver: async () => [],
    portOwnerResolver: async () => ({ pid: 999, executablePath: 'C:\\Tools\\other.exe' }),
  });

  await assert.rejects(
    () => process.restart({ debugPort: 9230 }),
    error => error.code === 'CDP_PORT_OCCUPIED' && /PID 999/.test(error.message),
  );
});

test('用户确认受控重启后不再执行不可靠的草稿自动检查', async () => {
  let draftReadCount = 0;
  let stopped = false;
  let launched = false;
  const process = new ControlledCodexProcess({
    platform: 'win32',
    packageResolver: async () => APP,
    processResolver: async () => {
      if (launched) return [{ pid: 220, executablePath: APP.executablePath, commandLine: ' --remote-debugging-port=9230' }];
      if (stopped) return [];
      return [{ pid: 120, executablePath: APP.executablePath, commandLine: '' }];
    },
    portOwnerResolver: async () => null,
    portAvailabilityProbe: async () => true,
    draftReader: async () => {
      draftReadCount += 1;
      return { inspected: false, text: '' };
    },
    processStopper: async () => { stopped = true; },
    launcher: async () => {
      launched = true;
      return { pid: 220 };
    },
    cdpProbe: async () => ({ ok: true, targetCount: 1, message: '' }),
    sleep: async () => {},
  });

  const result = await process.restart({ debugPort: 9230, waitTimeoutMs: 100 });

  assert.equal(result.ok, true);
  assert.equal(stopped, true);
  assert.equal(draftReadCount, 0);
});

test('旧包进程未真正退出时拒绝启动新实例', async () => {
  let launchCount = 0;
  const process = new ControlledCodexProcess({
    platform: 'win32',
    packageResolver: async () => APP,
    processResolver: async () => [{ pid: 120, executablePath: APP.executablePath, commandLine: '' }],
    portOwnerResolver: async () => null,
    processStopper: async () => {},
    launcher: async () => {
      launchCount += 1;
      return { pid: 220 };
    },
    sleep: async () => {},
  });

  await assert.rejects(
    () => process.restart({ debugPort: 9230, exitTimeoutMs: 1 }),
    error => error.code === 'CODEX_STOP_TIMEOUT',
  );
  assert.equal(launchCount, 0);
});

test('旧进程退出后等待 CDP 端口实际释放再启动新实例', async () => {
  const phases = [];
  let stopped = false;
  let launched = false;
  let portProbeCount = 0;
  const process = new ControlledCodexProcess({
    platform: 'win32',
    packageResolver: async () => APP,
    processResolver: async () => {
      if (launched) return [{ pid: 220, executablePath: APP.executablePath, commandLine: '' }];
      return stopped ? [] : [{ pid: 120, executablePath: APP.executablePath, commandLine: '' }];
    },
    portOwnerResolver: async () => null,
    processStopper: async () => {
      phases.push('stop');
      stopped = true;
    },
    portAvailabilityProbe: async () => {
      phases.push('port');
      portProbeCount += 1;
      return portProbeCount >= 3;
    },
    launcher: async () => {
      phases.push('launch');
      launched = true;
      return { pid: 220 };
    },
    cdpProbe: async () => ({ ok: true, targetCount: 1, message: '' }),
    sleep: async () => {},
  });

  await process.restart({ debugPort: 9230, exitTimeoutMs: 100, portReleaseTimeoutMs: 100, waitTimeoutMs: 100 });

  assert.deepEqual(phases, ['stop', 'port', 'port', 'port', 'launch']);
});

test('受控启动只停止目标包进程并通过 AUMID 传递 CDP 参数', async () => {
  const calls = [];
  let stopped = false;
  let launched = false;
  const process = new ControlledCodexProcess({
    platform: 'win32',
    packageResolver: async () => APP,
    processResolver: async () => {
      if (launched) return [{ pid: 220, executablePath: APP.executablePath, commandLine: ' --remote-debugging-port=9230' }];
      if (stopped) return [];
      return [{ pid: 120, executablePath: APP.executablePath, commandLine: '' }];
    },
    portOwnerResolver: async () => null,
    portAvailabilityProbe: async () => true,
    processStopper: async (app, processes) => {
      calls.push(['stop', app.appUserModelId, processes.map(item => item.pid)]);
      stopped = true;
    },
    launcher: async (app, args) => {
      calls.push(['launch', app.appUserModelId, args]);
      launched = true;
      return { pid: 220 };
    },
    cdpProbe: async port => ({ ok: port === 9230, targetCount: 1, message: '' }),
    sleep: async () => {},
  });

  const result = await process.restart({ debugPort: 9230, waitTimeoutMs: 100 });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['stop', APP.appUserModelId, [120]],
    ['launch', APP.appUserModelId, [
      '--remote-debugging-port=9230',
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=http://127.0.0.1:9230',
    ]],
  ]);
});
