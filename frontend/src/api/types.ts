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

// Wire shape per ADR-0004 — backend ships ApiOrderbookSnapshot verbatim,
// no adapter layer. Side encoded by which array (ask vs bid); rank by index.
export type OrderbookLevel = { price: number; qty: number };
export type OrderbookSnapshot = {
  ts_ms: number;
  seq: number;
  ask: OrderbookLevel[]; // length 10, index 0 = best ask
  bid: OrderbookLevel[]; // length 10, index 0 = best bid
  tot_ask: number;
  tot_bid: number;
};

/** GET /api/orderbook response envelope. */
export type OrderbookResponse = {
  available_from: number | null;
  snapshot: OrderbookSnapshot | null;
};

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

export type CapturePhase =
  | 'queued'
  | 'deciding'
  | 'capturing'
  | 'parsing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type SkipReason = 'already_complete' | 'source_partial';

export interface CaptureProgress {
  pages_done: number;
  events_seen: number;
  frontier_ms: number;       // Unix epoch ms per ADR-0003
  estimate_pct: number;
  elapsed_ms: number;
}

export interface CaptureResult {
  pages_written: number;
  unique_events: number;
  raw_dir: string;
  parsed: boolean;
}

export interface CaptureError {
  code: string;
  message: string;
  at_page?: number | null;
}

/** Mirrors hoga/api/models.py::QueueItem. */
export interface QueueItem {
  item_id: string;
  code: string;
  date: string;
  phase: CapturePhase;
  force_retry: boolean;
  pause_origin: boolean;
  enqueued_at_ms: number;
  started_at_ms: number | null;
  progress: CaptureProgress | null;
  result: CaptureResult | null;
  error: CaptureError | null;
  skip_reason: SkipReason | null;
}

/** Common header on every per-item SSE event (capture_progress / capture_phase /
 *  capture_finished). Mirrors hoga/api/models.py::_CaptureEventBase. */
export interface CaptureEventBase {
  item_id: string;
  code: string;
  date: string;
  phase: CapturePhase;
}

export type SSEEvent =
  | { type: 'inventory_added'; code: string; date: string }
  | { type: 'inventory_removed'; code: string; date: string }
  | (CaptureEventBase & { type: 'capture_progress'; progress: CaptureProgress })
  | (CaptureEventBase & { type: 'capture_phase' })
  | (CaptureEventBase & {
      type: 'capture_finished';
      result: CaptureResult | null;
      error: CaptureError | null;
      skip_reason: SkipReason | null;
    })
  | { type: 'capture_queued'; items: QueueItem[] }
  | { type: 'capture_queue_paused'; reason: 'cookie_expired'; message: string }
  | { type: 'capture_queue_resumed'; reason: 'user_resume' | 'cancel_all' }
  | {
      type: 'capture_queue_drained';
      total_done: number;
      total_failed: number;
      total_cancelled: number;
      total_skipped: number;
    }
  | { type: 'heartbeat' }
  | { type: 'disconnected' };

/** Mirrors hoga/api/models.py::SymbolHit. */
export interface SymbolHit {
  code: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  captured_count: number;                              // complete-only headline
  captured_breakdown: {
    complete: number;
    source_partial: number;
    client_incomplete: number;
  };
}

export type SymbolsCacheStatus = 'loading' | 'fresh' | 'stale' | 'unavailable';

/** Mirrors hoga/api/models.py::SymbolsAllResponse. */
export interface SymbolsAllResponse {
  symbols: SymbolHit[];
  status: SymbolsCacheStatus;
  fetched_at_ms: number | null;
}

export type CalendarStatus =
  | 'complete'
  | 'source_partial'
  | 'client_incomplete'
  | 'none'
  | 'weekend'
  | 'holiday'
  | 'future'
  | 'today_locked';

/** Mirrors hoga/api/models.py::CalendarCell. */
export interface CalendarCell {
  date: string;
  status: CalendarStatus;
  captured_at_ms: number | null;
}

/** Mirrors hoga/api/models.py::CalendarResponse. */
export interface CalendarResponse {
  cells: CalendarCell[];
  as_of_ms: number;                                    // spec §11 Q21 reconciliation key
}

/** Mirrors hoga/api/models.py::EnqueueRequest. */
export interface EnqueueRequest {
  code: string;
  start_date?: string | null;
  end_date?: string | null;
  dates?: string[] | null;
  force_retry: boolean;
}

export interface EnqueueDedupedRow {
  code: string;
  date: string;
  reason: 'already_in_queue' | 'already_running';
}

/** Mirrors hoga/api/models.py::EnqueueResponse. */
export interface EnqueueResponse {
  enqueued: QueueItem[];
  deduped: EnqueueDedupedRow[];
}

/** Mirrors hoga/api/models.py::QueueSnapshot. */
export interface QueueSnapshot {
  active: QueueItem[];
  queued: QueueItem[];
  done: QueueItem[];
  paused: boolean;
  max_concurrent: number;
}
