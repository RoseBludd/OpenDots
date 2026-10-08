import { expect, it } from 'vitest';
import { mountsFor, mountsPrompt } from '../src/server/computer-mounts.js';
import { computerInputs } from '../src/shared/computer-types.js';

const raw =
  'roofers=/c/Users/GENIUS/Rooferzs:/workspace/genius/project|/srv/shared:/workspace/genius/shared:ro|dot-x=/srv/x:/workspace/genius/x';

it('selects mounts per Dot, including unscoped ones', () => {
  expect(mountsFor(raw, 'roofers')).toEqual([
    { host: '/c/Users/GENIUS/Rooferzs', path: 'genius/project', mode: 'rw' },
    { host: '/srv/shared', path: 'genius/shared', mode: 'ro' },
  ]);
  expect(mountsFor(raw, 'other')).toEqual([
    { host: '/srv/shared', path: 'genius/shared', mode: 'ro' },
  ]);
  expect(mountsFor(undefined, 'roofers')).toEqual([]);
});
it('handles Windows drive-letter host paths', () => {
  expect(mountsFor('C:\\Users\\GENIUS:/workspace/genius', 'd')).toEqual([
    { host: 'C:\\Users\\GENIUS', path: 'genius', mode: 'rw' },
  ]);
});
it('tells the Dot where mounted folders live, and nothing when none', () => {
  expect(mountsPrompt([])).toBe('');
  const text = mountsPrompt(mountsFor(raw, 'roofers'));
  expect(text).toContain('"genius/project"');
  expect(text).toContain('read-only');
  expect(text).toContain('relative to the workspace root');
});
it('rejects host and absolute paths with an actionable message, accepts workspace-relative ones', () => {
  for (const bad of [
    'C:\\Users\\GENIUS\\OpenDots',
    '/etc/passwd',
    'genius/../x',
  ]) {
    const result = computerInputs.files_list.safeParse({ path: bad });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      'relative to the workspace root',
    );
  }
  expect(
    computerInputs.files_list.safeParse({ path: 'genius/project/src' }).success,
  ).toBe(true);
  expect(computerInputs.files_list.safeParse({}).success).toBe(true);
});
