import { apiCall } from './client';

export type Breakout =
  | { hit: true; event_date: string; days_ago: number; period_extreme: number }
  | { hit: false };

export interface ScreenerRow {
  code: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  price: number;
  trade_value_won: number;
  change_pct: number | null;
  new_high: Breakout | null;
  new_high_vol: Breakout | null;
}

export interface ScreenerResponse {
  status: 'ok' | 'not_seeded' | 'building';
  rows: ScreenerRow[];
}

export interface ScreenerStatus {
  status: string;
  last_raw_date?: string;
  universe_size?: number;
  days_behind?: number | null;
}

export interface BreakoutFilter {
  lookback: number;
  period: number;
}

export interface ScreenerFilters {
  minTradeValueEok?: number;
  newHigh?: BreakoutFilter;
  newHighVol?: BreakoutFilter;
  markets?: ('KOSPI' | 'KOSDAQ')[];
  excludeEtf?: boolean;
  excludeHalted?: boolean;
  q?: string;
}

export function runScreener(f: ScreenerFilters): Promise<ScreenerResponse> {
  const p = new URLSearchParams();
  if (f.minTradeValueEok != null) p.set('min_trade_value_eok', String(f.minTradeValueEok));
  if (f.newHigh) {
    p.set('nh_lookback', String(f.newHigh.lookback));
    p.set('nh_period', String(f.newHigh.period));
  }
  if (f.newHighVol) {
    p.set('nhv_lookback', String(f.newHighVol.lookback));
    p.set('nhv_period', String(f.newHighVol.period));
  }
  (f.markets ?? []).forEach((m) => p.append('markets', m));
  if (f.excludeEtf) p.set('exclude_etf', 'true');
  if (f.excludeHalted) p.set('exclude_halted', 'true');
  if (f.q) p.set('q', f.q);
  return apiCall<ScreenerResponse>(`/api/screener?${p.toString()}`);
}

export const getScreenerStatus = () => apiCall<ScreenerStatus>('/api/screener/status');
export const triggerScreenerUpdate = () => apiCall('/api/screener/update', { method: 'POST' });
