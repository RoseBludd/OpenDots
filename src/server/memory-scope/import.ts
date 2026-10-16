// Seat and standing-rule import (WO-02, RECON Part C layout):
//   - global memories = the standing rules only (one memory per rule);
//   - each desk's seat files (seats/<desk>/BRIEF.md first, then other *.md)
//     become memories scoped to that desk's Dot, at most `maxPerDesk`, each
//     capped at `maxBytes`.
// Dry run by default. Idempotent: an identical text already in the same scope
// is skipped. Never deletes or rescopes existing memories.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Store } from '../store.js';
import type { WorkspaceStore } from '../workspace.js';
import type { Dot } from '../../shared/types.js';
import { boundedText } from './bounded.js';

export interface ImportOptions {
  seatsDir?: string;
  rulesFile?: string;
  maxPerDesk?: number;
  maxRules?: number;
  maxBytes?: number;
  apply?: boolean;
}
export interface ImportReport {
  apply: boolean;
  globals: { added: number; skipped: number };
  desks: {
    desk: string;
    dotId: string | null;
    added: number;
    skipped: number;
    truncated: number;
  }[];
  unmatchedDesks: string[];
  /** Global memories that are not standing rules; reported, never changed. */
  otherGlobals: number;
}

/** Split markdown into sections at headings; drop empty sections. */
export function sections(markdown: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join('\n').trim();
    if (text && !/^#+\s*[^\n]*$/.test(text)) out.push(text);
    current = [];
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (/^#{1,6}\s/.test(line)) flush();
    current.push(line);
  }
  flush();
  return out;
}

/** One rule per numbered or bulleted top-level item. */
export function rules(markdown: string): string[] {
  const out: string[] = [];
  let current: string | undefined;
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const item = line.match(/^(?:\d+[.)]|[-*])\s+(.*)$/);
    if (item) {
      if (current) out.push(current.trim());
      current = item[1];
    } else if (current !== undefined && /^\s+\S/.test(line)) {
      current += ` ${line.trim()}`;
    } else if (current !== undefined && !line.trim()) {
      out.push(current.trim());
      current = undefined;
    }
  }
  if (current) out.push(current.trim());
  return out.filter(Boolean);
}

/** A desk maps to the Dot whose desk field (WO-03) or name matches it. */
export function dotForDesk(dots: Dot[], desk: string): Dot | undefined {
  const key = desk.toLowerCase();
  return (
    dots.find((dot) => dot.desk === key) ??
    dots.find((dot) => dot.name.toLowerCase().replace(/\.+$/, '') === key)
  );
}

function seatFiles(seatsDir: string, desk: string): string[] {
  const dir = join(seatsDir, desk);
  if (!statSync(dir).isDirectory()) return [dir];
  const files = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort((a, b) =>
      a.toUpperCase() === 'BRIEF.MD'
        ? -1
        : b.toUpperCase() === 'BRIEF.MD'
          ? 1
          : a.localeCompare(b),
    );
  return files.map((name) => join(dir, name));
}

export function importSeatMemories(
  store: Store,
  workspace: WorkspaceStore,
  options: ImportOptions,
): ImportReport {
  const apply = options.apply ?? false;
  const maxPerDesk = options.maxPerDesk ?? 20;
  const maxRules = options.maxRules ?? 40;
  const maxBytes = options.maxBytes ?? 1500;
  const scopes = workspace.memoryScopes;
  const existing = () => scopes.annotate(store.memories());
  const has = (text: string, dotId: string | null) =>
    existing().some((memory) => memory.text === text && memory.dotId === dotId);
  const save = (text: string, dotId: string | null) => {
    if (!apply) return;
    const memory = store.saveMemory(text);
    scopes.set(memory.id, dotId);
  };
  const report: ImportReport = {
    apply,
    globals: { added: 0, skipped: 0 },
    desks: [],
    unmatchedDesks: [],
    otherGlobals: 0,
  };
  const ruleTexts: string[] = [];
  if (options.rulesFile && existsSync(options.rulesFile)) {
    for (const rule of rules(readFileSync(options.rulesFile, 'utf8')).slice(
      0,
      maxRules,
    )) {
      const text = boundedText(rule, maxBytes);
      ruleTexts.push(text);
      if (has(text, null)) report.globals.skipped++;
      else {
        save(text, null);
        report.globals.added++;
      }
    }
  }
  if (options.seatsDir && existsSync(options.seatsDir)) {
    const dots = workspace.dots();
    for (const entry of readdirSync(options.seatsDir).sort()) {
      const desk = basename(entry, '.md').toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(desk)) continue;
      const dot = dotForDesk(dots, desk);
      if (!dot) {
        report.unmatchedDesks.push(desk);
        continue;
      }
      const row = { desk, dotId: dot.id, added: 0, skipped: 0, truncated: 0 };
      const items = seatFiles(options.seatsDir, entry).flatMap((file) =>
        sections(readFileSync(file, 'utf8')),
      );
      for (const item of items.slice(0, maxPerDesk)) {
        const text = boundedText(item, maxBytes);
        if (text !== item) row.truncated++;
        if (has(text, dot.id)) row.skipped++;
        else {
          save(text, dot.id);
          row.added++;
        }
      }
      report.desks.push(row);
    }
  }
  report.otherGlobals = existing().filter(
    (memory) => memory.dotId === null && !ruleTexts.includes(memory.text),
  ).length;
  return report;
}
