const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inspectCodexDesktopCompatibility,
} = require('../../desktop/src/codex-desktop-compatibility-report');

function createCdp(result) {
  const calls = [];
  return {
    calls,
    connect: async () => calls.push('connect'),
    evaluate: async () => result,
    close: () => calls.push('close'),
  };
}

test('任意官方版本通过页面结构检测后均可控制', async () => {
  const cdp = createCdp({ threadRows: 4, editor: true, action: true });
  const result = await inspectCodexDesktopCompatibility({
    debugPort: 9230,
    processManager: {
      inspect: async () => ({
        app: { version: '26.810.4967.0' },
        mainProcess: { pid: 1234 },
      }),
    },
    cdpFactory: () => cdp,
    now: () => new Date('2026-08-15T10:00:00.000Z'),
  });

  assert.equal(result.version, '26.810.4967.0');
  assert.equal(result.pageCompatible, true);
  assert.equal(result.compatible, true);
  assert.equal(result.status, 'compatible');
  assert.equal(result.contractId, 'codex-desktop-structural-v1');
  assert.deepEqual(cdp.calls, ['connect', 'close']);
});

test('官方版本保留在报告中但不参与控制结论', async () => {
  const cdp = createCdp({ threadRows: 24, editor: true, action: true });
  const result = await inspectCodexDesktopCompatibility({
    debugPort: 9230,
    processManager: {
      inspect: async () => ({
        app: { version: '26.810.7004.0' },
        mainProcess: { pid: 25396 },
      }),
    },
    cdpFactory: () => cdp,
  });

  assert.equal(result.version, '26.810.7004.0');
  assert.equal(result.contractId, 'codex-desktop-structural-v1');
  assert.equal(result.pageCompatible, true);
  assert.equal(result.compatible, true);
  assert.equal(result.status, 'compatible');
});

test('兼容性检测保留 CDP 失败阶段和错误码', async () => {
  const cdp = createCdp(null);
  cdp.connect = async () => {
    throw Object.assign(new Error('未找到页面目标'), { code: 'CDP_TARGET_NOT_FOUND' });
  };
  const result = await inspectCodexDesktopCompatibility({
    debugPort: 9230,
    processManager: {
      inspect: async () => ({
        app: { version: '26.810.4967.0' },
        mainProcess: { pid: 1234 },
      }),
    },
    cdpFactory: () => cdp,
  });

  assert.equal(result.compatible, false);
  assert.equal(result.stage, 'cdp');
  assert.equal(result.errorCode, 'CDP_TARGET_NOT_FOUND');
  assert.match(result.message, /未找到页面目标/);
  assert.equal(result.cdpConnected, false);
  assert.equal(result.threadRows, 0);
  assert.equal(result.editor, false);
  assert.equal(result.action, false);
  assert.deepEqual(cdp.calls, ['close']);
});

test('应用包检测失败仍返回字段完整的可复制报告', async () => {
  const result = await inspectCodexDesktopCompatibility({
    debugPort: 9230,
    processManager: {
      inspect: async () => {
        throw Object.assign(new Error('没有安装官方客户端'), { code: 'CODEX_PACKAGE_NOT_FOUND' });
      },
    },
    now: () => new Date('2026-08-15T10:00:00.000Z'),
  });

  assert.deepEqual(Object.keys(result).sort(), [
    'action',
    'cdpConnected',
    'checkedAt',
    'compatible',
    'contractId',
    'debugPort',
    'editor',
    'errorCode',
    'message',
    'pageCompatible',
    'pid',
    'stage',
    'status',
    'threadRows',
    'version',
  ]);
  assert.equal(result.stage, 'package');
  assert.equal(result.errorCode, 'CODEX_PACKAGE_NOT_FOUND');
});
