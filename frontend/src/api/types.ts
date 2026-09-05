import type { SectorTickEvent } from './sectorTickOverlay';
import type { SignalAlertEvent } from './signalAlerts';

// Mirrors hoga/api/models.py — keep in sync by hand.

/** Per ADR-0020 — backend `DiskState` values surfaced as a string.
 *  `none`은 inventory에 등장하지 않는다 (meta.json 없으면 행 자체가 없음). */
export type DiskStateValue = 'complete' | 'source_partial' | 'client_incomplete' | 'invalid';

/** 한 venue 의 디스크 상태 — 보관함 날짜 행의 venue 배지 하나 (ADR-0140 §7).
 *  **목록에 없는 venue 는 '없어야 정상'**(미상장)이고, 있는데 `disk_state` 가
 *  null 이면 '기대됐으나 없음'이다. 자리 유무가 그 둘을 가른다. */
export type StockDateVenue = {
  venue: string;
  disk_state: DiskStateValue | null;
  file_size_bytes: number;
};

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
  /** ADR-0093 mirror of StockDate.identical_capture_count. Consecutive completed
   *  captures that reproduced the identical result; >= 2 = confirmed upstream
   *  gap. Null on legacy meta.json. */
  identical_capture_count?: number | null;
  /** 이 `source_partial` 이 **재캡처로 나아지지 않는다**고 서버가 판정했는가
   *  (eligibility.is_terminal_partial — 워커가 `upstream_gap` 으로 건너뛰는 조건).
   *
   *  `identical_capture_count >= 2` 로 대신 계산하면 **안 된다**. 그건 확정 경로
   *  셋 중 하나(ADR-0093)일 뿐이고, 세션 경계 접촉(ADR-0126)·보유 창 밖 미확정
   *  (ADR-0131)은 여기서 재현할 수 없다 — 후자는 오늘 날짜가 있어야 풀린다. */
  upstream_gap_confirmed?: boolean;
  /** ADR-0042: consecutive failed+skipped count since last success/unblock.
   *  Joined from QueueManifest.fail_streaks at the route layer. 0 means
   *  "no recent failures"; ``>= 5`` means ``blocked``. */
  /** `kiwoom_live` 의 venue 별 상태 (ADR-0140 §7). **빈 배열 = venue 축 없는 행**
   *  (hogaplay 전용 캡처이거나 마이그레이션 전 평면 레이아웃) — 아무것도 안 그린다.
   *  행의 주 `disk_state` 는 hogaplay 것이라 이것과 별개다(커버 구간이 다르다). */
  venues?: StockDateVenue[];
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
  /** 대표 스냅샷의 10호가 사다리 폭(중간가 대비 %). 총잔량은 "고정된 가격 폭"이 아니라
   *  "고정된 호가 단계 수"로 잰 값이라, KRX 호가단위(가격대별 계단함수)가 바뀌면 같은 물량이
   *  다른 숫자로 나온다 — 경계에서 폭이 2~5배 점프한다. 급증 검출의 호가단위 보정이 이 값을
   *  쓴다(docs/research/2026-08-19-hoga-tick-band-totals-normalization.md).
   *  동시호가/완전-auction 버킷은 0. **0 은 "폭 없음"이지 "폭이 0"이 아니다** — 소비자는
   *  0 을 보정 불가로 다뤄야 한다. */
  band_pct: number;
  /** 대표 스냅샷 중간가의 KRX 호가단위(원). 급증 보정의 **트리거** — 가격의 결정론적
   *  함수라 빈 호가 잡음이 원리적으로 못 건드린다. `band_pct` 는 그 트리거를 **확인**하는
   *  용도로 함께 쓰인다(ETF 처럼 표가 틀리는 종목군에서 거부권). 0 = 모름. */
  tick: number;
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
  // 예상체결가/량(키움 0D FID 23/24) — 동시호가(단일가)에만 채워진다. 연속거래 중엔
  // 백엔드가 키를 안 실어 undefined/0 → BookPanel 이 "값>0"으로 게이트해 평시엔 숨김.
  exp_price?: number;
  exp_qty?: number;
};

/** Capture source that produced a segment. Orderflow sources mirror
 * hoga/api/sources.py::SourceName (kiwoom_live=키움 WS, ADR-0116); screener_daily is a
 * chart-only daily corpus. 표기 라벨은 api/sourceCapabilities.ts 가 소유한다.
 *
 * `kiwoom_gapfill` 도 프론트 전용이다 — 얼린 저장뷰에서 **디스크에 없는 거래일을 키움
 * 분봉으로 보충한** 날을 뜻한다(`useMinuteGapFill`). 백엔드에 같은 이름의 소스가 없는
 * 것이 정확하다: 그 봉은 캡처 저장소에 들어가지 않고 이 창의 화면에서만 산다. 별도
 * 값으로 두는 이유는 **그 날짜엔 캔들만 있고 호가 파생 지표가 없기** 때문이다 — 배지가
 * 그 사실을 말해 주지 않으면 빈 지표 pane 이 고장으로 읽힌다. */
export type SourceName = 'hogaplay' | 'kiwoom_live' | 'screener_daily' | 'kiwoom_gapfill';

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
  brokers: BrokerSeriesEntry[];   // sorted by final_net desc, all recorded brokers
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

export type SkipReason = 'already_complete' | 'source_partial' | 'no_upstream_data' | 'upstream_gap';

export interface CaptureProgress {
  pages_done: number;
  events_seen: number;
  frontier_ms: number;       // Unix epoch ms per ADR-0003
  estimate_pct: number;
  elapsed_ms: number;
  /** Rolling median wall-ms of recent first.php fetches. High with
   *  throttled_pages===0 means hogaplay itself is slow (not our backoff).
   *  Optional: absent on payloads from backends predating the field. */
  recent_http_p50_ms?: number | null;
  /** Cumulative 429-throttled fetch attempts this run. */
  throttled_pages?: number;
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
  | 'trading_days_unavailable'
  | 'trading_days_stale'
  | 'credentials_missing'
  | 'cookie_expired'
  | 'cookie_missing'
  | 'hogaplay_http_error'
  | 'symbol_master_not_initialized'
  | 'disk_write_failed'
  | 'master_fetch_failed';

/** Mirrors hoga/api/error_codes.py::LiveErrorCode verbatim (ADR-0009 3번째 카테고리).
 *
 *  `/api/live` 의 요청 문법 위반(422) · 의존성 미배선(503) · 키움 업스트림(502) 코드.
 *  2026-07-30 이전에는 이 라우터가 raw 문자열 code + `msg` 키를 쓰거나 아예 평문
 *  `detail` 문자열을 냈다. `apiCall` 은 `detail.message` 만 읽으므로 `msg` 페이로드는
 *  사람이 읽을 메시지를 잃고 `"<status> <path>"` 로 폴백했다 — 즉 `/api/live` 의 에러
 *  문구가 사용자에게 도달하지 않았다.
 *
 *  주의: HTTP 200 응답의 `data_warnings[].msg` 는 **다른 계약**이고 그대로 `msg` 다. */
export type LiveErrorCode =
  | 'invalid_code'
  | 'invalid_date'
  | 'from_after_to'
  | 'date_in_future'
  | 'date_range_too_large'
  | 'invalid_venue'
  | 'invalid_index_id'
  | 'unsupported_index'
  | 'unsupported_index_investor_net'
  | 'unsupported_bucket_ms'
  | 'no_live_data'
  | 'not_wired'
  | 'kiwoom_api_error'
  | 'kiwoom_http_error';

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
  // Today Promotion advanced a code's on-disk data (WS 푸시 승격 무효화).
  // The frontend refetches that code's today range on receipt instead of
  // waiting out the polling fallback.
  | { type: 'promotion_completed'; code: string; date: string }
  // 관심목록·히트맵 문서가 **서버에서** 바뀌었다 — 어느 창이 바꿨든 열려 있는 모든
  // 연결에 브로드캐스트된다(hoga/api/mutation_broadcast.py). 이 두 목록은 서버가
  // 진실이지만 프론트는 refetchOnWindowFocus 를 꺼 두었으므로(main.tsx), 이 신호가
  // 없으면 다른 탭·다른 브라우저는 새로고침 전까지 옛 목록을 계속 보여 준다.
  // 페이로드는 "바뀌었다" 신호뿐이고 diff 가 없다 — 수신 측은 목록 쿼리를 무효화해
  // 서버 상태를 통째로 다시 읽는다(inventory_* 와 같은 형태).
  | { type: 'watchlist_changed' }
  | { type: 'heatmap_changed' }
  // 저장된 스크리너 조건·저장뷰가 서버에서 바뀌었다 — 위 둘과 같은 브로드캐스트다.
  // ⚠ 이름을 `screener_update…` 로 짓지 말 것: subscribeToScreenerUpdateEvents 가
  // `startsWith('screener_update')` 로 거르므로, 갱신 job 진행률 소비처(드로어·칩)에
  // 저장 목록 신호가 새어 들어가 판별 유니온을 헛돌게 한다.
  | { type: 'screener_saves_changed' }
  | { type: 'study_views_changed' }
  | { type: 'live_layout_presets_changed' }
  | { type: 'study_layout_presets_changed' }
  | { type: 'screener_update_progress'; done: number; total: number }
  | { type: 'screener_update_finished'; updated: number; total: number; reason: string | null }
  // 키움 표시(온디맨드) 슬롯 만석 — 이 탭의 구독이 보류됐다(hoga/api/ws.py).
  // 등록은 보류 상태로 장부에 남아 슬롯이 반환되면 watchdog 이 자동 배정하므로,
  // 사용자에게는 "지금 실시간이 안 오는 이유 + 창을 닫으면 풀린다"만 알리면 된다.
  // 이 이벤트를 소비하지 않으면 해당 탭은 멈춘 차트만 보여 준다(무증상 실패).
  | { type: 'kiwoom_full_house'; code: string }
  // 키움 0J/0U 업종·지수 실시간 오버레이(1초 배칭·변경분만). 폴링 캐시 위에 얹히므로
  // 이 이벤트를 소비하지 않아도 화면은 30초 갱신으로 정상 동작한다 — 즉 **누락이
  // 무증상**이라, 흐르고 있는지는 /api/live/status 의 kiwoom.sector 로만 보인다.
  | SectorTickEvent
  | SignalAlertEvent
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
  /** NXT 상장 여부. `false` = 미상장, `null`/부재 = **모름**(판별 불가) — 둘을 합치면
   *  안 된다(ADR-0140 §4). 백엔드는 처음부터 이 필드를 보냈으나 이 미러가 빠뜨려
   *  프론트에서 소비가 불가능했다. 용도는 `effectiveLiveVenue` 하나다: 미상장 종목의
   *  통합(UN) 선택을 KRX 로 해석해 실시간 표면이 비지 않게 한다. */
  nxt_enabled?: boolean | null;
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
  // source_partial 의 정제 — 이 구멍은 재캡처로 채워지지 않는다고 판정된 상태
  // (ADR-0093 동일-재현 / ADR-0126 세션 경계 / ADR-0131 보유 창 밖 미확정).
  | 'source_partial_confirmed'
  | 'client_incomplete'
  | 'invalid'          // ADR-0020 — mirrors backend; was missing from frontend before
  | 'none'
  | 'weekend'
  | 'holiday'
  | 'future'
  | 'today_locked'
  | 'no_upstream_data'
  // KIS live/REST-only promotion (no hogaplay artifact for this Stock-Date).
  | 'complete_live'
  | 'partial_live';

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
  /** 성공했지만 **품질이 떨어진 채** 진행했다. 현재 유일한 값은
   *  `credentials_missing` — KIS 거래일 목록을 못 얻어 **평일 기준**으로 담았다는
   *  뜻이고, 휴장일이 섞일 수 있다. 실패가 아니라 알림이다. */
  warning?: UpstreamCode | null;
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
/** Mirrors hoga/api/models.py::GapRange — one continuous-trading data gap,
 *  in Unix ms (KST). start_ms = last snapshot before the gap; end_ms = first
 *  snapshot after it. */
export interface GapRange {
  start_ms: number;
  end_ms: number;
}

/** Mirrors hoga/api/models.py::GapRangesResponse (WS1). */
export interface GapRangesResponse {
  code: string;
  date: string;
  source: string;
  gap_ranges: GapRange[];
  /** True when the session window was too sparse (< 2 datapoints) to locate
   *  discrete ranges — is_partial then rode the count rule. */
  sparse: boolean;
  origin: 'meta' | 'computed';
}

/** Mirrors hoga/api/models.py::MissingStockDate. */
export interface MissingStockDate {
  code: string;
  date: string;
}

/** Mirrors hoga/api/models.py::CoveragePreviewResponse. 지난 N일 hogaplay 커버리지. */
export interface CoveragePreviewResponse {
  dates: string[];
  codes: number;
  total: number;
  have: number;
  no_upstream: number;
  to_collect: number;
  est_minutes: number;
  missing: MissingStockDate[];
}

/** Mirrors hoga/api/models.py::BulkEnqueueResponse. */
export interface BulkEnqueueResponse {
  enqueued: number;
  deduped: number;
  blocked: number;
  failed: number;
  codes: number;
}

export interface QueueSnapshot {
  active: QueueItem[];
  queued: QueueItem[];
  done: QueueItem[];
  paused: boolean;
  max_concurrent: number;
  /** ADR-0094: false when another backend instance owns the capture queue for
   *  this data dir — queue mutations return 503. Optional for wire back-compat. */
  queue_owned?: boolean;
}

// === RangeBundle (ADR-0013) ===

export type RangeSegment = {
  date: string;            // YYYYMMDD KST
  session_open_ms: number; // Unix ms
  session_close_ms: number;
  source?: SourceName;     // ADR-0037, ADR-0039; absent in legacy responses
  /** 이 세그먼트를 그린 소스의 정규장 결손 총량(ms).
   *
   *  ⚠ `null`/`undefined`(정보 없음)와 `0`(결손 없음)은 **다르다**. `?? 0` 으로 합치면
   *  정보가 없는 상태가 "완전함" 으로 둔갑해 배지가 조용해진다 — 이 리포가 이미 겪은
   *  계약 드리프트 패턴이다(#1183). 판단하는 쪽이 셋을 각각 다뤄야 한다. */
  gap_ms?: number | null;
};

export type Timeframe = '1m' | '3m' | '5m' | '10m' | '15m' | '30m' | '60m' | '120m' | '240m';

export const TIMEFRAME_TO_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '60m': 3_600_000,
  '120m': 7_200_000,
  '240m': 14_400_000,
};

export const TIMEFRAME_LABELS: ReadonlyArray<Timeframe> = [
  '1m', '3m', '5m', '10m', '15m', '30m', '60m', '120m', '240m',
];

/** ADR-0020: per-Stock-Date invariant outcome surfaced on the wire. */
export type ViolationWire = {
  invariant_id: string;
  severity: 'error' | 'warn';
  message: string;
  ctx: Record<string, unknown>;
};

export type RangeExcludedDate = {
  date: string;
  violations: ViolationWire[];
};

export type RangeDateWarning = {
  date: string;
  warnings: ViolationWire[];
};

/** 읽을 데이터가 **없어서** 빠진 거래일 + 사유 (#1133).
 *
 * `RangeExcludedDate` 와 다른 것이다 — 저쪽은 데이터가 있는데 불변식을 어겨 버린 날,
 * 이쪽은 애초에 없는 날이다. 이 구분이 UI 문구를 가른다("문제가 있다" vs "원래 없다").
 *
 * venue 축이 이 필드를 필요하게 만들었다: NXT·통합은 `kiwoom_live` 가 저장을 시작한
 * 날부터만 존재하므로 그 이전 구간은 **정상적으로** 빈다. 사유가 없으면 프론트는 빈
 * 배열을 장애와 구별할 수 없어 아무 설명 없는 빈 pane 을 그린다. */
/** Mirrors `hoga/api/models.py::MissingDateReason` (ADR-0004 — 손 미러).
 *
 *  `no_upstream_data`(업스트림이 그날을 영구히 못 준다)와 `not_captured`(캡처하면
 *  채워진다)는 **사용자의 선택지가 다르므로** 값이 갈려 있다 — 소비처가 이 둘을 같게
 *  말하면 되는 일과 안 되는 일이 화면에서 구별되지 않는다.
 *
 *  **이름을 백엔드와 같게 둔 것이 load-bearing 이다.** 필드 인라인 union 이면
 *  `WIRE_ENUM_MIRRORS` 의 파서가 원리적으로 못 찾아 값 드리프트가 무증상이 된다(#1183).
 *
 *  `| string` 은 방어적으로 남긴다: 백엔드가 값을 늘렸는데 프론트 번들이 옛것인 배포
 *  스큐에서도 렌더가 깨지지 않아야 한다(소비처는 일반 문구로 폴백). 대조 파서는 따옴표
 *  없는 `string` 을 세지 않으므로 이 폴백이 미러 검사를 무디게 하지 않는다. */
export type MissingDateReason =
  | 'venue_unsupported'
  | 'source_missing'
  | 'stock_date_missing'
  | 'meta_unreadable'
  | 'no_upstream_data'
  | 'not_captured'
  | string;

export type RangeMissingDate = {
  date: string;
  reason: MissingDateReason;
};

/** One live snapshot frame payload (ws.ts ch:'live' data). Mirrors the
 *  LiveBuffer entry: hoga/live/buffer.py — t_ms + kind are guaranteed;
 *  per-kind fields (orderbook/trade/broker) remain open pending a
 *  per-kind wire model (deliberate follow-up). */
export interface LiveSnapshotEntry {
  t_ms: number;
  kind: 'ob' | 'trade' | 'broker' | 'program';
  [field: string]: unknown;
}

/** One trading day's foreign/institution net-buy quantity. Mirrors
 *  hoga/live/kis_models.py::InvestorNetPoint. Net is signed: + = net buy,
 *  − = net sell. t_ms anchors at 09:00 KST — the same anchor as daily candles. */
/** 값의 단위는 **응답의 unit 필드가 정한다** (#1119) — 종목 경로는 qty_shares(주),
 * 지수 경로는 amt_eok(억원). 같은 모양이라 타입은 하나지만 물리량이 다르다. */
export type InvestorNetPoint = {
  t_ms: number;
  foreign_net: number;
  institution_net: number;
  /** 주체 분해 — **종목 경로만** 채운다(`ka10059`). 지수/시장 경로(`ka10051`)는
   *  분해 자체가 없어 `null` 이다. `null`(경로에 없음)과 0(그날 순매수 0)은 다른
   *  뜻이라 백엔드가 `exclude_none` 을 걸지 않는다. **옵셔널인 이유는 버전 스큐**다 —
   *  이 필드를 싣기 전의 백엔드를 타면 키가 아예 없다(워크트리 프론트가 사용자
   *  dev 서버를 프록시로 타는 구성이 그렇다). */
  breakdown?: InvestorSubjectBreakdown | null;
};

/** `hoga/live/investor.py::InvestorSubjectBreakdown` 손 미러(ADR-0004).
 *
 *  단위는 부모 `InvestorNetPoint` 를 따른다 — 종목 경로뿐이라 실제로는 늘 주(株).
 *
 *  ⚠ `native_foreign` 은 부모의 `foreign_net` 에 **이미 합산돼 있다**(KIS 정의).
 *  표시용 세부이지 상위 합계에 다시 더할 값이 아니다.
 *
 *  기관 세부 8종(`fin_invest`~`nation`)의 합은 `institution_net` 과 정확히 같다 —
 *  백엔드가 행마다 검사하고 어긋나면 data_warnings 로 알린다. */
export type InvestorSubjectBreakdown = {
  individual: number;
  native_foreign: number;
  other_corp: number;
  fin_invest: number;
  insurance: number;
  trust: number;
  other_fin: number;
  bank: number;
  pension: number;
  private_fund: number;
  nation: number;
};
/** `hoga/live/investor.py::InvestorNetUnit` 손 미러(ADR-0004 · WIRE_ENUM_MIRRORS).
 *
 *  `qty_shares` 주 · `amt_mwon` 백만원(종목 금액 축) · `amt_eok` 억원(지수 경로).
 *  **표시는 응답의 이 값으로 고른다** — 저장된 토글로 고르면 축을 바꾼 직후
 *  옛 축의 값을 새 단위로 그린다(#1119 부류, 100배 오독). */
export type InvestorNetUnit = 'qty_shares' | 'amt_mwon' | 'amt_eok';

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
  price: number | null;
  qty: number | null;
  t_ms: number | null;
  max_price: number | null;
  max_qty: number | null;
  max_t_ms: number | null;
  all_price?: number | null;
  all_qty?: number | null;
  all_t_ms?: number | null;
  all_max_price?: number | null;
  all_max_qty?: number | null;
  all_max_t_ms?: number | null;
  /** 미도달 벽(당일 극값이 지배하지 못한 벽) rank-1 — **cont 단일 계열**이라 close/max
   *  구분이 없다(백엔드 AskPeakDualRow 주석). None = 구 캐시·legacy payload. */
  unreached_price?: number | null;
  unreached_qty?: number | null;
  unreached_t_ms?: number | null;
};

/** hoga/api/models.py::AskPeak 미러. 후보 배열은 매도벽 표시용 ask-only 확장. */
export type AskPeak = PeakBase & {
  traded_peaks?: AskPeakCandidate[];
  traded_max_peaks?: AskPeakCandidate[];
  /** 기록 갱신 시퀀스(시간순 prefix maxima, ≤128) — 최대벽 강도 pane 의 "그 시점까지
   *  체결된 벽 중 최대" 복원용. traded_*(최종 크기순 top-3)와 축이 다르다. 봉 무관.
   *  구백엔드 부재 → optional. */
  traded_record_peaks?: AskPeakCandidate[];
  traded_record_max_peaks?: AskPeakCandidate[];
  /** 봉별 최대 체결 벽 — 봉마다 "그 봉에서 가장 크게 체결된 벽" 하나(시간순, 상한 없음).
   *  최대벽 강도 pane 의 **봉별 모드** 입력이고 traded_record_*(누적 계단)와 같은
   *  데이터의 다른 축이다. ⚠ **항상 1분 해상도**로 온다 — 굵은 봉은 프론트가 캔들 봉에
   *  접는다(`buildPeakWallBarPoints`). ⚠ **옵트인**이라 `bar_peaks_enabled=true` 로
   *  요청한 창에만 실린다(페이로드가 자릿수로 커진다). 구백엔드 부재 → optional. */
  traded_bar_peaks?: AskPeakCandidate[];
  traded_bar_max_peaks?: AskPeakCandidate[];
  all_peaks?: AskPeakCandidate[];
  all_max_peaks?: AskPeakCandidate[];
  /** 미도달 벽 top-3 — all_peaks 와 달리 /api/range 에서 벗기지 않는다(최대 3개). */
  unreached_peaks?: AskPeakCandidate[];
};

/** hoga/api/models.py::BidPeak mirror. Candidate arrays mirror ask for cutoff/ranking. */
export type BidPeak = PeakBase & {
  traded_peaks?: AskPeakCandidate[];
  traded_max_peaks?: AskPeakCandidate[];
  /** ask 쪽 주석 참조 — 동일 규약 미러. */
  traded_record_peaks?: AskPeakCandidate[];
  traded_record_max_peaks?: AskPeakCandidate[];
  /** ask 쪽 주석 참조 — 동일 규약 미러. */
  traded_bar_peaks?: AskPeakCandidate[];
  traded_bar_max_peaks?: AskPeakCandidate[];
  all_peaks?: AskPeakCandidate[];
  all_max_peaks?: AskPeakCandidate[];
  /** ask 쪽 주석 참조 — 동일 규약 미러. */
  unreached_peaks?: AskPeakCandidate[];
};

export type TradeVolumePocWire = {
  date: string;
  center_price: number;
  low_price: number;
  high_price: number;
  qty: number;
  t_ms: number;
  band_pct: number;
};

export type DepthHeatmapPointWire = {
  t_ms: number;
  asks: [number, number][];
  bids: [number, number][];
  asks_max?: [number, number][];
  bids_max?: [number, number][];
  /** 가격대마다 따로 잰 최댓값 — `asks_max`(총잔량 최대 **순간의 사진**)와 축이 다르다.
   *  길이가 10 고정이 아니고(그 버킷에 등장한 distinct 가격 수), 세로로 읽으면 실제로
   *  동시에 존재한 적 없는 호가창이다. 대신 각 셀이 「당일 최대벽」과 같은 값이다. */
  asks_price_max?: [number, number][];
  bids_price_max?: [number, number][];
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
  /** 이 (code, source, venue) 의 **가장 오래된 캡처 거래일**(YYYYMMDD) — 없으면 null.
   *
   *  디스크 모드(hogaplay 우회) 분봉 좌팬의 **바닥**이다. 벤더 모드에는 250일 벽이
   *  있지만 디스크 모드의 끝은 벽이 아니라 캡처 유무이고, 프론트는 그걸 알 방법이
   *  없었다 — 그래서 캡처 시작 이전으로 무한히 팬해 **빈 화면 + 「과거 불러오는 중」이
   *  계속** 뜨는 상태가 됐다(2026-08-26 신고: 028050 은 26-01-06 부터인데 창이
   *  25-11-17 까지 갔다). 구백엔드는 부재 → optional. */
  earliest_captured_date?: string | null;
  /** ADR-0020 invariant outcomes surfaced by hoga/api/models.py::RangeBundle. */
  excluded_dates?: RangeExcludedDate[];
  data_warnings?: RangeDateWarning[];
  /** 읽을 것이 없어 빠진 거래일 + 사유 (#1133). 구백엔드는 부재 → optional. */
  missing_dates?: RangeMissingDate[];
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
  /** 버킷별 10호가 잔량 스냅샷(호가 잔량 히트맵). 각 포인트는 t_ms 버킷 하나의
   *  매도/매수 [price, qty] 최대 10단계. 멀티데이 병합은 t_ms 단위 latest-wins. */
  depth_heatmap?: DepthHeatmapPointWire[];
  broker_late_entries: BrokerLateEntryEvent[];
};
