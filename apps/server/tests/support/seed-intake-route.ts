import type { FastifyInstance } from 'fastify';
import { registerSeedIntakeRoute as registerBuildAppSeedIntakeRoute } from '../../src/app.js';
import type { PmService } from '../../src/service.js';

export type SeedIntakeRouteGuard = {
  testOnly: true;
  nodeEnv: string;
  databaseProvider: string;
  databaseUrl: string;
};

/**
 * Explicit test-assembly guard for the built-in loopback seed route.
 * The route itself is registered by buildApp so the resident browser runtime
 * and test E2E server share the same contract.
 */
export function registerSeedIntakeRoute(app: FastifyInstance, service: PmService, guard: SeedIntakeRouteGuard) {
  if (
    guard.testOnly !== true
    || guard.nodeEnv !== 'test'
    || guard.databaseProvider !== 'sqlite'
    || guard.databaseUrl !== ':memory:'
  ) {
    throw new Error('模拟需求入口只允许在 test + sqlite :memory: 装配中注册。');
  }

  registerBuildAppSeedIntakeRoute(app, service);
}
