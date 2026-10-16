import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// The supervisor's /health is deliberately unauthenticated: the compose
// healthcheck calls it without the token and reads `docker`. That is only safe
// while it is liveness only. Pin the exact upstream shape ({status, docker:
// boolean}; no version, config, counts or secrets) and the single auth bypass,
// and fail the image build closed if either changes upstream.
const HANDLER =
  'app.get("/health", async (context) =>\n  context.json({ status: "ok", docker: await reachable() }),\n);';
const BYPASS = 'if (context.req.path === "/health") return next();';

export function assertLivenessOnlyHealth(source) {
  const normalized = source.replace(/\r\n/g, '\n');
  const routes = normalized.match(/app\.(get|all|use)\(\s*"\/health/g) ?? [];
  const bypasses = normalized.match(/"\/health"/g) ?? [];
  if (
    normalized.split(HANDLER).length !== 2 ||
    normalized.split(BYPASS).length !== 2 ||
    routes.length !== 1 ||
    bypasses.length !== 2
  )
    throw new Error(
      'Pinned OpenBot /health contract changed; review before building.',
    );
  return source;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.argv[2];
  if (!path) throw new Error('Pass the pinned supervisor index.ts path.');
  assertLivenessOnlyHealth(await readFile(path, 'utf8'));
}
