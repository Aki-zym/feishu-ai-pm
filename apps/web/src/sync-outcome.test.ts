import { describe, expect, it } from 'vitest';
import { normalizeHealth, normalizeLogResponse, normalizeLogRows, normalizeSyncOperation, shortDiagnosticId } from './observability';
import { syncOutcomeSummary, syncOutcomeTone, type SyncEnvelope } from './sync-outcome';

function validSource(status: string, counts: Record<string, number> = {}, error_code: string | null = null) {
  const normalized = status === 'partial_success' ? 'partial' : status;
  const safeErrorCode = error_code ?? (normalized === 'partial' ? 'FEISHU_SYNC_PARTIAL' : normalized === 'failure' ? 'FEISHU_SYNC_FAILED' : normalized === 'skipped' ? 'OBS_ADAPTER_UNAVAILABLE' : null);
  return {
    source: 'calendar', status, counts, duration_ms: 12, error_code: safeErrorCode,
    reason: safeErrorCode, message: 'fixed backend text',
    next_retry_at: normalized === 'success' ? null : '2026-08-18T00:01:00.000Z',
    stale: normalized !== 'success',
  };
}

function validDependencies(overrides: Record<string, string> = {}) {
  return Object.fromEntries(['token', 'freshness', 'backoff', 'disk'].map((name) => [name, {
    status: overrides[name] ?? 'ready', error_code: null, observed_at: '2026-08-18T00:00:00.000Z', details: {},
  }]));
}

function validEnvelope(outcome: SyncEnvelope['outcome'], counts: Record<string, number>, skipped = false): SyncEnvelope {
  const errorCode = outcome === 'partial_success' ? 'FEISHU_SYNC_PARTIAL' : outcome === 'failure' ? 'FEISHU_SYNC_FAILED' : outcome === 'skipped' ? 'OBS_ADAPTER_UNAVAILABLE' : null;
  return {
    operation_id: '11111111-1111-4111-8111-111111111111',
    request_id: '22222222-2222-4222-8222-222222222222',
    trace_id: '33333333-3333-4333-8333-333333333333',
    parent_span_id: null,
    span_id: '44444444-4444-4444-8444-444444444444',
    outcome,
    duration_ms: 12,
    sources: [validSource(outcome, counts, errorCode)],
    messages: counts.messages ?? 0,
    failures: counts.failures ?? 0,
    skipped,
  };
}

describe('sync outcome UI contract', () => {
  it.each([
    [validEnvelope('success', { messages: 3 }), 'success（成功）', 'success'],
    [validEnvelope('partial_success', { messages: 2, failures: 1 }), 'partial_success（部分成功）', 'warning'],
    [validEnvelope('skipped', {}, true), 'skipped（已跳过）', 'warning'],
    [validEnvelope('failure', { failures: 5 }), 'failure（失败）', 'error'],
  ] as Array<[SyncEnvelope, string, ReturnType<typeof syncOutcomeTone>]>)('shows $outcome explicitly', (result, label, tone) => {
    expect(syncOutcomeSummary(result)).toContain(label);
    expect(syncOutcomeTone(result.outcome)).toBe(tone);
  });

  it('maps the backend partial_success contract to the UI partial state', () => {
    const operation = normalizeSyncOperation({
      operation_id: 'operation-partial-01',
      request_id: 'request-partial-01',
      outcome: 'partial_success',
      duration_ms: 12,
      sources: [validSource('partial_success', { calendars: 2, failures: 1 }, 'FEISHU_SYNC_PARTIAL')],
    });
    expect(operation.outcome).toBe('partial');
    expect(operation.sources[0]).toMatchObject({ outcome: 'partial', source: 'calendar', message: '该来源部分成功；失败项已保留供后续重试。' });
  });

  it('fails closed for unknown outcome and readiness reason without exposing raw text', () => {
    const sync = normalizeSyncOperation({ outcome: 'future_state', duration_ms: 1, sources: [{ source: 'calendar', status: 'future_state', counts: {}, duration_ms: 1, error_code: null, message: 'raw-provider-secret' }] });
    expect(sync).toMatchObject({ outcome: 'failure', invalid: true, sources: [] });

    const health = normalizeHealth({
      liveness: { status: 'unknown-live' },
      readiness: { status: 'future_readiness', reasons: [{ code: 'RAW_PROVIDER_SECRET', message: 'do not display' }] },
    });
    expect(health).toMatchObject({ liveness: 'unknown', readiness: 'not_ready', invalid: true });
    expect(health.reasons[0]).toEqual({ code: 'OBS_HEALTH_UNAVAILABLE', message: '健康状态暂时无法确认。' });
    expect(JSON.stringify(health)).not.toMatch(/RAW_PROVIDER_SECRET|do not display/u);
  });

  it('accepts only controlled IDs, release identities, source names, and error codes', () => {
    const canary = 'SECRET_CANARY_58';
    const operation = normalizeSyncOperation({
      operation_id: canary,
      request_id: 'not-an-internal-id',
      outcome: 'failure',
      release: { app_version: canary, build_identity: canary, redaction_schema_version: canary },
      sources: [
        { source: canary, status: 'failure', counts: { failures: 1 }, duration_ms: 1, error_code: canary, message: canary },
        { source: 'calendar', status: 'failure', counts: { failures: 1 }, duration_ms: 1, error_code: canary, message: canary },
      ],
      duration_ms: 1,
    });

    expect(operation).toMatchObject({ outcome: 'failure', invalid: true, sources: [] });
    expect(JSON.stringify(operation)).not.toContain(canary);
    expect(shortDiagnosticId(canary)).toBe('未提供');
    expect(shortDiagnosticId('11111111-1111-4111-8111-111111111111')).toBe('11111111');
  });

  it('keeps valid semver, commit hash, and schema version values', () => {
    const operation = normalizeSyncOperation({
      operation_id: '11111111-1111-4111-8111-111111111111',
      request_id: '22222222-2222-4222-8222-222222222222',
      outcome: 'success',
      release: { app_version: '0.2.0', build_identity: '0123456789abcdef0123456789abcdef01234567', redaction_schema_version: '1' },
      sources: [validSource('success', { calendars: 1 })],
      duration_ms: 1,
    });

    expect(operation).toMatchObject({
      operation_id: '11111111-1111-4111-8111-111111111111',
      request_id: '22222222-2222-4222-8222-222222222222',
      release: { app_version: '0.2.0', build_identity: '0123456789abcdef0123456789abcdef01234567', redaction_schema_version: '1' },
    });
  });

  it('marks missing and malformed readiness shapes invalid while using fixed fallback text', () => {
    expect(normalizeHealth({ liveness: { status: 'alive' } })).toMatchObject({ readiness: 'not_ready', invalid: true });
    expect(normalizeHealth({ readiness: { status: 'ready', reasons: 'SECRET_CANARY_REASONS' } })).toMatchObject({ readiness: 'not_ready', invalid: true, reasons: [{ code: 'OBS_HEALTH_UNAVAILABLE', message: '健康状态暂时无法确认。' }] });
    const malformed = normalizeHealth({ readiness: { status: 'ready', reasons: [null, { code: 'SECRET_CANARY_REASON', message: 'SECRET_CANARY_MESSAGE' }] } });
    expect(malformed).toMatchObject({ readiness: 'not_ready', invalid: true });
    expect(malformed.reasons).toEqual([{ code: 'OBS_HEALTH_UNAVAILABLE', message: '健康状态暂时无法确认。' }]);
    expect(JSON.stringify(malformed)).not.toMatch(/SECRET_CANARY/u);
  });

  it('keeps a valid readiness envelope valid and preserves only fixed reason text', () => {
    const health = normalizeHealth({
      liveness: { status: 'alive' },
      readiness: { status: 'degraded', reasons: [{ code: 'SOURCE_PARTIAL', message: 'SECRET_CANARY_REASON_MESSAGE' }] },
      dependencies: validDependencies({ freshness: 'degraded' }),
    });
    expect(health).toMatchObject({ readiness: 'degraded', invalid: false, liveness: 'alive' });
    expect(health.reasons).toEqual([{ code: 'SOURCE_PARTIAL', message: '至少一个已启用信息源只能部分工作。' }]);
    expect(JSON.stringify(health)).not.toContain('SECRET_CANARY');
  });

  it('does not treat health failure as a successful old snapshot', () => {
    const old = normalizeHealth({ liveness: { status: 'alive' }, readiness: { status: 'ready', reasons: [] }, dependencies: validDependencies(), timestamp: '2026-08-15T00:00:00.000Z' });
    const failed = normalizeHealth(null);
    expect(old.readiness).toBe('ready');
    expect(failed.readiness).toBe('not_ready');
    expect(failed.invalid).toBe(true);
  });

  it.each([
    ['degraded', []],
    ['not_ready', []],
    ['degraded', [{ code: 'UNKNOWN_REASON', message: 'do not display' }]],
    ['not_ready', [{ code: 'SOURCE_PARTIAL', message: 'safe' }, { code: 'UNKNOWN_REASON', message: 'do not display' }]],
  ] as Array<[string, unknown[]]>)('requires allowlisted non-empty reasons for %s readiness', (status, reasons) => {
    const health = normalizeHealth({ readiness: { status, reasons }, dependencies: validDependencies() });
    expect(health).toMatchObject({ readiness: 'not_ready', invalid: true, reasons: [{ code: 'OBS_HEALTH_UNAVAILABLE', message: '健康状态暂时无法确认。' }] });
  });

  it('renders only allowlisted runtime event labels and never raw log fields', () => {
    const canary = 'SECRET_CANARY_LOG_58';
    const rows = normalizeLogRows({ logs: [
      { category: 'runtime', level: 'error', event_type: 'feishu.sync.completed', summary: canary, context_json: canary, created_at: '2026-08-16T00:00:00.000Z' },
      { category: 'runtime', level: 'info', event_type: canary, summary: canary, created_at: canary },
    ] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ event_type: 'feishu.sync.completed', event_label: '信息源同步已结束', message: '信息源同步已结束' });
    expect(rows[1]).toMatchObject({ event_type: 'OBS_UNKNOWN_EVENT', event_label: '已记录一条受控运行事件。', created_at: null });
    expect(JSON.stringify(rows)).not.toContain(canary);
  });

  it('fails closed for missing, non-array, empty, or all-rejected sources', () => {
    for (const payload of [
      { outcome: 'success', duration_ms: 1 },
      { outcome: 'success', duration_ms: 1, sources: 'not-an-array' },
      { outcome: 'success', duration_ms: 1, sources: [] },
      { outcome: 'success', duration_ms: 1, sources: [{ ...validSource('success'), source: 'unknown-source' }] },
      { outcome: 'success', duration_ms: 1, sources: [{ ...validSource('success'), unknown_field: 'SECRET_CANARY' }] },
    ]) {
      expect(normalizeSyncOperation(payload)).toMatchObject({ outcome: 'failure', invalid: true, sources: [] });
    }
  });

  it('cross-checks aggregate outcome and optional totals against every normalized source', () => {
    const source = (status: string, counts: Record<string, number> = {}) => ({ ...validSource(status, counts), source: status === 'success' ? 'calendar' : 'minutes' });
    const valid = (outcome: string, sources: Array<Record<string, unknown>>, totals: Record<string, unknown> = {}) => normalizeSyncOperation({ outcome, duration_ms: 1, sources, ...totals });

    expect(valid('success', [source('success', { messages: 1 }), source('success', { events: 2 })], { messages: 3 })).toMatchObject({ outcome: 'success', invalid: false });
    expect(valid('skipped', [source('skipped'), source('skipped')], { skipped: true })).toMatchObject({ outcome: 'skipped', invalid: false });
    expect(valid('failure', [source('failure', { failures: 1 }), source('skipped')], { failures: 1, skipped: false })).toMatchObject({ outcome: 'failure', invalid: false });
    expect(valid('partial_success', [source('success'), source('failure', { failures: 1 })], { failures: 1 })).toMatchObject({ outcome: 'partial', invalid: false });
    expect(valid('partial_success', [source('success'), source('skipped')])).toMatchObject({ outcome: 'partial', invalid: false });

    for (const payload of [
      valid('success', [source('success'), source('failure', { failures: 1 })]),
      valid('partial_success', [source('success'), source('success')]),
      valid('failure', [source('failure', { failures: 1 }), source('skipped')], { failures: 0 }),
      valid('success', [source('success', { messages: 1 })], { messages: 2 }),
      valid('skipped', [source('skipped')], { skipped: false }),
    ]) {
      expect(payload).toMatchObject({ outcome: 'failure', invalid: true, sources: [] });
    }
  });

  it('rejects contradictory source status, stale, error, and retry combinations', () => {
    const cases: Array<Record<string, unknown> & { status: string; counts?: Record<string, number> }> = [
      { status: 'success', stale: true },
      { status: 'success', next_retry_at: '2026-08-18T00:01:00.000Z' },
      { status: 'success', error_code: 'FEISHU_SYNC_FAILED' },
      { status: 'partial_success', stale: false, reason: 'FEISHU_SYNC_PARTIAL', error_code: 'FEISHU_SYNC_PARTIAL', next_retry_at: '2026-08-18T00:01:00.000Z', counts: { messages: 1, failures: 1 } },
      { status: 'failure', stale: true, reason: 'FEISHU_SYNC_FAILED', error_code: 'FEISHU_SYNC_FAILED', next_retry_at: null, counts: { failures: 1 } },
    ];
    for (const patch of cases) {
      const source = { ...validSource(patch.status, patch.counts ?? (patch.status === 'failure' ? { failures: 1 } : {})), ...patch };
      expect(normalizeSyncOperation({ outcome: patch.status === 'partial_success' ? 'partial_success' : patch.status, duration_ms: 1, sources: [source] })).toMatchObject({ invalid: true, outcome: 'failure', sources: [] });
    }
  });

  it('fails closed when required readiness dependency state is unknown or absent', () => {
    for (const name of ['token', 'freshness', 'backoff', 'disk']) {
      const dependencies = validDependencies({ [name]: 'unknown' });
      expect(normalizeHealth({ readiness: { status: 'ready', reasons: [] }, dependencies })).toMatchObject({ readiness: 'not_ready', invalid: true, reasons: [{ code: 'OBS_HEALTH_UNAVAILABLE' }] });
    }
    expect(normalizeHealth({ readiness: { status: 'ready', reasons: [] } })).toMatchObject({ readiness: 'not_ready', invalid: true, reasons: [{ code: 'OBS_HEALTH_UNAVAILABLE' }] });
  });

  it.each([
    ['string', '3'],
    ['boolean', true],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
  ])('rejects %s count values without coercion', (_label, count) => {
    expect(normalizeSyncOperation({ outcome: 'success', duration_ms: 1, sources: [{ ...validSource('success'), counts: { messages: count } }] })).toMatchObject({ outcome: 'failure', invalid: true });
    expect(normalizeSyncOperation({ outcome: 'success', duration_ms: 1, messages: count, sources: [validSource('success')] })).toMatchObject({ outcome: 'failure', invalid: true });
  });

  it('rejects unknown count keys at both operation and source boundaries', () => {
    expect(normalizeSyncOperation({ outcome: 'success', duration_ms: 1, sources: [{ ...validSource('success'), counts: { messages: 1, unknown: 2 } }] })).toMatchObject({ outcome: 'failure', invalid: true });
    expect(normalizeSyncOperation({ outcome: 'success', duration_ms: 1, unknown: 2, sources: [validSource('success')] })).toMatchObject({ outcome: 'failure', invalid: true });
  });

  it('projects every logs response section to fixed safe values', () => {
    const canary = 'refresh_token app_secret client_secret Bearer plain-error SECRET_CANARY_ID';
    const safe = normalizeLogResponse({
      logs: [{ id: canary, category: 'runtime', level: 'error', event_type: 'unknown-event', summary: canary, context_json: canary, created_at: canary }],
      health: [{ integration: canary, status: canary, message: canary, latency_ms: '3', checked_at: canary }],
      decisions: [{ id: canary, provider: canary, model: canary, prompt_version: canary, used_fallback: 'true', fallback_mode: canary, input_char_count: canary }],
      corrections: [{ id: canary, correction_type: canary, note: canary, candidate_id: canary, task_id: canary, created_at: canary }],
      unknown_field: canary,
    });
    expect(safe.invalid).toBe(true);
    expect(safe.health[0]).toMatchObject({ integration: 'unknown', status: 'unknown', status_label: '未提供', message: '连接状态暂未提供安全说明。', latency_ms: null, checked_at: null });
    expect(safe.decisions[0]).toMatchObject({ provider: '已记录', model: '已记录', prompt_version: '已记录', used_fallback: false, fallback_mode: '未知模式', input_char_count: null });
    expect(safe.corrections[0]).toMatchObject({ correction_type: 'unknown', correction_label: '未提供安全说明', note: '有备注', created_at: null });
    expect(JSON.stringify(safe)).not.toContain(canary);
  });

  it('does not render unknown primitive log details or secret/provider canaries', () => {
    const safe = normalizeLogRows({ logs: [{
      category: 'runtime', level: 'warn', event_type: 'feishu.sync.completed',
      details: {
        outcome: 'partial_success', unknownFutureField: 'future-secret',
        provider: 'provider-secret', reason: 'FEISHU_SYNC_PARTIAL',
      },
    }] });
    expect(safe).toHaveLength(1);
    expect(safe[0]?.details).toEqual({ outcome: 'partial_success', reason: 'FEISHU_SYNC_PARTIAL' });
    expect(JSON.stringify(safe)).not.toMatch(/future-secret|provider-secret|unknownFutureField/u);
  });
});
