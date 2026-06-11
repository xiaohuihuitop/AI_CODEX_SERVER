export const DEFAULT_CONFIG = {
  serverUrl: 'http://www.xiaohuihuitop.top:8008',
  token: 'xiaohuihui',
};

const CONFIG_KEY = 'codexMobile.config';
const SELECTION_KEY = 'codexMobile.selection';

/**
 * AI:读取 App 连接配置。
 *
 * @returns {{serverUrl: string, token: string}} 连接配置。
 */
export function loadConfig() {
  const stored = uni.getStorageSync(CONFIG_KEY);
  if (!stored || typeof stored !== 'object') return Object.assign({}, DEFAULT_CONFIG);
  return {
    serverUrl: typeof stored.serverUrl === 'string' && stored.serverUrl.trim() ? stored.serverUrl.trim() : DEFAULT_CONFIG.serverUrl,
    token: typeof stored.token === 'string' && stored.token.trim() ? stored.token.trim() : DEFAULT_CONFIG.token,
  };
}

/**
 * AI:保存 App 连接配置。
 *
 * @param {{serverUrl: string, token: string}} config 连接配置。
 * @returns {{serverUrl: string, token: string}} 已保存配置。
 */
export function saveConfig(config) {
  const normalized = {
    serverUrl: String(config.serverUrl || '').trim().replace(/\/+$/, ''),
    token: String(config.token || '').trim(),
  };
  uni.setStorageSync(CONFIG_KEY, normalized);
  return normalized;
}

/**
 * AI:读取最后选中的项目和对话。
 *
 * @returns {{projectName: string, threadId: string}} 选择状态。
 */
export function loadSelection() {
  const stored = uni.getStorageSync(SELECTION_KEY);
  if (!stored || typeof stored !== 'object') return { projectName: '', threadId: '' };
  return {
    projectName: typeof stored.projectName === 'string' ? stored.projectName : '',
    threadId: typeof stored.threadId === 'string' ? stored.threadId : '',
  };
}

/**
 * AI:保存当前项目和对话选择。
 *
 * @param {{projectName: string, threadId: string}} selection 选择状态。
 * @returns {void}
 */
export function saveSelection(selection) {
  uni.setStorageSync(SELECTION_KEY, {
    projectName: String(selection.projectName || ''),
    threadId: String(selection.threadId || ''),
  });
}
