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
import { reactive, ref } from 'vue';
import { loadConfig, saveConfig } from '../../utils/config';
import { getHealth } from '../../utils/api';

const form = reactive(loadConfig());
const saving = ref(false);
const testing = ref(false);
const statusText = ref('配置会保存在本机 App 内。');

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
    const data = await getHealth(config);
    statusText.value = data.online ? '服务器可访问，电脑 Agent 在线。' : '服务器可访问，电脑 Agent 未在线。';
    uni.showToast({ title: '连接正常', icon: 'success' });
  } catch (error) {
    statusText.value = error.message;
    uni.showToast({ title: '连接失败', icon: 'none' });
  } finally {
    testing.value = false;
  }
}
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
