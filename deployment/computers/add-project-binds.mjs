import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Lets one computer mount a single host project folder instead of the global
// COMPUTER_EXTRA_BINDS. `ensure` accepts {"project": "/host/path"}; the folder
// must sit under COMPUTER_PROJECT_ROOT, may not pass through a dot-directory,
// and is mounted at /workspace/project. A computer whose project differs from
// the requested one is replaced (its named volumes are kept). Fail closed if
// the pinned upstream source changes. Run after add-extra-binds.mjs.
function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2)
    throw new Error(
      `Pinned OpenBot source changed (${label}); review before building.`,
    );
  return source.replace(before, () => after);
}

export function addProjectBindsToDocker(source) {
  let next = replaceOnce(
    source,
    '      ...extraBinds(names.botId),\n    ],',
    '      ...(options.projectPath\n        ? [`${options.projectPath}:/workspace/project`]\n        : extraBinds(names.botId)),\n    ],',
    'binds',
  );
  next = replaceOnce(
    next,
    '  token?: string;\n} | null> {',
    '  token?: string;\n  project?: string;\n} | null> {',
    'inspect type',
  );
  next = replaceOnce(
    next,
    '      token: tokenIn(info.Config?.Env),',
    '      token: tokenIn(info.Config?.Env),\n      project: info.Config?.Labels?.["opendots.project"],',
    'inspect value',
  );
  next = replaceOnce(
    next,
    '  spireSocketVolume?: string;\n};',
    '  spireSocketVolume?: string;\n  /** Host folder mounted at /workspace/project instead of the global extra binds. */\n  projectPath?: string;\n};',
    'options',
  );
  next = replaceOnce(
    next,
    '!holdsCurrentToken(existing.token, options.environment))',
    '!holdsCurrentToken(existing.token, options.environment) ||\n        (existing.project ?? "") !== (options.projectPath ?? ""))',
    'recreate',
  );
  next = replaceOnce(
    next,
    '          Labels: labelsFor(names),\n          Env: options.environment,',
    '          Labels: {\n            ...labelsFor(names),\n            ...(options.projectPath\n              ? { "opendots.project": options.projectPath }\n              : {}),\n          },\n          Env: options.environment,',
    'labels',
  );
  return next;
}

export function addProjectBindsToIndex(source) {
  let next = replaceOnce(
    source,
    '    const identity = await registerEntry(parsed.names);\n',
    '    const requested = await projectFrom(context);\n    if (requested instanceof Error)\n      return context.json({ error: requested.message }, 400);\n    const identity = await registerEntry(parsed.names);\n',
    'handler',
  );
  next = replaceOnce(
    next,
    '      ...(spireSocketVolume ? { spireSocketVolume } : {}),\n    });',
    '      ...(spireSocketVolume ? { spireSocketVolume } : {}),\n      ...(requested ? { projectPath: requested } : {}),\n    });',
    'ensure call',
  );
  return (
    next +
    `
async function projectFrom(context: any): Promise<string | undefined | Error> {
  const body = await context.req.json().catch(() => ({}));
  const project = body && typeof body === "object" ? body.project : undefined;
  if (project === undefined || project === null || project === "") return undefined;
  const root = (process.env.COMPUTER_PROJECT_ROOT ?? "").replace(/\\/+$/, "");
  if (
    typeof project !== "string" ||
    !root ||
    !project.startsWith("/") ||
    project.includes("..") ||
    project.includes(":") ||
    (project !== root && !project.startsWith(root + "/")) ||
    project.slice(root.length).split("/").some((part) => part.startsWith("."))
  )
    return new Error("Project folder must be inside COMPUTER_PROJECT_ROOT and not hidden.");
  return project;
}
`
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [docker, index] = process.argv.slice(2);
  if (!docker || !index)
    throw new Error('Pass the pinned supervisor docker.ts and index.ts paths.');
  await writeFile(
    docker,
    addProjectBindsToDocker(await readFile(docker, 'utf8')),
  );
  await writeFile(index, addProjectBindsToIndex(await readFile(index, 'utf8')));
}
