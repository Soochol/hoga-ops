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

export function getSourceCapability(source: SourceName): SourceCapability {
  return SOURCE_CAPABILITIES[source];
}

export function getOrderflowSourcePreferenceLabel(value: SourcePreference): string {
  return `${SOURCE_CAPABILITIES[SOURCE_PREFERENCE_PRIMARY_SOURCE[value]].label} 우선`;
}

export function getSourcePreferenceLabel(value: SourcePreference): string {
  return getOrderflowSourcePreferenceLabel(value);
}
