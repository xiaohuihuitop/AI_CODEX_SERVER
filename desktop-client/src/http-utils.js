const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/**
 * 生成跨域响应头。
 *
 * @returns {Record<string, string>} HTTP 响应头。
 */
function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-mobile-typer-token',
    'access-control-allow-private-network': 'true',
  };
}

/**
 * 响应 OPTIONS 预检请求。
 *
 * @param {import('node:http').ServerResponse} res HTTP 响应对象。
 * @returns {void}
 */
function sendOptions(res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

/**
 * 发送 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res HTTP 响应对象。
 * @param {number} status HTTP 状态码。
 * @param {unknown} data 可序列化响应数据。
 * @returns {void}
 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 读取请求体并限制最大字节数。
 *
 * @param {import('node:http').IncomingMessage} req HTTP 请求对象。
 * @param {number} maxBytes 最大允许字节数。
 * @returns {Promise<string>} UTF-8 请求体文本。
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error(`请求体超过 ${maxBytes} 字节。`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 从 public 目录安全托管静态文件。
 *
 * @param {import('node:http').IncomingMessage} req HTTP 请求对象。
 * @param {import('node:http').ServerResponse} res HTTP 响应对象。
 * @param {string} publicDir 静态资源根目录。
 * @returns {void}
 */
function serveStatic(req, res, publicDir) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(publicDir, pathname));
  const relative = path.relative(publicDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
      'content-length': data.length,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

module.exports = {
  corsHeaders,
  readBody,
  sendJson,
  sendOptions,
  serveStatic,
};
