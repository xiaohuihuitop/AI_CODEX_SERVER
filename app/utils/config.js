export const DEFAULT_CONFIG = { serverUrl: '', token: '' };

const DEVICE_STORE_KEY = 'codexMobile.devices.v1';
const LEGACY_CONFIG_KEY = 'codexMobile.config';
const LEGACY_SELECTION_KEY = 'codexMobile.selection';
const DRAFT_GUARD_KEY = 'codexMobile.draftGuard';
const DEVICE_STORE_VERSION = 1;
let deviceIdSequence = 0;

function emptySelection() {
  return { projectName: '', threadId: '' };
}

function normalizeSelection(selection) {
  const value = selection && typeof selection === 'object' ? selection : {};
  return {
    projectName: typeof value.projectName === 'string' ? value.projectName : '',
    threadId: typeof value.threadId === 'string' ? value.threadId : '',
  };
}

function normalizeConnectionState(state) {
  if (!state || typeof state !== 'object' || !state.checkedAt) return null;
  return {
    online: Boolean(state.online),
    agentOnline: Boolean(state.agentOnline),
    checkedAt: String(state.checkedAt || ''),
  };
}

function normalizeDevice(input, options = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const device = {
    id: String(value.id || options.id || '').trim(),
    name: String(value.name || '').trim(),
    serverUrl: String(value.serverUrl || '').trim().replace(/\/+$/, ''),
    token: String(value.token || '').trim(),
    lastConnection: normalizeConnectionState(value.lastConnection),
  };
  if (!device.id) throw new Error('设备缺少有效标识。');
  if (!options.allowIncomplete) {
    if (!device.name) throw new Error('请输入设备名称。');
    if (!device.serverUrl) throw new Error('请输入服务器地址。');
    if (!device.token) throw new Error('请输入 Token。');
  }
  return device;
}

function createEmptyStore() {
  return { version: DEVICE_STORE_VERSION, activeDeviceId: '', devices: [], selections: {} };
}

function normalizeStore(input) {
  if (!input || typeof input !== 'object' || Number(input.version) !== DEVICE_STORE_VERSION || !Array.isArray(input.devices)) {
    throw new Error('设备配置已损坏，请在设置中重新配置。');
  }
  const devices = input.devices.map(device => normalizeDevice(device, { allowIncomplete: true }));
  const ids = {};
  for (const device of devices) {
    if (ids[device.id]) throw new Error('设备配置包含重复标识。');
    ids[device.id] = true;
  }
  const selections = {};
  const sourceSelections = input.selections && typeof input.selections === 'object' ? input.selections : {};
  for (const device of devices) selections[device.id] = normalizeSelection(sourceSelections[device.id]);
  const requestedActiveId = String(input.activeDeviceId || '').trim();
  if ((devices.length && !ids[requestedActiveId]) || (!devices.length && requestedActiveId)) {
    throw new Error('设备配置中的当前设备无效，请在设置中重新配置。');
  }
  return {
    version: DEVICE_STORE_VERSION,
    activeDeviceId: requestedActiveId,
    devices,
    selections,
  };
}

function writeStore(store) {
  const normalized = normalizeStore(store);
  uni.setStorageSync(DEVICE_STORE_KEY, normalized);
  return normalized;
}

function createDeviceId() {
  deviceIdSequence += 1;
  return `device_${Date.now().toString(36)}_${deviceIdSequence.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function migrateLegacyStore() {
  const legacyConfig = uni.getStorageSync(LEGACY_CONFIG_KEY);
  const legacySelection = uni.getStorageSync(LEGACY_SELECTION_KEY);
  const serverUrl = String(legacyConfig && legacyConfig.serverUrl || '').trim().replace(/\/+$/, '');
  const token = String(legacyConfig && legacyConfig.token || '').trim();
  const store = createEmptyStore();
  if (serverUrl || token) {
    const id = createDeviceId();
    store.devices.push(normalizeDevice({ id, name: '我的电脑', serverUrl, token }, { allowIncomplete: true }));
    store.activeDeviceId = id;
    store.selections[id] = normalizeSelection(legacySelection);
  }
  const saved = writeStore(store);
  uni.removeStorageSync(LEGACY_CONFIG_KEY);
  uni.removeStorageSync(LEGACY_SELECTION_KEY);
  return saved;
}

/**
 * AI:读取版本化设备仓库；仅在新仓库不存在时迁移旧单设备配置。
 *
 * @returns {{version: number, activeDeviceId: string, devices: Array<object>, selections: object}} 设备仓库。
 */
export function loadDeviceStore() {
  const stored = uni.getStorageSync(DEVICE_STORE_KEY);
  if (!stored) return migrateLegacyStore();
  return normalizeStore(stored);
}

/**
 * AI:列出所有本地设备配置。
 *
 * @returns {Array<object>} 设备副本。
 */
export function listDevices() {
  return loadDeviceStore().devices.map(device => Object.assign({}, device));
}

/**
 * AI:读取当前设备；未配置时返回空值。
 *
 * @returns {object|null} 当前设备。
 */
export function getActiveDevice() {
  const store = loadDeviceStore();
  return store.devices.find(device => device.id === store.activeDeviceId) || null;
}

/**
 * AI:新增或更新设备，编辑时保持内部 ID 不变。
 *
 * @param {object} input 设备表单。
 * @returns {object} 已保存设备。
 */
export function saveDevice(input) {
  const store = loadDeviceStore();
  const requestedId = String(input && input.id || '').trim();
  const existingIndex = requestedId ? store.devices.findIndex(device => device.id === requestedId) : -1;
  if (requestedId && existingIndex === -1) throw new Error('要编辑的设备不存在。');
  const id = requestedId || createDeviceId();
  const previous = existingIndex === -1 ? null : store.devices[existingIndex];
  const device = normalizeDevice(Object.assign({}, previous || {}, input || {}, { id }));
  if (previous && (previous.serverUrl !== device.serverUrl || previous.token !== device.token)) {
    device.lastConnection = null;
  }
  if (existingIndex === -1) {
    store.devices.push(device);
    store.selections[id] = emptySelection();
    if (!store.activeDeviceId) store.activeDeviceId = id;
  } else {
    store.devices.splice(existingIndex, 1, device);
  }
  writeStore(store);
  return Object.assign({}, device);
}

/**
 * AI:删除设备和设备级选择；删除当前设备后选择第一台剩余设备。
 *
 * @param {string} deviceId 设备 ID。
 * @returns {object|null} 删除后的当前设备。
 */
export function removeDevice(deviceId) {
  const store = loadDeviceStore();
  const id = String(deviceId || '').trim();
  const index = store.devices.findIndex(device => device.id === id);
  if (index === -1) throw new Error('要删除的设备不存在。');
  store.devices.splice(index, 1);
  delete store.selections[id];
  if (store.activeDeviceId === id) store.activeDeviceId = store.devices[0] ? store.devices[0].id : '';
  const saved = writeStore(store);
  return saved.devices.find(device => device.id === saved.activeDeviceId) || null;
}

/**
 * AI:切换当前设备，只接受已保存的内部 ID。
 *
 * @param {string} deviceId 设备 ID。
 * @returns {object} 新的当前设备。
 */
export function setActiveDevice(deviceId) {
  const store = loadDeviceStore();
  const id = String(deviceId || '').trim();
  const device = store.devices.find(row => row.id === id);
  if (!device) throw new Error('目标设备不存在。');
  store.activeDeviceId = id;
  writeStore(store);
  return Object.assign({}, device);
}

/**
 * AI:读取指定设备最后选择的项目和对话。
 *
 * @param {string} deviceId 设备 ID。
 * @returns {{projectName: string, threadId: string}} 选择状态。
 */
export function loadSelection(deviceId) {
  const store = loadDeviceStore();
  return normalizeSelection(store.selections[String(deviceId || '').trim()]);
}

/**
 * AI:按设备保存项目和对话选择。
 *
 * @param {string} deviceId 设备 ID。
 * @param {{projectName: string, threadId: string}} selection 选择状态。
 * @returns {void}
 */
export function saveSelection(deviceId, selection) {
  const store = loadDeviceStore();
  const id = String(deviceId || '').trim();
  if (!store.devices.some(device => device.id === id)) throw new Error('无法为未知设备保存对话选择。');
  store.selections[id] = normalizeSelection(selection);
  writeStore(store);
}

/**
 * AI:记录设备最近一次健康检查结果，不将其解释为持续实时状态。
 *
 * @param {string} deviceId 设备 ID。
 * @param {object} result 健康检查结果。
 * @returns {void}
 */
export function saveDeviceConnectionState(deviceId, result) {
  const store = loadDeviceStore();
  const id = String(deviceId || '').trim();
  const index = store.devices.findIndex(device => device.id === id);
  if (index === -1) return;
  store.devices[index] = Object.assign({}, store.devices[index], {
    lastConnection: {
      online: Boolean(result && result.online),
      agentOnline: Boolean(result && result.agentOnline),
      checkedAt: String(result && result.checkedAt || new Date().toISOString()),
    },
  });
  writeStore(store);
}

/**
 * AI:保存首页草稿存在标识，不持久化草稿正文。
 *
 * @param {string} deviceId 当前设备 ID。
 * @param {boolean} hasDraft 是否存在草稿。
 * @returns {void}
 */
export function saveDraftGuard(deviceId, hasDraft) {
  uni.setStorageSync(DRAFT_GUARD_KEY, { deviceId: String(deviceId || ''), hasDraft: Boolean(hasDraft) });
}

/**
 * AI:读取当前设备草稿保护状态。
 *
 * @returns {{deviceId: string, hasDraft: boolean}} 草稿保护状态。
 */
export function loadDraftGuard() {
  const value = uni.getStorageSync(DRAFT_GUARD_KEY);
  if (!value || typeof value !== 'object') return { deviceId: '', hasDraft: false };
  return { deviceId: String(value.deviceId || ''), hasDraft: Boolean(value.hasDraft) };
}
