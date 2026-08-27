import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PmService } from '../../src/service.js';

export type SimulatedMessageRouteGuard = {
  testOnly: true;
  nodeEnv: string;
  databaseProvider: string;
  databaseUrl: string;
};

/**
 * Test-only source fixture. This module lives outside src/ so production
 * builds cannot register the route by importing the formal app factory. The
 * guard is intentionally fail-closed: a caller must prove that this is the
 * test environment backed by in-memory SQLite before the route is registered.
 */
export function registerSimulatedMessageRoute(app: FastifyInstance, service: PmService, guard: SimulatedMessageRouteGuard) {
  if (
    guard.testOnly !== true
    || guard.nodeEnv !== 'test'
    || guard.databaseProvider !== 'sqlite'
    || guard.databaseUrl !== ':memory:'
  ) {
    throw new Error('模拟消息测试入口只允许在 test + sqlite :memory: 装配中注册。');
  }

  app.post('/api/dev/simulate-message', async (request) => {
    const body = z
      .object({
        externalId: z.string().min(1).default(() => 'demo-' + crypto.randomUUID()),
        sourceType: z.enum(['bot_dm', 'owner_dm', 'group', 'calendar', 'meeting', 'manual']).default('owner_dm'),
        conversationId: z.string().min(1).default('demo-conversation'),
        senderId: z.string().min(1).default('demo-sender'),
        senderName: z.string().min(1).default('需求方'),
        content: z.string().min(1),
        occurredAt: z.string().datetime().default(() => new Date().toISOString()),
        ownerMentioned: z.boolean().optional(),
        sourceUrl: z.string().url().optional(),
        completeness: z.enum(['complete', 'partial', 'limited']).optional(),
        discoveryReason: z.string().max(500).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(request.body);
    const windowId = `simulated:${body.externalId}`;
    const sourceKey = `simulated:${body.externalId}`;
    const result = service.processCindyIntake({
      window_id: windowId,
      window_start: body.occurredAt,
      window_end: body.occurredAt,
      result_kind: 'intake',
      sources: [{
        source_key: sourceKey,
        source_kind: undefined,
        conversation_key: body.conversationId,
        sender_role: body.senderName,
        text: body.content,
        occurred_at: body.occurredAt,
      }],
      proposals: [{
        action: 'create_candidate',
        source_keys: [sourceKey],
        title: body.content.slice(0, 160),
        describe: body.content.slice(0, 2000),
        reason: '模拟消息测试。',
      }],
    });
    return { external_id: body.externalId, ...result };
  });
}
