import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Appends operator-declared bind mounts to computers. COMPUTER_EXTRA_BINDS is
// "|"-separated; each entry is [dotId=]host:container[:ro|rw]. An entry with a
// dotId= prefix mounts only into that Dot's computer; an unprefixed entry mounts
// into every Dot. Fail closed if the pinned upstream contract changes. Every
// destination must stay under /workspace/genius.
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
      '...(options.spireSocketVolume\n        ? [`${options.spireSocketVolume}:/tmp/spire-agent/public:ro`]\n        : []),\n      ...extraBinds(names.botId),\n    ],',
    ) +
    `
function extraBinds(botId: string): string[] {
  const raw = process.env.COMPUTER_EXTRA_BINDS?.trim();
  if (!raw) return [];
  const out: string[] = [];
  for (const item of raw.split("|").filter(Boolean)) {
    const scoped = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})=(.+)$/.exec(item);
    const entry = scoped ? scoped[2] : item;
    const parts = entry.split(":");
    const dest = parts[1];
    if (
      parts.length < 2 || parts.length > 3 || !parts[0].startsWith("/") || parts[0].includes("..") ||
      !dest || (dest !== "/workspace/genius" && !dest.startsWith("/workspace/genius/")) || dest.includes("..") ||
      (parts[2] !== undefined && parts[2] !== "ro" && parts[2] !== "rw")
    )
      throw new Error("Invalid COMPUTER_EXTRA_BINDS entry: " + item);
    if (!scoped || scoped[1] === botId) out.push(entry);
  }
  return out;
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
