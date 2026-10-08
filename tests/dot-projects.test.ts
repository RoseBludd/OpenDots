import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveProjectPath } from '../src/server/project-path.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { developmentGuidance } from '../src/server/computer-guidance.js';

function root() {
  const base = mkdtempSync(join(tmpdir(), 'opendots-projects-'));
  mkdirSync(join(base, 'app', 'src'), { recursive: true });
  mkdirSync(join(base, '.ssh'));
  mkdirSync(join(base, 'app', '.git'));
  writeFileSync(join(base, 'file.txt'), 'x');
  const outside = mkdtempSync(join(tmpdir(), 'opendots-outside-'));
  symlinkSync(outside, join(base, 'escape'));
  return base;
}

it('accepts project folders inside the root and rejects everything else', () => {
  const base = root();
  expect(resolveProjectPath(join(base, 'app'), base)).toContain('/app');
  expect(resolveProjectPath(join(base, 'app', 'src'), base)).toContain('/src');
  const bad: [string, RegExp][] = [
    [base, /allowed projects root/],
    [join(base, '.ssh'), /Hidden/],
    [join(base, 'app', '.git'), /Hidden/],
    [join(base, 'file.txt'), /not found/],
    [join(base, 'missing'), /not found/],
    [join(base, 'escape'), /allowed projects root/],
    [`${base}/app/../..`, /absolute/],
    ['relative/path', /absolute/],
    [tmpdir(), /allowed projects root/],
  ];
  for (const [input, message] of bad)
    expect(() => resolveProjectPath(input, base)).toThrow(message);
  expect(() => resolveProjectPath(join(base, 'app'), undefined)).toThrow(
    /COMPUTER_PROJECT_ROOT/,
  );
});

it('maps Windows drive paths onto the WSL mount before validating', () => {
  expect(() =>
    resolveProjectPath('C:\\definitely\\missing\\folder', '/mnt/c'),
  ).toThrow(/Project folder not found: C:\\definitely/);
});

it('stores a Dot character and project folder and keeps them on partial updates', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const space = ws.spaces()[0];
  const dot = ws.createDot(
    space.id,
    'Roofers',
    'Build the platform.',
    true,
    true,
    [space.id],
    null,
    false,
    'orange',
    '/mnt/c/Users/x/Rooferzs',
  );
  expect(ws.dot(dot.id)).toMatchObject({
    avatar: 'orange',
    projectPath: '/mnt/c/Users/x/Rooferzs',
  });
  const patch = {
    name: 'Roofers',
    instructions: 'Build it well.',
    researchAllowed: true,
    memoryAllowed: true,
  };
  expect(ws.updateDot(dot.id, patch)).toMatchObject({
    avatar: 'orange',
    projectPath: '/mnt/c/Users/x/Rooferzs',
  });
  expect(
    ws.updateDot(dot.id, { ...patch, avatar: 'blue', projectPath: null }),
  ).toMatchObject({ avatar: 'blue', projectPath: null });
});

it('deletes a Dot with its conversations and protects the last Dot', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const space = ws.spaces()[0];
  const first = ws.dots()[0];
  const second = ws.createDot(
    space.id,
    'Second',
    'Do second things.',
    true,
    true,
  );
  ws.bindThread('thread-a', second.id, 'A');
  ws.bindThread('thread-b', first.id, 'B');
  ws.deleteDot(second.id);
  expect(ws.dot(second.id)).toBeUndefined();
  expect(ws.conversations().map((c) => c.id)).toEqual(['thread-b']);
  expect(ws.canAccessSpace(second.id, space.id)).toBe(false);
  expect(() => ws.deleteDot(first.id)).toThrow(/at least one Dot/);
  expect(() => ws.deleteDot('missing')).toThrow(/not found/);
});

it('tells computer-enabled Dots how to develop within the real limits', () => {
  for (const fact of [
    'git',
    'rg',
    '60 seconds',
    '64 KB',
    'background',
    'git diff',
    'secrets',
  ])
    expect(developmentGuidance).toContain(fact);
});
