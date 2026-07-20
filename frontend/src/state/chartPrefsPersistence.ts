import {
  CHART_TOGGLES,
  CHART_NUMERIC_PREFS,
  DEFAULT_PREFS,
  INDICATOR_MODAL_PREF_KEYS,
  isIndicatorModalPrefKey,
  resolveIndicatorModalPrefs,
  type ChartViewPrefs,
  type DayBoundaryLineWidth,
  type IndicatorModalByTimeframe,
  type IndicatorModalPrefKey,
} from './chartPrefs';
import type { useChartPrefsStore } from './chartPrefs';
import { INDICATOR_PANE_PROFILE_KEYS } from '../live/indicators/indicatorPaneProfiles';
import { attachPersistence } from './persistentSubscriber';

export const CHART_PREFS_KEY = 'hoga.chart.prefs.v1';
const WRITE_DEBOUNCE_MS = 250;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DAY_BOUNDARY_WIDTHS = new Set([1, 2, 3, 4]);

function isDayBoundaryLineWidth(v: unknown): v is DayBoundaryLineWidth {
  return typeof v === 'number' && DAY_BOUNDARY_WIDTHS.has(v);
}

/** 레지스트리 규칙으로 한 키의 값을 검증한다 — 무효면 undefined. */
function validatePrefValue(key: string, v: unknown): boolean | number | undefined {
  const toggle = CHART_TOGGLES.find((t) => t.key === key);
  if (toggle) return typeof v === 'boolean' ? v : undefined;
  const numeric = CHART_NUMERIC_PREFS.find((p) => p.key === key);
  if (numeric) {
    return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
      && v >= numeric.min && v <= numeric.max
      ? v
      : undefined;
  }
  return undefined;
}

/**
 * flat(전역) prefs 병합 — 차트 전반 키만 저장값을 읽고, **indicator-modal 키는
 * flat 에서 더 이상 읽지 않는다**(#699 PR-B: per-timeframe 버킷이 원본, flat 은
 * 기본값으로 시작해 hydrate 시 버킷 투영으로 덮인다).
 */
export function mergePrefs(raw: unknown): ChartViewPrefs {
  const out: ChartViewPrefs = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const t of CHART_TOGGLES) {
    if (isIndicatorModalPrefKey(t.key)) continue;
    const v = obj[t.key];
    if (typeof v === 'boolean') (out as Record<string, unknown>)[t.key] = v;
  }
  for (const p of CHART_NUMERIC_PREFS) {
    if (isIndicatorModalPrefKey(p.key)) continue;
    const v = validatePrefValue(p.key, obj[p.key]);
    if (v !== undefined) (out as Record<string, unknown>)[p.key] = v;
  }
  if (typeof obj.dayBoundaryColor === 'string' && HEX_COLOR_RE.test(obj.dayBoundaryColor)) {
    out.dayBoundaryColor = obj.dayBoundaryColor.toUpperCase();
  }
  if (isDayBoundaryLineWidth(obj.dayBoundaryLineWidth)) {
    out.dayBoundaryLineWidth = obj.dayBoundaryLineWidth;
  }
  if (typeof obj.tradeHighlightColor === 'string' && HEX_COLOR_RE.test(obj.tradeHighlightColor)) {
    out.tradeHighlightColor = obj.tradeHighlightColor.toUpperCase();
  }
  return out;
}

/** 한 버킷 partial 을 검증하고 기본값과 diff 한다(sparse 정의 — v2 모델과 동일). */
function sanitizeIndicatorModalBucket(raw: unknown): Partial<Record<IndicatorModalPrefKey, boolean | number>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const partial = raw as Record<string, unknown>;
  const out: Partial<Record<IndicatorModalPrefKey, boolean | number>> = {};
  for (const key of INDICATOR_MODAL_PREF_KEYS) {
    if (!(key in partial)) continue;
    const v = validatePrefValue(key, partial[key]);
    if (v !== undefined && v !== DEFAULT_PREFS[key]) out[key] = v;
  }
  return out;
}

/**
 * indicator-modal 버킷 로드. 블롭에 `indicatorModalByTimeframe` 가 있으면 정규화,
 * 없으면(구 형식) **flat indicator-modal 값을 minute 버킷에 diff 시드**한다
 * (#697 결정 변경 — 분봉 외양 무변화, D/W/M 은 기본값 시작).
 */
export function mergeIndicatorModalByTimeframe(raw: unknown): IndicatorModalByTimeframe {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const stored = obj.indicatorModalByTimeframe;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const byTimeframe: IndicatorModalByTimeframe = {};
    for (const profileKey of INDICATOR_PANE_PROFILE_KEYS) {
      const bucket = sanitizeIndicatorModalBucket((stored as Record<string, unknown>)[profileKey]);
      if (Object.keys(bucket).length > 0) byTimeframe[profileKey] = bucket;
    }
    return byTimeframe;
  }
  // 구 형식 시드: flat 값 자체가 하나의 partial 이다.
  const seeded = sanitizeIndicatorModalBucket(obj);
  return Object.keys(seeded).length > 0 ? { minute: seeded } : {};
}

export function hydrateChartPrefs(store: typeof useChartPrefsStore): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(CHART_PREFS_KEY);
    if (raw === null) return;
    const parsed = JSON.parse(raw);
    const prefs = mergePrefs(parsed);
    const indicatorModalByTimeframe = mergeIndicatorModalByTimeframe(parsed);
    const tf = store.getState().indicatorModalTimeframe;
    store.setState({
      ...prefs,
      indicatorModalByTimeframe,
      ...resolveIndicatorModalPrefs(indicatorModalByTimeframe, tf),
    });
  } catch {
    // localStorage unavailable / parse failure — fall back to DEFAULT_PREFS
  }
}

/**
 * Subscribe `useChartPrefsStore` to localStorage under `hoga.chart.prefs.v1`.
 *
 * Adapter shape: `attachPersistence` in `persistentSubscriber.ts` takes
 * `{ storageKey, toSnapshot, debounceMs }` and calls `JSON.stringify` on
 * the snapshot itself, so `toSnapshot` returns the plain prefs object
 * (action functions stripped) rather than a pre-serialized string.
 *
 * indicator-modal 키의 flat 값은 스냅샷에서 제외한다 — 원본은
 * `indicatorModalByTimeframe`(4버킷 sparse)이고 최상위는 투영일 뿐이다.
 */
export function attachChartPrefsPersistence(store: typeof useChartPrefsStore): () => void {
  return attachPersistence(store, {
    storageKey: CHART_PREFS_KEY,
    debounceMs: WRITE_DEBOUNCE_MS,
    toSnapshot: (s) => ({
      ...Object.fromEntries(
        Object.keys(DEFAULT_PREFS)
          .filter((k) => !isIndicatorModalPrefKey(k))
          .map((k) => [k, s[k as keyof ChartViewPrefs]]),
      ),
      indicatorModalByTimeframe: s.indicatorModalByTimeframe,
    }) as unknown as ChartViewPrefs,
  });
}
