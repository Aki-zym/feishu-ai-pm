import { describe, expect, it } from 'vitest';
import { DatabaseUpgradeError } from '../../server/src/database.js';
import { formatBootstrapFailure } from './startup-errors.js';

describe('desktop bootstrap failure boundary', () => {
  it('shows only the controlled database stage and message', () => {
    const error = new DatabaseUpgradeError('ledger', '数据库不符合受支持的完整历史 schema；已拒绝升级或恢复。');
    const message = formatBootstrapFailure(error);
    expect(message).toContain('ledger');
    expect(message).toContain('数据库不符合受支持的完整历史 schema');
    expect(message).not.toContain('C:\\');
    expect(message).not.toContain('SQLite Error');
  });

  it('uses a fixed redacted message for unknown errors', () => {
    const message = formatBootstrapFailure(new Error('D:\\canary\\secret.sqlite: SQLITE_CORRUPT raw details'));
    expect(message).toBe('TooManyTasks 无法启动，请查看脱敏诊断日志。应用将退出。');
    expect(message).not.toContain('canary');
    expect(message).not.toContain('secret.sqlite');
    expect(message).not.toContain('SQLITE_CORRUPT');
  });
});
