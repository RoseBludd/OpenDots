import { expect, it } from 'vitest';
import { patchWorkspaceListing } from '../deployment/computers/patch-computer-workspace.mjs';
import { addExtraBinds } from '../deployment/computers/add-extra-binds.mjs';
import {
  addProjectBindsToDocker,
  addProjectBindsToIndex,
} from '../deployment/computers/add-project-binds.mjs';

const dockerBefore =
  'x\n    Binds: [\n      ...(options.spireSocketVolume\n        ? [`${options.spireSocketVolume}:/tmp/spire-agent/public:ro`]\n        : []),\n    ],\n' +
  'async function inspectOwned(names): Promise<{\n  status: string;\n  token?: string;\n} | null> {\n  return {\n      token: tokenIn(info.Config?.Env),\n  };\n}\n' +
  'type EnsureOptions = {\n  spireSocketVolume?: string;\n};\n' +
  'if (\n  existing &&\n  (!(await runsCurrentImage(existing.image, options.image)) ||\n        !holdsCurrentToken(existing.token, options.environment))\n) {}\n' +
  'createContainer({\n          Labels: labelsFor(names),\n          Env: options.environment,\n});\n';
const indexBefore =
  'app.post("/computers/:botId/ensure", async (context) => {\n    const identity = await registerEntry(parsed.names);\n    const state = await ensure(parsed.names, {\n      ...(spireSocketVolume ? { spireSocketVolume } : {}),\n    });\n});\n';

it('patches the supervisor to scope one computer to one project, failing closed on drift', () => {
  const docker = addProjectBindsToDocker(addExtraBinds(dockerBefore));
  expect(docker).toContain('options.projectPath');
  expect(docker).toContain(':/workspace/project');
  expect(docker).toContain('extraBinds(names.botId)');
  expect(docker).toContain('"opendots.project"');
  expect(docker).toContain(
    '(existing.project ?? "") !== (options.projectPath ?? "")',
  );
  const index = addProjectBindsToIndex(indexBefore);
  expect(index).toContain('projectFrom(context)');
  expect(index).toContain('COMPUTER_PROJECT_ROOT');
  expect(() => addProjectBindsToDocker('changed upstream')).toThrow(
    /Pinned OpenBot source changed/,
  );
  expect(() => addProjectBindsToIndex('changed upstream')).toThrow(
    /Pinned OpenBot source changed/,
  );
});

it('patches the computer file listing to be breadth-first and skip dependency folders, failing closed on drift', () => {
  const upstream =
    'const entries = [];\nlet truncated = false;\n      await walk(start);\n      return { path: requested, entries, truncated };\n';
  const patched = patchWorkspaceListing(upstream);
  expect(patched).toContain('queue.shift()');
  expect(patched).toContain(
    'Number(b.isDirectory()) - Number(a.isDirectory())',
  );
  expect(patched).toContain('".git"');
  expect(patched).toContain('"node_modules"');
  expect(patched).toContain('WORKSPACE_LIST_DEPTH');
  expect(patched).not.toContain('await walk(start)');
  expect(() => patchWorkspaceListing('changed upstream')).toThrow(
    /Pinned OpenBot source changed/,
  );
  expect(() => patchWorkspaceListing(upstream + upstream)).toThrow(
    /Pinned OpenBot source changed/,
  );
});
