/**
 * 레이아웃 프리셋이 캡처/적용하는 지표 enable 플래그 화이트리스트 (ADR-0114 §4).
 * store 도 snapshot 도 이 leaf 를 import 한다(순환 회피 — 이 모듈은 store 를 모른다).
 *
 * 오버레이 enable 플래그 + **flat 레거시 pane 플래그**를 함께 담는다. flat 도 필요한
 * 이유: `panePrefsForTimeframe` 이 `flat ⊕ byTimeframe` 병합이라, map 만 적용하면
 * 사용자의 stale flat 값이 폴백으로 남는다. 적용 시 양 레이어를 모두 덮어써 결정론 확보.
 */
export const PRESET_INDICATOR_FLAG_KEYS = [
  // 오버레이 enable 플래그
  'movingAverageEnabled',
  'dailyMovingAverageEnabled',
  'askPeakEnabled',
  'bidPeakEnabled',
  'tradeVolumePocEnabled',
  'depthHeatmapEnabled',
  'brokerLateEntryEnabled',
  'volumeDistributionEnabled',
  // flat 레거시 pane 플래그
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
