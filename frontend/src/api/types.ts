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
  /** ADR-0004 mirror of hoga/api/models.py::StockDate.full_capture_count.
   *  Null on legacy meta.json files written before the counter existed.
   *  See CONTEXT.md "Full Capture Count". */
  full_capture_count: number | null;
  /** ADR-0042: consecutive failed+skipped count since last success/unblock.
   *  Joined from QueueManifest.fail_streaks at the route layer. 0 means
   *  "no recent failures"; ``>= 5`` means ``blocked``. */
  fail_streak: number;
  /** ADR-0042: ``fail_streak >= 5``. Renders a 차단됨 badge + 잠금 해제
   *  button on the inventory row; enqueue is rejected with HTTP 409 until
   *  the user clears the counter. */
  blocked: boolean;
};

export type Candle = { ts_ms: number; open: number; close: number; high: number; low: number; vol_a: number; vol_b: number };

export type PriceLevelHit = {
  date: string;
  t_ms: number;
  price: number;
  kind: 'vi' | 'limit';
  direction: 'upper' | 'lower';
  pct: 10 | 20 | 30;
};

export type QuoteRatioPoint = {
  t: number;
  bid_total: number;
  ask_total: number;
  bid_max: number;
  ask_max: number;
  imb_max_bid: number;
  imb_max_ask: number;
};
export type QuoteRatio = { bucket_ms: number; points: QuoteRatioPoint[] };

export type VolumeProfileBin = { price_low: number; qty: number };
export type VolumeProfile = {
  bin_count: number; price_min: number; price_max: number; bin_width: number;
  bins: VolumeProfileBin[];
};

export type VolumeDistributionBin = {
  price_low: number;
  price_high: number;
  qty: number;
};

export type DayVolumeDistribution = {
  date: string;
  range_count: number;
  price_min: number;
  price_max: number;
  session_open_ms: number;
  session_close_ms: number;
  last_trade_ms?: number | null;
  bins: VolumeDistributionBin[];
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

/** Source name for ADR-0039 source_pref thread-through. Mirrors
 *  hoga/api/sources.py::SourceName. */
export type SourceName = 'hogaplay' | 'kis_live' | 'kis_api';

/** GET /api/orderbook response envelope. */
export type OrderbookResponse = {
  available_from: number | null;
  snapshot: OrderbookSnapshot | null;
  source: SourceName;
};

// === Broker Day-Trajectory (ADR-0023) ===
// Mirrors hoga/api/models.py::BrokerSeriesPoint / BrokerSeriesEntry / BrokerSeriesResponse
// verbatim per ADR-0004 (wire model no-adapter). `net` is already signed at the
// producer (buy = +, sell = −) — no client-side re-aggregation.

export type BrokerSeriesPoint = {
  ts_ms: number;   // Unix epoch ms per ADR-0003
  net: number;     // signed: SUM(qty_today * sign(side)) at this snapshot
};

export type BrokerSeriesEntry = {
  broker: string;
  final_net: number;
  dominant_side: 'buy' | 'sell';
  points: BrokerSeriesPoint[];   // ts_ms ascending; observed snapshots only
};

export type BrokerSeriesResponse = {
  date: string;                   // YYYYMMDD KST, echoed
  brokers: BrokerSeriesEntry[];   // sorted by abs(final_net) desc, all recorded brokers
  source: SourceName;             // ADR-0044 — echoed by backend after resolve_source()
};

export type BrokerLateEntryEvent = {
  t_ms: number;
  broker: string;
  side: 'buy' | 'sell';
  net: number;
};

// Wire shape for SSE trade events emitted by hoga/live/poller.py.
// `side` is -1 / 0 / +1 by convention (sell / auction-cross / buy) but typed
// as number — the backend does not enforce the literal, and a runtime guard
// would be more honest than a TS fiction here.
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

export type SkipReason = 'already_complete' | 'source_partial' | 'no_upstream_data';

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
  | 'kis_holiday_fetch_failed'
  | 'kis_credentials_missing'
  | 'cookie_expired'
  | 'cookie_missing'
  | 'hogaplay_http_error'
  | 'symbol_master_not_initialized'
  | 'disk_write_failed'
  | 'kis_master_fetch_failed';

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
  attempt: number;
  /** ADR-0020 invariant violations attached when a strict-mode parse failure
   *  was absorbed by a lenient-mode retry (currently: upstream cum_vol /
   *  orderbook anomalies). phase stays 'done'; UI renders a warning badge. */
  warnings?: ViolationWire[] | null;
}

/** Common header on every per-item SSE event (capture_progress / capture_phase /
 *  capture_finished). Mirrors hoga/api/models.py::_CaptureEventBase. */
export interface CaptureEventBase {
  item_id: string;
  code: string;
  date: string;
  phase: CapturePhase;
}

export type PushEvent =
  | { type: 'inventory_added'; code: string; date: string }
  | { type: 'inventory_removed'; code: string; date: string }
  | (CaptureEventBase & { type: 'capture_progress'; progress: CaptureProgress })
  | (CaptureEventBase & { type: 'capture_phase' })
  | (CaptureEventBase & {
      type: 'capture_finished';
      result: CaptureResult | null;
      error: CaptureError | null;
      skip_reason: SkipReason | null;
      warnings?: ViolationWire[] | null;
    })
  | { type: 'capture_queued'; items: QueueItem[] }
  | { type: 'capture_dismissed'; item_ids: string[] }
  | { type: 'capture_queue_paused'; reason: 'cookie_expired'; message: string }
  | { type: 'capture_queue_resumed'; reason: 'user_resume' | 'cancel_all' }
  | {
      type: 'capture_queue_drained';
      total_done: number;
      total_failed: number;
      total_cancelled: number;
      total_skipped: number;
    }
  | CaptureTimingEvent
  | { type: 'connected' }
  | { type: 'disconnected' };

/** Mirrors hoga/api/models.py::TimingPhaseTotals. All values are milliseconds. */
export interface TimingPhaseTotalsMs {
  http_fetch_ms: number;
  parse_ms: number;
  disk_write_ms: number;
  rate_limit_ms: number;
  backoff_ms: number;
  cookie_pause_ms: number;
  other_ms: number;
}

/** Mirrors hoga/api/models.py::TimingEnv. */
export interface TimingEnv {
  rate_limit_s: number;
  max_concurrent: number;
  page_step_ms_initial: number;
  hoga_version: string;
  git_sha: string | null;
}

/** Mirrors hoga/api/models.py::TimingSummary. */
export interface TimingSummary {
  code: string;
  date: string;
  started_at_kst: string;
  ended_at_kst: string;
  total_ms: number;
  phase_totals_ms: TimingPhaseTotalsMs;
  phase_percentages: Record<string, number>;
  unaccounted_ms: number;
  page_count: number;
  event_count: number;
  error_counts: Record<string, number>;
  env: TimingEnv;
}

/** Mirrors hoga/api/models.py::CaptureTimingEvent. SSE summary event emitted
 *  when one capture finishes (or fails). `id` is `${code}:${date}` — the
 *  frontend dedup key. Full per-page detail lives in the timing JSON on
 *  disk, not on this event. */
export interface CaptureTimingEvent {
  type: 'capture_timing';
  id: string;
  summary: TimingSummary;
}

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
    invalid: number;
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
  | 'invalid'          // ADR-0020 — mirrors backend; was missing from frontend before
  | 'none'
  | 'weekend'
  | 'holiday'
  | 'future'
  | 'today_locked'
  | 'no_upstream_data';

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
  reason: 'already_in_queue' | 'already_running' | 'already_complete' | 'already_skipped';
}

/** ADR-0042: a (Code, Stock-Date) rejected by the fail_streak cap. */
export interface BlockedItem {
  code: string;
  date: string;
  fail_streak: number;
  reason: 'fail_streak_exceeded';
}

/** Mirrors hoga/api/models.py::EnqueueResponse. */
export interface EnqueueResponse {
  enqueued: QueueItem[];
  deduped: EnqueueDedupedRow[];
  /** ADR-0042: pairs rejected by the fail_streak cap. Default []. */
  blocked: BlockedItem[];
}

/** Mirrors hoga/api/models.py::RetryRequest. */
export interface RetryRequest {
  item_ids: string[];   // non-empty per backend validator
}

export interface RetrySkippedRow {
  item_id: string;
  reason: 'not_found' | 'not_failed' | 'already_in_queue' | 'already_running';
}

/** Mirrors hoga/api/models.py::RetryResponse. */
export interface RetryResponse {
  enqueued: QueueItem[];
  skipped: RetrySkippedRow[];
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
  source?: SourceName;     // ADR-0037, ADR-0039; absent in legacy responses
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

/** One live snapshot frame payload (ws.ts ch:'live' data). Mirrors the
 *  LiveBuffer entry: hoga/live/buffer.py — t_ms + kind are guaranteed;
 *  per-kind fields (orderbook/trade/broker) remain open pending a
 *  per-kind wire model (deliberate follow-up). */
export interface LiveSnapshotEntry {
  t_ms: number;
  kind: 'ob' | 'trade' | 'broker';
  [field: string]: unknown;
}

/** One trading day's foreign/institution net-buy quantity. Mirrors
 *  hoga/live/kis_models.py::InvestorNetPoint. Net is signed: + = net buy,
 *  − = net sell. t_ms anchors at 09:00 KST — the same anchor as daily candles. */
export type InvestorNetPoint = { t_ms: number; foreign_net: number; institution_net: number };

export type ProgramTradePoint = {
  t: number;
  net_qty: number | null;
  net_amount: number | null;
  delta_qty?: number | null;
  delta_amount?: number | null;
  gap_risk: boolean;
};

export type ProgramTradeSeries = {
  points: ProgramTradePoint[];
  source?: 'kis_program_trade';
};

export type AskPeakCandidate = {
  price: number;
  qty: number;
  t_ms: number;
};

/** 한 거래일 최대벽 공통 필드 — 연속거래 중 단일 호가단계 최대 물량·가격.
 *  date=거래일(YYYYMMDD, segment x-구간 매핑용), t_ms=unix ms(KST, peak 발생 시점).
 *  price/qty/t_ms=버킷 종가 대표의 당일 max(#96 close 변종). max_*=버킷 틱-max의 당일 max
 *  (분봉 내 최댓값 기준, Intra-Bar Max, ADR-0076). */
export type PeakBase = {
  date: string;
  price: number;
  qty: number;
  t_ms: number;
  max_price: number;
  max_qty: number;
  max_t_ms: number;
  all_price?: number | null;
  all_qty?: number | null;
  all_t_ms?: number | null;
  all_max_price?: number | null;
  all_max_qty?: number | null;
  all_max_t_ms?: number | null;
  untraded_price?: number | null;
  untraded_qty?: number | null;
  untraded_t_ms?: number | null;
  untraded_max_price?: number | null;
  untraded_max_qty?: number | null;
  untraded_max_t_ms?: number | null;
};

/** hoga/api/models.py::AskPeak 미러. 후보 배열은 매도벽 표시용 ask-only 확장. */
export type AskPeak = PeakBase & {
  traded_peaks?: AskPeakCandidate[];
  traded_max_peaks?: AskPeakCandidate[];
  all_peaks?: AskPeakCandidate[];
};

/** hoga/api/models.py::BidPeak 미러. */
export type BidPeak = PeakBase;

export type TradeVolumePocWire = {
  date: string;
  center_price: number;
  low_price: number;
  high_price: number;
  qty: number;
  t_ms: number;
  band_pct: number;
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
  /** KIS REST program-trade sidecar. Optional in TS so older fixtures/snapshots
   *  remain readable; live backend responses include it when supported. */
  program_trade?: ProgramTradeSeries;
  volume_profile_range: VolumeProfile;
  volume_profile_by_day: VolumeProfile[];
  volume_distributions: DayVolumeDistribution[];
  /** ADR-0055: daily foreign/institution net-buy bars across the requested
   *  range (FHPTJ04160001 date-cursor walk-back).
   *  Empty on minute timeframes (KIS provides investor data for D/W/M only).
   *  Separate array (not on Candle) so minute candles never carry null. */
  investorPoints: InvestorNetPoint[];
  /** 거래일별 매도 최대벽 — 데이터 있는 각 거래일당 1개. 프론트가 각 항목을 그날 segment
   *  x-구간의 수평 세그먼트로 그린다. 오늘 항목은 클라 ratchet(useDayAskPeaks)이 live.ob로 갱신.
   *  D·W·M/무데이터 → []. */
  ask_peaks: AskPeak[];
  bid_peaks?: BidPeak[];
  /** 캔들 고저가 VI 가격대(1차: 당일 open 기준 ±10%, 2차: VI 재개봉 open 기준 ±10%)
   *  또는 상하한가(전일 close 기준 ±30%)에 닿은 최초 시점. */
  price_level_hits?: PriceLevelHit[];
  /** 거래일별 정규장 체결량 최다 가격대(연속체결 매물대 분포의 max bar와 동일한 bin). */
  trade_volume_pocs?: TradeVolumePocWire[];
  broker_late_entries: BrokerLateEntryEvent[];
};
