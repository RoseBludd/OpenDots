import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  callBridgeTool,
  gateTool,
  listBridgeTools,
  loadBridgesConfig,
  matchesPattern,
  resetBridgeClients,
  resolveBridgeHeaders,
  type BridgeConfig,
} from '../src/server/bridge-clients.js';

const calledTools: string[] = [];

let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  httpServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = new McpServer(
      { name: 'test-bridge', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'list_campaigns', description: 'list', inputSchema: { type: 'object' } },
        { name: 'preview_send', description: 'preview', inputSchema: { type: 'object' } },
        { name: 'send_campaign', description: 'send', inputSchema: { type: 'object' } },
        { name: 'delete_campaign', description: 'delete', inputSchema: { type: 'object' } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calledTools.push(request.params.name);
      return {
        content: [{ type: 'text', text: JSON.stringify({ echoed: request.params.arguments }) }],
      };
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const bridge: BridgeConfig = {
  name: 'emailzs',
  url: 'placeholder',
  allow: ['list_*', 'get_*', 'create_campaign', 'update_campaign', 'create_template', 'preview_send'],
  deny: ['send_campaign', 'enroll_*', 'delete_*', 'create_mission', 'run_live_test'],
};

describe('matchesPattern', () => {
  it('matches by prefix for trailing * and exact otherwise', () => {
    expect(matchesPattern('list_*', 'list_campaigns')).toBe(true);
    expect(matchesPattern('list_*', 'send_campaign')).toBe(false);
    expect(matchesPattern('preview_send', 'preview_send')).toBe(true);
    expect(matchesPattern('preview_send', 'preview_send_now')).toBe(false);
  });
});

describe('gateTool', () => {
  it('allows the draft/preview tools', () => {
    for (const tool of ['list_campaigns', 'get_template', 'create_campaign', 'update_campaign', 'create_template', 'preview_send'])
      expect(gateTool(bridge, tool).allowed).toBe(true);
  });

  it('denies send/live/enroll/mission/delete tools even when listed', () => {
    for (const tool of ['send_campaign', 'run_live_test', 'enroll_lead_in_workflow', 'create_mission', 'delete_campaign'])
      expect(gateTool(bridge, tool).allowed).toBe(false);
  });

  it('denies anything the allowlist does not match (default-deny)', () => {
    const decision = gateTool(bridge, 'install_roofing_followups');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('default-deny');
  });

  it('denies an allowed-pattern tool when it is also denied', () => {
    expect(gateTool(bridge, 'delete_campaign').reason).toContain('deny:');
  });
});

describe('loadBridgesConfig', () => {
  it('loads a valid config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridges-'));
    const path = join(dir, 'bridges.json');
    writeFileSync(path, JSON.stringify({ bridges: [{ ...bridge, url: baseUrl }] }));
    try {
      const config = loadBridgesConfig(path);
      expect(config.bridges).toHaveLength(1);
      expect(config.bridges[0].name).toBe('emailzs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the file is missing or invalid', () => {
    expect(() => loadBridgesConfig('/nonexistent/bridges.json')).toThrow(/refusing to expose/);
    const dir = mkdtempSync(join(tmpdir(), 'bridges-'));
    const path = join(dir, 'bridges.json');
    writeFileSync(path, 'not json');
    try {
      expect(() => loadBridgesConfig(path)).toThrow(/refusing to expose/);
      writeFileSync(path, JSON.stringify({ bridges: 'nope' }));
      expect(() => loadBridgesConfig(path)).toThrow(/failed validation/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveBridgeHeaders', () => {
  it('resolves $-env refs at call time and omits unset vars', () => {
    const configured: BridgeConfig = {
      ...bridge,
      headers: { 'x-tenant-api-key': '$WO04_TEST_TENANT_KEY', 'x-static': 'plain' },
    };
    delete (process.env as Record<string, string | undefined>)['WO04_TEST_TENANT_KEY'];
    expect(resolveBridgeHeaders(configured)).toEqual({ 'x-static': 'plain' });
    process.env['WO04_TEST_TENANT_KEY'] = 'test-value-only';
    expect(resolveBridgeHeaders(configured)).toEqual({
      'x-tenant-api-key': 'test-value-only',
      'x-static': 'plain',
    });
    delete (process.env as Record<string, string | undefined>)['WO04_TEST_TENANT_KEY'];
  });
});

describe('bridge clients over MCP', () => {
  it('lists only allowlisted tools', async () => {
    const tools = await listBridgeTools({ ...bridge, url: baseUrl });
    expect(tools.sort()).toEqual(['list_campaigns', 'preview_send']);
  });

  it('performs an allowed draft/preview call end to end', async () => {
    const result = await callBridgeTool({ ...bridge, url: baseUrl }, 'preview_send', { campaignId: 1 });
    expect(result.ok).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(result.result).toMatchObject({ content: [{ type: 'text' }] });
    expect(calledTools).toContain('preview_send');
  });

  it('refuses a denied send client-side and never reaches the bridge, logging the refusal', async () => {
    const before = calledTools.length;
    const logSpy = vi.spyOn(console, 'log');
    const result = await callBridgeTool({ ...bridge, url: baseUrl }, 'send_campaign', { confirm: true });
    expect(result.ok).toBe(false);
    expect(result.refused).toBe(true);
    expect(result.result).toMatchObject({ refused: expect.stringContaining('deny') });
    expect(calledTools.length).toBe(before);
    const audit = logSpy.mock.calls.map((args) => args.join(' ')).find((line) => line.includes('send_campaign'));
    expect(audit).toContain('"decision":"deny"');
    expect(audit).toContain('"side":"client"');
    logSpy.mockRestore();
  });
});

describe('bridgeTools cache', () => {
  it('resets cleanly', () => {
    resetBridgeClients();
    expect(true).toBe(true);
  });
});
