import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
}

const SESSION_COOKIE = 'family_session';
const SESSION_DAYS = 30;

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

export class AuthStore {
  private db: DatabaseSync;
  constructor(
    path: string,
    private sessionSecret: string,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
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
      CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(expiresAt);`);
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
        'SELECT id, name, email, passwordHash, role, createdAt FROM users WHERE email=? COLLATE NOCASE',
      )
      .get(email.trim()) as
      | {
          id: string;
          name: string;
          email: string;
          passwordHash: string;
          role: UserRole;
          createdAt: number;
        }
      | undefined;
    return row;
  }
  userById(id: string): User | undefined {
    const row = this.db
      .prepare('SELECT id, name, email, role, createdAt FROM users WHERE id=?')
      .get(id) as User | undefined;
    return row;
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
      .run(id, name.trim(), email.trim().toLowerCase(), hashPassword(password), role, now);
    return { id, name: name.trim(), email: email.trim().toLowerCase(), role, createdAt: now };
  }
  verifyLogin(email: string, password: string): User | undefined {
    const row = this.userByEmail(email);
    if (!row || !verifyPassword(password, row.passwordHash)) return undefined;
    const { passwordHash: _, ...user } = row;
    return user;
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
        `SELECT u.id, u.name, u.email, u.role, u.createdAt FROM sessions s
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
