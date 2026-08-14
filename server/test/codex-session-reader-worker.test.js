const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { CodexSessionReader } = require('../../desktop/src/codex-session-reader');
const { CodexSessionReaderWorkerClient } = require('../../desktop/src/codex-session-reader-worker-client');

const fixtureRoot = path.join(__dirname, 'fixtures');
const readerOptions = {
  sessionsDir: path.join(fixtureRoot, 'sessions'),
  sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
};

test('会话读取 Worker 返回历史、状态并写回同步游标', async t => {
  const worker = new CodexSessionReaderWorkerClient({ readerOptions });
  t.after(() => worker.close());
  const reader = new CodexSessionReader(readerOptions);
  const target = reader.discoverDesktopThreadSessions([
    { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: '测试线程', cwd: 'C:\\Users\\admin\\Desktop\\demo' },
  ])[0];
  const offsets = new Map();

  const [history, status, sync] = await Promise.all([
    worker.parseHistory(target.threadId, 5, ''),
    worker.parseStatus({ threadId: target.threadId }),
    worker.readKnownThreadSync([target], offsets, { snapshotMessageLimit: 5, syncByteLimit: 64 * 1024 }),
  ]);

  assert.deepEqual(history.messages.map(message => message.text), ['你好 Codex', '你好，我在 Windows 上。']);
  assert.equal(status.status, 'complete');
  assert.equal(sync.sessions[0].snapshot.status.status, 'complete');
  assert.equal(offsets.get(target.threadId).size > 0, true);
});
