export const desktopLifecyclePhases = [
  'idle',
  'starting',
  'ready',
  'reloading',
  'failed',
  'shutting_down',
  'stopped',
] as const;

export type DesktopLifecyclePhase = typeof desktopLifecyclePhases[number];

export type DesktopLifecycleTransition = {
  from: DesktopLifecyclePhase;
  to: DesktopLifecyclePhase;
};

const allowedTransitions: Record<DesktopLifecyclePhase, readonly DesktopLifecyclePhase[]> = {
  idle: ['starting', 'shutting_down'],
  starting: ['ready', 'failed', 'shutting_down'],
  ready: ['reloading', 'shutting_down', 'failed'],
  reloading: ['ready', 'failed', 'shutting_down'],
  failed: ['shutting_down', 'stopped'],
  shutting_down: ['stopped'],
  stopped: [],
};

/**
 * Serializes the one desktop lifecycle shared by startup, reload, OAuth,
 * tray, runtime recovery and process shutdown. Work callbacks remain owned
 * by main.ts; this class owns ordering, state and idempotent shutdown.
 */
export class DesktopLifecycle {
  private current: DesktopLifecyclePhase = 'idle';
  private queue: Promise<void> = Promise.resolve();
  private readonly transitions: DesktopLifecycleTransition[] = [];

  constructor(private readonly onTransition?: (transition: DesktopLifecycleTransition) => void) {}

  get phase() {
    return this.current;
  }

  get history() {
    return [...this.transitions];
  }

  start<T>(work: () => Promise<T>) {
    return this.enqueue(async () => {
      this.expect('idle', 'start');
      this.transition('starting');
      try {
        const result = await work();
        this.transition('ready');
        return result;
      } catch (error) {
        this.transition('failed');
        throw error;
      }
    });
  }

  reload<T>(work: () => Promise<T>) {
    return this.enqueue(async () => {
      this.expect('ready', 'reload');
      this.transition('reloading');
      try {
        const result = await work();
        this.transition('ready');
        return result;
      } catch (error) {
        this.transition('failed');
        throw error;
      }
    });
  }

  shutdown(work: () => Promise<void>) {
    return this.enqueue(async () => {
      if (this.current === 'stopped') return;
      if (this.current !== 'shutting_down') this.transition('shutting_down');
      try {
        await work();
      } finally {
        this.transition('stopped');
      }
    });
  }

  private enqueue<T>(work: () => Promise<T>) {
    const result = this.queue.then(work, work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private expect(expected: DesktopLifecyclePhase, operation: string) {
    if (this.current !== expected) {
      throw new Error(`desktop lifecycle cannot ${operation} while ${this.current}`);
    }
  }

  private transition(next: DesktopLifecyclePhase) {
    if (next === this.current) return;
    if (!allowedTransitions[this.current].includes(next)) {
      throw new Error(`desktop lifecycle transition ${this.current} -> ${next} is not allowed`);
    }
    const transition = { from: this.current, to: next } satisfies DesktopLifecycleTransition;
    this.current = next;
    this.transitions.push(transition);
    this.onTransition?.(transition);
  }
}
