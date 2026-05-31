import type { MASource } from '../chart/projectors/movingAverage';

/**
 * /live indicator prefs — canonical types, constants, and the persistence
 * validator co-live here.
 *
 * Module placement note: `LiveMAConfig`, `MA_PERIOD_MIN/MAX/SLOT_LIMIT`, and
 * `DEFAULT_LIVE_MAS` are *defined* in this leaf module (not in
 * `state/livePage`) to break a runtime import cycle —
 * `livePage` imports `mergeLiveIndicatorPrefs` here, and the validator
 * needs the constants. `state/livePage` re-exports them, so all public
 * consumers continue to import from `state/livePage` (the spec and plan
 * both name livePage as the public surface). If you find yourself
 * importing constants from this module directly, prefer `state/livePage`
 * — that's the documented public seam.
 */

/** /live의 이동평균선 한 슬롯. 가변 슬롯이므로 array index가 아니라
 *  안정 id로 식별한다 — mid-list 삭제가 다른 슬롯의 series identity를
 *  churn하지 않게 한다. ADR-0046 참조. */
export type LiveMAConfig = {
  id: string;
  enabled: boolean;
  period: number;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  source: MASource;
};

export const MA_PERIOD_MIN = 2;
export const MA_PERIOD_MAX = 400;
export const MA_SLOT_LIMIT = 8;

/** 색상 hex는 tokens.css의 --ma-N과 정확히 일치 (canvas는 CSS var를
 *  직접 받지 못함). --ma-2 (#3B82F6, blue)는 KRX --price-down (#2563EB,
 *  blue)과 색역이 가까워 기본 슬롯에서 의도적으로 스킵. spec §1 참조. */
export const DEFAULT_LIVE_MAS: readonly LiveMAConfig[] = Object.freeze([
  { id: 'ma-1', enabled: true, period: 5,   color: '#EC4899', lineWidth: 1, source: 'close' },
  { id: 'ma-2', enabled: true, period: 20,  color: '#F97316', lineWidth: 1, source: 'close' },
  { id: 'ma-3', enabled: true, period: 60,  color: '#22C55E', lineWidth: 1, source: 'close' },
  { id: 'ma-4', enabled: true, period: 120, color: '#F8FAFC', lineWidth: 1, source: 'close' },
]) as readonly LiveMAConfig[];

const VALID_LINE_WIDTHS = new Set([1, 2, 3, 4]);
const VALID_SOURCES = new Set(['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4']);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export type PersistedIndicators = {
  movingAverages: LiveMAConfig[];
  movingAverageEnabled: boolean;
  /** ADR-0055: foreign-investor net-buy bar pane. Opt-in (default false). */
  foreignNetEnabled: boolean;
  /** ADR-0055: institution net-buy bar pane. Opt-in (default false). */
  institutionNetEnabled: boolean;
  /** Pane Legend: volume pane on/off. Default TRUE (kept for legacy stores). */
  volumeEnabled: boolean;
  /** Pane Legend: MA lines temporarily hidden (눈), config preserved. Default FALSE. */
  movingAverageHidden: boolean;
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
 *  growth from a corrupted store. `movingAverageEnabled` defaults to
 *  true unless the persisted value is the literal boolean false (any
 *  other shape — missing, null, "true" string — falls back to true so
 *  legacy stores written before this field existed keep showing MAs). */
export function mergeLiveIndicatorPrefs(
  raw: PersistedIndicators | undefined | null | unknown,
): PersistedIndicators {
  const defaults = DEFAULT_LIVE_MAS.map((m) => ({ ...m }));
  const build = (
    mas: LiveMAConfig[], enabled: boolean, fNet: boolean, iNet: boolean,
    vol: boolean, hidden: boolean,
  ): PersistedIndicators => ({
    movingAverages: mas,
    movingAverageEnabled: enabled,
    foreignNetEnabled: fNet,
    institutionNetEnabled: iNet,
    volumeEnabled: vol,
    movingAverageHidden: hidden,
  });
  if (!raw || typeof raw !== 'object') return build(defaults, true, false, false, true, false);
  const obj = raw as Record<string, unknown>;
  const enabled = obj.movingAverageEnabled === false ? false : true;
  // New indicators are opt-in: default false unless explicitly persisted true,
  // so legacy stores (written before these fields existed) stay hidden.
  const fNet = obj.foreignNetEnabled === true;
  const iNet = obj.institutionNetEnabled === true;
  // volumeEnabled defaults TRUE (mirror movingAverageEnabled); movingAverageHidden
  // defaults FALSE (mirror foreignNetEnabled).
  const vol = obj.volumeEnabled === false ? false : true;
  const hidden = obj.movingAverageHidden === true;
  const arr = obj.movingAverages;
  if (!Array.isArray(arr)) return build(defaults, enabled, fNet, iNet, vol, hidden);
  const kept = arr.filter(isValidEntry).slice(0, MA_SLOT_LIMIT) as LiveMAConfig[];
  if (kept.length === 0) return build(defaults, enabled, fNet, iNet, vol, hidden);
  return build(kept, enabled, fNet, iNet, vol, hidden);
}
