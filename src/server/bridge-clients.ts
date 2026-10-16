import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';

// Thin OpenDots-side client for the existing Juelzs MCP bridges
// (mcp-emailzs on 127.0.0.1:3101, mcp-callerzs on 127.0.0.1:3102), reached
// through the existing mTLS relay path. Draft/preview only: the client
// allowlist below is enforced here AND mirrored in each bridge's own
// tool-policy JSON (the bridge's TOOL_POLICY_PATH mechanism), so a send
// capability is refused on both sides and logged both times.

export const bridgeConfigSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  /** Tool name patterns; a trailing "*" matches by prefix. Anything not matched is refused (fail-closed). */
  allow: z.array(z.string()).min(1),
  deny: z.array(z.string()).default([]),
});
export const bridgesConfigSchema = z.object({
  bridges: z.array(bridgeConfigSchema).min(1),
});
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
export type BridgesConfig = z.infer<typeof bridgesConfigSchema>;

export const DEFAULT_BRIDGE_CONFIG_PATH = 'deployment/opendots-bridges.json';

/** Fail-closed: unlike the bridge side (which falls back to allow-all when its policy file is missing), the OpenDots client refuses to expose any bridge tool without a valid config. */
export function loadBridgesConfig(
  path: string = process.env.OPENBRIDGE_CONFIG_PATH ?? DEFAULT_BRIDGE_CONFIG_PATH,
): BridgesConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `OpenDots bridge config "${path}" is missing or invalid (${
        error instanceof Error ? error.message : String(error)
      }); refusing to expose any bridge tool.`,
    );
  }
  const parsed = bridgesConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `OpenDots bridge config "${path}" failed validation: ${parsed.error.message}`,
    );
  return parsed.data;
}

export function matchesPattern(pattern: string, toolName: string): boolean {
  return pattern.endsWith('*')
    ? toolName.startsWith(pattern.slice(0, -1))
    : pattern === toolName;
}

export type ToolGateDecision = { allowed: boolean; reason: string };

/** Deny wins, then allow, and anything unmatched is denied (default-deny). */
export function gateTool(bridge: BridgeConfig, toolName: string): ToolGateDecision {
  if (bridge.deny.some((pattern) => matchesPattern(pattern, toolName)))
    return { allowed: false, reason: `deny:${bridge.name}:${toolName}` };
  if (bridge.allow.some((pattern) => matchesPattern(pattern, toolName)))
    return { allowed: true, reason: `allow:${bridge.name}:${toolName}` };
  return { allowed: false, reason: `default-deny:${bridge.name}:${toolName}` };
}

export type BridgeAuditEvent = {
  ts: string;
  side: 'client';
  bridge: string;
  tool: string;
  decision: 'allow' | 'deny';
  reason: string;
};

export function auditLine(event: BridgeAuditEvent): void {
  console.log(JSON.stringify(event));
}

const CALL_TIMEOUT_MS = 60_000;

export type BridgeToolCall = {
  ok: boolean;
  refused?: boolean;
  result: unknown;
};

/** Calls one tool on one bridge. Refusals are logged to stdout as an audit line and returned as a refused result; the tool is never sent to the bridge. */
export async function callBridgeTool(
  bridge: BridgeConfig,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
): Promise<BridgeToolCall> {
  const gate = gateTool(bridge, toolName);
  auditLine({
    ts: new Date().toISOString(),
    side: 'client',
    bridge: bridge.name,
    tool: toolName,
    decision: gate.allowed ? 'allow' : 'deny',
    reason: gate.reason,
  });
  if (!gate.allowed) return { ok: false, refused: true, result: { refused: gate.reason } };
  const client = new Client({ name: 'opendots', version: '0.1.0' });
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: AbortSignal.any([boundedSignal, ...(init?.signal ? [init.signal] : [])]),
      }),
  });
  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { signal: boundedSignal },
    );
    return { ok: !result.isError, result };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Lists a bridge's tools as the client sees them: only allowlisted tools are returned. */
export async function listBridgeTools(bridge: BridgeConfig): Promise<string[]> {
  const client = new Client({ name: 'opendots', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(bridge.url));
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((tool) => tool.name).filter((name) => gateTool(bridge, name).allowed);
  } finally {
    await client.close().catch(() => {});
  }
}

let cachedConfig: BridgesConfig | undefined;
let cachedTools: ToolDefinition[] | undefined;

/** Clears the process-wide cache (used by tests and after a config change). */
export function resetBridgeClients(): void {
  cachedConfig = undefined;
  cachedTools = undefined;
}

/**
 * Primes the bridge tool cache once at server startup, without blocking or
 * failing startup when a bridge is down. `cachedBridgeTools()` then serves
 * the Dot tool-assembly hook synchronously.
 */
export function primeBridgeTools(configPath?: string): void {
  bridgeTools(configPath).catch((error: unknown) =>
    console.warn(
      `bridge-clients: initial bridge load failed (${
        error instanceof Error ? error.message : String(error)
      }); no bridge tools exposed until a restart.`,
    ),
  );
}

/** Synchronous access for the tool-assembly hook: the cache primed at startup, or an empty list. */
export function cachedBridgeTools(): ToolDefinition[] {
  return cachedTools ?? [];
}

function toToolDefinitions(
  config: BridgesConfig,
  listed: { bridge: BridgeConfig; name: string; description: string }[],
): ToolDefinition[] {
  return listed.map(({ bridge, name, description }) => ({
    name: `bridge_${bridge.name}_${name}`,
    description: `${description} (via ${bridge.name} bridge; draft/preview only — sends are refused)`,
    parameters: z.object({}).passthrough(),
    execute: async (args: unknown) =>
      (
        await callBridgeTool(
          bridge,
          name,
          (args ?? {}) as Record<string, unknown>,
        )
      ).result,
  }));
}

/**
 * Tool definitions for every reachable bridge, filtered by the client
 * allowlist. Intended for the Dot tool-assembly hook; caches per process and
 * returns an empty list (never throws) when no bridge is reachable, so Dots
 * keep working while a bridge is down.
 */
export async function bridgeTools(
  configPath?: string,
): Promise<ToolDefinition[]> {
  if (cachedTools) return cachedTools;
  const config = cachedConfig ?? loadBridgesConfig(configPath);
  cachedConfig = config;
  const listed: { bridge: BridgeConfig; name: string; description: string }[] = [];
  for (const bridge of config.bridges) {
    try {
      const client = new Client({ name: 'opendots', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(new URL(bridge.url));
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        for (const tool of tools)
          if (gateTool(bridge, tool.name).allowed)
            listed.push({ bridge, name: tool.name, description: tool.description ?? '' });
          else
            auditLine({
              ts: new Date().toISOString(),
              side: 'client',
              bridge: bridge.name,
              tool: tool.name,
              decision: 'deny',
              reason: `default-deny:${bridge.name}:${tool.name}`,
            });
      } finally {
        await client.close().catch(() => {});
      }
    } catch (error) {
      console.warn(
        `bridge-clients: bridge "${bridge.name}" unreachable (${
          error instanceof Error ? error.message : String(error)
        }); skipping its tools.`,
      );
    }
  }
  cachedTools = toToolDefinitions(config, listed);
  return cachedTools;
}
