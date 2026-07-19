import {
  PRESET_INDICATOR_FLAG_KEYS,
  type PresetEnableByTimeframe,
} from '../live/presets/presetFlags';
import { INDICATOR_PANE_PROFILE_KEYS } from '../live/indicators/indicatorPaneProfiles';
import type { IndicatorSettings, IndicatorSettingsByTimeframe } from './indicatorSettingsV2';

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
    const merged = { ...params, ...(byTimeframeEnable[profileKey] ?? {}) };
    if (Object.keys(merged).length > 0) byTimeframe[profileKey] = merged;
  }
  return byTimeframe;
}
