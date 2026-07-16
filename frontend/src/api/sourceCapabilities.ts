import type { SourceName } from './types';

export type SourcePreference = 'hogaplay_first' | 'kis_ws_first' | 'kis_api_first';

export interface SourceCapability {
  source: SourceName;
  label: string;
  resolutionLabel: string;
  cssTokenName: string;
}

export const SOURCE_CAPABILITIES: Record<SourceName, SourceCapability> = {
  hogaplay: {
    source: 'hogaplay',
    label: 'hogaplay',
    resolutionLabel: 'tick',
    cssTokenName: 'hogaplay',
  },
  kis_live: {
    source: 'kis_live',
    label: 'KIS WS',
    resolutionLabel: '10s',
    cssTokenName: 'kis-live',
  },
  kis_api: {
    source: 'kis_api',
    label: 'KIS API',
    resolutionLabel: '30s',
    cssTokenName: 'kis-api',
  },
  kiwoom_live: {
    source: 'kiwoom_live',
    label: '키움 WS',
    resolutionLabel: 'tick',
    cssTokenName: 'kiwoom-live',
  },
  screener_daily: {
    source: 'screener_daily',
    label: '스크리너',
    resolutionLabel: '1D',
    cssTokenName: 'screener-daily',
  },
};

export const SOURCE_PREFERENCE_OPTIONS = [
  'hogaplay_first',
  'kis_ws_first',
  'kis_api_first',
] as const satisfies readonly SourcePreference[];

export const SOURCE_PREFERENCE_PRIMARY_SOURCE: Record<SourcePreference, SourceName> = {
  hogaplay_first: 'hogaplay',
  kis_ws_first: 'kis_live',
  kis_api_first: 'kis_api',
};

// 백엔드가 프론트 유니온에 없는 소스 문자열을 보내도 크래시하지 않도록 폴백을 준다
// (리뷰 C2: SourceName 미러 드리프트가 SourceChip 렌더 크래시로 /live 전체를 언마운트시켰다).
// getSourceCapability는 런타임 문자열을 받으므로 SourceName이 아닌 값도 방어한다.
function _fallbackCapability(source: string): SourceCapability {
  return {
    source: source as SourceName,
    label: source,
    resolutionLabel: '',
    cssTokenName: 'unknown',
  };
}

export function getSourceCapability(source: SourceName): SourceCapability {
  return SOURCE_CAPABILITIES[source] ?? _fallbackCapability(source);
}

export function getOrderflowSourcePreferenceLabel(value: SourcePreference): string {
  return `${SOURCE_CAPABILITIES[SOURCE_PREFERENCE_PRIMARY_SOURCE[value]].label} 우선`;
}

export function getSourcePreferenceLabel(value: SourcePreference): string {
  return getOrderflowSourcePreferenceLabel(value);
}
