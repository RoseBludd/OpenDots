import { describe, expect, it } from 'vitest';
import { cronNextRun, validTz } from '../src/server/cron.js';

describe('cron time zones', () => {
  it('accepts IANA zone names and rejects junk', () => {
    expect(validTz('America/Chicago')).toBe(true);
    expect(validTz('UTC')).toBe(true);
    expect(validTz('Not/AZone')).toBe(false);
  });

  it('computes the next fire in the requested zone', () => {
    const after = Date.parse('2026-11-03T12:00:00Z');
    const chicago = cronNextRun('0 8 * * *', 'America/Chicago', after);
    expect(new Date(chicago as number).toISOString()).toBe('2026-11-03T14:00:00.000Z');
  });
});
