import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Visibility = 'private' | 'family' | 'public';

export interface Person {
  id: string;
  name: string;
  slug: string;
  userId: string | null;
  guardianId: string;
  isMinor: boolean;
  createdAt: number;
}

export interface MemoryMedia {
  key: string;
  name: string;
  type: string;
  size: number;
}

export interface Memory {
  id: string;
  ownerUserId: string;
  ownerName: string;
  title: string;
  body: string;
  media: MemoryMedia[];
  visibility: Visibility;
  occurredAt: number | null;
  createdAt: number;
  people: Person[];
  involvingMinor: boolean;
}

export interface Share {
  id: string;
  memoryId: string;
  personId: string | null;
  scope: 'person' | 'group' | 'family';
  grantedBy: string;
  createdAt: number;
}

export interface NotificationRow {
  id: string;
  userId: string;
  memoryId: string;
  title: string;
  createdAt: number;
  readAt: number | null;
}

export interface FamilyUser {
  id: string;
  name: string;
  email: string;
  role: 'guardian' | 'adult' | 'kid';
}

type PersonMapper = (row: {
  id: string;
  name: string;
  slug: string;
  userId: string | null;
  guardianId: string;
  isMinor: number;
  createdAt: number;
}) => Person;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'member';
}

export class FamilyStore {
  private db: DatabaseSync;
  /** Injected by the routes layer so owner names resolve without a cross-table join. */
  userLookup: ((userId: string) => FamilyUser | undefined) | undefined;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        userId TEXT,
        guardianId TEXT NOT NULL,
        isMinor INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        ownerUserId TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        mediaJson TEXT NOT NULL DEFAULT '[]',
        visibility TEXT NOT NULL CHECK(visibility IN ('private','family','public')),
        occurredAt INTEGER,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_people (
        memoryId TEXT NOT NULL,
        personId TEXT NOT NULL,
        PRIMARY KEY (memoryId, personId)
      );
      CREATE TABLE IF NOT EXISTS memory_shares (
        id TEXT PRIMARY KEY,
        memoryId TEXT NOT NULL,
        personId TEXT,
        scope TEXT NOT NULL CHECK(scope IN ('person','group','family')),
        grantedBy TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_subscriptions (
        id TEXT PRIMARY KEY,
        subscriberUserId TEXT NOT NULL,
        personId TEXT,
        createdAt INTEGER NOT NULL,
        UNIQUE(subscriberUserId, personId)
      );
      CREATE TABLE IF NOT EXISTS memory_notifications (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        memoryId TEXT NOT NULL,
        title TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        readAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS memory_people_person ON memory_people(personId);
      CREATE INDEX IF NOT EXISTS notifications_user ON memory_notifications(userId);
      CREATE INDEX IF NOT EXISTS memories_occurred ON memories(occurredAt);`);
  }
  close() {
    this.db.close();
  }

  // ---- people ----
  createPerson(
    name: string,
    guardianId: string,
    userId?: string | null,
    isMinor = false,
  ): Person {
    const id = randomUUID();
    const now = Date.now();
    let slug = slugify(name);
    const exists = this.db
      .prepare('SELECT 1 FROM people WHERE slug=?')
      .get(slug);
    if (exists) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    this.db
      .prepare(
        'INSERT INTO people (id, name, slug, userId, guardianId, isMinor, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, name.trim(), slug, userId ?? null, guardianId, isMinor ? 1 : 0, now);
    return { id, name: name.trim(), slug, userId: userId ?? null, guardianId, isMinor, createdAt: now };
  }
  private personFromRow(row: {
    id: string;
    name: string;
    slug: string;
    userId: string | null;
    guardianId: string;
    isMinor: number;
    createdAt: number;
  }): Person {
    return { ...row, isMinor: !!row.isMinor };
  }
  listPeople(): Person[] {
    return this.db
      .prepare(
        'SELECT id, name, slug, userId, guardianId, isMinor, createdAt FROM people ORDER BY createdAt',
      )
      .all()
      .map((r) => this.personFromRow(r as Parameters<PersonMapper>[0]));
  }
  personById(id: string): Person | undefined {
    const row = this.db
      .prepare(
        'SELECT id, name, slug, userId, guardianId, isMinor, createdAt FROM people WHERE id=?',
      )
      .get(id) as Parameters<PersonMapper>[0] | undefined;
    return row ? this.personFromRow(row) : undefined;
  }
  personByUserId(userId: string): Person | undefined {
    const row = this.db
      .prepare(
        'SELECT id, name, slug, userId, guardianId, isMinor, createdAt FROM people WHERE userId=?',
      )
      .get(userId) as Parameters<PersonMapper>[0] | undefined;
    return row ? this.personFromRow(row) : undefined;
  }
  deletePerson(id: string): boolean {
    this.db.prepare('DELETE FROM memory_people WHERE personId=?').run(id);
    this.db.prepare('DELETE FROM memory_subscriptions WHERE personId=?').run(id);
    const r = this.db.prepare('DELETE FROM people WHERE id=?').run(id);
    return r.changes > 0;
  }

  // ---- memories ----
  createMemory(input: {
    ownerUserId: string;
    ownerName: string;
    title: string;
    body?: string;
    media?: MemoryMedia[];
    visibility: Visibility;
    occurredAt?: number | null;
    peopleIds?: string[];
  }): Memory {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO memories (id, ownerUserId, title, body, mediaJson, visibility, occurredAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.ownerUserId,
        input.title.trim(),
        input.body ?? '',
        JSON.stringify(input.media ?? []),
        input.visibility,
        input.occurredAt ?? null,
        now,
      );
    for (const pid of input.peopleIds ?? []) {
      if (this.personById(pid))
        this.db
          .prepare('INSERT OR IGNORE INTO memory_people (memoryId, personId) VALUES (?, ?)')
          .run(id, pid);
    }
    const memory = this.getMemory(id)!;
    if (input.visibility !== 'private') this.fanOut(memory);
    return memory;
  }
  private memoryPeople(memoryId: string): Person[] {
    return this.db
      .prepare(
        `SELECT p.id, p.name, p.slug, p.userId, p.guardianId, p.isMinor, p.createdAt FROM memory_people mp
         JOIN people p ON p.id = mp.personId WHERE mp.memoryId=? ORDER BY p.createdAt`,
      )
      .all(memoryId)
      .map((r) => this.personFromRow(r as Parameters<PersonMapper>[0]));
  }
  getMemory(id: string): Memory | undefined {
    const row = this.db
      .prepare(
        'SELECT id, ownerUserId, title, body, mediaJson, visibility, occurredAt, createdAt FROM memories WHERE id=?',
      )
      .get(id) as
      | {
          id: string;
          ownerUserId: string;
          title: string;
          body: string;
          mediaJson: string;
          visibility: Visibility;
          occurredAt: number | null;
          createdAt: number;
        }
      | undefined;
    if (!row) return undefined;
    const people = this.memoryPeople(row.id);
    return {
      id: row.id,
      ownerUserId: row.ownerUserId,
      ownerName: this.ownerName(row.ownerUserId),
      title: row.title,
      body: row.body,
      media: JSON.parse(row.mediaJson) as MemoryMedia[],
      visibility: row.visibility,
      occurredAt: row.occurredAt,
      createdAt: row.createdAt,
      people,
      involvingMinor: people.some((p) => p.isMinor),
    };
  }
  /** Owner display name resolved via the injected users table callback. */
  ownerName(userId: string): string {
    return this.userLookup?.(userId)?.name ?? 'Family';
  }
  /** Visibility ACL: private = owner only; family = any signed-in user; public = everyone. */
  canSee(memory: Memory, user?: FamilyUser): boolean {
    if (memory.visibility === 'public') return true;
    if (!user) return false;
    if (memory.ownerUserId === user.id) return true;
    return memory.visibility === 'family';
  }
  listMemories(user?: FamilyUser): Memory[] {
    const rows = this.db
      .prepare('SELECT id FROM memories ORDER BY createdAt DESC')
      .all() as { id: string }[];
    return rows
      .map((r) => this.getMemory(r.id)!)
      .filter((m) => this.canSee(m, user));
  }
  listMemoriesForUser(userId: string, user?: FamilyUser): Memory[] {
    return this.listMemories(user).filter((m) => m.ownerUserId === userId || this.canSee(m, user));
  }
  memoriesInvolvingPerson(personId: string, user?: FamilyUser): Memory[] {
    const rows = this.db
      .prepare('SELECT memoryId FROM memory_people WHERE personId=?')
      .all(personId) as { memoryId: string }[];
    return rows
      .map((r) => this.getMemory(r.memoryId)!)
      .filter((m) => m && this.canSee(m, user));
  }
  onThisDay(user?: FamilyUser, now = new Date()): Memory[] {
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const rows = this.db
      .prepare(
        `SELECT id, occurredAt FROM memories WHERE occurredAt IS NOT NULL
         AND CAST(strftime('%m', occurredAt / 1000, 'unixepoch') AS INTEGER) = ?
         AND CAST(strftime('%d', occurredAt / 1000, 'unixepoch') AS INTEGER) = ?
         AND CAST(strftime('%Y', occurredAt / 1000, 'unixepoch') AS INTEGER) < ?
         ORDER BY occurredAt DESC`,
      )
      .all(month, day, now.getUTCFullYear()) as { id: string }[];
    return rows
      .map((r) => this.getMemory(r.id)!)
      .filter((m) => this.canSee(m, user) && m.occurredAt !== null);
  }
  deleteMemory(id: string, userId: string): boolean {
    const m = this.getMemory(id);
    if (!m || m.ownerUserId !== userId) return false;
    this.db.prepare('DELETE FROM memory_people WHERE memoryId=?').run(id);
    this.db.prepare('DELETE FROM memory_shares WHERE memoryId=?').run(id);
    this.db.prepare('DELETE FROM memory_notifications WHERE memoryId=?').run(id);
    return this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0;
  }

  // ---- shares / subscriptions / notifications ----
  grantShare(memoryId: string, grantedBy: string, personId?: string | null, scope: Share['scope'] = 'person'): Share | undefined {
    if (!this.getMemory(memoryId)) return undefined;
    if (scope === 'person' && personId && !this.personById(personId)) return undefined;
    const share: Share = {
      id: randomUUID(),
      memoryId,
      personId: personId ?? null,
      scope,
      grantedBy,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO memory_shares (id, memoryId, personId, scope, grantedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(share.id, share.memoryId, share.personId, share.scope, share.grantedBy, share.createdAt);
    return share;
  }
  revokeShare(id: string, grantedBy: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM memory_shares WHERE id=? AND grantedBy=?')
        .run(id, grantedBy).changes > 0
    );
  }
  listShares(memoryId: string): Share[] {
    return this.db
      .prepare('SELECT id, memoryId, personId, scope, grantedBy, createdAt FROM memory_shares WHERE memoryId=?')
      .all(memoryId) as unknown as Share[];
  }
  subscribe(userId: string, personId: string | null): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO memory_subscriptions (id, subscriberUserId, personId, createdAt) VALUES (?, ?, ?, ?)',
      )
      .run(randomUUID(), userId, personId, Date.now());
  }
  unsubscribe(userId: string, personId: string | null): boolean {
    return (
      this.db
        .prepare('DELETE FROM memory_subscriptions WHERE subscriberUserId=? AND personId IS ?')
        .run(userId, personId).changes > 0
    );
  }
  listSubscriptions(userId: string): { id: string; personId: string | null }[] {
    return this.db
      .prepare('SELECT id, personId FROM memory_subscriptions WHERE subscriberUserId=?')
      .all(userId) as { id: string; personId: string | null }[];
  }
  /** Fan-out: notify subscribers of attached people + family-wide for family/public visibility. */
  fanOut(memory: Memory, notifyUserIds?: string[]): number {
    const targets = new Set<string>(notifyUserIds ?? []);
    if (memory.visibility === 'family' || memory.visibility === 'public') {
      for (const row of this.db.prepare('SELECT DISTINCT subscriberUserId AS u FROM memory_subscriptions').all() as { u: string }[])
        targets.add(row.u);
    }
    for (const person of memory.people) {
      const subs = this.db
        .prepare('SELECT subscriberUserId FROM memory_subscriptions WHERE personId=?')
        .all(person.id) as { subscriberUserId: string }[];
      for (const s of subs) targets.add(s.subscriberUserId);
    }
    targets.delete(memory.ownerUserId);
    const now = Date.now();
    let count = 0;
    for (const userId of targets) {
      if (!userId) continue;
      this.db
        .prepare(
          'INSERT INTO memory_notifications (id, userId, memoryId, title, createdAt) VALUES (?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), userId, memory.id, memory.title, now);
      count += 1;
    }
    return count;
  }
  listNotifications(userId: string): NotificationRow[] {
    return this.db
      .prepare(
        'SELECT id, userId, memoryId, title, createdAt, readAt FROM memory_notifications WHERE userId=? ORDER BY createdAt DESC LIMIT 100',
      )
      .all(userId) as unknown as NotificationRow[];
  }
  unreadCount(userId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM memory_notifications WHERE userId=? AND readAt IS NULL')
      .get(userId) as { n: number };
    return Number(row.n);
  }
  markNotificationsRead(userId: string): number {
    return Number(this.db
      .prepare('UPDATE memory_notifications SET readAt=? WHERE userId=? AND readAt IS NULL')
      .run(Date.now(), userId).changes);
  }
}
