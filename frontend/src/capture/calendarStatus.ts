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
    tooltipSuffix: '수집 완료',
    legendLabel: '✓ 완료',
  },
  source_partial: {
    marker: '⚠',
    badgeColor: 'var(--warn)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: '수집됨 (원본 부분 — 데이터 구멍)',
    legendLabel: '⚠ 부분',
  },
  client_incomplete: {
    marker: '✕',
    badgeColor: 'var(--error)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: '디스크에 부분 페이지 (캡처 시 이어받기)',
    legendLabel: '✕ 손상',
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
    tooltipSuffix: '데이터 형식 오류 (재캡처 필요)',
    legendLabel: null,
  },
  no_upstream_data: {
    // ADR-0021 — hogaplay info.php returned 200 + empty body. The cell stays
    // clickable so the next capture can re-attempt; the dim baseColor + en-dash
    // marker signal absence (distinct from '✕' broken which means "data
    // exists but collection was interrupted").
    marker: '–',
    badgeColor: 'var(--fg-dimmer)',
    baseColorVar: 'var(--fg-dim)',
    disabled: false,
    tooltipSuffix: '업스트림 데이터 없음 (캡처 시 재시도)',
    legendLabel: '– 업스트림 없음',
  },
  complete_live: {
    // KIS live/REST-only promotion, no hogaplay artifact. Reuses the ✓ glyph but
    // uses the kis_live source-identity token (DESIGN.md --source-kis-live-border)
    // instead of --success green, so it's visually distinct from a hogaplay
    // capture. Cell stays clickable — this date is still a hogaplay target.
    marker: '✓',
    badgeColor: 'var(--source-kis-live-border)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: 'KIS 실시간 데이터 (hogaplay 미수집)',
    legendLabel: '✓ KIS 실시간',
  },
  partial_live: {
    // KIS live/REST-only promotion with session gaps. ⚠ glyph in the kis_live
    // source-identity token.
    marker: '⚠',
    badgeColor: 'var(--source-kis-live-border)',
    baseColorVar: 'var(--fg)',
    disabled: false,
    tooltipSuffix: 'KIS 실시간 데이터, 부분 (hogaplay 미수집)',
    legendLabel: '⚠ KIS 실시간 부분',
  },
  today_locked: {
    marker: '🔒',
    baseColorVar: 'var(--fg-dim)',
    disabled: true,
    tooltipSuffix: '당일 16:30 이전 (잠김)',
    legendLabel: '🔒 당일 16:30 이전',
  },
  weekend: {
    marker: null,
    baseColorVar: 'var(--fg-dimmer)',
    disabled: true,
    tooltipSuffix: '주말',
    legendLabel: null,
  },
  holiday: {
    marker: null,
    baseColorVar: 'var(--fg-dimmer)',
    disabled: true,
    tooltipSuffix: 'KRX 휴장일',
    legendLabel: null,
  },
  future: {
    marker: null,
    baseColorVar: 'var(--fg-dimmer)',
    disabled: true,
    tooltipSuffix: '미래 날짜',
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
  'complete_live',
  'partial_live',
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
  return `범례: ${parts.join(' · ')}`;
}
