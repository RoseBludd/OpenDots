import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';

// Dot computers hold no Git credentials. A push is done by the server on the host
// with the owner's own signed-in Git (for example Windows Git Credential Manager
// through git.exe under WSL), limited to repositories inside a folder mounted into
// the Dot's computer. It never forces and never prompts.
const execFileAsync = promisify(execFile);

export interface GitRunOptions {
  timeout: number;
  signal?: AbortSignal;
}
export type GitRunner = (
  command: string,
  args: string[],
  options: GitRunOptions,
) => Promise<{ stdout: string; stderr: string }>;

export const defaultGitRunner: GitRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    ...options,
    maxBuffer: 1 << 20,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

const remotePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function stripCredentials(text: string) {
  return text.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1');
}

export interface HostPushInput {
  /** Host directory (POSIX, as the server sees it) inside the mounted folder. */
  dir: string;
  /** The mounted host folder the repository must stay inside. */
  root: string;
  /** The repository may be the mounted folder itself (a dedicated project mount). */
  allowRoot?: boolean;
  remote: string;
  branch?: string;
  gitCommand?: string;
  run?: GitRunner;
  signal?: AbortSignal;
}

export async function pushFromHost(input: HostPushInput) {
  const command = input.gitCommand?.trim() || 'git';
  const run = input.run ?? defaultGitRunner;
  const options: GitRunOptions = { timeout: 120_000, signal: input.signal };
  if (!remotePattern.test(input.remote))
    throw new Error('Invalid remote name.');
  if (input.branch !== undefined && !branchPattern.test(input.branch))
    throw new Error('Invalid branch name.');
  // git.exe wants a Windows path; a Linux git wants the POSIX one.
  const windows = /\.exe$/i.test(command);
  const toGit = async (path: string) =>
    windows
      ? (await run('wslpath', ['-w', path], options)).stdout.trim()
      : path;
  const fromGit = async (path: string) =>
    windows
      ? (await run('wslpath', ['-u', path], options)).stdout.trim()
      : path;
  const git = async (args: string[]) =>
    run(command, ['-C', await toGit(input.dir), ...args], options);

  const top = (await git(['rev-parse', '--show-toplevel'])).stdout.trim();
  if (!top) throw new Error('That folder is not inside a Git repository.');
  const topReal = realpathSync(await fromGit(top));
  const rootReal = realpathSync(input.root);
  if (topReal !== rootReal && !topReal.startsWith(`${rootReal}/`))
    throw new Error(
      'That repository is outside the folders mounted for this Dot.',
    );

  if (topReal === rootReal && !input.allowRoot)
    throw new Error(
      'That is a shared workspace folder, not a project repository. Push from a repository inside it.',
    );

  const branch =
    input.branch ??
    (await git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  if (!branchPattern.test(branch))
    throw new Error(
      'Check out a branch first; a detached HEAD cannot be pushed.',
    );
  const url = stripCredentials(
    (await git(['remote', 'get-url', input.remote])).stdout.trim(),
  );
  // Fixed refspec, no force flag: a rejected non-fast-forward stays rejected.
  const pushed = await git([
    'push',
    '--porcelain',
    input.remote,
    `refs/heads/${branch}:refs/heads/${branch}`,
  ]);
  return {
    pushed: true,
    remote: input.remote,
    url,
    branch,
    output: stripCredentials(`${pushed.stdout}\n${pushed.stderr}`)
      .trim()
      .slice(-4000),
  };
}
