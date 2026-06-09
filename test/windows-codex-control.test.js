const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'scripts', 'win-codex-control.ps1');
const indexPath = path.join(__dirname, '..', 'public', 'index.html');

function extractGetThreadRowExpression(script, projectName, threadName) {
  const functionText = script.match(/function Get-ThreadRow \{[\s\S]*?\n\}\r?\n\r?\nfunction Get-Composer/)?.[0] || '';
  const expression = functionText.match(/\$expression = @"\r?\n([\s\S]*?)\r?\n"@/)?.[1] || '';
  return expression
    .replaceAll('$projectJson', JSON.stringify(projectName))
    .replaceAll('$threadJson', JSON.stringify(threadName));
}

function makeElement({ tag = 'div', attrs = {}, text = '', rect = {}, children = [] }) {
  const element = {
    tagName: tag.toUpperCase(),
    attrs,
    innerText: text,
    textContent: text,
    parent: null,
    children,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getBoundingClientRect() {
      return {
        x: rect.x || 0,
        y: rect.y || 0,
        width: rect.width || 0,
        height: rect.height || 0,
      };
    },
    scrollIntoView() {},
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      return getDescendants(this).filter(item => matchesSelectorList(item, selector));
    },
  };
  for (const child of children) child.parent = element;
  return element;
}

function getDescendants(element) {
  return element.children.flatMap(child => [child, ...getDescendants(child)]);
}

function matchesSelectorList(element, selectorList) {
  return selectorList.split(',').some(selector => matchesSelector(element, selector.trim()));
}

function matchesSelector(element, selector) {
  const parts = selector.split(/\s+/).filter(Boolean);
  let current = element;
  if (!parts.length || !matchesSimpleSelector(current, parts[parts.length - 1])) return false;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    current = current.parent;
    while (current && !matchesSimpleSelector(current, parts[index])) current = current.parent;
    if (!current) return false;
  }
  return true;
}

function matchesSimpleSelector(element, selector) {
  let rest = selector;
  const attrMatches = [...rest.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
  rest = rest.replace(/\[[^\]]+\]/g, '');
  if (rest && rest !== element.tagName.toLowerCase()) return false;
  return attrMatches.every(([, name, value]) => {
    const actual = element.getAttribute(name);
    return value === undefined ? actual !== null : actual === value;
  });
}

function buildProjectDocument() {
  const threadButton = (name, y, time = '') => makeElement({
    attrs: { role: 'button' },
    text: time ? `${name}\n${time}` : name,
    rect: { x: 8, y, width: 273.6, height: 31 },
  });
  const threadItem = (name, y, time = '') => makeElement({
    attrs: { role: 'listitem' },
    text: time ? `${name}\n${time}` : name,
    rect: { x: 8, y, width: 273.6, height: 32 },
    children: [threadButton(name, y, time)],
  });
  const projectRow = makeElement({
    attrs: { role: 'listitem', 'aria-label': 'GUI_LED' },
    text: 'GUI_LED\ncontrol\napp\n6 天\nslave\n1 周',
    rect: { x: 8, y: 454, width: 273.6, height: 136 },
    children: [
      makeElement({
        attrs: { role: 'button', 'aria-label': 'GUI_LED' },
        text: 'GUI_LED',
        rect: { x: 8, y: 454, width: 273.6, height: 31 },
      }),
      makeElement({
        attrs: { role: 'list', 'aria-label': '“GUI_LED”中的自动化操作' },
        text: 'control\napp\n6 天\nslave\n1 周',
        rect: { x: 8, y: 487, width: 273.6, height: 95 },
        children: [
          threadItem('control', 487),
          threadItem('app', 519, '6 天'),
          threadItem('slave', 551, '1 周'),
        ],
      }),
    ],
  });
  const document = makeElement({
    tag: 'document',
    children: [projectRow],
  });
  document.body = { innerText: projectRow.innerText };
  return document;
}

test('关闭 CDP socket 时不等待远端关闭帧', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');
  const closeFunction = script.match(/function Close-CodexSocket \{[\s\S]*?\n\}/)?.[0] || '';

  assert.ok(closeFunction.includes('$Socket.Dispose()'));
  assert.equal(closeFunction.includes('CloseAsync('), false);
});

test('打包后控制脚本路径指向 app.asar.unpacked 真实文件', () => {
  const { WindowsCodexController, resolveAsarUnpackedPath } = require('../src/windows-codex-controller');
  const packedPath = [
    'C:',
    'app',
    'resources',
    'app.asar',
    'scripts',
    'win-codex-control.ps1',
  ].join(path.sep);
  const expected = [
    'C:',
    'app',
    'resources',
    'app.asar.unpacked',
    'scripts',
    'win-codex-control.ps1',
  ].join(path.sep);
  const controller = new WindowsCodexController({ scriptPath: packedPath });

  assert.equal(resolveAsarUnpackedPath(packedPath), expected);
  assert.equal(controller.scriptPath, expected);
});

test('脚本支持读取 Codex Desktop 当前打开线程', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /ValidateSet\('send-thread', 'stop', 'list-open-threads'/);
  assert.match(script, /function Get-OpenThreads/);
  assert.match(script, /projectName/);
  assert.match(script, /threadName/);
});

test('脚本不支持单独切换 Codex Desktop 线程', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.equal(script.includes("'open-thread'"), false);
  assert.equal(script.includes('function Open-Thread'), false);
  assert.equal(script.includes("$Action -eq 'open-thread'"), false);
});

test('同一项目多线程时定位具体线程行', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');
  const expression = extractGetThreadRowExpression(script, 'GUI_LED', 'app');
  const result = Function('document', `return ${expression};`)(buildProjectDocument());

  assert.equal(result.ok, true);
  assert.equal(result.text, 'app\n6 天');
  assert.equal(result.rect.y, 519);
});

test('线程定位不回退点击线程父容器', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');
  const getThreadRow = script.match(/function Get-ThreadRow \{[\s\S]*?\n\}\r?\n\r?\nfunction Get-Composer/)?.[0] || '';

  assert.equal(getThreadRow.includes('|| threadItem'), false);
  assert.match(getThreadRow, /THREAD_BUTTON_NOT_FOUND/);
});

test('手机端线程切换不触发桌面端同步切换', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const threadsChange = html.match(/threadsEl\.addEventListener\('change', async \(\) => \{([\s\S]*?)\n    \}\);/)?.[1] || '';
  const projectsChange = html.match(/projectsEl\.addEventListener\('change', async \(\) => \{([\s\S]*?)\n    \}\);/)?.[1] || '';

  assert.equal(html.includes('openSelectedThread'), false);
  assert.equal(html.includes('/codex/open'), false);
  assert.equal(threadsChange.includes('await openSelectedThread()'), false);
  assert.equal(projectsChange.includes('await openSelectedThread()'), false);
  assert.match(threadsChange, /await loadHistory\(\)/);
  assert.match(projectsChange, /await loadHistory\(\)/);
});

test('手机端初始化不同步切换桌面端当前线程', () => {
  const html = fs.readFileSync(indexPath, 'utf8');

  assert.match(html, /loadThreads\(\)\.then\(loadHistory\)/);
  assert.equal(html.includes('then(openSelectedThread)'), false);
});

test('手机端消息使用本地 Markdown 渲染器', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const messageFunction = html.match(/function message\(role, text\) \{([\s\S]*?)\n    \}/)?.[1] || '';

  assert.match(html, /<script src="\/markdown\.js(?:\?v=\d+)?"><\/script>/);
  assert.match(messageFunction, /CodexMarkdown\.renderMarkdownToHtml/);
  assert.equal(messageFunction.includes('div.textContent = text'), false);
});

test('手机端显示线程运行状态指示点', () => {
  const html = fs.readFileSync(indexPath, 'utf8');

  assert.match(html, /id="threadStatus"/);
  assert.match(html, /function updateThreadStatus/);
  assert.match(html, /thread-status--running/);
  assert.match(html, /setInterval\(\(\) => refreshThreadStatuses/);
});

test('手机端线程列表请求复用同一个进行中的请求', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const loadFunction = html.match(/async function loadThreads\(\) \{([\s\S]*?)\n    \}/)?.[1] || '';
  const refreshFunction = html.match(/async function refreshThreadStatuses\(\) \{([\s\S]*?)\n    \}/)?.[1] || '';

  assert.match(html, /let threadListRequest = null/);
  assert.match(html, /function fetchThreadRows/);
  assert.match(html, /if \(threadListRequest\) return threadListRequest/);
  assert.match(html, /threadListRequest = null/);
  assert.match(loadFunction, /await fetchThreadRows\(/);
  assert.match(refreshFunction, /await fetchThreadRows\(/);
});
