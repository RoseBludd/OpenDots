import { realpathSync, statSync } from 'node:fs';

/**
 * Turns a user-entered project folder (Windows `C:\Users\me\app` or a host path)
 * into the host path the supervisor will bind-mount, or throws a readable error.
 * The result must be an existing, non-hidden directory inside `root`.
 */
export function resolveProjectPath(input: string, root?: string): string {
  if (!root)
    throw new Error(
      'Dot project folders need COMPUTER_PROJECT_ROOT set on the server.',
    );
  const raw = input.trim().replaceAll('\\', '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(raw);
  const host = drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2]}` : raw;
  if (!host.startsWith('/') || host.split('/').includes('..'))
    throw new Error('Enter an absolute project folder path.');
  let real: string;
  try {
    real = realpathSync(host);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Project folder not found: ${input.trim()}`);
  }
  const base = realpathSync(root);
  const inside = real === base || real.startsWith(`${base}/`);
  if (!inside || real === base)
    throw new Error(
      'Choose a project folder inside your allowed projects root.',
    );
  if (
    real
      .slice(base.length)
      .split('/')
      .some((part) => part.startsWith('.'))
  )
    throw new Error('Hidden folders cannot be used as a project folder.');
  return real;
}
