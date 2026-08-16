const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CODEX_DESKTOP_PROFILE,
  selectPrimaryCodexTarget,
} = require('../../desktop/src/codex-desktop-compatibility');

test('官方客户端控制使用与版本号无关的页面结构契约', () => {
  assert.equal(CODEX_DESKTOP_PROFILE.id, 'codex-desktop-structural-v1');
  assert.equal(Object.hasOwn(CODEX_DESKTOP_PROFILE, 'versionPattern'), false);
});

test('CDP 目标选择排除快捷窗口、错误端口和多个主页面', () => {
  const primary = { url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9230/devtools/page/main' };
  const quick = { url: 'app://-/index.html?initialRoute=/chatgpt/quick-chat', webSocketDebuggerUrl: 'ws://127.0.0.1:9230/devtools/page/quick' };
  const otherPort = { url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/other' };

  assert.equal(selectPrimaryCodexTarget([quick, otherPort, primary], 9230), primary);
  assert.equal(selectPrimaryCodexTarget([primary, { ...primary, webSocketDebuggerUrl: 'ws://127.0.0.1:9230/devtools/page/second' }], 9230), null);
});

test('CDP 目标选择排除新版头像浮层并保留唯一主页面', () => {
  const primary = {
    id: '9A0B3E6D16F8FC5A879B44323BD73B71',
    title: 'Codex',
    type: 'page',
    url: 'app://-/index.html',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9230/devtools/page/9A0B3E6D16F8FC5A879B44323BD73B71',
  };
  const avatarOverlay = {
    id: 'F58F1AF634BF36262D978E3C5BC9C746',
    title: 'Codex',
    type: 'page',
    url: 'app://-/index.html?initialRoute=%2Favatar-overlay',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9230/devtools/page/F58F1AF634BF36262D978E3C5BC9C746',
  };

  assert.equal(selectPrimaryCodexTarget([primary, avatarOverlay], 9230), primary);
});
