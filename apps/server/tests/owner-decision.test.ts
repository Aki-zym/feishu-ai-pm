import { describe, expect, it } from 'vitest';
import type { OwnerIntentDecision } from '../src/domain.js';
import { decideOwnerIntent, isOwnerDecisionSource, selectOwnerDecisionTarget, type OwnerDecisionTarget } from '../src/owner-decision.js';

const baseTarget: OwnerDecisionTarget = {
  candidateId: 'cand-1',
  candidateState: 'accepted',
  acceptedTaskId: 'task-1',
  threadId: 'thread-1',
  taskId: 'task-1',
  taskStatus: 'unplanned',
  taskVersion: 3,
  threadVersion: 2,
  sourceMatched: true,
};

const ownerMetadata = { isOwnerMessage: true, senderRole: 'owner' };
const trustedOwnerIds = ['owner-open'];

function intent(action: OwnerIntentDecision['action'], overrides: Partial<OwnerIntentDecision> = {}): OwnerIntentDecision {
  return {
    action,
    confidence: 0.98,
    summary: '测试主人判断',
    delegateTo: null,
    scheduleText: null,
    evidence: ['原消息证据'],
    reason: '测试原因',
    ...overrides,
  };
}

describe('owner decision policy', () => {
  it('只接受服务端确认的主人身份标记，不信任名字', () => {
    expect(isOwnerDecisionSource(ownerMetadata, 'owner-open', trustedOwnerIds)).toBe(true);
    expect(isOwnerDecisionSource(ownerMetadata, 'spoofed-open', trustedOwnerIds)).toBe(false);
    expect(isOwnerDecisionSource({ senderName: '系统主人' }, 'owner-open', trustedOwnerIds)).toBe(false);
    expect(isOwnerDecisionSource({ contextOnly: true, matchedOwnerOpenId: 'other' }, 'owner-open', trustedOwnerIds)).toBe(false);
  });

  it('多个可能需求时不自动选择第一个', () => {
    const second = { ...baseTarget, candidateId: 'cand-2', taskId: 'task-2', threadId: 'thread-2' };
    expect(selectOwnerDecisionTarget([baseTarget, second])).toMatchObject({ target: null, ambiguous: true });
    expect(decideOwnerIntent({ senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds, intent: intent('continue'), targets: [baseTarget, second] }))
      .toMatchObject({ eligible: false, disposition: 'review', target: null });
  });

  it('主人承接需求时把未排期任务推进到进行中', () => {
    const target = { ...baseTarget, taskStatus: 'unplanned' as const };
    const result = decideOwnerIntent({ senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds, intent: intent('continue', { summary: '我来做吧。' }), targets: [target] });
    expect(result).toMatchObject({ eligible: true, disposition: 'apply_task_patch', patch: { status: 'in_progress', waitingReason: null } });
  });

  it('主人确认明确交付日期时只写入可解析的私人计划', () => {
    const result = decideOwnerIntent({
      senderId: 'owner-open',
      metadata: ownerMetadata,
      trustedOwnerIds,
      intent: intent('confirm_schedule', { scheduleText: '下周一给到' }),
      targets: [baseTarget],
      schedule: { sourceText: '下周一给到', startAt: null, dueAt: '2026-08-17T15:59:59.999Z', needsConfirmation: false },
    });
    expect(result).toMatchObject({ eligible: true, patch: { status: 'planned', plannedDueAt: '2026-08-17T15:59:59.999Z' } });
  });

  it('待确认候选收到主人明确交付日期时一次承接并写入计划', () => {
    const target = {
      ...baseTarget,
      candidateState: 'pending' as const,
      acceptedTaskId: null,
      taskId: null,
      taskStatus: null,
      taskVersion: null,
    };
    const result = decideOwnerIntent({
      senderId: 'owner-open',
      metadata: ownerMetadata,
      trustedOwnerIds,
      intent: intent('confirm_schedule', { summary: '明白，那下周五给吧。', scheduleText: '下周五给' }),
      targets: [target],
      schedule: { sourceText: '下周五给', startAt: null, dueAt: '2026-08-21T15:59:59.999Z', needsConfirmation: false },
    });
    expect(result).toMatchObject({
      eligible: true,
      disposition: 'accept_candidate',
      patch: { status: 'in_progress', plannedStartAt: null, plannedDueAt: '2026-08-21T15:59:59.999Z' },
    });
  });

  it('模糊时间不得自动落库', () => {
    const result = decideOwnerIntent({
      senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds, intent: intent('confirm_schedule'), targets: [baseTarget],
      schedule: { sourceText: '尽快', startAt: null, dueAt: null, needsConfirmation: true },
    });
    expect(result).toMatchObject({ eligible: false, disposition: 'review', patch: {} });
  });

  it('主人索要资料时进入等待状态并记录下一步', () => {
    const result = decideOwnerIntent({ senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds, intent: intent('request_context', { summary: '策划案在哪？' }), targets: [baseTarget] });
    expect(result).toMatchObject({
      eligible: true,
      patch: { status: 'waiting', waitingReason: '策划案在哪？', nextStep: '等待需求方补充必要资料。' },
    });
  });

  it('未接受候选明确拒绝时移出收件箱，但不触碰正式任务', () => {
    const target = { ...baseTarget, candidateState: 'pending' as const, acceptedTaskId: null, taskId: null, taskStatus: null };
    const result = decideOwnerIntent({ senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds, intent: intent('decline', { summary: '不是我负责。' }), targets: [target] });
    expect(result).toMatchObject({ eligible: true, disposition: 'decline_candidate', patch: {} });
  });

  it('转交必须带有来源证据支持的对象', () => {
    const target = { ...baseTarget, candidateState: 'pending' as const, acceptedTaskId: null, taskId: null, taskStatus: null };
    const missing = decideOwnerIntent({ senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds, intent: intent('delegate'), targets: [target] });
    expect(missing).toMatchObject({ eligible: false, disposition: 'review' });
    const delegated = decideOwnerIntent({ senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds, intent: intent('delegate', { delegateTo: '小王' }), targets: [target] });
    expect(delegated).toMatchObject({ eligible: true, disposition: 'delegate_candidate', delegateTo: '小王' });
  });

  it('已接受任务拒绝或转交不会被静默删除', () => {
    const declined = decideOwnerIntent({ senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds, intent: intent('decline'), targets: [baseTarget] });
    const delegated = decideOwnerIntent({ senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds, intent: intent('delegate', { delegateTo: '小王' }), targets: [baseTarget] });
    expect(declined).toMatchObject({ eligible: false, disposition: 'review' });
    expect(delegated).toMatchObject({ eligible: false, disposition: 'review' });
  });

  it('已完成或归档任务不被继续动作重新激活', () => {
    const target = { ...baseTarget, taskStatus: 'completed' as const };
    const result = decideOwnerIntent({ senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds, intent: intent('continue'), targets: [target] });
    expect(result).toMatchObject({ eligible: false, disposition: 'review', patch: {} });
  });

  it('对方消息即使带有 ownerIntent 也不会触发状态动作', () => {
    const result = decideOwnerIntent({
      senderId: 'requester-open', metadata: { senderRole: 'requester', isOwnerMessage: false }, trustedOwnerIds, intent: intent('continue'), targets: [baseTarget],
    });
    expect(result).toMatchObject({ eligible: false, action: 'continue', disposition: 'review', target: null });
  });

  it('低置信主人意图只进入待确认，不自动修改任务', () => {
    const result = decideOwnerIntent({
      senderId: 'owner-open', metadata: ownerMetadata, trustedOwnerIds,
      intent: intent('continue', { confidence: 0.89 }), targets: [baseTarget],
    });
    expect(result).toMatchObject({ eligible: false, disposition: 'review', target: baseTarget, confidence: 0.89 });
    expect(result.reason).toContain('低于自动执行门槛');
  });
});
