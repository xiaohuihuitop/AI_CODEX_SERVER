const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CodexSessionReader, projectNameFromCwd, threadIdFromSessionFile } = require('../src/codex-session-reader');

const fixtureRoot = path.join(__dirname, 'fixtures');

test('从会话文件名提取 threadId', () => {
  assert.equal(
    threadIdFromSessionFile('2026-06-08T10-00-00-000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  );
});

test('跨平台提取 Codex 会话项目名', () => {
  assert.equal(projectNameFromCwd('C:\\Users\\admin\\Desktop\\demo'), 'demo');
  assert.equal(projectNameFromCwd('/home/admin/demo'), 'demo');
});

test('列出线程并合并 index 标题', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const threads = reader.listThreads(10);
  const target = threads.find(item => item.id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.ok(target);
  assert.equal(target.name, '测试线程');
  assert.equal(target.runtimeStatus, undefined);
});

test('列出线程时不解析每个线程状态', () => {
  class ThrowingStatusReader extends CodexSessionReader {
    parseStatus() {
      throw new Error('listThreads should not parse status');
    }
  }

  const reader = new ThrowingStatusReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const threads = reader.listThreads(10);
  assert.ok(threads.length >= 1);
});

test('只列出 Codex Desktop 当前打开的线程', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const threads = reader.listOpenThreads([
    { projectName: 'demo', threadName: '测试线程' },
  ]);

  assert.deepEqual(threads.map(item => item.id), ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
  assert.equal(threads[0].name, '测试线程');
  assert.equal(threads[0].projectName, 'demo');
});

test('同一项目下多个打开线程都保留', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const threads = reader.listOpenThreads([
    { projectName: 'demo', threadName: '测试线程' },
    { projectName: 'demo', threadName: '第二线程' },
  ]);

  assert.deepEqual(threads.map(item => item.name), ['测试线程', '第二线程']);
  assert.deepEqual([...new Set(threads.map(item => item.projectName))], ['demo']);
});

test('打开线程列表包含运行状态', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const threads = reader.listOpenThreads([
    { projectName: 'demo', threadName: '测试线程' },
    { projectName: 'demo', threadName: '运行中线程' },
  ]);

  assert.deepEqual(threads.map(item => item.status), ['complete', 'running']);
  assert.deepEqual(threads.map(item => item.active), [false, true]);
});

test('打开线程列表只扫描一次会话目录', () => {
  class CountingReader extends CodexSessionReader {
    constructor(options) {
      super(options);
      this.sessionFilesCalls = 0;
    }

    sessionFiles() {
      this.sessionFilesCalls += 1;
      return super.sessionFiles();
    }
  }

  const reader = new CountingReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  reader.listOpenThreads([
    { projectName: 'demo', threadName: '测试线程' },
    { projectName: 'demo', threadName: '第二线程' },
    { projectName: 'demo', threadName: '运行中线程' },
  ]);

  assert.equal(reader.sessionFilesCalls, 1);
});

test('解析线程历史', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const history = reader.parseHistory('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 20);
  assert.equal(history.available, true);
  assert.deepEqual(history.messages.map(item => item.role), ['user', 'assistant']);
  assert.equal(history.messages[0].text, '你好 Codex');
  assert.equal(history.messages[1].text, '你好，我在 Windows 上。');
});

test('解析线程控制目标元数据', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const target = reader.getThreadTarget('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(target.available, true);
  assert.equal(target.threadId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(target.threadName, '测试线程');
  assert.equal(target.projectName, 'demo');
  assert.equal(target.cwd, 'C:\\Users\\admin\\Desktop\\demo');
});

test('解析完成状态', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const status = reader.parseStatus({ threadId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.equal(status.available, true);
  assert.equal(status.status, 'complete');
  assert.equal(status.final, '你好，我在 Windows 上。');
});

test('指定 since 后不使用旧回复作为完成状态', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const status = reader.parseStatus({
    threadId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    since: '2026-06-08T10:01:00.000Z',
  });
  assert.equal(status.available, true);
  assert.equal(status.status, 'idle');
  assert.equal(status.final, '');
});

test('final_answer 后缺少 task_complete 时也视为完成', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const status = reader.parseStatus({ threadId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' });
  assert.equal(status.available, true);
  assert.equal(status.active, false);
  assert.equal(status.status, 'complete');
  assert.equal(status.final, '最终回复');
});
