import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deriveCindyAuthContext } from '../../src/cindy-source.js';
import type { PmService } from '../../src/service.js';

export type SeedIntakeRouteGuard = {
  testOnly: true;
  nodeEnv: string;
  databaseProvider: string;
  databaseUrl: string;
};

const seedAuth = deriveCindyAuthContext({
  accountAnchor: 'test-only-seed-account-anchor',
  receiptSecret: 'test-only-seed-receipt-secret-0123456789abcdef0123456789abcdef',
});

const seedIntakeBodySchema = z.object({
  title: z.string().trim().min(1).max(160),
  describe: z.string().trim().min(1).max(2_000).optional(),
  background: z.string().trim().min(1).max(8_000).optional(),
}).strict();

/** Test-only browser fixture. Production buildApp never registers this route. */
export function registerSeedIntakeRoute(app: FastifyInstance, service: PmService, guard: SeedIntakeRouteGuard) {
  if (
    guard.testOnly !== true
    || guard.nodeEnv !== 'test'
    || guard.databaseProvider !== 'sqlite'
    || guard.databaseUrl !== ':memory:'
  ) {
    throw new Error('模拟需求入口只允许在 test + sqlite :memory: 装配中注册。');
  }

  app.post('/api/dev/seed-intake', async (request, reply) => {
    const remoteAddress = request.socket.remoteAddress ?? request.ip;
    const normalizedAddress = remoteAddress?.replace(/^::ffff:/u, '').replace(/^\[|\]$/gu, '').split('%')[0];
    if (normalizedAddress !== '127.0.0.1' && normalizedAddress !== '::1') {
      return reply.code(403).send({ error: '模拟需求入口只接受本机回环请求。' });
    }
    try {
      const body = seedIntakeBodySchema.parse(request.body);
      const nonce = randomUUID();
      const occurredAt = new Date().toISOString();
      const saved = service.saveCindySources(seedAuth, {
        save_request_id: `test-seed-save-${nonce}`,
        sources: [{
          client_ref: 'seed',
          provider: 'synthetic',
          source_kind: 'synthetic_message',
          stable_message_id: `test-seed-message-${nonce}`,
          occurred_at: occurredAt,
          conversation_key: `test-seed-conversation-${nonce}`,
          sender_role: '测试模拟需求',
          text: body.background ?? body.describe ?? body.title,
          revision: { sequence: 0 },
        }],
      });
      const sourceReceipt = saved.sources[0]!.source_receipt;
      const result = service.processCindyDecisions(seedAuth, {
        decision_request_id: `test-seed-decision-${nonce}`,
        window_id: `test-seed-window-${nonce}`,
        window_start: occurredAt,
        window_end: occurredAt,
        decisions: [{
          decision_ref: 'candidate',
          action: 'create_candidate',
          source_receipts: [sourceReceipt],
          title: body.title,
          ...(body.describe === undefined ? {} : { describe: body.describe }),
          reason: '浏览器 HTML 测试模拟需求。',
        }],
      });
      const candidateId = result.decisions[0]?.candidate_id;
      if (!candidateId) return reply.code(500).send({ error: '模拟需求未生成候选。' });
      return { candidate_id: candidateId, source_receipt: sourceReceipt };
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '模拟需求写入失败。' });
    }
  });
}
