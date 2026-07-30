import type { SourceName } from './types';

// kis_api_first는 제거됨(2026-07-17 정책: 호가·체결은 KIS REST로 받지 않는다).
// SOURCE_CAPABILITIES의 kis_api 항목은 유지 — 소스 유니온의 전수 표기를 여기서 소유한다.
export type SourcePreference = 'hogaplay_first' | 'kis_ws_first' | 'completeness_first';

export interface SourceCapability {
  source: SourceName;
  label: string;
}

// 소스별 표기 레지스트리. 2026-07-31 기준 유일한 소비자는 SOURCE_PREFERENCE_LABELS다 —
// 소스별 렌더 필드(resolutionLabel·cssTokenName)는 SourceChip과 함께 제거했다.
export const SOURCE_CAPABILITIES: Record<SourceName, SourceCapability> = {
  hogaplay: {
    source: 'hogaplay',
    label: 'hogaplay',
  },
  kis_live: {
    source: 'kis_live',
    label: 'KIS WS',
  },
  kis_api: {
    source: 'kis_api',
    label: 'KIS API',
  },
  kiwoom_live: {
    source: 'kiwoom_live',
    label: '키움 WS',
  },
  screener_daily: {
    source: 'screener_daily',
    label: '스크리너',
  },
};

export const SOURCE_PREFERENCE_OPTIONS = [
  'hogaplay_first',
  'kis_ws_first',
  'completeness_first',
] as const satisfies readonly SourcePreference[];

// completeness_first의 대표 소스는 kis_live — 완결성 동급(둘 다 완결/둘 다 미완결)일
// 때의 타이브레이크가 실시간 WS 우선이라, 칩/기본 표시도 WS를 대표로 둔다.
export const SOURCE_PREFERENCE_PRIMARY_SOURCE: Record<SourcePreference, SourceName> = {
  hogaplay_first: 'hogaplay',
  kis_ws_first: 'kis_live',
  completeness_first: 'kis_live',
};

// getSourceCapability(런타임 소스 문자열 → capability, 미지 소스 폴백 포함)는
// SourceChip과 함께 제거했다(2026-07-31). 폴백이 존재한 이유는 리뷰 C2 —
// 백엔드 SourceName 드리프트가 칩 렌더 크래시로 /live 전체를 언마운트시켰기 때문인데,
// 지금은 이 레코드를 런타임 문자열로 인덱싱하는 코드가 없어 그 크래시 면이 없다.
// **백엔드 문자열로 인덱싱하는 소비자를 다시 만든다면 폴백부터 되살릴 것.**

// kis_ws_first는 종목별로 KIS·키움 중 실제 수집한 실시간 WS 소스가 자동 선택되므로
// 'KIS WS 우선' 대신 '실시간 WS 우선'으로 표기한다.
const SOURCE_PREFERENCE_LABELS: Record<SourcePreference, string> = {
  hogaplay_first: `${SOURCE_CAPABILITIES.hogaplay.label} 우선`,
  kis_ws_first: '실시간 WS 우선',
  completeness_first: '완결성 우선',
};

export function getOrderflowSourcePreferenceLabel(value: SourcePreference): string {
  return SOURCE_PREFERENCE_LABELS[value];
}

export function getSourcePreferenceLabel(value: SourcePreference): string {
  return getOrderflowSourcePreferenceLabel(value);
}
