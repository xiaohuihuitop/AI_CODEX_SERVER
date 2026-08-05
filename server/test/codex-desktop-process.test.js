const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  restartCodexDesktopWithDebug,
} = require('../../desktop/src/codex-desktop-process');

test('重启 Codex Desktop 时使用调试端口启动主进程', async () => {
  const killed = [];
  const launches = [];
  const result = await restartCodexDesktopWithDebug({
    platform: 'win32',
    debugPort: 9229,
    waitTimeoutMs: 1,
    processFinder: () => ({
      pid: 1234,
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_x64\\app\\ChatGPT.exe',
      commandLine: '"ChatGPT.exe"',
    }),
    packageFinder: () => ({
      appUserModelId: 'OpenAI.Codex_2p2nqsd0c76g0!App',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_x64\\app\\ChatGPT.exe',
    }),
    processKiller: pid => killed.push(pid),
    launcher: (launchTarget, args) => {
      launches.push({ launchTarget, args });
      return { pid: 5678 };
    },
    debugWaiter: async () => ({ ok: true, targetCount: 1, message: '' }),
    processStopWaiter: async () => {},
  });

  assert.deepEqual(killed, [1234]);
  assert.deepEqual(launches, [{
    launchTarget: {
      appUserModelId: 'OpenAI.Codex_2p2nqsd0c76g0!App',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_x64\\app\\ChatGPT.exe',
    },
    args: [
      '--remote-debugging-port=9229',
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=http://127.0.0.1:9229',
    ],
  }]);
  assert.equal(result.appUserModelId, 'OpenAI.Codex_2p2nqsd0c76g0!App');
  assert.equal(result.executablePath, 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_x64\\app\\ChatGPT.exe');
  assert.equal(result.previousPid, 1234);
  assert.equal(result.launchedPid, 5678);
  assert.equal(result.debugPort, 9229);
});

test('重启 Codex Desktop 时未运行也会通过应用入口启动', async () => {
  const killed = [];
  const launches = [];
  const result = await restartCodexDesktopWithDebug({
    platform: 'win32',
    debugPort: 9333,
    waitTimeoutMs: 1,
    processFinder: () => null,
    packageFinder: () => ({
      appUserModelId: 'OpenAI.Codex_2p2nqsd0c76g0!App',
      executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_x64\\app\\ChatGPT.exe',
    }),
    processKiller: pid => killed.push(pid),
    launcher: (launchTarget, args) => {
      launches.push({ launchTarget, args });
      return { pid: 9012 };
    },
    debugWaiter: async () => ({ ok: true, targetCount: 1, message: '' }),
    processStopWaiter: async () => {},
  });

  assert.deepEqual(killed, []);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].args, [
    '--remote-debugging-port=9333',
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=http://127.0.0.1:9333',
  ]);
  assert.equal(result.previousPid, null);
  assert.equal(result.launchedPid, 9012);
});

test('重启 Codex Desktop 后 CDP 未就绪时返回明确失败', async () => {
  await assert.rejects(
    () => restartCodexDesktopWithDebug({
      platform: 'win32',
      processFinder: () => null,
      packageFinder: () => ({
        appUserModelId: 'OpenAI.Codex_2p2nqsd0c76g0!App',
        executablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_x64\\app\\ChatGPT.exe',
      }),
      processKiller: () => {},
      launcher: () => ({ pid: 9012 }),
      debugWaiter: async () => ({ ok: false, targetCount: 0, message: 'fetch failed' }),
      processStopWaiter: async () => {},
    }),
    error => error.code === 'CODEX_DEBUG_NOT_READY' && /fetch failed/.test(error.message),
  );
});

test('重启 Codex Desktop 时旧 GUI 未退出会停止启动并返回明确失败', async () => {
  await assert.rejects(
    () => restartCodexDesktopWithDebug({
      platform: 'win32',
      processFinder: () => ({ pid: 1234 }),
      packageFinder: () => ({ appUserModelId: 'OpenAI.Codex_2p2nqsd0c76g0!App' }),
      processKiller: () => {},
      processStopWaiter: async () => {
        throw Object.assign(new Error('Codex Desktop 进程 1234 未能退出。'), { code: 'CODEX_PROCESS_STOP_TIMEOUT' });
      },
      launcher: () => {
        throw new Error('不应启动');
      },
    }),
    error => error.code === 'CODEX_PROCESS_STOP_TIMEOUT',
  );
});

test('重启 Codex Desktop 时未安装应用会给出明确错误', async () => {
  await assert.rejects(
    () => restartCodexDesktopWithDebug({
      platform: 'win32',
      processFinder: () => null,
      packageFinder: () => null,
      processKiller: () => {},
      launcher: () => {},
    }),
    /未找到已安装的 Codex Desktop/,
  );
});

test('停止 Codex Desktop 不结束本地 app-server 后端进程', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'src', 'codex-desktop-process.js'), 'utf8');

  assert.doesNotMatch(source, /OpenAI\\\\Codex\\\\bin/);
  assert.doesNotMatch(source, /resources\\\\codex\.exe/);
});
