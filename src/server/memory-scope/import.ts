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
  /**
   * Opt-in: on apply, set an empty `desk` field on each matched Dot to its seat
   * name. A Dot with a desk then calls the model only with CADIS_API_KEY_<DESK>
   * (WO-03), failing until that key exists.
   */
  setDesk?: boolean;
}
export interface DeskReport {
  desk: string;
  dotId: string | null;
  dotName: string | null;
  /** How the Dot was matched: its desk field or its name. */
  matchedBy: 'desk' | 'name';
  new: number;
  skippedDuplicate: number;
  truncated: number;
  /** --set-desk outcome: the desk that was (or, in a dry run, would be) set. */
  setDesk: string | null;
}
export interface ImportReport {
  apply: boolean;
  globals: { new: number; skippedDuplicate: number };
  desks: DeskReport[];
  unmatchedDesks: string[];
  /** Global memories that are not standing rules; reported, never changed. */
  otherGlobals: number;
}

/** Content key for dedupe: list marker stripped, whitespace collapsed, case folded. */
export function normalizeMemory(text: string): string {
  return text
    .trim()
    .replace(/^(?:\d+[.)]|[-*])\s+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
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

/**
 * Seat folder -> Dot: the Dot's desk field first, then its name. Host Dots are
 * named like 'oppi. (desk)' or 'oppi.'; the trailing dot and the ' (desk)'
 * suffix are optional and matching is case-insensitive.
 */
export function dotForDesk(
  dots: Dot[],
  desk: string,
): { dot: Dot; matchedBy: 'desk' | 'name' } | undefined {
  const key = desk.toLowerCase();
  const byDesk = dots.find((dot) => dot.desk?.toLowerCase() === key);
  if (byDesk) return { dot: byDesk, matchedBy: 'desk' };
  const byName = dots.find((dot) => {
    const match = dot.name
      .trim()
      .match(/^([a-z0-9][a-z0-9-]*)\.?(?:\s*\(desk\))?$/i);
    return match?.[1].toLowerCase() === key;
  });
  return byName ? { dot: byName, matchedBy: 'name' } : undefined;
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
  // Normalized content already present per scope ('' = global); grows as we add,
  // so duplicates inside one import are skipped too.
  const seen = new Map<string, Set<string>>();
  for (const memory of scopes.annotate(store.memories())) {
    const key = memory.dotId ?? '';
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key)!.add(normalizeMemory(memory.text));
  }
  const existingGlobals = [...(seen.get('') ?? [])];
  const claim = (text: string, dotId: string | null) => {
    const key = dotId ?? '';
    const set = seen.get(key) ?? new Set<string>();
    seen.set(key, set);
    const normalized = normalizeMemory(text);
    if (set.has(normalized)) return false;
    set.add(normalized);
    if (apply) scopes.set(store.saveMemory(text).id, dotId);
    return true;
  };
  const report: ImportReport = {
    apply,
    globals: { new: 0, skippedDuplicate: 0 },
    desks: [],
    unmatchedDesks: [],
    otherGlobals: 0,
  };
  const ruleKeys = new Set<string>();
  if (options.rulesFile && existsSync(options.rulesFile)) {
    for (const rule of rules(readFileSync(options.rulesFile, 'utf8')).slice(
      0,
      maxRules,
    )) {
      const text = boundedText(rule, maxBytes);
      ruleKeys.add(normalizeMemory(text));
      if (claim(text, null)) report.globals.new++;
      else report.globals.skippedDuplicate++;
    }
  }
  if (options.seatsDir && existsSync(options.seatsDir)) {
    const dots = workspace.dots();
    for (const entry of readdirSync(options.seatsDir).sort()) {
      const desk = basename(entry, '.md').toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(desk)) continue;
      const match = dotForDesk(dots, desk);
      if (!match) {
        report.unmatchedDesks.push(desk);
        continue;
      }
      const { dot, matchedBy } = match;
      const row: DeskReport = {
        desk,
        dotId: dot.id,
        dotName: dot.name,
        matchedBy,
        new: 0,
        skippedDuplicate: 0,
        truncated: 0,
        setDesk: null,
      };
      if (options.setDesk && !dot.desk) {
        row.setDesk = desk;
        if (apply) workspace.setDotModel(dot.id, { desk });
      }
      const items = seatFiles(options.seatsDir, entry).flatMap((file) =>
        sections(readFileSync(file, 'utf8')),
      );
      for (const item of items.slice(0, maxPerDesk)) {
        const text = boundedText(item, maxBytes);
        if (text !== item) row.truncated++;
        if (claim(text, dot.id)) row.new++;
        else row.skippedDuplicate++;
      }
      report.desks.push(row);
    }
  }
  report.otherGlobals = existingGlobals.filter(
    (key) => !ruleKeys.has(key),
  ).length;
  return report;
}
