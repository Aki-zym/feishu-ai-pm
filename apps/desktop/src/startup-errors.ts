import { DatabaseUpgradeError } from '../../server/src/database.js';

/**
 * Convert a bootstrap failure to a bounded user-facing message. Database
 * errors already carry a controlled stage/message; all other failures use a
 * fixed fallback so paths, SQLite/OS text and secrets never cross the desktop
 * boundary.
 */
export function formatBootstrapFailure(error: unknown) {
  if (error instanceof DatabaseUpgradeError) {
    return `数据库启动失败（${error.stage}）：${error.message}`;
  }
  return '数据 PM 无法启动，请查看脱敏诊断日志。应用将退出。';
}
