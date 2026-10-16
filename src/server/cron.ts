// Cron parsing and next-run computation for time-of-day schedules.
// Ported from RoseBludd/hermes (main @ c94cdd6) vendor/hermes-agent/cron/jobs.py,
// which validates cron expressions with the Python `croniter` library; the
// TypeScript port uses cron-parser, the equivalent well-tested cron library,
// for 5-field cron parsing, next-run computation and IANA time zones.
import { CronExpressionParser } from 'cron-parser';

/** Default time zone for cron schedules (Juelzs HQ). */
export const DEFAULT_TZ = 'America/Chicago';

/** Returns a normalized cron expression, or null when invalid. */
export function parseCron(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  try {
    CronExpressionParser.parse(trimmed, { tz: 'UTC' });
    return trimmed;
  } catch {
    return null;
  }
}

/** True when the string names a valid IANA time zone. */
export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(tz);
    return true;
  } catch {
    return false;
  }
}

/** First fire of `expr` (time zone `tz`) strictly after `afterMs`. */
export function cronNextRun(
  expr: string,
  tz: string | null | undefined,
  afterMs: number,
): number | null {
  const normalized = parseCron(expr);
  if (!normalized) return null;
  const zone = tz && validTz(tz) ? tz : DEFAULT_TZ;
  try {
    return CronExpressionParser.parse(normalized, {
      tz: zone,
      currentDate: new Date(afterMs),
    })
      .next()
      .getTime();
  } catch {
    return null;
  }
}
