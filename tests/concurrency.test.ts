import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { cronNextRun, DEFAULT_TZ } from '../src/server/cron.js';
import type { Config } from '../src/server/research.js';
import type { Claim } from '../src/server/store.js';

const config: Config = {
  mode: 'sample',
  baseUrl: '',
};

const result = (text: string) => ({ text, sources: [], sample: false });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('worker pool concurrency', () => {
  it('runs tasks for three different Dots concurrently', async () => {
    const store = new Store(':memory:');
    const blockers = ['dot-a', 'dot-b', 'dot-c'].map(() => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      return { blocked, release };
    });
    let next = 0;
    const executed: Claim[] = [];
    const runner = new Runner(store, config, async (claim) => {
      executed.push(claim);
      await blockers[next++].blocked;
      return result(claim.prompt);
    });
    for (const dot of ['dot-a', 'dot-b', 'dot-c'])
      store.createTask(`Task for ${dot}`, null, dot);
    const tick = runner.tick();
    await vi.waitFor(() => expect(executed.length).toBe(3));
    expect(store.tasks().every((task) => task.status === 'running')).toBe(true);
    expect(
      new Set(store.tasks().map((task) => task.lease)).size,
    ).toBe(3);
    for (const blocker of blockers) blocker.release();
    await tick;
    expect(store.tasks().every((task) => task.status === 'completed')).toBe(
      true,
    );
    runner.stop();
    store.close();
  });
  it('respects DOT_WORKERS and defaults to three workers', () => {
    vi.stubEnv('DOT_WORKERS', '1');
    const one = new Runner(new Store(':memory:'), config);
    expect(one['workers']).toBe(1);
    vi.stubEnv('DOT_WORKERS', 'not-a-number');
    const fallback = new Runner(new Store(':memory:'), config);
    expect(fallback['workers']).toBe(3);
    one.stop();
    fallback.stop();
    one['store'].close();
    fallback['store'].close();
  });
  it('runs only one worker with DOT_WORKERS=1', async () => {
    vi.stubEnv('DOT_WORKERS', '1');
    const store = new Store(':memory:');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const executed: Claim[] = [];
    const runner = new Runner(store, config, async (claim) => {
      executed.push(claim);
      await blocked;
      return result(claim.prompt);
    });
    for (const dot of ['dot-a', 'dot-b', 'dot-c'])
      store.createTask(`Task for ${dot}`, null, dot);
    const tick = runner.tick();
    await vi.waitFor(() => expect(executed.length).toBe(1));
    expect(store.tasks().filter((task) => task.status === 'running')).toHaveLength(
      1,
    );
    release();
    await tick;
    runner.stop();
    store.close();
  });
  it('serializes two tasks for the same Dot while other Dots stay free', async () => {
    const store = new Store(':memory:');
    let running = 0;
    let peak = 0;
    const runner = new Runner(store, config, async (claim) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return result(claim.prompt);
    });
    store.createTask('First', null, 'solo');
    store.createTask('Second', null, 'solo');
    store.createTask('Other Dot', null, 'other');
    await runner.tick();
    const first = store.tasks().find((task) => task.prompt === 'First')!;
    const second = store.tasks().find((task) => task.prompt === 'Second')!;
    const other = store.tasks().find((task) => task.prompt === 'Other Dot')!;
    expect(first.status).toBe('completed');
    expect(second.status).toBe('queued');
    expect(other.status).toBe('completed');
    await runner.tick();
    expect(store.task(second.id)!.status).toBe('completed');
    expect(peak).toBe(2);
    runner.stop();
    store.close();
  });
});

describe('cron schedules', () => {
  it('computes the next cron fire in the schedule time zone', () => {
    const after = Date.parse('2026-01-15T03:00:00Z');
    expect(cronNextRun('30 9 * * *', 'America/Chicago', after)).toBe(
      Date.parse('2026-01-15T15:30:00Z'),
    );
    expect(cronNextRun('30 9 * * *', 'UTC', after)).toBe(
      Date.parse('2026-01-15T09:30:00Z'),
    );
    expect(cronNextRun('30 9 * * *', null, after)).toBe(
      cronNextRun('30 9 * * *', DEFAULT_TZ, after),
    );
  });
  it('skips wall-clock minutes that do not exist during DST transitions', () => {
    const before = Date.parse('2026-03-08T07:00:00Z');
    expect(cronNextRun('30 2 * * *', 'America/Chicago', before)).toBe(
      Date.parse('2026-03-08T08:30:00Z'),
    );
  });
  it('rejects invalid cron expressions and time zones', () => {
    expect(cronNextRun('99 * * * *', 'UTC', 0)).toBeNull();
    expect(cronNextRun('nonsense', 'UTC', 0)).toBeNull();
  });
  it('fires a cron schedule at the right minute on a fake clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    const store = new Store(':memory:');
    const task = store.createTask(
      'Morning brief',
      null,
      'dot-a',
      '30 9 * * *',
      'America/Chicago',
    );
    expect(task.cron).toBe('30 9 * * *');
    expect(task.tz).toBe('America/Chicago');
    expect(task.nextRunAt).toBe(Date.parse('2026-01-15T15:30:00Z'));
    expect(store.claim()).toBeNull();
    const due = Date.parse('2026-01-15T15:30:00Z');
    const claim = store.claim(due)!;
    expect(claim.id).toBe(task.id);
    expect(claim.attempts).toBe(1);
    expect(store.finish(claim, result('Done'), due)).toBe(true);
    expect(store.task(task.id)!.nextRunAt).toBe(
      Date.parse('2026-01-16T15:30:00Z'),
    );
    expect(store.claim(due)).toBeNull();
    const refire = store.claim(due + 24 * 60 * 60 * 1000)!;
    expect(refire.id).toBe(task.id);
    expect(refire.attempts).toBe(1);
    store.close();
    vi.useRealTimers();
  });
});

describe('interval schedules', () => {
  it('reschedules completed interval tasks exactly like before', () => {
    const store = new Store(':memory:');
    const task = store.createTask('Watch the feed', 60);
    const now = Date.now();
    const claim = store.claim(now)!;
    expect(claim.id).toBe(task.id);
    expect(store.finish(claim, result('Done'), now)).toBe(true);
    expect(store.task(task.id)!.nextRunAt).toBe(now + 60_000);
    expect(store.claim(now + 59_000)).toBeNull();
    expect(store.claim(now + 60_000)!.id).toBe(task.id);
    store.close();
  });
});

describe('work-order claim/retry/escalate', () => {
  it('retries failed tasks with a growing cooldown, then escalates once', () => {
    const store = new Store(':memory:');
    const task = store.createTask('Ship the work order', null, 'dot-a');
    let now = Date.parse('2026-01-15T12:00:00Z');
    const attempt = (at: number, error: string) => {
      const claim = store.claim(at)!;
      expect(claim.id).toBe(task.id);
      store.fail(claim, error, at);
      return store.task(task.id)!;
    };
    const first = attempt(now, 'Flaky source');
    expect(first.status).toBe('queued');
    expect(first.nextRunAt).toBe(now + 60_000);
    expect(store.claim(now)).toBeNull();
    now += 60_000;
    const second = attempt(now, 'Flaky source');
    expect(second.status).toBe('queued');
    expect(second.nextRunAt).toBe(now + 120_000);
    now += 120_000;
    const third = attempt(now, 'Flaky source');
    expect(third.status).toBe('failed');
    const escalated = store
      .detail(task.id)!
      .events.map((event) => event.text)
      .some((text) => text.includes('escalated'));
    expect(escalated).toBe(true);
    expect(store.claim(now + 600_000)).toBeNull();
    store.close();
  });
  it('resets the retry budget when a task is re-queued manually', () => {
    const store = new Store(':memory:');
    const task = store.createTask('Ship the work order', null, 'dot-a');
    const claim = store.claim()!;
    store.fail(claim, 'Flaky source');
    store.action(task.id, 'run');
    expect(store.task(task.id)!.attempts).toBe(0);
    store.close();
  });
});
