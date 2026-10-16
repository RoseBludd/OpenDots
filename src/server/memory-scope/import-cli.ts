// Seat and standing-rule memory import. Dry run unless --apply; run with --help.
//   node dist/server/server/memory-scope/import-cli.js \
//     --seats /mnt/genius_vol_2/opendots/seats --rules /root/oppi-twins/standing-rules.md \
//     [--max 20] [--max-bytes 1500] [--set-desk] [--apply]
// (In a dev checkout: node --import tsx src/server/memory-scope/import-cli.ts ...)
// Uses DATABASE_PATH (default data/opendots.sqlite) and OWNER_ID like the server.
import { parseArgs } from 'node:util';
import { Store } from '../store.js';
import { WorkspaceStore } from '../workspace.js';
import { importSeatMemories } from './import.js';

export const HELP = `Import seat memories and standing rules (dry run unless --apply).

  --seats <dir>      seats/<desk>/ folders (BRIEF.md first) or seats/<desk>.md files
  --rules <file>     standing rules; each item becomes one global memory
  --max <n>          memories per desk (default 20)
  --max-bytes <n>    size cap per memory (default 1500)
  --apply            write; without it nothing changes and the report shows what would
  --set-desk         opt-in: set an EMPTY Dot desk field to its matched seat name.
                     WARNING: a Dot with a desk calls the model ONLY with
                     CADIS_API_KEY_<DESK> (no fallback to the shared key), so its
                     chat and tasks fail until that key is set on the server.
  --help             show this text

Desks match Dots by desk field first, then by name ('oppi.', 'oppi. (desk)',
case-insensitive). Memories already present (same text ignoring case, spacing
and list markers) are skipped as duplicates; nothing is deleted or rescoped.`;

const { values } = parseArgs({
  options: {
    seats: { type: 'string' },
    rules: { type: 'string' },
    max: { type: 'string' },
    'max-bytes': { type: 'string' },
    apply: { type: 'boolean', default: false },
    'set-desk': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (values.help || (!values.seats && !values.rules)) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
const store = new Store(database);
const workspace = new WorkspaceStore(
  database,
  process.env.OWNER_ID ?? 'opendots-owner',
);
try {
  const report = importSeatMemories(store, workspace, {
    seatsDir: values.seats,
    rulesFile: values.rules,
    maxPerDesk: values.max ? Number(values.max) : undefined,
    maxBytes: values['max-bytes'] ? Number(values['max-bytes']) : undefined,
    apply: values.apply,
    setDesk: values['set-desk'],
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
  workspace.close();
}
