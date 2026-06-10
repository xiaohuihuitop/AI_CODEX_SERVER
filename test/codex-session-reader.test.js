const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  CodexSessionReader,
  projectNameFromCwd,
  reasoningText,
  stripCodexUiDirectives,
  threadIdFromSessionFile,
} = require('../src/codex-session-reader');

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
