import { describe, expect, it } from 'vitest';
import {
  SOURCE_CAPABILITIES,
  SOURCE_PREFERENCE_OPTIONS,
  SOURCE_PREFERENCE_PRIMARY_SOURCE,
  getSourceCapability,
  getSourcePreferenceLabel,
} from './sourceCapabilities';

describe('sourceCapabilities', () => {
  it('defines UI capabilities for every read source', () => {
    expect(SOURCE_CAPABILITIES).toEqual({
      hogaplay: expect.objectContaining({ label: 'hogaplay', resolutionLabel: 'tick', cssTokenName: 'hogaplay' }),
      kis_live: expect.objectContaining({ label: 'KIS WS', resolutionLabel: '10s', cssTokenName: 'kis-live' }),
      kis_api: expect.objectContaining({ label: 'KIS API', resolutionLabel: '30s', cssTokenName: 'kis-api' }),
    });
  });

  it('keeps display preference options in backend policy order', () => {
    expect(SOURCE_PREFERENCE_OPTIONS).toEqual(['hogaplay_first', 'kis_ws_first', 'kis_api_first']);
    expect(SOURCE_PREFERENCE_PRIMARY_SOURCE).toEqual({
      hogaplay_first: 'hogaplay',
      kis_ws_first: 'kis_live',
      kis_api_first: 'kis_api',
    });
  });

  it('derives labels from source capabilities', () => {
    expect(getSourceCapability('kis_api').resolutionLabel).toBe('30s');
    expect(getSourcePreferenceLabel('kis_ws_first')).toBe('KIS WS 우선');
  });
});
