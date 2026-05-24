// Mirrors hoga/api/models.py — keep in sync by hand.

/** Per ADR-0020 — backend `DiskState` values surfaced as a string.
 *  `none`은 inventory에 등장하지 않는다 (meta.json 없으면 행 자체가 없음). */
export type DiskStateValue = 'complete' | 'source_partial' | 'client_incomplete' | 'invalid';

export type StockDate = {
  date: string; code: string; name: string;
  regular_session_open_ms: number; regular_session_close_ms: number;
  data_window_first_ms: number; data_window_last_ms: number;
  price_min: number; price_max: number; captured_at: number;
  total_volume: number; pages_collected: number; file_size_bytes: number;
  today_open: number; today_high: number; today_low: number; today_close: number;
  disk_state: DiskStateValue;
};

export type Candle = { ts_ms: number; open: number; close: number; high: number; low: number; vol_a: number; vol_b: number };

export type QuoteRatioPoint = { t: number; bid_total: number; ask_total: number };
export type QuoteRatio = { bucket_ms: number; points: QuoteRatioPoint[] };

export type VolumeProfileBin = { price_low: number; qty: number };
export type VolumeProfile = {
  bin_count: number; price_min: number; price_max: number; bin_width: number;
  bins: VolumeProfileBin[];
};

export type FillStrengthPoint = { t: number; buy_qty: number; sell_qty: number };
export type FillStrength = { bucket_ms: number; points: FillStrengthPoint[] };

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

// Mirrors hoga/tables/brokers.py::ApiBrokerEntry verbatim. `broker` is the
// firm's name; `qty_today` is the cumulative quantity through the cursor
// moment and `qty_delta` is the increment since the previous broker tick.
// The Replay Viewer's BrokerNetTable aggregates qty_today by side to
// render net pressure.
export type BrokerEntry = {
  side: 'buy' | 'sell';
  rank: number;
  broker: string;
  qty_today: number;
  qty_delta: number;
};

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
  /** "stagnation_abort" when the collector's stagnation guard tripped (hogaplay
   *  response freeze). Null on normal completion. Frontend should flag the row
   *  as partial-data when present, not render as a clean "done". */
  abort_reason: string | null;
}

/** Mirrors hoga/api/error_codes.py::CaptureErrorCode verbatim — captures-domain
 *  non-upstream codes. Per ADR-0009 cookie/hogaplay codes moved to UpstreamCode.
 *  Per ADR-0004 mirror discipline: adding a value to the Python enum requires
 *  adding the same string here. */
export type CaptureErrorCode =
  | 'today_too_early'
  | 'missing_range'
  | 'terminal'
  | 'not_found'
  | 'internal_error';

/** Mirrors hoga/api/error_codes.py::UpstreamCode verbatim (ADR-0009). Used as
 *  `reason: UpstreamCode | null` on cache envelopes (SymbolsAllResponse,
 *  CalendarResponse), as `detail.code: UpstreamCode` on HTTP 5xx error
 *  bodies, and as `CaptureError.code` on per-item SSE failures (via the
 *  `CaptureFinishedErrorCode` alias below). */
export type UpstreamCode =
  | 'krx_credentials_missing'
  | 'krx_fetch_failed'
  | 'cookie_expired'
  | 'cookie_missing'
  | 'hogaplay_http_error'
  | 'symbol_master_not_initialized'
  | 'disk_write_failed';

/** Union used wherever an error code can be either domain — currently
 *  CaptureError.code on the per-item SSE capture_finished payload. */
export type CaptureFinishedErrorCode = CaptureErrorCode | UpstreamCode;

export interface CaptureError {
  code: CaptureFinishedErrorCode;
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

/** Mirrors hoga/api/models.py::SymbolMasterInfo. See ADR-0004 (mirror discipline). */
export interface SymbolMasterInfo {
  count: number;
  fetched_at_ms: number | null;
  status: SymbolsCacheStatus;
  reason: UpstreamCode | null;
}

/** Mirrors hoga/api/models.py::SymbolsAllResponse. */
export interface SymbolsAllResponse {
  symbols: SymbolHit[];
  status: SymbolsCacheStatus;
  fetched_at_ms: number | null;
  reason?: UpstreamCode | null;
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
  reason?: UpstreamCode | null;
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

// === RangeBundle (ADR-0013) ===

export type RangeSegment = {
  date: string;            // YYYYMMDD KST
  session_open_ms: number; // Unix ms
  session_close_ms: number;
};

export type Timeframe = '1m' | '3m' | '5m' | '10m' | '15m' | '30m';

export const TIMEFRAME_TO_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
};

export const TIMEFRAME_LABELS: ReadonlyArray<Timeframe> = ['1m', '3m', '5m', '10m', '15m', '30m'];

/** ADR-0020: per-Stock-Date invariant outcome surfaced on the wire. */
export type ViolationWire = {
  invariant_id: string;
  severity: 'error' | 'warn';
  message: string;
  ctx: Record<string, unknown>;
};

export type ExcludedDate = {
  date: string;             // YYYYMMDD KST
  violations: ViolationWire[];
};

export type DateWarning = {
  date: string;
  warnings: ViolationWire[];
};

export type RangeBundle = {
  code: string;
  from_date: string;
  to_date: string;
  bucket_ms: number;
  segments: RangeSegment[];
  candles: Candle[];
  quote_ratio: QuoteRatio;
  fill_strength: FillStrength;
  volume_profile_range: VolumeProfile;
  volume_profile_by_day: VolumeProfile[];
  /** ADR-0020: Stock-Dates dropped from segments due to error-severity
   * invariant violations. Default empty list on healthy bundles. */
  excluded_dates?: ExcludedDate[];
  /** ADR-0020: Stock-Dates kept in segments but with warn-severity
   * invariant violations attached. */
  data_warnings?: DateWarning[];
};
