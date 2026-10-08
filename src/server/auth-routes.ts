import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AuthStore, UserRole } from './auth-store.js';

const credentials = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(200),
    role: z.enum(['guardian', 'adult', 'kid']).optional(),
    joinCode: z.string().trim().min(4).max(16).optional(),
  })
  .strict();

const joinCodeRequest = z
  .object({
    role: z.enum(['adult', 'kid']),
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
  })
  .strict();

const AVATAR_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const avatarUpload = z
  .object({
    dataUrl: z.string().min(1),
  })
  .strict();

function secureCookie(origin?: string) {
  if (!origin) return false;
  try {
    return new URL(origin).protocol === 'https:';
  } catch {
    return false;
  }
}

export function authRoutes(auth: AuthStore, origin?: string) {
  const app = new Hono();
  app.get('/config', (c) =>
    c.json({
      mode: 'family',
      bootstrap: auth.userCount() === 0,
      users: auth.userCount(),
    }),
  );
  app.post('/register', async (c) => {
    const parsed = credentials.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Enter your name, email, and an 8+ character password.' },
        400,
      );
    if (auth.userByEmail(parsed.data.email))
      return c.json({ error: 'That email is already in use.' }, 409);

    let role: UserRole;
    let joinCodeId: string | undefined;
    if (auth.userCount() === 0) {
      role = 'guardian';
    } else {
      if (!parsed.data.joinCode)
        return c.json(
          {
            error: 'Family is already set up. Ask a guardian for a join code.',
          },
          403,
        );
      const redeemed = auth.redeemJoinCode(parsed.data.joinCode);
      if (!redeemed)
        return c.json(
          { error: 'That join code is invalid, used, or expired.' },
          400,
        );
      role = redeemed.role;
      joinCodeId = redeemed.codeId;
    }

    const name = parsed.data.name ?? 'Guardian';
    const user = auth.createUser(
      name,
      parsed.data.email,
      parsed.data.password,
      role,
    );
    if (joinCodeId) auth.markJoinCodeUsed(joinCodeId, user.id);
    const token = auth.createSession(user.id);
    setCookie(c, auth.cookieName(), token, {
      httpOnly: true,
      secure: secureCookie(origin),
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 86_400,
    });
    return c.json({ user }, 201);
  });
  app.post('/login', async (c) => {
    const parsed = credentials
      .omit({ name: true, role: true })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Enter a valid email and password.' }, 400);
    const user = auth.verifyLogin(parsed.data.email, parsed.data.password);
    if (!user)
      return c.json({ error: 'Email or password was not recognized.' }, 401);
    const token = auth.createSession(user.id);
    setCookie(c, auth.cookieName(), token, {
      httpOnly: true,
      secure: secureCookie(origin),
      sameSite: 'Lax',
      path: '/',
      maxAge: 30 * 86_400,
    });
    return c.json({ user });
  });
  app.post('/logout', (c) => {
    const token = auth.sessionTokenFromContext(c);
    if (token) auth.revokeSession(token);
    deleteCookie(c, auth.cookieName(), { path: '/' });
    return c.json({ ok: true });
  });
  app.get('/me', (c) => {
    const user = auth.userFromContext(c);
    return user ? c.json({ user }) : c.json({ error: 'Not signed in.' }, 401);
  });
  app.post('/members', async (c) => {
    const actor = auth.userFromContext(c);
    if (!actor || actor.role !== 'guardian')
      return c.json({ error: 'Only a guardian can add family members.' }, 403);
    const parsed = credentials.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !parsed.data.name)
      return c.json(
        {
          error: 'Provide name, email, password, and role for the new member.',
        },
        400,
      );
    const role = (parsed.data.role ?? 'adult') as UserRole;
    if (auth.userByEmail(parsed.data.email))
      return c.json({ error: 'That email is already in use.' }, 409);
    const user = auth.createUser(
      parsed.data.name,
      parsed.data.email,
      parsed.data.password,
      role,
    );
    return c.json({ user }, 201);
  });
  app.get('/members', (c) => {
    const actor = auth.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    if (actor.role !== 'guardian')
      return c.json({ error: 'Only a guardian can list family members.' }, 403);
    return c.json({ users: auth.listUsers() });
  });
  app.post('/join-codes', async (c) => {
    const actor = auth.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    if (actor.role !== 'guardian')
      return c.json({ error: 'Only a guardian can create join codes.' }, 403);
    const parsed = joinCodeRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: 'Provide a role of adult or kid.' }, 400);
    const { code, record } = auth.createJoinCode(
      actor.id,
      parsed.data.role,
      parsed.data.expiresInHours,
    );
    return c.json({ code, record }, 201);
  });
  app.get('/join-codes', (c) => {
    const actor = auth.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    if (actor.role !== 'guardian')
      return c.json({ error: 'Only a guardian can list join codes.' }, 403);
    return c.json({ codes: auth.listJoinCodes() });
  });
  app.delete('/join-codes/:id', (c) => {
    const actor = auth.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    if (actor.role !== 'guardian')
      return c.json({ error: 'Only a guardian can revoke join codes.' }, 403);
    const ok = auth.revokeJoinCode(c.req.param('id'));
    return ok
      ? c.json({ ok: true })
      : c.json({ error: 'Code not found or already used.' }, 404);
  });
  app.post('/avatar', async (c) => {
    const actor = auth.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    const parsed = avatarUpload.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Provide an image dataUrl.' }, 400);
    const match = /^data:([^;]+);base64,(.+)$/.exec(parsed.data.dataUrl);
    const ext = match && AVATAR_MIME_EXT[match[1]!];
    if (!match || !ext)
      return c.json({ error: 'Only PNG or JPEG images are supported.' }, 400);
    const buf = Buffer.from(match[2]!, 'base64');
    if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES)
      return c.json(
        { error: 'Image must be a non-empty file up to 2MB.' },
        400,
      );
    const current = auth.userById(actor.id);
    if (current?.avatarPath) {
      await unlink(current.avatarPath).catch(() => {});
    }
    const filePath = join(auth.avatarsDir, `${actor.id}.${ext}`);
    await writeFile(filePath, buf);
    auth.setAvatarPath(actor.id, filePath);
    return c.json({ ok: true }, 201);
  });
  app.get('/avatar/:userId', async (c) => {
    const actor = auth.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    const target = auth.userById(c.req.param('userId'));
    if (!target?.avatarPath) return c.json({ error: 'No avatar.' }, 404);
    const buf = await readFile(target.avatarPath).catch(() => null);
    if (!buf) return c.json({ error: 'No avatar.' }, 404);
    const ext = target.avatarPath.split('.').pop();
    c.header('Content-Type', ext === 'png' ? 'image/png' : 'image/jpeg');
    c.header('Cache-Control', 'no-cache');
    return c.body(buf);
  });
  app.delete('/avatar', async (c) => {
    const actor = auth.userFromContext(c);
    if (!actor) return c.json({ error: 'Not signed in.' }, 401);
    const current = auth.userById(actor.id);
    if (current?.avatarPath) await unlink(current.avatarPath).catch(() => {});
    auth.setAvatarPath(actor.id, null);
    return c.json({ ok: true });
  });
  return app;
}
