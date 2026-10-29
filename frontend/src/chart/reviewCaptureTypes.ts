import type { LiveVenueOption } from '../state/liveVenue';

/** Frozen from the clicked window, never from the focused/last-created chart. */
export interface ReviewCaptureContext {
  name: string;
  venue: LiveVenueOption;
  dates: string[];
  fromMs: number;
  toMs: number;
}

export interface ReviewCandle {
  t_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ReviewCandleSection {
  candles: ReviewCandle[];
  message: string;
}

export interface ReviewFlowMarket {
  foreign: number | null;
  institution: number | null;
  individual: number | null;
  basis: string;
}

export interface ReviewCaptureData {
  date: string;
  kospi: ReviewCandleSection;
  kosdaq: ReviewCandleSection;
  daily: ReviewCandleSection;
  flow: { markets: Record<'KOSPI' | 'KOSDAQ', ReviewFlowMarket>; message: string };
}
