// Paperclip -> OpenDots wake bridge (WO-TWIN-06).
// Accepts the same /v1/runs contract the Paperclip `hermes_gateway` adapter sends
// to the Hermes API server (:8642), so Paperclip needs only an apiBaseUrl change.
// Reuses: RoseBludd/hermes gateway contract (api_server.py `/v1/runs`), the
// Paperclip hermes adapter request/response shape, OpenDots Store tasks and
// WorkspaceStore Dot threads. Standalone file; mounted with one hook in app.ts.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Context } from 'hono';
import type { Runner } from './runner.js';
import type { Store } from './store.js';
import type { WorkspaceStore } from './workspace.js';

export interface PaperclipBridgeOptions {
  store: Store;
  runner: Runner;
  workspace?: WorkspaceStore;
  /** Bridge bearer token; the bridge is disabled when absent. */
  token?: string;
  /** TSV `company<TAB>agent<TAB>dotIdOrName`; '#' comments allowed. */
  deskMapPath?: string;
  /** Comma-separated exact IPs / IPv4 CIDRs; loopback + tailnet only. */
  allowedNets?: string;
}

const DEFAULT_ALLOWED_NETS = '127.0.0.1,::1,100.64.0.0/10';
const MAX_PROMPT = 20_000;

export const bridgeError = (message: string, code: string) => ({
  error: { message, code },
});

export function parseDeskMap(path: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(path)) return map;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const row = line.split('#')[0].trim();
    if (!row) return;
    if (index === 0 && row.toLowerCase().startsWith('company')) return;
    const [company, agent, dot] = row.split('\t').map((v) => v.trim());
    if (company && agent && dot) map.set(`${company}\u0000${agent}`, dot);
  });
  return map;
}

/** `paperclip:company:<co>:agent:<agent>[:issue:<id>|:run:<id>]` -> identity. */
export function parseAgentIdentity(sessionKey: string | undefined | null) {
  const match = /^paperclip:company:([^:\s]+):agent:([^:\s]+)/.exec(
    (sessionKey ?? '').trim(),
  );
  if (!match) return null;
  return { companyId: match[1], agentId: match[2] };
}

export function clientAllowed(
  remoteAddress: string | undefined,
  allowedNets: string,
) {
  if (!remoteAddress) return false;
  const ip = remoteAddress.replace(/^::ffff:/i, '').toLowerCase();
  for (const raw of allowedNets.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === ip) return true;
    const [net, bitsRaw] = entry.split('/');
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32 || !net) continue;
    const netBytes = net.split('.').map(Number);
    const ipBytes = ip.split('.').map(Number);
    if (netBytes.length !== 4 || ipBytes.length !== 4) continue;
    if (
      [...netBytes, ...ipBytes].some(
        (n) => !Number.isInteger(n) || n < 0 || n > 255,
      )
    )
      continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const toInt = (bytes: number[]) =>
      ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    if ((toInt(netBytes) & mask) === (toInt(ipBytes) & mask)) return true;
  }
  return false;
}

export function bridgeRemoteAddress(c: Context): string | undefined {
  const env = c.env as
    | {
        remoteAddress?: unknown;
        incoming?: { socket?: { remoteAddress?: unknown } };
      }
    | undefined;
  if (typeof env?.remoteAddress === 'string') return env.remoteAddress;
  if (typeof env?.incoming?.socket?.remoteAddress === 'string')
    return env.incoming.socket.remoteAddress;
  return undefined;
}

export const HERMES_STATUS_BY_TASK: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  paused: 'interrupted',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function paperclipBridgeRoutes(options: PaperclipBridgeOptions) {
  const {
    store,
    runner,
    workspace,
    token = process.env.PAPERCLIP_BRIDGE_TOKEN,
    deskMapPath = process.env.PAPERCLIP_BRIDGE_DESK_MAP ??
      'deployment/paperclip/desk-map.tsv',
    allowedNets = process.env.PAPERCLIP_BRIDGE_ALLOWED_NETS ??
      DEFAULT_ALLOWED_NETS,
  } = options;
  const app = new Hono();
  // Duplicates are refused: Paperclip sends its run id as Idempotency-Key, and a
  // replayed create returns the original run instead of a second task.
  const idempotency = new Map<string, string>();
  const authorized = (c: Context) => {
    if (!token) return false;
    const expected = Buffer.from(token);
    const supplied = Buffer.from(
      c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
    );
    return (
      expected.length === supplied.length && timingSafeEqual(expected, supplied)
    );
  };
  const admitted = (c: Context) =>
    clientAllowed(bridgeRemoteAddress(c), allowedNets);

  app.use('*', bodyLimit({ maxSize: 2_000_000 }));
  app.use('*', async (c, next) => {
    // Fail closed: a disabled bridge looks like nothing is there, and
    // off-tailnet callers are refused before any auth check.
    if (!token)
      return c.json(bridgeError('Not found.', 'bridge_disabled'), 404);
    if (!admitted(c))
      return c.json(
        bridgeError(
          'The bridge is reachable from loopback or the tailnet only.',
          'bridge_off_net',
        ),
        403,
      );
    await next();
  });

  app.get('/health', (c) =>
    c.json({ ok: true, service: 'opendots-paperclip-bridge' }),
  );

  app.get('/v1/models', (c) => {
    if (!authorized(c))
      return c.json(
        bridgeError('Bridge authorization required.', 'bridge_auth_required'),
        401,
      );
    return c.json({
      object: 'list',
      data: [{ id: 'cadis-free', object: 'model', owned_by: 'opendots' }],
    });
  });

  const mappedDot = (companyId: string, agentId: string) => {
    if (!workspace) return undefined;
    const dots = workspace.dots();
    const entry = parseDeskMap(deskMapPath).get(`${companyId}\u0000${agentId}`);
    if (entry)
      return (
        dots.find((dot) => dot.id === entry) ??
        dots.find((dot) => dot.name.toLowerCase() === entry.toLowerCase())
      );
    // Dots-table fallback: the agent id may be the Dot id or exact Dot name.
    return (
      dots.find((dot) => dot.id === agentId) ??
      dots.find((dot) => dot.name.toLowerCase() === agentId.toLowerCase())
    );
  };

  const runPayload = (runId: string, sessionId: string | null) => {
    const detail = store.detail(runId);
    if (!detail) return undefined;
    const status = HERMES_STATUS_BY_TASK[detail.task.status] ?? 'queued';
    const last = detail.runs[0];
    return {
      object: 'hermes.run',
      run_id: detail.task.id,
      status,
      created_at: detail.task.createdAt,
      updated_at: detail.task.updatedAt,
      session_id: sessionId,
      output: status === 'completed' ? (last?.result?.text ?? null) : null,
      error:
        detail.task.error ?? (status === 'failed' ? 'Dot run failed.' : null),
      model: 'cadis-free',
      usage: null,
    };
  };

  const bridgeVisible = (runId: string) => {
    if (!workspace) return false;
    // Only tasks bound to a bridge-mapped Dot's thread are visible here.
    const threadId = workspace.taskThread(runId);
    const thread = threadId
      ? workspace.conversations().find((t) => t.id === threadId)
      : undefined;
    return !!thread && !!workspace.dot(thread.dotId);
  };

  app.post('/v1/runs', async (c) => {
    if (!authorized(c))
      return c.json(
        bridgeError('Bridge authorization required.', 'bridge_auth_required'),
        401,
      );
    if (!workspace)
      return c.json(
        bridgeError('Bridge workspace is unavailable.', 'bridge_unavailable'),
        503,
      );
    const body = (await c.req.json().catch(() => null)) as {
      input?: unknown;
      session_id?: unknown;
    } | null;
    const prompt = typeof body?.input === 'string' ? body.input.trim() : '';
    if (!prompt || prompt.length < 3 || prompt.length > MAX_PROMPT)
      return c.json(
        bridgeError(
          `Missing 'input' field, or it is not between 3 and ${MAX_PROMPT} characters.`,
          'invalid_input',
        ),
        400,
      );
    const sessionKey =
      (typeof body?.session_id === 'string' && body.session_id) ||
      c.req.header('x-hermes-session-key') ||
      null;
    const identity = parseAgentIdentity(sessionKey);
    if (!identity)
      return c.json(
        bridgeError(
          'Session key must identify a Paperclip company and agent (paperclip:company:<co>:agent:<agent>).',
          'unknown_agent',
        ),
        404,
      );
    const dot = mappedDot(identity.companyId, identity.agentId);
    if (!dot)
      return c.json(
        bridgeError(
          `Unknown agent ${identity.companyId}/${identity.agentId} for this bridge.`,
          'unknown_agent',
        ),
        404,
      );
    const idempotencyKey = (c.req.header('idempotency-key') ?? '').trim();
    if (idempotencyKey.length > 255 || /[^\u0021-\u007e]/.test(idempotencyKey))
      return c.json(
        bridgeError(
          'Idempotency-Key must be 1-255 visible ASCII characters',
          'invalid_idempotency_key',
        ),
        400,
      );
    const existing = idempotencyKey
      ? idempotency.get(idempotencyKey)
      : undefined;
    if (existing) {
      const payload = runPayload(existing, sessionKey);
      if (payload) return c.json(payload, 200);
    }
    // The desk Dot's standing thread: first bound conversation, else create one.
    const thread =
      workspace.conversations().find((t) => t.dotId === dot.id) ??
      workspace.bindThread(crypto.randomUUID(), dot.id, 'Paperclip wakes');
    const task = store.createTask(prompt, null);
    workspace.bindTask(task.id, thread.id);
    if (idempotencyKey) idempotency.set(idempotencyKey, task.id);
    return c.json(
      {
        object: 'hermes.run',
        run_id: task.id,
        status: 'queued',
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        session_id: sessionKey,
        output: null,
        error: null,
        model: 'cadis-free',
        usage: null,
        agent_id: identity.agentId,
        company_id: identity.companyId,
        desk_dot_id: dot.id,
        thread_id: thread.id,
      },
      201,
    );
  });

  app.get('/v1/runs/:runId/events', (c) =>
    c.json(
      bridgeError(
        'Bridge runs are polled; use GET /v1/runs/{run_id}.',
        'bridge_events_unsupported',
      ),
      405,
    ),
  );

  app.get('/v1/runs/:runId', (c) => {
    if (!authorized(c))
      return c.json(
        bridgeError('Bridge authorization required.', 'bridge_auth_required'),
        401,
      );
    const runId = c.req.param('runId');
    if (!bridgeVisible(runId))
      return c.json(bridgeError('Run not found.', 'run_not_found'), 404);
    const payload = runPayload(runId, null);
    return payload
      ? c.json(payload)
      : c.json(bridgeError('Run not found.', 'run_not_found'), 404);
  });

  app.post('/v1/runs/:runId/stop', async (c) => {
    if (!authorized(c))
      return c.json(
        bridgeError('Bridge authorization required.', 'bridge_auth_required'),
        401,
      );
    const runId = c.req.param('runId');
    const payload = runPayload(runId, null);
    if (!payload)
      return c.json(bridgeError('Run not found.', 'run_not_found'), 404);
    store.action(runId, 'cancel');
    runner.abort(runId);
    return c.json({
      ...payload,
      status: 'cancelled',
      object: 'hermes.run.stop',
    });
  });

  return app;
}
