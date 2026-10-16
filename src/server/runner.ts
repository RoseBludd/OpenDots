import { Store } from './store.js';
import type { Result, Memory } from '../shared/types.js';
import type { Claim } from './store.js';
import { research, type Config } from './research.js';
export class Runner {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, AbortController>();
  private pumping = false;
  /** Concurrent task slots (DOT_WORKERS); one task per Dot is enforced by the store. */
  private workers: number;
  constructor(
    private store: Store,
    private config: Config,
    private execute?: (
      claim: Claim,
      memories: Memory[],
      signal: AbortSignal,
      progress: (text: string) => void,
    ) => Promise<Result>,
  ) {
    this.workers = Math.max(1, Number(process.env.DOT_WORKERS) || 3);
  }
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), 1000);
      void this.tick();
    }
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const task of this.store.tasks()) {
      if (this.active.has(task.id) && task.lease)
        this.store.release(
          { ...task, lease: task.lease },
          'Server stopping; queued for restart.',
        );
    }
    this.abortAll();
  }
  abort(id: string) {
    this.active.get(id)?.abort(new Error('Run stopped.'));
  }
  abortAll() {
    for (const controller of this.active.values())
      controller.abort(new Error('Run stopped because settings changed.'));
  }
  /** Claims and starts every task that fits in the worker pool. */
  async tick() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const runs: Promise<void>[] = [];
      while (this.active.size < this.workers) {
        const claim = this.store.claim();
        if (!claim) break;
        runs.push(this.run(claim));
      }
      await Promise.all(runs);
    } finally {
      this.pumping = false;
    }
  }
  private async run(claim: Claim) {
    const controller = new AbortController();
    this.active.set(claim.id, controller);
    const ownershipCheck = setInterval(() => {
      if (!this.store.owns(claim))
        controller.abort(new Error('Run permission or lease was revoked.'));
    }, 100);
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error('Task exceeded the TASK_TIMEOUT_MS time limit.'),
        ),
      Number(process.env.TASK_TIMEOUT_MS) || 90_000,
    );
    try {
      const settings = this.store.settings();
      const memories = settings.memoryAllowed ? this.store.memories() : [];
      const progress = (text: string) => {
        if (!this.store.owns(claim))
          controller.abort(new Error('Run permission or lease was revoked.'));
        controller.signal.throwIfAborted();
        this.store.event(claim.id, claim.lease, text);
      };
      const result = this.execute
        ? await this.execute(claim, memories, controller.signal, progress)
        : await research(
            claim.prompt,
            memories,
            this.config,
            controller.signal,
            progress,
          );
      controller.signal.throwIfAborted();
      this.store.finish(claim, result);
    } catch (error) {
      this.store.fail(
        claim,
        error instanceof Error ? error.message : 'Unexpected research failure.',
      );
    } finally {
      clearInterval(ownershipCheck);
      clearTimeout(timeout);
      this.active.delete(claim.id);
    }
  }
}
