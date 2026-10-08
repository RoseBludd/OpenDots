import { expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { hardenSupervisorEnvironment } from '../deployment/computers/harden-supervisor.mjs';

const upstream = `export function environmentFor(botId, env) {
  const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;
  return [\`COMPUTER_BOT_ID=\${botId}\`, \`COMPUTER_TOKEN=\${computerToken}\`];
}`;
it('gives each child its own credential without forwarding the master', async () => {
  const module = await import(
    `data:text/javascript,${encodeURIComponent(hardenSupervisorEnvironment(upstream))}`
  );
  const master = 'fixture-master-only-for-this-test';
  const first = module.environmentFor('dot-a', { COMPUTER_TOKEN: master });
  const second = module.environmentFor('dot-b', { COMPUTER_TOKEN: master });
  expect(first[1]).toBe(
    `COMPUTER_TOKEN=${createHmac('sha256', master).update('opendots-computer:dot-a').digest('hex')}`,
  );
  expect(first[1]).not.toBe(second[1]);
  expect(first.join()).not.toContain(master);
  expect(() =>
    module.environmentFor('dot-a', { COMPUTER_TOKEN: 'short' }),
  ).toThrow();
});
it('refuses missing or ambiguous upstream patch targets', () => {
  expect(() => hardenSupervisorEnvironment('changed upstream')).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorEnvironment(upstream + upstream)).toThrow(
    /contract changed/,
  );
});

import { addExtraBinds } from '../deployment/computers/add-extra-binds.mjs';

const dockerSource =
  'x\n    Binds: [\n      ...(options.spireSocketVolume\n        ? [`${options.spireSocketVolume}:/tmp/spire-agent/public:ro`]\n        : []),\n    ],\n';
async function bindsFor(botId, raw) {
  const patched = addExtraBinds(dockerSource);
  const fn = patched.slice(patched.indexOf('function extraBinds'));
  const js = fn.replace(/: string\[\]/g, '').replace(/: string/g, '');
  const previous = process.env.COMPUTER_EXTRA_BINDS;
  process.env.COMPUTER_EXTRA_BINDS = raw;
  try {
    const module = await import(
      `data:text/javascript,${encodeURIComponent(js + '\nexport { extraBinds };')}`
    );
    return module.extraBinds(botId);
  } finally {
    if (previous === undefined) delete process.env.COMPUTER_EXTRA_BINDS;
    else process.env.COMPUTER_EXTRA_BINDS = previous;
  }
}
it('mounts scoped binds only into the named Dot and unscoped binds into all', async () => {
  const raw =
    'dot-a=/srv/a:/workspace/genius/a|dot-b=/srv/b:/workspace/genius/b:ro|/srv/shared:/workspace/genius/shared:ro';
  expect(await bindsFor('dot-a', raw)).toEqual([
    '/srv/a:/workspace/genius/a',
    '/srv/shared:/workspace/genius/shared:ro',
  ]);
  expect(await bindsFor('dot-b', raw)).toEqual([
    '/srv/b:/workspace/genius/b:ro',
    '/srv/shared:/workspace/genius/shared:ro',
  ]);
  expect(await bindsFor('dot-c', raw)).toEqual([
    '/srv/shared:/workspace/genius/shared:ro',
  ]);
});
it('rejects destinations outside /workspace/genius and bad modes', async () => {
  for (const bad of [
    'dot-a=/srv/a:/workspace/other',
    '/srv/a:/workspace/geniusX',
    '/srv/a:/workspace/genius/../x',
    '/srv/a:/workspace/genius/a:rwx',
    'relative:/workspace/genius/a',
  ])
    await expect(bindsFor('dot-a', bad)).rejects.toThrow(
      /Invalid COMPUTER_EXTRA_BINDS/,
    );
});
