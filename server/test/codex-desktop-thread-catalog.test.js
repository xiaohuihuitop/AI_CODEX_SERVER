const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexDesktopThreadCatalog } = require('../../desktop/src/codex-desktop-thread-catalog');

test('Desktop 线程目录只读取未归档的 vscode 顶层线程', () => {
  const calls = [];
  const catalog = new CodexDesktopThreadCatalog({
    stateFile: 'state_5.sqlite',
    databaseFactory: (file, options) => ({
      prepare(sql) {
        calls.push({ file, options, sql });
        return {
          all(limit) {
            assert.equal(limit, 1000);
            return [{
              id: '019fa30b-7be2-7103-a8cc-0b62857b29bf',
              title: 'Start Trellis session',
              name: '',
              cwd: '\\\\?\\D:\\AI\\AI_CODEX_SERVER',
              updated_at: 1785849470,
              is_pinned: 0,
            }];
          },
        };
      },
      close() {},
    }),
  });

  assert.deepEqual(catalog.listThreads(), [{
    id: '019fa30b-7be2-7103-a8cc-0b62857b29bf',
    name: 'Start Trellis session',
    cwd: '\\\\?\\D:\\AI\\AI_CODEX_SERVER',
    updatedAt: 1785849470,
    pinned: false,
  }]);
  assert.match(calls[0].sql, /WHERE archived = 0/);
  assert.match(calls[0].sql, /source = 'vscode'/);
  assert.match(calls[0].sql, /thread_source IS NULL OR thread_source <> 'subagent'/);
  assert.match(calls[0].sql, /TRIM\(COALESCE\(title, name, ''\)\) <> ''/);
  assert.deepEqual(calls[0].options, { readOnly: true });
});
