import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AuthStore, UserRole } from './auth-store.js';

const credentials = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    email: z.string().trim().email().max(254),
    password: z.string().min(8).max(200),
    role: z.enum(['guardian', 'adult', 'kid']).optional(),
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
    if (auth.userCount() > 0)
      return c.json(
        { error: 'Family is already set up. Ask a guardian to add you.' },
        403,
      );
    const parsed = credentials.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Enter your name, email, and an 8+ character password.' }, 400);
    const name = parsed.data.name ?? 'Guardian';
    const user = auth.createUser(name, parsed.data.email, parsed.data.password, 'guardian');
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
    if (!user) return c.json({ error: 'Email or password was not recognized.' }, 401);
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
        { error: 'Provide name, email, password, and role for the new member.' },
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
  return app;
}
