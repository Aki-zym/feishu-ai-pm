import { existsSync } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CandidateState, RiskLevel, TaskStatus } from './domain.js';
import { AUDIT_REPLAY_INTENT, type ReplayCapabilityBinding } from './data04.js';
import { CandidateVersionConflictError, CandidateVersionRequiredError, CindyIntakeConflictError, CindyIntakeValidationError, PrivacyAuthorizationError, ReplayAuthorizationError, type PmService } from './service.js';
import { createOperationContext, failedSourceOutcome, operationEnvelope, type SyncSourceName } from './observability.js';
import { assertShanghaiCalendarPlanRange } from './shanghai-time.js';
import {
  candidateActionDtoSchema,
  candidateInboxDtoSchema,
  candidateMergeDtoSchema,
  candidateMergeRejectedDtoSchema,
  candidateReprocessDtoSchema,
  candidateSourceRetryDtoSchema,
  candidateSplitDtoSchema,
  candidateThreadAssociationDtoSchema,
  correctionActionDtoSchema,
  correctionListDtoSchema,
  dashboardDtoSchema,
  minimalCandidateDtoSchema,
  sourceScopeSchema,
  taskListDtoSchema,
  threadListDtoSchema,
} from './source-privacy.js';

const candidateStates = ['pending', 'snoozed', 'ignored', 'accepted'] as const;
const taskStatuses = ['unplanned', 'planned', 'in_progress', 'waiting', 'review', 'completed', 'archived'] as const;
const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const seedIntakeBodySchema = z.object({
  title: z.string().trim().min(1).max(160),
  describe: z.string().trim().min(1).max(2_000).optional(),
  background: z.string().trim().min(1).max(8_000).optional(),
}).strict();

function requestTraceContext(request: FastifyRequest) {
  const header = (name: string) => {
    const value = request.headers[name];
    return typeof value === 'string' && requestIdPattern.test(value) ? value.toLowerCase() : null;
  };
  return { traceId: header('x-trace-id'), parentSpanId: header('x-parent-span-id') };
}

function isLoopbackRequest(request: FastifyRequest) {
  const remoteAddress = request.socket.remoteAddress ?? request.ip;
  const normalizedAddress = remoteAddress?.replace(/^::ffff:/u, '').replace(/^\[|\]$/gu, '').split('%')[0];
  return normalizedAddress === '127.0.0.1' || normalizedAddress === '::1';
}

function candidateMutationError(error: unknown, fallback: string, current?: unknown) {
  const message = error instanceof Error ? error.message : fallback;
  if (error instanceof CandidateVersionRequiredError) {
    return {
      error: message,
      error_code: error.errorCode,
      outcome: 'failure' as const,
      current: current ?? null,
      current_version: null,
    };
  }
  if (error instanceof CandidateVersionConflictError) {
    const currentVersion = current && typeof current === 'object' && 'version' in current && typeof current.version === 'number'
      ? current.version
      : null;
    return {
      error: message,
      error_code: error.errorCode,
      outcome: 'failure' as const,
      current: current ?? null,
      current_version: currentVersion,
    };
  }
  return { error: message, outcome: 'failure' as const };
}
const risks = ['low', 'medium', 'high'] as const;
type SourceFailureListStatus = 'active' | 'all' | 'open' | 'retrying' | 'resolved' | 'ignored' | 'stale';
type SourceFailureListRequest = FastifyRequest<{ Querystring: { status?: SourceFailureListStatus } }>;
type SourceFailureActionRequest = FastifyRequest<{ Params: { id: string } }>;

type BuildAppOptions = {
  webOrigin?: string;
  serveWeb?: boolean;
  webRoot?: string;
  desktopCapability?: LocalActionCapability;
  cindyIntegrationToken?: string;
  runtimeShutdown?: () => Promise<void> | void;
  runtimeRestart?: () => Promise<void> | void;
  logger?: boolean;
};

export type LocalActionCapability = {
  token: string;
  csrfToken: string;
  expiresAt: number;
  origin: 'app://local';
};

/** Non-secret evidence persisted with a privacy deletion binding. */
export type LocalActionCapabilityBinding = ReplayCapabilityBinding;

/** Shared owner-action intent for privacy routes that are not hard deletion. */
export const PRIVACY_OWNER_ACTION_INTENT = 'privacy.owner-action.v1';
export const PRIVACY_DELETION_INTENT = 'privacy.deletion.hard-delete.v1';
export { AUDIT_REPLAY_INTENT };

export function createLocalActionCapability(ttlMs = 15 * 60 * 1_000): LocalActionCapability {
  const now = Date.now();
  return {
    token: `${randomUUID()}${randomUUID()}`,
    csrfToken: `${randomUUID()}${randomUUID()}`,
    expiresAt: now + ttlMs,
    origin: 'app://local',
  };
}

function capabilityBinding(capability: LocalActionCapability): LocalActionCapabilityBinding {
  return {
    tokenHash: createHash('sha256').update(capability.token).digest('hex'),
    csrfTokenHash: createHash('sha256').update(capability.csrfToken).digest('hex'),
    origin: capability.origin,
  };
}

function requirePrivacyCapability(
  request: FastifyRequest,
  reply: FastifyReply,
  capability: LocalActionCapability | undefined,
  expectedIntent: string,
) {
  if (!capability) {
    reply.code(401).send({ error: '此隐私操作只允许受信任桌面主人会话发起。', error_code: 'DESKTOP_CAPABILITY_REQUIRED' });
    return false;
  }
  const token = request.headers['x-ai-pm-desktop-capability'];
  const csrfToken = request.headers['x-csrf-token'];
  const origin = request.headers.origin;
  const referer = request.headers.referer;
  const intent = request.headers['x-ai-pm-privacy-intent'];
  if (typeof token !== 'string' || typeof csrfToken !== 'string' || typeof origin !== 'string' || typeof intent !== 'string') {
    reply.code(401).send({ error: '缺少桌面主人操作能力凭证。', error_code: 'DESKTOP_CAPABILITY_REQUIRED' });
    return false;
  }
  if (!Number.isFinite(capability.expiresAt) || Date.now() >= capability.expiresAt || token !== capability.token || csrfToken !== capability.csrfToken) {
    reply.code(403).send({ error: '桌面主人操作能力凭证无效或已过期。', error_code: 'DESKTOP_CAPABILITY_INVALID' });
    return false;
  }
  if (origin !== capability.origin
    || (typeof referer === 'string' && !referer.startsWith(`${capability.origin}/`))) {
    reply.code(403).send({ error: '跨来源隐私操作已拒绝。', error_code: 'CSRF_ORIGIN_MISMATCH' });
    return false;
  }
  if (intent !== expectedIntent) {
    reply.code(403).send({ error: '隐私操作意图不匹配。', error_code: 'PRIVACY_INTENT_MISMATCH' });
    return false;
  }
  return capabilityBinding(capability);
}

export function registerSeedIntakeRoute(app: FastifyInstance, service: PmService) {
  if (app.hasRoute({ method: 'POST', url: '/api/dev/seed-intake' })) return;
  app.post('/api/dev/seed-intake', async (request, reply) => {
    const remoteAddress = request.socket.remoteAddress ?? request.ip;
    const normalizedAddress = remoteAddress?.replace(/^::ffff:/u, '').replace(/^\[|\]$/gu, '').split('%')[0];
    if (normalizedAddress !== '127.0.0.1' && normalizedAddress !== '::1') {
      return reply.code(403).send({ error: '模拟需求入口只接受本机回环请求。' });
    }
    try {
      const body = seedIntakeBodySchema.parse(request.body);
      const occurredAt = new Date().toISOString();
      const sourceKey = `dev-seed-source-${randomUUID()}`;
      const background = body.background ?? body.describe ?? body.title;
      const result = service.processCindyIntake({
        window_id: `dev-seed-window-${randomUUID()}`,
        window_start: occurredAt,
        window_end: occurredAt,
        sources: [{
          source_key: sourceKey,
          occurred_at: occurredAt,
          conversation_key: `dev-seed-conversation-${sourceKey}`,
          sender_role: '测试模拟需求',
          text: background,
        }],
        proposals: [{
          action: 'create_candidate',
          source_keys: [sourceKey],
          title: body.title,
          ...(body.describe === undefined ? {} : { describe: body.describe }),
          reason: '浏览器 HTML 测试模拟需求。',
        }],
      });
      const candidateId = result.proposals.find((proposal) => proposal.action === 'create_candidate')?.candidate_id;
      if (!candidateId) return reply.code(500).send({ error: '模拟需求未生成候选。' });
      return { candidate_id: candidateId };
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '模拟需求写入失败。' });
    }
  });
}

export async function buildApp(service: PmService, input: string | BuildAppOptions = 'http://localhost:5173') {
  const options: BuildAppOptions = typeof input === 'string' ? { webOrigin: input } : input;
  const webOrigin = options.webOrigin ?? 'http://localhost:5173';
  if (options.desktopCapability) service.registerAuditReplayCapability(options.desktopCapability);
  const app = Fastify({ logger: options.logger ?? process.env.NODE_ENV !== 'test' });
  await app.register(cors, { origin: webOrigin });
  let runtimeShutdownScheduled = false;
  let runtimeRestartScheduled = false;

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/integrations/cindy/')) return;
    if (request.method === 'OPTIONS') return;
    const expected = options.cindyIntegrationToken?.trim();
    const authorization = String(request.headers.authorization ?? '');
    const expectedAuthorization = expected ? `Bearer ${expected}` : '';
    const authorizationMatches = Boolean(expectedAuthorization)
      && authorization.length === expectedAuthorization.length
      && timingSafeEqual(Buffer.from(authorization, 'utf8'), Buffer.from(expectedAuthorization, 'utf8'));
    if (!authorizationMatches) {
      return reply.code(401).send({ error: 'Cindy 集成令牌无效或尚未配置。' });
    }
  });

  app.get('/api/health', async () => service.health(randomUUID()));
  app.post('/api/runtime/shutdown', async (request, reply) => {
    if (!isLoopbackRequest(request)) return reply.code(403).send({ error: '后台关闭接口只接受本机请求。' });
    if (!options.runtimeShutdown) return reply.code(409).send({ error: '当前运行方式不支持关闭后台进程。' });
    if (runtimeShutdownScheduled) return reply.code(409).send({ error: '后台进程已经在退出。' });
    runtimeShutdownScheduled = true;
    reply.code(200).send({ message: '本机任务库后台已收到退出请求，4310 即将关闭。' });
    setTimeout(() => {
      void Promise.resolve(options.runtimeShutdown?.()).catch(() => undefined);
    }, 25);
    return reply;
  });
  app.post('/api/runtime/restart', async (request, reply) => {
    if (!isLoopbackRequest(request)) return reply.code(403).send({ error: '后台重启接口只接受本机请求。' });
    if (!options.runtimeRestart) return reply.code(409).send({ error: '当前运行方式不支持重启后台进程。' });
    if (runtimeShutdownScheduled) return reply.code(409).send({ error: '后台进程已经在退出。' });
    if (runtimeRestartScheduled) return reply.code(409).send({ error: '后台进程已经在重启。' });
    runtimeRestartScheduled = true;
    reply.code(200).send({ message: '本机任务库后台已收到重启请求，4310 即将重新监听。' });
    setTimeout(() => {
      void Promise.resolve(options.runtimeRestart?.()).catch(() => undefined);
    }, 25);
    return reply;
  });
  app.get('/api/runtime/auto-scan', async (request, reply) => {
    if (!isLoopbackRequest(request)) return reply.code(403).send({ error: '自动扫描开关只接受本机请求。' });
    return service.autoScanSettings();
  });
  app.put('/api/runtime/auto-scan', async (request, reply) => {
    if (!isLoopbackRequest(request)) return reply.code(403).send({ error: '自动扫描开关只接受本机请求。' });
    const body = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '自动扫描开关需要布尔值 enabled。' });
    return service.updateAutoScanSettings(body.data.enabled);
  });
  app.get('/api/runtime/intake-cursor', async (request, reply) => {
    if (!isLoopbackRequest(request)) return reply.code(403).send({ error: '入库窗口游标只接受本机请求。' });
    return service.intakeWindowCursor();
  });
  app.put('/api/runtime/intake-cursor', async (request, reply) => {
    if (!isLoopbackRequest(request)) return reply.code(403).send({ error: '入库窗口游标只接受本机请求。' });
    const body = z.object({ window_end: z.string().datetime({ offset: true }) }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '入库窗口游标需要有效的 window_end。' });
    try {
      return service.updateIntakeWindowCursor(body.data.window_end);
    } catch (error) {
      const status = error instanceof CindyIntakeConflictError ? 409 : 400;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '入库窗口游标更新失败。' });
    }
  });
  registerSeedIntakeRoute(app, service);
  app.get('/api/dashboard', async () => dashboardDtoSchema.parse(service.dashboard()));
  app.get('/api/calendar', async () => service.calendar());
  app.get('/api/calendar/sources', async (request) => {
    const query = z.object({
      route: z.enum(['calendar_fact', 'candidate_review', 'owner_confirmation']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(request.query);
    return service.calendarSources(query);
  });
  app.get('/api/notifications', async (request) => {
    const query = z.object({ unreadOnly: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return { items: service.listNotifications(query.unreadOnly, query.limit) };
  });
  app.post('/api/notifications/:id/read', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return service.markNotificationRead(params.id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : '提醒不存在。' });
    }
  });
  app.get('/api/configuration', async () => service.configuration());
  app.get('/api/automation-policy', async () => service.automationPolicy());
  app.patch('/api/automation-policy', async (request, reply) => {
    try {
      const body = z.object({ mode: z.enum(['auto', 'suggest']) }).parse(request.body);
      return service.updateAutomationPolicy(body.mode);
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : '自动维护设置更新失败。' });
    }
  });

  app.get('/api/diagnostics', async () => service.diagnostics(randomUUID()));
  app.get('/api/audit/ai-decisions/:id/replay', async (request, reply) => {
    const binding = requirePrivacyCapability(request, reply, options.desktopCapability, AUDIT_REPLAY_INTENT);
    if (!binding) return;
    const params = z.object({ id: z.string().min(1).max(200) }).parse(request.params);
    try {
      return service.replayAiDecision(params.id, binding);
    } catch (error) {
      const status = error instanceof ReplayAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : 'AI 决策回放失败。' });
    }
  });
  app.get('/api/logs', async (request) => {
    const query = z.object({
      category: z.string().max(80).optional(),
      level: z.enum(['info', 'warn', 'error']).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      operation_id: z.string().uuid().optional(),
      trace_id: z.string().uuid().optional(),
      event_type: z.string().max(120).regex(/^[A-Za-z0-9._-]+$/u).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(request.query);
    return service.listLogs(query);
  });
  app.delete('/api/logs', async (request) => {
    const query = z.object({ includeCorrections: z.coerce.boolean().default(false) }).parse(request.query);
    return service.clearLogs(query.includeCorrections);
  });
  app.post('/api/diagnostics/cleanup', async () => service.cleanupLogs());
  app.post('/api/integrations/:key/check', async (request, reply) => {
    const params = z.object({ key: z.enum(['feishu', 'llm', 'workspace']) }).parse(request.params);
    try {
      return await service.testIntegration(params.key);
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : '连接检查失败。' });
    }
  });
  app.get('/api/integrations/health', async () => service.integrationHealth());
  app.get('/api/integrations/cindy/tasks', async () => ({
    items: service.listCindyTasks(),
    candidates: service.listCindyCandidates(),
    cursors: service.listCindyConversationCursors(),
  }));
  app.get('/api/integrations/cindy/bindings/:sessionId', async (request) => {
    const params = z.object({ sessionId: z.string().min(1).max(200) }).parse(request.params);
    return { binding: service.getCindySessionBinding(params.sessionId) };
  });
  app.post('/api/integrations/cindy/turn-evaluations', async (request, reply) => {
    try {
      const body = z.object({
        sessionId: z.string().min(1).max(200),
        turnId: z.string().min(1).max(200),
        candidateTaskIds: z.array(z.string().min(1).max(200)).max(200).default([]),
        decision: z.enum(['no_match', 'suggest_binding', 'bind', 'no_update', 'progress_update']),
        taskId: z.string().min(1).max(200).nullable().optional(),
        associationConfidence: z.number().min(0).max(1).nullable().optional(),
        updateConfidence: z.number().min(0).max(1).nullable().optional(),
        patch: z.object({
          status: z.enum(taskStatuses).optional(),
          nextStep: z.string().max(1000).optional(),
          waitingReason: z.string().max(1000).nullable().optional(),
        }).strict().optional(),
        reason: z.string().min(1).max(2000),
        evidence: z.array(z.string().max(500)).max(8).optional(),
        provider: z.string().max(100).optional(),
        model: z.string().max(256).optional(),
        inputHash: z.string().max(128).optional(),
        promptVersion: z.string().max(100).optional(),
      }).parse(request.body);
      return service.recordCindyTurnEvaluation({
        ...body,
        taskId: body.taskId ?? undefined,
        patch: body.patch ? { ...body.patch, status: body.patch.status as TaskStatus | undefined } : undefined,
      });
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : '轮次判断写入失败。' });
    }
  });
  app.post('/api/integrations/cindy/intake', async (request, reply) => {
    try {
      const isoTimestamp = z.string().datetime({ offset: true });
      const body = z.object({
        window_id: z.string().trim().min(1).max(200),
        window_start: isoTimestamp,
        window_end: isoTimestamp,
        sources: z.array(z.object({
          source_key: z.string().trim().min(1).max(200),
          occurred_at: isoTimestamp,
          conversation_key: z.string().trim().min(1).max(500).optional(),
          sender_role: z.string().trim().min(1).max(120).optional(),
          text: z.string().min(1).max(20_000),
        }).strict()).max(500),
        proposals: z.array(z.object({
          action: z.enum(['create_candidate', 'update_task', 'skip', 'needs_owner']),
          source_keys: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
          task_key: z.string().trim().min(1).max(200).optional(),
          expected_version: z.number().int().nonnegative().optional(),
          title: z.string().trim().min(1).max(160).optional(),
          describe: z.string().trim().min(1).max(2_000).optional(),
          next_step: z.string().trim().min(1).max(1_000).optional(),
          reason: z.string().trim().max(2_000).optional(),
        }).strict()).max(500),
      }).strict().parse(request.body);
      return service.processCindyIntake(body);
    } catch (error) {
      const status = error instanceof z.ZodError || error instanceof CindyIntakeValidationError
        ? 400
        : error instanceof CindyIntakeConflictError ? 409 : 409;
      const payload: Record<string, unknown> = {
        error: error instanceof Error ? error.message : 'Cindy 入库失败。',
      };
      if (error instanceof CindyIntakeConflictError) {
        payload.error_code = error.errorCode;
        payload.current_version = error.currentVersion;
      }
      return reply.code(status).send(payload);
    }
  });
  app.get('/api/owner-information', async () => service.ownerInformation());
  app.get('/api/privacy/status', async () => service.privacyStatus());
  app.post('/api/privacy/collection/stop', async (request, reply) => {
    const binding = requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT);
    if (!binding) return;
    try {
      const body = z.object({ expectedVersion: z.number().int().nonnegative().optional() }).parse(request.body ?? {});
      return await service.stopPrivacyCollection(body.expectedVersion, binding);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '停止采集失败。' });
    }
  });
  app.post('/api/privacy/collection/start', async (request, reply) => {
    const binding = requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT);
    if (!binding) return;
    try {
      const body = z.object({ expectedVersion: z.number().int().nonnegative().optional() }).parse(request.body ?? {});
      return await service.startPrivacyCollection(body.expectedVersion, binding);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '恢复采集失败。' });
    }
  });
  app.post('/api/privacy/revoke', async (request, reply) => {
    const binding = requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT);
    if (!binding) return;
    try {
      const body = z.object({ expectedVersion: z.number().int().nonnegative().optional() }).parse(request.body ?? {});
      return await service.revokePrivacyAuthorization(body.expectedVersion, binding);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '撤销授权失败。' });
    }
  });
  app.post('/api/privacy/export', async (request, reply) => {
    if (!requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT)) return;
    try {
      const body = z.object({
        scope: z.enum(['all', 'sources', 'tasks', 'audit']).default('all'),
        format: z.literal('json').default('json'),
        idempotencyKey: z.string().min(1).max(200),
      }).parse(request.body ?? {});
      return service.exportPrivacyData(body);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '个人数据导出失败。' });
    }
  });
  app.post('/api/privacy/deletion/request', async (request, reply) => {
    const binding = requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_DELETION_INTENT);
    if (!binding) return;
    try {
      const body = z.object({ idempotencyKey: z.string().min(1).max(200) }).parse(request.body ?? {});
      return service.requestPrivacyDeletion({ ...body, capabilityBinding: binding });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '删除请求失败。' });
    }
  });
  app.post('/api/privacy/deletion/confirm', async (request, reply) => {
    const binding = requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_DELETION_INTENT);
    if (!binding) return;
    try {
      const body = z.object({
        deletionId: z.string().min(1).max(200),
        confirmationToken: z.string().min(1).max(200),
        expectedVersion: z.number().int().nonnegative().optional(),
      }).parse(request.body ?? {});
      return await service.confirmPrivacyDeletion({ ...body, capabilityBinding: binding });
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '删除确认失败。' });
    }
  });
  app.patch('/api/privacy/retention', async (request, reply) => {
    if (!requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT)) return;
    try {
      const body = z.object({
        expectedVersion: z.number().int().nonnegative().optional(),
        sourceDays: z.number().int().min(1).max(3650).optional(),
        derivedDays: z.number().int().min(1).max(3650).optional(),
        diagnosticsDays: z.number().int().min(1).max(365).optional(),
        backupCount: z.number().int().min(1).max(32).optional(),
      }).parse(request.body ?? {});
      return service.updatePrivacyRetention(body);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '留存策略更新失败。' });
    }
  });
  app.post('/api/privacy/retention/run', async (request, reply) => {
    if (!requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT)) return;
    try {
      const body = z.object({ expectedVersion: z.number().int().nonnegative().optional() }).parse(request.body ?? {});
      return service.runPrivacyRetention(body);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '留存清理失败。' });
    }
  });
  app.post('/api/privacy/backup', async (_request, reply) => {
    if (!requirePrivacyCapability(_request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT)) return;
    try {
      return service.createPrivacyBackup();
    } catch (error) {
      const status = error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '备份创建失败。' });
    }
  });
  app.post('/api/privacy/backup/verify', async (request, reply) => {
    if (!requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT)) return;
    try {
      const body = z.object({ fileName: z.string().min(1).max(255) }).parse(request.body ?? {});
      return service.verifyPrivacyBackup(body.fileName);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '备份校验失败。' });
    }
  });
  app.post('/api/privacy/backup/restore', async (request, reply) => {
    if (!requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT)) return;
    try {
      const body = z.object({ fileName: z.string().min(1).max(255), expectedVersion: z.number().int().nonnegative().optional() }).parse(request.body ?? {});
      return service.restorePrivacyBackup(body);
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof PrivacyAuthorizationError ? error.statusCode : 409;
      return reply.code(status).send({ error: error instanceof Error ? error.message : '备份恢复失败。' });
    }
  });
  app.post('/api/integrations/feishu/owner/refresh', async (_request, reply) => {
    try {
      await service.refreshOwnerIdentity();
      return service.ownerInformation();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '无法读取系统主人身份。' });
    }
  });
  app.get('/api/integrations/feishu/monitoring-scope', async () => service.feishuMonitoringScope());
  app.post('/api/integrations/feishu/monitoring-scope/refresh', async (_request, reply) => {
    try {
      return await service.refreshFeishuMonitoringScope();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '无法刷新飞书人员和群聊范围。' });
    }
  });
  app.patch('/api/integrations/feishu/monitoring-scope', async (request, reply) => {
    try {
      const body = z.object({
        personIds: z.array(z.string().min(1).max(160)).max(5000).optional(),
        personChanges: z.array(z.object({
          id: z.string().min(1).max(160),
          selected: z.boolean(),
        })).max(5000).optional(),
        groupIds: z.array(z.string().min(1).max(160)).max(50).optional(),
      }).parse(request.body);
      return service.updateFeishuMonitoringScope(body);
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : '无法保存飞书监控范围。' });
    }
  });
  app.get('/api/integrations/feishu/people', async (request, reply) => {
    try {
      const query = z.object({ query: z.string().max(50).optional().default('') }).parse(request.query);
      return await service.searchFeishuPeople(query.query);
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : '飞书联系人搜索失败。' });
    }
  });
  app.get('/api/integrations/feishu/oauth/url', async (request, reply) => {
    try {
      const query = z.object({ state: z.string().uuid().optional() }).parse(request.query);
      return await service.feishuAuthorizationUrl(query.state);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '无法生成飞书授权地址。' });
    }
  });
  app.post('/api/integrations/feishu/oauth/exchange', async (request, reply) => {
    const body = z.object({ code: z.string().min(1).max(4096), state: z.string().max(512).optional() }).parse(request.body);
    try {
      return await service.completeFeishuOAuth(body.code, body.state);
    } catch (error) {
      const diagnostic = error && typeof error === 'object' && 'diagnostic' in error
        ? (error as { diagnostic?: unknown }).diagnostic
        : undefined;
      return reply.code(409).send({ error: error instanceof Error ? error.message : '飞书授权失败。', diagnostic });
    }
  });
  app.post('/api/integrations/feishu/listener/start', async (request, reply) => {
    if (!requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT)) return;
    try {
      return await service.startFeishu();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '无法启动飞书监听。' });
    }
  });
  app.post('/api/integrations/feishu/listener/stop', async (request, reply) => {
    if (!requirePrivacyCapability(request, reply, options.desktopCapability, PRIVACY_OWNER_ACTION_INTENT)) return;
    try {
      return await service.stopFeishu();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '无法停止飞书监听。' });
    }
  });
  app.post('/api/integrations/feishu/sync', async (request, reply) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const context = requestTraceContext(request);
    const operationContext = createOperationContext({ requestId, traceId: context.traceId, parentSpanId: context.parentSpanId });
    try {
      return await service.syncFeishuOnce(requestId, context, operationContext);
    } catch (error) {
      return reply.code(409).send(operationEnvelope({
        context: operationContext,
        startedAt,
        sources: [failedSourceOutcome('feishu', error, Date.now() - startedAt)],
        release: service.releaseIdentity(),
      }));
    }
  });
  app.post('/api/integrations/feishu/sources/:kind/sync', async (request, reply) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const context = requestTraceContext(request);
    const operationContext = createOperationContext({ requestId, traceId: context.traceId, parentSpanId: context.parentSpanId });
    let source: SyncSourceName = 'feishu_source';
    try {
      const params = z.object({ kind: z.enum(['owner_dm', 'owner_mentions', 'calendar', 'minutes', 'bot_supplement']) }).parse(request.params);
      source = params.kind;
      return await service.syncFeishuSource(params.kind, requestId, context, operationContext);
    } catch (error) {
      const isValidation = error instanceof z.ZodError;
      return reply.code(isValidation ? 400 : 409).send(operationEnvelope({
        context: operationContext,
        startedAt,
        sources: [failedSourceOutcome(source, error, Date.now() - startedAt)],
        release: service.releaseIdentity(),
      }));
    }
  });
  app.get('/api/integrations/feishu/calendar', async (request, reply) => {
    try {
      const query = z.record(z.string(), z.string()).parse(request.query);
      return await service.feishuCalendar(query);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '飞书日历读取失败。' });
    }
  });
  app.get('/api/integrations/feishu/chats', async (_request, reply) => {
    try {
      return await service.feishuChats();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '飞书会话读取失败。' });
    }
  });
  app.get('/api/integrations/feishu/messages/search', async (request, reply) => {
    try {
      const query = z.record(z.string(), z.string()).parse(request.query);
      return await service.feishuMessagesSearch(query);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '飞书消息搜索失败。' });
    }
  });
  app.get('/api/integrations/feishu/minutes/search', async (request, reply) => {
    try {
      const query = z.record(z.string(), z.string()).parse(request.query);
      return await service.feishuMinutesSearch(query);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '会议纪要搜索失败。' });
    }
  });
  app.get('/api/integrations/feishu/minutes/:token/transcript', async (request, reply) => {
    try {
      const params = z.object({ token: z.string().min(1).max(512) }).parse(request.params);
      return await service.feishuMinuteTranscript(params.token);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '会议纪要读取失败。' });
    }
  });

  app.post('/api/configuration/validate', async (request) => {
    const body = z
      .object({ values: z.record(z.string(), z.string().max(4096)).default({}) })
      .parse(request.body ?? {});
    return {
      valid: true,
      persisted: false,
      connected: false,
      receivedFields: Object.keys(body.values),
      message: '格式校验通过；此表单不会保存密钥或连接外部服务。',
    };
  });

  app.get('/api/candidates', async (request) => {
    const query = z.object({
      state: z.enum(candidateStates).optional(),
      deleted: z.enum(['active', 'only', 'all']).default('active'),
    }).parse(request.query);
    return candidateInboxDtoSchema.parse({
      items: service.listCandidatesPublic(query.state as CandidateState | undefined, query.deleted),
      ownerActions: service.listPendingOwnerActionsPublic(),
    });
  });

  const sourceFailureQuery = z.object({
    status: z.enum(['active', 'all', 'open', 'retrying', 'resolved', 'ignored', 'stale']).default('active'),
  });
  const listSourceFailures = async (request: SourceFailureListRequest) => {
    const query = sourceFailureQuery.parse(request.query);
    return service.listSourceFailures(query.status);
  };
  app.get('/api/source-failures', listSourceFailures);
  // Compatibility alias for clients that name the inbox by its user-facing label.
  app.get('/api/failed-sources', listSourceFailures);

  const retrySourceFailure = async (request: SourceFailureActionRequest, reply: FastifyReply) => {
    const params = z.object({ id: z.string().trim().min(1).max(256) }).parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive().optional() }).strict().parse(request.body ?? {});
    try {
      return service.retrySourceFailure(params.id, body.expectedVersion);
    } catch (error) {
      const message = error instanceof Error ? error.message : '失败来源无法重试。';
      return reply.code(message.includes('不存在') ? 404 : error instanceof CandidateVersionRequiredError ? 400 : 409).send({ error: message });
    }
  };
  const ignoreSourceFailure = async (request: SourceFailureActionRequest, reply: FastifyReply) => {
    const params = z.object({ id: z.string().trim().min(1).max(256) }).parse(request.params);
    try {
      return service.ignoreSourceFailure(params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '失败来源无法归档。';
      return reply.code(message.includes('不存在') ? 404 : 409).send({ error: message });
    }
  };
  app.post('/api/source-failures/:id/retry', retrySourceFailure);
  app.post('/api/source-failures/:id/ignore', ignoreSourceFailure);
  app.post('/api/source-failures/:id/archive', ignoreSourceFailure);
  app.post('/api/failed-sources/:id/retry', retrySourceFailure);
  app.post('/api/failed-sources/:id/ignore', ignoreSourceFailure);
  app.post('/api/failed-sources/:id/archive', ignoreSourceFailure);

  app.post('/api/sources/:sourceEventId/classification/retry', async (request, reply) => {
    const params = z.object({ sourceEventId: z.string().trim().min(1) }).parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(request.body ?? {});
    try {
      return service.retrySourceClassification(
        params.sourceEventId,
        undefined,
        undefined,
        service.candidateVersionFenceForSource(params.sourceEventId, body.expectedVersion) ?? undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '来源分类无法重试。';
      if (message === '来源消息不存在。') return reply.code(404).send({ error: message });
      return reply.code(409).send(candidateMutationError(error, '来源分类无法重试。', service.candidateVersionDtoForSource(params.sourceEventId)));
    }
  });

  app.delete('/api/candidates/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive(), expectedGroupVersionHash: z.string().trim().min(64).max(128).optional() }).strict().parse(request.body ?? {});
    try {
      service.deleteCandidate(params.id, body.expectedVersion, body.expectedGroupVersionHash);
      const candidate = service.publicCandidate(params.id);
      return candidate ? minimalCandidateDtoSchema.parse(candidate) : service.candidateVersionDto(params.id) ?? reply.code(404).send({ error: '候选需求不存在。' });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '候选删除失败。', service.candidateVersionDto(params.id)));
    }
  });

  app.post('/api/candidates/:id/source-retry', async (request, reply) => {
    const params = z.object({ id: z.string().trim().min(1).max(200) }).parse(request.params);
    const body = z.object({ sourceScope: sourceScopeSchema, expectedVersion: z.number().int().positive() }).strict().parse(request.body ?? {});
    try {
      const result = service.retryCandidateSourceClassification(params.id, body.sourceScope, body.expectedVersion);
      return result
        ? candidateSourceRetryDtoSchema.parse({ status: result.status, message: result.message })
        : reply.code(404).send({ error: '来源范围无效。' });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '来源分类无法重试。', service.candidateVersionDto(params.id)));
    }
  });

  app.post('/api/candidates/:id/restore', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive(), expectedGroupVersionHash: z.string().trim().min(64).max(128).optional() }).strict().parse(request.body ?? {});
    try {
      service.restoreCandidate(params.id, body.expectedVersion, body.expectedGroupVersionHash);
      const candidate = service.publicCandidate(params.id);
      return candidate ? minimalCandidateDtoSchema.parse(candidate) : service.candidateVersionDto(params.id) ?? reply.code(404).send({ error: '候选需求不存在。' });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '候选恢复失败。', service.candidateVersionDto(params.id)));
    }
  });

  app.post('/api/candidates/:id/action', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z
      .object({ action: z.enum(['accept', 'snooze', 'ignore']), snoozedUntil: z.string().datetime().optional(), expectedVersion: z.number().int().positive(), expectedGroupVersionHash: z.string().trim().min(64).max(128).optional() }).strict()
      .parse(request.body);
    try {
      const result = service.actOnCandidate(params.id, body.action, body.snoozedUntil, body.expectedVersion, body.expectedGroupVersionHash);
      const candidate = service.publicCandidate(params.id);
      if (!candidate) throw new Error('候选需求不存在。');
      return candidateActionDtoSchema.parse({
        candidate,
        task: service.publicTask(result.task?.id),
        linkedExistingTask: result.linkedExistingTask,
      });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '操作失败。', service.candidateVersionDto(params.id)));
    }
  });

  app.post('/api/candidates/:id/thread-association', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      targetThreadId: z.string().min(1).nullable(),
      expectedVersion: z.number().int().positive(),
      expectedThreadVersion: z.number().int().positive(),
      expectedTargetThreadVersion: z.number().int().positive().optional(),
    }).strict().superRefine((value, context) => {
      if (value.targetThreadId !== null && value.expectedTargetThreadVersion === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['expectedTargetThreadVersion'], message: '选择已有需求线程时需要提供当前线程版本。' });
      }
    }).parse(request.body);
    try {
      const result = service.resolveCandidateThreadAssociation(
        params.id,
        body.targetThreadId,
        body.expectedVersion,
        body.expectedThreadVersion,
        body.expectedTargetThreadVersion,
      );
      const candidate = service.publicCandidate(params.id);
      if (!candidate) throw new Error('候选需求不存在。');
      return candidateThreadAssociationDtoSchema.parse({
        candidate,
        task: service.publicTask(result.task?.id),
        proposal: service.publicTaskUpdateProposal(result.proposal?.id),
        threadId: result.threadId,
      });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '需求归属无法确认。', service.candidateVersionDto(params.id)));
    }
  });

  app.post('/api/candidates/:id/merge/confirm', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      targetCandidateId: z.string().min(1),
      primaryCandidateId: z.string().min(1),
      suggestionId: z.string().min(1),
      expectedThreadVersion: z.number().int().positive(),
      expectedVersion: z.number().int().positive(),
      expectedTargetVersion: z.number().int().positive(),
      expectedGroupVersionHash: z.string().trim().length(64),
    }).strict().parse(request.body);
    try {
      const result = service.confirmCandidateMerge(params.id, body.targetCandidateId, body.primaryCandidateId, body.suggestionId, body.expectedThreadVersion, body.expectedVersion, body.expectedTargetVersion, body.expectedGroupVersionHash);
      const candidate = service.publicCandidate(result.candidate?.id ?? body.primaryCandidateId);
      if (!candidate) throw new Error('候选需求不存在。');
      return candidateMergeDtoSchema.parse({ candidate, mergeGroup: candidate.merge_group ?? null });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '候选归并无法确认。', service.candidateVersionDto(params.id)));
    }
  });

  app.post('/api/candidates/:id/merge/reject', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ targetCandidateId: z.string().min(1), suggestionId: z.string().min(1), expectedVersion: z.number().int().positive(), expectedTargetVersion: z.number().int().positive(), expectedGroupVersionHash: z.string().trim().length(64) }).strict().parse(request.body);
    try {
      const result = service.rejectCandidateMerge(params.id, body.targetCandidateId, body.suggestionId, body.expectedVersion, body.expectedTargetVersion, body.expectedGroupVersionHash);
      const candidate = service.publicCandidate(result.candidate?.id ?? params.id);
      const targetCandidate = service.publicCandidate(result.targetCandidate?.id ?? body.targetCandidateId);
      if (!candidate || !targetCandidate) throw new Error('候选需求不存在。');
      return candidateMergeRejectedDtoSchema.parse({ candidate, targetCandidate, separateCandidates: true });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '候选归并建议无法否决。', service.candidateVersionDto(params.id)));
    }
  });

  app.post('/api/candidates/:id/merge/primary', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ primaryCandidateId: z.string().min(1), expectedVersion: z.number().int().positive(), expectedThreadVersion: z.number().int().positive(), expectedGroupVersionHash: z.string().trim().length(64) }).strict().parse(request.body);
    try {
      const result = service.setCandidateMergePrimary(params.id, body.primaryCandidateId, body.expectedVersion, body.expectedGroupVersionHash, body.expectedThreadVersion);
      const candidate = service.publicCandidate(result.candidate?.id ?? body.primaryCandidateId);
      if (!candidate) throw new Error('候选需求不存在。');
      return candidateMergeDtoSchema.parse({ candidate, mergeGroup: candidate.merge_group ?? null });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '候选主体无法更换。', service.candidateVersionDto(params.id)));
    }
  });

  app.post('/api/candidates/:id/merge/split', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive(), expectedThreadVersion: z.number().int().positive(), expectedGroupVersionHash: z.string().trim().length(64) }).strict().parse(request.body ?? {});
    try {
      const result = service.splitCandidateMerge(params.id, body.expectedVersion, body.expectedGroupVersionHash, body.expectedThreadVersion);
      const splitCandidate = service.publicCandidate(result.splitCandidate?.id ?? params.id);
      const remainingCandidate = service.publicCandidate(result.remainingCandidate?.id ?? '');
      if (!splitCandidate || !remainingCandidate) throw new Error('候选需求不存在。');
      return candidateSplitDtoSchema.parse({
        splitCandidate,
        remainingCandidate,
        splitGroup: splitCandidate.merge_group ?? null,
        remainingGroup: remainingCandidate.merge_group ?? null,
      });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '候选来源无法拆分。', service.candidateVersionDto(params.id)));
    }
  });

  app.get('/api/tasks', async (request) => {
    const query = z.object({
      status: z.enum(taskStatuses).optional(),
      recordState: z.enum(['active', 'invalidated', 'all']).default('active'),
      deleted: z.enum(['active', 'only', 'all']).default('active'),
    }).parse(request.query);
    return taskListDtoSchema.parse({
      items: service.listTasksPublic(query.status as TaskStatus | undefined, query.recordState, query.deleted),
    });
  });

  app.get('/api/audit-chain', async (request, reply) => {
    const internalId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/u, '审计链 ID 格式无效。');
    const query = z.object({
      sourceEventId: internalId.optional(),
      demandUnitId: internalId.optional(),
      candidateId: internalId.optional(),
      threadId: internalId.optional(),
      taskId: internalId.optional(),
    }).refine((value) => Object.values(value).some(Boolean), {
      message: '至少提供一个审计链筛选条件。',
    }).parse(request.query);
    try {
      return service.getAuditChain(query);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '审计链读取失败。' });
    }
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const task = service.getTaskDetail(params.id);
    return task ?? reply.code(404).send({ error: '任务不存在。' });
  });

  app.post('/api/tasks/:id/sources/:scope/verify', async (request, reply) => {
    const params = z.object({ id: z.string().trim().min(1), scope: z.string().trim().min(1).max(100) }).parse(request.params);
    const body = z.object({ confirmed: z.literal(true) }).strict().parse(request.body ?? {});
    try {
      return service.verifyTaskSource(params.id, params.scope, body.confirmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : '来源核验失败。';
      return reply.code(message === '来源核验范围无效。' ? 404 : 409).send({ error: message });
    }
  });

  app.get('/api/tasks/:id/memory', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const projection = service.getMemoryProjectionView(params.id);
    return projection ?? reply.code(404).send({ error: '任务记忆投影不存在。' });
  });

  app.post('/api/tasks/:id/memory/project', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      service.projectTaskMemory(params.id);
      return service.getMemoryProjectionView(params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '任务记忆投影失败。' });
    }
  });

  app.post('/api/tasks/:id/memory/rebuild', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return service.rebuildTaskMemory(params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '任务记忆清理重建失败。' });
    }
  });

  app.get('/api/threads', async (request) => {
    const query = z.object({ status: z.enum(['open', 'needs_confirmation', 'closed']).optional() }).parse(request.query);
    return threadListDtoSchema.parse({ items: service.listThreadsPublic(query.status) });
  });

  app.get('/api/threads/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const thread = service.publicThreadDetail(params.id);
    return thread ?? reply.code(404).send({ error: '需求线程不存在。' });
  });

  app.get('/api/task-update-proposals', async (request) => {
    const query = z.object({ state: z.enum(['awaiting_approval', 'approved', 'rejected', 'stale']).optional() }).parse(request.query);
    return { items: service.listTaskUpdateProposalsPublic(query.state) };
  });

  app.get('/api/task-update-proposals/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const proposal = service.publicTaskUpdateProposal(params.id);
    return proposal ?? reply.code(404).send({ error: '任务更新提案不存在。' });
  });

  app.post('/api/task-update-proposals/:id/approve', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return service.approveTaskUpdateProposal(params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '任务更新提案无法确认。' });
    }
  });

  app.post('/api/task-update-proposals/:id/reject', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return service.rejectTaskUpdateProposal(params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '任务更新提案无法拒绝。' });
    }
  });

  app.post('/api/task-update-proposals/:id/revert', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return service.revertAutomaticTaskUpdate(params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'AI 自动更新无法撤销。' });
    }
  });

  app.get('/api/runtime/jobs', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return service.listRuntimeJobs(query.limit);
  });

  app.get('/api/runtime/jobs/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const job = service.getRuntimeJob(params.id);
    return job ?? reply.code(404).send({ error: 'Runtime 工作项不存在。' });
  });

  app.post('/api/runtime/jobs/:id/cancel', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return service.cancelRuntimeJob(params.id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'Runtime 工作项不存在。' });
    }
  });

  app.post('/api/runtime/jobs/:id/retry', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return service.retryRuntimeJob(params.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Runtime 工作项无法重试。';
      return reply.code(message.includes('不存在') ? 404 : 409).send({ error: message });
    }
  });

  app.get('/api/runtime/tools', async () => ({ items: service.runtimeToolPolicies() }));

  app.patch('/api/tasks/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      const body = z
        .object({
          title: z.string().min(1).max(160).optional(),
          describe: z.string().min(1).max(2000).optional(),
          status: z.enum(taskStatuses).optional(),
          scheduleAt: z.string().datetime().nullable().optional(),
          plannedStartAt: z.string().datetime().nullable().optional(),
          plannedDueAt: z.string().datetime().nullable().optional(),
          nextStep: z.string().max(1000).optional(),
          risk: z.enum(risks).optional(),
          waitingReason: z.string().max(1000).nullable().optional(),
          expectedVersion: z.number().int().positive(),
        })
        .parse(request.body);
      assertShanghaiCalendarPlanRange(body.plannedStartAt ?? null, body.plannedDueAt ?? null);
      service.updateTask(params.id, {
        ...body,
        status: body.status as TaskStatus | undefined,
        risk: body.risk as RiskLevel | undefined,
      });
      return service.getTaskDetail(params.id);
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : '更新失败。' });
    }
  });

  app.patch('/api/tasks/:id/automation', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      const body = z.object({ paused: z.boolean(), expectedVersion: z.number().int().positive() }).parse(request.body);
      service.updateTaskAutomation(params.id, body.paused, body.expectedVersion);
      return service.getTaskDetail(params.id);
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : '任务自动维护设置更新失败。' });
    }
  });

  app.delete('/api/tasks/:id', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body);
      service.deleteTask(params.id, body.expectedVersion);
      return service.getTaskDetail(params.id);
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : '删除失败。' });
    }
  });

  app.post('/api/tasks/:id/restore', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body);
      service.restoreTask(params.id, body.expectedVersion);
      return service.getTaskDetail(params.id);
    } catch (error) {
      return reply.code(error instanceof z.ZodError ? 400 : 409).send({ error: error instanceof Error ? error.message : '恢复失败。' });
    }
  });

  app.post('/api/tasks/:id/references', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ label: z.string().min(1).max(100), referencePath: z.string().min(1).max(1000), accessMode: z.enum(['reference_only', 'readonly']).default('reference_only') }).parse(request.body);
    try {
      return service.addReference(params.id, body.label, body.referencePath, body.accessMode);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : '添加失败。' });
    }
  });

  app.post('/api/tasks/:id/references/:referenceId/inspect', async (request, reply) => {
    const params = z.object({ id: z.string().min(1), referenceId: z.string().min(1) }).parse(request.params);
    try {
      return await service.inspectReference(params.id, params.referenceId);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '目录检查失败。' });
    }
  });

  app.delete('/api/tasks/:id/references/:referenceId', async (request, reply) => {
    const params = z.object({ id: z.string().min(1), referenceId: z.string().min(1) }).parse(request.params);
    try {
      return service.removeReference(params.id, params.referenceId);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '参考路径解除失败。' });
    }
  });

  app.post('/api/candidates/:id/reprocess', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ guidance: z.string().max(1000).optional(), expectedVersion: z.number().int().positive() }).strict().parse(request.body ?? {});
    const requestId = randomUUID();
    const traceContext = requestTraceContext(request);
    const operationContext = createOperationContext({ requestId, traceId: traceContext.traceId, parentSpanId: traceContext.parentSpanId });
    try {
      const result = await service.reprocessCandidate(params.id, body.guidance, undefined, body.expectedVersion, operationContext);
      const candidate = service.publicCandidate(params.id);
      if (!candidate) throw new Error('候选需求不存在。');
      return candidateReprocessDtoSchema.parse({
        candidate,
        changed: result.changed,
        message: result.changed ? '候选已重新整理；来源正文仍需主人主动核验。' : '本次重新整理未产生可应用变化。',
        proposal: result.proposal ? service.publicTaskUpdateProposal(result.proposal.id) : null,
      });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '重新判断失败。', service.candidateVersionDto(params.id)));
    }
  });

  app.get('/api/corrections', async () => correctionListDtoSchema.parse({ items: service.listCorrectionsPublic() }));
  app.post('/api/corrections', async (request, reply) => {
    let body = z.object({
      correctionType: z.enum(['false_positive', 'missed_request', 'wrong_association', 'wrong_fields', 'describe_incomplete', 'status_or_schedule_wrong']),
      candidateId: z.string().trim().min(1).optional(),
      taskId: z.string().trim().min(1).optional(),
      targetTaskId: z.string().trim().min(1).optional(),
      sourceEventId: z.string().trim().min(1).optional(),
      sourceScope: z.string().trim().min(1).max(100).optional(),
      demandUnitId: z.string().trim().min(1).optional(),
      expectedCandidateVersion: z.number().int().positive().optional(),
      expectedTaskVersion: z.number().int().positive().optional(),
      expectedTargetTaskVersion: z.number().int().positive().optional(),
      idempotencyKey: z.string().trim().min(1).max(160).optional(),
      note: z.string().trim().max(1000).optional(),
      replacementValue: z.string().trim().min(1).max(2000).optional(),
      replacementStatus: z.enum(taskStatuses).optional(),
      replacementScheduleAt: z.string().datetime().nullable().optional(),
      manualContent: z.string().trim().min(1).max(8000).optional(),
      manualSenderName: z.string().trim().min(1).max(160).default('人工补录'),
      manualOccurredAt: z.string().datetime().optional(),
    }).superRefine((value, context) => {
      const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
      if (value.correctionType === 'false_positive' && !value.candidateId && !value.taskId) issue('“这不是需求”需要指定候选或正式任务。');
      if (value.candidateId && value.expectedCandidateVersion === undefined) issue('候选纠错需要提供当前候选版本。');
      if (value.correctionType === 'missed_request' && !value.manualContent) issue('补录需求需要填写原始内容。');
      if (value.correctionType === 'wrong_association') {
        if (!value.taskId || !value.targetTaskId || (!value.sourceEventId && !value.sourceScope)) issue('关联纠错需要源任务、目标任务和具体来源。');
        if (value.taskId && value.taskId === value.targetTaskId) issue('源任务和目标任务不能相同。');
      }
      if ((value.correctionType === 'wrong_fields' || value.correctionType === 'describe_incomplete') && ((!value.candidateId && !value.taskId) || !value.replacementValue)) {
        issue('字段纠错需要指定候选或任务，并填写正确内容。');
      }
      if (value.correctionType === 'status_or_schedule_wrong' && (!value.taskId || (value.replacementStatus === undefined && value.replacementScheduleAt === undefined && !value.replacementValue))) {
        issue('状态或排期纠错至少需要修改一项。');
      }
    }).parse(request.body);
    try {
      if (body.correctionType === 'wrong_association' && body.taskId && body.sourceScope) {
        const relation = service.resolveTaskSourceScope(body.taskId, body.sourceScope);
        if (!relation) return reply.code(404).send({ error: '来源范围无效。' });
        body = {
          ...body,
          sourceEventId: relation.sourceEventId,
          demandUnitId: body.demandUnitId ?? relation.demandUnitId ?? undefined,
        };
      }
      const result = service.recordCorrection(body);
      if (result.duplicate) {
        const correction = result.correction as { candidate_id?: string | null; task_id?: string | null };
        return correctionActionDtoSchema.parse({
          duplicate: true,
          candidate: correction.candidate_id ? service.publicCandidate(correction.candidate_id) : null,
          task: correction.task_id ? service.publicTask(correction.task_id) : null,
          targetTask: null,
        });
      }
      return correctionActionDtoSchema.parse({
        duplicate: false,
        candidate: result.candidate ? service.publicCandidate(result.candidate.id) : null,
        task: result.task ? service.publicTask(result.task.id) : null,
        targetTask: result.targetTask ? service.publicTask(result.targetTask.id) : null,
      });
    } catch (error) {
      return reply.code(409).send(candidateMutationError(error, '记录纠错失败。', body.candidateId ? service.candidateVersionDto(body.candidateId) : null));
    }
  });

  app.post('/api/tasks/:id/external-actions', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ actionType: z.string().min(1).max(100), payload: z.unknown().optional() }).parse(request.body);
    try {
      return service.requestExternalAction(params.id, body.actionType, body.payload ?? {});
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : '操作失败。' });
    }
  });

  app.post('/api/approvals/:id/reject', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    try {
      return service.rejectExternalDraft(params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : '草稿无法废止。' });
    }
  });

  if (options.serveWeb !== false) {
    const defaultWebRoot = resolve(process.cwd(), 'apps', 'web', 'dist');
    const webRoot = options.webRoot ?? (process.env.WEB_DIST_DIR ? resolve(process.env.WEB_DIST_DIR) : defaultWebRoot);
    if (!existsSync(webRoot)) return app;
    const contentTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    const sendIndex = async (reply: FastifyReply) =>
      reply.type('text/html; charset=utf-8').send(await readFile(resolve(webRoot, 'index.html')));

    app.get('/', async (_request, reply) => sendIndex(reply));
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const wildcard = (request.params as { '*': string })['*'];
      const filePath = resolve(webRoot, wildcard);
      const relativePath = relative(webRoot, filePath);
      if (relativePath.startsWith('..' + sep) || relativePath === '..') {
        return reply.code(400).send({ error: 'Invalid path' });
      }
      try {
        const info = await stat(filePath);
        if (info.isFile()) {
          const contentType = contentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
          if (wildcard.startsWith('assets/')) {
            reply.header('cache-control', 'public, max-age=31536000, immutable');
          }
          return reply.type(contentType).send(await readFile(filePath));
        }
      } catch {
        // React Router paths fall back to index.html.
      }
      return sendIndex(reply);
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: '输入格式不正确。', details: error.issues });
    }
    return reply.code(500).send({ error: error instanceof Error ? error.message : '服务发生未知错误。' });
  });

  return app;
}
