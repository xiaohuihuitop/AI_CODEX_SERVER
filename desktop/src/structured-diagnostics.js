const fs = require('node:fs');
const path = require('node:path');

const MAX_DIAGNOSTIC_ENTRIES = 500;

/**
 * AI:创建有限长度的 JSONL 诊断记录器，字段只保存标识和阶段，不保存消息正文。
 *
 * @param {string} filePath 诊断文件路径；为空时只返回无副作用记录器。
 * @param {number} maxEntries 最大记录数。
 * @returns {{record: (event: string, details?: object) => void}} 诊断记录器。
 */
function createStructuredDiagnosticLog(filePath, maxEntries = MAX_DIAGNOSTIC_ENTRIES) {
  const absolutePath = String(filePath || '').trim() ? path.resolve(filePath) : '';
  const limit = Math.max(10, Number(maxEntries) || MAX_DIAGNOSTIC_ENTRIES);
  if (absolutePath) fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  function record(event, details = {}) {
    if (!absolutePath) return;
    const entry = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      component: 'desktop-agent',
      event: String(event || 'unknown'),
      details: details && typeof details === 'object' ? details : {},
    };
    fs.appendFileSync(absolutePath, `${JSON.stringify(entry)}\n`, 'utf8');
    const lines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length > limit) fs.writeFileSync(absolutePath, `${lines.slice(-limit).join('\n')}\n`, 'utf8');
  }

  return { record };
}

module.exports = {
  MAX_DIAGNOSTIC_ENTRIES,
  createStructuredDiagnosticLog,
};
