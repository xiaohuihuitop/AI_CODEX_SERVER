<template>
  <view class="page">
    <view class="control-panel">
      <view class="topbar">
        <view class="status-row">
          <view class="status-item">
            <view class="dot" :class="serverDotClass"></view>
            <text class="status-text">{{ serverText }}</text>
          </view>
          <view class="status-item">
            <view class="dot" :class="agentDotClass"></view>
            <text class="status-text">{{ agentText }}</text>
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
        <button class="refresh-button" :disabled="loading || switchingThread" @click="manualRefresh">刷新</button>
      </view>

      <view class="notice">{{ notice }}</view>
    </view>

    <view v-if="threadPopupOpen" class="popup-mask" @click="closeThreadPopup"></view>
    <view v-if="threadPopupOpen" class="thread-popup">
      <view class="popup-header">
        <view>
          <text class="popup-title">选择对话</text>
          <text class="popup-subtitle">按文件夹分组显示电脑端已同步的对话</text>
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

    <scroll-view class="messages" scroll-y :scroll-into-view="scrollTarget" upper-threshold="80" @scrolltoupper="loadOlderHistory">
      <view v-if="switchingThread" class="switch-loading">
        <view class="switch-loading-spinner"></view>
        <text class="switch-loading-title">正在载入对话</text>
        <text class="switch-loading-subtitle">{{ selectedThreadName || '请稍候' }}</text>
      </view>

      <view v-if="loadingOlderHistory" class="history-loading">正在加载更早对话...</view>
      <view v-else-if="hasOlderHistory" class="history-load-more" @click="loadOlderHistory">上滑加载更早 5 轮对话</view>

      <view v-for="item in timelineItems" :key="item.key">
        <view
          v-if="item.type === 'message'"
          class="message"
          :class="item.row.role === 'user' ? 'message-user' : 'message-assistant'"
        >
          <rich-text class="markdown" :nodes="renderMarkdown(item.row.text || '')" />
        </view>

        <view v-else-if="item.type === 'process'" class="process-card">
          <view class="process-title" @click="toggleProcess(item.turn)">
            <text>{{ processTitle(item.turn, isProcessOpen(item.turn)) }}</text>
            <text class="process-action">{{ isProcessOpen(item.turn) ? '收起' : '展开' }}</text>
          </view>
          <view v-if="isProcessOpen(item.turn)" class="process-body">
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
      <button class="send-button" :disabled="!canSend" @click="send">发送</button>
      <button class="stop-button" :disabled="!canStop" @click="stop">停止</button>
    </view>
  </view>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { onBackPress, onHide, onShow, onUnload } from '@dcloudio/uni-app';
import { createRealtimeSocket, getHealth, getHistory, getStatus, getThreads, sendMessage, stopCodex } from '../../utils/api';
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
const serverState = ref({ online: false, offline: false, message: '服务器检测中' });
const agentState = ref({ online: false, offline: false, message: 'Agent 检测中' });
const syncState = ref({ fresh: false, version: 0, lastSyncedAt: '' });
const appServerState = ref({ state: 'unknown', updatedAt: '' });
const realtimeThreadStates = ref({});
const currentThreadStatus = ref(null);
const historyNextBefore = ref('');
const hasOlderHistory = ref(false);
const loadingOlderHistory = ref(false);
const pendingWatch = ref(null);
const pendingLocalSends = ref([]);
const historyReloadedForCompletion = ref(false);
const followBottom = ref(false);
const manualProcessOpenState = ref({});
const loading = ref(false);
const sending = ref(false);
const switchingThread = ref(false);
const threadPopupOpen = ref(false);
const scrollTarget = ref('');
const AUTO_REFRESH_INTERVAL_MS = 4000;
let threadListRequest = null;
let switchRequestSeq = 0;
let realtimeSocket = null;
let realtimeReconnectTimer = null;
let realtimeRefreshTimer = null;
let automaticRefreshTimer = null;
let commandConfirmTimer = null;
let mountedOnce = false;
let pageActive = false;
let timersStarted = false;
let lifecycleToken = 0;
let requestTasks = [];
let runningHistoryRequest = null;
let runningHistorySyncAt = 0;
let runningHistoryThreadId = '';
let clientMessageSequence = 0;

/**
 * AI:为一次用户提交生成跨层复用的幂等标识。
 *
 * @returns {string} 客户端用户消息标识。
 */
function createClientUserMessageId() {
  clientMessageSequence += 1;
  return `mobile-${Date.now().toString(36)}-${clientMessageSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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
const processTurns = computed(() => normalizeProcessTurns(currentThreadStatus.value));
const selectedRealtimeState = computed(() => realtimeThreadStates.value[selectedThreadId.value] || null);
const running = computed(() => {
  if (selectedRealtimeState.value) return agentState.value.online && selectedRealtimeState.value.status === 'running';
  const status = (currentThreadStatus.value && currentThreadStatus.value.status) || (selectedThread.value && selectedThread.value.status);
  const activeStatus = Boolean(currentThreadStatus.value && currentThreadStatus.value.active) || Boolean(selectedThread.value && selectedThread.value.active);
  return agentState.value.online && syncState.value.fresh && (activeStatus || status === 'running');
});
const complete = computed(() => {
  if (selectedRealtimeState.value) return selectedRealtimeState.value.status === 'complete';
  const currentStatus = currentThreadStatus.value && currentThreadStatus.value.status;
  const selectedStatus = selectedThread.value && selectedThread.value.status;
  return !running.value && (currentStatus === 'complete' || selectedStatus === 'complete');
});
const canStop = computed(() => running.value && !sending.value && !switchingThread.value && !(pendingWatch.value && pendingWatch.value.threadId === selectedThreadId.value));
const canSend = computed(() => {
  const status = (selectedRealtimeState.value && selectedRealtimeState.value.status) || (currentThreadStatus.value && currentThreadStatus.value.status) || (selectedThread.value && selectedThread.value.status) || '';
  const active = selectedRealtimeState.value ? selectedRealtimeState.value.active : Boolean(currentThreadStatus.value && currentThreadStatus.value.active) || Boolean(selectedThread.value && selectedThread.value.active);
  const waitingForDesktop = Boolean(pendingWatch.value && pendingWatch.value.threadId === selectedThreadId.value);
  return Boolean(selectedThreadId.value && !sending.value && !switchingThread.value && !waitingForDesktop && !active && status !== 'running');
});
const serverDotClass = computed(() => serverState.value.online ? 'dot-green' : serverState.value.offline ? 'dot-red' : 'dot-gray');
const agentDotClass = computed(() => agentState.value.online ? 'dot-green' : 'dot-gray');
const threadDotClass = computed(() => running.value ? 'dot-blue' : complete.value ? 'dot-green' : 'dot-gray');
const serverText = computed(() => serverState.value.online ? '服务器已连' : serverState.value.message || '服务器未知');
const agentText = computed(() => {
  if (!agentState.value.online) return agentState.value.message || 'Agent 未知';
  if (appServerState.value.state === 'unavailable' || appServerState.value.state === 'stopped') return '会话服务异常';
  if (appServerState.value.state === 'starting') return '会话服务启动中';
  return 'Agent 在线';
});
const threadText = computed(() => {
  if (pendingWatch.value && pendingWatch.value.threadId === selectedThreadId.value) {
    return pendingWatch.value.unconfirmed ? '发送未确认' : '等待电脑确认';
  }
  if (selectedRealtimeState.value) return running.value ? '对话进行中' : complete.value ? '对话已完成' : '对话空闲';
  if (!syncState.value.fresh && agentState.value.online) return '状态未确认';
  return running.value ? '对话进行中' : complete.value ? '对话已完成' : '对话空闲';
});
const timelineItems = computed(() => {
  const items = [];
  const pendingTurns = [];
  const turnsById = {};
  const renderedProcessTurnIds = {};
  for (const turn of processTurns.value) {
    pendingTurns.push(turn);
    turnsById[turn.turnId] = turn;
  }
  for (let index = 0; index < messages.value.length; index += 1) {
    const row = messages.value[index];
    const userTurn = row && row.role === 'user' && row.turnId ? turnsById[row.turnId] : null;
    if (userTurn && !renderedProcessTurnIds[userTurn.turnId]) {
      items.push({ type: 'message', key: row.id || `message-${row.role}-${index}`, row });
      items.push({ type: 'process', key: `process-${userTurn.turnId}`, turn: userTurn });
      renderedProcessTurnIds[userTurn.turnId] = true;
      const pendingIndex = pendingTurns.findIndex(turn => turn.turnId === userTurn.turnId);
      if (pendingIndex !== -1) pendingTurns.splice(pendingIndex, 1);
      continue;
    }
    const exactTurn = row && row.role === 'assistant' && row.turnId ? turnsById[row.turnId] : null;
    if (exactTurn && !renderedProcessTurnIds[exactTurn.turnId]) {
      items.push({ type: 'process', key: `process-${exactTurn.turnId}`, turn: exactTurn });
      renderedProcessTurnIds[exactTurn.turnId] = true;
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
    if (shouldAppendUnmatchedProcess(turn)) items.push({ type: 'process', key: `process-${turn.turnId}`, turn });
  }
  return items;
});

/**
 * AI:判断手机端是否已经填写云端地址和 Token。
 *
 * @returns {boolean} 已配置返回 true。
 */
function hasConnectionConfig() {
  return Boolean(config.value && config.value.serverUrl && config.value.token);
}

/**
 * AI:缺少连接配置时阻止请求空地址。
 *
 * @returns {void}
 */
function markConfigMissing() {
  serverState.value = { online: false, offline: false, message: '请配置服务器' };
  agentState.value = { online: false, offline: false, message: 'Agent 未连接' };
  currentThreadStatus.value = null;
  threadRows.value = [];
  setNotice('请先在设置中填写服务器地址和 Token。');
}

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
function formatElapsedTime(startedAt, completedAt, observedAt = '') {
  const start = Date.parse(startedAt || '');
  if (Number.isNaN(start)) return '';
  const end = Date.parse(completedAt || observedAt || '') || Date.now();
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
  const interrupted = turn && turn.status === 'interrupted';
  const statusText = interrupted ? ` · ${turn.interruptionReason || '状态未确认'}` : '';
  const duration = turn && turn.durationText ? ` · ${turn.durationText}` : '';
  if (interrupted) return `${prefix}${statusText}${duration}（${count}）`;
  return `${prefix}${duration}（${count}）`;
}

/**
 * AI:判断没有匹配到最终回复的处理过程是否允许临时追加到底部。
 *
 * @param {object} turn 处理过程轮次。
 * @returns {boolean} 只有当前运行轮次允许追加。
 */
function shouldAppendUnmatchedProcess(turn) {
  return false;
}

/**
 * AI:筛出手机端可展示的处理过程步骤。
 *
 * @param {object} turn Codex 轮次数据。
 * @returns {Array<object>} 可展示步骤。
 */
function visibleProcessSteps(turn) {
  return ((turn && turn.steps) || []).filter(step => step && step.text && step.kind !== 'start' && step.kind !== 'final' && step.kind !== 'complete');
}

/**
 * AI:生成处理过程展开状态键，避免旧轮次的手动状态串到新轮次。
 *
 * @param {object} turn Codex 轮次数据。
 * @param {Array<object>} steps 可展示步骤。
 * @returns {string} 展开状态键。
 */
function processStateKey(turn, steps) {
  const turnId = String((turn && turn.turnId) || '').trim();
  const startedAt = String((turn && turn.startedAt) || '').trim();
  const firstStep = steps && steps[0] ? steps[0] : null;
  const firstStepTime = String((firstStep && firstStep.time) || '').trim();
  return `${turnId}\u0000${startedAt}\u0000${firstStepTime}`;
}

/**
 * AI:规范化处理过程轮次，默认只生成折叠状态所需的数据。
 *
 * @param {object|null} status 状态数据。
 * @returns {Array<object>} 可展示处理过程轮次。
 */
function normalizeProcessTurns(status) {
  return ((status && status.turns) || [])
    .map(turn => {
      const steps = visibleProcessSteps(turn);
      const interrupted = Boolean(turn && turn.status === 'running' && (!agentState.value.online || !syncState.value.fresh));
      return {
        turnId: turn && turn.turnId ? turn.turnId : '',
        processKey: processStateKey(turn, steps),
        status: interrupted ? 'interrupted' : turn && turn.status ? turn.status : '',
        interruptionReason: !agentState.value.online ? 'Agent 未在线' : '状态未确认',
        steps,
        final: turn && turn.final ? turn.final : '',
        durationText: formatElapsedTime(turn && turn.startedAt, turn && turn.completedAt, interrupted ? syncState.value.lastSyncedAt : ''),
      };
    })
    .filter(turn => turn.turnId && turn.steps.length);
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
  switchRequestSeq += 1;
  switchingThread.value = false;
  threadListRequest = null;
  runningHistoryRequest = null;
  if (commandConfirmTimer) clearTimeout(commandConfirmTimer);
  commandConfirmTimer = null;
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
 * AI:判断处理过程是否由用户手动展开。
 *
 * @param {object} turn 处理过程轮次。
 * @returns {boolean} 已手动展开时返回 true。
 */
function isProcessOpen(turn) {
  return Boolean(turn && manualProcessOpenState.value[turn.processKey]);
}

/**
 * AI:切换指定轮次的处理过程手动展开状态。
 *
 * @param {object} turn 处理过程轮次。
 * @returns {void}
 */
function toggleProcess(turn) {
  if (!turn || !turn.processKey) return;
  manualProcessOpenState.value = Object.assign({}, manualProcessOpenState.value, {
    [turn.processKey]: !manualProcessOpenState.value[turn.processKey],
  });
}

/**
 * AI:同步用户手动展开的处理过程状态，新轮次始终默认折叠。
 *
 * @param {object} status 状态数据。
 * @returns {void}
 */
function syncManualProcessOpenState(status) {
  const next = {};
  const turns = normalizeProcessTurns(status);
  for (const turn of turns) {
    if (manualProcessOpenState.value[turn.processKey] === true) next[turn.processKey] = true;
  }
  manualProcessOpenState.value = next;
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
  bindPendingLocalSendTurn(runningTurn.turnId);
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
 * AI:记录手机端已发送但尚未被电脑端历史确认的消息。
 *
 * @param {string} threadId Codex 线程 ID。
 * @param {string} text 用户发送的文本。
 * @param {number} sentAt 本地发送时间戳。
 * @param {number} baseMessageCount 发送前已确认的历史消息数量。
 * @returns {object} 本地待确认消息记录。
 */
function registerPendingLocalSend(threadId, text, sentAt, baseMessageCount) {
  const row = {
    threadId,
    text,
    userId: `local-user-${sentAt}`,
    assistantId: `local-assistant-${sentAt}`,
    baseMessageCount,
    turnId: '',
  };
  pendingLocalSends.value = pendingLocalSends.value.concat([row]);
  return row;
}

/**
 * AI:发送失败后移除本地待确认记录，避免后续历史刷新重复插入未送达消息。
 *
 * @param {object} pending 本地待确认消息记录。
 * @returns {void}
 */
function removePendingLocalSend(pending) {
  const rows = [];
  for (const row of pendingLocalSends.value) {
    if (row !== pending) rows.push(row);
  }
  pendingLocalSends.value = rows;
}

/**
 * AI:把最新运行轮次绑定到本地待确认回复占位，保证处理过程插在用户消息之后。
 *
 * @param {string} turnId Codex 轮次 ID。
 * @returns {void}
 */
function bindPendingLocalSendTurn(turnId) {
  if (!turnId) return;
  const rows = pendingLocalSends.value.slice();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (!rows[index].turnId && rows[index].threadId === selectedThreadId.value) {
      rows[index] = Object.assign({}, rows[index], { turnId });
      pendingLocalSends.value = rows;
      return;
    }
  }
}

/**
 * AI:判断历史中是否已经出现指定角色和文本的消息。
 *
 * @param {Array<object>} rows 历史消息。
 * @param {string} role 消息角色。
 * @param {string} text 消息文本。
 * @param {number} startIndex 起始检查位置。
 * @returns {boolean} 已出现返回 true。
 */
function hasHistoryMessage(rows, role, text, startIndex = 0) {
  for (let index = Math.max(0, Number(startIndex) || 0); index < (rows || []).length; index += 1) {
    const row = rows[index];
    if (row && row.role === role && String(row.text || '') === text) return true;
  }
  return false;
}

/**
 * AI:判断待确认消息之后是否已经有电脑端回复，避免继续显示等待占位。
 *
 * @param {Array<object>} rows 历史消息。
 * @param {object} pending 本地待确认消息。
 * @returns {boolean} 已有新回复返回 true。
 */
function hasAssistantAfterPendingBase(rows, pending) {
  const start = Math.max(0, Number(pending && pending.baseMessageCount) || 0);
  for (let index = start; index < (rows || []).length; index += 1) {
    const row = rows[index];
    if (row && row.role === 'assistant') return true;
  }
  return false;
}

/**
 * AI:合并电脑端历史和手机端待确认消息，避免缓存刷新覆盖刚发送的用户消息。
 *
 * @param {string} threadId Codex 线程 ID。
 * @param {Array<object>} historyRows 电脑端历史消息。
 * @returns {Array<object>} 可展示消息列表。
 */
function mergePendingLocalMessages(threadId, historyRows) {
  const rows = (historyRows || []).slice();
  const nextPending = [];
  let insertedCount = 0;
  for (const pending of pendingLocalSends.value) {
    if (!pending || pending.threadId !== threadId) {
      nextPending.push(pending);
      continue;
    }
    if (hasHistoryMessage(rows, 'user', pending.text, pending.baseMessageCount)) continue;
    nextPending.push(pending);
    const localRows = [];
    localRows.push({ role: 'user', text: pending.text, pending: true, id: pending.userId });
    if (!hasAssistantAfterPendingBase(rows, pending)) {
      const assistant = { role: 'assistant', text: '已发送，等待 Codex 回复...', pending: true, id: pending.assistantId };
      if (pending.turnId) assistant.turnId = pending.turnId;
      localRows.push(assistant);
    }
    const insertAt = Math.min(rows.length, Math.max(0, (Number(pending.baseMessageCount) || 0) + insertedCount));
    for (let localIndex = 0; localIndex < localRows.length; localIndex += 1) {
      rows.splice(insertAt + localIndex, 0, localRows[localIndex]);
    }
    insertedCount += localRows.length;
  }
  pendingLocalSends.value = nextPending;
  return rows;
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
  if (!hasConnectionConfig()) {
    markConfigMissing();
    return;
  }
  try {
    const data = await getHealth(config.value, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token)) return;
    serverState.value = { online: true, offline: false, message: '服务器已连' };
    applyRelayState(Object.assign({}, data, { agentOnline: Boolean(data.online) }));
  } catch (error) {
    if (!canUpdateTask(token)) return;
    serverState.value = { online: false, offline: true, message: '服务器断开' };
    agentState.value = { online: false, offline: true, message: 'Agent 未知' };
    setNotice(error.message);
  }
}

/**
 * AI:使用服务端响应里的 Agent 在线状态更新连接指示，避免缓存接口成功被误判为在线。
 *
 * @param {object} data 接口响应。
 * @returns {void}
 */
function applyAgentOnline(data) {
  if (!data || typeof data.agentOnline !== 'boolean') return;
  serverState.value = { online: true, offline: false, message: '服务器已连' };
  agentState.value = {
    online: data.agentOnline,
    offline: !data.agentOnline,
    message: data.agentOnline ? 'Agent 在线' : 'Agent 未在线',
  };
}

/**
 * AI:合并已加载的历史页与服务器最新页，实时刷新不能丢弃向上翻出的旧消息。
 *
 * @param {Array<object>} existingRows 当前已展示消息。
 * @param {Array<object>} latestRows 服务器返回的最新一页消息。
 * @returns {Array<object>} 时间顺序稳定且去重后的历史消息。
 */
function mergeLoadedHistory(existingRows, latestRows) {
  const rows = [];
  const seen = {};
  const currentRows = (existingRows || []).filter(item => !(item && item.pending));
  const combinedRows = currentRows.concat(latestRows || []);
  for (const row of combinedRows) {
    if (!row || !row.text) continue;
    const key = [row.role || '', row.turnId || '', row.timestamp || '', row.text || ''].join('\u0000');
    if (Object.prototype.hasOwnProperty.call(seen, key)) continue;
    seen[key] = true;
    rows.push(row);
  }
  return rows;
}

/**
 * AI:应用 Relay 的版本化同步状态，拒绝旧快照回写页面。
 *
 * @param {object} data Relay 响应或实时事件。
 * @returns {boolean} 快照是否可用于更新页面。
 */
function applyRelayState(data) {
  if (!data || typeof data !== 'object') return true;
  const nextVersion = Number(data.syncVersion);
  if (Number.isFinite(nextVersion) && nextVersion < syncState.value.version) return false;
  if (Number.isFinite(nextVersion)) syncState.value = {
    fresh: Boolean(data.syncFresh),
    version: nextVersion,
    lastSyncedAt: typeof data.lastSyncedAt === 'string' ? data.lastSyncedAt : syncState.value.lastSyncedAt,
  };
  if (typeof data.appServerState === 'string') appServerState.value = {
    state: data.appServerState,
    updatedAt: typeof data.appServerUpdatedAt === 'string' ? data.appServerUpdatedAt : appServerState.value.updatedAt,
  };
  applyAgentOnline(data);
  if (!syncState.value.fresh && pendingWatch.value && (data.type === 'sync-status' || data.agentOnline === false)) {
    pendingWatch.value = Object.assign({}, pendingWatch.value, { unconfirmed: true });
    if (commandConfirmTimer) clearTimeout(commandConfirmTimer);
    commandConfirmTimer = null;
    setNotice('电脑同步超时，发送结果未确认，已停止继续发送。');
  }
  return true;
}

/**
 * AI:等待命令对应的新快照确认，超时后收敛为未确认而非无限运行。
 *
 * @param {object} watch 命令观察窗口。
 * @returns {void}
 */
function waitForCommandConfirmation(watch) {
  if (commandConfirmTimer) clearTimeout(commandConfirmTimer);
  commandConfirmTimer = setTimeout(() => {
    if (!pendingWatch.value || pendingWatch.value.threadId !== watch.threadId) return;
    pendingWatch.value = Object.assign({}, pendingWatch.value, { unconfirmed: true });
    setNotice('电脑尚未确认本次操作，已停止继续发送；请刷新后核对。');
  }, 12000);
}

/**
 * AI:读取当前打开的对话列表，并复用进行中的同类请求。
 *
 * @returns {Promise<Array<object>>} 对话列表。
 */
async function fetchThreadRows() {
  const token = currentLifecycleToken();
  if (!canUpdateTask(token)) return threadRows.value;
  if (!hasConnectionConfig()) {
    markConfigMissing();
    return threadRows.value;
  }
  if (threadListRequest) return threadListRequest;
  const request = (async () => {
    const data = await getThreads(config.value, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token)) return threadRows.value;
    if (!applyRelayState(data)) return threadRows.value;
    return data.threads || [];
  })();
  threadListRequest = request;
  try {
    return await request;
  } catch (error) {
    if (!canUpdateTask(token)) return threadRows.value;
    serverState.value = { online: false, offline: true, message: '服务器断开' };
    agentState.value = { online: false, offline: true, message: 'Agent 未知' };
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
 * @returns {void}
 */
function applyThreadStatus(status) {
  if (!applyRelayState(status)) return false;
  reconcileRealtimeThreadState(status);
  currentThreadStatus.value = status;
  bindPendingAssistantTurn(status);
  syncManualProcessOpenState(status);
  const commandConfirmed = isCommandConfirmed(status, pendingWatch.value);
  if (commandConfirmed) {
    pendingWatch.value = null;
    if (commandConfirmTimer) clearTimeout(commandConfirmTimer);
    commandConfirmTimer = null;
  }
  return true;
}

/**
 * AI:只有权威状态包含同一回合且状态一致时才移除实时覆盖，避免旧快照造成闪烁。
 *
 * @param {object} status HTTP 返回的线程状态。
 * @returns {void}
 */
function reconcileRealtimeThreadState(status) {
  const threadId = String(status && status.threadId || '').trim();
  const realtime = realtimeThreadStates.value[threadId];
  if (!realtime) return;
  const authoritativeStatus = status.active || status.status === 'running' ? 'running' : status.status;
  const turns = Array.isArray(status.turns) ? status.turns : [];
  const turnConfirmed = !realtime.turnId || turns.some(turn => turn && turn.turnId === realtime.turnId);
  if (!turnConfirmed || authoritativeStatus !== realtime.status) return;
  const next = Object.assign({}, realtimeThreadStates.value);
  delete next[threadId];
  realtimeThreadStates.value = next;
}

/**
 * AI:只用目标 App Server 回合证据确认发送，停止命令继续使用新同步后的空闲状态确认。
 *
 * @param {object} status 当前线程状态。
 * @param {object|null} watch 待确认控制窗口。
 * @returns {boolean} 控制命令已被目标线程同步确认时返回 true。
 */
function isCommandConfirmed(status, watch) {
  if (!watch || watch.threadId !== status.threadId || !syncState.value.fresh) return false;
  const stateConfirmed = status.active || status.status === 'running' || status.status === 'complete' || status.status === 'error';
  if (watch.kind === 'send') {
    const confirmedTurnIds = Array.isArray(status.confirmedControlTurnIds) ? status.confirmedControlTurnIds : [];
    return Boolean(watch.turnId && confirmedTurnIds.indexOf(watch.turnId) !== -1 && stateConfirmed);
  }
  return Boolean(
    watch.kind === 'stop'
    && Number(status.syncVersion) > Number(watch.acceptedSyncVersion)
    && !status.active
    && status.status !== 'running'
  );
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
  const requestedThreadId = options.threadId || selectedThreadId.value;
  if (!requestedThreadId) {
    messages.value = [];
    historyNextBefore.value = '';
    hasOlderHistory.value = false;
    currentThreadStatus.value = null;
    manualProcessOpenState.value = {};
    setNotice('没有可用 Codex 对话');
    return;
  }
  const data = await getHistory(config.value, requestedThreadId, { limit: 5, registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
  if (!canUpdateTask(token) || selectedThreadId.value !== requestedThreadId) return;
  if (!applyRelayState(data)) return;
  messages.value = mergePendingLocalMessages(requestedThreadId, mergeLoadedHistory(messages.value, data.messages || []));
  historyNextBefore.value = data.nextBefore || '';
  hasOlderHistory.value = Boolean(data.hasMore && historyNextBefore.value);
  if (data.available) {
    const snapshot = statusData || await getStatus(config.value, { threadId: requestedThreadId }, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token) || selectedThreadId.value !== requestedThreadId) return;
    if (!applyThreadStatus(snapshot)) return;
  }
  if (!options.silent) setNotice(data.available ? '已同步电脑端 Codex 对话' : '这个对话暂时没有可加载的本机记录');
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
    if (sending.value || pendingWatch.value) return;
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
  const requestSeq = switchRequestSeq + 1;
  switchRequestSeq = requestSeq;
  selectedProjectName.value = projectName || '';
  selectedThreadId.value = thread ? thread.id : '';
  threadPopupOpen.value = false;
  switchingThread.value = true;
  messages.value = [];
  currentThreadStatus.value = null;
  pendingWatch.value = null;
  historyReloadedForCompletion.value = false;
  runningHistoryRequest = null;
  runningHistorySyncAt = 0;
  runningHistoryThreadId = '';
  manualProcessOpenState.value = {};
  persistSelection();
  setNotice('正在载入对话...');
  try {
    await loadThreads();
    if (!canUpdateTask(token) || switchRequestSeq !== requestSeq) return;
    const refreshedThread = threadRows.value.find(row => row.id === selectedThreadId.value);
    if (refreshedThread) {
      selectedProjectName.value = refreshedThread.projectName || '未命名文件夹';
      persistSelection();
    }
    await loadHistory(null, { scrollToBottom: true, threadId: selectedThreadId.value });
  } catch (error) {
    if (canUpdateTask(token) && switchRequestSeq === requestSeq) setNotice(error.message);
  } finally {
    if (canUpdateTask(token) && switchRequestSeq === requestSeq) switchingThread.value = false;
  }
}

/**
 * AI:电脑端直接发送消息时，运行中也补拉历史，避免用户消息等到最终回复后才出现。
 *
 * @param {object} statusData 当前轮询到的运行状态。
 * @returns {Promise<void>} 历史同步完成。
 */
async function syncRunningHistory(statusData) {
  const requestedThreadId = selectedThreadId.value;
  if (!requestedThreadId || sending.value || pendingWatch.value) return false;
  if (!statusData || (!statusData.active && statusData.status !== 'running')) return false;
  if (runningHistoryRequest) {
    await runningHistoryRequest;
    return true;
  }
  const now = Date.now();
  if (runningHistoryThreadId === requestedThreadId && now - runningHistorySyncAt < 1500) return false;
  runningHistoryThreadId = requestedThreadId;
  runningHistorySyncAt = now;
  runningHistoryRequest = loadHistory(statusData, { scrollToBottom: false, silent: true });
  try {
    await runningHistoryRequest;
    return true;
  } finally {
    runningHistoryRequest = null;
  }
}

/**
 * AI:返回对话在侧边列表中的状态点样式。
 *
 * @param {object} thread 对话对象。
 * @returns {string} 状态样式类名。
 */
function threadDotClassFor(thread) {
  const realtime = thread && realtimeThreadStates.value[thread.id];
  if (realtime) return realtime.status === 'running' ? 'dot-blue' : realtime.status === 'error' ? 'dot-red' : 'dot-green';
  const isSelected = thread && thread.id === selectedThreadId.value;
  const status = isSelected && currentThreadStatus.value
    ? currentThreadStatus.value.status
    : thread && thread.status;
  const active = isSelected && currentThreadStatus.value
    ? Boolean(currentThreadStatus.value.active)
    : Boolean(thread && thread.active);
  if (!agentState.value.online) return 'dot-gray';
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
  const waitingForDesktop = pendingWatch.value && pendingWatch.value.threadId === data.threadId;
  const commandConfirmed = waitingForDesktop && isCommandConfirmed(data, pendingWatch.value);
  if ((data.status === 'complete' || data.status === 'error') && waitingForDesktop && !commandConfirmed) {
    if (!applyThreadStatus(data)) return;
    setNotice('正在等待电脑确认本次发送...');
    return;
  }
  if (data.status === 'complete' || data.status === 'error') {
    if (!applyThreadStatus(data)) return;
    const shouldScroll = followBottom.value;
    if (pendingWatch.value && pendingWatch.value.threadId === data.threadId) pendingWatch.value = null;
    if (commandConfirmTimer) clearTimeout(commandConfirmTimer);
    commandConfirmTimer = null;
    followBottom.value = false;
    if (!historyReloadedForCompletion.value) {
      historyReloadedForCompletion.value = true;
      await loadHistory(data, { scrollToBottom: shouldScroll });
    }
    return;
  }
  const historySynced = await syncRunningHistory(data);
  if (!historySynced && !applyThreadStatus(data)) return;
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
  if (!canSend.value) {
    setNotice('当前对话尚未完成或发送结果未确认，不能继续发送。');
    return;
  }
  messageText.value = '';
  sending.value = true;
  followBottom.value = true;
  historyReloadedForCompletion.value = false;
  try {
    const clientUserMessageId = createClientUserMessageId();
    const baseMessageCount = messages.value.length;
    const data = await sendMessage(config.value, {
      threadId: selectedThreadId.value,
      text,
      clientUserMessageId,
    }, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token)) return;
    const sentAt = Date.now();
    const pending = registerPendingLocalSend(selectedThreadId.value, text, sentAt, baseMessageCount);
    pendingWatch.value = Object.assign({}, data.watch || { threadId: selectedThreadId.value }, {
      kind: 'send',
      acceptedSyncVersion: Number(data.acceptedSyncVersion) || syncState.value.version,
    });
    messages.value = mergePendingLocalMessages(selectedThreadId.value, messages.value);
    await scrollToBottom();
    waitForCommandConfirmation(pendingWatch.value);
    await pollStatus(pendingWatch.value);
  } catch (error) {
    if (canUpdateTask(token) && !messageText.value) messageText.value = text;
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
    const data = await stopCodex(config.value, selectedThreadId.value, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token)) return;
    pendingWatch.value = {
      threadId: selectedThreadId.value,
      kind: 'stop',
      acceptedSyncVersion: Number(data.acceptedSyncVersion) || syncState.value.version,
    };
    waitForCommandConfirmation(pendingWatch.value);
    setNotice(data.message || '已发送停止指令，等待电脑确认');
    await pollStatus(pendingWatch.value);
  } catch (error) {
    setNotice(error.message);
  }
}

/**
 * AI:处理实时通道事件后的缓存刷新，合并短时间内连续到达的同步事件。
 *
 * @returns {void}
 */
function scheduleRealtimeRefresh() {
  if (realtimeRefreshTimer || !canUpdatePage()) return;
  realtimeRefreshTimer = setTimeout(async () => {
    realtimeRefreshTimer = null;
    if (switchingThread.value || loading.value) {
      scheduleRealtimeRefresh();
      return;
    }
    try {
      await loadThreads();
      if (selectedThreadId.value) await loadHistory(null, { scrollToBottom: followBottom.value, silent: true });
    } catch (error) {
      setNotice(error.message);
    }
  }, 180);
}

/**
 * AI:前台定时核对当前线程，修复实时事件丢失后页面长期停在旧快照的问题。
 *
 * @returns {Promise<void>}
 */
async function refreshCurrentThreadAutomatically() {
  if (!canUpdatePage()) return;
  try {
    if (!switchingThread.value && !loading.value && !sending.value) {
      await loadThreads();
      if (selectedThreadId.value) await loadHistory(null, { scrollToBottom: followBottom.value, silent: true });
    }
  } catch (error) {
    setNotice(error.message);
  } finally {
    scheduleAutomaticRefresh();
  }
}

/**
 * AI:安排一次前台状态核对，始终由前一轮完成后再开始计时。
 *
 * @returns {void}
 */
function scheduleAutomaticRefresh() {
  if (automaticRefreshTimer || !canUpdatePage()) return;
  automaticRefreshTimer = setTimeout(() => {
    automaticRefreshTimer = null;
    refreshCurrentThreadAutomatically();
  }, AUTO_REFRESH_INTERVAL_MS);
}

/**
 * AI:向上追加当前对话的更早消息，每次固定读取五轮。
 *
 * @returns {Promise<void>}
 */
async function loadOlderHistory() {
  const token = currentLifecycleToken();
  const requestedThreadId = selectedThreadId.value;
  if (!requestedThreadId || !hasOlderHistory.value || loadingOlderHistory.value) return;
  loadingOlderHistory.value = true;
  try {
    const data = await getHistory(config.value, requestedThreadId, { limit: 5, before: historyNextBefore.value, registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!canUpdateTask(token) || requestedThreadId !== selectedThreadId.value) return;
    if (!applyRelayState(data)) return;
    messages.value = mergePendingLocalMessages(requestedThreadId, mergeLoadedHistory(data.messages || [], messages.value));
    historyNextBefore.value = data.nextBefore || '';
    hasOlderHistory.value = Boolean(data.hasMore && historyNextBefore.value);
  } catch (error) {
    if (canUpdateTask(token)) setNotice(error.message);
  } finally {
    if (canUpdateTask(token)) loadingOlderHistory.value = false;
  }
}

/**
 * AI:安排实时通道重连，不降级为 HTTP 轮询。
 *
 * @returns {void}
 */
function scheduleRealtimeReconnect() {
  if (!canUpdatePage() || realtimeReconnectTimer) return;
  realtimeReconnectTimer = setTimeout(() => {
    realtimeReconnectTimer = null;
    openRealtimeSocket();
  }, 2000);
}

/**
 * AI:把 App Server 线程事件转换为短生命周期状态覆盖，随后由 HTTP 权威数据对账。
 *
 * @param {object} event Relay 的 thread-event 消息。
 * @returns {void}
 */
function applyRealtimeThreadEvent(event) {
  const payload = event && event.event;
  const threadId = String(payload && payload.threadId || '').trim();
  if (!threadId) return;
  const previous = realtimeThreadStates.value[threadId];
  const seq = Number(payload.seq) || 0;
  if (previous && seq <= previous.seq) return;
  let status = '';
  let active = false;
  if (payload.type === 'turn.started') {
    status = 'running';
    active = true;
  } else if (payload.type === 'turn.completed') {
    const turnStatus = String(payload.payload && payload.payload.turn && payload.payload.turn.status || '').toLowerCase();
    status = turnStatus === 'failed' ? 'error' : 'complete';
  } else if (payload.type === 'thread.status.changed') {
    const protocolStatus = String(payload.payload && payload.payload.status && payload.payload.status.type || '').toLowerCase();
    if (protocolStatus === 'active') {
      status = 'running';
      active = true;
    } else if (protocolStatus === 'idle') status = 'complete';
    else if (protocolStatus === 'systemerror') status = 'error';
  }
  if (!status) return;
  const realtime = {
    threadId,
    turnId: String(payload.turnId || '').trim(),
    status,
    active,
    seq,
    observedAt: String(payload.observedAt || ''),
  };
  realtimeThreadStates.value = Object.assign({}, realtimeThreadStates.value, { [threadId]: realtime });
  threadRows.value = threadRows.value.map(row => row.id === threadId ? Object.assign({}, row, { status, active }) : row);
}

/**
 * AI:处理服务端实时状态事件。
 *
 * @param {object} event Relay 推送的事件。
 * @returns {void}
 */
function handleRealtimeEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (!applyRelayState(event)) return;
  if (event.type === 'thread-event') {
    applyRealtimeThreadEvent(event);
    scheduleRealtimeRefresh();
    return;
  }
  if (event.type === 'event-resync-required') {
    realtimeThreadStates.value = {};
    scheduleRealtimeRefresh();
    return;
  }
  if (event.type === 'session-updated') scheduleRealtimeRefresh();
}

/**
 * AI:建立手机到云端 Relay 的实时状态订阅。
 *
 * @returns {void}
 */
function openRealtimeSocket() {
  if (!canUpdatePage() || !hasConnectionConfig() || realtimeSocket) return;
  realtimeSocket = createRealtimeSocket(config.value, {
    open() {
      if (!canUpdatePage()) return;
      serverState.value = { online: true, offline: false, message: '服务器已连' };
    },
    message(event) {
      try {
        handleRealtimeEvent(JSON.parse(event.data || '{}'));
      } catch (error) {
        setNotice('服务器实时事件格式不正确');
      }
    },
    close() {
      realtimeSocket = null;
      if (!canUpdatePage()) return;
      serverState.value = { online: false, offline: true, message: '服务器实时连接断开' };
      agentState.value = { online: false, offline: true, message: 'Agent 状态未知' };
      scheduleRealtimeReconnect();
    },
    error(event) {
      if (canUpdatePage()) setNotice(event.errMsg || '服务器实时连接失败');
    },
  });
}

/**
 * AI:启动页面实时状态订阅。
 *
 * @returns {void}
 */
function startTimers() {
  if (timersStarted) return;
  timersStarted = true;
  openRealtimeSocket();
  scheduleAutomaticRefresh();
}

/**
 * AI:停止页面实时状态订阅和待执行刷新。
 *
 * @returns {void}
 */
function stopTimers() {
  if (realtimeReconnectTimer) clearTimeout(realtimeReconnectTimer);
  if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
  if (automaticRefreshTimer) clearTimeout(automaticRefreshTimer);
  realtimeReconnectTimer = null;
  realtimeRefreshTimer = null;
  automaticRefreshTimer = null;
  const socket = realtimeSocket;
  realtimeSocket = null;
  if (socket) socket.close({ code: 1000, reason: 'PAGE_INACTIVE' });
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
  const latest = loadConfig();
  if (latest.serverUrl !== config.value.serverUrl || latest.token !== config.value.token) {
    stopTimers();
    config.value = latest;
    refreshConnectionStatus();
    refreshAll({ scrollToBottom: true });
  }
  startTimers();
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
  height: 32px;
}

.status-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  min-width: 0;
  flex: 1;
  gap: 5px;
}

.status-item {
  display: flex;
  align-items: center;
  height: 30px;
  min-width: 0;
  border: 1px solid #dfe3ea;
  border-radius: 6px;
  background: #ffffff;
  padding: 0 6px;
  gap: 4px;
}

.dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
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
  font-size: 11px;
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
  height: 32px;
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
  height: 70vh;
  max-height: 680px;
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

.history-loading,
.history-load-more {
  padding: 8px 12px;
  color: #6b7280;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}

.history-load-more {
  color: #1f6feb;
}

.switch-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 210px;
  margin: 8px 0;
  border: 1px solid #dfe3ea;
  border-radius: 8px;
  background: #ffffff;
}

.switch-loading-spinner {
  width: 26px;
  height: 26px;
  border: 3px solid #d8dde5;
  border-top-color: #1f2937;
  border-radius: 50%;
  animation: switch-loading-spin 0.9s linear infinite;
}

.switch-loading-title {
  margin-top: 12px;
  color: #111827;
  font-size: 15px;
  line-height: 20px;
  font-weight: 700;
}

.switch-loading-subtitle {
  max-width: 260px;
  margin-top: 4px;
  color: #6b7280;
  font-size: 12px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes switch-loading-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
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
