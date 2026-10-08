import { DatabaseSync } from 'node:sqlite';
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';

export type UserRole = 'guardian' | 'adult' | 'kid';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: number;
  avatarPath?: string | null;
  avatarUpdatedAt?: number | null;
}

export interface JoinCodeRecord {
  id: string;
  role: 'adult' | 'kid';
  createdAt: number;
  expiresAt: number;
  createdByUserId: string;
  usedByUserId: string | null;
  revokedAt: number | null;
}

const SESSION_COOKIE = 'family_session';
const SESSION_DAYS = 30;
const JOIN_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function hashPassword(password: string, salt?: string): string {
  const s = salt ?? randomBytes(16).toString('hex');
  const derived = scryptSync(password, s, 32).toString('hex');
  return `scrypt:${s}:${derived}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const candidate = hashPassword(password, parts[1]);
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hashJoinCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

function generateJoinCodePlain(): string {
  let out = '';
  const bytes = randomBytes(8);
  for (let i = 0; i < 8; i++)
    out += JOIN_CODE_CHARS[bytes[i]! % JOIN_CODE_CHARS.length];
  return out;
}

export class AuthStore {
  private db: DatabaseSync;
  readonly avatarsDir: string;
  constructor(
    path: string,
    private sessionSecret: string,
  ) {
    const baseDir = path === ':memory:' ? '.' : dirname(path);
    if (path !== ':memory:') mkdirSync(baseDir, { recursive: true });
    this.avatarsDir = join(baseDir, 'avatars');
    mkdirSync(this.avatarsDir, { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        passwordHash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('guardian','adult','kid')),
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        tokenHash TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
      CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(expiresAt);
      CREATE TABLE IF NOT EXISTS join_codes (
        id TEXT PRIMARY KEY,
        codeHash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('adult','kid')),
        createdByUserId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        usedByUserId TEXT,
        revokedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS join_codes_hash ON join_codes(codeHash);`);
    this.migrateUserAvatars();
  }

  private migrateUserAvatars() {
    const cols = this.db.prepare(`PRAGMA table_info(users)`).all() as {
      name: string;
    }[];
    if (cols.some((c) => c.name === 'avatarPath')) return;
    this.db.exec(`CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        passwordHash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('guardian','adult','kid')),
        createdAt INTEGER NOT NULL,
        avatarPath TEXT,
        avatarUpdatedAt INTEGER
      );
      INSERT INTO users_new (id, name, email, passwordHash, role, createdAt)
        SELECT id, name, email, passwordHash, role, createdAt FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;`);
  }

  close() {
    this.db.close();
  }
  userCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as {
      n: number;
    };
    return row.n;
  }
  userByEmail(email: string): (User & { passwordHash: string }) | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, email, passwordHash, role, createdAt, avatarPath, avatarUpdatedAt
         FROM users WHERE email=? COLLATE NOCASE`,
      )
      .get(email.trim()) as
      | {
          id: string;
          name: string;
          email: string;
          passwordHash: string;
          role: UserRole;
          createdAt: number;
          avatarPath: string | null;
          avatarUpdatedAt: number | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      ...row,
      avatarPath: row.avatarPath ?? null,
      avatarUpdatedAt: row.avatarUpdatedAt ?? null,
    };
  }
  userById(id: string): User | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, email, role, createdAt, avatarPath, avatarUpdatedAt FROM users WHERE id=?`,
      )
      .get(id) as User | undefined;
    return row;
  }
  listUsers(): User[] {
    return this.db
      .prepare(
        `SELECT id, name, email, role, createdAt, avatarPath, avatarUpdatedAt
         FROM users ORDER BY createdAt ASC`,
      )
      .all() as unknown as User[];
  }
  createUser(
    name: string,
    email: string,
    password: string,
    role: UserRole,
  ): User {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO users (id, name, email, passwordHash, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        name.trim(),
        email.trim().toLowerCase(),
        hashPassword(password),
        role,
        now,
      );
    return {
      id,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      role,
      createdAt: now,
      avatarPath: null,
      avatarUpdatedAt: null,
    };
  }
  setAvatarPath(userId: string, avatarPath: string | null) {
    const now = Date.now();
    this.db
      .prepare('UPDATE users SET avatarPath=?, avatarUpdatedAt=? WHERE id=?')
      .run(avatarPath, avatarPath ? now : null, userId);
  }
  verifyLogin(email: string, password: string): User | undefined {
    const row = this.userByEmail(email);
    if (!row || !verifyPassword(password, row.passwordHash)) return undefined;
    const { passwordHash: _, ...user } = row;
    return user;
  }
  createJoinCode(
    createdByUserId: string,
    role: 'adult' | 'kid',
    expiresInHours = 72,
  ): { record: JoinCodeRecord; code: string } {
    const plain = generateJoinCodePlain();
    const id = randomUUID();
    const now = Date.now();
    const expiresAt = now + expiresInHours * 3_600_000;
    this.db
      .prepare(
        `INSERT INTO join_codes (id, codeHash, role, createdByUserId, createdAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, hashJoinCode(plain), role, createdByUserId, now, expiresAt);
    return {
      code: plain,
      record: {
        id,
        role,
        createdAt: now,
        expiresAt,
        createdByUserId,
        usedByUserId: null,
        revokedAt: null,
      },
    };
  }
  listJoinCodes(): JoinCodeRecord[] {
    return this.db
      .prepare(
        `SELECT id, role, createdAt, expiresAt, createdByUserId, usedByUserId, revokedAt
         FROM join_codes ORDER BY createdAt DESC`,
      )
      .all() as unknown as JoinCodeRecord[];
  }
  revokeJoinCode(id: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE join_codes SET revokedAt=? WHERE id=? AND usedByUserId IS NULL AND revokedAt IS NULL`,
      )
      .run(now, id);
    return result.changes > 0;
  }
  redeemJoinCode(
    code: string,
  ): { role: 'adult' | 'kid'; codeId: string } | undefined {
    const hash = hashJoinCode(code);
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT id, role, expiresAt, usedByUserId, revokedAt FROM join_codes WHERE codeHash=?`,
      )
      .get(hash) as
      | {
          id: string;
          role: 'adult' | 'kid';
          expiresAt: number;
          usedByUserId: string | null;
          revokedAt: number | null;
        }
      | undefined;
    if (!row || row.usedByUserId || row.revokedAt || row.expiresAt <= now)
      return undefined;
    return { role: row.role, codeId: row.id };
  }
  markJoinCodeUsed(codeId: string, userId: string) {
    this.db
      .prepare(`UPDATE join_codes SET usedByUserId=? WHERE id=?`)
      .run(userId, codeId);
  }
  private hashSessionToken(token: string): string {
    return scryptSync(token, this.sessionSecret, 32).toString('hex');
  }
  createSession(userId: string): string {
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    const now = Date.now();
    const expiresAt = now + SESSION_DAYS * 86_400_000;
    this.db
      .prepare(
        'INSERT INTO sessions (id, userId, tokenHash, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, userId, this.hashSessionToken(token), expiresAt, now);
    return token;
  }
  userFromSessionToken(token: string): User | undefined {
    const hash = this.hashSessionToken(token);
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role, u.createdAt, u.avatarPath, u.avatarUpdatedAt
         FROM sessions s
         JOIN users u ON u.id = s.userId
         WHERE s.tokenHash=? AND s.expiresAt > ?`,
      )
      .get(hash, now) as User | undefined;
    return row;
  }
  revokeSession(token: string) {
    const hash = this.hashSessionToken(token);
    this.db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(hash);
  }
  sessionTokenFromContext(c: Context): string | undefined {
    return getCookie(c, SESSION_COOKIE);
  }
  userFromContext(c: Context): User | undefined {
    const token = this.sessionTokenFromContext(c);
    return token ? this.userFromSessionToken(token) : undefined;
  }
  cookieName() {
    return SESSION_COOKIE;
  }
}
