// Mirrors hoga/api/models.py — keep in sync by hand.

export type StockDate = {
  date: string; code: string; name: string;
  regular_session_open_ms: number; regular_session_close_ms: number;
  data_window_first_ms: number; data_window_last_ms: number;
  price_min: number; price_max: number; captured_at: number;
  total_volume: number; pages_collected: number; file_size_bytes: number;
  today_open: number; today_high: number; today_low: number; today_close: number;
};

export type Candle = { ts_ms: number; open: number; close: number; high: number; low: number; vol_a: number; vol_b: number };

export type QuoteRatioPoint = { t: number; bid_total: number; ask_total: number };
export type QuoteRatio = { bucket_ms: number; points: QuoteRatioPoint[] };

export type DepthIntensity = {
  bucket_ms: number; price_min: number; price_max: number; price_step: number;
  times: number[]; bid_grid: number[][]; ask_grid: number[][];
};

export type VolumeProfileBin = { price_low: number; qty: number };
export type VolumeProfile = {
  bin_count: number; price_min: number; price_max: number; bin_width: number;
  bins: VolumeProfileBin[];
};

export type FillStrengthPoint = { t: number; buy_qty: number; sell_qty: number };
export type FillStrength = { bucket_ms: number; points: FillStrengthPoint[] };

export type SessionBundle = {
  code: string; date: string;
  session_open_ms: number; session_close_ms: number;
  candles: Candle[];
  quote_ratio: QuoteRatio;
  depth_intensity: DepthIntensity;
  volume_profile: VolumeProfile;
  fill_strength: FillStrength;
};

export type OrderbookLevel = { side: 'ask' | 'bid'; rank: number; price: number; qty: number };
export type OrderbookSnapshot = { ts_ms: number; levels: OrderbookLevel[] };

export type BrokerEntry = { name: string; side: 'buy' | 'sell'; rank: number; qty: number };

// Mirrors hoga/tables/trades.py::ApiTrade. `side` is -1 / 0 / +1 by convention
// (sell / auction-cross / buy) but typed as number — the backend does not
// enforce the literal, and a runtime guard would be more honest than a TS
// fiction here.
export type Trade = {
  ts_ms: number;
  seq: number;
  price: number;
  change_pct: number;
  qty: number;
  side: number;
  cum_vol: number;
  cum_trades: number;
  low_so_far: number;
  high_so_far: number;
  net_pressure: number;
};

export type SSEEvent =
  | { type: 'inventory_added'; code: string; date: string }
  | { type: 'inventory_removed'; code: string; date: string }
  | { type: 'heartbeat' }
  | { type: 'disconnected' };
