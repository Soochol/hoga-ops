import { apiCall } from './client';

// --- condition params (one per catalog type; type keys MUST match backend) ---
export interface TradeValueParams { min_eok: number }
export interface BreakoutParams { lookback: number; period: number }
export type ChangePctOp = 'gte' | 'lte' | 'between';
export interface ChangePctParams { op: ChangePctOp; pct?: number; lo?: number; hi?: number }
export interface PriceRangeParams { min?: number; max?: number }
export type MaRelation = 'above' | 'below';
export interface MaParams { period: number; relation: MaRelation }

export type ConditionLeaf =
  | { id: string; type: 'trade_value'; params: TradeValueParams }
  | { id: string; type: 'new_high'; params: BreakoutParams }
  | { id: string; type: 'new_high_vol'; params: BreakoutParams }
  | { id: string; type: 'change_pct'; params: ChangePctParams }
  | { id: string; type: 'price_range'; params: PriceRangeParams }
  | { id: string; type: 'ma'; params: MaParams };
export type ConditionType = ConditionLeaf['type'];

export interface ScreenerUniverse {
  markets?: ('KOSPI' | 'KOSDAQ')[];
  exclude_etf?: boolean;
  exclude_halted?: boolean;
}

export interface ScanRequest {
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  limit?: number;
}

export interface ScreenerRow {
  code: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  price: number;
  trade_value_won: number;
  change_pct: number | null;
}

export interface ScreenerResponse {
  status: 'ok' | 'not_seeded' | 'building';
  rows: ScreenerRow[];
  warnings: string[];
}

export interface ScreenerStatus {
  status: string;
  last_raw_date?: string;
  universe_size?: number;
  days_behind?: number | null;
}

export function runScan(body: ScanRequest): Promise<ScreenerResponse> {
  return apiCall<ScreenerResponse>('/api/screener/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const getScreenerStatus = () => apiCall<ScreenerStatus>('/api/screener/status');
export const triggerScreenerUpdate = () => apiCall('/api/screener/update', { method: 'POST' });
