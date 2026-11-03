// Where [[shell]] runs. Order: the Dot's own desk computer (via the computer supervisor) when it is
// running and the owner enabled its shell permission; otherwise the dedicated desk-sandbox container
// (deploy/host/desk-sandbox.mjs), which has no app secrets. Never in the app process.
import type { ComputerService } from '../computer-service.js';

export const SHELL_TIMEOUT_MS = 120_000;
const COMPUTER_TIMEOUT_MS = 60_000; // the computer exec API caps a command at 60 s

// A desk computer's shell inherits its server's environment: drop anything credential-shaped first.
const CLEAN_ENV =
  'for v in $(env | cut -d= -f1 | grep -i -E "token|key|secret|passw|credential|auth"); do unset "$v"; done; ';

export function deskName(dot: { id: string; name: string; desk?: string | null }): string {
  const clean = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 64);
  return clean(dot.desk ?? '') || clean(dot.name) || clean(dot.id) || 'desk';
}

function render(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const out = [r.stdout, r.stderr, r.output].filter((v) => typeof v === 'string' && v).join('');
    const code = r.exitCode ?? r.code ?? r.status;
    if (out || code !== undefined) return `${out}${out.endsWith('\n') || !out ? '' : '\n'}exit=${code ?? '?'}`;
  }
  return JSON.stringify(result);
}

export interface ShellRunnerOptions {
  dotId: string;
  desk: string;
  computers?: ComputerService;
  sandboxUrl?: string;
  fetch?: typeof fetch;
}

/** Undefined when neither a desk computer service nor a sandbox is configured. */
export function shellRunner(options: ShellRunnerOptions) {
  if (!options.computers && !options.sandboxUrl) return undefined;
  return async (command: string, signal?: AbortSignal): Promise<string> => {
    if (options.computers) {
      const status = await options.computers.status(options.dotId).catch(() => undefined);
      if (status?.state === 'running' && status.permissions.enabled && status.permissions.shell) {
        const result = await options.computers.action(
          options.dotId,
          'exec',
          { command: `${CLEAN_ENV}${command}`, timeoutMs: COMPUTER_TIMEOUT_MS },
          'agent',
          signal,
        );
        return `[desk computer]\n${render(result)}`;
      }
    }
    if (!options.sandboxUrl) throw new Error("no sandbox is configured and this Dot's computer is not running with shell enabled");
    const response = await (options.fetch ?? fetch)(`${options.sandboxUrl.replace(/\/$/, '')}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ desk: options.desk, command, timeoutMs: SHELL_TIMEOUT_MS }),
      signal: AbortSignal.any([AbortSignal.timeout(SHELL_TIMEOUT_MS + 15_000), ...(signal ? [signal] : [])]),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`sandbox returned HTTP ${response.status}`);
    return `[sandbox]\n${text}`;
  };
}
