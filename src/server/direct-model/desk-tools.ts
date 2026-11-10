// Desk tools for every specialist Dot through Intelligence/CopilotKit (WO-P1 hybrid
// mode): one tool implementation (runTool, shell-guard.ts's denylist, desk-memory.ts)
// shared with direct-model mode, wrapped here as native CopilotKit tool definitions.
// Capability tiers follow each Dot's own owner-set permissions (researchAllowed is
// already covered by dot-agent.ts's search_web/read_public_page; memoryAllowed and the
// computer's shell permission gate the tools below) rather than a separate desk
// allowlist: every desk gets tools, scoped by what the owner already allowed it.
import path from 'node:path';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Dot, Settings } from '../../shared/types.js';
import type { Store } from '../store.js';
import type { WorkspaceStore } from '../workspace.js';
import { deskName, shellRunner } from './sandbox.js';
import { rememberMemory, recallMemory } from '../desk-memory.js';
import { runTool, toolsEnabled, type ToolCaps, type ToolCall, type ToolOptions } from './tools.js';

export interface DeskToolsConfig {
  /** Shared desk files (brief/state/log/transcript), read-only, one subfolder per desk. */
  filesRoot?: string;
  /** Per-desk private work folder for desk_write and the draft tools. */
  workRoot?: string;
  /** Lightweight no-secrets shell sandbox, used only when the Dot has no full computer. */
  sandboxUrl?: string;
  githubToken?: string;
  cloudflareToken?: string;
  cloudflareAccountId?: string;
}

export interface DeskToolsContext {
  store: Store;
  workspace: WorkspaceStore;
  dot: Dot;
  settings: Settings;
  /** Whether this Dot already has a full computer (which brings its own shell/file tools). */
  computerConfigured: boolean;
  config: DeskToolsConfig;
  /** Re-checked before each tool call so a stopped run or revoked permission aborts it. */
  check: () => void;
  signal: AbortSignal;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

/** Scopes a user-facing path onto "work/<path>" when there is no shared files folder, so
 * desk_ls/desk_read fall through to runTool's work-folder branch instead of failing. */
function scopeArg(arg: string, hasFilesRoot: boolean): string {
  return hasFilesRoot ? arg : `work/${arg.replace(/^\/+/, '')}`;
}

export function deskToolCaps(ctx: Pick<DeskToolsContext, 'dot' | 'settings' | 'config' | 'computerConfigured'>): ToolCaps {
  return {
    files: !!ctx.config.filesRoot || !!ctx.config.workRoot,
    shell: !ctx.computerConfigured && !!ctx.config.sandboxUrl,
    write: !!ctx.config.workRoot,
    memory: ctx.settings.memoryAllowed && ctx.dot.memoryAllowed,
    github: !!ctx.config.githubToken,
    cloudflare: !!(ctx.config.cloudflareToken && ctx.config.cloudflareAccountId),
    drafts: !!ctx.config.workRoot,
  };
}

/** Desk tool set for one Dot's run, empty when DESK_TOOLS=off or nothing is configured. */
export function deskTools(ctx: DeskToolsContext): ToolDefinition[] {
  if (!toolsEnabled()) return [];
  const caps = deskToolCaps(ctx);
  const desk = deskName(ctx.dot);
  const options: ToolOptions = {
    filesRoot: ctx.config.filesRoot ? path.join(ctx.config.filesRoot, desk) : undefined,
    workRoot: ctx.config.workRoot ? path.join(ctx.config.workRoot, desk) : undefined,
    shell: caps.shell ? shellRunner({ dotId: ctx.dot.id, desk, sandboxUrl: ctx.config.sandboxUrl, fetch: ctx.fetch }) : undefined,
    remember: caps.memory ? (text) => rememberMemory(ctx.store, ctx.workspace, ctx.dot.id, text) : undefined,
    recall: caps.memory ? (query) => recallMemory(ctx.store, ctx.workspace, ctx.dot.id, query) : undefined,
    githubToken: ctx.config.githubToken,
    cloudflareToken: ctx.config.cloudflareToken,
    cloudflareAccountId: ctx.config.cloudflareAccountId,
    signal: ctx.signal,
    fetch: ctx.fetch,
    log: ctx.log,
  };
  const run = (call: ToolCall) => {
    ctx.check();
    return runTool(call, options);
  };
  const tools: ToolDefinition[] = [];
  if (caps.memory)
    tools.push(
      defineTool({
        name: 'desk_remember',
        description: 'Store one durable memory fact or preference for this Dot. Use for lasting facts the owner states, not for chatter.',
        parameters: z.object({ fact: z.string().min(1).max(1000) }),
        execute: ({ fact }) => run({ name: 'remember', arg: fact }),
      }),
      defineTool({
        name: 'desk_recall',
        description: "Search this Dot's durable memories. Leave the query empty to list the latest ones.",
        parameters: z.object({ query: z.string().max(200).default('') }),
        execute: ({ query }) => run({ name: 'recall', arg: query }),
      }),
    );
  if (caps.files) {
    const hasFilesRoot = !!ctx.config.filesRoot;
    tools.push(
      defineTool({
        name: 'desk_ls',
        description: hasFilesRoot
          ? "List files under this desk's shared files folder (brief/state/log/transcript). Start with \".\"."
          : "List files in this desk's private work folder. Start with \".\".",
        parameters: z.object({ path: z.string().max(400).default('.') }),
        execute: ({ path: arg }) => run({ name: 'ls', arg: scopeArg(arg, hasFilesRoot) }),
      }),
      defineTool({
        name: 'desk_read',
        description: hasFilesRoot
          ? "Read a text file under this desk's shared files folder."
          : "Read a text file from this desk's private work folder.",
        parameters: z.object({ path: z.string().min(1).max(400) }),
        execute: ({ path: arg }) => run({ name: 'read', arg: scopeArg(arg, hasFilesRoot) }),
      }),
    );
  }
  if (caps.write)
    tools.push(
      defineTool({
        name: 'desk_write',
        description: "Save a text file (2 MB max, relative path) in this desk's private work folder.",
        parameters: z.object({ path: z.string().min(1).max(400), content: z.string().max(2_000_000) }),
        execute: ({ path: arg, content }) => run({ name: 'write', arg, body: content }),
      }),
    );
  if (caps.drafts)
    tools.push(
      defineTool({
        name: 'desk_draft_email',
        description: 'Save a draft email for the owner to review and send. This only saves a draft; nothing is ever sent.',
        parameters: z.object({
          to: z.string().min(1).max(320),
          subject: z.string().min(1).max(200),
          body: z.string().min(1).max(20_000),
        }),
        execute: ({ to, subject, body }) =>
          run({ name: 'draft_email', arg: `${to} | ${subject} | ${body.replace(/\n/g, '\\n')}` }),
      }),
      defineTool({
        name: 'desk_draft_slack',
        description: 'Save a draft Slack message for the owner to review and send. This only saves a draft; nothing is ever sent.',
        parameters: z.object({ channel: z.string().min(1).max(200), text: z.string().min(1).max(20_000) }),
        execute: ({ channel, text }) =>
          run({ name: 'draft_slack', arg: `${channel} | ${text.replace(/\n/g, '\\n')}` }),
      }),
    );
  if (caps.shell)
    tools.push(
      defineTool({
        name: 'desk_shell',
        description: "Run one shell command (single line, 120 s limit, output capped) in this desk's sandbox. Destructive commands are refused and come back as \"DENIED: <rule>\".",
        parameters: z.object({ command: z.string().min(1).max(4000) }),
        execute: ({ command }) => run({ name: 'shell', arg: command }),
      }),
    );
  if (caps.github)
    tools.push(
      defineTool({
        name: 'desk_github',
        description: 'Read-only GitHub REST GET, e.g. "/repos/OWNER/REPO/commits?per_page=3".',
        parameters: z.object({ path: z.string().min(1).max(400) }),
        execute: ({ path: arg }) => run({ name: 'github', arg }),
      }),
    );
  if (caps.cloudflare)
    tools.push(
      defineTool({
        name: 'desk_cloudflare',
        description: 'Read-only Cloudflare API v4 GET, e.g. "/zones?per_page=50".',
        parameters: z.object({ path: z.string().min(1).max(400) }),
        execute: ({ path: arg }) => run({ name: 'cloudflare', arg }),
      }),
    );
  return tools;
}
