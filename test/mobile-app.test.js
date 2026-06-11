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

test('uni-app Android 手机端按每轮对话渲染处理过程', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /const manualProcessOpenState = ref\(\{\}\)/);
  assert.match(index, /const processTurns = computed/);
  assert.match(index, /normalizeProcessTurns\(currentThreadStatus\.value\)/);
  assert.match(index, /function visibleProcessSteps\(turn\)/);
  assert.match(index, /function processStateKey\(turn, steps\)/);
  assert.match(index, /function normalizeProcessTurns\(status\)/);
  assert.match(index, /processKey: processStateKey\(turn, steps\)/);
  assert.match(index, /const timelineItems = computed/);
  assert.match(index, /const turnsById = \{\};/);
  assert.match(index, /row\.turnId \? turnsById\[row\.turnId\] : null/);
  assert.match(index, /function shouldAppendUnmatchedProcess\(turn\)/);
  assert.match(index, /turn && turn\.status === 'running'/);
  assert.match(index, /if \(shouldAppendUnmatchedProcess\(turn\)\) items\.push\(\{ type: 'process'/);
  assert.doesNotMatch(index, /pendingTurns\.splice\(0, 1\)/);
  assert.match(index, /items\.push\(\{ type: 'process'/);
  assert.match(index, /items\.push\(\{ type: 'message'/);
  assert.match(index, /processTitle\(item\.turn, isProcessOpen\(item\.turn\)\)/);
  assert.match(index, /@click="toggleProcess\(item\.turn\)"/);
  assert.match(index, /v-if="isProcessOpen\(item\.turn\)"/);
  assert.match(index, /step\.kind !== 'start'/);
  assert.match(index, /function formatElapsedTime\(startedAt, completedAt\)/);
  assert.match(index, /function processTitle\(turn, open\)/);
  assert.match(index, /function isProcessOpen\(turn\)/);
  assert.match(index, /function toggleProcess\(turn\)/);
  assert.match(index, /function bindPendingAssistantTurn\(status\)/);
  assert.match(index, /row\.pending/);
  assert.doesNotMatch(index, /processOpenState/);
  assert.doesNotMatch(index, /messagesBeforeProcess/);
  assert.doesNotMatch(index, /messagesAfterProcess/);
});

test('uni-app Android 手机端展示前会清理 Codex UI 上下文', () => {
  const markdown = fs.readFileSync(path.join(appDir, 'utils', 'markdown.js'), 'utf8');
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(markdown, /export function stripCodexUiDirectives\(text\)/);
  assert.match(markdown, /In app browser:/);
  assert.match(markdown, /My request for Codex:/);
  assert.match(markdown, /Current URL:/);
  assert.match(markdown, /renderMarkdownToHtml\(markdown\)[\s\S]*stripCodexUiDirectives\(markdown\)/);
  assert.match(index, /renderMarkdown\(item\.row\.text \|\| ''\)/);
  assert.match(index, /renderMarkdown\(step\.text \|\| ''\)/);
});

test('uni-app Android 手机端轮询刷新不强制推动阅读位置和处理过程展开状态', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /function syncManualProcessOpenState\(status\)/);
  assert.match(index, /syncManualProcessOpenState\(status\)/);
  assert.match(index, /const turns = normalizeProcessTurns\(status\);/);
  assert.match(index, /manualProcessOpenState\.value\[turn\.processKey\] === true/);
  assert.match(index, /next\[turn\.processKey\] = true;/);
  assert.match(index, /manualProcessOpenState\.value = next;/);
  assert.match(index, /manualProcessOpenState\.value = \{\};/);
  assert.match(index, /if \(sending\.value \|\| pendingWatch\.value\) return;/);
  assert.doesNotMatch(index, /autoOpenProcess/);
  assert.doesNotMatch(index, /previousTurnStatus/);
  assert.doesNotMatch(index, /syncProcessOpenState/);
  assert.doesNotMatch(index, /processOpenState/);
  assert.doesNotMatch(index, /next\[turnId\] = true;/);
  assert.doesNotMatch(index, /status === 'running' \? true/);
  assert.match(index, /await loadHistory\(data, \{ scrollToBottom: shouldScroll \}\)/);
  assert.match(index, /manualRefresh\(\)[\s\S]*refreshAll\(\{ scrollToBottom: false \}\)/);
});

test('uni-app Android 手机端发送后立即追加本地消息', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /const sentAt = Date\.now\(\);/);
  assert.match(index, /messages\.value = messages\.value\.concat\(\[/);
  assert.match(index, /\{ role: 'user', text, id: `local-user-\$\{sentAt\}` \}/);
  assert.match(index, /\{ role: 'assistant', text: '已发送，等待 Codex 回复\.\.\.', pending: true, id: `local-assistant-\$\{sentAt\}` \}/);
  assert.match(index, /await scrollToBottom\(\);/);
});

test('uni-app Android 手机端使用弹出二级对话列表选择线程', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.doesNotMatch(index, /<picker/);
  assert.match(index, /class="thread-selector"/);
  assert.match(index, /class="thread-popup"/);
  assert.match(index, /const threadPopupOpen = ref\(false\)/);
  assert.match(index, /@click="toggleThreadPopup"/);
  assert.match(index, /const projectGroups = computed/);
  assert.match(index, /v-for="project in projectGroups"/);
  assert.match(index, /v-for="thread in project\.threads"/);
  assert.match(index, /threadDotClassFor\(thread\)/);
  assert.match(index, /function threadDotClassFor\(thread\)/);
  assert.match(index, /return active \|\| status === 'running' \? 'dot-blue' : 'dot-green';/);
  assert.match(index, /async function selectThread\(projectName, thread\)/);
  assert.match(index, /threadPopupOpen\.value = false;/);
  assert.match(index, /thread-row-active/);
  assert.match(index, /\.thread-selector\s*\{[\s\S]*border-bottom:\s*1px solid #9ca3af;[\s\S]*border-radius:\s*0;[\s\S]*background:\s*transparent;/);
  assert.match(index, /\.thread-selector-title\s*\{[\s\S]*line-height:\s*40px;[\s\S]*text-align:\s*left;/);
  assert.match(index, /\.thread-selector-subtitle\s*\{[\s\S]*line-height:\s*40px;[\s\S]*text-align:\s*right;/);
  const popupListStyle = index.match(/\.popup-list\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(popupListStyle, /height:\s*52vh;/);
  assert.doesNotMatch(popupListStyle, /height:\s*0;/);
  assert.match(index, /import \{ onBackPress, onHide, onShow, onUnload \} from '@dcloudio\/uni-app';/);
  assert.match(index, /onBackPress\(\(\) => \{[\s\S]*threadPopupOpen\.value = false;[\s\S]*return true;/);
  assert.match(index, /if \(!threadPopupOpen\.value\) return false;/);
});

test('uni-app Android 手机端切换对话时显示等待 UI 并防止旧请求覆盖', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /const switchingThread = ref\(false\)/);
  assert.match(index, /let switchRequestSeq = 0;/);
  assert.match(index, /v-if="switchingThread" class="switch-loading"/);
  assert.match(index, /正在载入对话/);
  assert.match(index, /:disabled="loading \|\| switchingThread"/);
  assert.match(index, /:disabled="sending \|\| switchingThread \|\| !selectedThreadId"/);
  assert.match(index, /const requestSeq = switchRequestSeq \+ 1;/);
  assert.match(index, /switchingThread\.value = true;/);
  assert.match(index, /messages\.value = \[\];/);
  assert.match(index, /await loadHistory\(null, \{ scrollToBottom: true, threadId: selectedThreadId\.value \}\)/);
  assert.match(index, /switchRequestSeq === requestSeq/);
  assert.match(index, /if \(canUpdateTask\(token\) && switchRequestSeq === requestSeq\) setNotice\(error\.message\);/);
  assert.match(index, /selectedThreadId\.value !== requestedThreadId/);
  assert.match(index, /\.switch-loading\s*\{/);
  assert.match(index, /@keyframes switch-loading-spin/);
});

test('uni-app Android 手机端隐藏或销毁后停止轮询并阻止异步回写', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /let lifecycleToken = 0;/);
  assert.match(index, /let requestTasks = \[\];/);
  assert.match(index, /function registerRequestTask\(task\)/);
  assert.match(index, /function unregisterRequestTask\(task\)/);
  assert.match(index, /function abortRequestTasks\(\)/);
  assert.match(index, /task\.abort\(\)/);
  assert.match(index, /function canUpdateTask\(token\)/);
  assert.match(index, /token === lifecycleToken/);
  assert.match(index, /function activatePage\(\)/);
  assert.match(index, /function deactivatePage\(\)/);
  assert.match(index, /switchRequestSeq \+= 1;/);
  assert.match(index, /switchingThread\.value = false;/);
  assert.match(index, /threadListRequest = null;/);
  assert.match(index, /abortRequestTasks\(\);/);
  assert.match(index, /registerTask: registerRequestTask, unregisterTask: unregisterRequestTask/);
  assert.match(index, /onHide\(\(\) => \{[\s\S]*deactivatePage\(\);[\s\S]*\}\);/);
  assert.match(index, /onUnload\(\(\) => \{[\s\S]*deactivatePage\(\);[\s\S]*\}\);/);
  assert.match(index, /onUnmounted\(\(\) => \{[\s\S]*deactivatePage\(\);[\s\S]*\}\);/);
  assert.match(index, /if \(timersStarted\) return;/);
  assert.match(index, /timersStarted = false;/);
  assert.match(index, /const token = currentLifecycleToken\(\);[\s\S]*if \(!canUpdateTask\(token\)\) return;/);
  assert.match(index, /if \(!canUpdateTask\(token\)\) return;[\s\S]*connectionState\.value =/);
  assert.match(index, /if \(canUpdateTask\(token\)\) loading\.value = false;/);
  assert.match(index, /if \(canUpdateTask\(token\)\) sending\.value = false;/);
});

test('uni-app Android 请求支持页面销毁时取消', () => {
  const api = fs.readFileSync(path.join(appDir, 'utils', 'api.js'), 'utf8');

  assert.match(api, /let task = null;/);
  assert.match(api, /task = uni\.request/);
  assert.match(api, /registerTask/);
  assert.match(api, /unregisterTask/);
  assert.match(api, /complete\(\) \{[\s\S]*options\.unregisterTask\(task\)/);
  assert.match(api, /export function sendMessage[\s\S]*registerTask: options\.registerTask,[\s\S]*unregisterTask: options\.unregisterTask,/);
  assert.match(api, /export function stopCodex[\s\S]*registerTask: options\.registerTask,[\s\S]*unregisterTask: options\.unregisterTask,/);
});

test('uni-app Android 设置页测试连接离开页面时取消请求', () => {
  const settings = fs.readFileSync(path.join(appDir, 'pages', 'settings', 'settings.vue'), 'utf8');

  assert.match(settings, /import \{ onHide, onShow, onUnload \} from '@dcloudio\/uni-app';/);
  assert.match(settings, /let pageActive = true;/);
  assert.match(settings, /let requestTask = null;/);
  assert.match(settings, /function registerRequestTask\(task\)/);
  assert.match(settings, /function unregisterRequestTask\(task\)/);
  assert.match(settings, /function deactivatePage\(\)/);
  assert.match(settings, /task\.abort\(\)/);
  assert.match(settings, /function activatePage\(\)/);
  assert.match(settings, /getHealth\(config, \{ registerTask: registerRequestTask, unregisterTask: unregisterRequestTask \}\)/);
  assert.match(settings, /if \(!pageActive\) return;/);
  assert.match(settings, /onHide\(\(\) => \{[\s\S]*deactivatePage\(\);[\s\S]*\}\);/);
  assert.match(settings, /onShow\(\(\) => \{[\s\S]*activatePage\(\);[\s\S]*\}\);/);
  assert.match(settings, /onUnload\(\(\) => \{[\s\S]*deactivatePage\(\);[\s\S]*\}\);/);
  assert.match(settings, /onUnmounted\(\(\) => \{[\s\S]*deactivatePage\(\);[\s\S]*\}\);/);
});
