<template>
  <view class="page">
    <view class="topbar">
      <view class="status-row">
        <view class="status-item">
          <view class="dot" :class="connectionDotClass"></view>
          <text class="status-text">{{ connectionText }}</text>
        </view>
        <view class="status-item">
          <view class="dot" :class="threadDotClass"></view>
          <text class="status-text">{{ threadText }}</text>
        </view>
      </view>
      <button class="settings-button" @click="openSettings">设置</button>
    </view>

    <view class="selectors">
      <picker :range="projectNames" :value="projectIndex" :disabled="!projectNames.length" @change="onProjectChange">
        <view class="select-control">{{ selectedProjectName || '选择文件夹' }}</view>
      </picker>
      <picker :range="threadNames" :value="threadIndex" :disabled="!threadOptions.length" @change="onThreadChange">
        <view class="select-control">{{ selectedThreadName || '选择对话' }}</view>
      </picker>
      <button class="refresh-button" :disabled="loading" @click="manualRefresh">刷新</button>
    </view>

    <view class="notice">{{ notice }}</view>

    <scroll-view class="messages" scroll-y :scroll-into-view="scrollTarget">
      <view
        v-for="(row, index) in messages"
        :key="row.id || `${row.role}-${index}`"
        class="message"
        :class="row.role === 'user' ? 'message-user' : 'message-assistant'"
      >
        <rich-text class="markdown" :nodes="renderMarkdown(row.text || '')" />
      </view>

      <view v-if="processSteps.length" class="process-card">
        <view class="process-title" @click="toggleProcess">
          <text>{{ processOpen ? `处理过程（${processSteps.length}）` : `处理过程已折叠（${processSteps.length}）` }}</text>
          <text class="process-action">{{ processOpen ? '收起' : '展开' }}</text>
        </view>
        <view v-if="processOpen" class="process-body">
          <view v-for="(step, index) in processSteps" :key="`${step.kind || 'step'}-${index}`" class="process-step">
            <text class="process-label">{{ step.label || '过程' }}</text>
            <rich-text class="markdown muted-markdown" :nodes="renderMarkdown(step.text || '')" />
          </view>
        </view>
      </view>

      <view id="bottomAnchor" class="bottom-anchor"></view>
    </scroll-view>

    <view class="composer">
      <textarea v-model="messageText" class="input" auto-height maxlength="-1" placeholder="发消息给电脑 Codex" />
      <button class="send-button" :disabled="sending || !selectedThreadId" @click="send">发送</button>
      <button class="stop-button" :disabled="!canStop" @click="stop">停止</button>
    </view>
  </view>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { getHealth, getHistory, getStatus, getThreads, sendMessage, stopCodex } from '../../utils/api';
import { loadConfig, loadSelection, saveSelection } from '../../utils/config';
import { renderMarkdownToHtml } from '../../utils/markdown';

const config = ref(loadConfig());
const selection = loadSelection();
const selectedProjectName = ref(selection.projectName);
const selectedThreadId = ref(selection.threadId);
const threadRows = ref([]);
const messages = ref([]);
const notice = ref('正在连接服务器...');
const messageText = ref('');
const connectionState = ref({ online: false, offline: false, message: '正在检测连接状态' });
const currentThreadStatus = ref(null);
const pendingWatch = ref(null);
const historyReloadedForCompletion = ref(false);
const followBottom = ref(false);
const processOpen = ref(false);
const loading = ref(false);
const sending = ref(false);
const scrollTarget = ref('');
let threadListRequest = null;
let connectionTimer = null;
let threadTimer = null;
let pollTimer = null;

/**
 * AI:按项目分组当前打开的 Codex 对话。
 *
 * @param {Array<object>} rows 对话列表。
 * @returns {Map<string, Array<object>>} 项目分组。
 */
function groupThreads(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const projectName = row.projectName || '未命名文件夹';
    if (!groups.has(projectName)) groups.set(projectName, []);
    groups.get(projectName).push(row);
  }
  return groups;
}

const groupedThreads = computed(() => groupThreads(threadRows.value));
const projectNames = computed(() => [...groupedThreads.value.keys()]);
const projectIndex = computed(() => Math.max(0, projectNames.value.indexOf(selectedProjectName.value)));
const threadOptions = computed(() => groupedThreads.value.get(selectedProjectName.value) || []);
const threadNames = computed(() => threadOptions.value.map(row => row.name || row.id));
const threadIndex = computed(() => Math.max(0, threadOptions.value.findIndex(row => row.id === selectedThreadId.value)));
const selectedThread = computed(() => threadOptions.value.find(row => row.id === selectedThreadId.value) || null);
const selectedThreadName = computed(() => selectedThread.value?.name || selectedThreadId.value);
const processSteps = computed(() => {
  return (currentThreadStatus.value?.steps || []).filter(step => step?.text && step.kind !== 'final' && step.kind !== 'complete');
});
const running = computed(() => {
  const status = currentThreadStatus.value?.status || selectedThread.value?.status;
  return Boolean(currentThreadStatus.value?.active) || Boolean(selectedThread.value?.active) || status === 'running' || pendingWatch.value?.threadId === selectedThreadId.value;
});
const complete = computed(() => !running.value && (currentThreadStatus.value?.status === 'complete' || selectedThread.value?.status === 'complete'));
const canStop = computed(() => running.value && !sending.value);
const connectionDotClass = computed(() => connectionState.value.online ? 'dot-green' : connectionState.value.offline ? 'dot-red' : 'dot-gray');
const threadDotClass = computed(() => running.value ? 'dot-blue' : complete.value ? 'dot-green' : 'dot-gray');
const connectionText = computed(() => connectionState.value.online ? 'Agent 在线' : connectionState.value.message || '连接未知');
const threadText = computed(() => running.value ? '对话进行中' : complete.value ? '对话已完成' : '对话空闲');

/**
 * AI:渲染 Markdown 消息。
 *
 * @param {string} text Markdown 文本。
 * @returns {string} HTML 字符串。
 */
function renderMarkdown(text) {
  return renderMarkdownToHtml(text);
}

/**
 * AI:跳转到连接设置页。
 *
 * @returns {void}
 */
function openSettings() {
  uni.navigateTo({ url: '/pages/settings/settings' });
}

/**
 * AI:触发消息列表滚动到底部。
 *
 * @returns {Promise<void>}
 */
async function scrollToBottom() {
  scrollTarget.value = '';
  await nextTick();
  scrollTarget.value = 'bottomAnchor';
}

/**
 * AI:保存当前对话选择。
 *
 * @returns {void}
 */
function persistSelection() {
  saveSelection({
    projectName: selectedProjectName.value,
    threadId: selectedThreadId.value,
  });
}

/**
 * AI:确保项目和对话选择仍然指向当前打开的对话。
 *
 * @returns {void}
 */
function ensureSelection() {
  const selectedRow = threadRows.value.find(row => row.id === selectedThreadId.value);
  if (selectedRow) selectedProjectName.value = selectedRow.projectName || '未命名文件夹';
  if (!groupedThreads.value.has(selectedProjectName.value)) selectedProjectName.value = projectNames.value[0] || '';
  const rows = groupedThreads.value.get(selectedProjectName.value) || [];
  if (!rows.some(row => row.id === selectedThreadId.value)) selectedThreadId.value = rows[0]?.id || '';
  persistSelection();
}

/**
 * AI:读取服务器和 Agent 在线状态。
 *
 * @returns {Promise<void>}
 */
async function refreshConnectionStatus() {
  try {
    const data = await getHealth(config.value);
    connectionState.value = {
      online: Boolean(data.online),
      offline: !data.online,
      message: data.online ? 'Agent 在线' : 'Agent 未在线',
    };
  } catch (error) {
    connectionState.value = { online: false, offline: true, message: error.message };
  }
}

/**
 * AI:读取当前打开的对话列表，并复用进行中的同类请求。
 *
 * @returns {Promise<Array<object>>} 对话列表。
 */
async function fetchThreadRows() {
  if (threadListRequest) return threadListRequest;
  threadListRequest = (async () => {
    const data = await getThreads(config.value);
    connectionState.value = { online: true, offline: false, message: 'Agent 在线' };
    return data.threads || [];
  })();
  try {
    return await threadListRequest;
  } catch (error) {
    connectionState.value = { online: false, offline: true, message: error.message };
    throw error;
  } finally {
    threadListRequest = null;
  }
}

/**
 * AI:加载项目和对话列表。
 *
 * @returns {Promise<void>}
 */
async function loadThreads() {
  threadRows.value = await fetchThreadRows();
  ensureSelection();
}

/**
 * AI:根据状态数据更新处理过程展开状态。
 *
 * @param {object} status 状态数据。
 * @returns {void}
 */
function applyThreadStatus(status) {
  currentThreadStatus.value = status;
  if ((status?.steps || []).length) processOpen.value = status.status !== 'complete';
}

/**
 * AI:加载当前对话历史。
 *
 * @param {object|null} statusData 已读取的状态数据。
 * @param {{scrollToBottom?: boolean}} options 渲染选项。
 * @returns {Promise<void>}
 */
async function loadHistory(statusData = null, options = {}) {
  if (!selectedThreadId.value) {
    messages.value = [];
    currentThreadStatus.value = null;
    notice.value = '没有可用 Codex 对话';
    return;
  }
  const data = await getHistory(config.value, selectedThreadId.value);
  messages.value = data.messages || [];
  if (data.available) {
    const snapshot = statusData || await getStatus(config.value, { threadId: selectedThreadId.value });
    applyThreadStatus(snapshot);
  }
  notice.value = data.available ? '已同步电脑端 Codex 对话' : '这个对话暂时没有可加载的本机记录';
  if (options.scrollToBottom) await scrollToBottom();
}

/**
 * AI:刷新当前打开对话列表和历史。
 *
 * @param {{scrollToBottom?: boolean}} options 渲染选项。
 * @returns {Promise<void>}
 */
async function refreshAll(options = {}) {
  loading.value = true;
  try {
    await loadThreads();
    await loadHistory(null, options);
  } catch (error) {
    notice.value = error.message;
  } finally {
    loading.value = false;
  }
}

/**
 * AI:手动刷新当前数据，保留当前阅读位置。
 *
 * @returns {Promise<void>}
 */
async function manualRefresh() {
  await refreshAll({ scrollToBottom: false });
}

/**
 * AI:切换项目后加载该项目第一个对话。
 *
 * @param {{detail: {value: number}}} event picker 事件。
 * @returns {Promise<void>}
 */
async function onProjectChange(event) {
  selectedProjectName.value = projectNames.value[Number(event.detail.value)] || '';
  const rows = groupedThreads.value.get(selectedProjectName.value) || [];
  selectedThreadId.value = rows[0]?.id || '';
  currentThreadStatus.value = null;
  pendingWatch.value = null;
  historyReloadedForCompletion.value = false;
  persistSelection();
  await loadHistory(null, { scrollToBottom: true });
}

/**
 * AI:切换对话后加载该对话历史。
 *
 * @param {{detail: {value: number}}} event picker 事件。
 * @returns {Promise<void>}
 */
async function onThreadChange(event) {
  const row = threadOptions.value[Number(event.detail.value)];
  selectedThreadId.value = row?.id || '';
  currentThreadStatus.value = null;
  pendingWatch.value = null;
  historyReloadedForCompletion.value = false;
  persistSelection();
  await loadHistory(null, { scrollToBottom: true });
}

/**
 * AI:轮询当前对话运行状态。
 *
 * @param {{threadId?: string, since?: string}} watch 轮询参数。
 * @returns {Promise<void>}
 */
async function pollStatus(watch = pendingWatch.value || {}) {
  const requestedThreadId = watch.threadId || selectedThreadId.value;
  if (!requestedThreadId) return;
  const data = await getStatus(config.value, { ...watch, threadId: requestedThreadId });
  if (requestedThreadId !== selectedThreadId.value || data.threadId !== selectedThreadId.value) return;
  applyThreadStatus(data);
  if (data.status === 'complete' || data.status === 'error') {
    const shouldScroll = followBottom.value;
    if (pendingWatch.value?.threadId === data.threadId) pendingWatch.value = null;
    followBottom.value = false;
    if (!historyReloadedForCompletion.value) {
      historyReloadedForCompletion.value = true;
      await loadHistory(data, { scrollToBottom: shouldScroll });
    }
    return;
  }
  historyReloadedForCompletion.value = false;
  notice.value = data.preview || 'Codex 正在回复...';
}

/**
 * AI:向电脑端 Codex 发送消息。
 *
 * @returns {Promise<void>}
 */
async function send() {
  const text = messageText.value.trim();
  if (!text || !selectedThreadId.value) return;
  messageText.value = '';
  sending.value = true;
  followBottom.value = true;
  historyReloadedForCompletion.value = false;
  messages.value = [
    ...messages.value,
    { role: 'user', text },
    { role: 'assistant', text: '已发送，等待 Codex 回复...' },
  ];
  await scrollToBottom();
  try {
    const data = await sendMessage(config.value, { threadId: selectedThreadId.value, text });
    pendingWatch.value = data.watch || { threadId: selectedThreadId.value };
    await pollStatus(pendingWatch.value);
  } catch (error) {
    notice.value = error.message;
  } finally {
    sending.value = false;
  }
}

/**
 * AI:停止电脑端 Codex 当前任务。
 *
 * @returns {Promise<void>}
 */
async function stop() {
  if (!canStop.value) return;
  try {
    const data = await stopCodex(config.value);
    notice.value = data.message || '已发送停止指令';
  } catch (error) {
    notice.value = error.message;
  }
}

/**
 * AI:启动页面定时刷新任务。
 *
 * @returns {void}
 */
function startTimers() {
  connectionTimer = setInterval(() => refreshConnectionStatus(), 3000);
  threadTimer = setInterval(() => loadThreads().catch(error => { notice.value = error.message; }), 3000);
  pollTimer = setInterval(() => pollStatus().catch(error => { notice.value = error.message; }), 900);
}

/**
 * AI:停止页面定时刷新任务。
 *
 * @returns {void}
 */
function stopTimers() {
  clearInterval(connectionTimer);
  clearInterval(threadTimer);
  clearInterval(pollTimer);
}

onMounted(async () => {
  await refreshConnectionStatus();
  await refreshAll({ scrollToBottom: true });
  startTimers();
});

onUnmounted(() => {
  stopTimers();
});

onShow(() => {
  const latest = loadConfig();
  if (latest.serverUrl !== config.value.serverUrl || latest.token !== config.value.token) {
    config.value = latest;
    refreshConnectionStatus();
    refreshAll({ scrollToBottom: true });
  }
});
</script>

<style scoped>
.page {
  min-height: 100vh;
  background: #f5f6f8;
  color: #111827;
  padding-bottom: calc(146px + env(safe-area-inset-bottom));
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  background: #ffffff;
  border-bottom: 1px solid #e5e7eb;
}

.status-row {
  display: flex;
  min-width: 0;
  flex: 1;
  gap: 10px;
}

.status-item {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
}

.dot {
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  border-radius: 999px;
  background: #9ca3af;
}

.dot-gray {
  background: #9ca3af;
}

.dot-red {
  background: #ef4444;
}

.dot-blue {
  background: #3b82f6;
}

.dot-green {
  background: #22c55e;
}

.status-text {
  color: #4b5563;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-button {
  width: 54px;
  height: 34px;
  background: #111827;
  color: #ffffff;
  font-size: 13px;
}

.selectors {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) 58px;
  gap: 8px;
  padding: 10px 12px;
  background: #ffffff;
  border-bottom: 1px solid #e5e7eb;
}

.select-control {
  height: 36px;
  min-width: 0;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #ffffff;
  padding: 0 9px;
  color: #111827;
  font-size: 13px;
  line-height: 36px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.refresh-button {
  height: 36px;
  background: #111827;
  color: #ffffff;
  font-size: 13px;
}

.notice {
  min-height: 28px;
  padding: 7px 12px;
  color: #6b7280;
  font-size: 12px;
  line-height: 1.35;
}

.messages {
  height: calc(100vh - 250px);
  padding: 8px 12px 16px;
}

.message {
  max-width: 92%;
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 8px;
  line-height: 1.45;
  font-size: 14px;
}

.message-user {
  margin-left: auto;
  background: #1f6feb;
  color: #ffffff;
}

.message-assistant {
  margin-right: auto;
  border: 1px solid #e5e7eb;
  background: #ffffff;
  color: #111827;
}

.markdown {
  word-break: break-word;
}

.process-card {
  max-width: 92%;
  margin: 8px 0;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #ffffff;
  overflow: hidden;
}

.process-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 12px;
  color: #111827;
  font-size: 13px;
}

.process-action {
  color: #1f6feb;
}

.process-body {
  border-top: 1px solid #e5e7eb;
}

.process-step {
  padding: 10px 12px;
  border-bottom: 1px solid #f0f2f5;
}

.process-step:last-child {
  border-bottom: 0;
}

.process-label {
  display: block;
  margin-bottom: 6px;
  color: #374151;
  font-size: 12px;
  font-weight: 700;
}

.muted-markdown {
  color: #6b7280;
  font-size: 13px;
}

.bottom-anchor {
  height: 1px;
}

.composer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 58px 58px;
  gap: 8px;
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid #e5e7eb;
  background: #ffffff;
}

.input {
  min-height: 42px;
  max-height: 108px;
  width: 100%;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 9px 10px;
  color: #111827;
  font-size: 14px;
  line-height: 1.35;
}

.send-button,
.stop-button {
  height: 42px;
  color: #ffffff;
  font-size: 14px;
}

.send-button {
  background: #111827;
}

.stop-button {
  background: #b42318;
}

button[disabled] {
  opacity: 0.55;
}
</style>
