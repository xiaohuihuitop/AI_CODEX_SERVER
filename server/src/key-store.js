const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_PREFIX = 'cdb_';
const TOKEN_BYTES = 24;

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
    tokenHint: key.tokenHint,
  };
}

/**
 * AI:创建持久化设备 Key 仓库，仓库只保存 Key 哈希，原始 Key 仅在创建时返回。
 *
 * @param {string} filePath Key 数据文件路径。
 * @param {string[]} bootstrapTokens 仅用于首次迁移的旧环境变量 Key。
 * @returns {{has: (token: string) => boolean, matches: (id: string, token: string) => boolean, list: () => object[], create: (note: string) => object, disable: (id: string) => boolean, remove: (id: string) => boolean}}
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
      tokenHint: `${String(token).slice(0, 6)}...`,
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
    create(note) {
      const normalizedNote = normalizeNote(note);
      if (!normalizedNote) {
        throw Object.assign(new Error('请填写 Key 备注。'), { status: 400, code: 'KEY_NOTE_REQUIRED' });
      }
      const token = `${KEY_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
      const key = {
        id: crypto.randomUUID(),
        note: normalizedNote,
        tokenHash: tokenHash(token),
        tokenHint: `${token.slice(0, 10)}...${token.slice(-4)}`,
        createdAt: new Date().toISOString(),
        disabledAt: '',
      };
      keys.push(key);
      persist();
      return { key: publicKey(key), token };
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
