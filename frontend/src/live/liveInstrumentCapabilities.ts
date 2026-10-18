import { isUsIndexId, type LiveInstrument } from './liveInstrument';

export type LiveInvestorNetCapability = 'stock' | 'market' | 'index' | 'none';

export type LiveInstrumentCapabilities = {
  hogaPanes: boolean;
  investorNet: LiveInvestorNetCapability;
  studySave: boolean;
  tradeValue?: boolean;
  volume?: boolean;
};

export const STOCK_CAPABILITIES: LiveInstrumentCapabilities = {
  hogaPanes: true,
  investorNet: 'stock',
  studySave: true,
  tradeValue: true,
};

export function capabilitiesForInstrument(
  instrument: LiveInstrument | null,
): LiveInstrumentCapabilities {
  if (instrument?.kind === 'us_stock' || (instrument?.kind === 'index' && isUsIndexId(instrument.id))) return { hogaPanes: false, investorNet: 'none', studySave: false, tradeValue: false, volume: false };
  if (!instrument || instrument.kind === 'stock') return STOCK_CAPABILITIES;
  return {
    hogaPanes: false,
    investorNet: instrument.id === 'KOSPI' || instrument.id === 'KOSDAQ' ? 'market' : 'none',
    studySave: false,
    tradeValue: true,
  };
}
