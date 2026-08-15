const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexDesktopUiController } = require('../../desktop/src/codex-desktop-ui-controller');

function createCdp(overrides = {}) {
  const calls = [];
  return Object.assign({
    calls,
    connect: async () => calls.push(['connect']),
    evaluate: async expression => {
      calls.push(['evaluate', expression]);
      return null;
    },
    request: async (method, params) => {
      calls.push(['request', method, params]);
      return {};
    },
  }, overrides);
}

test('界面控制器启动时验证已知 DOM 控制契约', async () => {
  const compatible = new CodexDesktopUiController({
    cdp: createCdp({ evaluate: async () => ({ threadRows: 2, editor: true, action: true }) }),
  });
  const incompatible = new CodexDesktopUiController({
    cdp: createCdp({ evaluate: async () => ({ threadRows: 2, editor: true, action: false }) }),
  });

  assert.equal((await compatible.probeCompatibility()).profileId, 'codex-desktop-26.707.3748');
  await assert.rejects(
    () => incompatible.probeCompatibility(),
    error => error.code === 'CODEX_DESKTOP_DOM_INCOMPATIBLE',
  );
});

test('界面控制器按 threadId 精确选择侧栏线程并核对选中结果', async () => {
  const cdp = createCdp({
    evaluate: async expression => {
      cdp.calls.push(['evaluate', expression]);
      if (expression.includes('return inspect()')) return { found: true, selected: false, rect: { x: 10, y: 20, width: 100, height: 40 } };
      if (expression.includes('aria-current')) return { found: true, selected: true, threadId: 'local:thread-1' };
      return null;
    },
  });
  const controller = new CodexDesktopUiController({ cdp, sleep: async () => {} });

  const selected = await controller.selectThread('thread-1');

  assert.equal(selected.threadId, 'thread-1');
  assert.equal(cdp.calls.some(call => call[0] === 'request' && call[1] === 'Input.dispatchMouseEvent'), true);
  assert.equal(cdp.calls.some(call => call[0] === 'evaluate' && call[1].includes('local:thread-1')), true);
});

test('界面控制器找不到 threadId 时明确失败且不按标题猜测', async () => {
  const cdp = createCdp({ evaluate: async () => ({ found: false, selected: false }) });
  const controller = new CodexDesktopUiController({ cdp });

  await assert.rejects(
    () => controller.selectThread('missing-thread'),
    error => error.code === 'THREAD_ROW_NOT_FOUND',
  );
});

test('界面控制器检测到草稿或目标线程运行中时拒绝发送', async () => {
  const draft = new CodexDesktopUiController({
    cdp: createCdp(),
    threadSelector: async () => ({ threadId: 'thread-1' }),
    composerReader: async () => ({ found: true, draft: '本地草稿', action: 'send', disabled: false }),
  });
  const running = new CodexDesktopUiController({
    cdp: createCdp(),
    threadSelector: async () => ({ threadId: 'thread-1' }),
    composerReader: async () => ({ found: true, draft: '', action: 'stop', disabled: false }),
  });

  await assert.rejects(() => draft.sendMessage('thread-1', '手机消息'), error => error.code === 'LOCAL_DRAFT_EXISTS');
  await assert.rejects(() => running.sendMessage('thread-1', '手机消息'), error => error.code === 'THREAD_ALREADY_RUNNING');
});

test('界面控制器精确校验输入并点击发送后以 JSONL 新回合确认结果', async () => {
  const cdp = createCdp();
  const states = [
    { found: true, draft: '', action: 'send', disabled: false, editorRect: { x: 10, y: 20, width: 400, height: 80 } },
    { found: true, draft: '手机消息', action: 'send', disabled: false, sendRect: { x: 430, y: 40, width: 30, height: 30 } },
  ];
  const confirmations = [];
  const controller = new CodexDesktopUiController({
    cdp,
    threadSelector: async () => ({ threadId: 'thread-1' }),
    composerReader: async () => states.shift(),
    sessionConfirmer: async (threadId, since) => {
      confirmations.push([threadId, since]);
      return { turnId: 'turn-1', observedAt: '2026-08-12T00:00:00.000Z' };
    },
    sleep: async () => {},
  });

  const result = await controller.sendMessage('thread-1', '手机消息');

  assert.equal(cdp.calls.some(call => call[1] === 'Input.insertText' && call[2].text === '手机消息'), true);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0][0], 'thread-1');
  assert.equal(Number.isFinite(Date.parse(confirmations[0][1])), true);
  assert.deepEqual(result, {
    ok: true,
    threadId: 'thread-1',
    turnId: 'turn-1',
    observedAt: '2026-08-12T00:00:00.000Z',
  });
});

test('界面控制器仅在目标线程显示停止按钮时执行停止', async () => {
  const cdp = createCdp();
  const controller = new CodexDesktopUiController({
    cdp,
    threadSelector: async () => ({ threadId: 'thread-1' }),
    composerReader: async () => ({ found: true, draft: '', action: 'stop', disabled: false, sendRect: { x: 430, y: 40, width: 30, height: 30 } }),
    sessionStopConfirmer: async () => ({ status: 'interrupted' }),
    sleep: async () => {},
  });

  assert.deepEqual(await controller.stop('thread-1'), { ok: true, threadId: 'thread-1', status: 'interrupted' });
  assert.equal(cdp.calls.some(call => call[0] === 'request' && call[1] === 'Input.dispatchMouseEvent'), true);
});

test('界面控制器直接读取当前官方客户端运行态', async () => {
  const cdp = createCdp({ evaluate: async () => ({ threadId: 'local:thread-1' }) });
  const controller = new CodexDesktopUiController({
    cdp,
    composerReader: async () => ({ found: true, draft: '', action: 'stop', disabled: false }),
  });

  assert.deepEqual(await controller.getThreadRuntime('thread-1'), { state: 'running', threadId: 'thread-1' });
});

test('界面控制器读取非当前线程状态时不切换电脑界面', async () => {
  let composerRead = false;
  const cdp = createCdp({ evaluate: async () => ({ threadId: 'local:other-thread' }) });
  const controller = new CodexDesktopUiController({
    cdp,
    threadSelector: async () => { throw new Error('不应切换线程'); },
    composerReader: async () => { composerRead = true; },
  });

  assert.deepEqual(await controller.getThreadRuntime('thread-1'), { state: 'unknown', threadId: 'thread-1' });
  assert.equal(composerRead, false);
});
