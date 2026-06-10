const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'mobile-app');

test('uni-app Android 手机端工程包含必要入口和默认连接配置', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'src', 'manifest.json'), 'utf8'));
  const pages = JSON.parse(fs.readFileSync(path.join(appDir, 'src', 'pages.json'), 'utf8'));
  const config = fs.readFileSync(path.join(appDir, 'src', 'utils', 'config.js'), 'utf8');
  const index = fs.readFileSync(path.join(appDir, 'src', 'pages', 'index', 'index.vue'), 'utf8');

  assert.equal(pkg.scripts['build:app'], 'uni build -p app');
  assert.match(pkg.dependencies['@dcloudio/uni-app'], /^3\.0\.0-/);
  assert.equal(manifest['app-plus'].distribute.android.packagename, 'top.xiaohuihui.codex.mobile');
  assert.equal(manifest['app-plus'].distribute.android.usesCleartextTraffic, true);
  assert.deepEqual(pages.pages.map(page => page.path), ['pages/index/index', 'pages/settings/settings']);
  assert.match(config, /http:\/\/www\.xiaohuihuitop\.top:8008/);
  assert.match(config, /xiaohuihui/);
  assert.match(index, /getThreads/);
  assert.match(index, /getHistory/);
  assert.match(index, /sendMessage/);
  assert.match(index, /stopCodex/);
});
