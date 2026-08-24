import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OwnerDecisionInbox } from './CandidatesPage';
import type { CindyOwnerDecision } from '../types';

describe('owner decision private projection', () => {
  it('只渲染安全摘要，append 保持不可用且不显示技术字段或原始错误', () => {
    const decision = {
      decision_id: 'cindy_owner_decision_00000000-0000-0000-0000-000000000001',
      status: 'pending',
      version: 1,
      reason_summary: '需要确认是否在后续版本追加。',
      options: [{
        option_key: 'append',
        action: 'append_candidate',
        title: '追加到已有候选',
        describe: null,
        next_step: null,
        available: false,
      }],
      source_count: 1,
      last_attempt_failed: true,
      resolution_action: null,
      resolved_candidate_id: null,
      created_at: '2026-08-24T00:00:00.000Z',
      updated_at: '2026-08-24T00:00:00.000Z',
      resolved_at: null,
      batch_id: 'CANARY_BATCH_ID',
      last_error: 'CANARY_RAW_SQLITE_ERROR',
      source_revision_id: 'CANARY_SOURCE_REVISION',
      receipt: 'CANARY_RECEIPT',
      prompt: 'CANARY_PROMPT',
      reasoning: 'CANARY_REASONING',
      body: 'CANARY_SOURCE_BODY',
    } as CindyOwnerDecision & Record<string, unknown>;

    const markup = renderToStaticMarkup(<OwnerDecisionInbox
      decisions={[decision]}
      busy=""
      onResolve={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(markup).toContain('等待后续追加能力');
    expect(markup).toContain('上次执行未完成，请稍后重试。');
    expect(markup).not.toContain('确认跳过');
    expect(markup).not.toContain('建立候选</button>');
    expect(markup).not.toMatch(/CANARY_BATCH_ID|CANARY_RAW_SQLITE_ERROR|CANARY_SOURCE_REVISION|CANARY_RECEIPT|CANARY_PROMPT|CANARY_REASONING|CANARY_SOURCE_BODY/u);
  });
});
