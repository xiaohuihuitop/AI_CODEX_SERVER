<template>
  <view class="page">
    <view class="control-panel">
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
        <button class="thread-selector" :disabled="!threadRows.length" @click="toggleThreadPopup">
          <text class="thread-selector-title">{{ selectedThreadName || '选择对话' }}</text>
          <text class="thread-selector-subtitle">{{ selectedProjectName || '未选择文件夹' }}</text>
        </button>
        <button class="refresh-button" :disabled="loading" @click="manualRefresh">刷新</button>
      </view>

      <view class="notice">{{ notice }}</view>
    </view>

    <view v-if="threadPopupOpen" class="popup-mask" @click="closeThreadPopup"></view>
    <view v-if="threadPopupOpen" class="thread-popup">
      <view class="popup-header">
        <view>
          <text class="popup-title">选择对话</text>
          <text class="popup-subtitle">按文件夹分组显示当前打开的对话</text>
        </view>
        <button class="popup-close" @click="closeThreadPopup">关闭</button>
      </view>
      <scroll-view class="popup-list" scroll-y>
        <view v-if="!projectGroups.length" class="popup-empty">暂无可选对话</view>
        <view v-for="project in projectGroups" :key="project.name" class="project-group">
          <view class="project-title">{{ project.name }}</view>
          <button
            v-for="thread in project.threads"
            :key="thread.id"
            class="thread-row"
            :class="thread.id === selectedThreadId ? 'thread-row-active' : ''"
            @click="selectThread(project.name, thread)"
          >
            <view class="dot" :class="threadDotClassFor(thread)"></view>
            <text class="thread-row-name">{{ thread.name || thread.id }}</text>
          </button>
        </view>
      </scroll-view>
    </view>

    <scroll-view class="messages" scroll-y :scroll-into-view="scrollTarget">
      <view
        v-for="(row, index) in messagesBeforeProcess"
        :key="row.id || `before-${row.role}-${index}`"
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

      <view
        v-for="(row, index) in messagesAfterProcess"
        :key="row.id || `after-${row.role}-${index}`"
        class="message"
        :class="row.role === 'user' ? 'message-user' : 'message-assistant'"
      >
        <rich-text class="markdown" :nodes="renderMarkdown(row.text || '')" />
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
import { onBackPress, onShow } from '@dcloudio/uni-app';
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
const threadPopupOpen = ref(false);
const scrollTarget = ref('');
let threadListRequest = null;
let connectionTimer = null;
let threadTimer = null;
let pollTimer = null;

/**
 * AI:按项目分组当前打开的 Codex 对话。
 *
 * @param {Array<object>} rows 对话列表。
 * @returns {{groups: object, names: string[]}} 项目分组。
 */
function groupThreads(rows) {
  const groups = {};
  const names = [];
  for (const row of rows || []) {
    const projectName = row.projectName || '未命名文件夹';
    if (!Object.prototype.hasOwnProperty.call(groups, projectName)) {
      groups[projectName] = [];
      names.push(projectName);
    }
    groups[projectName].push(row);
  }
  return { groups, names };
}

const groupedThreads = computed(() => groupThreads(threadRows.value));
const projectNames = computed(() => groupedThreads.value.names);
const threadOptions = computed(() => groupedThreads.value.groups[selectedProjectName.value] || []);
const selectedThread = computed(() => threadOptions.value.find(row => row.id === selectedThreadId.value) || null);
const selectedThreadName = computed(() => (selectedThread.value && selectedThread.value.name) || selectedThreadId.value);
const projectGroups = computed(() => projectNames.value.map(name => ({
  name,
  threads: groupedThreads.value.groups[name] || [],
})));
const processSteps = computed(() => {
  const steps = (currentThreadStatus.value && currentThreadStatus.value.steps) || [];
  return steps.filter(step => step && step.text && step.kind !== 'final' && step.kind !== 'complete');
});
const running = computed(() => {
  const status = (currentThreadStatus.value && currentThreadStatus.value.status) || (selectedThread.value && selectedThread.value.status);
  const activeStatus = Boolean(currentThreadStatus.value && currentThreadStatus.value.active) || Boolean(selectedThread.value && selectedThread.value.active);
  const pendingThreadId = pendingWatch.value && pendingWatch.value.threadId;
  return activeStatus || status === 'running' || pendingThreadId === selectedThreadId.value;
});
const complete = computed(() => {
  const currentStatus = currentThreadStatus.value && currentThreadStatus.value.status;
  const selectedStatus = selectedThread.value && selectedThread.value.status;
  return !running.value && (currentStatus === 'complete' || selectedStatus === 'complete');
});
const canStop = computed(() => running.value && !sending.value);
const connectionDotClass = computed(() => connectionState.value.online ? 'dot-green' : connectionState.value.offline ? 'dot-red' : 'dot-gray');
const threadDotClass = computed(() => running.value ? 'dot-blue' : complete.value ? 'dot-green' : 'dot-gray');
const connectionText = computed(() => connectionState.value.online ? 'Agent 在线' : connectionState.value.message || '连接未知');
const threadText = computed(() => running.value ? '对话进行中' : complete.value ? '对话已完成' : '对话空闲');
const processInsertIndex = computed(() => {
  if (!complete.value || !processSteps.value.length) return -1;
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    if (messages.value[index] && messages.value[index].role === 'assistant') return index;
  }
  return -1;
});
const messagesBeforeProcess = computed(() => {
  const index = processInsertIndex.value;
  return index === -1 ? messages.value : messages.value.slice(0, index);
});
const messagesAfterProcess = computed(() => {
  const index = processInsertIndex.value;
  return index === -1 ? [] : messages.value.slice(index);
});

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
 * AI:切换对话选择弹出列表。
 *
 * @returns {void}
 */
function toggleThreadPopup() {
  threadPopupOpen.value = !threadPopupOpen.value;
}

/**
 * AI:关闭对话选择弹出列表。
 *
 * @returns {void}
 */
function closeThreadPopup() {
  threadPopupOpen.value = false;
}

/**
 * AI:切换处理过程展开状态。
 *
 * @returns {void}
 */
function toggleProcess() {
  processOpen.value = !processOpen.value;
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
  if (!Object.prototype.hasOwnProperty.call(groupedThreads.value.groups, selectedProjectName.value)) selectedProjectName.value = projectNames.value[0] || '';
  const rows = groupedThreads.value.groups[selectedProjectName.value] || [];
  if (!rows.some(row => row.id === selectedThreadId.value)) selectedThreadId.value = rows[0] ? rows[0].id : '';
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
 * @param {{autoOpenProcess?: boolean}} options 展开选项。
 * @returns {void}
 */
function applyThreadStatus(status, options = {}) {
  const previousStatus = currentThreadStatus.value && currentThreadStatus.value.status;
  currentThreadStatus.value = status;
  const steps = (status && status.steps) || [];
  if (!steps.length) {
    processOpen.value = false;
    return;
  }
  if (status.status === 'complete' || status.status === 'error') {
    if (previousStatus !== 'complete' && previousStatus !== 'error') processOpen.value = false;
    return;
  }
  if (options.autoOpenProcess || followBottom.value) processOpen.value = true;
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
    processOpen.value = false;
    notice.value = '没有可用 Codex 对话';
    return;
  }
  const data = await getHistory(config.value, selectedThreadId.value);
  messages.value = data.messages || [];
  if (data.available) {
    const snapshot = statusData || await getStatus(config.value, { threadId: selectedThreadId.value });
    applyThreadStatus(snapshot, { autoOpenProcess: Boolean(options.scrollToBottom) });
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
 * AI:切换到指定对话。
 *
 * @param {string} projectName 项目目录名。
 * @param {object} thread 对话对象。
 * @returns {Promise<void>}
 */
async function selectThread(projectName, thread) {
  selectedProjectName.value = projectName || '';
  selectedThreadId.value = thread ? thread.id : '';
  threadPopupOpen.value = false;
  currentThreadStatus.value = null;
  pendingWatch.value = null;
  historyReloadedForCompletion.value = false;
  processOpen.value = false;
  persistSelection();
  await loadHistory(null, { scrollToBottom: true });
}

/**
 * AI:返回对话在侧边列表中的状态点样式。
 *
 * @param {object} thread 对话对象。
 * @returns {string} 状态样式类名。
 */
function threadDotClassFor(thread) {
  const isSelected = thread && thread.id === selectedThreadId.value;
  const status = isSelected && currentThreadStatus.value
    ? currentThreadStatus.value.status
    : thread && thread.status;
  const active = isSelected && currentThreadStatus.value
    ? Boolean(currentThreadStatus.value.active)
    : Boolean(thread && thread.active);
  return active || status === 'running' ? 'dot-blue' : 'dot-green';
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
  const data = await getStatus(config.value, Object.assign({}, watch, { threadId: requestedThreadId }));
  if (requestedThreadId !== selectedThreadId.value || data.threadId !== selectedThreadId.value) return;
  applyThreadStatus(data, { autoOpenProcess: followBottom.value });
  if (data.status === 'complete' || data.status === 'error') {
    const shouldScroll = followBottom.value;
    if (pendingWatch.value && pendingWatch.value.threadId === data.threadId) pendingWatch.value = null;
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
  messages.value = messages.value.concat([
    { role: 'user', text },
    { role: 'assistant', text: '已发送，等待 Codex 回复...' },
  ]);
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

onBackPress(() => {
  if (!threadPopupOpen.value) return false;
  threadPopupOpen.value = false;
  return true;
});
</script>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 100vh;
  overflow: hidden;
  background: #f4f5f7;
  color: #111827;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.control-panel {
  flex: 0 0 auto;
  padding: 10px 12px 8px;
  background: #f4f5f7;
  border-bottom: 1px solid #dde1e7;
}

.topbar,
.selectors {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topbar {
  height: 36px;
}

.status-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  min-width: 0;
  flex: 1;
  gap: 8px;
}

.status-item {
  display: flex;
  align-items: center;
  height: 36px;
  min-width: 0;
  border: 1px solid #dfe3ea;
  border-radius: 7px;
  background: #ffffff;
  padding: 0 8px;
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
  line-height: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.selectors {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 58px;
  height: 38px;
  margin-top: 8px;
}

.settings-button,
.refresh-button,
.thread-selector,
.popup-close,
.thread-row,
.send-button,
.stop-button {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  border: 0;
  border-radius: 7px;
  padding: 0;
  line-height: 1;
  font-weight: 600;
}

.settings-button {
  width: 58px;
  height: 36px;
  flex: 0 0 58px;
  background: #111827;
  color: #ffffff;
  font-size: 13px;
}

.refresh-button {
  height: 38px;
  background: #111827;
  color: #ffffff;
  font-size: 13px;
}

.thread-selector {
  flex-direction: column;
  align-items: flex-start;
  height: 38px;
  min-width: 0;
  border: 1px solid #dfe3ea;
  border-radius: 7px;
  background: #ffffff;
  padding: 4px 10px;
  color: #111827;
}

.thread-selector-title,
.thread-selector-subtitle {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-selector-title {
  color: #111827;
  font-size: 13px;
  line-height: 15px;
}

.thread-selector-subtitle {
  color: #6b7280;
  font-size: 11px;
  line-height: 13px;
  font-weight: 400;
}

.notice {
  height: 24px;
  margin-top: 7px;
  color: #6b7280;
  font-size: 12px;
  line-height: 24px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.popup-mask {
  position: fixed;
  z-index: 20;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: rgba(17, 24, 39, 0.34);
}

.thread-popup {
  position: fixed;
  z-index: 21;
  top: 100px;
  right: 12px;
  left: 12px;
  background: #f8fafc;
  border: 1px solid #dfe3ea;
  border-radius: 10px;
  overflow: hidden;
}

.popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 58px;
  padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
  border-bottom: 1px solid #dfe3ea;
  background: #ffffff;
}

.popup-title,
.popup-subtitle {
  display: block;
}

.popup-title {
  color: #111827;
  font-size: 16px;
  line-height: 20px;
  font-weight: 700;
}

.popup-subtitle {
  margin-top: 2px;
  color: #6b7280;
  font-size: 11px;
  line-height: 14px;
}

.popup-close {
  width: 54px;
  height: 32px;
  flex: 0 0 54px;
  background: #111827;
  color: #ffffff;
  font-size: 13px;
}

.popup-list {
  height: 52vh;
  max-height: 460px;
  padding: 10px 10px 20px;
}

.popup-empty {
  padding: 14px 8px;
  color: #6b7280;
  font-size: 13px;
}

.project-group {
  margin-bottom: 12px;
}

.project-title {
  padding: 6px 4px;
  color: #4b5563;
  font-size: 12px;
  line-height: 16px;
  font-weight: 700;
}

.thread-row {
  justify-content: flex-start;
  width: 100%;
  min-height: 40px;
  margin-top: 6px;
  border: 1px solid #e5e7eb;
  background: #ffffff;
  padding: 0 9px;
  color: #111827;
}

.thread-row-active {
  border-color: #111827;
  background: #f3f4f6;
}

.thread-row-name {
  min-width: 0;
  flex: 1;
  margin-left: 8px;
  color: #111827;
  font-size: 13px;
  line-height: 16px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.messages {
  flex: 1 1 auto;
  min-height: 0;
  height: 0;
  padding: 10px 12px 14px;
}

.message {
  max-width: 94%;
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 8px;
  line-height: 1.58;
  font-size: 14px;
  font-weight: 400;
}

.message-user {
  margin-left: auto;
  background: #1f2937;
  color: #ffffff;
}

.message-assistant {
  margin-right: auto;
  border: 1px solid #dfe3ea;
  background: #ffffff;
  color: #111827;
}

.markdown {
  color: inherit;
  font-size: 14px;
  line-height: 1.58;
  word-break: break-word;
}

.process-card {
  max-width: 94%;
  margin: 10px 0;
  border: 1px solid #dfe3ea;
  border-radius: 8px;
  background: #ffffff;
  overflow: hidden;
}

.process-title {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 42px;
  align-items: center;
  min-height: 40px;
  padding: 0 12px;
  color: #111827;
  font-size: 13px;
}

.process-action {
  color: #1f6feb;
  text-align: right;
  font-weight: 600;
}

.process-body {
  border-top: 1px solid #eef1f5;
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
  font-weight: 600;
}

.muted-markdown {
  color: #6b7280;
  font-size: 13px;
}

.bottom-anchor {
  height: 1px;
}

.composer {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 58px 58px;
  gap: 8px;
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid #dde1e7;
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
