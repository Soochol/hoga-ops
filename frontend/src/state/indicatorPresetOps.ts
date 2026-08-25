import {
  PRESET_INDICATOR_FLAG_KEYS,
  type PresetEnableByTimeframe,
} from '../live/presets/presetFlags';
import { INDICATOR_PANE_PROFILE_KEYS } from '../live/indicators/indicatorPaneProfiles';
import type { LiveMAConfig } from './liveIndicatorsPersistence';
import {
  FACTORY_INDICATOR_SETTINGS,
  type IndicatorSettings,
  type IndicatorSettingsByTimeframe,
} from './indicatorSettingsV2';

/** 프리셋이 봉별로 교체하는 enable 키 집합 — 이 키만 프리셋으로 덮이고
 *  나머지(파라미터)는 보존된다(applyIndicatorPreset, #699 PR-D). */
const PRESET_ENABLE_KEY_SET = new Set<string>(PRESET_INDICATOR_FLAG_KEYS);

/**
 * 프리셋의 봉별 enable 오버라이드를 현 버킷에 적용한 결과를 돌려주는 순수 함수
 * (ADR-0119 C2c-2a에서 livePage 밖으로 추출 — 전역/창별 두 백엔드 공유).
 *
 * 파라미터(색·기간 등 enable 이 아닌 오버라이드)는 보존, enable 15키는 프리셋
 * 값으로 통째 교체(#699 §5 — 결정론: 미포함 enable 은 공장값 복귀).
 */
export function applyPresetEnableByTimeframe(
  current: IndicatorSettingsByTimeframe,
  byTimeframeEnable: PresetEnableByTimeframe,
): IndicatorSettingsByTimeframe {
  const byTimeframe: IndicatorSettingsByTimeframe = {};
  for (const profileKey of INDICATOR_PANE_PROFILE_KEYS) {
    const existing = current[profileKey] ?? {};
    const params: Partial<IndicatorSettings> = {};
    for (const [key, value] of Object.entries(existing)) {
      if (!PRESET_ENABLE_KEY_SET.has(key)) {
        (params as Record<string, unknown>)[key] = value;
      }
    }
    // MA 마스터 2키는 **서버에 저장된 프리셋 payload 의 키**라 이름을 유지하지만,
    // 설정 스키마에는 더 이상 없다(슬롯의 `enabled` 로 접혔다). 그래서 버킷에 그대로
    // 쓰지 않고 슬롯 배열로 번역한다 — 번역을 빼먹으면 프리셋의 "MA 끔" 이 세션
    // 안에서 조용히 무시되고(다음 로드의 collapse 가 처리) 증상이 한참 뒤에 온다.
    const { movingAverageEnabled, dailyMovingAverageEnabled, ...otherFlags } =
      byTimeframeEnable[profileKey] ?? {};
    const merged: Partial<IndicatorSettings> = { ...params, ...otherFlags };
    applySlotEnable(merged, 'movingAverages', movingAverageEnabled);
    applySlotEnable(merged, 'dailyMovingAverages', dailyMovingAverageEnabled);
    if (Object.keys(merged).length > 0) byTimeframe[profileKey] = merged;
  }
  return byTimeframe;
}

/** 프리셋의 MA 마스터 값을 슬롯 배열의 `enabled` 로 옮긴다.
 *
 *  기간·색은 enable 이 아니라 **파라미터**라 위에서 이미 보존됐다 — 여기서는 그
 *  슬롯들의 켜짐만 프리셋 값으로 덮는다. 프리셋에 키가 없으면(구 payload) 손대지
 *  않는다: 접힌 뒤로는 MA 의 켜짐이 파라미터 필드 안에 살아, "미포함 enable 은
 *  공장값 복귀" 규칙을 적용하면 사용자의 슬롯 구성까지 되돌리게 된다. */
function applySlotEnable(
  target: Partial<IndicatorSettings>,
  key: 'movingAverages' | 'dailyMovingAverages',
  enabled: boolean | undefined,
): void {
  if (enabled === undefined) return;
  const slots: readonly LiveMAConfig[] = target[key] ?? FACTORY_INDICATOR_SETTINGS[key];
  target[key] = slots.map((slot) => ({ ...slot, enabled }));
}
