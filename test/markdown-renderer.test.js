const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { renderMarkdownToHtml } = require('../server/public/markdown');

test('渲染常用 Markdown 格式', () => {
  const html = renderMarkdownToHtml([
    '# 标题',
    '',
    '- **重点** 和 `code`',
    '- [链接](https://example.com)',
    '',
    '> 引用内容',
    '',
    '```js',
    'console.log(1)',
    '```',
  ].join('\n'));

  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre><code class="language-js">console\.log\(1\)<\/code><\/pre>/);
});

test('Markdown 渲染会转义原始 HTML 并拒绝危险链接', () => {
  const html = renderMarkdownToHtml('<script>alert(1)</script> [危险](javascript:alert(1)) **ok**');

  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('href="javascript:'), false);
  assert.match(html, /<strong>ok<\/strong>/);
});

test('网页端 Markdown 渲染器避免旧 Android WebView 不兼容 API', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'markdown.js'), 'utf8');

  assert.doesNotMatch(source, /\.replaceAll\s*\(/);
  assert.doesNotMatch(source, /new\s+URL\s*\(/);
  assert.doesNotMatch(source, /new\s+Set\s*\(/);
  assert.doesNotMatch(source, /\.(startsWith|includes)\s*\(/);
});
