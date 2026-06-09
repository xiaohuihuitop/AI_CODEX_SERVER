const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

function resolveAsarUnpackedPath(filePath) {
  return String(filePath).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

class WindowsCodexController {
  /**
   * 创建 Windows Codex Desktop 控制器。
   *
   * @param {{scriptPath?: string}} options 控制脚本配置。
   */
  constructor(options = {}) {
    this.scriptPath = resolveAsarUnpackedPath(options.scriptPath || path.join(__dirname, '..', 'scripts', 'win-codex-control.ps1'));
  }

  /**
   * 运行 Windows 控制脚本。
   *
   * @param {string} action 控制动作。
   * @param {string[]} args 额外参数。
   * @returns {Promise<{stdout: string, stderr: string}>} 脚本输出。
   */
  run(action, args = []) {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.scriptPath,
        '-Action',
        action,
        ...args,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => { stdout += data.toString(); });
      child.stderr.on('data', data => { stderr += data.toString(); });
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(Object.assign(new Error(stderr.trim() || `Windows Codex 控制失败：${action}`), { code, stdout, stderr }));
      });
    });
  }

  /**
   * 发送文本到指定 Codex Desktop 线程。
   *
   * @param {{projectName: string, threadName: string}} target 线程控制目标。
   * @param {string} text 输入文本。
   * @returns {Promise<{stdout: string, stderr: string}>} 脚本输出。
   */
  async sendToThread(target, text) {
    const file = path.join(os.tmpdir(), `codex-windows-bridge-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`);
    fs.writeFileSync(file, String(text || ''), 'utf8');
    try {
      return await this.run('send-thread', [
        '-ProjectName',
        target.projectName,
        '-ThreadName',
        target.threadName,
        '-TextFile',
        file,
      ]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  /**
   * 读取 Codex Desktop 当前打开的线程。
   *
   * @returns {Promise<Array<{projectName: string, threadName: string}>>} 打开线程列表。
   */
  async listOpenThreads() {
    const result = await this.run('list-open-threads');
    return JSON.parse(result.stdout || '[]');
  }

  /**
   * 向 Codex Desktop 发送停止回复指令。
   *
   * @returns {Promise<{stdout: string, stderr: string}>} 脚本输出。
   */
  stopResponse() {
    return this.run('stop');
  }
}

module.exports = {
  WindowsCodexController,
  resolveAsarUnpackedPath,
};
