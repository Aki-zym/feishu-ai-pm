import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DesktopLifecycle } from './lifecycle.js';

describe('desktop lifecycle', () => {
  it('serializes startup, reload and shutdown into one ordered state machine', async () => {
    const events: string[] = [];
    const lifecycle = new DesktopLifecycle(({ from, to }) => events.push(`${from}->${to}`));

    await lifecycle.start(async () => {
      events.push('start-work');
    });
    await Promise.all([
      lifecycle.reload(async () => {
        events.push('reload-work');
      }),
      lifecycle.shutdown(async () => {
        events.push('shutdown-work');
      }),
    ]);

    expect(lifecycle.phase).toBe('stopped');
    expect(events).toEqual([
      'idle->starting',
      'start-work',
      'starting->ready',
      'ready->reloading',
      'reload-work',
      'reloading->ready',
      'ready->shutting_down',
      'shutdown-work',
      'shutting_down->stopped',
    ]);
  });

  it('marks a failed reload and still permits a clean shutdown', async () => {
    const cleanup: string[] = [];
    const lifecycle = new DesktopLifecycle();
    await lifecycle.start(async () => undefined);

    await expect(lifecycle.reload(async () => {
      throw new Error('synthetic reload failure');
    })).rejects.toThrow('synthetic reload failure');
    expect(lifecycle.phase).toBe('failed');

    await lifecycle.shutdown(async () => {
      cleanup.push('all resources closed');
    });
    expect(cleanup).toEqual(['all resources closed']);
    expect(lifecycle.phase).toBe('stopped');
  });

  it('cleans up after a startup failure before the shell becomes ready', async () => {
    const cleanup: string[] = [];
    const lifecycle = new DesktopLifecycle();

    await expect(lifecycle.start(async () => {
      throw new Error('synthetic startup failure');
    })).rejects.toThrow('synthetic startup failure');
    expect(lifecycle.phase).toBe('failed');

    await lifecycle.shutdown(async () => {
      cleanup.push('partial core closed');
    });
    expect(cleanup).toEqual(['partial core closed']);
    expect(lifecycle.phase).toBe('stopped');
  });

  it('rejects duplicate starts and keeps shutdown idempotent', async () => {
    const lifecycle = new DesktopLifecycle();
    await lifecycle.start(async () => undefined);
    await expect(lifecycle.start(async () => undefined)).rejects.toThrow('cannot start while ready');

    await lifecycle.shutdown(async () => undefined);
    await lifecycle.shutdown(async () => {
      throw new Error('must not run twice');
    });
    expect(lifecycle.phase).toBe('stopped');
  });

  it('queues shutdown requested during startup and stops after startup settles', async () => {
    const events: string[] = [];
    let releaseStartup!: () => void;
    const startupFinished = new Promise<void>((resolve) => { releaseStartup = resolve; });
    const lifecycle = new DesktopLifecycle(({ from, to }) => events.push(`${from}->${to}`));

    const startPromise = lifecycle.start(async () => {
      events.push('start-work');
      await startupFinished;
    });
    await Promise.resolve();
    expect(lifecycle.phase).toBe('starting');

    const shutdownPromise = lifecycle.shutdown(async () => {
      events.push('shutdown-work');
    });
    expect(lifecycle.phase).toBe('starting');

    releaseStartup();
    await Promise.all([startPromise, shutdownPromise]);

    expect(lifecycle.phase).toBe('stopped');
    expect(events).toEqual([
      'idle->starting',
      'start-work',
      'starting->ready',
      'ready->shutting_down',
      'shutdown-work',
      'shutting_down->stopped',
    ]);
  });

  it('awaits bounded Runtime shutdown before closing desktop core resources', () => {
    const mainSource = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const disposeStart = mainSource.indexOf('async function disposeCore()');
    const disposeEnd = mainSource.indexOf('async function stopOAuthCallbackServer()', disposeStart);
    const disposeCore = mainSource.slice(disposeStart, disposeEnd);
    const stopRuntime = disposeCore.indexOf('await currentService?.stopRuntimeRecovery().catch(() => undefined);');
    const awaitRecovery = disposeCore.indexOf('await currentService?.awaitRuntimeRecovery().catch(() => undefined);');
    const stopFeishu = disposeCore.indexOf('await currentService?.stopFeishu().catch(() => undefined);');
    const closeDatabase = disposeCore.indexOf('currentDatabase?.close();');

    expect(disposeStart).toBeGreaterThanOrEqual(0);
    expect(disposeEnd).toBeGreaterThan(disposeStart);
    expect(stopRuntime).toBeGreaterThanOrEqual(0);
    expect(awaitRecovery).toBeGreaterThan(stopRuntime);
    expect(stopFeishu).toBeGreaterThan(awaitRecovery);
    expect(closeDatabase).toBeGreaterThan(stopFeishu);
  });
});
