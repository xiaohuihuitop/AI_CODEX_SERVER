const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const serverRoot = path.join(__dirname, '..');
const repoRoot = path.join(serverRoot, '..');
const desktopRoot = path.join(repoRoot, 'desktop');

/**
 * AI:列出目录下一级 JS 文件，用于语法检查入口。
 *
 * @param {string} dir 目录路径。
 * @returns {string[]} JS 文件路径列表。
 */
function listJs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.js'))
    .map(file => path.join(dir, file));
}

const files = [
  path.join(serverRoot, 'cloud-server.js'),
  path.join(desktopRoot, 'server.js'),
  path.join(desktopRoot, 'desktop-agent.js'),
  path.join(desktopRoot, 'desktop-manager-server.js'),
  ...listJs(path.join(serverRoot, 'src')),
  ...listJs(path.join(desktopRoot, 'src')),
  ...listJs(path.join(desktopRoot, 'electron')),
];

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
