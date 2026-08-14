const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CodexSessionReader,
  applyDesktopRuntimeStatus,
  paginateMessagesByTurn,
  projectNameFromCwd,
  reasoningText,
  stripCodexUiDirectives,
  threadIdFromSessionFile,
} = require('../../desktop/src/codex-session-reader');
const { parseSession } = require('../src/session-cache');

const fixtureRoot = path.join(__dirname, 'fixtures');

test('从会话文件名提取 threadId', () => {
  assert.equal(
    threadIdFromSessionFile('2026-06-08T10-00-00-000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  );
});

test('过滤 Codex Desktop UI 指令行', () => {
  const text = [
    '已推送到 GitHub。',
    '',
    '::git-push{cwd="C:\\Users\\admin\\Desktop\\demo" branch="master"}',
    '保留正文。',
  ].join('\n');

  assert.equal(stripCodexUiDirectives(text), '已推送到 GitHub。\n\n保留正文。');
});

test('过滤 in-app browser 上下文并保留真实请求', () => {
  const text = [
    '# In app browser:',
    '- The user has the in-app browser open.',
    '- Current URL: http://127.0.0.1:5175/#/pages/settings/settings',
    '',
    '## My request for Codex:',
    'app端的ui修一下吧。',
  ].join('\n');

  assert.equal(stripCodexUiDirectives(text), 'app端的ui修一下吧。');
});

test('过滤裸露的 in-app browser 上下文', () => {
  const text = [
    'In app browser:',
    '- The user has the in-app browser open.',
    '- Current URL: http://127.0.0.1:14854/?token=test-token',
    '',
    '还是有错误不知道哪里来的。',
  ].join('\n');

  assert.equal(stripCodexUiDirectives(text), '还是有错误不知道哪里来的。');
});

test('提取 Codex 公开过程摘要', () => {
  assert.equal(reasoningText({ text: '正在检查项目结构' }), '正在检查项目结构');
  assert.equal(reasoningText({
    summary: [
      { type: 'summary_text', text: '读取文件' },
      { type: 'summary_text', text: '准备修改' },
    ],
    encrypted_content: 'hidden',
  }), '读取文件\n准备修改');
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

test('运行状态包含公开过程步骤', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const status = reader.parseStatus({ threadId: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd' });
  const reasoningSteps = status.steps.filter(item => item.kind === 'reasoning');
  const commentarySteps = status.steps.filter(item => item.kind === 'commentary');
  const toolSteps = status.steps.filter(item => item.kind === 'tools');

  assert.equal(status.status, 'running');
  assert.deepEqual(commentarySteps.map(item => item.text), ['我会检查当前任务上下文。']);
  assert.equal(commentarySteps.length, 1);
  assert.deepEqual(toolSteps.map(item => item.text), ['已运行 3 条命令']);
  assert.deepEqual(reasoningSteps.map(item => item.text), ['正在检查项目结构', '准备修改手机端显示逻辑']);
  assert.deepEqual(reasoningSteps.map(item => item.turnId), ['turn-running', 'turn-running']);
  assert.equal(status.turns.length, 1);
  assert.equal(status.turns[0].turnId, 'turn-running');
  assert.deepEqual(status.turns[0].steps.filter(item => item.kind === 'commentary').map(item => item.text), ['我会检查当前任务上下文。']);
  assert.equal(status.turns[0].steps.filter(item => item.kind === 'commentary').length, 1);
  assert.deepEqual(status.turns[0].steps.filter(item => item.kind === 'tools').map(item => item.text), ['已运行 3 条命令']);
  assert.deepEqual(status.turns[0].steps.filter(item => item.kind === 'reasoning').map(item => item.text), ['正在检查项目结构', '准备修改手机端显示逻辑']);
});

test('只有开始事件时不返回可显示处理过程', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const status = reader.parseStatus({ threadId: '11111111-2222-3333-4444-555555555555' });

  assert.equal(status.status, 'running');
  assert.equal(status.turns.length, 1);
  assert.equal(status.turns[0].turnId, 'turn-start-only');
  assert.equal(status.turns[0].startedAt, '2026-06-08T10:14:02.000Z');
  assert.deepEqual(status.steps, []);
  assert.deepEqual(status.turns[0].steps, []);
});

test('指定 since 后仍保留当前轮次的公开过程归属', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const status = reader.parseStatus({
    threadId: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd',
    since: '2026-06-08T10:12:03.500Z',
  });

  assert.equal(status.status, 'running');
  assert.equal(status.turns.length, 1);
  assert.equal(status.turns[0].turnId, 'turn-running');
  assert.deepEqual(status.turns[0].steps.filter(item => item.kind === 'commentary').map(item => item.text), ['我会检查当前任务上下文。']);
  assert.deepEqual(status.turns[0].steps.filter(item => item.kind === 'tools').map(item => item.text), ['已运行 3 条命令']);
  assert.deepEqual(status.turns[0].steps.filter(item => item.kind === 'reasoning').map(item => item.text), ['正在检查项目结构', '准备修改手机端显示逻辑']);
  assert.deepEqual(status.steps.filter(item => item.kind === 'reasoning').map(item => item.text), ['准备修改手机端显示逻辑']);
  assert.deepEqual(status.steps.filter(item => item.kind === 'tools').map(item => item.text), []);
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

test('打开线程同步只上传尾部和后续增量', () => {
  const offsets = new Map();
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const first = reader.readOpenThreadSync([
    { projectName: 'demo', threadName: '测试线程' },
  ], offsets, { initialLineLimit: 2 });
  const second = reader.readOpenThreadSync([
    { projectName: 'demo', threadName: '测试线程' },
  ], offsets, { initialLineLimit: 2 });

  assert.deepEqual(first.openThreadIds, ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
  assert.equal(first.sessions.length, 1);
  assert.equal(first.sessions[0].reset, true);
  assert.equal(first.sessions[0].lines.length, 2);
  assert.equal(second.sessions.length, 0);
  assert.deepEqual(second.openThreadIds, ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
});

test('已发现打开线程后增量同步不再扫描会话目录', () => {
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

  const offsets = new Map();
  const reader = new CountingReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const targets = reader.discoverOpenThreadSessions([
    { projectName: 'demo', threadName: '测试线程' },
  ]);
  const callsAfterDiscovery = reader.sessionFilesCalls;
  const first = reader.readKnownThreadSync(targets, offsets, { initialLineLimit: 2 });
  const second = reader.readKnownThreadSync(targets, offsets, { initialLineLimit: 2 });

  assert.equal(callsAfterDiscovery, 1);
  assert.equal(reader.sessionFilesCalls, callsAfterDiscovery);
  assert.equal(first.sessions.length, 1);
  assert.equal(second.sessions.length, 0);
});

test('侧栏可见线程在索引缺失标题时仍可精确发现且不包含归档会话', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });

  const targets = reader.discoverOpenThreadSessions([
    { projectName: 'demo', threadName: '我现在 手机端 看不到任何对话. web 也看不见 : http://www.xiaohuihuitop.top:80…' },
  ]);

  assert.deepEqual(targets.map(target => target.threadId), ['22222222-3333-4444-5555-666666666666']);
  assert.deepEqual(targets.map(target => target.threadName), ['我现在 手机端 看不到任何对话. web 也看不见 : http://www.xiaohuihuitop.top:80…']);
});

test('发现本机全部会话时不依赖 Codex 当前打开的窗口', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });

  const targets = reader.discoverThreadSessions(160);

  assert.equal(targets.length, reader.sessionFiles().length);
  assert.equal(targets.some(target => target.threadName === '未打开线程'), true);
  assert.equal(targets.some(target => target.threadName === '测试线程'), true);
});

test('通用线程目录仅映射同一 threadId 的本地 JSONL', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });

  const targets = reader.discoverCatalogThreadSessions([
    { id: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd', name: '目录标题', cwd: 'C:\\repo\\running', updatedAt: 1780910000 },
    { id: '00000000-0000-0000-0000-000000000000', name: '不存在的会话' },
  ]);

  assert.deepEqual(targets.map(target => target.threadId), ['ffffffff-aaaa-bbbb-cccc-dddddddddddd']);
  assert.equal(targets[0].threadName, '目录标题');
  assert.equal(targets[0].projectName, 'running');
  assert.equal(targets[0].updatedAt, '2026-06-08T09:13:20.000Z');
});

test('Desktop 线程目录能映射其他目录不可见的本地 JSONL', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });

  const targets = reader.discoverDesktopThreadSessions([
    { id: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd', name: 'Desktop 状态标题', cwd: 'C:\\repo\\desktop', updatedAt: 1780910000 },
  ]);

  assert.deepEqual(targets.map(target => target.threadId), ['ffffffff-aaaa-bbbb-cccc-dddddddddddd']);
  assert.equal(targets[0].threadName, '运行中线程');
  assert.equal(targets[0].projectName, 'desktop');
});

test('Desktop 线程目录映射不扫描会话正文', () => {
  class BodyScanReader extends CodexSessionReader {
    discoverThreadSessions() {
      throw new Error('Desktop 目录映射不应扫描全部会话正文');
    }
  }

  const reader = new BodyScanReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const targets = reader.discoverDesktopThreadSessions([
    { id: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd', name: 'Desktop 状态标题', cwd: 'C:\\repo\\desktop', updatedAt: 1780910000 },
  ]);

  assert.deepEqual(targets.map(target => target.threadId), ['ffffffff-aaaa-bbbb-cccc-dddddddddddd']);
  assert.equal(targets[0].threadName, '运行中线程');
});

test('首轮同步受字节预算限制时仍上传全部线程元数据', () => {
  const offsets = new Map();
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const targets = reader.discoverOpenThreadSessions([
    { projectName: 'demo', threadName: '测试线程' },
    { projectName: 'demo', threadName: '第二线程' },
    { projectName: 'demo', threadName: '运行中线程' },
  ]);
  const sync = reader.readKnownThreadSync(targets, offsets, {
    initialLineLimit: 1000,
    syncByteLimit: 1024,
  });

  assert.deepEqual(sync.openThreadIds, targets.map(target => target.threadId));
  assert.equal(sync.sessions.length, targets.length);
  assert.equal(sync.sessions.some(session => session.metadataOnly), true);
  assert.equal(offsets.size < targets.length, true);
});

test('分批同步只解析当前批次，避免长时间阻塞 Agent 心跳', () => {
  const offsets = new Map();
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const targets = reader.discoverOpenThreadSessions([
    { projectName: 'demo', threadName: '测试线程' },
    { projectName: 'demo', threadName: '第二线程' },
    { projectName: 'demo', threadName: '运行中线程' },
  ]);
  const sync = reader.readKnownThreadSync(targets, offsets, {
    snapshotMessageLimit: 10,
    maxTargets: 2,
  });

  assert.deepEqual(sync.openThreadIds, targets.slice(0, 2).map(target => target.threadId));
  assert.equal(sync.sessions.length, 2);
  assert.equal(offsets.size, 2);
});

test('紧凑会话快照在首轮同步时保留最近消息和当前状态', () => {
  const offsets = new Map();
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const targets = reader.discoverOpenThreadSessions([
    { projectName: 'demo', threadName: '测试线程' },
  ]);
  const sync = reader.readKnownThreadSync(targets, offsets, {
    snapshotMessageLimit: 10,
    syncByteLimit: 64 * 1024,
  });

  assert.equal(sync.sessions.length, 1);
  assert.equal(sync.sessions[0].metadataOnly, undefined);
  assert.deepEqual(sync.sessions[0].snapshot.messages.map(message => message.text), ['你好 Codex', '你好，我在 Windows 上。']);
  assert.equal(sync.sessions[0].snapshot.status.status, 'complete');
  assert.equal(offsets.get(targets[0].threadId).size > 0, true);
  assert.deepEqual(sync.openThreadIds, [targets[0].threadId]);
});

test('紧凑会话快照不调用完整历史和状态解析', () => {
  class BoundedSnapshotReader extends CodexSessionReader {
    parseHistory() {
      throw new Error('后台快照不应完整解析历史');
    }

    parseStatus() {
      throw new Error('后台快照不应完整解析状态');
    }
  }

  const offsets = new Map();
  const reader = new BoundedSnapshotReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const targets = reader.discoverOpenThreadSessions([
    { projectName: 'demo', threadName: '测试线程' },
  ]);
  const sync = reader.readKnownThreadSync(targets, offsets, {
    snapshotMessageLimit: 10,
    syncByteLimit: 64 * 1024,
  });

  assert.deepEqual(sync.sessions[0].snapshot.messages.map(message => message.text), ['你好 Codex', '你好，我在 Windows 上。']);
  assert.equal(sync.sessions[0].snapshot.status.status, 'complete');
});

test('桌面已空闲时结束缺少 JSONL 终止事件的运行状态', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const running = reader.parseStatus({ threadId: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd' });
  const status = applyDesktopRuntimeStatus(running, {
    state: 'idle',
    observedAt: '2026-06-08T10:15:00.000Z',
  });

  assert.equal(running.status, 'running');
  assert.equal(status.active, false);
  assert.equal(status.status, 'complete');
  assert.equal(status.completedAt, '2026-06-08T10:15:00.000Z');
  assert.equal(status.turns.at(-1).status, 'complete');
});

test('未知 app-server 运行态不会覆盖 Desktop JSONL 的运行状态', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const running = reader.parseStatus({ threadId: 'ffffffff-aaaa-bbbb-cccc-dddddddddddd' });
  const status = applyDesktopRuntimeStatus(running, { state: 'unknown', observedAt: '2026-06-08T10:15:00.000Z' });

  assert.equal(status.active, true);
  assert.equal(status.status, 'running');
});

test('App Server 失败终态覆盖 JSONL 中尚未结束的运行状态', () => {
  const status = applyDesktopRuntimeStatus({
    ok: true,
    available: true,
    active: true,
    status: 'running',
    final: '',
    turns: [{ turnId: 'turn-failed', status: 'running', steps: [] }],
  }, {
    state: 'error',
    turnId: 'turn-failed',
    observedAt: '2026-08-10T10:00:00.000Z',
  });

  assert.equal(status.active, false);
  assert.equal(status.status, 'error');
  assert.equal(status.turns[0].status, 'error');
});

test('桌面仍在运行时覆盖 JSONL 中上一轮的完成状态', () => {
  const status = applyDesktopRuntimeStatus({
    ok: true,
    available: true,
    active: false,
    status: 'complete',
    preview: '上一轮回复',
    final: '上一轮回复',
    turns: [{ turnId: 'turn-complete', status: 'complete', steps: [], final: '上一轮回复' }],
  }, {
    state: 'running',
    observedAt: '2026-06-08T10:16:00.000Z',
  });

  assert.equal(status.active, true);
  assert.equal(status.status, 'running');
  assert.equal(status.final, '');
  assert.equal(status.preview, 'Codex 正在回复...');
});

test('桌面运行态变化时即使 JSONL 未变化也重新同步状态快照', () => {
  const offsets = new Map();
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const targets = reader.discoverOpenThreadSessions([
    { projectName: 'demo', threadName: '运行中线程' },
  ]);
  const first = reader.readKnownThreadSync(targets, offsets, { snapshotMessageLimit: 10 });
  targets[0].desktopRuntime = { state: 'idle', observedAt: '2026-06-08T10:15:00.000Z' };
  const second = reader.readKnownThreadSync(targets, offsets, { snapshotMessageLimit: 10 });
  const third = reader.readKnownThreadSync(targets, offsets, { snapshotMessageLimit: 10 });

  assert.equal(first.sessions[0].snapshot.status.status, 'running');
  assert.equal(second.sessions.length, 1);
  assert.equal(second.sessions[0].snapshot.status.status, 'complete');
  assert.equal(offsets.get(targets[0].threadId).desktopState, 'idle');
  assert.equal(third.sessions.length, 0);
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
  assert.equal(history.messages[1].turnId, 'turn-1');
});

test('发送证据只从会话尾部读取控制开始后的新回合', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });

  assert.deepEqual(reader.findTurnStartedSince(
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    '2026-06-08T10:00:02.500Z',
  ), {
    turnId: 'turn-1',
    observedAt: '2026-06-08T10:00:03.000Z',
  });
  assert.equal(reader.findTurnStartedSince(
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    '2026-06-08T10:00:03.500Z',
  ), null);
});

test('解析线程历史使用 turnId 稳定游标且新增回合不改变更早页', () => {
  const messages = [
    { role: 'user', text: '问题 1', turnId: 'turn-1' },
    { role: 'assistant', text: '回答 1', turnId: 'turn-1' },
    { role: 'user', text: '问题 2', turnId: 'turn-2' },
    { role: 'assistant', text: '回答 2', turnId: 'turn-2' },
    { role: 'user', text: '问题 3', turnId: 'turn-3' },
    { role: 'assistant', text: '回答 3', turnId: 'turn-3' },
  ];
  const newest = paginateMessagesByTurn(messages, 2);
  const afterAppend = messages.concat([
    { role: 'user', text: '问题 4', turnId: 'turn-4' },
    { role: 'assistant', text: '回答 4', turnId: 'turn-4' },
  ]);
  const older = paginateMessagesByTurn(afterAppend, 2, newest.nextBefore);

  assert.deepEqual(newest.messages.map(item => item.text), ['问题 2', '回答 2', '问题 3', '回答 3']);
  assert.equal(newest.nextBefore, 'turn:turn-2');
  assert.deepEqual(older.messages.map(item => item.text), ['问题 1', '回答 1']);
  assert.equal(older.hasMore, false);
});

test('解析线程历史时保留 task_complete 中的最终回复', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const history = reader.parseHistory('99999999-aaaa-bbbb-cccc-dddddddddddd', 20);

  assert.equal(history.available, true);
  assert.deepEqual(history.messages.map(item => item.role), ['user', 'assistant']);
  assert.equal(history.messages[1].text, '这是完成事件里的最终回复。');
  assert.equal(history.messages[1].turnId, 'turn-complete-only');
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

test('手动停止 turn_aborted 后 Desktop 与 Relay 都结束运行状态', () => {
  const file = path.join(fixtureRoot, 'events', 'turn-aborted.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });

  const desktopStatus = reader.parseStatus({
    threadId: '55555555-6666-7777-8888-999999999999',
    file,
  });
  const relayStatus = parseSession(lines, '55555555-6666-7777-8888-999999999999').status;

  for (const status of [desktopStatus, relayStatus]) {
    assert.equal(status.active, false);
    assert.equal(status.status, 'complete');
    assert.equal(status.completedAt, '2026-08-11T08:00:02.000Z');
    assert.equal(status.turns[0].status, 'interrupted');
    assert.equal(status.turns[0].completedAt, '2026-08-11T08:00:02.000Z');
    assert.equal(status.turns[0].interruptionReason, '用户停止');
  }
});

test('同一轮最终回复的双记录只保留一个最终步骤', () => {
  const reader = new CodexSessionReader({
    sessionsDir: path.join(fixtureRoot, 'sessions'),
    sessionIndexFile: path.join(fixtureRoot, 'session_index.jsonl'),
  });
  const status = reader.parseStatus({
    file: path.join(fixtureRoot, 'sessions', '2026-08-05T02-00-00-000Z-12345678-1234-1234-1234-1234567890ab.jsonl'),
  });
  const finalSteps = status.turns[0].steps.filter(item => item.kind === 'final');

  assert.equal(finalSteps.length, 1);
  assert.equal(finalSteps[0].text, '最终回复');
});
