import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// The upstream workspace listing is a depth-first walk capped at 500 entries, so
// one repository's .git folder used up the whole budget and hid the source
// files. This swaps it for a breadth-first walk (every top-level folder shows
// before anything deeper, folders before files), never descends into
// dependency/build/VCS folders (the folder itself still shows) and stops after a
// few levels; a Dot lists a deeper path to go further. Fail closed if the pinned
// source changes.
const anchor = '      await walk(start);\n';

export function patchWorkspaceListing(source) {
  if (source.split(anchor).length !== 2)
    throw new Error(
      'Pinned OpenBot source changed (workspace listing); review before building.',
    );
  return (
    source.replace(
      anchor,
      () => `      const queue: Array<[string, number]> = [[start, 0]];
      while (queue.length && !truncated) {
        const [dir, depth] = queue.shift()!;
        const found = (await readdir(dir, { withFileTypes: true })).sort(
          (a, b) =>
            Number(b.isDirectory()) - Number(a.isDirectory()) ||
            a.name.localeCompare(b.name),
        );
        for (const item of found) {
          if (entries.length >= limits.listEntries) {
            truncated = true;
            break;
          }
          const full = \`\${dir}/\${item.name}\`;
          const shown = full.slice(root.length + 1);
          if (item.isDirectory()) {
            entries.push({ path: shown, kind: "folder" });
            if (depth + 1 < LIST_DEPTH && !LIST_SKIP.has(item.name))
              queue.push([full, depth + 1]);
            continue;
          }
          if (!item.isFile()) continue;
          const size = await stat(full).catch(() => null);
          entries.push({
            path: shown,
            kind: "file",
            ...(size ? { bytes: size.size } : {}),
          });
        }
      }
`,
    ) +
    `
/** Levels shown below the listed folder; list a deeper path to see more. */
const LIST_DEPTH = Number(process.env.WORKSPACE_LIST_DEPTH) || 3;
/** Folders listed by name but never descended into: dependencies, builds, VCS and caches. */
const LIST_SKIP = new Set([
  ".git", "node_modules", ".next", ".nuxt", ".turbo", ".cache", "dist", "build", "out",
  "coverage", "__pycache__", ".venv", "venv", "target", ".gradle", ".idea", ".pytest_cache",
]);
`
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.argv[2];
  if (!path)
    throw new Error('Pass the pinned agent-computer workspace.ts path.');
  await writeFile(path, patchWorkspaceListing(await readFile(path, 'utf8')));
}
