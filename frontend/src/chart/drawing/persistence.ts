// frontend/src/chart/drawing/persistence.ts
import type { Drawing, DrawingKind, LineStyle, PaneId, DrawingDefaults } from './types';
import { PANE_SPECS } from '../paneSpecs';
import { INITIAL_DEFAULTS } from './types';

const PREFIX = 'replay.drawings.v2.';
/** Pre-slot key namespace — keyed by bare `code`. Read-only: it seeds a slot
 *  that has never been written, and is never written to again (see loadDrawings). */
const LEGACY_PREFIX = 'replay.drawings.v1.';
const VERSION = 1;

/** Timeframe bucket a drawing belongs to. Minute frames (1m~30m) share one
 *  slot: their coordinates are real-time (`realMs`) so a line drawn on 5m
 *  renders correctly on 15m, and switching among them reads as a zoom change
 *  rather than a different chart. D/W/M each get their own.
 *  Mirrors `LiveTimeframeShortcutSlot` (live/useLiveKeyboard.ts). */
export type DrawingSlot = 'minute' | 'D' | 'W' | 'M';

/** The persistence/store key: a `code` scoped to one timeframe slot.
 *  `|` is safe as the separator — it appears in neither symbol codes nor index
 *  ids, and matches the repo's existing composite-key convention
 *  (LiveChartRoot's `${code}|${timeframe}|…` viewKey). */
export function drawingScope(code: string, slot: DrawingSlot): string {
  return `${code}|${slot}`;
}

/** Inverse of `drawingScope`. A scope with no separator is treated as a bare
 *  code (defensive — no such value is written by this build). */
export function parseScope(scope: string): { code: string; slot: DrawingSlot | null } {
  const i = scope.lastIndexOf('|');
  if (i < 0) return { code: scope, slot: null };
  return { code: scope.slice(0, i), slot: scope.slice(i + 1) as DrawingSlot };
}

/** Kinds this build knows how to render. Items with any other kind (corruption,
 *  or a shape written by a newer build) are dropped on load rather than
 *  crashing the exhaustive render/hit-test switches. */
const KNOWN_KINDS: ReadonlySet<string> = new Set<DrawingKind>([
  'hline',
  'vline',
  'trendline',
  'rect',
  'measure',
  'text',
  'pencil',
]);

export function storageKey(scope: string): string {
  return `${PREFIX}${scope}`;
}

export function legacyStorageKey(code: string): string {
  return `${LEGACY_PREFIX}${code}`;
}

type Wrapper = { v: number; items: unknown };

/** Legacy in-memory shape — readers tolerate items missing paneId or lineStyle,
 *  and carrying the never-shipped numeric paneIndex from dev branches. */
type LegacyItem = Omit<Drawing, 'paneId' | 'lineStyle'> & {
  paneId?: PaneId;
  paneIndex?: number;
  lineStyle?: LineStyle;
};

function resolvePaneId(item: LegacyItem): PaneId {
  if (typeof item.paneId === 'string') return item.paneId;
  if (
    typeof item.paneIndex === 'number' &&
    PANE_SPECS[item.paneIndex] != null
  ) {
    return PANE_SPECS[item.paneIndex].name;
  }
  return 'candle';
}

/** Read one key. `null` means the key is absent — distinct from a present-but-
 *  empty list, which the slot-seeding rule in `loadDrawings` depends on. */
function readKey(key: string): Drawing[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw == null) return null;
  let parsed: Wrapper;
  try {
    parsed = JSON.parse(raw) as Wrapper;
  } catch {
    return [];
  }
  if (parsed == null || parsed.v !== VERSION) return [];
  return normalizeItems(parsed.items);
}

/**
 * Load the drawings for one `(code, slot)` scope.
 *
 * Slot migration is lazy: a scope whose v2 key has never been written falls
 * back to the pre-slot v1 payload for its code, so right after the upgrade
 * every slot still shows the drawings the user had. Each slot forks off that
 * seed on its first mutation (saveDrawings only ever writes v2).
 *
 * The seed is gated on key *existence*, not on the list being non-empty — a
 * slot the user emptied with "모두 지우기" writes `[]`, and must stay empty
 * instead of resurrecting the v1 snapshot on the next load.
 */
export function loadDrawings(scope: string): Drawing[] {
  const own = readKey(storageKey(scope));
  if (own != null) return own;
  return readKey(legacyStorageKey(parseScope(scope).code)) ?? [];
}

/**
 * Coerce an untrusted array of drawing-ish records into valid `Drawing`s:
 * drops unknown/unparseable kinds, resolves legacy `paneIndex`→`paneId`, and
 * defaults a missing `lineStyle`. Shared by localStorage load and JSON import.
 */
export function normalizeItems(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  return (raw as LegacyItem[])
    .filter((item) => item != null && KNOWN_KINDS.has((item as { kind?: string }).kind ?? ''))
    .map((item) => {
      const { paneIndex: _ignored, ...rest } = item;
      void _ignored;
      const lineStyle = (item as { lineStyle?: LineStyle }).lineStyle ?? 'solid';
      return { ...rest, paneId: resolvePaneId(item), lineStyle } as Drawing;
    });
}

export function saveDrawings(scope: string, items: Drawing[]): void {
  const wrapper: Wrapper = { v: VERSION, items };
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify(wrapper));
  } catch {
    // Quota exceeded or storage unavailable — ignore. Drawings remain in
    // memory; user simply loses them on reload.
  }
}

export const DEFAULTS_KEY = 'replay.drawingDefaults.v1';
const DEFAULTS_VERSION = 1;

type DefaultsWrapper = { v: number; value: DrawingDefaults };

export function loadDefaults(): DrawingDefaults {
  let raw: string | null;
  try {
    raw = localStorage.getItem(DEFAULTS_KEY);
  } catch {
    return INITIAL_DEFAULTS;
  }
  if (raw == null) return INITIAL_DEFAULTS;
  let parsed: DefaultsWrapper;
  try {
    parsed = JSON.parse(raw) as DefaultsWrapper;
  } catch {
    return INITIAL_DEFAULTS;
  }
  if (parsed == null || parsed.v !== DEFAULTS_VERSION) return INITIAL_DEFAULTS;
  return { ...INITIAL_DEFAULTS, ...parsed.value };
}

export function saveDefaults(d: DrawingDefaults): void {
  const wrapper: DefaultsWrapper = { v: DEFAULTS_VERSION, value: d };
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(wrapper));
  } catch {
    // Quota / storage unavailable — defaults stay in-memory; user simply
    // loses the cross-session sticky-ness on next reload.
  }
}
