import {
  INDICATOR_PANE_PROFILE_KEYS,
  type IndicatorPaneProfileKey,
} from '../indicators/indicatorPaneProfiles';

/**
 * 레이아웃 프리셋이 캡처/적용하는 지표 enable 키 화이트리스트 (ADR-0114 §4).
 * store 도 snapshot 도 이 leaf 를 import 한다(순환 회피 — 이 모듈은 store 를 모른다).
 *
 * 오버레이 enable 8종 + pane 토글 7종. PR-D(#699) 이후 프리셋 payload 는 이 15키를
 * **봉별(minute/D/W/M) sparse 오버라이드**로 담는다(구 flat indicator_flags +
 * pane_prefs_by_timeframe 통합). flat 병합이 폐지돼(PR-A) 더 이상 flat 레이어를
 * 덮어쓸 필요가 없다 — 적용은 각 버킷의 enable 오버라이드를 통째 교체한다.
 */
export const PRESET_INDICATOR_FLAG_KEYS = [
  // 오버레이 enable
  'movingAverageEnabled',
  'dailyMovingAverageEnabled',
  'askPeakEnabled',
  'bidPeakEnabled',
  'tradeVolumePocEnabled',
  'depthHeatmapEnabled',
  'brokerLateEntryEnabled',
  'volumeDistributionEnabled',
  // pane 토글
  'volumeEnabled',
  'quoteTotalsEnabled',
  'ratioEnabled',
  'fillStrengthEnabled',
  'programTradeEnabled',
  'foreignNetEnabled',
  'institutionNetEnabled',
] as const;

export type PresetIndicatorFlagKey = (typeof PRESET_INDICATOR_FLAG_KEYS)[number];

export type PresetIndicatorFlags = Partial<Record<PresetIndicatorFlagKey, boolean>>;

/** 봉별 enable 오버라이드 맵 — 프리셋 payload by_timeframe_enable 의 정규형. */
export type PresetEnableByTimeframe =
  Partial<Record<IndicatorPaneProfileKey, PresetIndicatorFlags>>;

const FLAG_KEY_SET = new Set<string>(PRESET_INDICATOR_FLAG_KEYS);

function isPresetFlagKey(v: string): v is PresetIndicatorFlagKey {
  return FLAG_KEY_SET.has(v);
}

/** 프리셋 payload 의 by_timeframe_enable 를 정규화한다: 미지 프로파일·미지 키·
 *  비불리언 값 드롭. (구 v1 payload 는 서버가 이미 폐기하므로 여기선 v2 형식만.) */
export function normalizePresetEnableByTimeframe(raw: unknown): PresetEnableByTimeframe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const profileSet = new Set<string>(INDICATOR_PANE_PROFILE_KEYS);
  const out: PresetEnableByTimeframe = {};
  for (const [profileKey, bucket] of Object.entries(raw as Record<string, unknown>)) {
    if (!profileSet.has(profileKey)) continue;
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    const flags: PresetIndicatorFlags = {};
    for (const [key, value] of Object.entries(bucket as Record<string, unknown>)) {
      if (isPresetFlagKey(key) && typeof value === 'boolean') flags[key] = value;
    }
    if (Object.keys(flags).length > 0) out[profileKey as IndicatorPaneProfileKey] = flags;
  }
  return out;
}
