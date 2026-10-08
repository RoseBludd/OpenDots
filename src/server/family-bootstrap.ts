import { readFileSync } from 'node:fs';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';

export interface FamilyPackage {
  space?: { name: string; description: string };
  dot?: {
    name: string;
    instructions: string;
    researchAllowed?: boolean;
    memoryAllowed?: boolean;
  };
  settings?: { name?: string };
}

export function loadFamilyPackage(path: string): FamilyPackage {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.json')) return JSON.parse(raw) as FamilyPackage;
  const pkg: FamilyPackage = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'spaceName')
      pkg.space = { name: value, description: pkg.space?.description ?? '' };
    if (key === 'spaceDescription') {
      pkg.space = {
        name: pkg.space?.name ?? 'Family Home',
        description: value,
      };
    }
    if (key === 'dotName') {
      pkg.dot = {
        name: value,
        instructions: pkg.dot?.instructions ?? '',
        researchAllowed: pkg.dot?.researchAllowed ?? false,
        memoryAllowed: pkg.dot?.memoryAllowed ?? true,
      };
    }
    if (key === 'dotInstructions' && pkg.dot) pkg.dot.instructions = value;
    if (key === 'settingsName') pkg.settings = { name: value };
  }
  return pkg;
}

export function applyFamilyPackage(
  store: Store,
  workspace: WorkspaceStore,
  pkg: FamilyPackage,
) {
  const spaces = workspace.spaces();
  const dots = workspace.dots();
  if (spaces.length === 1 && spaces[0].name === 'Everyday' && pkg.space) {
    workspace.updateSpace(spaces[0].id, {
      name: pkg.space.name,
      description: pkg.space.description,
    });
  }
  const dot = dots[0];
  if (dot && dot.name === 'Dot' && pkg.dot) {
    workspace.updateDot(dot.id, {
      name: pkg.dot.name,
      instructions: pkg.dot.instructions,
      researchAllowed: pkg.dot.researchAllowed ?? false,
      memoryAllowed: pkg.dot.memoryAllowed ?? true,
    });
  }
  if (pkg.settings?.name) store.updateSettings({ name: pkg.settings.name });
}
