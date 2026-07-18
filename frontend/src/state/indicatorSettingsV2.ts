import type { PaneId } from '../chart/drawing/types';
import { normalizePaneOrder } from '../chart/paneOrder';
import {
  mergeLiveIndicatorPrefs,
  type PersistedIndicators,
} from './liveIndicatorsPersistence';
import {
  INDICATOR_PANE_PREF_KEYS,
  INDICATOR_PANE_PROFILE_KEYS,
  normalizePanePrefsByTimeframe,
  profileKeyForTimeframe,
  type IndicatorPaneProfileKey,
} from '../live/indicators/indicatorPaneProfiles';
import type { LiveTimeframe } from './livePage';

/**
 * per-timeframe 지표 설정 v2 (지도 #694 / 최종 스펙 #699).
 *
 * 저장 모델: `live.indicators.v2` = { paneOrder(전역) + byTimeframe(분/D/W/M
 * 4버킷 sparse 오버라이드) }. 읽기 = 공장 기본값 ⊕ 현재 봉 버킷. flat 상속과
 * `panePrefsByTimeframe` 병합(구 모델)은 폐지 — 기존 pane 토글 7종도 버킷 안으로
 * 흡수된다(#696). sparse 의 정의는 "공장값과의 diff"다: 공장값과 같은 항목은
 * 로드 시 제거되므로, 향후 공장값 개선이 안 만진 필드에 자동 반영된다(#697).
 */

/** 버킷 하나가 담는 지표 설정 전체 — v1 `PersistedIndicators` 에서 per-timeframe
 *  컨테이너(panePrefsByTimeframe)와 레이아웃(paneOrder)만 뺀 것. */
export type IndicatorSettings = Omit<PersistedIndicators, 'panePrefsByTimeframe' | 'paneOrder'>;

export type IndicatorSettingsByTimeframe =
  Partial<Record<IndicatorPaneProfileKey, Partial<IndicatorSettings>>>;

export type PersistedIndicatorsV2 = {
  paneOrder: PaneId[];
  byTimeframe: IndicatorSettingsByTimeframe;
};

export const INDICATORS_V2_STORAGE_KEY = 'live.indicators.v2';
const V1_STORAGE_KEY = 'live.indicators.v1';

function stripContainers(v1: PersistedIndicators): IndicatorSettings {
  const { panePrefsByTimeframe: _p, paneOrder: _o, ...settings } = v1;
  return settings;
}

/** 공장 기본값 (#697 보충 정정): 거래량 + 이동평균선(기본 슬롯)만 on, 그 외 지표
 *  마스터 토글은 전부 off. 하위 파라미터·색 기본값은 v1 기본값 그대로 유지 —
 *  지표를 켜는 순간 기존 기본 구성이 나온다. */
export const FACTORY_INDICATOR_SETTINGS: IndicatorSettings = Object.freeze({
  ...stripContainers(mergeLiveIndicatorPrefs(undefined)),
  // 구 기본값 TRUE에서 off로 바뀌는 마스터 토글들.
  quoteTotalsEnabled: false,
  ratioEnabled: false,
  fillStrengthEnabled: false,
  programTradeEnabled: false,
  tradeVolumePocEnabled: false,
  volumeDistributionEnabled: false,
});

export const INDICATOR_SETTING_KEYS = Object.freeze(
  Object.keys(FACTORY_INDICATOR_SETTINGS),
) as readonly (keyof IndicatorSettings)[];

/** JSON 직렬화 동등성(키 순서 민감) — 이 모듈의 값은 전부 JSON 왕복 가능하고
 *  같은 코드 경로가 만든 객체라 키 순서가 안정적이므로 충분하다. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** 공장값과 다른 필드만 남긴다 — sparse 버킷의 정의. */
export function diffIndicatorSettingsFromFactory(
  settings: IndicatorSettings,
): Partial<IndicatorSettings> {
  const diff: Partial<IndicatorSettings> = {};
  for (const key of INDICATOR_SETTING_KEYS) {
    if (!jsonEqual(settings[key], FACTORY_INDICATOR_SETTINGS[key])) {
      (diff as Record<string, unknown>)[key] = settings[key];
    }
  }
  return diff;
}

/** 임의의 partial 을 필드 단위로 검증한다. 검증기는 v1 코어서를 재사용 — 공장값
 *  위에 partial 을 얹어 full-shape 을 만들고 코어서에 통과시킨 뒤, partial 이
 *  건드린 키만 뽑아 공장값과 diff 한다(무효값은 코어서가 공장값으로 되돌리므로
 *  diff 에서 자연 탈락). */
function sanitizeSettingsPatch(raw: unknown): Partial<IndicatorSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const partial = raw as Record<string, unknown>;
  // 1단계 — 런타임 타입이 공장값과 다른 엔트리를 먼저 버린다. 코어서의 boolean
  // 폴백은 v1 기본값(예: quoteTotalsEnabled → true)이라 새 공장값(false)과 다를
  // 수 있어, 타입 불일치 쓰레기가 영구 오버라이드로 승격되는 것을 여기서 막는다.
  const typed: Record<string, unknown> = {};
  for (const key of INDICATOR_SETTING_KEYS) {
    if (!(key in partial)) continue;
    const factoryValue = FACTORY_INDICATOR_SETTINGS[key];
    const value = partial[key];
    const typeMatches = Array.isArray(factoryValue)
      ? Array.isArray(value)
      : typeof value === typeof factoryValue;
    if (typeMatches) typed[key] = value;
  }
  // 2단계 — 도메인 검증(hex·범위·enum)은 v1 코어서 재사용: 공장값 위에 얹어
  // full-shape 을 만들고 통과시킨 뒤, 건드린 키만 뽑아 공장값과 diff 한다.
  const candidate = {
    ...FACTORY_INDICATOR_SETTINGS,
    ...typed,
    panePrefsByTimeframe: {},
    paneOrder: [],
  };
  const validated = stripContainers(mergeLiveIndicatorPrefs(candidate));
  const touched: IndicatorSettings = { ...FACTORY_INDICATOR_SETTINGS };
  for (const key of INDICATOR_SETTING_KEYS) {
    if (key in typed) {
      (touched as Record<string, unknown>)[key] = validated[key];
    }
  }
  return diffIndicatorSettingsFromFactory(touched);
}

export function normalizeIndicatorsV2(raw: unknown): PersistedIndicatorsV2 {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const byTimeframe: IndicatorSettingsByTimeframe = {};
  const rawBuckets = obj.byTimeframe && typeof obj.byTimeframe === 'object' && !Array.isArray(obj.byTimeframe)
    ? obj.byTimeframe as Record<string, unknown>
    : {};
  for (const profileKey of INDICATOR_PANE_PROFILE_KEYS) {
    const patch = sanitizeSettingsPatch(rawBuckets[profileKey]);
    if (Object.keys(patch).length > 0) byTimeframe[profileKey] = patch;
  }
  return {
    paneOrder: normalizePaneOrder(obj.paneOrder),
    byTimeframe,
  };
}

/** 현재 봉의 유효 설정 = 공장 기본값 ⊕ 해당 버킷. */
export function resolveIndicatorSettings(
  byTimeframe: IndicatorSettingsByTimeframe,
  timeframe: LiveTimeframe,
): IndicatorSettings {
  return {
    ...FACTORY_INDICATOR_SETTINGS,
    ...(byTimeframe[profileKeyForTimeframe(timeframe)] ?? {}),
  };
}

/** 전환 시드 (#697 결정 변경): v1 의 분봉 관점 유효 설정(flat ⊕ 구
 *  panePrefsByTimeframe.minute)을 새 공장값과 diff 해 minute 버킷에 심는다.
 *  D/W/M 버킷은 시드 없음 — 구 D/W/M pane 오버라이드는 폐기. paneOrder 는 이관. */
export function seedV2FromV1(v1raw: unknown): PersistedIndicatorsV2 {
  const v1 = mergeLiveIndicatorPrefs(v1raw);
  const minuteView: IndicatorSettings = { ...stripContainers(v1) };
  const minutePanePrefs = normalizePanePrefsByTimeframe(v1.panePrefsByTimeframe).minute ?? {};
  for (const key of INDICATOR_PANE_PREF_KEYS) {
    const override = minutePanePrefs[key];
    if (typeof override === 'boolean') minuteView[key] = override;
  }
  const minuteDiff = diffIndicatorSettingsFromFactory(minuteView);
  return {
    paneOrder: normalizePaneOrder(v1.paneOrder),
    byTimeframe: Object.keys(minuteDiff).length > 0 ? { minute: minuteDiff } : {},
  };
}

export function persistIndicatorsV2(state: PersistedIndicatorsV2): void {
  try {
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable — silent fallback.
  }
}

/** v2 로드. v2 부재 && v1 존재 시 1회 시드 후 즉시 영속(다음 로드부터 v1 미참조).
 *  둘 다 없으면 공장 클린 스타트. */
export function loadIndicatorsV2Storage(): PersistedIndicatorsV2 {
  try {
    const rawV2 = localStorage.getItem(INDICATORS_V2_STORAGE_KEY);
    if (rawV2) return normalizeIndicatorsV2(JSON.parse(rawV2));
    const rawV1 = localStorage.getItem(V1_STORAGE_KEY);
    if (rawV1) {
      const seeded = seedV2FromV1(JSON.parse(rawV1));
      persistIndicatorsV2(seeded);
      return seeded;
    }
    return normalizeIndicatorsV2(undefined);
  } catch {
    return normalizeIndicatorsV2(undefined);
  }
}
