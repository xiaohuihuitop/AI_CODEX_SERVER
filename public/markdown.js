(function (root, factory) {
  const api = factory();
  root.CodexMarkdown = api;
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

  /**
   * 转义 HTML 文本。
   *
   * @param {string} value 原始文本。
   * @returns {string} 安全文本。
   */
  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  /**
   * 校验 Markdown 链接地址。
   *
   * @param {string} href 原始链接。
   * @returns {string} 安全链接；不安全时返回空字符串。
   */
  function safeHref(href) {
    const value = String(href || '').trim();
    if (!value) return '';
    if (value.startsWith('#') || value.startsWith('/')) return value;
    try {
      const url = new URL(value);
      return SAFE_PROTOCOLS.has(url.protocol) ? value : '';
    } catch {
      return '';
    }
  }

  /**
   * 渲染行内 Markdown。
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
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return text;
  }

  /**
   * 判断是否是 Markdown 表格分隔行。
   *
   * @param {string} line 当前行。
   * @returns {boolean} 是否表格分隔行。
   */
  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  }

  /**
   * 拆分 Markdown 表格行。
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
   * 将 Markdown 文本渲染为安全 HTML。
   *
   * @param {string} markdown Markdown 文本。
   * @returns {string} HTML 字符串。
   */
  function renderMarkdownToHtml(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
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
        while (index < lines.length && !lines[index].trim().startsWith('```')) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
        html.push(`<pre><code${language}>${escapeHtml(code.join('\n'))}</code></pre>`);
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

      if (trimmed.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
        const headers = splitTableRow(trimmed);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].trim().includes('|')) {
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
      while (index < lines.length && lines[index].trim() && !/^(#{1,6})\s+/.test(lines[index].trim()) && !/^([-*+]|\d+\.)\s+/.test(lines[index].trim()) && !/^>\s?/.test(lines[index].trim()) && !lines[index].trim().startsWith('```')) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    }

    return html.join('');
  }

  return {
    escapeHtml,
    renderMarkdownToHtml,
  };
}));
