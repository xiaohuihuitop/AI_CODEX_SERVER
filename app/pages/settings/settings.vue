<template>
  <view class="settings-page">
    <view class="field">
      <text class="label">服务器地址</text>
      <input v-model="form.serverUrl" class="input" placeholder="http://服务器:端口" />
    </view>
    <view class="field">
      <text class="label">Token</text>
      <input v-model="form.token" class="input" password placeholder="请输入 token" />
    </view>
    <button class="primary" :disabled="saving" @click="save">保存</button>
    <button class="secondary" :disabled="testing" @click="testConnection">测试连接</button>
    <view class="hint">{{ statusText }}</view>
  </view>
</template>

<script setup>
import { onUnmounted, reactive, ref } from 'vue';
import { onHide, onShow, onUnload } from '@dcloudio/uni-app';
import { loadConfig, saveConfig } from '../../utils/config';
import { getHealth } from '../../utils/api';

const form = reactive(loadConfig());
const saving = ref(false);
const testing = ref(false);
const statusText = ref('配置会保存在本机 App 内。');
let pageActive = true;
let requestTask = null;

/**
 * AI:登记设置页测试连接请求，页面退出时可取消。
 *
 * @param {object} task uni.request 返回的任务对象。
 * @returns {void}
 */
function registerRequestTask(task) {
  if (!task || typeof task.abort !== 'function') return;
  requestTask = task;
}

/**
 * AI:测试连接请求结束后清理任务引用。
 *
 * @param {object} task uni.request 返回的任务对象。
 * @returns {void}
 */
function unregisterRequestTask(task) {
  if (requestTask === task) requestTask = null;
}

/**
 * AI:设置页退出时取消未完成请求，避免回调写入已销毁页面。
 *
 * @returns {void}
 */
function deactivatePage() {
  pageActive = false;
  const task = requestTask;
  requestTask = null;
  if (task && typeof task.abort === 'function') {
    try {
      task.abort();
    } catch (error) {
      // AI:页面退出时只需要终止请求，不再更新设置页状态。
    }
  }
}

/**
 * AI:设置页重新显示后允许新的测试连接结果更新页面。
 *
 * @returns {void}
 */
function activatePage() {
  pageActive = true;
}

/**
 * AI:保存服务器地址和 token。
 *
 * @returns {void}
 */
function save() {
  saving.value = true;
  try {
    const saved = saveConfig(form);
    form.serverUrl = saved.serverUrl;
    form.token = saved.token;
    statusText.value = '已保存连接配置。';
    uni.showToast({ title: '已保存', icon: 'success' });
  } finally {
    saving.value = false;
  }
}

/**
 * AI:使用当前表单配置测试服务器连通性。
 *
 * @returns {Promise<void>}
 */
async function testConnection() {
  testing.value = true;
  try {
    const config = {
      serverUrl: String(form.serverUrl || '').trim().replace(/\/+$/, ''),
      token: String(form.token || '').trim(),
    };
    const data = await getHealth(config, { registerTask: registerRequestTask, unregisterTask: unregisterRequestTask });
    if (!pageActive) return;
    statusText.value = data.online ? '服务器可访问，电脑 Agent 在线。' : '服务器可访问，电脑 Agent 未在线。';
    uni.showToast({ title: '连接正常', icon: 'success' });
  } catch (error) {
    if (!pageActive) return;
    statusText.value = error.message;
    uni.showToast({ title: '连接失败', icon: 'none' });
  } finally {
    if (pageActive) testing.value = false;
  }
}

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
  padding: 18px 16px;
  background: #f4f5f7;
  color: #111827;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.field {
  margin-bottom: 16px;
}

.label {
  display: block;
  margin-bottom: 8px;
  color: #4b5563;
  font-size: 13px;
  line-height: 1;
  font-weight: 600;
}

.input {
  height: 46px;
  width: 100%;
  border: 1px solid #dfe3ea;
  border-radius: 8px;
  background: #ffffff;
  padding: 0 12px;
  color: #111827;
  font-size: 15px;
  line-height: 46px;
}

.primary,
.secondary {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 46px;
  margin-top: 12px;
  border-radius: 8px;
  padding: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
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
  color: #6b7280;
  font-size: 13px;
  line-height: 1.55;
}

button[disabled] {
  opacity: 0.55;
}
</style>
