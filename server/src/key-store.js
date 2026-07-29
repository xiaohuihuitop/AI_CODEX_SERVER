const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function normalizeNote(note) {
  return String(note || '').trim().slice(0, 80);
}

function publicKey(key) {
  return {
    id: key.id,
    note: key.note,
    createdAt: key.createdAt,
    disabledAt: key.disabledAt || '',
    token: typeof key.token === 'string' ? key.token : '',
  };
}

/**
 * AI:创建持久化设备 Key 仓库，支持自定义 Key 和备注。
 *
 * @param {string} filePath Key 数据文件路径。
 * @param {string[]} bootstrapTokens 仅用于首次迁移的旧环境变量 Key。
 * @returns {{has: (token: string) => boolean, matches: (id: string, token: string) => boolean, list: () => object[], create: (note: string, token: string) => object, disable: (id: string) => boolean, remove: (id: string) => boolean}}
 */
function createKeyStore(filePath, bootstrapTokens = []) {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  let keys = [];

  if (fs.existsSync(absolutePath)) {
    const data = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    keys = Array.isArray(data.keys) ? data.keys : [];
  }

  if (!keys.length && bootstrapTokens.length) {
    const createdAt = new Date().toISOString();
    keys = bootstrapTokens.filter(Boolean).map((token, index) => ({
      id: crypto.randomUUID(),
      note: `迁移的旧 Key ${index + 1}`,
      tokenHash: tokenHash(token),
      token: String(token),
      createdAt,
      disabledAt: '',
    }));
  }

  function persist() {
    const tempPath = `${absolutePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, absolutePath);
  }

  persist();

  return {
    has(token) {
      const hash = tokenHash(token);
      return keys.some(key => !key.disabledAt && key.tokenHash === hash);
    },
    matches(id, token) {
      const key = keys.find(item => item.id === id);
      return Boolean(key && key.tokenHash === tokenHash(token));
    },
    list() {
      return keys.map(publicKey);
    },
    create(note, token) {
      const normalizedNote = normalizeNote(note);
      if (!normalizedNote) {
        throw Object.assign(new Error('请填写 Key 备注。'), { status: 400, code: 'KEY_NOTE_REQUIRED' });
      }
      const normalizedToken = String(token || '').trim();
      if (!KEY_PATTERN.test(normalizedToken)) {
        throw Object.assign(new Error('Key 必须为 8-128 位字母、数字、下划线或连字符。'), { status: 400, code: 'KEY_INVALID' });
      }
      if (keys.some(item => item.tokenHash === tokenHash(normalizedToken))) {
        throw Object.assign(new Error('Key 已存在，请使用其他 Key。'), { status: 409, code: 'KEY_DUPLICATE' });
      }
      const key = {
        id: crypto.randomUUID(),
        note: normalizedNote,
        tokenHash: tokenHash(normalizedToken),
        token: normalizedToken,
        createdAt: new Date().toISOString(),
        disabledAt: '',
      };
      keys.push(key);
      persist();
      return { key: publicKey(key), token: normalizedToken };
    },
    disable(id) {
      const key = keys.find(item => item.id === id);
      if (!key || key.disabledAt) return false;
      key.disabledAt = new Date().toISOString();
      persist();
      return true;
    },
    remove(id) {
      const index = keys.findIndex(item => item.id === id);
      if (index < 0) return false;
      keys.splice(index, 1);
      persist();
      return true;
    },
  };
}

module.exports = { createKeyStore };
