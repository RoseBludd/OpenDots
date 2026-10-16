import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Action,
  Detail,
  Memory,
  Result,
  Run,
  Settings,
  Task,
  TaskEvent,
} from '../shared/types.js';
import { cronNextRun, DEFAULT_TZ, validTz } from './cron.js';

export type Claim = Task & { lease: string };
// Work-order retry budget before escalation, ported from RoseBludd/hermes
// (main @ c94cdd6) scripts/hermes-wo-tracker.sh + wo-escalation-queue.sh:
// stalled work is retried, then escalated once and left for a human.
const taskRetryLimit = () => Math.max(1, Number(process.env.DOT_TASK_RETRIES) || 3);
const defaults: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
};
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER, dotId TEXT, cron TEXT, tz TEXT, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, nextRunAt);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId, startedAt);
      CREATE INDEX IF NOT EXISTS events_task ON events(taskId, id);`);
    this.db
      .prepare('INSERT OR IGNORE INTO settings VALUES (1, ?)')
      .run(JSON.stringify(defaults));
    this.migrate();
  }
  /** Adds scheduler columns (Dot lock, cron, retry budget) to pre-existing databases. */
  private migrate() {
    const columns = (
      this.db.prepare('PRAGMA table_info(tasks)').all() as unknown as {
        name: string;
      }[]
    ).map((column) => column.name);
    const additions: Record<string, string> = {
      dotId: 'dotId TEXT',
      cron: 'cron TEXT',
      tz: 'tz TEXT',
      attempts: 'attempts INTEGER NOT NULL DEFAULT 0',
    };
    for (const [name, ddl] of Object.entries(additions))
      if (!columns.includes(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`);
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  settings(): Settings {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE id=1')
      .get() as { value: string };
    return JSON.parse(row.value) as Settings;
  }
  updateSettings(patch: Partial<Settings>): Settings {
    return this.transaction(() => {
      const previous = this.settings();
      const settings = { ...previous, ...patch };
      this.db
        .prepare('UPDATE settings SET value=? WHERE id=1')
        .run(JSON.stringify(settings));
      if (
        (!previous.paused && settings.paused) ||
        (previous.researchAllowed && !settings.researchAllowed) ||
        (previous.memoryAllowed && !settings.memoryAllowed)
      ) {
        const running = this.tasks().filter((t) => t.status === 'running');
        for (const task of running) {
          this.invalidate(
            task,
            'queued',
            'Run stopped because settings changed.',
          );
        }
      }
      return settings;
    });
  }
  tasks(): Task[] {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY createdAt DESC')
      .all() as unknown as Task[];
  }
  task(id: string): Task | undefined {
    return this.db
      .prepare('SELECT * FROM tasks WHERE id=?')
      .get(id) as unknown as Task | undefined;
  }
  createTask(
    prompt: string,
    intervalSeconds: number | null = null,
    dotId: string | null = null,
    cron: string | null = null,
    tz: string | null = null,
  ): Task {
    const now = Date.now();
    const id = randomUUID();
    const zone = cron ? (tz && validTz(tz) ? tz : DEFAULT_TZ) : null;
    this.db
      .prepare(
        "INSERT INTO tasks (id, prompt, status, intervalSeconds, dotId, cron, tz, attempts, nextRunAt, createdAt, updatedAt, error, lease, leaseUntil) VALUES (?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, NULL)",
      )
      .run(
        id,
        prompt,
        intervalSeconds,
        dotId,
        cron,
        zone,
        cron ? cronNextRun(cron, zone, now) : null,
        now,
        now,
      );
    this.event(id, null, 'Task added to the research queue.');
    return this.task(id)!;
  }
  detail(id: string): Detail | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const rows = this.db
      .prepare(
        'SELECT * FROM runs WHERE taskId=? ORDER BY startedAt DESC, rowid DESC',
      )
      .all(id) as unknown as (Omit<Run, 'result'> & {
      result: string | null;
    })[];
    return {
      task,
      runs: rows.map((row) => ({
        ...row,
        result: row.result ? (JSON.parse(row.result) as Result) : null,
      })),
      events: this.db
        .prepare('SELECT * FROM events WHERE taskId=? ORDER BY id')
        .all(id) as unknown as TaskEvent[],
    };
  }
  event(taskId: string, runId: string | null, text: string) {
    this.db
      .prepare(
        'INSERT INTO events (taskId, runId, text, createdAt) VALUES (?, ?, ?, ?)',
      )
      .run(taskId, runId, text, Date.now());
  }
  private invalidate(task: Task, status: string, reason: string) {
    const now = Date.now();
    if (task.lease)
      this.db
        .prepare(
          "UPDATE runs SET status='interrupted', finishedAt=?, error=? WHERE id=? AND status='running'",
        )
        .run(now, reason, task.lease);
    this.db
      .prepare(
        'UPDATE tasks SET status=?, lease=NULL, leaseUntil=NULL, updatedAt=? WHERE id=?',
      )
      .run(status, now, task.id);
    this.event(task.id, task.lease, reason);
  }
  action(id: string, action: Action): Task | undefined {
    return this.transaction(() => {
      const task = this.task(id);
      if (!task) return undefined;
      if (action === 'run' && task.status === 'running') return task;
      const status =
        action === 'run'
          ? 'queued'
          : action === 'pause'
            ? 'paused'
            : 'cancelled';
      this.invalidate(
        task,
        status,
        action === 'run' ? 'Task queued for a new run.' : `Task ${status}.`,
      );
      this.db
        .prepare('UPDATE tasks SET error=NULL, nextRunAt=NULL, attempts=0 WHERE id=?')
        .run(id);
      return this.task(id);
    });
  }
  schedule(id: string, intervalSeconds: number | null): Task | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const next =
      intervalSeconds && task.status === 'completed'
        ? Date.now() + intervalSeconds * 1000
        : null;
    this.db
      .prepare(
        'UPDATE tasks SET intervalSeconds=?, cron=NULL, nextRunAt=?, updatedAt=? WHERE id=?',
      )
      .run(intervalSeconds, next, Date.now(), id);
    this.event(
      id,
      null,
      intervalSeconds
        ? `Repeats every ${intervalSeconds / 60} minutes after a successful run.`
        : 'Repeat schedule removed.',
    );
    return this.task(id);
  }
  /** Time-of-day schedule: 5-field cron + IANA TZ (default America/Chicago). */
  scheduleCron(id: string, cron: string, tz?: string | null): Task | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const zone = tz && validTz(tz) ? tz : DEFAULT_TZ;
    const next =
      task.status === 'completed'
        ? cronNextRun(cron, zone, Date.now())
        : null;
    this.db
      .prepare(
        'UPDATE tasks SET cron=?, tz=?, intervalSeconds=NULL, nextRunAt=?, updatedAt=? WHERE id=?',
      )
      .run(cron, zone, next, Date.now(), id);
    this.event(
      id,
      null,
      `Repeats on cron schedule "${cron}" (${zone}) after a successful run.`,
    );
    return this.task(id);
  }
  claim(now = Date.now()): Claim | null {
    return this.transaction(() => {
      const settings = this.settings();
      if (settings.paused || !settings.researchAllowed) return null;
      const expired = this.db
        .prepare("SELECT * FROM tasks WHERE status='running' AND leaseUntil<=?")
        .all(now) as unknown as Task[];
      for (const task of expired)
        this.invalidate(
          task,
          'queued',
          'Previous worker lease expired; safely retrying.',
        );
      // Oldest-first claim, but at most one running task per Dot: a queued or
      // due task is skipped while its Dot (or the global bucket for Dot-less
      // tasks) still has a live lease. Atomic inside BEGIN IMMEDIATE.
      const task = this.db
        .prepare(
          "SELECT * FROM tasks t WHERE ((t.status='queued' AND (t.nextRunAt IS NULL OR t.nextRunAt<=?)) OR (t.status='completed' AND t.nextRunAt IS NOT NULL AND t.nextRunAt<=?)) AND NOT EXISTS (SELECT 1 FROM tasks r WHERE r.status='running' AND IFNULL(r.dotId,'')=IFNULL(t.dotId,'')) ORDER BY t.createdAt LIMIT 1",
        )
        .get(now, now) as unknown as Task | undefined;
      if (!task) return null;
      const lease = randomUUID();
      this.db
        .prepare(
          "UPDATE tasks SET status='running', lease=?, leaseUntil=?, nextRunAt=NULL, error=NULL, attempts=attempts+1, updatedAt=? WHERE id=?",
        )
        .run(lease, now + Math.max(180_000, (Number(process.env.TASK_TIMEOUT_MS) || 90_000) + 30_000), now, task.id);
      this.db
        .prepare(
          "INSERT INTO runs VALUES (?, ?, 'running', ?, NULL, NULL, NULL)",
        )
        .run(lease, task.id, now);
      this.event(task.id, lease, 'Research worker started.');
      return { ...this.task(task.id)!, lease };
    });
  }
  owns(claim: Claim): boolean {
    const task = this.task(claim.id);
    return task?.status === 'running' && task.lease === claim.lease;
  }
  finish(claim: Claim, result: Result, now = Date.now()): boolean {
    return this.transaction(() => {
      if (!this.owns(claim)) return false;
      const task = this.task(claim.id)!;
      this.db
        .prepare(
          "UPDATE runs SET status='completed', finishedAt=?, result=? WHERE id=?",
        )
        .run(now, JSON.stringify(result), claim.lease);
      this.db
        .prepare(
          "UPDATE tasks SET status='completed', lease=NULL, leaseUntil=NULL, attempts=0, updatedAt=?, nextRunAt=? WHERE id=?",
        )
        .run(
          now,
          task.intervalSeconds
            ? now + task.intervalSeconds * 1000
            : task.cron
              ? cronNextRun(task.cron, task.tz, now)
              : null,
          claim.id,
        );
      this.event(
        claim.id,
        claim.lease,
        result.sample
          ? 'Fictional sample brief ready.'
          : 'Research brief ready.',
      );
      return true;
    });
  }
  release(claim: Claim, reason: string) {
    this.transaction(() => {
      if (this.owns(claim)) this.invalidate(claim, 'queued', reason);
    });
  }
  fail(
    claim: Claim,
    error: string,
    now = Date.now(),
    retryable = true,
  ) {
    this.transaction(() => {
      if (!this.owns(claim)) return;
      const task = this.task(claim.id)!;
      const limit = taskRetryLimit();
      this.db
        .prepare(
          "UPDATE runs SET status='failed', finishedAt=?, error=? WHERE id=?",
        )
        .run(now, error, claim.lease);
      // Work-order claim/retry/escalate flow, ported from RoseBludd/hermes
      // scripts/hermes-wo-tracker.sh -> wo-escalation-queue.sh: retry with a
      // growing cooldown until the budget is spent, then escalate once.
      const attempts = task.attempts ?? 0;
      if (retryable && attempts < limit) {
        const backoffMinutes = Math.min(attempts, 5);
        this.db
          .prepare(
            "UPDATE tasks SET status='queued', lease=NULL, leaseUntil=NULL, nextRunAt=?, error=?, updatedAt=? WHERE id=?",
          )
          .run(now + backoffMinutes * 60_000, error, now, claim.id);
        this.event(
          claim.id,
          claim.lease,
          `Work order attempt ${task.attempts}/${limit} failed; retrying in ${backoffMinutes} minute(s).`,
        );
      } else {
        this.db
          .prepare(
            "UPDATE tasks SET status='failed', lease=NULL, leaseUntil=NULL, error=?, updatedAt=? WHERE id=?",
          )
          .run(error, now, claim.id);
        this.event(
          claim.id,
          claim.lease,
          `Work order escalated after ${limit} failed attempts; no further retries.`,
        );
      }
    });
  }
  memories(): Memory[] {
    return this.db
      .prepare('SELECT * FROM memories ORDER BY createdAt DESC')
      .all() as unknown as Memory[];
  }
  saveMemory(text: string, id: string = randomUUID()): Memory {
    this.db
      .prepare(
        'INSERT INTO memories VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text',
      )
      .run(id, text, Date.now());
    return this.db
      .prepare('SELECT * FROM memories WHERE id=?')
      .get(id) as unknown as Memory;
  }
  deleteMemory(id: string): boolean {
    return (
      this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0
    );
  }
}
