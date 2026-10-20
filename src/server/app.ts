import { computerRoutes } from './computer-routes.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { Runner } from './runner.js';
import type { WorkspaceStore } from './workspace.js';
import { parseCron, validTz } from './cron.js';
import { configured, type Config } from './research.js';
import type { Platform } from './platform.js';
import { VoiceService } from './voice.js';
import { workspaceRoutes } from './workspace-routes.js';
import { authRoutes } from './auth-routes.js';
import type { AuthStore } from './auth-store.js';
import type { DirectModel } from './direct-model/index.js';
import { directModelRoutes } from './direct-model/routes.js';
import { paperclipBridgeRoutes } from './paperclip-bridge.js';
import type { PaperclipBridgeOptions } from './paperclip-bridge.js';
import { HandoffService } from './handoff/index.js';
const interval = z.number().int().min(60).max(31_536_000).nullable();
export interface AppOptions {
  store: Store;
  runner: Runner;
  config: Config;
  ownerToken?: string;
  origin?: string;
  platform?: Platform;
  direct?: DirectModel;
  auth?: AuthStore;
  familyMode?: boolean;
  /** Workspace for the Paperclip wake bridge when neither platform nor direct mode is active. */
  workspace?: WorkspaceStore;
  /** Paperclip wake bridge (WO-TWIN-06); token absent keeps the bridge disabled. */
  paperclipBridge?: Omit<
    PaperclipBridgeOptions,
    'store' | 'runner' | 'workspace'
  >;
  handoff?: HandoffService;
}
function bearerAuthorized(
  c: { req: { header: (n: string) => string | undefined } },
  ownerToken?: string,
) {
  if (!ownerToken) return false;
  const expected = Buffer.from(ownerToken);
  const supplied = Buffer.from(
    c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
  );
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}
function ipToLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}
// Requests reach the app edge only from the tailnet guard (which overwrites
// x-forwarded-for with the real source) or from host-local loopback callers.
// Treat those sources as the owner: the network boundary is the auth layer
// (tailscale-only deployment); the bearer token remains valid and still gates
// any source that somehow presents a non-tailnet forwarded address.
// Tailnet CGNAT + host-private docker bridge networks (Traefik edge,
// app-egress members). Public sources never match, so the bearer gate still
// protects the app from anything that reaches it from the internet.
function inPrivateRanges(value: number): boolean {
  return (
    (value >= ipToLong('100.64.0.0')! && value <= ipToLong('100.127.255.255')!) ||
    (value >= ipToLong('10.0.0.0')! && value <= ipToLong('10.255.255.255')!) ||
    (value >= ipToLong('172.16.0.0')! && value <= ipToLong('172.31.255.255')!) ||
    (value >= ipToLong('192.168.0.0')! && value <= ipToLong('192.168.255.255')!)
  );
}
function trustedTailnetSource(forwarded: string | undefined): boolean {
  if (!forwarded) return false; // direct edge access keeps the bearer gate
  return forwarded.split(',').every((raw) => {
    let ip = raw.trim().toLowerCase();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (ip === '::1' || ip.startsWith('127.')) return true;
    const value = ipToLong(ip);
    if (value === null) return false;
    return inPrivateRanges(value);
  });
}
export function createApp({
  store,
  runner,
  config,
  ownerToken,
  origin,
  platform,
  direct: directOption,
  auth,
  familyMode = false,
  workspace: workspaceOption,
  paperclipBridge,
  handoff,
}: AppOptions) {
  const direct = platform ? undefined : directOption;
  // Per-Dot memory scope (WO-02) lives with the Dots; absent in sample mode.
  const workspace = platform?.workspace ?? direct?.workspace ?? workspaceOption;
  const dotIdField = z.string().min(1).max(200).nullable().optional();
  const app = new Hono();
  if (auth) app.route('/api/auth', authRoutes(auth, origin));
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 1_000_000,
      onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    }),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const requestUrl = new URL(c.req.url);
    const path = requestUrl.pathname;
    const authPublic =
      path === '/api/auth/config' ||
      path === '/api/auth/register' ||
      path === '/api/auth/login';
    const allowedHosts = new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      ...(origin ? [new URL(origin).hostname] : []),
    ]);
    if (!ownerToken && !auth && !allowedHosts.has(requestUrl.hostname))
      return c.json({ error: 'Unrecognized host.' }, 403);
    const requestOrigin = c.req.header('origin');
    const expectedOrigin = origin ?? new URL(c.req.url).origin;
    const extraOrigins = (process.env.APP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    if (
      requestOrigin &&
      requestOrigin !== expectedOrigin &&
      !extraOrigins.includes(requestOrigin)
    )
      return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    if (c.req.header('sec-fetch-site') === 'cross-site')
      return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
    const trusted = trustedTailnetSource(c.req.header('x-forwarded-for'));
    if (auth && !authPublic) {
      const sessionUser = auth.userFromContext(c);
      if (!sessionUser && !bearerAuthorized(c, ownerToken) && !trusted)
        return c.json({ error: 'Sign in to continue.' }, 401);
    } else if (ownerToken) {
      if (!bearerAuthorized(c, ownerToken) && !trusted)
        return c.json(
          { error: 'Enter your owner access token to unlock OpenDots.' },
          401,
        );
    }
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      !c.req.header('content-type')?.includes('application/json')
    )
      return c.json({ error: 'Use application/json.' }, 415);
    await next();
  });
  app.get('/api/media/:name', (c) => {
    const name = c.req.param('name');
    const type = (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
      } as Record<string, string>
    )[name.split('.').pop()?.toLowerCase() ?? ''];
    if (!type || !/^[A-Za-z0-9._-]{1,160}$/.test(name) || name.includes('..'))
      return c.json({ error: 'Not found.' }, 404);
    const file = join(process.env.MEDIA_DIR || '/data/media', name);
    if (!existsSync(file)) return c.json({ error: 'Not found.' }, 404);
    return new Response(readFileSync(file), {
      headers: {
        'Content-Type': type,
        'Cache-Control': 'private, max-age=86400',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  if (platform) app.route('/api', computerRoutes(platform.computers));
  const voice = platform ? new VoiceService(platform) : undefined;
  if (platform && voice) app.route('/api', workspaceRoutes(platform, voice));
  if (direct) app.route('/api', directModelRoutes(direct));
  app.route(
    '/paperclip',
    paperclipBridgeRoutes({ store, runner, workspace, ...paperclipBridge }),
  );
  if (handoff) {
    app.get('/api/handoff/registry', (c) => {
      return c.json(handoff.registry());
    });
  }
  app.get('/api/state', (c) =>
    c.json({
      settings: store.settings(),
      tasks: store.tasks(),
      memories: workspace
        ? workspace.memoryScopes.annotate(store.memories())
        : store.memories(),
      mode: direct ? direct.mode : config.mode,
      configured: direct ? true : configured(config),
    }),
  );
  app.post('/api/tasks', async (c) => {
    const parsed = z
      .object({
        prompt: z.string().trim().min(3).max(4000),
        intervalSeconds: interval.optional(),
        threadId: z.string().optional(),
        dotId: z.string().min(1).optional(),
        cron: z.string().optional(),
        tz: z.string().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Enter a request between 3 and 4,000 characters; repeat intervals must be at least 60 seconds.',
        },
        400,
      );
    if (!store.settings().researchAllowed)
      return c.json({ error: 'Research is disabled in Settings.' }, 403);
    if (parsed.data.cron && !parseCron(parsed.data.cron))
      return c.json(
        { error: 'Use a 5-field cron expression, e.g. "30 9 * * *".' },
        400,
      );
    if (parsed.data.tz && !validTz(parsed.data.tz))
      return c.json({ error: 'Use a valid IANA time zone name.' }, 400);
    let dotId = parsed.data.dotId ?? null;
    if (platform) {
      if (platform.setup().missing.length)
        return c.json(
          { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
          503,
        );
      if (!parsed.data.threadId)
        return c.json(
          { error: 'Select a conversation for this scheduled task.' },
          400,
        );
      try {
        dotId =
          dotId ??
          platform.workspace.requireThread(parsed.data.threadId).dotId;
      } catch {
        return c.json(
          { error: 'Conversation is not owned by this workspace.' },
          403,
        );
      }
    }
    if (direct && parsed.data.threadId) {
      try {
        dotId = dotId ?? direct.workspace.requireThread(parsed.data.threadId).dotId;
      } catch {
        return c.json(
          { error: 'Conversation is not owned by this workspace.' },
          403,
        );
      }
    }
    const task = store.createTask(
      parsed.data.prompt,
      parsed.data.cron ? null : (parsed.data.intervalSeconds ?? null),
      dotId,
      parsed.data.cron ?? null,
      parsed.data.tz ?? null,
    );
    if (platform && parsed.data.threadId)
      platform.workspace.bindTask(task.id, parsed.data.threadId);
    if (direct && parsed.data.threadId)
      direct.workspace.bindTask(task.id, parsed.data.threadId);
    return c.json(task, 201);
  });
  app.get('/api/tasks/:id', (c) => {
    const detail = store.detail(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'Task not found.' }, 404);
  });
  app.post('/api/tasks/:id/actions', async (c) => {
    const parsed = z
      .object({ action: z.enum(['run', 'pause', 'cancel']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Unknown task action.' }, 400);
    if (parsed.data.action === 'run' && !store.settings().researchAllowed)
      return c.json({ error: 'Research is disabled in Settings.' }, 403);
    const task = store.action(c.req.param('id'), parsed.data.action);
    if (parsed.data.action !== 'run') runner.abort(c.req.param('id'));
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.put('/api/tasks/:id/schedule', async (c) => {
    const parsed = z
      .object({
        intervalSeconds: interval.optional(),
        cron: z.string().optional(),
        tz: z.string().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Repeat interval must be 60 seconds to one year, or null.' },
        400,
      );
    if (parsed.data.cron !== undefined) {
      if (!parseCron(parsed.data.cron))
        return c.json(
          { error: 'Use a 5-field cron expression, e.g. "30 9 * * *".' },
          400,
        );
      if (parsed.data.tz && !validTz(parsed.data.tz))
        return c.json({ error: 'Use a valid IANA time zone name.' }, 400);
      const task = store.scheduleCron(
        c.req.param('id'),
        parsed.data.cron,
        parsed.data.tz ?? null,
      );
      return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
    }
    const task = store.schedule(
      c.req.param('id'),
      parsed.data.intervalSeconds ?? null,
    );
    return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
  });
  app.patch('/api/settings', async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        paused: z.boolean().optional(),
        researchAllowed: z.boolean().optional(),
        memoryAllowed: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid settings.' }, 400);
    const previous = store.settings();
    const settings = store.updateSettings(parsed.data);
    if (
      settings.paused ||
      !settings.researchAllowed ||
      previous.memoryAllowed !== settings.memoryAllowed
    )
      runner.abortAll();
    if (settings.paused) voice?.abortAll();
    else void voice?.resumePending();
    return c.json(settings);
  });
  app.get('/api/memories', (c) => {
    const dotId = c.req.query('dotId');
    if (dotId === undefined)
      return c.json({
        memories: workspace
          ? workspace.memoryScopes.annotate(store.memories())
          : store.memories(),
      });
    if (!workspace?.dot(dotId)) return c.json({ error: 'Dot not found.' }, 404);
    return c.json({
      memories: workspace.memoryScopes.visible(store.memories(), dotId),
    });
  });
  app.post('/api/memories', async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000), dotId: dotIdField })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    const { dotId } = parsed.data;
    if (dotId && !workspace?.dot(dotId))
      return c.json({ error: 'Dot not found.' }, 404);
    const memory = store.saveMemory(parsed.data.text);
    if (dotId && workspace) workspace.memoryScopes.set(memory.id, dotId);
    return c.json({ ...memory, dotId: dotId ?? null }, 201);
  });
  app.put('/api/memories/:id', async (c) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000), dotId: dotIdField })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Memory must be between 1 and 2,000 characters.' },
        400,
      );
    if (!store.memories().some((m) => m.id === c.req.param('id')))
      return c.json({ error: 'Memory not found.' }, 404);
    const { dotId } = parsed.data;
    if (dotId && !workspace?.dot(dotId))
      return c.json({ error: 'Dot not found.' }, 404);
    const memory = store.saveMemory(parsed.data.text, c.req.param('id'));
    if (dotId !== undefined && workspace)
      workspace.memoryScopes.set(memory.id, dotId);
    return c.json({
      ...memory,
      dotId: workspace?.memoryScopes.scopeOf(memory.id) ?? null,
    });
  });
  app.delete('/api/memories/:id', (c) =>
    store.deleteMemory(c.req.param('id'))
      ? c.json({ ok: true })
      : c.json({ error: 'Memory not found.' }, 404),
  );
  app.onError((error, c) => {
    console.error('API request failed:', error.name);
    return c.json(
      {
        error:
          'The server could not complete this request. Check server logs and database access.',
      },
      500,
    );
  });
  return app;
}
