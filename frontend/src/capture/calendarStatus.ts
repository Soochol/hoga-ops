// Single source of truth for the visual presentation of a CalendarStatus.
// Mirrors the PhaseDescriptor pattern in phase.ts. Adding a new
// CalendarStatus requires exactly one row here — TypeScript's
// Record<CalendarStatus, _> exhaustiveness flags any miss.
import type { CalendarStatus } from '../api/types';

export interface CalendarStatusDescriptor {
  /** Glyph rendered in the corner of the cell; null = no glyph. */
  marker: '✓' | '⚠' | '✕' | '🔒' | '–' | null;
  /** Per-status badge color for the marker. Optional — today_locked relies
   *  on the 🔒 glyph itself and intentionally has no separate color. */
  badgeColor?: string;
  /** Cell text color (the day-of-month digit). Always a CSS var. */
  baseColorVar: string;
  /** Hover/click disabled. Replaces the historical DISABLED_STATUSES set. */
  disabled: boolean;
  /** Suffix appended after "${date} · " in tooltip text.
   *  null → tooltip is just "${date}" (no separator, matches the historical
   *  default for the `none` status). */
  tooltipSuffix: string | null;
  /** Legend chunk like "✓ complete". null → not surfaced in the Legend at all
   *  (weekend/holiday/future/none). */
  legendLabel: string | null;
}

export const CALENDAR_STATUS: Record<CalendarStatus, CalendarStatusDescriptor> = {
  complete: {
    marker: '✓',
    badgeColor: 'var(--success)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: 'captured (complete)',
    legendLabel: '✓ complete',
  },
  source_partial: {
    marker: '⚠',
    badgeColor: 'var(--warn)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: 'captured (source partial — data gaps)',
    legendLabel: '⚠ partial',
  },
  client_incomplete: {
    marker: '✕',
    badgeColor: 'var(--error)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: 'partial pages on disk (resume on capture)',
    legendLabel: '✕ broken',
  },
  invalid: {
    // ADR-0020 — DiskState.INVALID reaches the wire when a Stock-Date has an
    // error-severity invariant violation. Reuses the '✕' glyph (the data
    // shape is broken, semantically adjacent to client_incomplete) but the
    // tooltip distinguishes the cause from "collection interrupted".
    marker: '✕',
    badgeColor: 'var(--error)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: 'invalid data shape (re-capture)',
    legendLabel: null,
  },
  no_upstream_data: {
    // ADR-0021 — hogaplay info.php returned 200 + empty body. The cell stays
    // clickable so force_retry can re-attempt; the dim baseColor + en-dash
    // marker signal absence (distinct from '✕' broken which means "data
    // exists but collection was interrupted").
    marker: '–',
    badgeColor: 'var(--fg-dimmer)',
    baseColorVar: 'var(--fg-dim)',
    disabled: false,
    tooltipSuffix: 'no upstream data (force to retry)',
    legendLabel: '– no upstream data',
  },
  today_locked: {
    marker: '🔒',
    baseColorVar: 'var(--fg-dim)',
    disabled: true,
    tooltipSuffix: 'today < 18:00 KST (locked)',
    legendLabel: '🔒 today < 18:00 KST',
  },
  weekend: {
    marker: null,
    baseColorVar: 'var(--fg-dimmer)',
    disabled: true,
    tooltipSuffix: 'weekend',
    legendLabel: null,
  },
  holiday: {
    marker: null,
    baseColorVar: 'var(--fg-dimmer)',
    disabled: true,
    tooltipSuffix: 'KRX holiday',
    legendLabel: null,
  },
  future: {
    marker: null,
    baseColorVar: 'var(--fg-dimmer)',
    disabled: true,
    tooltipSuffix: 'future date',
    legendLabel: null,
  },
  none: {
    marker: null,
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: null,
    legendLabel: null,
  },
};

/** Order in which Legend chunks appear in the Capture form footer.
 *  Statuses with `legendLabel: null` are skipped. */
export const LEGEND_ORDER: readonly CalendarStatus[] = [
  'complete',
  'source_partial',
  'client_incomplete',
  'no_upstream_data',
  'today_locked',
];

/** Derived helpers — exposed so existing call sites can swap inline branches
 *  for a single lookup without changing observable behavior. */

export function markerFor(status: CalendarStatus): CalendarStatusDescriptor['marker'] {
  return CALENDAR_STATUS[status].marker;
}

export function badgeColorFor(status: CalendarStatus): string | undefined {
  return CALENDAR_STATUS[status].badgeColor;
}

export function baseColorVarFor(status: CalendarStatus): string {
  return CALENDAR_STATUS[status].baseColorVar;
}

export function isDisabled(status: CalendarStatus): boolean {
  return CALENDAR_STATUS[status].disabled;
}

export function tooltipFor(status: CalendarStatus, date: string): string {
  const suffix = CALENDAR_STATUS[status].tooltipSuffix;
  return suffix === null ? date : `${date} · ${suffix}`;
}

export function legendText(): string {
  const parts = LEGEND_ORDER
    .map((s) => CALENDAR_STATUS[s].legendLabel)
    .filter((label): label is string => label !== null);
  return `Legend: ${parts.join(' · ')}`;
}
