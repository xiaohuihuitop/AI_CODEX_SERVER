const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStructuredDiagnosticLog } = require('../../desktop/src/structured-diagnostics');

test('桌面诊断日志保留结构化关联字段并限制为 500 条', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-diagnostics-'));
  const file = path.join(directory, 'agent.jsonl');
  try {
    const diagnostics = createStructuredDiagnosticLog(file, 500);
    for (let index = 0; index < 505; index += 1) {
      diagnostics.record('control.stage', { commandId: `command-${index}`, threadId: 'thread-1' });
    }
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const first = JSON.parse(lines[0]);
    const last = JSON.parse(lines.at(-1));
    assert.equal(lines.length, 500);
    assert.equal(first.details.commandId, 'command-5');
    assert.equal(last.details.commandId, 'command-504');
    assert.equal(last.event, 'control.stage');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
