const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const appDir = path.join(root, 'app');

function loadMobileMarkdown() {
  const source = fs.readFileSync(path.join(appDir, 'utils', 'markdown.js'), 'utf8')
    .replace(/export function /g, 'function ');
  return Function(`${source}\nreturn { renderMarkdownToHtml, stripCodexUiDirectives };`)();
}

function loadMobileConfig(storage = {}) {
  const source = fs.readFileSync(path.join(appDir, 'utils', 'config.js'), 'utf8')
    .replace(/export const /g, 'const ')
    .replace(/export function /g, 'function ');
  const uni = {
    getStorageSync(key) { return storage[key]; },
    setStorageSync(key, value) { storage[key] = JSON.parse(JSON.stringify(value)); },
    removeStorageSync(key) { delete storage[key]; },
  };
  const api = Function('uni', `${source}\nreturn { loadDeviceStore, listDevices, getActiveDevice, saveDevice, removeDevice, setActiveDevice, loadSelection, saveSelection, saveDeviceConnectionState, saveDraftGuard, loadDraftGuard };`)(uni);
  return { api, storage };
}

test('uni-app Android 手机端将旧单设备配置一次性迁移为设备仓库', () => {
  const runtime = loadMobileConfig({
    'codexMobile.config': { serverUrl: ' http://relay.example/ ', token: ' token-a ' },
    'codexMobile.selection': { projectName: 'project-a', threadId: 'thread-a' },
  });

  const store = runtime.api.loadDeviceStore();
  assert.equal(store.version, 1);
  assert.equal(store.devices.length, 1);
  assert.equal(store.devices[0].name, '我的电脑');
  assert.equal(store.devices[0].serverUrl, 'http://relay.example');
  assert.equal(store.devices[0].token, 'token-a');
  assert.deepEqual(runtime.api.loadSelection(store.devices[0].id), { projectName: 'project-a', threadId: 'thread-a' });
  assert.equal(runtime.storage['codexMobile.config'], undefined);
  assert.equal(runtime.storage['codexMobile.selection'], undefined);
});

test('uni-app Android 手机端设备增删改和对话选择按内部 ID 隔离', () => {
  const runtime = loadMobileConfig();
  const first = runtime.api.saveDevice({ name: '办公室', serverUrl: 'http://office/', token: 'office-token' });
  const second = runtime.api.saveDevice({ name: '家里', serverUrl: 'http://home', token: 'home-token' });
  runtime.api.saveSelection(first.id, { projectName: 'office-project', threadId: 'office-thread' });
  runtime.api.saveSelection(second.id, { projectName: 'home-project', threadId: 'home-thread' });
  runtime.api.saveDeviceConnectionState(second.id, { online: true, agentOnline: true, checkedAt: '2026-08-12T00:00:00.000Z' });

  runtime.api.setActiveDevice(second.id);
  const renamed = runtime.api.saveDevice({ id: second.id, name: '家中电脑', serverUrl: 'http://home', token: 'home-token' });
  assert.equal(renamed.lastConnection.online, true);
  const edited = runtime.api.saveDevice({ id: second.id, name: '家中电脑', serverUrl: 'http://home-new/', token: 'home-token-new' });
  assert.equal(edited.id, second.id);
  assert.equal(edited.serverUrl, 'http://home-new');
  assert.equal(edited.lastConnection, null);
  assert.deepEqual(runtime.api.loadSelection(first.id), { projectName: 'office-project', threadId: 'office-thread' });
  assert.deepEqual(runtime.api.loadSelection(second.id), { projectName: 'home-project', threadId: 'home-thread' });

  const activeAfterDelete = runtime.api.removeDevice(second.id);
  assert.equal(activeAfterDelete.id, first.id);
  assert.equal(runtime.api.listDevices().length, 1);
});

test('uni-app Android 手机端设备仓库拒绝损坏新数据且不回退旧配置', () => {
  const runtime = loadMobileConfig({
    'codexMobile.devices.v1': { version: 1, devices: 'broken' },
    'codexMobile.config': { serverUrl: 'http://legacy', token: 'legacy-token' },
  });
  assert.throws(() => runtime.api.loadDeviceStore(), /设备配置已损坏/);

  const invalidActive = loadMobileConfig({
    'codexMobile.devices.v1': {
      version: 1,
      activeDeviceId: 'missing-device',
      devices: [{ id: 'device-a', name: '设备 A', serverUrl: 'http://a', token: 'token-a' }],
      selections: {},
    },
  });
  assert.throws(() => invalidActive.api.loadDeviceStore(), /当前设备无效/);
});

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
  assert.equal(manifest.versionName, '0.2.1');
  assert.equal(manifest.versionCode, 201);
  assert.equal(manifest['app-plus'].distribute.android.packagename, 'io.github.codexbridge.mobile');
  assert.equal(manifest['app-plus'].distribute.android.usesCleartextTraffic, true);
  assert.deepEqual(pages.pages.map(page => page.path), ['pages/index/index', 'pages/settings/settings']);
  assert.match(config, /DEVICE_STORE_KEY = 'codexMobile\.devices\.v1'/);
  assert.match(config, /export function loadDeviceStore\(\)/);
  assert.match(config, /export function saveDevice\(input\)/);
  assert.match(index, /function hasConnectionConfig\(\)/);
  assert.match(index, /function markConfigMissing\(\)/);
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
  assert.match(index, /class="device-nav"/);
  assert.match(index, /class="device-switcher"/);
  assert.match(index, /\.page\s*\{[\s\S]*display:\s*flex;[\s\S]*height:\s*100vh;[\s\S]*overflow:\s*hidden;/);
  assert.match(index, /\.messages\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*height:\s*0;/);
  assert.doesNotMatch(index, /\.composer\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(app, /button\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;/);
  assert.match(app, /button::after\s*\{[\s\S]*border:\s*0;/);
  assert.match(settings, /\.add-button,[\s\S]*\.primary,[\s\S]*\.secondary\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;/);
});

test('uni-app Android 手机端顶部只切换已有设备且草稿阻止切换', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const settings = fs.readFileSync(path.join(appDir, 'pages', 'settings', 'settings.vue'), 'utf8');
  const pages = JSON.parse(fs.readFileSync(path.join(appDir, 'pages.json'), 'utf8'));

  assert.equal(pages.pages[0].style.navigationStyle, 'custom');
  assert.match(index, /const devicePopupOpen = ref\(false\)/);
  assert.match(index, /v-for="device in deviceRows"/);
  assert.match(index, /async function switchDevice\(deviceId\)/);
  assert.match(index, /if \(messageText\.value\.trim\(\)\) \{[\s\S]*请先发送或清空草稿[\s\S]*return;/);
  assert.match(index, /uni\.showToast\(\{ title: '请先发送或清空草稿', icon: 'none' \}\)/);
  assert.match(index, /try \{[\s\S]*stopTimers\(\);[\s\S]*abortRequestTasks\(\);[\s\S]*resetDeviceViewState\(\);[\s\S]*setActiveDevice\(id\)[\s\S]*finally \{[\s\S]*switchingDevice\.value = false;/);
  assert.match(index, /onMounted\(async \(\) => \{[\s\S]*saveDraftGuard\(activeDeviceId\.value, false\);/);
  assert.match(settings, /@click="beginCreate">添加设备/);
  assert.match(settings, /function confirmRemove\(device\)/);
  assert.match(settings, /uni\.showModal\(/);
});

test('uni-app Android 手机端异步任务按生命周期和设备 ID 双重隔离', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const canUpdateTask = index.match(/function canUpdateTask\(token\) \{[\s\S]*?\n\}/)?.[0] || '';
  const realtime = index.match(/function openRealtimeSocket\(\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(index, /return \{ lifecycle: lifecycleToken, deviceId: activeDeviceId\.value \};/);
  assert.match(canUpdateTask, /token\.lifecycle === lifecycleToken/);
  assert.match(canUpdateTask, /token\.deviceId === activeDeviceId\.value/);
  assert.match(index, /function openRealtimeSocket\(\)[\s\S]*realtimeSocket !== socket/);
});

test('uni-app Android 手机端紧凑展示服务器、Agent 和对话三种状态', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /const serverState = ref\(\{ online: false, offline: false, message: '服务器检测中' \}\);/);
  assert.match(index, /const agentState = ref\(\{ online: false, offline: false, message: 'Agent 检测中' \}\);/);
  assert.match(index, /serverDotClass/);
  assert.match(index, /agentDotClass/);
  assert.match(index, /threadDotClass/);
  assert.match(index, /serverText/);
  assert.match(index, /agentText/);
  assert.match(index, /threadText/);
  assert.match(index, /服务器已连/);
  assert.match(index, /Agent 在线/);
  assert.match(index, /对话进行中/);
  assert.match(index, /\.status-row\s*\{[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(index, /\.status-item\s*\{[\s\S]*height:\s*30px;[\s\S]*padding:\s*0 6px;/);
  assert.match(index, /\.dot\s*\{[\s\S]*width:\s*8px;[\s\S]*height:\s*8px;/);
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
  assert.match(index, /const renderedProcessTurnIds = \{\};/);
  assert.match(index, /row\.turnId \? turnsById\[row\.turnId\] : null/);
  assert.match(index, /function shouldAppendUnmatchedProcess\(turn\)/);
  assert.match(index, /const userTurn = row && row\.role === 'user' && row\.turnId \? turnsById\[row\.turnId\] : null;/);
  assert.match(index, /if \(userTurn && !renderedProcessTurnIds\[userTurn\.turnId\]\) \{[\s\S]*items\.push\(\{ type: 'message'[\s\S]*items\.push\(\{ type: 'process'/);
  assert.match(index, /return false;/);
  assert.doesNotMatch(index, /pendingTurns\.splice\(0, 1\)/);
  assert.match(index, /items\.push\(\{ type: 'process'/);
  assert.match(index, /items\.push\(\{ type: 'message'/);
  assert.match(index, /processTitle\(item\.turn, isProcessOpen\(item\.turn\)\)/);
  assert.match(index, /@click="toggleProcess\(item\.turn\)"/);
  assert.match(index, /v-if="isProcessOpen\(item\.turn\)"/);
  assert.match(index, /step\.kind !== 'start'/);
  assert.match(index, /function formatElapsedTime\(startedAt, completedAt, observedAt = ''\)/);
  assert.match(index, /function processTitle\(turn, open\)/);
  assert.match(index, /function isProcessOpen\(turn\)/);
  assert.match(index, /function toggleProcess\(turn\)/);
  assert.match(index, /function bindPendingAssistantTurn\(status\)/);
  assert.match(index, /row\.pending/);
  assert.doesNotMatch(index, /processOpenState/);
  assert.doesNotMatch(index, /messagesBeforeProcess/);
  assert.doesNotMatch(index, /messagesAfterProcess/);
});

test('uni-app Android 手机端 Agent 离线时不中断轮次不继续累计处理时长', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const normalizeFunction = index.match(/function normalizeProcessTurns\(status\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const titleFunction = index.match(/function processTitle\(turn, open\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(normalizeFunction, /turn\.status === 'interrupted'/);
  assert.match(normalizeFunction, /turn\.status === 'running' && \(!agentState\.value\.online \|\| !syncState\.value\.fresh\)/);
  assert.match(normalizeFunction, /status: interrupted \? 'interrupted'/);
  assert.match(normalizeFunction, /durationText: formatElapsedTime\(turn && turn\.startedAt, turn && turn\.completedAt, interrupted \? syncState\.value\.lastSyncedAt : ''\)/);
  assert.match(titleFunction, /turn && turn\.status === 'interrupted'/);
  assert.match(titleFunction, /interruptionReason/);
  assert.match(index, /return false;/);
});

test('uni-app Android 和 Web 保留手动停止回合的终态语义', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const web = fs.readFileSync(path.join(root, 'server', 'public', 'index.html'), 'utf8');
  const source = index.match(/function normalizeProcessTurns\(status\) \{([\s\S]*?)\n\}/)?.[0] || '';
  const normalize = new Function(
    'visibleProcessSteps',
    'processStateKey',
    'formatElapsedTime',
    'agentState',
    'syncState',
    `${source}\nreturn normalizeProcessTurns;`,
  )(
    turn => turn.steps || [],
    turn => turn.turnId,
    () => '已处理 2s',
    { value: { online: true } },
    { value: { fresh: true, lastSyncedAt: '' } },
  );

  const turns = normalize({
    turns: [{
      turnId: 'turn-aborted',
      status: 'interrupted',
      interruptionReason: '用户停止',
      steps: [{ kind: 'interrupted', text: '本轮回复已停止' }],
    }],
  });

  assert.equal(turns[0].status, 'interrupted');
  assert.equal(turns[0].interruptionReason, '用户停止');
  assert.match(web, /turn\?\.status === 'interrupted'/);
  assert.match(web, /turn\?\.interruptionReason/);
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

test('uni-app Android 手机端不展示附件元数据且紧凑渲染代码块', () => {
  const { renderMarkdownToHtml } = loadMobileMarkdown();
  const html = renderMarkdownToHtml([
    '# Files mentioned by the user:',
    '',
    '## Screenshot_2026.jpg:',
    'C:/Users/admin/Downloads/Screenshot_2026.jpg',
    '',
    '## My request for Codex:',
    '请处理手机端显示。',
    '',
    '```text',
    'C:/Users/admin/Downloads/a-very-long-path.txt',
    '```',
  ].join('\n'));

  assert.doesNotMatch(html, /Files mentioned by the user/);
  assert.doesNotMatch(html, /Screenshot_2026/);
  assert.match(html, /已附 1 个附件（仅电脑端可查看）/);
  assert.match(html, /请处理手机端显示。/);
  assert.match(html, /word-break:break-all/);
  assert.doesNotMatch(html, /<pre><code>/);

  const directRequestHtml = renderMarkdownToHtml([
    '# Files mentioned by the user:',
    '',
    '## Screenshot_2026.jpg: C:/Users/admin/Downloads/Screenshot_2026.jpg',
    '',
    '手机端没显示我发的消息?',
  ].join('\n'));

  assert.match(directRequestHtml, /已附 1 个附件（仅电脑端可查看）/);
  assert.match(directRequestHtml, /手机端没显示我发的消息/);
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

test('uni-app Android 手机端发送前追加本地待确认消息并等待实时控制结果', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const sendFunction = index.match(/async function send\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(index, /const canSend = computed\(\(\) => \{/);
  assert.match(index, /:disabled="!canSend"/);
  assert.match(sendFunction, /if \(!canSend\.value\) \{[\s\S]*当前对话尚未完成或发送结果未确认/);
  assert.match(sendFunction, /const baseMessageCount = confirmedHistoryRows\(messages\.value\)\.length;[\s\S]*?registerPendingLocalSend\([\s\S]*?const data = await sendMessage\(/);
  assert.match(sendFunction, /messages\.value = mergePendingLocalMessages\(selectedThreadId\.value, messages\.value\);/);
  assert.match(sendFunction, /pendingWatch\.value = \{[\s\S]*awaitingControlResult: true/);
  assert.match(sendFunction, /acceptedSyncVersion: Number\(data\.acceptedSyncVersion\) \|\| syncState\.value\.version/);
  assert.doesNotMatch(sendFunction, /messageText\.value = text/);
  assert.match(index, /await scrollToBottom\(\);/);
});

test('uni-app Android 手机端发送时立即展示待确认消息且超时不恢复输入框', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const api = fs.readFileSync(path.join(appDir, 'utils', 'api.js'), 'utf8');
  const sendFunction = index.match(/async function send\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(sendFunction, /registerPendingLocalSend\([\s\S]*?messages\.value = mergePendingLocalMessages\([\s\S]*?const data = await sendMessage\(/);
  assert.match(sendFunction, /if \(error\.code === 'REQUEST_TIMEOUT'\)[\s\S]*pendingWatch\.value =/);
  assert.doesNotMatch(sendFunction, /messageText\.value = text/);
  assert.match(api, /createRequestError\([\s\S]*?'REQUEST_TIMEOUT'/);
});

test('uni-app Android 手机端处理异步控制结果并绑定真实回合', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /function applyControlResult\(event\)/);
  assert.match(index, /event\.type === 'control-result'/);
  assert.match(index, /clientUserMessageId/);
  assert.match(index, /result\.watch\.turnId/);
});

test('uni-app Android 手机端历史刷新保留未确认本地用户消息', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const sendFunction = index.match(/async function send\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const mergeFunction = index.match(/function mergePendingLocalMessages\(threadId, historyRows\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(index, /const pendingLocalSends = ref\(\[\]\);/);
  assert.match(index, /function registerPendingLocalSend\(threadId, text, sentAt, baseMessageCount, clientUserMessageId\)/);
  assert.match(index, /function removePendingLocalSend\(pending\)/);
  assert.match(index, /function bindPendingLocalSendTurn\(turnId\)/);
  assert.match(index, /function hasHistoryMessage\(rows, role, text, startIndex = 0\)/);
  assert.match(index, /function hasAssistantAfterPendingBase\(rows, pending\)/);
  assert.match(index, /function mergePendingLocalMessages\(threadId, historyRows\)/);
  assert.match(index, /function confirmedHistoryRows\(rows\)/);
  assert.match(mergeFunction, /const rows = confirmedHistoryRows\(historyRows\);/);
  assert.match(index, /id\.indexOf\('local-user-'\) !== 0/);
  assert.match(index, /id\.indexOf\('local-assistant-'\) !== 0/);
  assert.match(mergeFunction, /if \(hasHistoryMessage\(rows, 'user', pending\.text, pending\.baseMessageCount\)\) continue;/);
  assert.match(mergeFunction, /localRows\.push\(\{ role: 'user', text: pending\.text, pending: true, id: pending\.userId \}\);/);
  assert.match(mergeFunction, /const insertAt = Math\.min\(rows\.length, Math\.max\(0, \(Number\(pending\.baseMessageCount\) \|\| 0\) \+ insertedCount\)\);/);
  assert.match(mergeFunction, /for \(let localIndex = 0; localIndex < localRows\.length; localIndex \+= 1\)/);
  assert.match(mergeFunction, /rows\.splice\(insertAt \+ localIndex, 0, localRows\[localIndex\]\);/);
  assert.match(index, /function mergeLoadedHistory\(existingRows, latestRows\)/);
  assert.match(index, /const currentRows = \(existingRows \|\| \[\]\)\.filter\(item => !\(item && item\.pending\)\);/);
  assert.match(index, /messages\.value = mergePendingLocalMessages\(requestedThreadId, mergeLoadedHistory\(messages\.value, data\.messages \|\| \[\]\)\);/);
  assert.match(sendFunction, /catch \(error\) \{[\s\S]*markPendingLocalSendFailed\(clientUserMessageId, error\.message\);[\s\S]*setNotice\(error\.message\);/);
  assert.doesNotMatch(sendFunction, /messageText\.value = text/);
  assert.doesNotMatch(sendFunction, /removePendingLocalSend\(pending\)/);
  assert.match(index, /bindPendingLocalSendTurn\(runningTurn\.turnId\);/);
});

test('uni-app Android 手机端运行中同步电脑端新增用户消息', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /let runningHistoryRequest = null;/);
  assert.match(index, /let runningHistorySyncAt = 0;/);
  assert.match(index, /let runningHistoryThreadId = '';/);
  assert.match(index, /async function syncRunningHistory\(statusData\)/);
  assert.match(index, /if \(!requestedThreadId \|\| sending\.value \|\| pendingWatch\.value\) return false;/);
  assert.match(index, /if \(!statusData \|\| \(!statusData\.active && statusData\.status !== 'running'\)\) return false;/);
  assert.match(index, /if \(runningHistoryRequest\) \{[\s\S]*await runningHistoryRequest;[\s\S]*return true;[\s\S]*\}/);
  assert.match(index, /now - runningHistorySyncAt < 1500/);
  assert.match(index, /loadHistory\(statusData, \{ scrollToBottom: false, silent: true \}\)/);
  assert.match(index, /const historySynced = await syncRunningHistory\(data\);/);
  assert.match(index, /if \(!historySynced && !applyThreadStatus\(data\)\) return;/);
  assert.match(index, /if \(!options\.silent\) setNotice/);
  assert.match(index, /runningHistoryRequest = null;/);
});

test('uni-app Android 手机端消息顺序固定为用户消息、处理过程、最终回复', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const timelineFunction = index.match(/const timelineItems = computed\(\(\) => \{([\s\S]*?)\n\}\);/)?.[1] || '';
  const pollFunction = index.match(/async function pollStatus\(watch = pendingWatch\.value \|\| \{\}\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(timelineFunction, /if \(userTurn && !renderedProcessTurnIds\[userTurn\.turnId\]\) \{[\s\S]*items\.push\(\{ type: 'message'[\s\S]*items\.push\(\{ type: 'process'/);
  assert.match(timelineFunction, /if \(exactTurn && !renderedProcessTurnIds\[exactTurn\.turnId\]\) \{[\s\S]*items\.push\(\{ type: 'process'[\s\S]*items\.push\(\{ type: 'message'/);
  assert.match(pollFunction, /const historySynced = await syncRunningHistory\(data\);[\s\S]*if \(!historySynced && !applyThreadStatus\(data\)\) return;/);
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
  assert.match(popupListStyle, /height:\s*70vh;/);
  assert.doesNotMatch(popupListStyle, /height:\s*0;/);
  assert.match(index, /import \{ onBackPress, onHide, onShow, onUnload \} from '@dcloudio\/uni-app';/);
  assert.match(index, /onBackPress\(\(\) => \{[\s\S]*threadPopupOpen\.value = false;[\s\S]*return true;/);
  assert.match(index, /if \(!threadPopupOpen\.value\) return false;/);
});

test('uni-app Android 手机端运行状态同时要求 Agent 在线和同步新鲜', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const fetchThreadRowsFunction = index.match(/async function fetchThreadRows\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const threadDotFunction = index.match(/function threadDotClassFor\(thread\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const startTimersFunction = index.match(/function startTimers\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const realtimeRefreshFunction = index.match(/function scheduleRealtimeRefresh\(options = \{\}\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(index, /function applyAgentOnline\(data\)/);
  assert.match(index, /typeof data\.agentOnline !== 'boolean'/);
  assert.match(index, /message: data\.agentOnline \? 'Agent 在线' : 'Agent 未在线'/);
  assert.match(index, /return agentState\.value\.online && syncState\.value\.fresh && \(activeStatus \|\| status === 'running'\);/);
  assert.match(index, /function applyRelayState\(data\)/);
  assert.match(index, /syncVersion/);
  assert.match(index, /syncFresh/);
  assert.match(index, /function isCommandConfirmed\(status, watch\)/);
  assert.match(index, /confirmedControlTurnIds/);
  assert.match(index, /confirmedTurnIds\.indexOf\(watch\.turnId\)\s*!==\s*-1/);
  assert.match(index, /kind: 'send'/);
  assert.match(fetchThreadRowsFunction, /!applyRelayState\(data\)/);
  assert.doesNotMatch(fetchThreadRowsFunction, /agentState\.value = \{ online: true/);
  assert.match(threadDotFunction, /if \(!agentState\.value\.online\) return 'dot-gray';/);
  assert.match(index, /function applyThreadStatus\(status\) \{[\s\S]*!applyRelayState\(status\)/);
  assert.match(index, /createRealtimeSocket/);
  assert.match(index, /function scheduleRealtimeRefresh\(options = \{\}\)/);
  assert.match(realtimeRefreshFunction, /if \(switchingThread\.value \|\| loading\.value\) \{[\s\S]*scheduleRealtimeRefresh\(refreshOptions\);[\s\S]*return;/);
  assert.match(realtimeRefreshFunction, /refreshOptions\.terminal[\s\S]*!historyHasAssistantTurn\(refreshOptions\.turnId\)[\s\S]*REALTIME_REFRESH_RETRY_LIMIT/);
  assert.match(index, /let pendingRealtimeRefreshOptions = null;/);
  assert.match(index, /function mergeRealtimeRefreshOptions\(current, incoming = \{\}\)/);
  assert.match(realtimeRefreshFunction, /pendingRealtimeRefreshOptions = mergeRealtimeRefreshOptions\(pendingRealtimeRefreshOptions, options\);/);
  assert.match(realtimeRefreshFunction, /if \(pendingRealtimeRefreshOptions\) scheduleRealtimeRefresh\(\);/);
  assert.match(index, /function scheduleRealtimeReconnect\(\)/);
  assert.match(index, /function openRealtimeSocket\(\)/);
  assert.match(index, /event\.type === 'session-updated'/);
  assert.match(index, /function applyRealtimeThreadEvent\(event\)/);
  assert.match(index, /event\.type === 'thread-event'/);
  assert.match(index, /terminal: \(payload\.type === 'turn\.completed' \|\| payload\.type === 'thread\.status\.changed'\)[\s\S]*=== selectedThreadId\.value/);
  assert.match(index, /event\.type === 'event-resync-required'/);
  assert.match(index, /payload\.type === 'turn\.started'/);
  assert.match(index, /payload\.type === 'turn\.completed'/);
  assert.match(index, /function reconcileRealtimeThreadState\(status\)/);
  assert.match(index, /const appServerState = ref\(/);
  assert.match(index, /const AUTO_REFRESH_INTERVAL_MS = 4000;/);
  assert.match(index, /let automaticRefreshTimer = null;/);
  assert.match(index, /async function refreshCurrentThreadAutomatically\(\)/);
  assert.match(index, /function scheduleAutomaticRefresh\(\)/);
  assert.match(index, /await loadHistory\(null, \{ scrollToBottom: followBottom\.value, silent: true \}\);/);
  assert.match(startTimersFunction, /openRealtimeSocket\(\);/);
  assert.match(startTimersFunction, /scheduleAutomaticRefresh\(\);/);
  assert.match(index, /if \(automaticRefreshTimer\) clearTimeout\(automaticRefreshTimer\);/);
});

test('uni-app Android 手机端以较新的终态快照清除陈旧实时进行中覆盖', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const source = index.match(/function reconcileRealtimeThreadState\(status\) \{([\s\S]*?)\n\}/)?.[0] || '';
  const realtimeThreadStates = { value: {
    threadA: {
      threadId: 'threadA',
      turnId: 'turn-running',
      status: 'running',
      active: true,
      seq: 7,
      observedAt: '2026-08-10T14:00:00.000Z',
    },
  } };
  const messages = { value: [] };
  const reconcile = new Function('realtimeThreadStates', 'messages', `${source}\nreturn reconcileRealtimeThreadState;`)(realtimeThreadStates, messages);

  reconcile({
    threadId: 'threadA',
    active: false,
    status: 'complete',
    completedAt: '2026-08-10T14:00:05.000Z',
    turns: [{ turnId: 'turn-earlier', status: 'complete' }],
  });
  assert.equal(realtimeThreadStates.value.threadA, undefined);
});

test('uni-app Android 手机端以 Agent 直接终态清除迟到的实时运行覆盖', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const source = index.match(/function reconcileRealtimeThreadState\(status\) \{([\s\S]*?)\n\}/)?.[0] || '';
  const realtimeThreadStates = { value: {
    threadA: {
      threadId: 'threadA',
      turnId: 'turn-running',
      status: 'running',
      active: true,
      seq: 9,
      observedAt: '2026-08-11T04:15:50.000Z',
    },
  } };
  const messages = { value: [] };
  const reconcile = new Function('realtimeThreadStates', 'messages', `${source}\nreturn reconcileRealtimeThreadState;`)(realtimeThreadStates, messages);

  reconcile({
    threadId: 'threadA',
    active: false,
    status: 'complete',
    cached: false,
    completedAt: '2026-08-11T04:14:33.181Z',
    turns: [{ turnId: 'turn-terminal', status: 'complete' }],
  });
  assert.equal(realtimeThreadStates.value.threadA, undefined);
});

test('uni-app Android 手机端历史已含最终回复时清除运行中覆盖', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const source = index.match(/function reconcileRealtimeThreadState\(status\) \{([\s\S]*?)\n\}/)?.[0] || '';
  const realtimeThreadStates = { value: {
    threadA: { threadId: 'threadA', turnId: 'turn-running', status: 'running', active: true, seq: 8, observedAt: '2026-08-10T14:00:00.000Z' },
  } };
  const messages = { value: [{ role: 'assistant', turnId: 'turn-running', text: '最终回复' }] };
  const reconcile = new Function('realtimeThreadStates', 'messages', `${source}\nreturn reconcileRealtimeThreadState;`)(realtimeThreadStates, messages);

  reconcile({ threadId: 'threadA', active: true, status: 'running', turns: [] });
  assert.equal(realtimeThreadStates.value.threadA, undefined);
});

test('uni-app Android 手机端连续实时事件不会覆盖已排队的终态刷新', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const source = index.match(/function mergeRealtimeRefreshOptions\(current, incoming = \{\}\) \{([\s\S]*?)\n\}/)?.[0] || '';
  const merge = new Function(`${source}\nreturn mergeRealtimeRefreshOptions;`)();

  const completed = merge({ threadId: 'threadA', turnId: 'turn-1', terminal: true, attempt: 1 }, {});
  assert.deepEqual(completed, { threadId: 'threadA', turnId: 'turn-1', terminal: true, attempt: 1 });

  const latest = merge(completed, { threadId: 'threadA', turnId: 'turn-2', terminal: true });
  assert.deepEqual(latest, { threadId: 'threadA', turnId: 'turn-2', terminal: true, attempt: 0 });
});

test('uni-app Android 手机端切换对话时显示等待 UI 并防止旧请求覆盖', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const selectThreadFunction = index.match(/async function selectThread\(projectName, thread\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(index, /const switchingThread = ref\(false\)/);
  assert.match(index, /let switchRequestSeq = 0;/);
  assert.match(index, /v-if="switchingThread \|\| switchingDevice" class="switch-loading"/);
  assert.match(index, /正在载入对话/);
  assert.match(index, /:disabled="loading \|\| switchingThread \|\| switchingDevice"/);
  assert.match(index, /:disabled="!canSend"/);
  assert.match(index, /const requestSeq = switchRequestSeq \+ 1;/);
  assert.match(index, /switchingThread\.value = true;/);
  assert.match(index, /messages\.value = \[\];/);
  assert.match(selectThreadFunction, /await loadThreads\(\);[\s\S]*await loadHistory\(null, \{ scrollToBottom: true, threadId: selectedThreadId\.value \}\)/);
  assert.match(selectThreadFunction, /const refreshedThread = threadRows\.value\.find\(row => row\.id === selectedThreadId\.value\);/);
  assert.match(selectThreadFunction, /selectedProjectName\.value = refreshedThread\.projectName \|\| '未命名文件夹';/);
  assert.match(index, /switchRequestSeq === requestSeq/);
  assert.match(index, /if \(canUpdateTask\(token\) && switchRequestSeq === requestSeq\) setNotice\(error\.message\);/);
  assert.match(index, /selectedThreadId\.value !== requestedThreadId/);
  assert.match(index, /\.switch-loading\s*\{/);
  assert.match(index, /@keyframes switch-loading-spin/);
  assert.match(index, /if \(switchingThread\.value \|\| loading\.value\) \{[\s\S]*scheduleRealtimeRefresh\(\);[\s\S]*return;/);
});

test('uni-app Android 手机端首次只读取最近五轮并支持向上分页', () => {
  const api = fs.readFileSync(path.join(appDir, 'utils', 'api.js'), 'utf8');
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(api, /function getHistory\(config, threadId, options = \{\}\)/);
  assert.match(api, /limit=\$\{encodeURIComponent\(options\.limit \|\| 10\)\}/);
  assert.match(api, /before=\$\{encodeURIComponent\(options\.before \|\| ''\)\}/);
  assert.match(index, /const historyNextBefore = ref\(''\)/);
  assert.match(index, /const hasOlderHistory = ref\(false\)/);
  assert.match(index, /@scrolltoupper="loadOlderHistory"/);
  assert.match(index, /async function loadOlderHistory\(\)/);
  assert.match(index, /await getHistory\(config\.value, requestedThreadId, \{ limit: 5, before: historyNextBefore\.value/);
  assert.match(index, /messages\.value = mergePendingLocalMessages\(requestedThreadId, mergeLoadedHistory\(messages\.value, data\.messages \|\| \[\]\)\);/);
});

test('uni-app Android 手机端向上分页后保持消息时间顺序', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const source = index.match(/function mergeLoadedHistory\(existingRows, latestRows\) \{([\s\S]*?)\r?\n\}\r?\n\r?\n\/\*\*\r?\n \* AI:应用 Relay/)?.[0] || '';
  const factory = new Function(`${source.replace(/\r?\n\/\*\*[\s\S]*$/, '')}\nreturn mergeLoadedHistory;`);
  const mergeLoadedHistory = factory();
  const olderRows = [
    { role: 'user', text: '第 1 条', timestamp: '2026-07-30T09:00:00.000Z' },
    { role: 'assistant', text: '第 2 条', timestamp: '2026-07-30T09:00:01.000Z' },
  ];
  const latestRows = [
    { role: 'user', text: '第 3 条', timestamp: '2026-07-30T09:00:02.000Z' },
    { role: 'assistant', text: '第 4 条', timestamp: '2026-07-30T09:00:03.000Z' },
  ];

  const loadOlderHistorySource = index.match(/async function loadOlderHistory\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const merged = mergeLoadedHistory(olderRows, latestRows);

  assert.deepEqual(merged.map(row => row.text), ['第 1 条', '第 2 条', '第 3 条', '第 4 条']);
  const refreshed = mergeLoadedHistory(merged, [
    ...latestRows,
    { role: 'user', text: '第 5 条', timestamp: '2026-07-30T09:00:04.000Z' },
    { role: 'assistant', text: '第 6 条', timestamp: '2026-07-30T09:00:05.000Z' },
  ]);

  assert.deepEqual(
    refreshed.map(row => row.text),
    ['第 1 条', '第 2 条', '第 3 条', '第 4 条', '第 5 条', '第 6 条'],
  );
  assert.match(loadOlderHistorySource, /mergeLoadedHistory\(data\.messages \|\| \[\], messages\.value\)/);
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
  assert.match(index, /token\.lifecycle === lifecycleToken/);
  assert.match(index, /token\.deviceId === activeDeviceId\.value/);
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
  assert.match(index, /if \(!canUpdateTask\(token\)\) return;[\s\S]*serverState\.value =/);
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
  assert.match(api, /export function createRealtimeSocket/);
  assert.match(api, /x-mobile-typer-token/);
  assert.match(api, /\/mobile/);
  assert.match(api, /const REQUEST_TIMEOUT_MS = 15000;/);
  assert.match(api, /timeout: timeoutMs,/);
  assert.match(api, /请求超时，请检查电脑 Agent 或服务器连接。/);
  assert.match(api, /if \(task && typeof task\.abort === 'function'\) task\.abort\(\);/);
});

test('uni-app Android 实时连接强制使用 SocketTask 回调模式', () => {
  const api = fs.readFileSync(path.join(appDir, 'utils', 'api.js'), 'utf8');
  const buildRealtimeUrlSource = api.match(/function buildRealtimeUrl\(serverUrl\) \{[\s\S]*?\n\}/)?.[0] || '';
  const createRealtimeSocketSource = (api.match(/export function createRealtimeSocket\(config, handlers = \{\}\) \{[\s\S]*?\n\}/)?.[0] || '')
    .replace('export function', 'function');
  const listeners = {};
  const socketTask = {
    onOpen(handler) { listeners.open = handler; },
    onMessage(handler) { listeners.message = handler; },
    onClose(handler) { listeners.close = handler; },
    onError(handler) { listeners.error = handler; },
  };
  let connectOptions = null;
  const uni = {
    connectSocket(options) {
      connectOptions = options;
      const callbackMode = ['success', 'fail', 'complete'].some(name => typeof options[name] === 'function');
      return callbackMode ? socketTask : Promise.resolve(socketTask);
    },
  };
  const createRealtimeSocket = new Function(
    'uni',
    `${buildRealtimeUrlSource}\n${createRealtimeSocketSource}\nreturn createRealtimeSocket;`,
  )(uni);

  const result = createRealtimeSocket(
    { serverUrl: 'http://relay.example', token: 'token-1' },
    { open() {}, message() {}, close() {}, error() {} },
  );

  assert.equal(result, socketTask);
  assert.equal(connectOptions.url, 'ws://relay.example/mobile');
  assert.equal(typeof connectOptions.complete, 'function');
  assert.deepEqual(Object.keys(listeners).sort(), ['close', 'error', 'message', 'open']);
});

test('uni-app Android 设置页测试连接离开页面时取消请求', () => {
  const settings = fs.readFileSync(path.join(appDir, 'pages', 'settings', 'settings.vue'), 'utf8');

  assert.match(settings, /import \{ onHide, onShow, onUnload \} from '@dcloudio\/uni-app';/);
  assert.match(settings, /let pageActive = true;/);
  assert.match(settings, /let requestTask = null;/);
  assert.match(settings, /function registerRequestTask\(task\)/);
  assert.match(settings, /function unregisterRequestTask\(task\)/);
  assert.match(settings, /function deactivatePage\(\)/);
  assert.match(settings, /testingDeviceId\.value = '';/);
  assert.match(settings, /testingForm\.value = false;/);
  assert.match(settings, /task\.abort\(\)/);
  assert.match(settings, /function activatePage\(\)/);
  assert.match(settings, /getHealth\(device, \{ registerTask: registerRequestTask, unregisterTask: unregisterRequestTask \}\)/);
  assert.match(settings, /getHealth\(input, \{ registerTask: registerRequestTask, unregisterTask: unregisterRequestTask \}\)/);
  assert.match(settings, /if \(!pageActive\) return;/);
  assert.match(settings, /onHide\(\(\) => \{[\s\S]*deactivatePage\(\);[\s\S]*\}\);/);
  assert.match(settings, /onShow\(\(\) => \{[\s\S]*activatePage\(\);[\s\S]*\}\);/);
  assert.match(settings, /onUnload\(\(\) => \{[\s\S]*deactivatePage\(\);[\s\S]*\}\);/);
  assert.match(settings, /onUnmounted\(\(\) => \{[\s\S]*deactivatePage\(\);[\s\S]*\}\);/);
});
