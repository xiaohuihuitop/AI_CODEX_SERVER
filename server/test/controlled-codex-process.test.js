const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ControlledCodexProcess,
  parsePowerShellJson,
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

test('受控重启通过窗口关闭请求退出官方客户端，不强制终止进程', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../desktop/src/controlled-codex-process.js'), 'utf8');
  assert.match(source, /CloseMainWindow\(\)/);
  assert.doesNotMatch(source, /Stop-Process -Id \$id -Force/);
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
