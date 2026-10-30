import type { SavedRangeFocus } from '../../state/livePage';
import type { GroupId, GroupSymbol, WorkspaceWindow, ChartWindowRuntime } from '../../state/workspace';

/** Only view state crosses the floating-window channel; actions and credentials never do. */
export interface FloatingWorkspace {
  savedView: { focus: SavedRangeFocus | null; requestSeq: number };
  zOrder: string[];
  windows: Record<string, WorkspaceWindow>;
  groupSymbols: Partial<Record<GroupId, GroupSymbol>>;
  chartRuntime: Record<string, ChartWindowRuntime>;
}
export interface FloatingChange { path: string[]; value?: unknown; remove?: true }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);

/** Leaf patches preserve simultaneous edits to other windows, groups and settings. */
export function floatingChanges(before: unknown, after: unknown, path: string[] = []): FloatingChange[] {
  if (Object.is(before, after)) return [];
  if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !unsafe.has(key)).flatMap(key => floatingChanges(before[key], after[key], [...path, key]));
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [after === undefined ? { path, remove: true } : { path, value: after }];
}

export function applyFloatingChanges<T>(state: T, changes: readonly FloatingChange[]): T {
  let next = state;
  for (const change of changes) {
    if (!Array.isArray(change.path) || !change.path.length || change.path.length > 16
      || change.path.some(key => typeof key !== 'string' || unsafe.has(key))) continue;
    const write = (source: unknown, depth: number): unknown => {
      const result = { ...(object(source) ? source : {}) };
      const key = change.path[depth];
      if (depth === change.path.length - 1) {
        if (change.remove) delete result[key]; else result[key] = change.value;
      } else result[key] = write(result[key], depth + 1);
      return result;
    };
    next = write(next, 0) as T;
  }
  return next;
}

export function floatingParams(): { token: string; id: string } | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('floating');
  const id = params.get('window');
  return token && /^[a-f0-9-]{36}$/.test(token) && id && /^[\w-]{1,100}$/.test(id) ? { token, id } : null;
}
