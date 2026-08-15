const assert = require('node:assert/strict');
const test = require('node:test');
const {
  resolveCodexDesktopProfile,
  selectPrimaryCodexTarget,
} = require('../../desktop/src/codex-desktop-compatibility');

test('官方客户端兼容配置只接受已验证版本族', () => {
  assert.equal(resolveCodexDesktopProfile('26.707.3748.0').id, 'codex-desktop-26.707.3748');
  assert.throws(
    () => resolveCodexDesktopProfile('26.800.1.0'),
    error => error.code === 'CODEX_DESKTOP_VERSION_UNSUPPORTED',
  );
});

test('CDP 目标选择排除快捷窗口、错误端口和多个主页面', () => {
  const profile = resolveCodexDesktopProfile('26.707.3748.0');
  const primary = { url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9230/devtools/page/main' };
  const quick = { url: 'app://-/index.html?initialRoute=/chatgpt/quick-chat', webSocketDebuggerUrl: 'ws://127.0.0.1:9230/devtools/page/quick' };
  const otherPort = { url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/other' };

  assert.equal(selectPrimaryCodexTarget([quick, otherPort, primary], 9230, profile), primary);
  assert.equal(selectPrimaryCodexTarget([primary, { ...primary, webSocketDebuggerUrl: 'ws://127.0.0.1:9230/devtools/page/second' }], 9230, profile), null);
});
