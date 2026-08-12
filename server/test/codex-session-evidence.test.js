const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexSessionEvidence } = require('../../desktop/src/codex-session-evidence');

test('JSONL 确认器等待目标线程出现发送后的新回合', async () => {
  let reads = 0;
  const evidence = new CodexSessionEvidence({
    reader: {
      parseStatus: () => {
        reads += 1;
        return {
          turns: reads === 1 ? [] : [{ turnId: 'turn-1', startedAt: '2026-08-12T01:00:01.000Z' }],
        };
      },
    },
    sleep: async () => {},
    timeoutMs: 100,
  });

  assert.deepEqual(await evidence.waitForTurnStarted('thread-1', '2026-08-12T01:00:00.000Z'), {
    turnId: 'turn-1',
    observedAt: '2026-08-12T01:00:01.000Z',
  });
});

test('JSONL 确认器不接受控制开始时间之前的旧回合', async () => {
  const evidence = new CodexSessionEvidence({
    reader: { parseStatus: () => ({ turns: [{ turnId: 'old', startedAt: '2026-08-12T00:59:00.000Z' }] }) },
    sleep: async () => {},
    timeoutMs: 5,
  });
  await assert.rejects(
    () => evidence.waitForTurnStarted('thread-1', '2026-08-12T01:00:00.000Z'),
    error => error.code === 'TURN_START_CONFIRM_TIMEOUT',
  );
});

test('JSONL 确认器等待目标线程从运行转为停止', async () => {
  let reads = 0;
  const evidence = new CodexSessionEvidence({
    reader: {
      parseStatus: () => {
        reads += 1;
        return reads === 1
          ? { status: 'running', turns: [{ status: 'running' }] }
          : { status: 'complete', turns: [{ status: 'interrupted' }] };
      },
    },
    sleep: async () => {},
    timeoutMs: 100,
  });
  assert.deepEqual(await evidence.waitForStopped('thread-1'), { status: 'interrupted' });
});
