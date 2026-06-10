const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'mobile-app');

function listSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['.hbuilderx', 'dist', 'node_modules', 'unpackage'].includes(entry.name)) continue;
      files.push(...listSourceFiles(fullPath));
    } else if (/\.(js|vue)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

test('uni-app Android 手机端工程包含必要入口和默认连接配置', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf8'));
  const pages = JSON.parse(fs.readFileSync(path.join(appDir, 'pages.json'), 'utf8'));
  const config = fs.readFileSync(path.join(appDir, 'utils', 'config.js'), 'utf8');
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.equal(fs.existsSync(path.join(appDir, 'package.json')), false);
  assert.equal(fs.existsSync(path.join(appDir, 'node_modules')), false);
  assert.equal(manifest.vueVersion, '3');
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

test('uni-app Android 手机端不使用调试基座不兼容的运行时 API', () => {
  for (const file of listSourceFiles(appDir)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\.replaceAll\s*\(/, file);
    assert.doesNotMatch(source, /new\s+URL\s*\(/, file);
    assert.doesNotMatch(source, /\?\.|\?\?/, file);
    assert.doesNotMatch(source, /\.(startsWith|includes)\s*\(/, file);
    assert.doesNotMatch(source, /new\s+(Map|Set)\s*\(/, file);
    assert.doesNotMatch(source, /\.\.\.[A-Za-z_$]/, file);
  }
});

test('uni-app Android 手机端控制区和按钮布局稳定', () => {
  const app = fs.readFileSync(path.join(appDir, 'App.vue'), 'utf8');
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const settings = fs.readFileSync(path.join(appDir, 'pages', 'settings', 'settings.vue'), 'utf8');

  assert.match(index, /class="control-panel"/);
  assert.match(index, /\.page\s*\{[\s\S]*display:\s*flex;[\s\S]*height:\s*100vh;[\s\S]*overflow:\s*hidden;/);
  assert.match(index, /\.messages\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*height:\s*0;/);
  assert.doesNotMatch(index, /\.composer\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(app, /button\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;/);
  assert.match(app, /button::after\s*\{[\s\S]*border:\s*0;/);
  assert.match(settings, /\.primary,\s*\n\.secondary\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;/);
});

test('uni-app Android 手机端处理过程可展开且位于最终回答前', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /@click="toggleProcess"/);
  assert.match(index, /function toggleProcess\(\) \{[\s\S]*processOpen\.value = !processOpen\.value;/);
  assert.match(index, /const processInsertIndex = computed/);
  assert.match(index, /messagesBeforeProcess/);
  assert.match(index, /messagesAfterProcess/);
  assert.match(index, /messages\.value\.slice\(0, index\)/);
  assert.match(index, /messages\.value\.slice\(index\)/);
});

test('uni-app Android 手机端轮询刷新不强制推动阅读位置', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /applyThreadStatus\(data, \{ autoOpenProcess: followBottom\.value \}\)/);
  assert.match(index, /if \(options\.autoOpenProcess \|\| followBottom\.value\) processOpen\.value = true;/);
  assert.match(index, /if \(previousStatus !== 'complete' && previousStatus !== 'error'\) processOpen\.value = false;/);
  assert.match(index, /await loadHistory\(data, \{ scrollToBottom: shouldScroll \}\)/);
  assert.match(index, /manualRefresh\(\)[\s\S]*refreshAll\(\{ scrollToBottom: false \}\)/);
});
