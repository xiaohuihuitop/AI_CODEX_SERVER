/**
 * AI:拼接服务器 API 地址。
 *
 * @param {string} serverUrl 服务器根地址。
 * @param {string} apiPath API 路径。
 * @returns {string} 完整 URL。
 */
function buildUrl(serverUrl, apiPath) {
  const base = String(serverUrl || '').trim().replace(/\/+$/, '');
  const path = apiPath.charAt(0) === '/' ? apiPath : `/${apiPath}`;
  return `${base}${path}`;
}

/**
 * AI:发起 JSON 请求。
 *
 * @param {{serverUrl: string, token: string}} config 连接配置。
 * @param {string} apiPath API 路径。
 * @param {{method?: string, data?: object, registerTask?: Function}} options 请求选项。
 * @returns {Promise<object>} JSON 响应。
 */
export function requestJson(config, apiPath, options = {}) {
  return new Promise((resolve, reject) => {
    let task = null;
    task = uni.request({
      url: buildUrl(config.serverUrl, apiPath),
      method: options.method || 'GET',
      data: options.data,
      header: {
        'content-type': 'application/json',
        'x-mobile-typer-token': config.token,
      },
      success(response) {
        const data = response.data || {};
        if (response.statusCode < 200 || response.statusCode >= 300 || data.ok === false) {
          reject(new Error(data.message || `请求失败：${response.statusCode}`));
          return;
        }
        resolve(data);
      },
      fail(error) {
        reject(new Error(error.errMsg || '网络请求失败'));
      },
      complete() {
        if (typeof options.unregisterTask === 'function') options.unregisterTask(task);
      },
    });
    if (typeof options.registerTask === 'function') options.registerTask(task);
  });
}

/**
 * AI:读取服务器和 Agent 在线状态。
 *
 * @param {{serverUrl: string, token: string}} config 连接配置。
 * @returns {Promise<object>} 状态响应。
 */
export function getHealth(config, options = {}) {
  return requestJson(config, '/codex/health', options);
}

/**
 * AI:读取 Codex Desktop 当前打开的对话列表。
 *
 * @param {{serverUrl: string, token: string}} config 连接配置。
 * @returns {Promise<object>} 对话列表响应。
 */
export function getThreads(config, options = {}) {
  return requestJson(config, '/codex/threads?limit=120', options);
}

/**
 * AI:读取指定对话历史。
 *
 * @param {{serverUrl: string, token: string}} config 连接配置。
 * @param {string} threadId 对话 ID。
 * @returns {Promise<object>} 历史响应。
 */
export function getHistory(config, threadId, options = {}) {
  return requestJson(config, `/codex/history?thread=${encodeURIComponent(threadId)}&limit=120`, options);
}

/**
 * AI:读取指定对话运行状态。
 *
 * @param {{serverUrl: string, token: string}} config 连接配置。
 * @param {{threadId: string, since?: string}} watch 状态查询参数。
 * @returns {Promise<object>} 状态响应。
 */
export function getStatus(config, watch, options = {}) {
  const params = [
    `thread=${encodeURIComponent(watch.threadId || '')}`,
    `since=${encodeURIComponent(watch.since || '')}`,
  ].join('&');
  return requestJson(config, `/codex/status?${params}`, options);
}

/**
 * AI:向指定对话发送消息。
 *
 * @param {{serverUrl: string, token: string}} config 连接配置。
 * @param {{threadId: string, text: string}} payload 消息负载。
 * @returns {Promise<object>} 发送响应。
 */
export function sendMessage(config, payload, options = {}) {
  return requestJson(config, '/send', {
    method: 'POST',
    data: {
      threadId: payload.threadId,
      text: payload.text,
    },
    registerTask: options.registerTask,
    unregisterTask: options.unregisterTask,
  });
}

/**
 * AI:停止当前 Codex 回复任务。
 *
 * @param {{serverUrl: string, token: string}} config 连接配置。
 * @returns {Promise<object>} 停止响应。
 */
export function stopCodex(config, options = {}) {
  return requestJson(config, '/codex/stop', {
    method: 'POST',
    registerTask: options.registerTask,
    unregisterTask: options.unregisterTask,
  });
}
