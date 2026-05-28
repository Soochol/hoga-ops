import {
  DEFAULT_LIVE_MAS,
  MA_PERIOD_MIN,
  MA_PERIOD_MAX,
  MA_SLOT_LIMIT,
  type LiveMAConfig,
} from './livePage';

const VALID_LINE_WIDTHS = new Set([1, 2, 3, 4]);
const VALID_SOURCES = new Set(['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4']);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export type PersistedIndicators = {
  movingAverages: LiveMAConfig[];
};

function isValidEntry(m: unknown): m is LiveMAConfig {
  if (!m || typeof m !== 'object') return false;
  const e = m as Record<string, unknown>;
  return (
    typeof e.id === 'string' && e.id.length > 0
    && typeof e.enabled === 'boolean'
    && typeof e.period === 'number'
    && Number.isFinite(e.period)
    && Number.isInteger(e.period)
    && e.period >= MA_PERIOD_MIN
    && e.period <= MA_PERIOD_MAX
    && typeof e.color === 'string' && HEX_COLOR.test(e.color)
    && typeof e.lineWidth === 'number' && VALID_LINE_WIDTHS.has(e.lineWidth)
    && typeof e.source === 'string' && VALID_SOURCES.has(e.source)
  );
}

/** Merge persisted state with defaults. If the input is structurally
 *  unrecoverable (missing/non-object/non-array MAs) return defaults.
 *  If a subset of entries is valid, keep those; if none are valid,
 *  fall back to defaults. Cap to MA_SLOT_LIMIT to prevent unbounded
 *  growth from a corrupted store. */
export function mergeLiveIndicatorPrefs(
  raw: PersistedIndicators | undefined | null | unknown,
): PersistedIndicators {
  const defaults = DEFAULT_LIVE_MAS.map((m) => ({ ...m }));
  if (!raw || typeof raw !== 'object') return { movingAverages: defaults };
  const arr = (raw as Record<string, unknown>).movingAverages;
  if (!Array.isArray(arr)) return { movingAverages: defaults };
  const kept = arr.filter(isValidEntry).slice(0, MA_SLOT_LIMIT) as LiveMAConfig[];
  if (kept.length === 0) return { movingAverages: defaults };
  return { movingAverages: kept };
}
