import { normalizePaneStretch, type PaneStretchMap } from '../chart/paneOrder';
import {
  normalizePaneGroupStretch,
  type PaneGroups,
  type PaneGroupStretchMap,
} from '../chart/paneGroups';
import {
  INDICATOR_PANE_PROFILE_KEYS,
  profileKeyForTimeframe,
  type IndicatorPaneProfileKey,
} from '../live/indicators/indicatorPaneProfiles';
import type { LiveTimeframe } from './livePage';

export type PaneStretchByTimeframe =
  Partial<Record<IndicatorPaneProfileKey, PaneStretchMap>>;
export type PaneGroupStretchByTimeframe =
  Partial<Record<IndicatorPaneProfileKey, PaneGroupStretchMap>>;

function objectBucket(raw: unknown, key: IndicatorPaneProfileKey): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return (raw as Record<string, unknown>)[key];
}

/**
 * 봉별 pane 높이 저장값을 정규화한다. 새 필드가 없는 구 블롭은 기존 전역 값을
 * 네 프로필에 복제해 첫 로드의 시각적 레이아웃을 그대로 보존한다. 부분 저장값은
 * 없는 프로필만 레거시 값으로 채운다(혼합 버전/점진 마이그레이션 안전).
 */
export function normalizePaneStretchByTimeframe(
  raw: unknown,
  legacy: unknown,
): PaneStretchByTimeframe {
  const fallback = normalizePaneStretch(legacy);
  const out: PaneStretchByTimeframe = {};
  for (const key of INDICATOR_PANE_PROFILE_KEYS) {
    const bucket = objectBucket(raw, key);
    out[key] = bucket === undefined ? { ...fallback } : normalizePaneStretch(bucket);
  }
  return out;
}

export function normalizePaneGroupStretchByTimeframe(
  raw: unknown,
  legacy: unknown,
  groups: PaneGroups,
): PaneGroupStretchByTimeframe {
  const fallback = normalizePaneGroupStretch(legacy, groups);
  const out: PaneGroupStretchByTimeframe = {};
  for (const key of INDICATOR_PANE_PROFILE_KEYS) {
    const bucket = objectBucket(raw, key);
    out[key] = bucket === undefined
      ? { ...fallback }
      : normalizePaneGroupStretch(bucket, groups);
  }
  return out;
}

export function paneStretchForTimeframe(
  byTimeframe: PaneStretchByTimeframe,
  timeframe: LiveTimeframe,
): PaneStretchMap {
  return byTimeframe[profileKeyForTimeframe(timeframe)] ?? {};
}

export function paneGroupStretchForTimeframe(
  byTimeframe: PaneGroupStretchByTimeframe,
  timeframe: LiveTimeframe,
): PaneGroupStretchMap {
  return byTimeframe[profileKeyForTimeframe(timeframe)] ?? {};
}
