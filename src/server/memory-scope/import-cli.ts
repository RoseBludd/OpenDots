// Usage (dry run unless --apply):
//   node --import tsx src/server/memory-scope/import-cli.ts \
//     --seats /mnt/genius_vol_2/opendots/seats --rules /root/oppi-twins/standing-rules.md \
//     [--max 20] [--max-bytes 1500] [--apply]
// Uses DATABASE_PATH (default data/opendots.sqlite) and OWNER_ID like the server.
import { parseArgs } from 'node:util';
import { Store } from '../store.js';
import { WorkspaceStore } from '../workspace.js';
import { importSeatMemories } from './import.js';

const { values } = parseArgs({
  options: {
    seats: { type: 'string' },
    rules: { type: 'string' },
    max: { type: 'string' },
    'max-bytes': { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});
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
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
  workspace.close();
}
