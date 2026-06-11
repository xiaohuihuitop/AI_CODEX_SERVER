const crypto = require('node:crypto');

/**
 * 创建本机访问令牌。
 *
 * @returns {string} 环境变量令牌或随机令牌。
 */
function createToken() {
  return process.env.CODEX_BRIDGE_TOKEN || crypto.randomBytes(18).toString('base64url');
}

/**
 * 解析 Cookie 请求头。
 *
 * @param {string} header Cookie 原始请求头。
 * @returns {Record<string, string>} Cookie 键值表。
 */
function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const raw = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(raw);
    } catch {
      cookies[key] = raw;
    }
  }
  return cookies;
}

/**
 * 判断请求是否携带正确访问令牌。
 *
 * @param {import('node:http').IncomingMessage | {url: string, headers: Record<string, string>}} req HTTP 请求对象。
 * @param {string} token 服务端令牌。
 * @returns {boolean} 是否授权。
 */
function isAuthorized(req, token) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const fromQuery = url.searchParams.get('token');
  const fromHeader = req.headers['x-mobile-typer-token'];
  const fromCookie = parseCookies(req.headers.cookie || '').codexBridgeToken;
  return Boolean(token && (fromQuery === token || fromHeader === token || fromCookie === token));
}

module.exports = {
  createToken,
  isAuthorized,
  parseCookies,
};
