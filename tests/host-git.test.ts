import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerTools } from '../src/server/computer-tools.js';
import {
  pushFromHost,
  stripCredentials,
  type GitRunner,
} from '../src/server/host-git.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function repoRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opendots-git-')));
  mkdirSync(join(root, 'site'), { recursive: true });
  return root;
}
function runner(top: string, calls: string[][] = []): GitRunner {
  return async (_command, args) => {
    calls.push(args);
    const sub = args.slice(2);
    if (sub[0] === 'rev-parse') return { stdout: `${top}\n`, stderr: '' };
    if (sub[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '' };
    if (sub[0] === 'remote')
      return {
        stdout: 'https://user:secret-token@github.com/o/r.git\n',
        stderr: '',
      };
    return {
      stdout: '*\trefs/heads/main:refs/heads/main\t[new branch]\nDone\n',
      stderr: '',
    };
  };
}

it('pushes the current branch with a fixed refspec, never forcing, and hides credentials', async () => {
  const root = repoRoot();
  const calls: string[][] = [];
  const result = await pushFromHost({
    dir: join(root, 'site'),
    root,
    remote: 'origin',
    run: runner(join(root, 'site'), calls),
  });
  expect(result).toMatchObject({
    pushed: true,
    branch: 'main',
    url: 'https://github.com/o/r.git',
  });
  expect(JSON.stringify(result)).not.toContain('secret-token');
  const push = calls.find((args) => args[2] === 'push')!;
  expect(push.slice(2)).toEqual([
    'push',
    '--porcelain',
    'origin',
    'refs/heads/main:refs/heads/main',
  ]);
  expect(push.join(' ')).not.toMatch(/force|--delete|\+refs/);
});

it('refuses repositories outside the mounted folder and bad names', async () => {
  const root = repoRoot();
  const other = repoRoot();
  await expect(
    pushFromHost({ dir: root, root, remote: 'origin', run: runner(other) }),
  ).rejects.toThrow(/outside the folders mounted/);
  for (const remote of ['-evil', 'a b', '', 'x;rm']) {
    await expect(
      pushFromHost({ dir: root, root, remote, run: runner(root) }),
    ).rejects.toThrow(/Invalid remote/);
  }
  for (const branch of ['--force', '-d', 'a b', '']) {
    await expect(
      pushFromHost({
        dir: root,
        root,
        remote: 'origin',
        branch,
        run: runner(root),
      }),
    ).rejects.toThrow(/Invalid branch/);
  }
  expect(stripCredentials('see https://a:b@host/x and http://tok@h/y')).toBe(
    'see https://host/x and http://h/y',
  );
});

function service(extra: Partial<PlatformConfig>, run: GitRunner) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const id = workspace.dots()[0].id;
  const config = {
    baseUrl: 'http://x',
    voiceName: 'marin',
    slackUsers: [],
    computerSupervisorUrl: 'http://127.0.0.1:1',
    computerSupervisorToken: 's'.repeat(24),
    computerToken: 't'.repeat(24),
    ...extra,
  } as PlatformConfig;
  return {
    id,
    workspace,
    service: new ComputerService(
      workspace,
      config,
      () => false,
      fetch,
      1000,
      run,
    ),
  };
}

it('is off unless enabled, and needs the shell permission', async () => {
  const root = repoRoot();
  const off = service(
    { computerMounts: `${root}:/workspace/genius` },
    runner(root),
  );
  await off.service
    .permissions(off.id, { enabled: true, shell: true })
    .catch(() => undefined);
  await expect(
    off.service.action(off.id, 'git_push', { path: 'genius/site' }, 'owner'),
  ).rejects.toThrow(/not enabled/);
  const on = service(
    { computerMounts: `${root}:/workspace/genius`, computerGitPush: true },
    runner(root),
  );
  await expect(
    on.service.action(on.id, 'git_push', { path: 'genius/site' }, 'owner'),
  ).rejects.toThrow(/permission is disabled/);
});

it('maps workspace paths to mounted host folders only', async () => {
  const root = repoRoot();
  const calls: string[][] = [];
  const on = service(
    { computerMounts: `${root}:/workspace/genius`, computerGitPush: true },
    runner(join(root, 'site'), calls),
  );
  on.workspace.computers.patch(on.id, { enabled: true, shell: true });
  const ok = (await on.service.action(
    on.id,
    'git_push',
    { path: 'genius/site' },
    'owner',
  )) as { pushed: boolean };
  expect(ok.pushed).toBe(true);
  expect(calls[0]).toEqual([
    '-C',
    join(root, 'site'),
    'rev-parse',
    '--show-toplevel',
  ]);
  for (const path of ['', 'elsewhere/site', 'genius/missing', 'project']) {
    await expect(
      on.service.action(on.id, 'git_push', { path }, 'owner'),
    ).rejects.toThrow();
  }
  await expect(
    on.service.action(on.id, 'git_push', { path: 'genius/../x' }, 'owner'),
  ).rejects.toThrow();
});

it('only exposes the push tool to Dots when the server enables it', () => {
  const root = repoRoot();
  const names = (enabled: boolean) => {
    const s = service(
      { computerMounts: `${root}:/workspace/genius`, computerGitPush: enabled },
      runner(root),
    );
    return computerTools(
      s.service,
      s.id,
      () => undefined,
      new AbortController().signal,
    ).map((tool) => tool.name);
  };
  expect(names(false)).not.toContain('computer_git_push');
  expect(names(true)).toContain('computer_git_push');
});

it('refuses a repository at the root of a shared mount unless the mount is the project', async () => {
  const root = repoRoot();
  await expect(
    pushFromHost({ dir: root, root, remote: 'origin', run: runner(root) }),
  ).rejects.toThrow(/shared workspace folder/);
  const result = await pushFromHost({
    dir: root,
    root,
    allowRoot: true,
    remote: 'origin',
    run: runner(root),
  });
  expect(result.pushed).toBe(true);
});

it('treats a project-folder mount as the repository itself', async () => {
  const root = repoRoot();
  const s = service(
    { computerGitPush: true, computerProjectRoot: tmpdir() },
    runner(root),
  );
  s.workspace.updateDot(s.id, {
    ...s.workspace.dot(s.id)!,
    projectPath: root,
  });
  s.workspace.computers.patch(s.id, { enabled: true, shell: true });
  const pushed = (await s.service.action(
    s.id,
    'git_push',
    { path: 'project' },
    'owner',
  )) as { pushed: boolean };
  expect(pushed.pushed).toBe(true);
});
