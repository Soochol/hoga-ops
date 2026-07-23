import { apiCall } from './client';

// --- condition params (one per catalog type; type keys MUST match backend) ---
export interface TradeValueParams { min_eok: number }
export interface BreakoutParams { lookback: number; period: number }
export interface PeriodParams { period: number }
export interface TradeValuePeriodParams { lookback: number; min_eok: number }
export type ChangePctOp = 'gte' | 'lte' | 'between';
export interface ChangePctParams { op: ChangePctOp; pct?: number; lo?: number; hi?: number }
export interface PriceRangeParams { min?: number; max?: number }
// 최근 period일 고가 peak 대비 현재 고가 위치. within=고점 −pct% 이내 / outside=이외.
export type HighOffPeakSide = 'within' | 'outside';
export interface HighOffPeakParams { period: number; pct: number; side: HighOffPeakSide }
export type MaRelation = 'above' | 'below';
export type MaSource = 'open' | 'high' | 'low' | 'close';
export interface MaParams { period: number; relation: MaRelation; source?: MaSource }
// 매도/매수 총잔량 분봉 peak 신고: 당일 peak ≥ (threshold_pct/100) × 지난 N일 peak.
export interface DepthPeakParams { lookback: number; threshold_pct: number }

export type ConditionLeaf =
  | { id: string; type: 'trade_value'; params: TradeValueParams }
  | { id: string; type: 'trade_value_period'; params: TradeValuePeriodParams }
  | { id: string; type: 'new_high_today'; params: PeriodParams }
  | { id: string; type: 'new_high'; params: BreakoutParams }
  | { id: string; type: 'new_high_vol_today'; params: PeriodParams }
  | { id: string; type: 'new_high_vol'; params: BreakoutParams }
  | { id: string; type: 'high_off_peak'; params: HighOffPeakParams }
  | { id: string; type: 'change_pct'; params: ChangePctParams }
  | { id: string; type: 'price_range'; params: PriceRangeParams }
  | { id: string; type: 'ma'; params: MaParams }
  | { id: string; type: 'ask_depth_new_high'; params: DepthPeakParams }
  | { id: string; type: 'bid_depth_new_high'; params: DepthPeakParams };
export type ConditionType = ConditionLeaf['type'];

export type ScreenerScope = 'watchlist' | 'heatmap';

export interface ScreenerUniverse {
  markets?: ('KOSPI' | 'KOSDAQ')[];
  exclude_etf?: boolean;
  exclude_halted?: boolean;
  // 조회 대상을 캡처 집합으로 좁힌다(빈/미지정 = 전체 시장). 체크된 스코프의 합집합.
  scopes?: ScreenerScope[];
}

export type ScanBasis = 'eod' | 'intraday';

export interface ScanRequest {
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  limit?: number;
  basis?: ScanBasis;
}

export interface ScreenerRow {
  code: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  price: number;
  trade_value_won: number;
  change_pct: number | null;
}

export interface DepthCoverageCode {
  code: string;
  name: string;
  have_days: number;
  need_days: number;
}
export interface DepthCoverage {
  lookback: number;
  evaluated: number;
  excluded: DepthCoverageCode[];
  partial: DepthCoverageCode[];
}
export interface DepthPeakValue {
  ask_today: number | null;
  ask_past_peak: number | null;
  ask_have_days: number;
  ask_need_days: number;
  bid_today: number | null;
  bid_past_peak: number | null;
  bid_have_days: number;
  bid_need_days: number;
}

export interface ScreenerResponse {
  status: 'ok' | 'not_seeded' | 'building';
  rows: ScreenerRow[];
  warnings: string[];
  // 총잔량 신고 조건이 있을 때만 채워진다(없으면 null — 기존 응답과 하위호환).
  depth_coverage?: DepthCoverage | null;
  depth_values?: Record<string, DepthPeakValue> | null;
}

/** 진행 중인 갱신 job — WS 이벤트가 없어도(재진입/재연결) 서버가 복원해 준다. */
export interface ScreenerUpdating {
  done: number;
  total: number;
  started_ms: number;
}

export interface ScreenerStatus {
  status: string;
  last_raw_date?: string;
  universe_size?: number;
  days_behind?: number | null;
  updating?: ScreenerUpdating | null;
}

export type ScreenerUpdateSkipReason =
  | 'no_gap'
  | 'not_seeded'
  | 'kis_creds_missing'
  | 'calendar_unavailable';

export type ScreenerUpdateResponse =
  | { running: true; done: number; total: number }
  | { running: false; updated: 0; reason: ScreenerUpdateSkipReason };

export function runScan(body: ScanRequest): Promise<ScreenerResponse> {
  return apiCall<ScreenerResponse>('/api/screener/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const getScreenerStatus = () => apiCall<ScreenerStatus>('/api/screener/status');
export const triggerScreenerUpdate = () =>
  apiCall<ScreenerUpdateResponse>('/api/screener/update', { method: 'POST' });
