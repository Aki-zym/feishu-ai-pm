import { normalizeSyncOperation, syncOutcomeLabel, syncOutcomeMessage, syncOutcomeTone, type RawSyncOutcome, type SyncOperation, type SyncOutcome } from './observability';

export type SyncEnvelope = {
  outcome: RawSyncOutcome;
  duration_ms: number;
  sources: unknown[];
  operation_id?: string | null;
  request_id?: string | null;
  trace_id?: string | null;
  parent_span_id?: string | null;
  span_id?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  release?: unknown;
  messages?: number;
  failures?: number;
  skipped?: boolean;
};

export { normalizeSyncOperation, shortDiagnosticId, syncOutcomeLabel, syncOutcomeMessage, syncOutcomeTone, syncSourceLabel } from './observability';
export type { RawSyncOutcome, SyncOperation, SyncOutcome };

export function syncOutcomeSummary(result: SyncEnvelope | SyncOperation, sourceName?: string) {
  const operation = 'invalid' in result ? result : normalizeSyncOperation(result);
  const prefix = sourceName ? `${sourceName}：` : '个人信息流：';
  const count = operation.sources.reduce((sum, source) => sum + (source.counts.messages ?? source.counts.events ?? source.counts.minutes ?? 0), 0);
  const explicitOutcome = operation.outcome === 'partial' ? 'partial_success（部分成功）' : `${operation.outcome}（${operation.outcome === 'success' ? '成功' : operation.outcome === 'skipped' ? '已跳过' : '失败'}）`;
  return `${prefix}${explicitOutcome}，${syncOutcomeMessage(operation.outcome)}${count ? ` 共处理 ${count} 条来源。` : ''}`;
}
