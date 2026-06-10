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
      <view v-for="item in timelineItems" :key="item.key">
        <view
          v-if="item.type === 'message'"
          class="message"
          :class="item.row.role === 'user' ? 'message-user' : 'message-assistant'"
        >
          <rich-text class="markdown" :nodes="renderMarkdown(item.row.text || '')" />
        </view>

        <view v-else-if="item.type === 'process'" class="process-card">
          <view class="process-title" @click="toggleProcess(item.turn.turnId)">
            <text>{{ processTitle(item.turn, processOpenState[item.turn.turnId]) }}</text>
            <text class="process-action">{{ processOpenState[item.turn.turnId] ? '收起' : '展开' }}</text>
          </view>
          <view v-if="processOpenState[item.turn.turnId]" class="process-body">
            <view v-for="(step, index) in item.turn.steps" :key="`${item.turn.turnId}-${step.kind || 'step'}-${index}`" class="process-step">
              <text class="process-label">{{ step.label || '过程' }}</text>
              <rich-text class="markdown muted-markdown" :nodes="renderMarkdown(step.text || '')" />
            </view>
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
import { onBackPress, onHide, onShow, onUnload } from '@dcloudio/uni-app';
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
const processOpenState = ref({});
const loading = ref(false);
const sending = ref(false);
const threadPopupOpen = ref(false);
const scrollTarget = ref('');
let threadListRequest = null;
let connectionTimer = null;
let threadTimer = null;
let pollTimer = null;
let mountedOnce = false;
let pageActive = false;
let timersStarted = false;
let lifecycleToken = 0;
let requestTasks = [];

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
const processTurns = computed(() => ((currentThreadStatus.value && currentThreadStatus.value.turns) || [])
  .map(turn => ({
    turnId: turn.turnId || '',
    status: turn.status || '',
    steps: ((turn.steps || []).filter(step => step && step.text && step.kind !== 'final' && step.kind !== 'complete')),
    final: turn.final || '',
    durationText: formatElapsedTime(turn.startedAt, turn.completedAt),
  }))
  .filter(turn => turn.turnId && turn.steps.length));
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
const timelineItems = computed(() => {
  const items = [];
  const pendingTurns = [];
  const turnsById = {};
  for (const turn of processTurns.value) {
    pendingTurns.push(turn);
    turnsById[turn.turnId] = turn;
  }
  for (let index = 0; index < messages.value.length; index += 1) {
    const row = messages.value[index];
    const exactTurn = row && row.role === 'assistant' && row.turnId ? turnsById[row.turnId] : null;
    if (exactTurn) {
      items.push({ type: 'process', key: `process-${exactTurn.turnId}`, turn: exactTurn });
      for (let pendingIndex = 0; pendingIndex < pendingTurns.length; pendingIndex += 1) {
        if (pendingTurns[pendingIndex].turnId === exactTurn.turnId) {
          pendingTurns.splice(pendingIndex, 1);
          break;
        }
      }
    }
    items.push({ type: 'message', key: row.id || `message-${row.role}-${index}`, row });
  }
  for (const turn of pendingTurns) {
    items.push({ type: 'process', key: `process-${turn.turnId}`, turn });
  }
  return items;
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
 * AI:格式化 Codex 当前轮次已处理时间。
 *
 * @param {string} startedAt 开始时间。
 * @param {string} completedAt 完成时间。
 * @returns {string} 已处理时间文本。
 */
function formatElapsedTime(startedAt, completedAt) {
  const start = Date.parse(startedAt || '');
  if (Number.isNaN(start)) return '';
  const end = Date.parse(completedAt || '') || Date.now();
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `已处理 ${minutes}m ${seconds}s`;
  return `已处理 ${seconds}s`;
}

/**
 * AI:生成处理过程标题。
 *
 * @param {object} turn 当前轮次。
 * @param {boolean} open 是否展开。
 * @returns {string} 标题文本。
 */
function processTitle(turn, open) {
  const count = turn && turn.steps ? turn.steps.length : 0;
  const prefix = open ? '处理过程' : '处理过程已折叠';
  const duration = turn && turn.durationText ? ` · ${turn.durationText}` : '';
  return `${prefix}${duration}（${count}）`;
}

/**
 * AI:判断当前页面实例是否仍可安全更新。
 *
 * @returns {boolean} 页面仍处于可更新状态时返回 true。
 */
function canUpdatePage() {
  return pageActive;
}

/**
 * AI:获取当前页面生命周期令牌，用于阻止旧异步请求回写新页面实例。
 *
 * @returns {number} 生命周期令牌。
 */
function currentLifecycleToken() {
  return lifecycleToken;
}

/**
 * AI:判断指定异步任务是否仍属于当前页面实例。
 *
 * @param {number} token 异步任务启动时记录的生命周期令牌。
 * @returns {boolean} 仍可安全更新时返回 true。
 */
function canUpdateTask(token) {
  return canUpdatePage() && token === lifecycleToken;
}

/**
 * AI:登记当前页面发出的原生请求，页面销毁时统一取消。
 *
 * @param {object} task uni.request 返回的任务对象。
 * @returns {void}
 */
function registerRequestTask(task) {
  if (!task || typeof task.abort !== 'function') return;
  requestTasks.push(task);
}

/**
 * AI:请求结束后从页面任务列表中移除。
 *
 * @param {object} task uni.request 返回的任务对象。
 * @returns {void}
 */
function unregisterRequestTask(task) {
  const next = [];
  for (const item of requestTasks) {
    if (item !== task) next.push(item);
  }
  requestTasks = next;
}

/**
 * AI:取消当前页面还未结束的原生请求。
 *
 * @returns {void}
 */
function abortRequestTasks() {
  const tasks = requestTasks.slice();
  requestTasks = [];
  for (const task of tasks) {
    try {
      task.abort();
    } catch (error) {
      // AI:页面退出时只需要终止请求，不把取消请求再写回已销毁页面。
    }
  }
}

/**
 * AI:激活当前页面实例并刷新生命周期令牌。
 *
 * @returns {void}
 */
function activatePage() {
  if (pageActive) return;
  pageActive = true;
  lifecycleToken += 1;
}

/**
 * AI:停用当前页面实例并废弃未完成异步任务。
 *
 * @returns {void}
 */
function deactivatePage() {
  if (!pageActive && !timersStarted) return;
  pageActive = false;
  lifecycleToken += 1;
  threadListRequest = null;
  stopTimers();
  abortRequestTasks();
}

/**
 * AI:只在页面可更新时写入提示文本，避免页面销毁后异步回写。
 *
 * @param {string} text 提示文本。
 * @returns {void}
 */
function setNotice(text) {
  if (!canUpdatePage()) return;
  notice.value = text;
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
 * AI:切换指定轮次的处理过程展开状态。
 *
 * @param {string} turnId 轮次 ID。
 * @returns {void}
 */
function toggleProcess(turnId) {
  if (!turnId) return;
  processOpenState.value = Object.assign({}, processOpenState.value, {
    [turnId]: !processOpenState.value[turnId],
  });
}

/**
 * AI:提取每轮处理过程的状态索引。
 *
 * @param {object|null} status 状态数据。
 * @returns {object} 以 turnId 为键的状态索引。
 */
function turnStatusById(status) {
  const rows = (status && status.turns) || [];
  const result = {};
  for (const turn of rows) {
    if (turn && turn.turnId) result[turn.turnId] = turn.status || '';
  }
  return result;
}

/**
 * AI:按轮次状态同步处理过程默认展开状态。
 *
 * @param {object} status 状态数据。
 * @param {{autoOpenProcess?: boolean}} options 展开选项。
 * @param {object} previousTurnStatus 上一次轮次状态索引。
 * @returns {void}
 */
function syncProcessOpenState(status, options = {}, previousTurnStatus = {}) {
  const next = {};
  const turns = (status && status.turns) || [];
  for (const turn of turns) {
    const turnId = turn && turn.turnId;
    if (!turnId) continue;
    const isRunningTurn = turn.status === 'running' || (status && status.active && turns[turns.length - 1] === turn);
    if (isRunningTurn) {
      next[turnId] = true;
      continue;
    }
    if (previousTurnStatus[turnId] === 'running') {
      next[turnId] = false;
      continue;
    }
    next[turnId] = Boolean(processOpenState.value[turnId]);
  }
  processOpenState.value = next;
}

/**
 * AI:把发送后的临时回复绑定到当前运行轮次，避免处理过程插到错误消息前。
 *
 * @param {object} status 状态数据。
 * @returns {void}
 */
function bindPendingAssistantTurn(status) {
  const turns = (status && status.turns) || [];
  let runningTurn = null;
  for (const turn of turns) {
    if (turn && turn.turnId && (turn.status === 'running' || status.active)) runningTurn = turn;
  }
  if (!runningTurn) return;
  const rows = messages.value.slice();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && row.role === 'assistant' && !row.turnId && row.pending) {
      rows[index] = Object.assign({}, row, { turnId: runningTurn.turnId });
      messages.value = rows;
      return;
    }
  }
}

/**
 * AI:触发消息列表滚动到底部。
 *
 * @returns {Promise<void>}
 */
async function scrollToBottom() {
  const token = currentLifecycleToken();
  if (!canUpdateTask(token)) return;
  scrollTarget.value = '';
  await nextTick();
  if (!canUpdateTask(token)) return;
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
  const token = currentLifecycleToken();
  try {
    const data = await getHealth(config.value, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token)) return;
    connectionState.value = {
      online: Boolean(data.online),
      offline: !data.online,
      message: data.online ? 'Agent 在线' : 'Agent 未在线',
    };
  } catch (error) {
    if (!canUpdateTask(token)) return;
    connectionState.value = { online: false, offline: true, message: error.message };
  }
}

/**
 * AI:读取当前打开的对话列表，并复用进行中的同类请求。
 *
 * @returns {Promise<Array<object>>} 对话列表。
 */
async function fetchThreadRows() {
  const token = currentLifecycleToken();
  if (!canUpdateTask(token)) return threadRows.value;
  if (threadListRequest) return threadListRequest;
  const request = (async () => {
    const data = await getThreads(config.value, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token)) return threadRows.value;
    connectionState.value = { online: true, offline: false, message: 'Agent 在线' };
    return data.threads || [];
  })();
  threadListRequest = request;
  try {
    return await request;
  } catch (error) {
    if (!canUpdateTask(token)) return threadRows.value;
    connectionState.value = { online: false, offline: true, message: error.message };
    throw error;
  } finally {
    if (threadListRequest === request) threadListRequest = null;
  }
}

/**
 * AI:加载项目和对话列表。
 *
 * @returns {Promise<void>}
 */
async function loadThreads() {
  const token = currentLifecycleToken();
  const rows = await fetchThreadRows();
  if (!canUpdateTask(token)) return;
  threadRows.value = rows;
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
  const previousTurnStatus = turnStatusById(currentThreadStatus.value);
  currentThreadStatus.value = status;
  bindPendingAssistantTurn(status);
  syncProcessOpenState(status, options, previousTurnStatus);
}

/**
 * AI:加载当前对话历史。
 *
 * @param {object|null} statusData 已读取的状态数据。
 * @param {{scrollToBottom?: boolean}} options 渲染选项。
 * @returns {Promise<void>}
 */
async function loadHistory(statusData = null, options = {}) {
  const token = currentLifecycleToken();
  if (!canUpdateTask(token)) return;
  if (!selectedThreadId.value) {
    messages.value = [];
    currentThreadStatus.value = null;
    processOpenState.value = {};
    setNotice('没有可用 Codex 对话');
    return;
  }
  const data = await getHistory(config.value, selectedThreadId.value, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
  if (!canUpdateTask(token)) return;
  messages.value = data.messages || [];
  if (data.available) {
    const snapshot = statusData || await getStatus(config.value, { threadId: selectedThreadId.value }, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token)) return;
    applyThreadStatus(snapshot, { autoOpenProcess: Boolean(options.scrollToBottom) });
  }
  setNotice(data.available ? '已同步电脑端 Codex 对话' : '这个对话暂时没有可加载的本机记录');
  if (options.scrollToBottom) await scrollToBottom();
}

/**
 * AI:刷新当前打开对话列表和历史。
 *
 * @param {{scrollToBottom?: boolean}} options 渲染选项。
 * @returns {Promise<void>}
 */
async function refreshAll(options = {}) {
  const token = currentLifecycleToken();
  if (!canUpdateTask(token)) return;
  loading.value = true;
  try {
    await loadThreads();
    if (!canUpdateTask(token)) return;
    await loadHistory(null, options);
  } catch (error) {
    setNotice(error.message);
  } finally {
    if (canUpdateTask(token)) loading.value = false;
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
  const token = currentLifecycleToken();
  if (!canUpdateTask(token)) return;
  selectedProjectName.value = projectName || '';
  selectedThreadId.value = thread ? thread.id : '';
  threadPopupOpen.value = false;
  currentThreadStatus.value = null;
  pendingWatch.value = null;
  historyReloadedForCompletion.value = false;
  processOpenState.value = {};
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
  const token = currentLifecycleToken();
  if (!canUpdateTask(token)) return;
  const requestedThreadId = watch.threadId || selectedThreadId.value;
  if (!requestedThreadId) return;
  const data = await getStatus(config.value, Object.assign({}, watch, { threadId: requestedThreadId }), { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
  if (!canUpdateTask(token)) return;
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
  setNotice(data.preview || 'Codex 正在回复...');
}

/**
 * AI:向电脑端 Codex 发送消息。
 *
 * @returns {Promise<void>}
 */
async function send() {
  const token = currentLifecycleToken();
  if (!canUpdateTask(token)) return;
  const text = messageText.value.trim();
  if (!text || !selectedThreadId.value) return;
  messageText.value = '';
  sending.value = true;
  followBottom.value = true;
  historyReloadedForCompletion.value = false;
  messages.value = messages.value.concat([
    { role: 'user', text },
    { role: 'assistant', text: '已发送，等待 Codex 回复...', pending: true },
  ]);
  await scrollToBottom();
  try {
    const data = await sendMessage(config.value, { threadId: selectedThreadId.value, text }, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token)) return;
    pendingWatch.value = data.watch || { threadId: selectedThreadId.value };
    await pollStatus(pendingWatch.value);
  } catch (error) {
    setNotice(error.message);
  } finally {
    if (canUpdateTask(token)) sending.value = false;
  }
}

/**
 * AI:停止电脑端 Codex 当前任务。
 *
 * @returns {Promise<void>}
 */
async function stop() {
  const token = currentLifecycleToken();
  if (!canUpdateTask(token)) return;
  if (!canStop.value) return;
  try {
    const data = await stopCodex(config.value, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token)) return;
    setNotice(data.message || '已发送停止指令');
  } catch (error) {
    setNotice(error.message);
  }
}

/**
 * AI:启动页面定时刷新任务。
 *
 * @returns {void}
 */
function startTimers() {
  if (timersStarted) return;
  timersStarted = true;
  connectionTimer = setInterval(() => {
    if (canUpdatePage()) refreshConnectionStatus().catch(error => { setNotice(error.message); });
  }, 3000);
  threadTimer = setInterval(() => {
    if (canUpdatePage()) loadThreads().catch(error => { setNotice(error.message); });
  }, 3000);
  pollTimer = setInterval(() => {
    if (canUpdatePage()) pollStatus().catch(error => { setNotice(error.message); });
  }, 900);
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
  connectionTimer = null;
  threadTimer = null;
  pollTimer = null;
  timersStarted = false;
}

onMounted(async () => {
  activatePage();
  mountedOnce = true;
  await refreshConnectionStatus();
  if (!canUpdatePage()) return;
  await refreshAll({ scrollToBottom: true });
  if (!canUpdatePage()) return;
  startTimers();
});

onUnmounted(() => {
  deactivatePage();
});

onHide(() => {
  deactivatePage();
});

onUnload(() => {
  deactivatePage();
});

onShow(() => {
  activatePage();
  if (!mountedOnce) return;
  startTimers();
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
  align-items: end;
  height: 40px;
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
  position: relative;
  justify-content: flex-start;
  height: 40px;
  min-width: 0;
  border: 0;
  border-bottom: 1px solid #9ca3af;
  border-radius: 0;
  background: transparent;
  padding: 0;
  color: #111827;
}

.thread-selector-title,
.thread-selector-subtitle {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-selector-title {
  min-width: 0;
  flex: 1;
  color: #111827;
  font-size: 14px;
  line-height: 40px;
  text-align: left;
}

.thread-selector-subtitle {
  flex: 0 1 34%;
  margin-left: 8px;
  color: #6b7280;
  font-size: 11px;
  line-height: 40px;
  font-weight: 400;
  text-align: right;
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
