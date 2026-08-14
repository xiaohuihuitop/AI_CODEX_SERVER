<template>
  <view class="settings-page">
    <view class="section-header">
      <view>
        <text class="section-title">设备</text>
        <text class="section-subtitle">每台电脑使用独立 Token</text>
      </view>
      <button class="add-button" :disabled="Boolean(testingDeviceId) || testingForm" @click="beginCreate">添加设备</button>
    </view>

    <view v-if="!devices.length" class="empty-state">暂无设备，点击“添加设备”开始配置。</view>

    <view v-for="device in devices" :key="device.id" class="device-card">
      <view class="device-card-main">
        <view class="dot" :class="connectionDotClass(device)"></view>
        <view class="device-card-copy">
          <view class="device-name-line">
            <text class="device-name">{{ device.name }}</text>
            <text v-if="device.id === activeDeviceId" class="current-label">当前</text>
          </view>
          <text class="device-server">{{ device.serverUrl || '未填写服务器地址' }}</text>
          <text class="device-status">{{ connectionText(device) }}</text>
        </view>
      </view>
      <view class="device-actions">
        <button class="action-button" :disabled="Boolean(testingDeviceId) || testingForm" @click="beginEdit(device)">编辑</button>
        <button class="action-button" :disabled="Boolean(testingDeviceId) || testingForm" @click="testSavedDevice(device)">
          {{ testingDeviceId === device.id ? '检测中' : '测试' }}
        </button>
        <button class="action-button danger-text" :disabled="Boolean(testingDeviceId) || testingForm" @click="confirmRemove(device)">删除</button>
      </view>
    </view>

    <view v-if="formOpen" class="editor">
      <view class="editor-header">
        <text class="editor-title">{{ form.id ? '编辑设备' : '添加设备' }}</text>
        <button class="close-editor" @click="cancelEdit">取消</button>
      </view>
      <view class="field">
        <text class="label">设备名称</text>
        <input v-model="form.name" class="input" maxlength="40" placeholder="例如：办公室电脑" />
      </view>
      <view class="field">
        <text class="label">服务器地址</text>
        <input v-model="form.serverUrl" class="input" placeholder="http://服务器:端口" />
      </view>
      <view class="field">
        <text class="label">Token</text>
        <input v-model="form.token" class="input" password placeholder="请输入 Token" />
      </view>
      <button class="primary" :disabled="saving || testingForm || Boolean(testingDeviceId)" @click="saveForm">{{ saving ? '保存中' : '保存设备' }}</button>
      <button class="secondary" :disabled="testingForm || Boolean(testingDeviceId)" @click="testFormConnection">{{ testingForm ? '检测中' : '测试当前填写' }}</button>
    </view>

    <view class="hint">{{ statusText }}</view>
  </view>
</template>

<script setup>
import { onUnmounted, reactive, ref } from 'vue';
import { onHide, onShow, onUnload } from '@dcloudio/uni-app';
import {
  getActiveDevice,
  listDevices,
  loadDeviceStore,
  loadDraftGuard,
  removeDevice,
  saveDevice,
  saveDeviceConnectionState,
} from '../../utils/config';
import { getHealth } from '../../utils/api';

const devices = ref([]);
const activeDeviceId = ref('');
const formOpen = ref(false);
const saving = ref(false);
const testingForm = ref(false);
const testingDeviceId = ref('');
const statusText = ref('设备配置只保存在本机 App 内。');
const form = reactive({ id: '', name: '', serverUrl: '', token: '' });
let pageActive = true;
let requestTask = null;

function refreshDevices() {
  const store = loadDeviceStore();
  devices.value = store.devices;
  activeDeviceId.value = store.activeDeviceId;
}

function resetForm() {
  form.id = '';
  form.name = '';
  form.serverUrl = '';
  form.token = '';
}

function beginCreate() {
  resetForm();
  formOpen.value = true;
  statusText.value = '填写新电脑的设备名称、服务器地址和 Token。';
}

function beginEdit(device) {
  form.id = device.id;
  form.name = device.name;
  form.serverUrl = device.serverUrl;
  form.token = device.token;
  formOpen.value = true;
  statusText.value = `正在编辑“${device.name}”。`;
}

function cancelEdit() {
  formOpen.value = false;
  resetForm();
  statusText.value = '未保存本次修改。';
}

function normalizedForm() {
  return {
    id: String(form.id || '').trim(),
    name: String(form.name || '').trim(),
    serverUrl: String(form.serverUrl || '').trim().replace(/\/+$/, ''),
    token: String(form.token || '').trim(),
  };
}

function currentDeviceConnectionWouldChange(input) {
  if (!input.id || input.id !== activeDeviceId.value) return false;
  const current = getActiveDevice();
  return Boolean(current && (current.serverUrl !== input.serverUrl || current.token !== input.token));
}

function activeDeviceHasDraft() {
  const guard = loadDraftGuard();
  return guard.deviceId === activeDeviceId.value && guard.hasDraft;
}

function saveForm() {
  saving.value = true;
  try {
    const input = normalizedForm();
    if (currentDeviceConnectionWouldChange(input) && activeDeviceHasDraft()) {
      statusText.value = '请先发送或清空草稿';
      uni.showToast({ title: '请先发送或清空草稿', icon: 'none' });
      return;
    }
    const saved = saveDevice(input);
    refreshDevices();
    formOpen.value = false;
    resetForm();
    statusText.value = `已保存“${saved.name}”。`;
    uni.showToast({ title: '已保存', icon: 'success' });
  } catch (error) {
    statusText.value = error.message;
    uni.showToast({ title: error.message, icon: 'none' });
  } finally {
    saving.value = false;
  }
}

function registerRequestTask(task) {
  if (!task || typeof task.abort !== 'function') return;
  requestTask = task;
}

function unregisterRequestTask(task) {
  if (requestTask === task) requestTask = null;
}

async function testDeviceConnection(device) {
  const data = await getHealth(device, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
  if (!pageActive) return;
  saveDeviceConnectionState(device.id, { online: true, agentOnline: Boolean(data.online) });
  refreshDevices();
  statusText.value = data.online ? `“${device.name}”连接正常，电脑 Agent 在线。` : `“${device.name}”服务器可访问，电脑 Agent 未在线。`;
  uni.showToast({ title: '检测完成', icon: 'success' });
}

async function testSavedDevice(device) {
  if (testingDeviceId.value || testingForm.value) return;
  testingDeviceId.value = device.id;
  try {
    await testDeviceConnection(device);
  } catch (error) {
    if (!pageActive) return;
    saveDeviceConnectionState(device.id, { online: false, agentOnline: false });
    refreshDevices();
    statusText.value = error.message;
    uni.showToast({ title: '连接失败', icon: 'none' });
  } finally {
    if (pageActive) testingDeviceId.value = '';
  }
}

async function testFormConnection() {
  if (testingForm.value || testingDeviceId.value) return;
  testingForm.value = true;
  try {
    const input = normalizedForm();
    if (!input.name || !input.serverUrl || !input.token) throw new Error('请完整填写设备名称、服务器地址和 Token。');
    const data = await getHealth(input, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!pageActive) return;
    statusText.value = data.online ? '当前填写连接正常，电脑 Agent 在线。' : '服务器可访问，电脑 Agent 未在线。';
    uni.showToast({ title: '检测完成', icon: 'success' });
  } catch (error) {
    if (!pageActive) return;
    statusText.value = error.message;
    uni.showToast({ title: '连接失败', icon: 'none' });
  } finally {
    if (pageActive) testingForm.value = false;
  }
}

function confirmRemove(device) {
  if (device.id === activeDeviceId.value && activeDeviceHasDraft()) {
    statusText.value = '请先发送或清空草稿';
    uni.showToast({ title: '请先发送或清空草稿', icon: 'none' });
    return;
  }
  uni.showModal({
    title: '删除设备',
    content: `确认删除“${device.name}”？`,
    confirmText: '删除',
    confirmColor: '#b42318',
    success(result) {
      if (!result.confirm || !pageActive) return;
      try {
        removeDevice(device.id);
        refreshDevices();
        if (form.id === device.id) cancelEdit();
        statusText.value = `已删除“${device.name}”。`;
      } catch (error) {
        statusText.value = error.message;
      }
    },
  });
}

function connectionDotClass(device) {
  const state = device && device.lastConnection;
  if (!state) return 'dot-gray';
  return state.online && state.agentOnline ? 'dot-green' : 'dot-red';
}

function connectionText(device) {
  const state = device && device.lastConnection;
  if (!state) return '未检测';
  if (state.online && state.agentOnline) return '最近在线';
  if (state.online) return '最近 Agent 离线';
  return '最近无法连接';
}

function deactivatePage() {
  pageActive = false;
  testingDeviceId.value = '';
  testingForm.value = false;
  const task = requestTask;
  requestTask = null;
  if (task && typeof task.abort === 'function') {
    try {
      task.abort();
    } catch (error) {
      // AI:页面退出时终止检测请求，不再更新已销毁页面。
    }
  }
}

function activatePage() {
  pageActive = true;
  refreshDevices();
}

refreshDevices();

onHide(() => {
  deactivatePage();
});

onShow(() => {
  activatePage();
});

onUnload(() => {
  deactivatePage();
});

onUnmounted(() => {
  deactivatePage();
});
</script>

<style scoped>
.settings-page {
  min-height: 100vh;
  padding: 18px 16px calc(28px + env(safe-area-inset-bottom));
  background: #f4f5f7;
  color: #111827;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.section-header,
.editor-header,
.device-card-main,
.device-actions,
.device-name-line {
  display: flex;
  align-items: center;
}

.section-header,
.editor-header {
  justify-content: space-between;
}

.section-title,
.section-subtitle,
.device-name,
.device-server,
.device-status {
  display: block;
}

.section-title {
  font-size: 20px;
  line-height: 26px;
  font-weight: 700;
}

.section-subtitle,
.device-server,
.device-status,
.hint {
  color: #6b7280;
  font-size: 12px;
}

.add-button,
.close-editor,
.action-button,
.primary,
.secondary {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  border-radius: 7px;
  padding: 0;
  line-height: 1;
  font-weight: 600;
}

.add-button {
  width: 82px;
  height: 36px;
  border: 0;
  background: #111827;
  color: #ffffff;
  font-size: 13px;
}

.empty-state,
.device-card,
.editor {
  margin-top: 14px;
  border: 1px solid #dfe3ea;
  border-radius: 8px;
  background: #ffffff;
}

.empty-state {
  padding: 20px 14px;
  color: #6b7280;
  font-size: 13px;
  line-height: 20px;
}

.device-card {
  padding: 13px;
}

.device-card-main {
  min-width: 0;
}

.device-card-copy {
  min-width: 0;
  flex: 1;
  margin-left: 10px;
}

.device-name {
  min-width: 0;
  max-width: 75%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  line-height: 20px;
  font-weight: 700;
}

.current-label {
  margin-left: 8px;
  color: #166534;
  font-size: 11px;
  font-weight: 700;
}

.device-server {
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-status {
  margin-top: 3px;
}

.device-actions {
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #eef1f5;
}

.action-button,
.close-editor {
  width: 58px;
  height: 32px;
  border: 1px solid #dfe3ea;
  background: #ffffff;
  color: #374151;
  font-size: 12px;
}

.danger-text {
  color: #b42318;
}

.editor {
  padding: 14px;
}

.editor-title {
  font-size: 16px;
  font-weight: 700;
}

.field {
  margin-top: 14px;
}

.label {
  display: block;
  margin-bottom: 7px;
  color: #4b5563;
  font-size: 12px;
  font-weight: 600;
}

.input {
  box-sizing: border-box;
  width: 100%;
  height: 44px;
  border: 1px solid #dfe3ea;
  border-radius: 7px;
  background: #ffffff;
  padding: 0 11px;
  color: #111827;
  font-size: 14px;
}

.primary,
.secondary {
  width: 100%;
  height: 44px;
  margin-top: 12px;
  font-size: 14px;
}

.primary {
  border: 0;
  background: #111827;
  color: #ffffff;
}

.secondary {
  border: 1px solid #dfe3ea;
  background: #ffffff;
  color: #111827;
}

.hint {
  margin-top: 16px;
  line-height: 18px;
}

.dot {
  width: 9px;
  height: 9px;
  flex: 0 0 9px;
  border-radius: 50%;
  background: #9ca3af;
}

.dot-gray { background: #9ca3af; }
.dot-green { background: #22c55e; }
.dot-red { background: #ef4444; }

button[disabled] { opacity: 0.55; }
</style>
