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
  assert.equal(manifest['app-plus'].distribute.android.packagename, 'io.github.codexbridge.mobile');
  assert.equal(manifest['app-plus'].distribute.android.usesCleartextTraffic, true);
  assert.deepEqual(pages.pages.map(page => page.path), ['pages/index/index', 'pages/settings/settings']);
  assert.match(config, /serverUrl:\s*''/);
  assert.match(config, /token:\s*''/);
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
  assert.match(index, /\.page\s*\{[\s\S]*display:\s*flex;[\s\S]*height:\s*100vh;[\s\S]*overflow:\s*hidden;/);
  assert.match(index, /\.messages\s*\{[\s\S]*flex:\s*1 1 auto;[\s\S]*height:\s*0;/);
  assert.doesNotMatch(index, /\.composer\s*\{[\s\S]*position:\s*fixed;/);
  assert.match(app, /button\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;/);
  assert.match(app, /button::after\s*\{[\s\S]*border:\s*0;/);
  assert.match(settings, /\.primary,\s*\n\.secondary\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;[\s\S]*justify-content:\s*center;/);
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

  assert.match(normalizeFunction, /const interrupted = Boolean\(turn && turn\.status === 'running' && \(!agentState\.value\.online \|\| !syncState\.value\.fresh\)\);/);
  assert.match(normalizeFunction, /status: interrupted \? 'interrupted'/);
  assert.match(normalizeFunction, /durationText: formatElapsedTime\(turn && turn\.startedAt, turn && turn\.completedAt, interrupted \? syncState\.value\.lastSyncedAt : ''\)/);
  assert.match(titleFunction, /turn && turn\.status === 'interrupted'/);
  assert.match(titleFunction, /interruptionReason/);
  assert.match(index, /return false;/);
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

test('uni-app Android 手机端发送后立即追加本地消息', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');

  assert.match(index, /const sentAt = Date\.now\(\);/);
  assert.match(index, /const pending = registerPendingLocalSend\(selectedThreadId\.value, text, sentAt, messages\.value\.length\);/);
  assert.match(index, /messages\.value = messages\.value\.concat\(\[/);
  assert.match(index, /\{ role: 'user', text, id: pending\.userId \}/);
  assert.match(index, /\{ role: 'assistant', text: '已发送，等待 Codex 回复\.\.\.', pending: true, id: pending\.assistantId \}/);
  assert.match(index, /kind: 'send-pending'/);
  assert.match(index, /if \(pendingWatch\.value && pendingWatch\.value\.threadId === pending\.threadId\) pendingWatch\.value = null;/);
  assert.match(index, /await scrollToBottom\(\);/);
});

test('uni-app Android 手机端历史刷新保留未确认本地用户消息', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const mergeFunction = index.match(/function mergePendingLocalMessages\(threadId, historyRows\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(index, /const pendingLocalSends = ref\(\[\]\);/);
  assert.match(index, /function registerPendingLocalSend\(threadId, text, sentAt, baseMessageCount\)/);
  assert.match(index, /function removePendingLocalSend\(pending\)/);
  assert.match(index, /function bindPendingLocalSendTurn\(turnId\)/);
  assert.match(index, /function hasHistoryMessage\(rows, role, text, startIndex = 0\)/);
  assert.match(index, /function hasAssistantAfterPendingBase\(rows, pending\)/);
  assert.match(index, /function mergePendingLocalMessages\(threadId, historyRows\)/);
  assert.match(mergeFunction, /if \(hasHistoryMessage\(rows, 'user', pending\.text, pending\.baseMessageCount\)\) continue;/);
  assert.match(mergeFunction, /localRows\.push\(\{ role: 'user', text: pending\.text, id: pending\.userId \}\);/);
  assert.match(mergeFunction, /const insertAt = Math\.min\(rows\.length, Math\.max\(0, \(Number\(pending\.baseMessageCount\) \|\| 0\) \+ insertedCount\)\);/);
  assert.match(mergeFunction, /for \(let localIndex = 0; localIndex < localRows\.length; localIndex \+= 1\)/);
  assert.match(mergeFunction, /rows\.splice\(insertAt \+ localIndex, 0, localRows\[localIndex\]\);/);
  assert.match(index, /function mergeLoadedHistory\(existingRows, latestRows\)/);
  assert.match(index, /messages\.value = mergePendingLocalMessages\(requestedThreadId, mergeLoadedHistory\(messages\.value, data\.messages \|\| \[\]\)\);/);
  assert.match(index, /catch \(error\) \{[\s\S]*removePendingLocalSend\(pending\);[\s\S]*setNotice\(error\.message\);/);
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
  const realtimeRefreshFunction = index.match(/function scheduleRealtimeRefresh\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(index, /function applyAgentOnline\(data\)/);
  assert.match(index, /typeof data\.agentOnline !== 'boolean'/);
  assert.match(index, /message: data\.agentOnline \? 'Agent 在线' : 'Agent 未在线'/);
  assert.match(index, /return agentState\.value\.online && syncState\.value\.fresh && \(activeStatus \|\| status === 'running'\);/);
  assert.match(index, /function applyRelayState\(data\)/);
  assert.match(index, /syncVersion/);
  assert.match(index, /syncFresh/);
  assert.match(fetchThreadRowsFunction, /!applyRelayState\(data\)/);
  assert.doesNotMatch(fetchThreadRowsFunction, /agentState\.value = \{ online: true/);
  assert.match(threadDotFunction, /if \(!agentState\.value\.online\) return 'dot-gray';/);
  assert.match(index, /function applyThreadStatus\(status\) \{[\s\S]*!applyRelayState\(status\)/);
  assert.match(index, /createRealtimeSocket/);
  assert.match(index, /function scheduleRealtimeRefresh\(\)/);
  assert.match(realtimeRefreshFunction, /if \(switchingThread\.value \|\| loading\.value\) \{[\s\S]*scheduleRealtimeRefresh\(\);[\s\S]*return;/);
  assert.match(index, /function scheduleRealtimeReconnect\(\)/);
  assert.match(index, /function openRealtimeSocket\(\)/);
  assert.match(index, /event\.type === 'session-updated'/);
  assert.match(index, /const AUTO_REFRESH_INTERVAL_MS = 4000;/);
  assert.match(index, /let automaticRefreshTimer = null;/);
  assert.match(index, /async function refreshCurrentThreadAutomatically\(\)/);
  assert.match(index, /function scheduleAutomaticRefresh\(\)/);
  assert.match(index, /await loadHistory\(null, \{ scrollToBottom: followBottom\.value, silent: true \}\);/);
  assert.match(startTimersFunction, /openRealtimeSocket\(\);/);
  assert.match(startTimersFunction, /scheduleAutomaticRefresh\(\);/);
  assert.match(index, /if \(automaticRefreshTimer\) clearTimeout\(automaticRefreshTimer\);/);
});

test('uni-app Android 手机端切换对话时显示等待 UI 并防止旧请求覆盖', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const selectThreadFunction = index.match(/async function selectThread\(projectName, thread\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(index, /const switchingThread = ref\(false\)/);
  assert.match(index, /let switchRequestSeq = 0;/);
  assert.match(index, /v-if="switchingThread" class="switch-loading"/);
  assert.match(index, /正在载入对话/);
  assert.match(index, /:disabled="loading \|\| switchingThread"/);
  assert.match(index, /:disabled="sending \|\| switchingThread \|\| !selectedThreadId"/);
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
  assert.match(index, /await getHistory\(config\.value, requestedThreadId, \{ limit: 10, before: historyNextBefore\.value/);
  assert.match(index, /messages\.value = mergePendingLocalMessages\(requestedThreadId, mergeLoadedHistory\(messages\.value, data\.messages \|\| \[\]\)\);/);
});

test('uni-app Android 手机端向上分页后保持消息时间顺序', () => {
  const index = fs.readFileSync(path.join(appDir, 'pages', 'index', 'index.vue'), 'utf8');
  const source = index.match(/function mergeLoadedHistory\(existingRows, latestRows\) \{([\s\S]*?)\n\}\n\n\/\*\*\n \* AI:应用 Relay/)?.[0] || '';
  const factory = new Function(`${source.replace(/\n\/\*\*[\s\S]*$/, '')}\nreturn mergeLoadedHistory;`);
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
