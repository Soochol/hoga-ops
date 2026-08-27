import {
  CHART_TOGGLES,
  CHART_LINE_STYLES,
  CHART_NUMERIC_PREFS,
  DEFAULT_PREFS,
  INDICATOR_MODAL_PREF_KEYS,
  isIndicatorModalPrefKey,
  resolveIndicatorModalPrefs,
  type ChartLineWidth,
  type ChartViewPrefs,
  type IndicatorModalByTimeframe,
  type IndicatorModalPrefKey,
} from './chartPrefs';
import type { useChartPrefsStore } from './chartPrefs';
import { INDICATOR_PANE_PROFILE_KEYS } from '../live/indicators/indicatorPaneProfiles';
import { INDICATOR_WINDOW_SCOPE_LIMIT } from './indicatorSettingsV2';
import { attachPersistence } from './persistentSubscriber';

export const CHART_PREFS_KEY = 'hoga.chart.prefs.v1';
const WRITE_DEBOUNCE_MS = 250;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
/** `MAStylePicker` 가 제공하는 네 단계 — 모든 선 스타일이 공유한다. */
const CHART_LINE_WIDTHS = new Set([1, 2, 3, 4]);

function isChartLineWidth(v: unknown): v is ChartLineWidth {
  return typeof v === 'number' && CHART_LINE_WIDTHS.has(v);
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
  if (typeof obj.tradeHighlightColor === 'string' && HEX_COLOR_RE.test(obj.tradeHighlightColor)) {
    out.tradeHighlightColor = obj.tradeHighlightColor.toUpperCase();
  }
  // 선 스타일은 레지스트리에서 파생된다 — 엔트리를 추가해도 여기 코드는 그대로다.
  // 색의 `''` 는 "고르지 않음"(방향 토큰 추종)이라 **유효한 저장값**이다.
  for (const d of CHART_LINE_STYLES) {
    const rawColor = obj[`${d.key}Color`];
    if (typeof rawColor === 'string' && (rawColor === '' || HEX_COLOR_RE.test(rawColor))) {
      (out as Record<string, unknown>)[`${d.key}Color`] = rawColor.toUpperCase();
    }
    const rawWidth = obj[`${d.key}Width`];
    if (isChartLineWidth(rawWidth)) (out as Record<string, unknown>)[`${d.key}Width`] = rawWidth;
  }
  return out;
}

/**
 * 구 **방향 공용** 최대벽 키 → 계열 셋으로 펼치는 표(2026-08-25).
 *
 * 라벨·레전드 셀·화살표·MA 필터 둘(+기간)은 방향당 하나였다가 계열마다 갈렸다. 저장은
 * 기본값과의 sparse diff 라, 이 표가 없으면 **그 일곱을 손댔던 사용자만** 조용히 기본값으로
 * 돌아간다(안 건드린 사용자는 애초에 저장된 값이 없어 아무 일도 안 일어난다). 되돌아가는
 * 값이 「라벨 끔」·「MA 필터 끔」 같은 것이라 증상이 "왜 갑자기 라벨이 다시 뜨지" 로 온다.
 *
 * 펼친 값은 **세 계열 모두 같다** — 종전에 화면이 실제로 그렇게 동작했으므로 그것이
 * 외양 무변화다.
 *
 * 언제 지워도 되는가: 이 키들이 저장 블롭에서 사라진 뒤. 한 번이라도 저장이 일어나면
 * (`INDICATOR_MODAL_PREF_KEYS` 기준으로만 쓰므로) 구 키는 자연 소멸한다 — 즉 이 표는
 * "아직 한 번도 설정을 안 만진 채 이 버전을 처음 여는 사용자" 를 위한 것이고, 그 창이
 * 닫혔다고 판단되면 통째로 지우면 된다.
 */
const LEGACY_PEAK_WALL_FANOUT: Readonly<Record<string, readonly IndicatorModalPrefKey[]>> = {
  askPeakLabelEnabled: [
    'askPeakTradedLabelEnabled', 'askPeakUnreachedLabelEnabled', 'askPeakAllWallLabelEnabled',
  ],
  askPeakLegendCellEnabled: [
    'askPeakTradedLegendCellEnabled', 'askPeakUnreachedLegendCellEnabled', 'askPeakAllWallLegendCellEnabled',
  ],
  askPeakRankArrowEnabled: [
    'askPeakTradedRankArrowEnabled', 'askPeakUnreachedRankArrowEnabled', 'askPeakAllWallRankArrowEnabled',
  ],
  askPeakAboveMaEnabled: [
    'askPeakTradedAboveMaEnabled', 'askPeakUnreachedAboveMaEnabled', 'askPeakAllWallAboveMaEnabled',
  ],
  askPeakAboveMaPeriod: [
    'askPeakTradedAboveMaPeriod', 'askPeakUnreachedAboveMaPeriod', 'askPeakAllWallAboveMaPeriod',
  ],
  askPeakAboveDailyMaEnabled: [
    'askPeakTradedAboveDailyMaEnabled', 'askPeakUnreachedAboveDailyMaEnabled', 'askPeakAllWallAboveDailyMaEnabled',
  ],
  askPeakAboveDailyMaPeriod: [
    'askPeakTradedAboveDailyMaPeriod', 'askPeakUnreachedAboveDailyMaPeriod', 'askPeakAllWallAboveDailyMaPeriod',
  ],
  bidPeakLabelEnabled: [
    'bidPeakTradedLabelEnabled', 'bidPeakUnreachedLabelEnabled', 'bidPeakAllWallLabelEnabled',
  ],
  bidPeakLegendCellEnabled: [
    'bidPeakTradedLegendCellEnabled', 'bidPeakUnreachedLegendCellEnabled', 'bidPeakAllWallLegendCellEnabled',
  ],
  bidPeakRankArrowEnabled: [
    'bidPeakTradedRankArrowEnabled', 'bidPeakUnreachedRankArrowEnabled', 'bidPeakAllWallRankArrowEnabled',
  ],
  bidPeakBelowMaEnabled: [
    'bidPeakTradedBelowMaEnabled', 'bidPeakUnreachedBelowMaEnabled', 'bidPeakAllWallBelowMaEnabled',
  ],
  bidPeakBelowMaPeriod: [
    'bidPeakTradedBelowMaPeriod', 'bidPeakUnreachedBelowMaPeriod', 'bidPeakAllWallBelowMaPeriod',
  ],
  bidPeakBelowDailyMaEnabled: [
    'bidPeakTradedBelowDailyMaEnabled', 'bidPeakUnreachedBelowDailyMaEnabled', 'bidPeakAllWallBelowDailyMaEnabled',
  ],
  bidPeakBelowDailyMaPeriod: [
    'bidPeakTradedBelowDailyMaPeriod', 'bidPeakUnreachedBelowDailyMaPeriod', 'bidPeakAllWallBelowDailyMaPeriod',
  ],
};

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
  // 구 방향 공용 키를 계열 셋으로 펼친다. 새 키가 이미 저장돼 있으면 **그쪽이 이긴다** —
  // 위 루프가 넣은 값을 덮으면 새 설정이 구 값으로 되돌아간다.
  for (const [legacyKey, targets] of Object.entries(LEGACY_PEAK_WALL_FANOUT)) {
    if (!(legacyKey in partial)) continue;
    for (const key of targets) {
      if (key in partial) continue;
      const v = validatePrefValue(key, partial[legacyKey]);
      if (v !== undefined && v !== DEFAULT_PREFS[key]) out[key] = v;
    }
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

/**
 * `/study` 의 indicator-modal 버킷 로드 — **키가 없을 때만** `/live` 에서 시드한다
 * (ADR-0146). `livePage` 의 `studyByTimeframe` 과 같은 규약이다:
 * 게으른 폴백이면 `/study` 가 첫 편집 전까지 `/live` 를 계속 따라다닌다.
 */
export function mergeStudyIndicatorModal(
  raw: unknown,
  live: IndicatorModalByTimeframe,
): IndicatorModalByTimeframe {
  const stored = raw && typeof raw === 'object'
    ? (raw as Record<string, unknown>).studyIndicatorModalByTimeframe
    : undefined;
  if (stored === undefined) {
    // 깊은 사본 — 버킷 객체를 공유하면 한쪽 편집이 다른 쪽으로 샌다.
    const seeded: IndicatorModalByTimeframe = {};
    for (const profileKey of INDICATOR_PANE_PROFILE_KEYS) {
      const bucket = live[profileKey];
      if (bucket) seeded[profileKey] = { ...bucket };
    }
    return seeded;
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const out: IndicatorModalByTimeframe = {};
  for (const profileKey of INDICATOR_PANE_PROFILE_KEYS) {
    const bucket = sanitizeIndicatorModalBucket((stored as Record<string, unknown>)[profileKey]);
    if (Object.keys(bucket).length > 0) out[profileKey] = bucket;
  }
  return out;
}

/** indicator-modal 버킷 맵 하나를 정규화한다 — 저장소 로드와 **프리셋 payload
 *  적용**이 공유한다(ADR-0159). `livePage` 쪽 `normalizeBucketMap` 의 대응물이고,
 *  같은 규약이다: 맵 안의 빈 버킷은 걷지만 결과가 `{}` 인 것은 정상이다(멤버십은
 *  엔트리의 존재가 정하므로 호출자가 관리한다). */
export function sanitizeIndicatorModalBucketMap(raw: unknown): IndicatorModalByTimeframe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: IndicatorModalByTimeframe = {};
  for (const profileKey of INDICATOR_PANE_PROFILE_KEYS) {
    const bucket = sanitizeIndicatorModalBucket((raw as Record<string, unknown>)[profileKey]);
    if (Object.keys(bucket).length > 0) out[profileKey] = bucket;
  }
  return out;
}

/**
 * 창별 indicator-modal 버킷 로드 — **빈 엔트리를 보존한다**(`livePage` 의
 * `byWindow` 와 같은 멤버십 규약: 엔트리의 존재가 곧 "이 창은 자기 세트를 갖는다").
 */
export function mergeIndicatorModalByWindow(
  raw: unknown,
): Record<string, IndicatorModalByTimeframe> {
  const stored = raw && typeof raw === 'object'
    ? (raw as Record<string, unknown>).indicatorModalByWindow
    : undefined;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const out: Record<string, IndicatorModalByTimeframe> = {};
  for (const [scopeKey, value] of Object.entries(stored as Record<string, unknown>)) {
    if (Object.keys(out).length >= INDICATOR_WINDOW_SCOPE_LIMIT) break;
    if (!scopeKey) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    out[scopeKey] = sanitizeIndicatorModalBucketMap(value);
  }
  return out;
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
      studyIndicatorModalByTimeframe: mergeStudyIndicatorModal(parsed, indicatorModalByTimeframe),
      indicatorModalByWindow: mergeIndicatorModalByWindow(parsed),
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
/**
 * 다른 탭의 차트 prefs 변경을 받아 이 탭 스토어를 맞춘다(`crossTabSync` 가 유일
 * 호출자). 「지표」 모달의 호가 동작설정(호가비 극단값 필터·체결강도 누적 …)이
 * 여기 살고(ADR-0072), 사용자 눈에는 지표 설정과 같은 표면이므로 함께 따라와야
 * 한다 — 한쪽만 동기화되면 같은 드로어 안에서 어떤 행은 따라오고 어떤 행은 안
 * 따라오는 상태가 된다.
 *
 * 되쓰기(에코)는 `attachPersistence` 의 "같은 값이면 안 쓴다" 가드가 끊는다.
 */
export function subscribeToChartPrefsStorage(store: typeof useChartPrefsStore): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== CHART_PREFS_KEY) return;
    hydrateChartPrefs(store);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

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
      studyIndicatorModalByTimeframe: s.studyIndicatorModalByTimeframe,
      indicatorModalByWindow: s.indicatorModalByWindow,
    }) as unknown as ChartViewPrefs,
  });
}
