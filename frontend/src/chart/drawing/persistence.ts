// frontend/src/chart/drawing/persistence.ts
import type { Drawing, LineStyle, PaneId } from './types';
import { PANE_SPECS } from '../paneSpecs';

const PREFIX = 'replay.drawings.v1.';
const VERSION = 1;

export function storageKey(code: string): string {
  return `${PREFIX}${code}`;
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

export function loadDrawings(code: string): Drawing[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(code));
  } catch {
    return [];
  }
  if (raw == null) return [];
  let parsed: Wrapper;
  try {
    parsed = JSON.parse(raw) as Wrapper;
  } catch {
    return [];
  }
  if (parsed == null || parsed.v !== VERSION) return [];
  if (!Array.isArray(parsed.items)) return [];
  return (parsed.items as LegacyItem[]).map((item) => {
    const { paneIndex: _ignored, ...rest } = item;
    void _ignored;
    const lineStyle = (item as { lineStyle?: LineStyle }).lineStyle ?? 'solid';
    return { ...rest, paneId: resolvePaneId(item), lineStyle } as Drawing;
  });
}

export function saveDrawings(code: string, items: Drawing[]): void {
  const wrapper: Wrapper = { v: VERSION, items };
  try {
    localStorage.setItem(storageKey(code), JSON.stringify(wrapper));
  } catch {
    // Quota exceeded or storage unavailable — ignore. Drawings remain in
    // memory; user simply loses them on reload.
  }
}
