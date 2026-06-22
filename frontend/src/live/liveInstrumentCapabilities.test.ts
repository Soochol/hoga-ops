import { describe, expect, it } from 'vitest';
import { capabilitiesForInstrument } from './liveInstrumentCapabilities';

describe('capabilitiesForInstrument', () => {
  it('keeps stock hoga and stock investor panes enabled', () => {
    expect(capabilitiesForInstrument({ kind: 'stock', code: '005930', label: '삼성전자' })).toEqual({
      hogaPanes: true,
      investorNet: 'stock',
      studySave: true,
    });
  });

  it('disables hoga panes for KOSPI while allowing market investor panes', () => {
    expect(capabilitiesForInstrument({ kind: 'index', id: 'KOSPI', label: 'KOSPI' })).toEqual({
      hogaPanes: false,
      investorNet: 'market',
      studySave: false,
    });
  });

  it('disables investor panes for narrower indices without direct KIS support', () => {
    expect(capabilitiesForInstrument({ kind: 'index', id: 'KOSPI200', label: 'KOSPI 200' })).toMatchObject({
      hogaPanes: false,
      investorNet: 'none',
    });
  });
});
