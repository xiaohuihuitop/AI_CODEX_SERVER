const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthorized, parseCookies } = require('../desktop-client/src/auth');

/**
 * 构造最小 HTTP 请求对象。
 *
 * @param {string} url 请求 URL。
 * @param {Record<string, string>} headers 请求头。
 * @returns {{url: string, headers: Record<string, string>}} 请求对象。
 */
function req(url, headers = {}) {
  return { url, headers: { host: 'localhost:8787', ...headers } };
}

test('query token 可以通过鉴权', () => {
  assert.equal(isAuthorized(req('/codex/health?token=abc'), 'abc'), true);
});

test('header token 可以通过鉴权', () => {
  assert.equal(isAuthorized(req('/codex/health', { 'x-mobile-typer-token': 'abc' }), 'abc'), true);
});

test('cookie token 可以通过鉴权', () => {
  assert.equal(isAuthorized(req('/codex/health', { cookie: 'codexBridgeToken=abc' }), 'abc'), true);
});

test('错误 token 被拒绝', () => {
  assert.equal(isAuthorized(req('/codex/health?token=bad'), 'abc'), false);
});

test('cookie 解析保留合法键值', () => {
  assert.deepEqual(parseCookies('a=1; codexBridgeToken=hello%20world'), {
    a: '1',
    codexBridgeToken: 'hello world',
  });
});
