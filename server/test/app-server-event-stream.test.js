const assert = require('node:assert/strict');
const test = require('node:test');
const { createAppServerEventStream } = require('../../desktop/src/app-server-event-stream');

test('App Server 通知转换为带流标识和单调序号的跨端事件', () => {
  const times = [
    '2026-08-10T00:00:00.000Z',
    '2026-08-10T00:00:00.100Z',
  ];
  const stream = createAppServerEventStream({
    deviceId: 'device-3060',
    streamId: 'stream-test',
    now: () => times.shift(),
  });

  const started = stream.fromNotification('turn/started', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'inProgress' },
  });
  const completed = stream.fromNotification('turn/completed', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'completed' },
  });

  assert.deepEqual(started, {
    streamId: 'stream-test',
    seq: 1,
    eventId: 'stream-test:1',
    threadId: 'thread-1',
    turnId: 'turn-1',
    source: 'agent-app-server',
    observedAt: '2026-08-10T00:00:00.000Z',
    type: 'turn.started',
    payload: {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress' },
    },
  });
  assert.equal(completed.seq, 2);
  assert.equal(completed.eventId, 'stream-test:2');
  assert.equal(completed.type, 'turn.completed');
  assert.deepEqual(stream.state(), { streamId: 'stream-test', lastSeq: 2, deviceId: 'device-3060' });
});

test('缺少线程标识的 App Server 通知不进入线程事件流', () => {
  const stream = createAppServerEventStream({ deviceId: 'device-3060', streamId: 'stream-test' });

  assert.equal(stream.fromNotification('account/updated', { authMode: 'chatgpt' }), null);
  assert.deepEqual(stream.state(), { streamId: 'stream-test', lastSeq: 0, deviceId: 'device-3060' });
});
