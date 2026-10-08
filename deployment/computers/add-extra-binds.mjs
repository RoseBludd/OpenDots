import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Appends operator-declared bind mounts (COMPUTER_EXTRA_BINDS, "|"-separated
// host:container[:ro] entries) to every computer. Fail closed if the pinned
// upstream contract changes. Every destination must stay under /workspace/genius.
export function addExtraBinds(source) {
  const before =
    '...(options.spireSocketVolume\n        ? [`${options.spireSocketVolume}:/tmp/spire-agent/public:ro`]\n        : []),\n    ],';
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned OpenBot docker contract changed; review before building.',
    );
  return (
    source.replace(
      before,
      '...(options.spireSocketVolume\n        ? [`${options.spireSocketVolume}:/tmp/spire-agent/public:ro`]\n        : []),\n      ...extraBinds(),\n    ],',
    ) +
    `
function extraBinds(): string[] {
  const raw = process.env.COMPUTER_EXTRA_BINDS?.trim();
  if (!raw) return [];
  return raw.split("|").filter(Boolean).map((entry) => {
    const parts = entry.split(":");
    const dest = parts[1];
    if (parts.length < 2 || parts.length > 3 || !parts[0].startsWith("/") || !dest?.startsWith("/workspace/genius") || dest.includes(".."))
      throw new Error("Invalid COMPUTER_EXTRA_BINDS entry: " + entry);
    return entry;
  });
}
`
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.argv[2];
  if (!path) throw new Error('Pass the pinned supervisor docker.ts path.');
  await writeFile(path, addExtraBinds(await readFile(path, 'utf8')));
}
