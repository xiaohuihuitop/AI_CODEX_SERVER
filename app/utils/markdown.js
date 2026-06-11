const SAFE_PROTOCOLS = {
  'http:': true,
  'https:': true,
  'mailto:': true,
};

/**
 * AI:过滤 Codex Desktop 注入的浏览器上下文和客户端指令。
 *
 * @param {string} text 原始消息文本。
 * @returns {string} 可展示文本。
 */
export function stripCodexUiDirectives(text) {
  const lines = [];
  let inBrowserContext = false;

  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    const isBrowserHeader = /^(?:#+\s*)?In app browser:\s*$/i.test(trimmed);
    const isRequestHeader = /^(?:#+\s*)?My request for Codex:\s*$/i.test(trimmed);
    const isBrowserMeta = /^[-*]\s*(?:The user has the in-app browser open\.?|Current URL:.*)$/i.test(trimmed);

    if (isBrowserHeader) {
      inBrowserContext = true;
      continue;
    }
    if (isRequestHeader) {
      inBrowserContext = false;
      continue;
    }
    if (inBrowserContext) {
      if (!trimmed || isBrowserMeta) continue;
      inBrowserContext = false;
    }
    if (isBrowserMeta) continue;
    lines.push(line);
  }

  return lines
    .filter(line => !/^::[a-z][a-z-]*\{.*\}\s*$/i.test(line.trim()))
    .join('\n')
    .trim();
}

/**
 * AI:转义 HTML 文本，避免 Markdown 原文注入页面。
 *
 * @param {string} value 原始文本。
 * @returns {string} 安全文本。
 */
export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * AI:校验 Markdown 链接地址。
 *
 * @param {string} href 原始链接。
 * @returns {string} 安全链接；不安全时返回空字符串。
 */
function safeHref(href) {
  const value = String(href || '').trim();
  if (!value) return '';
  if (value.charAt(0) === '#' || value.charAt(0) === '/') return value;
  const match = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  return match && SAFE_PROTOCOLS[`${match[1].toLowerCase()}:`] ? value : '';
}

/**
 * AI:渲染 Markdown 行内语法。
 *
 * @param {string} value Markdown 文本。
 * @returns {string} HTML 片段。
 */
function renderInline(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const safe = safeHref(href);
    if (!safe) return label;
    return `<a href="${escapeHtml(safe)}">${label}</a>`;
  });
  return text;
}

/**
 * AI:判断当前行是否是 Markdown 表格分隔行。
 *
 * @param {string} line 当前行。
 * @returns {boolean} 是否表格分隔行。
 */
function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/**
 * AI:拆分 Markdown 表格行。
 *
 * @param {string} line 表格行。
 * @returns {string[]} 单元格。
 */
function splitTableRow(line) {
  return String(line || '')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

/**
 * AI:将 Markdown 文本渲染为 uni-app rich-text 可用的 HTML 字符串。
 *
 * @param {string} markdown Markdown 文本。
 * @returns {string} HTML 字符串。
 */
export function renderMarkdownToHtml(markdown) {
  const lines = stripCodexUiDirectives(markdown).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && lines[index].trim().indexOf('```') !== 0) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      html.push(`<blockquote>${quoteLines.map(item => `<p>${renderInline(item)}</p>`).join('')}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*+]\s+/, ''));
        index += 1;
      }
      html.push(`<ul>${items.map(item => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      html.push(`<ol>${items.map(item => `<li>${renderInline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    if (trimmed.indexOf('|') !== -1 && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(trimmed);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().indexOf('|') !== -1) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      html.push([
        '<table>',
        `<thead><tr>${headers.map(cell => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`,
        `<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`,
        '</table>',
      ].join(''));
      continue;
    }

    const paragraph = [trimmed];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,6})\s+/.test(lines[index].trim()) && !/^([-*+]|\d+\.)\s+/.test(lines[index].trim()) && !/^>\s?/.test(lines[index].trim()) && lines[index].trim().indexOf('```') !== 0) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
  }

  return html.join('');
}
