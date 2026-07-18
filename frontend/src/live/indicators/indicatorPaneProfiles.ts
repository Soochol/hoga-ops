import type { LiveTimeframe } from '../../state/livePage';
import type { PersistedIndicators } from '../../state/liveIndicatorsPersistence';
import type { PaneToggles } from '../paneSpecsForTimeframe';

/**
 * Timeframe 프로파일 키(분/D/W/M 4버킷)와 pane 토글 7종의 어휘.
 *
 * PR-A(#699) 이후 per-timeframe 해석은 store 가 소유한다 — 최상위 지표 필드는
 * 항상 현재 봉으로 resolve 된 투영이므로, 이 모듈의 함수들은 병합 없이 그 투영을
 * 골라 담기만 한다. `normalizePanePrefsByTimeframe` 는 구 v1 블롭(전환 시드)과
 * 프리셋 payload(PR-D 전 구 형식) 파싱용으로 남는다.
 */

export type IndicatorPaneProfileKey = 'minute' | 'D' | 'W' | 'M';

export type IndicatorPanePrefs = {
  volumeEnabled: boolean;
  quoteTotalsEnabled: boolean;
  ratioEnabled: boolean;
  fillStrengthEnabled: boolean;
  programTradeEnabled: boolean;
  foreignNetEnabled: boolean;
  institutionNetEnabled: boolean;
};

export type PanePrefKey = keyof IndicatorPanePrefs;

/** 소비자가 store 에서 골라오는, 이미 resolve 된 pane 토글 7종. */
export type PanePrefsIndicatorSource = Pick<PersistedIndicators, PanePrefKey>;

export type PersistedPanePrefsByTimeframe =
  Partial<Record<IndicatorPaneProfileKey, Partial<IndicatorPanePrefs>>>;

export const INDICATOR_PANE_PROFILE_KEYS: readonly IndicatorPaneProfileKey[] =
  ['minute', 'D', 'W', 'M'] as const;

export const INDICATOR_PANE_PREF_KEYS: readonly PanePrefKey[] = [
  'volumeEnabled',
  'quoteTotalsEnabled',
  'ratioEnabled',
  'fillStrengthEnabled',
  'programTradeEnabled',
  'foreignNetEnabled',
  'institutionNetEnabled',
] as const;

const PROFILE_KEY_SET = new Set<string>(INDICATOR_PANE_PROFILE_KEYS);
function isProfileKey(value: string): value is IndicatorPaneProfileKey {
  return PROFILE_KEY_SET.has(value);
}

export function profileKeyForTimeframe(tf: LiveTimeframe): IndicatorPaneProfileKey {
  return tf === 'D' || tf === 'W' || tf === 'M' ? tf : 'minute';
}

/** per-timeframe boolean 오버라이드 맵의 공용 정규화기: 미지 프로파일·미지 키·
 *  비불리언 값·빈 버킷을 드롭한다. pane 7키(구 v1 블롭)와 프리셋 enable 15키가
 *  동일 형태라 이 하나를 공유한다(#699 PR-D 코드 리뷰). */
export function normalizeBooleanByTimeframe<K extends string>(
  raw: unknown,
  allowedKeys: readonly K[],
): Partial<Record<IndicatorPaneProfileKey, Partial<Record<K, boolean>>>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const allowed = new Set<string>(allowedKeys);
  const out: Partial<Record<IndicatorPaneProfileKey, Partial<Record<K, boolean>>>> = {};
  for (const [profileKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isProfileKey(profileKey)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const bucket: Partial<Record<K, boolean>> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (allowed.has(key) && typeof v === 'boolean') bucket[key as K] = v;
    }
    if (Object.keys(bucket).length > 0) out[profileKey] = bucket;
  }
  return out;
}

/** 구 v1 블롭·구 프리셋 payload 의 per-timeframe pane 서브트리 파서. */
export function normalizePanePrefsByTimeframe(raw: unknown): PersistedPanePrefsByTimeframe {
  return normalizeBooleanByTimeframe(raw, INDICATOR_PANE_PREF_KEYS);
}

/** resolve 된 store 슬라이스에서 pane 토글 7종을 골라 담는다(병합 없음). */
export function pickPanePrefs(indicators: PanePrefsIndicatorSource): IndicatorPanePrefs {
  return {
    volumeEnabled: indicators.volumeEnabled,
    quoteTotalsEnabled: indicators.quoteTotalsEnabled,
    ratioEnabled: indicators.ratioEnabled,
    fillStrengthEnabled: indicators.fillStrengthEnabled,
    programTradeEnabled: indicators.programTradeEnabled,
    foreignNetEnabled: indicators.foreignNetEnabled,
    institutionNetEnabled: indicators.institutionNetEnabled,
  };
}

/** resolve 된 pane 토글에 차트 국지 override 를 얹어 PaneToggles 를 만든다. */
export function resolvePaneToggles(input: {
  indicators: PanePrefsIndicatorSource;
  forceHogaPanes?: boolean;
  hogaPanes?: boolean;
  override?: Partial<PaneToggles>;
}): PaneToggles {
  const prefs = pickPanePrefs(input.indicators);
  return {
    foreignNet: prefs.foreignNetEnabled,
    institutionNet: prefs.institutionNetEnabled,
    volumeEnabled: prefs.volumeEnabled,
    quoteTotalsEnabled: prefs.quoteTotalsEnabled,
    ratioEnabled: prefs.ratioEnabled,
    fillStrengthEnabled: prefs.fillStrengthEnabled,
    programTradeEnabled: prefs.programTradeEnabled,
    hogaPanes: input.hogaPanes,
    forceHogaPanes: input.forceHogaPanes,
    ...input.override,
  };
}
