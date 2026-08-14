function controlError(message, code) {
  return Object.assign(new Error(message), { code });
}

function center(rect) {
  return {
    x: Number(rect.x) + Number(rect.width) / 2,
    y: Number(rect.y) + Number(rect.height) / 2,
  };
}

/**
 * AI:通过受控官方 Codex Desktop 页面执行线程选择、发送和停止。
 */
class CodexDesktopUiController {
  /**
   * @param {{cdp: object, threadSelector?: Function, composerReader?: Function, sessionConfirmer?: Function, sessionStopConfirmer?: Function, sleep?: Function}} options 控制依赖。
   */
  constructor(options = {}) {
    if (!options.cdp) throw new Error('CodexDesktopUiController 缺少 CDP 客户端。');
    this.cdp = options.cdp;
    this.threadSelector = options.threadSelector || (threadId => this.selectThread(threadId));
    this.composerReader = options.composerReader || (() => this.readComposer());
    this.sessionConfirmer = options.sessionConfirmer;
    this.sessionStopConfirmer = options.sessionStopConfirmer;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async click(rect) {
    const point = center(rect);
    await this.cdp.request('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await this.cdp.request('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await this.cdp.request('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }

  async selectThread(threadId) {
    const id = String(threadId || '').trim();
    if (!id) throw controlError('缺少目标 threadId。', 'THREAD_ID_REQUIRED');
    await this.cdp.connect();
    const localId = `local:${id}`;
    const inspected = await this.cdp.evaluate(`(() => {
      const wanted = ${JSON.stringify(localId)};
      const inspect = () => {
        const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
          .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === wanted);
        if (!row) return { found: false, selected: false };
        row.scrollIntoView({ block: 'center' });
        const rect = row.getBoundingClientRect();
        return {
          found: true,
          selected: row.getAttribute('aria-current') === 'page',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      };
      return inspect();
    })()`);
    if (!inspected || !inspected.found) throw controlError(`Codex Desktop 侧栏中不存在目标线程：${id}`, 'THREAD_ROW_NOT_FOUND');
    if (!inspected.selected) {
      await this.cdp.request('Page.bringToFront');
      await this.click(inspected.rect);
      await this.sleep(500);
    }
    const selected = await this.cdp.evaluate(`(() => {
      const row = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]');
      return {
        found: !!row,
        selected: !!row,
        threadId: row ? row.getAttribute('data-app-action-sidebar-thread-id') : ''
      };
    })()`);
    if (!selected || selected.threadId !== localId) {
      throw controlError(`Codex Desktop 未切换到目标线程：${id}`, 'THREAD_SELECTION_FAILED');
    }
    return { threadId: id };
  }

  async readComposer() {
    return this.cdp.evaluate(`(() => {
      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const rectOf = element => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const editor = [...document.querySelectorAll('[contenteditable="true"]')].find(visible);
      const buttons = [...document.querySelectorAll('button')].filter(visible);
      const stopButton = buttons.find(button => button.getAttribute('aria-label') === '停止');
      const sendButton = buttons.find(button => {
        const label = String(button.getAttribute('aria-label') || '').trim();
        return label === '发送' || label === '发送消息' || String(button.className || '').includes('size-token-button-composer');
      });
      const actionButton = stopButton || sendButton;
      return {
        found: !!editor && !!actionButton,
        draft: String(editor && (editor.innerText || editor.textContent) || '').trim(),
        action: stopButton ? 'stop' : sendButton ? 'send' : 'unknown',
        disabled: !!actionButton?.disabled,
        editorRect: rectOf(editor),
        sendRect: rectOf(actionButton)
      };
    })()`);
  }

  async sendMessage(threadId, text) {
    const message = String(text || '').trim();
    const controlStartedAt = new Date().toISOString();
    if (!message) throw controlError('发送内容不能为空。', 'EMPTY_TEXT');
    await this.threadSelector(threadId);
    const before = await this.composerReader();
    if (!before || !before.found) throw controlError('Codex Desktop 编辑器不可用。', 'COMPOSER_NOT_FOUND');
    if (String(before.draft || '').trim()) throw controlError('Codex Desktop 存在本地草稿，已拒绝覆盖。', 'LOCAL_DRAFT_EXISTS');
    if (before.action === 'stop') throw controlError('目标线程正在运行，已拒绝并发发送。', 'THREAD_ALREADY_RUNNING');
    if (before.action !== 'send' || before.disabled) throw controlError('Codex Desktop 当前不可发送。', 'SEND_DISABLED');

    await this.click(before.editorRect);
    await this.cdp.request('Input.insertText', { text: message });
    await this.sleep(100);
    const ready = await this.composerReader();
    if (!ready || ready.action !== 'send' || ready.disabled || String(ready.draft || '').trim() !== message) {
      throw controlError('Codex Desktop 未形成待发送消息。', 'MESSAGE_INPUT_FAILED');
    }
    await this.click(ready.sendRect);
    if (typeof this.sessionConfirmer !== 'function') {
      throw controlError('缺少 JSONL 发送确认器。', 'SESSION_CONFIRMATION_UNAVAILABLE');
    }
    // AI:输入正文已在点击前精确校验；点击后以同一线程的新 task_started 确认官方客户端已接收。
    const evidence = await this.sessionConfirmer(threadId, controlStartedAt);
    return {
      ok: true,
      threadId,
      turnId: String(evidence && evidence.turnId || ''),
      observedAt: String(evidence && evidence.observedAt || ''),
    };
  }

  async stop(threadId) {
    const controlStartedAt = new Date().toISOString();
    await this.threadSelector(threadId);
    const composer = await this.composerReader();
    if (!composer || !composer.found) throw controlError('Codex Desktop 编辑器不可用。', 'COMPOSER_NOT_FOUND');
    if (composer.action !== 'stop') throw controlError('目标线程当前没有可停止的回复。', 'THREAD_NOT_RUNNING');
    await this.click(composer.sendRect);
    if (typeof this.sessionStopConfirmer !== 'function') {
      throw controlError('缺少 JSONL 停止确认器。', 'SESSION_CONFIRMATION_UNAVAILABLE');
    }
    const evidence = await this.sessionStopConfirmer(threadId, controlStartedAt);
    return { ok: true, threadId, status: String(evidence && evidence.status || '') };
  }

  async getThreadRuntime(threadId) {
    const current = await this.cdp.evaluate(`(() => {
      const row = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]');
      return { threadId: row ? row.getAttribute('data-app-action-sidebar-thread-id') : '' };
    })()`);
    if (!current || current.threadId !== `local:${threadId}`) return { state: 'unknown', threadId };
    const composer = await this.composerReader();
    if (!composer || !composer.found) return { state: 'unknown', threadId };
    return { state: composer.action === 'stop' ? 'running' : composer.action === 'send' ? 'idle' : 'unknown', threadId };
  }
}

module.exports = {
  CodexDesktopUiController,
  controlError,
};
