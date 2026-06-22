import type { LiveInstrument } from './liveInstrument';

export type LiveInvestorNetCapability = 'stock' | 'market' | 'index' | 'none';

export type LiveInstrumentCapabilities = {
  hogaPanes: boolean;
  investorNet: LiveInvestorNetCapability;
  studySave: boolean;
};

export const STOCK_CAPABILITIES: LiveInstrumentCapabilities = {
  hogaPanes: true,
  investorNet: 'stock',
  studySave: true,
};

export function capabilitiesForInstrument(
  instrument: LiveInstrument | null,
): LiveInstrumentCapabilities {
  if (!instrument || instrument.kind === 'stock') return STOCK_CAPABILITIES;
  return {
    hogaPanes: false,
    investorNet: instrument.id === 'KOSPI' || instrument.id === 'KOSDAQ' ? 'market' : 'none',
    studySave: false,
  };
}
