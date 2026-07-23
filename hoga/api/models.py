"""API response container models. Per-entity models live in their table
module (``hoga/tables/{trades,snapshots,brokers,candles}.py``).
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Annotated, Any, Literal, Union
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, field_validator, model_validator

from hoga.api.error_codes import UpstreamCode
from hoga.api.params import CODE_PATTERN
from hoga.api.sources import SourceName
from hoga.tables.candles import ApiCandle
from hoga.tables.snapshots import ApiOrderbookSnapshot


class StockDate(BaseModel):
    """Inventory entry: one captured Stock-Date with its boundaries.

    All time fields are Unix epoch ms (UTC) per ADR 0003 — the on-disk
    HHMMSSmmm encoding is converted at the API boundary.
    """

    date: str
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    data_window_first_ms: int
    data_window_last_ms: int
    # Frontend spec §4.4 — inventory card fields:
    price_min: int
    price_max: int
    captured_at: int  # Unix ms of latest mtime in the Stock-Date dir
    total_volume: int
    pages_collected: int
    file_size_bytes: int
    today_open: int
    today_high: int
    today_low: int
    today_close: int
    collection_complete: bool
    is_partial: bool
    # ADR-0020: the primary state string. Use this in new code; the two
    # boolean bits above remain for backward compatibility but cannot
    # represent INVALID (they collapse it to {complete=True, partial=False},
    # which makes the corrupted Stock-Date invisible to UIs that only read
    # the booleans). Values: "complete", "source_partial", "client_incomplete",
    # "invalid". DiskState.NONE never appears here (no meta.json means no row).
    disk_state: str = "complete"
    full_capture_count: int | None = None
    """Number of successful Full Captures for this Stock-Date (initial + Retry-driven
    overwrites of meta.json). Null on legacy meta files written before this counter
    was introduced. See CONTEXT.md "Full Capture Count" and ADR-0031 for the
    distinction from QueueItem.attempt."""
    identical_capture_count: int | None = None
    """ADR-0093: consecutive completed captures that reproduced the identical
    result (fingerprint = total_unique_events + pages_collected + gap_ranges).
    ``>= 2`` marks a confirmed upstream gap — the worker skips it (upstream_gap)
    and the inventory drawer surfaces it + offers a force-recapture. Null on
    legacy meta written before this counter."""
    fail_streak: int = 0
    """ADR-0042: consecutive failed+skipped count since last success/unblock.
    Joined from QueueManifest.fail_streaks at the route layer. 0 means
    "no recent failures". When ``>= 5`` the row is also ``blocked``."""
    blocked: bool = False
    """ADR-0042: ``fail_streak >= 5``. Renders a 차단됨 badge + 잠금 해제
    button on the inventory row; enqueue requests for this (Code, Stock-Date)
    are rejected with HTTP 409 until the user clears the counter."""


class OrderbookResponse(BaseModel):
    available_from: int | None = None
    snapshot: ApiOrderbookSnapshot | None
    source: SourceName


class CandlesResponse(BaseModel):
    candles: list[ApiCandle]


class Meta(BaseModel):
    code: str
    name: str
    regular_session_open_ms: int
    regular_session_close_ms: int
    prev_close: int
    upper_limit: int
    lower_limit: int
    today_open: int
    today_high: int
    today_low: int
    today_close: int
    pages_collected: int
    total_unique_events: int
    parser_version: str


class GapRange(BaseModel):
    """One continuous-trading data gap, in Unix ms (KST) at the API boundary.

    ``start_ms`` = last snapshot before the gap; ``end_ms`` = first snapshot
    after it. On disk (meta.json) these are stored in HHMMSSmmm (HogaMs); the
    ``/gaps`` route converts to Unix ms so the frontend shares the chart's
    coordinate system.
    """
    start_ms: int
    end_ms: int


class GapRangesResponse(BaseModel):
    """WS1: continuous-trading gap boundaries for one (code, date, source).

    Powers the inventory drawer's "업스트림 결손 N구간" panel — a ``source_partial``
    Stock-Date whose collection completed still has these gaps, which means the
    upstream archive is missing them (re-capture won't recover them).
    """
    code: str
    date: str
    source: str
    gap_ranges: list[GapRange]
    # True when the in-session window had < 2 datapoints — too sparse to prove
    # completeness, so is_partial rode the count rule and no ranges exist.
    sparse: bool
    # "meta" when read from the parser-written gap_ranges field; "computed" when
    # recomputed from snapshots.parquet for legacy meta lacking the field.
    origin: Literal["meta", "computed"]


class AskPeakCandidate(BaseModel):
    price: int
    qty: int
    t_ms: int


class AskPeak(BaseModel):
    """한 거래일 연속거래 중 단일 매도 호가단계 최대 물량·가격(Day Ask Peak).

    ``date``는 이 peak이 속한 거래일(YYYYMMDD) — 프론트가 segment x-구간에 매핑.
    ``t_ms``는 unix ms(KST), 캔들 시각과 동일 좌표계(peak 발생 시점).

    ``price``/``qty``/``t_ms`` = 체결가격 기준 버킷 종가 대표 위에서의 당일 max.
    ``max_*`` = 체결가격 기준 버킷 틱-max 위에서의 당일 max(Intra-Bar Max, ADR-0076).
    ``all_*`` = 모든 eligible ask price 기준. None이면 legacy payload.
    ``all_peaks``/``all_max_peaks`` 전체 랭킹 배열은 /api/range 응답에서 비워진다
    (bundle._without_all_peak_rankings — 하루당 수천 후보로 페이로드의 99%인데
    range 소비처 미사용). 전체 랭킹은 라이브 ``ask_peak_today`` 경로 전용.
    ``traded_*`` arrays = post-touch ranked wire; single ``price``/``max_price`` remain
    the legacy rank-1 compatibility fields.
    ``untraded_*`` = post-untouched legacy rank-1 wire. ``untraded_*_peaks`` carries
    the full ranked candidates array.
    """
    date: str
    price: int | None
    qty: int | None
    t_ms: int | None
    max_price: int | None
    max_qty: int | None
    max_t_ms: int | None
    all_price: int | None = None
    all_qty: int | None = None
    all_t_ms: int | None = None
    all_max_price: int | None = None
    all_max_qty: int | None = None
    all_max_t_ms: int | None = None
    untraded_price: int | None = None
    untraded_qty: int | None = None
    untraded_t_ms: int | None = None
    untraded_max_price: int | None = None
    untraded_max_qty: int | None = None
    untraded_max_t_ms: int | None = None
    traded_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    traded_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    all_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    all_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    untraded_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    untraded_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)


class BidPeak(BaseModel):
    """한 거래일 연속거래 중 단일 매수 호가단계 최대 물량·가격(Day Bid Peak).

    Mirrors ``AskPeak`` on the bid side. ``traded_*`` arrays are the post-touch
    ranked wire, while single ``price``/``max_price`` stay as legacy rank-1
    compatibility fields. ``untraded_*`` fields are the post-untouched legacy
    rank-1 wire, and ``untraded_*_peaks`` carries the full ranked candidates
    array.
    """

    date: str
    price: int | None
    qty: int | None
    t_ms: int | None
    max_price: int | None
    max_qty: int | None
    max_t_ms: int | None
    all_price: int | None = None
    all_qty: int | None = None
    all_t_ms: int | None = None
    all_max_price: int | None = None
    all_max_qty: int | None = None
    all_max_t_ms: int | None = None
    untraded_price: int | None = None
    untraded_qty: int | None = None
    untraded_t_ms: int | None = None
    untraded_max_price: int | None = None
    untraded_max_qty: int | None = None
    untraded_max_t_ms: int | None = None
    traded_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    traded_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    all_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    all_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    untraded_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    untraded_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)


class QuoteRatioPoint(BaseModel):
    t: int          # Unix ms
    bid_total: int
    ask_total: int
    # Intra-Bar Max (ADR-0076) — 종가 옆에 항상 동봉(순수 렌더 스위치; mode= 파라미터 없음).
    bid_max: int        # 버킷 내 매수 총잔량 독립 최댓값
    ask_max: int        # 버킷 내 매도 총잔량 독립 최댓값
    imb_max_bid: int    # |imbalance| 최대 스냅샷의 bid_total
    imb_max_ask: int    # |imbalance| 최대 스냅샷의 ask_total


class QuoteRatio(BaseModel):
    bucket_ms: int
    points: list[QuoteRatioPoint]


class VolumeProfileBin(BaseModel):
    price_low: int
    qty: int


class VolumeProfile(BaseModel):
    bin_count: int
    price_min: int
    price_max: int
    bin_width: int
    bins: list[VolumeProfileBin]


class FillStrengthPoint(BaseModel):
    t: int
    buy_qty: int
    sell_qty: int


class FillStrength(BaseModel):
    bucket_ms: int
    points: list[FillStrengthPoint]


class ProgramTradePoint(BaseModel):
    t: int
    net_qty: int | None
    net_amount: int | None
    delta_qty: int | None
    delta_amount: int | None
    gap_risk: bool = False


class ProgramTradeSeries(BaseModel):
    points: list[ProgramTradePoint] = Field(default_factory=list)
    source: Literal["kis_program_trade"] = "kis_program_trade"


CapturePhase = Literal[
    "queued", "deciding", "capturing", "parsing",
    "done", "failed", "cancelled", "skipped",
]
# ADR-0093 adds "upstream_gap": a confirmed upstream data gap (a full re-capture
# reproduced the identical gappy result) — skipped so we stop hammering hogaplay
# for data it doesn't have. force_retry bypasses it.
SkipReason = Literal["already_complete", "source_partial", "no_upstream_data", "upstream_gap"]


class CaptureProgress(BaseModel):
    pages_done: int
    events_seen: int
    frontier_ms: int  # Unix epoch ms per ADR-0003 (converted from HHMMSSmmm)
    estimate_pct: int  # 0..98 — backend-computed (see spec §5.5)
    elapsed_ms: int
    # Upstream-health telemetry (mirrors collector ProgressEvent): rolling
    # median wall-ms of recent first.php fetches + cumulative 429 count.
    # High p50 with zero 429s = hogaplay itself is slow (not our backoff).
    # Defaults keep restored manifests and legacy emitters parseable.
    recent_http_p50_ms: float | None = None
    throttled_pages: int = 0


class CaptureResult(BaseModel):
    """Mirrors hoga.collector.orchestrator.CollectResult, plus parse outcome."""

    pages_written: int
    unique_events: int
    raw_dir: str  # absolute path as string
    parsed: bool  # True when capture_only=false and parse succeeded
    # "stagnation_abort" when the page step loop exited via the stagnation
    # guard; None on normal completion. Surfaces to the frontend so the
    # capture row can flag partial data instead of rendering as done.
    abort_reason: str | None = None


class CaptureError(BaseModel):
    code: str  # see spec §4.1 error mapping table
    message: str
    at_page: int | None = None


class QueueItem(BaseModel):
    """Wire model for one item in the capture queue. Mirrors backend state."""

    item_id: str
    code: str
    date: str
    phase: CapturePhase
    force_retry: bool          # legacy wire field; retry policy no longer branches on it
    pause_origin: bool         # True when cancelled by cookie-expired pool pause
    enqueued_at_ms: int
    started_at_ms: int | None = None
    progress: CaptureProgress | None = None
    result: CaptureResult | None = None
    error: CaptureError | None = None
    skip_reason: SkipReason | None = None
    attempt: int = 1  # 1 = first try; Retry-enqueued items carry prior + 1 (ADR-0031)
    # ADR-0020 invariant violations surfaced inline. Populated when strict-mode
    # parse rejected the data but lenient-mode retry succeeded (currently:
    # upstream cum_vol/orderbook anomalies). phase stays 'done'; the UI renders
    # a non-fatal warning badge. None when no warnings; empty list is reserved
    # so the field type stays stable across mirror.
    warnings: list[ViolationModel] | None = None



# SSE event Wire Models — same ADR-0004 rule applies to events as to HTTP responses:
# the schema is declared once here and shipped verbatim to consumers. Frontend
# types.ts hand-mirrors these BY HAND — per ADR-0004 there is no codegen, so the
# TypeScript compiler has no visibility into this file: a field rename here
# compiles clean on both sides and surfaces as runtime `undefined` in the browser.
# Keep types.ts in sync by hand when editing these models.
#
# Each subclass carries its own `type` Literal so pydantic serializes the
# discriminator automatically — class name is the source of truth, no manual
# string juggling.


class _CaptureEventBase(BaseModel):
    item_id: str
    code: str
    date: str
    phase: CapturePhase


class CaptureProgressEvent(_CaptureEventBase):
    type: Literal["capture_progress"] = "capture_progress"
    progress: CaptureProgress


class CapturePhaseEvent(_CaptureEventBase):
    """Phase transition without progress payload (e.g. capturing → parsing)."""

    type: Literal["capture_phase"] = "capture_phase"


class CaptureFinishedEvent(_CaptureEventBase):
    """Terminal event. `phase` is one of done | failed | cancelled | skipped."""

    type: Literal["capture_finished"] = "capture_finished"
    result: CaptureResult | None = None
    error: CaptureError | None = None
    skip_reason: SkipReason | None = None  # set when phase == "skipped"
    # Mirrors QueueItem.warnings — same ADR-0020 invariant outcomes, exposed on
    # the SSE terminal event so subscribers don't need a follow-up snapshot poll
    # to discover that a 'done' capture carries warnings.
    warnings: list[ViolationModel] | None = None


# --- Queue-level SSE events (Plan B) ----------------------------------------


class CaptureQueuedEvent(BaseModel):
    type: Literal["capture_queued"] = "capture_queued"
    items: list[QueueItem]


class CaptureQueuePausedEvent(BaseModel):
    type: Literal["capture_queue_paused"] = "capture_queue_paused"
    reason: Literal["cookie_expired"]
    message: str


class CaptureQueueResumedEvent(BaseModel):
    type: Literal["capture_queue_resumed"] = "capture_queue_resumed"
    reason: Literal["user_resume", "cancel_all"] = "user_resume"


class CaptureQueueDrainedEvent(BaseModel):
    type: Literal["capture_queue_drained"] = "capture_queue_drained"
    total_done: int
    total_failed: int
    total_cancelled: int
    total_skipped: int


class CaptureDismissedEvent(BaseModel):
    """Tells the frontend to drop these item_ids from any bucket. Emitted by
    the Retry flow when the old failed row is removed from `_done` before
    the new attempt is enqueued. See ADR-0031.
    """

    type: Literal["capture_dismissed"] = "capture_dismissed"
    item_ids: list[str]


class QueueSnapshot(BaseModel):
    """Wire model for the full queue/worker state at one moment in time."""

    active: list[QueueItem]
    queued: list[QueueItem]
    done: list[QueueItem]
    paused: bool
    max_concurrent: int
    # ADR-0094: False when another backend instance owns the capture queue for
    # this data dir — mutations return 503 and the frontend shows a banner.
    # Defaulted so older wire consumers and tests that build snapshots by hand
    # stay valid.
    queue_owned: bool = True


class QueueManifestItem(BaseModel):
    """On-disk representation of one queue item. Persistence-only — never
    returned by API endpoints. Fields are the minimum needed to reconstruct
    a QueueItemState on restart: phase is always 'queued' on restore (see
    spec §4.2 and ADR-0019).
    """

    item_id: str
    code: str
    date: str
    force_retry: bool
    enqueued_at_ms: int
    pause_origin: bool
    attempt: int = 1  # ADR-0031: additive, schema_version unchanged


class QueueManifest(BaseModel):
    """On-disk capture-queue manifest. Written to ``<data_dir>/.queue.json``
    on every queue mutation. Loaded once at lifespan startup to restore the
    queue (ADR-0019).
    """

    schema_version: int = 1
    paused: bool
    items: list[QueueManifestItem]
    fail_streaks: dict[str, int] = Field(default_factory=dict)
    """Per-(Code, Stock-Date) consecutive failed+skipped counter (ADR-0042).

    Key format ``"{code}|{date}"``. Missing key means 0. Reset to 0 on
    ``phase == done`` or on ``unblock`` action. Old manifests without this
    key load as empty dict — no migration script.
    """


# --- POST /api/captures/items request/response (Plan B Task 7) --------------


class EnqueueRequest(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    start_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    end_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    dates: list[str] | None = None       # alternative to start/end
    force_retry: bool = False


class EnqueueDedupedRow(BaseModel):
    code: str
    date: str
    reason: Literal[
        "already_in_queue",
        "already_running",
        "already_complete",  # ADR-0033 — addItems collided with _done(phase=done)
        "already_skipped",   # Legacy value; skipped rows are now re-enqueueable.
    ]


class BlockedItem(BaseModel):
    """A (Code, Stock-Date) rejected by the fail_streak cap (ADR-0042).

    Reported on ``EnqueueResponse.blocked`` and rendered inline in CaptureForm.
    User must click "잠금 해제" in inventory to clear the counter before this
    (Code, Stock-Date) can be enqueued again.
    """

    code: str
    date: str
    fail_streak: int
    reason: Literal["fail_streak_exceeded"]


class EnqueueResponse(BaseModel):
    enqueued: list[QueueItem]
    deduped: list[EnqueueDedupedRow]
    blocked: list[BlockedItem] = Field(default_factory=list)


# --- 다종목 지난 N일 수집: coverage-preview + bulk-items (히트맵/스크리너 공용) ---


class CoveragePreviewRequest(BaseModel):
    """여러 종목의 지난 N거래일 hogaplay 커버리지 미리보기 요청.

    ``lookback_days`` 또는 명시적 ``start_date``+``end_date`` 중 하나. lookback 이면
    오늘(KST)로 끝나는 최근 N거래일(오늘이 16:30 전이면 제외)을 캘린더로 전개한다."""
    codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]] = Field(min_length=1)
    lookback_days: int | None = Field(default=None, ge=1, le=120)
    start_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    end_date: str | None = Field(default=None, pattern=r"^\d{8}$")


class MissingStockDate(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    date: str = Field(pattern=r"^\d{8}$")


class CoveragePreviewResponse(BaseModel):
    """(codes × 거래일) 디스크 커버리지 요약. ``missing`` = 수집 대상(code,date) —
    bulk-items 가 정확히 이것만 적재한다(이미 보유/상류무데이터는 제외)."""
    dates: list[str]                    # 창의 거래일(YYYYMMDD)
    codes: int
    total: int                          # codes × dates
    have: int                           # COMPLETE (이미 보유)
    no_upstream: int                    # NO_UPSTREAM_DATA (상류 무데이터, 재시도 제외)
    to_collect: int                     # 수집 대상 수(= len(missing))
    est_minutes: int                    # 대략적 예상 소요(분)
    missing: list[MissingStockDate]


class BulkEnqueueItem(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    dates: list[str] = Field(min_length=1)


class BulkEnqueueRequest(BaseModel):
    """정확히 (code, dates) 목록을 적재. coverage-preview.missing 를 그대로 넘긴다."""
    items: list[BulkEnqueueItem] = Field(min_length=1)


class BulkEnqueueResponse(BaseModel):
    enqueued: int
    deduped: int
    blocked: int
    failed: int = 0        # 코드별 enqueue 가 raise 한 수(부분 적재는 유지됨)
    codes: int


# --- POST /api/captures/items/retry request/response (ADR-0031) ------------


class RetryRequest(BaseModel):
    """Bulk Retry payload. Single-row ↻ sends a one-element list."""

    item_ids: list[str] = Field(min_length=1)


class RetrySkippedRow(BaseModel):
    """One item_id that did not produce a Retry enqueue and why."""

    item_id: str
    reason: Literal["not_found", "not_failed", "already_in_queue", "already_running"]


class RetryResponse(BaseModel):
    """Mirrors EnqueueResponse shape (enqueued + diagnostic list)."""

    enqueued: list[QueueItem]
    skipped: list[RetrySkippedRow]


# --- Sibling-endpoint wire models (Tasks 16–17) -----------------------------


class SymbolHit(BaseModel):
    code: str
    name: str
    market: Literal["KOSPI", "KOSDAQ"]
    security_type: Literal["stock", "etf", "etn"] = "stock"
    captured_count: int                 # complete only — headline number (spec §11 Q18)
    captured_breakdown: dict[str, int]  # {"complete": N, "source_partial": M, "client_incomplete": K, "invalid": J}


class SymbolsAllResponse(BaseModel):
    symbols: list[SymbolHit]
    status: Literal["fresh", "loading", "stale", "unavailable"]
    fetched_at_ms: int | None
    reason: UpstreamCode | None = None


class SymbolMasterInfo(BaseModel):
    """Lightweight metadata for the Settings page — no entries payload."""
    count: int
    fetched_at_ms: int | None
    status: Literal["loading", "fresh", "stale", "unavailable"]
    reason: UpstreamCode | None = None


CalendarStatus = Literal[
    "complete", "source_partial", "client_incomplete", "invalid", "none",
    "weekend", "holiday", "future", "today_locked",
    "no_upstream_data",   # ADR-0021
    # KIS live/REST-only promotion (no hogaplay artifact for this Stock-Date).
    # Distinct from "complete"/"source_partial" so the cell signals "WS data
    # present, hogaplay not collected" and stays a hogaplay collection target.
    "complete_live", "partial_live",
]


class CalendarCell(BaseModel):
    date: str
    status: CalendarStatus
    captured_at_ms: int | None = None


class CalendarResponse(BaseModel):
    cells: list[CalendarCell]
    as_of_ms: int                       # server wall-clock when cells were read (spec §11 Q21)
    reason: UpstreamCode | None = None


# === RangeBundle (ADR-0013) — multi-Stock-Date read-path Wire Model ===

ALLOWED_TIMEFRAME_MS: tuple[int, ...] = (
    60_000,      # 1m
    180_000,     # 3m
    300_000,     # 5m
    600_000,     # 10m
    900_000,     # 15m
    1_800_000,   # 30m
)


def validate_bucket_ms(value: int) -> int:
    """Whitelist-validate a Timeframe bucket_ms (ADR-0014). Raise ValueError otherwise."""
    if value not in ALLOWED_TIMEFRAME_MS:
        raise ValueError(
            f"bucket_ms must be one of {ALLOWED_TIMEFRAME_MS}, got {value}"
        )
    return value


class RangeSegment(BaseModel):
    """One captured Stock-Date inside a Stock-Date Range.

    The frontend stitches these onto a virtual axis (see util/time.ts).
    """

    date: str
    session_open_ms: int
    session_close_ms: int
    source: str = "hogaplay"  # ADR-0039: which source subdir this segment came from


class ViolationModel(BaseModel):
    """Wire-shape mirror of :class:`hoga.api.invariants.Violation` (ADR-0020).

    The invariants module deliberately stays free of the Pydantic dep — its
    ``Violation`` is a plain ``@dataclass(frozen=True)``. This model is the
    serialization surface for it; the dataclass exposes ``to_model()`` to
    cross the boundary. Having a typed wire model (rather than ``list[dict]``)
    means downstream contracts catch breaking field changes at type-check
    time, and the OpenAPI schema documents the shape.
    """
    invariant_id: str
    severity: str    # 'error' | 'warn' — kept as str so non-Python clients
                     # don't need the enum definition; Severity in the Python
                     # domain enforces the closed set.
    message: str
    ctx: dict


class ExcludedDate(BaseModel):
    """A Stock-Date that build_range_bundle skipped due to error-severity
    invariant violations (ADR-0020). Surfaced so the UI can explain the gap.
    """
    date: str
    violations: list[ViolationModel]


class DateWarning(BaseModel):
    """A Stock-Date that was included in the bundle but tripped warn-severity
    invariants. The UI should mark the segment but render its data (ADR-0020).
    """
    date: str
    warnings: list[ViolationModel]


class PriceLevelHit(BaseModel):
    """One exact trade at a calculated VI or limit-up/down price level."""

    date: str
    t_ms: int
    price: int
    kind: Literal["vi", "limit"]
    direction: Literal["upper", "lower"]
    pct: Literal[10, 20, 30]


class TradeVolumePoc(BaseModel):
    """One trading day's most-traded regular-session price area.

    The range is the max-quantity price bin from the continuous-trade volume
    distribution grid. ``band_pct`` remains on the wire for backward
    compatibility with older saved indicator state.
    """

    date: str
    center_price: int
    low_price: int
    high_price: int
    qty: int
    t_ms: int
    band_pct: float


class DepthHeatmapPoint(BaseModel):
    """한 분봉 버킷의 대표 스냅샷 10호가 잔량 분포.

    ``t_ms``는 버킷 시작 unix ms (bucket_ms 정렬, ApiCandle.ts_ms와 동일 축).
    ``asks``/``bids``는 각 최대 10단계 ``[price, qty]`` — asks는 가격 오름차순
    (index 0 = 최우선 매도), bids는 가격 내림차순(index 0 = 최우선 매수).
    잔량 0 단계는 프론트에서 렌더 스킵되므로 그대로 실어 보낸다.

    ``asks_max``/``bids_max``는 분봉 내 총잔량 최대 스냅샷의 분포(캔들 고가
    직관) — 토글로 ``asks``/``bids``와 교체해 렌더한다. 형식은 동일한
    ``[price, qty]`` 10단계.
    """

    t_ms: int
    asks: list[list[int]] = Field(default_factory=list)
    bids: list[list[int]] = Field(default_factory=list)
    asks_max: list[list[int]] = Field(default_factory=list)
    bids_max: list[list[int]] = Field(default_factory=list)


class DepthDeltaPoint(BaseModel):
    """한 분봉 버킷의 단별 잔량 증감 (연속 스냅샷 diff 의 버킷 합).

    ``t_ms``는 버킷 시작 unix ms. ``asks``/``bids``는 ``[price, in_qty, out_qty]``
    (in ≥ 0 유입 합, out ≤ 0 유출 합, 증감 0 가격은 미포함). ``ask_tick``/``bid_tick``
    은 셀 높이용 호가단위(관측 불가 시 0) — 증감 레벨은 변한 가격만 남은 희소
    집합이라 프론트가 역산할 수 없어 서버가 사다리에서 구해 싣는다.

    캡처 주기(~10s) 제약으로 유입/유출 gross 는 하한선, net 은 정확(텔레스코핑).
    """

    t_ms: int
    asks: list[list[int]] = Field(default_factory=list)
    bids: list[list[int]] = Field(default_factory=list)
    ask_tick: int = 0
    bid_tick: int = 0


class VolumeDistributionBin(BaseModel):
    price_low: int
    price_high: int
    qty: int


class DayVolumeDistribution(BaseModel):
    date: str
    range_count: int = Field(ge=5, le=30)
    price_min: int
    price_max: int
    session_open_ms: int
    session_close_ms: int
    last_trade_ms: int | None = None
    bins: list[VolumeDistributionBin]


class RangeBundle(BaseModel):
    """The sole read-path Wire Model for a Stock-Date Range (ADR-0013).

    All series aggregated at the same Timeframe (ADR-0014).

    volume_profile is per-segment (volume_profile_by_day) because each
    Stock-Date has its own price grid (price_min/price_max/price_step) — the
    grids cannot be concatenated meaningfully. QuoteRatio.points and
    FillStrength.points ARE concatenated across segments because they are flat
    (t, value) point arrays with no per-day grid dependency.

    excluded_dates / data_warnings surface invariant outcomes (ADR-0020).
    Both default to empty lists so existing clients are unaffected.
    """

    code: str
    from_date: str
    to_date: str
    bucket_ms: int
    segments: list[RangeSegment]
    candles: list[ApiCandle]
    quote_ratio: QuoteRatio
    fill_strength: FillStrength
    volume_profile_range: VolumeProfile
    volume_profile_by_day: list[VolumeProfile]
    excluded_dates: list[ExcludedDate] = []
    data_warnings: list[DateWarning] = []
    # 거래일별 매도 최대벽(연속거래만) — 범위 내 데이터 있는 각 거래일당 1개. 프론트가 각 항목을
    # 그날 segment x-구간의 수평 세그먼트로 그린다. 오늘 항목은 클라 ratchet이 live.ob로 갱신.
    # D·W·M/무데이터는 빈 리스트. 기본 []라 기존 클라 무영향.
    ask_peaks: list["AskPeak"] = []
    bid_peaks: list["BidPeak"] = Field(default_factory=list)
    # 분봉 버킷별 대표 스냅샷 10호가 잔량 분포(호가 잔량 히트맵). 기본 []라 기존 클라 무영향.
    depth_heatmap: list["DepthHeatmapPoint"] = Field(default_factory=list)
    depth_delta: list["DepthDeltaPoint"] = Field(default_factory=list)
    broker_late_entries: list["BrokerLateEntryEvent"] = Field(default_factory=list)
    price_level_hits: list[PriceLevelHit] = Field(default_factory=list)
    trade_volume_pocs: list[TradeVolumePoc] = Field(default_factory=list)
    volume_distributions: list[DayVolumeDistribution] = Field(default_factory=list)
    program_trade: ProgramTradeSeries = Field(default_factory=ProgramTradeSeries)
    # hogaplay 캡처 공백을 KIS 분봉으로 복구한 거래일(YYYYMMDD). 승리 소스가 kis_api
    # + meta.created_from == 'kis_minute_repair'인 날. 프론트가 "KIS 보충 캔들 ·
    # 호가 지표 없음" 배지를 띄운다. 기본 []라 기존 클라 무영향(hoga.live.candle_repair).
    repaired_candle_dates: list[str] = Field(default_factory=list)


# === Broker Day-Trajectory (ADR-0023) ===
# Day-scope series shipped by GET /api/brokers/series. The point's `net` is
# already signed by side at the producer (buy = +, sell = −) so the frontend
# does not re-aggregate; matches the legacy BrokerNetTable.computeNet sign
# convention. dominant_side mirrors sign(final_net) as a Literal so the
# frontend can color the row without recomputing.

class BrokerSeriesPoint(BaseModel):
    ts_ms: int
    net: int


class BrokerSeriesEntry(BaseModel):
    broker: str
    final_net: int
    dominant_side: Literal["buy", "sell"]
    points: list[BrokerSeriesPoint]


class BrokerSeriesResponse(BaseModel):
    date: str
    brokers: list[BrokerSeriesEntry]
    source: SourceName


class BrokerLateEntryEvent(BaseModel):
    t_ms: int
    broker: str
    side: Literal["buy", "sell"]
    net: int


# --- Watchlist (see spec 2026-05-26 and ADR-0034) --------------------------


class WatchlistFolder(BaseModel):
    """A named, ordered grouping that OWNS its ordered member Codes (v3,
    ADR-0070). `member_codes` order = the folder's in-display order. `id` is
    backend-minted and stable across renames. STORE model — the wire ships
    WatchlistFolderView (member_codes dropped, ADR-0004 Entity≠Wire)."""

    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)
    member_codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]] = Field(default_factory=list)
    capture_enabled: bool = True


class WatchlistEntry(BaseModel):
    """One Code's backfill record (v3). Folder membership + ordering live on
    WatchlistFolder.member_codes — the entry holds only capture markers.
    STORE model; the wire ships the exploded WatchlistEntryView."""

    code: str = Field(pattern=CODE_PATTERN)
    name: str
    registered_at_kst_date: str = Field(pattern=r"^\d{8}$")
    last_success_date: str | None = Field(default=None, pattern=r"^\d{8}$")


class WatchlistDocument(BaseModel):
    """On-disk watchlist.json (v3). Typed envelope, validated on load via
    model_validate. Every writer round-trips the WHOLE document under one
    lock so folders survive a capture-success write (ADR-0065). The invariant
    {e.code} == ⋃ folder.member_codes is a write-path/migration concern — NOT
    a raising validator (read path must not crash/wipe on drift, ADR-0065)."""

    schema_version: int = 3
    folders: list[WatchlistFolder] = Field(default_factory=list)
    entries: list[WatchlistEntry] = Field(default_factory=list)


# --- Wire (Wire Model = consumer shape; ADR-0004) --------------------------
# The store keeps member_codes on folders + slim per-Code entries; the wire
# ships the shape the frontend consumes verbatim: folders {id,name,order} and
# entries EXPLODED to one (folder, code) row each (a multi-folder Code appears
# once per folder). The backend route builds these from the document — no
# client adapter (ADR-0070 option B).


class WatchlistFolderView(BaseModel):
    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)
    capture_enabled: bool = True


class WatchlistEntryView(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    name: str
    registered_at_kst_date: str = Field(pattern=r"^\d{8}$")
    last_success_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    folder_id: str = Field(pattern=r"^f_[0-9a-f]{8}$")  # v3: never null
    order: int = Field(default=0, ge=0)                  # index within the folder's member_codes
    capture_candidate: bool = True


class WatchlistResponse(BaseModel):
    folders: list[WatchlistFolderView] = Field(default_factory=list)
    entries: list[WatchlistEntryView]
    next_run_at_ms: int  # Unix-ms of next KST 17:00 boundary (ADR-0003)


class WatchlistAddRequest(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)


class MemberAddRequest(BaseModel):
    """Body for POST /api/watchlist/folders/{folder_id}/members (v3, ADR-0070)."""
    code: str = Field(pattern=CODE_PATTERN)


class _FolderNameBody(BaseModel):
    """Shared request body for folder create/rename — one validated folder name."""

    name: str = Field(min_length=1, max_length=40)

    @field_validator("name")
    @classmethod
    def _strip_nonempty(cls, v: str) -> str:
        # Field(min_length=1) runs first on the RAW string, so "   " (len 3)
        # passes it. Strip and re-check here so a whitespace-only name is
        # rejected at the request boundary with a clean 422 — otherwise the
        # service strips to "" and reconstructs WatchlistFolder(name=""),
        # which re-trips min_length=1 as an uncaught ValidationError → HTTP 500.
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        return v


class FolderCreateRequest(_FolderNameBody):
    pass


class FolderRenameRequest(_FolderNameBody):
    pass


class FolderCaptureRequest(BaseModel):
    capture_enabled: bool


class FolderReorderRequest(BaseModel):
    ordered_ids: list[str]


class LiveSettingsResponse(BaseModel):
    """KIS REST 호가 캡처(rest30)·storage_policy·heatmap_capture_enabled는 제거됨
    (2026-07-17 정책: 호가는 api로 받지 않는다 — 관심종목=KIS WS, 히트맵=키움 WS).
    디스크의 옛 live_settings.json에 남은 키는 pydantic 기본(extra ignore)이 무시."""

    schema_version: int = 1
    kis_rest_bypass_enabled: bool = False
    # 스크리너 총잔량 조건에서 hogaplay 결측 종목을 발견하면 자동으로 지난 N일치 수집을
    # 큐에 적재할지. 기본 False — 스캔은 탐색적으로 반복 실행되므로 묵시적 큐 증가를 막고
    # 명시적 [수집 요청] 버튼을 1차 UX 로 둔다.
    screener_depth_autocollect: bool = False
    # 키움 WS 실시간 활성화 스위치는 폐지(ADR-0118, 2026-07-18). 실시간=키움 WS 유일
    # 소스이므로 '쓸지 말지'는 선택지가 아니다 — 활성화는 오직 자격증명 존재(n_kiwoom>0)
    # 로 게이트된다(키 있으면 항상 ON). 옛 live_settings.json의 kiwoom_enabled 키는
    # pydantic extra-ignore로 무시된다(마이그레이션 불필요).
    # 프로그램 순매수 저장 스위치(program_trade_storage_enabled)도 같은 이유로 폐지
    # (2026-07-21) — 키움 0w push 로 전환되며 수집 한계비용이 0 이 됐고, 거래원(0F)과
    # 마찬가지로 항시 저장한다. 옛 키 역시 extra-ignore 로 무시된다.


class LiveSettingsUpdate(BaseModel):
    kis_rest_bypass_enabled: bool | None = None
    screener_depth_autocollect: bool | None = None


SignalAlertSource = Literal["ws", "rest"]
SignalAlertName = Literal["sell_total_renewal"]
SignalAlertScope = Literal["inbox", "all"]


class SellTotalRenewalSettings(BaseModel):
    enabled: bool = True
    start_hhmm: int = 1100
    threshold_pct: int = 100
    use_intra_minute_max: bool = True

    @field_validator("start_hhmm")
    @classmethod
    def _valid_hhmm(cls, value: int) -> int:
        hh = value // 100
        mm = value % 100
        if hh < 9 or hh > 15 or mm < 0 or mm > 59 or (hh == 15 and mm > 20):
            raise ValueError("start_hhmm must be between 0900 and 1520 KST")
        return value

    @field_validator("threshold_pct")
    @classmethod
    def _valid_threshold(cls, value: int) -> int:
        if value < 50 or value > 150:
            raise ValueError("threshold_pct must be between 50 and 150")
        return value


class SignalAlertSettings(BaseModel):
    schema_version: int = 1
    sell_total_renewal: SellTotalRenewalSettings = Field(
        default_factory=SellTotalRenewalSettings
    )


class SignalAlertSettingsUpdate(BaseModel):
    sell_total_renewal: SellTotalRenewalSettings


class SignalAlertEvent(BaseModel):
    type: Literal["signal_alert"] = "signal_alert"
    id: str
    signal: SignalAlertName
    seq: int
    code: str
    name: str
    t_ms: int
    date: str
    source: SignalAlertSource
    value: int
    baseline: int
    ratio_pct: float
    use_intra_minute_max: bool


class SignalAlertRecentResponse(BaseModel):
    date: str
    scope: SignalAlertScope
    cleared_through_seq: int
    alerts: list[SignalAlertEvent]


class SignalAlertClearResponse(BaseModel):
    date: str
    cleared_through_seq: int


# Code lists below validate against params.CODE_PATTERN (6-char alphanumeric +
# Q-prefixed ETN) — same boundary rule as every other code input, so the
# folder endpoints can't smuggle arbitrary strings into watchlist storage.

class EntriesMoveRequest(BaseModel):
    codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]]
    folder_id: str | None = None


class EntriesReorderRequest(BaseModel):
    folder_id: str = Field(pattern=r"^f_[0-9a-f]{8}$")  # v3: reorder is within one real folder
    ordered_codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]]


class EntriesRemoveRequest(BaseModel):
    codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]]


# --- Heatmap (independent monitoring store, ADR-0068) ----------------------
# Parallel to the Watchlist but WITHOUT capture fields: the heatmap is a
# monitoring board, not a capture target. Folders + the folder/entry request
# bodies above (FolderCreateRequest, EntriesMoveRequest, ...) and
# WatchlistAddRequest are SHARED. Seeded once from the watchlist at first boot,
# then fully independent (no continuous sync).


class HeatmapEntry(BaseModel):
    """One Code on the Heatmap. Mirrors WatchlistEntry MINUS the capture
    markers (registered_at_kst_date / last_success_date) — the heatmap drives
    no captures (ADR-0068). v3 (ADR-0112): folder_id is REQUIRED — every entry
    belongs to a real folder; the 미분류(null) render-group no longer exists."""

    code: str = Field(pattern=CODE_PATTERN)
    name: str
    folder_id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    order: int = Field(default=0, ge=0)


class HeatmapEntriesMoveRequest(BaseModel):
    """POST /api/heatmap/move body. The watchlist's shared EntriesMoveRequest
    allows folder_id=null; the heatmap has no null group (ADR-0112), so the
    wire itself rejects a null destination (422, not a silent reparent)."""

    codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]]
    folder_id: str = Field(pattern=r"^f_[0-9a-f]{8}$")


class HeatmapFolderView(BaseModel):
    """Heatmap folder Wire Model. The store may reuse WatchlistFolder, but the
    heatmap wire must not expose member_codes (ADR-0004 Entity≠Wire)."""

    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)


class HeatmapDocument(BaseModel):
    """On-disk heatmap.json (v3, ADR-0112). Same envelope discipline as
    WatchlistDocument (ADR-0065 applied independently); entries are
    HeatmapEntry (no capture fields, folder_id required). Folders reuse
    WatchlistFolder."""

    schema_version: int = 3
    folders: list[WatchlistFolder] = Field(default_factory=list)
    entries: list[HeatmapEntry] = Field(default_factory=list)

    @model_validator(mode="after")
    def _no_dangling_folder_id(self) -> "HeatmapDocument":
        valid = {f.id for f in self.folders}
        for e in self.entries:
            if e.folder_id not in valid:
                raise ValueError(
                    f"entry {e.code} references unknown folder {e.folder_id}"
                )
        return self


class HeatmapResponse(BaseModel):
    """GET /api/heatmap. No next_run_at_ms — the heatmap has no scheduler."""

    folders: list[HeatmapFolderView] = Field(default_factory=list)
    entries: list[HeatmapEntry]


# --- Watchlist manual catch-up (see spec 2026-05-27) -----------------------


class ManualCatchupError(BaseModel):
    """Structured error for one watchlist entry that failed catch-up.

    ``code`` is a stable identifier the frontend can branch on (e.g.
    ``kis_holiday_fetch_failed``, ``catchup_failed``); ``message`` is a
    human-readable explanation. Raw exception strings are NOT exposed —
    server-side details (file paths, stack traces, credential hints) go
    to log.exception only.
    """
    code: str
    message: str


class ManualCatchupAllEntryResult(BaseModel):
    """One row in the ManualCatchupAllResponse.results list.

    ``error`` is a structured ``{code, message}`` envelope when the entry
    failed, or ``None`` when it succeeded. The stable ``error.code`` lets
    the panel branch on known failure modes (e.g.
    ``kis_holiday_fetch_failed``) without parsing exception strings.
    """
    code: str = Field(pattern=CODE_PATTERN)
    name: str
    enqueued_count: int
    deduped_count: int
    error: ManualCatchupError | None = None


class ManualCatchupAllResponse(BaseModel):
    """Response shape for POST /api/watchlist/catchup."""
    results: list[ManualCatchupAllEntryResult]


class TimingPhaseTotals(BaseModel):
    http_fetch_ms: float = 0.0
    parse_ms: float = 0.0
    disk_write_ms: float = 0.0
    rate_limit_ms: float = 0.0
    backoff_ms: float = 0.0
    cookie_pause_ms: float = 0.0
    other_ms: float = 0.0


class TimingPageDetail(BaseModel):
    idx: int
    http_ms: float
    parse_ms: float
    write_ms: float
    events: int
    errors: list[str]


class TimingEnv(BaseModel):
    rate_limit_s: float
    max_concurrent: int
    page_step_ms_initial: int
    hoga_version: str
    git_sha: str | None = None


class TimingSummary(BaseModel):
    code: str
    date: str
    started_at_kst: str
    ended_at_kst: str
    total_ms: float
    phase_totals_ms: TimingPhaseTotals
    phase_percentages: dict[str, float]
    unaccounted_ms: float
    page_count: int
    event_count: int
    error_counts: dict[str, int]
    env: TimingEnv


class TimingReport(BaseModel):
    summary: TimingSummary
    pages: list[TimingPageDetail]


class CaptureTimingEvent(BaseModel):
    """SSE summary event for one completed (or failed) capture's timing.

    Carries only the summary — full per-page detail is written to the
    timing JSON on disk (see ``write_timing_report``) so we don't push
    page-level payload over the SSE channel.

    ``id`` (``${code}:${date}``) is the frontend dedup key.
    """
    type: Literal["capture_timing"] = "capture_timing"
    id: str
    summary: TimingSummary


# === Screener Wire Models ===


class ScreenerStatusFile(BaseModel):
    """디스크 status.json (Stock-Date capture meta.json 과 별개)."""

    schema_version: int = 1
    # None = 시드됐으나 유효 거래일이 없음(빈/NULL-date 아카이브) — last_raw_date()
    # 가 None 을 돌려줘도 ValidationError 로 죽지 않고 상태를 표현한다. status 라우트는
    # None 을 days_behind=None(불명)으로 강등한다.
    last_raw_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    last_built_ms: int
    universe_size: int
    derive_ms: int


# === Saved-screener condition leaves (2026-05-31 saved-screener spec) ===

class TradeValueParams(BaseModel):
    min_eok: float = Field(ge=0)                       # 최신일 거래대금 ≥ N억

class TradeValuePeriodParams(BaseModel):                # 최근 N거래일 중 하루라도 거래대금 ≥ min_eok억
    lookback: int = Field(ge=1)
    min_eok: float = Field(ge=0)

class BreakoutParams(BaseModel):                       # 신고가/신고거래량 공용 (구 BreakoutFilter)
    lookback: int = Field(ge=1)                        # N: Lookback Window
    period: int = Field(ge=1)                          # M: Record Period

class PeriodParams(BaseModel):                         # 당일 신고가/신고거래량 — 단일 윈도우
    period: int = Field(ge=1)

class ChangePctParams(BaseModel):
    op: Literal["gte", "lte", "between"]
    pct: float | None = None                           # gte/lte
    lo: float | None = None                            # between
    hi: float | None = None

    @model_validator(mode="after")
    def _check(self) -> "ChangePctParams":
        if self.op in ("gte", "lte") and self.pct is None:
            raise ValueError("gte/lte requires pct")
        if self.op == "between":
            if self.lo is None or self.hi is None:
                raise ValueError("between requires lo and hi")
            if self.lo > self.hi:
                raise ValueError("lo must be <= hi")
        return self

class PriceRangeParams(BaseModel):
    min: int | None = None                             # 원
    max: int | None = None

    @model_validator(mode="after")
    def _check(self) -> "PriceRangeParams":
        if self.min is None and self.max is None:
            raise ValueError("price_range needs at least one of min/max")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min must be <= max")
        return self

class MaParams(BaseModel):
    period: int = Field(ge=1)
    relation: Literal["above", "below"]                # source >= SMA(source) / source <= SMA(source)
    source: Literal["open", "high", "low", "close"] = "close"

class HighOffPeakParams(BaseModel):                    # 신고가 대비 고가 위치 (52주 고점 근접도)
    period: int = Field(ge=1)                          # N: peak 산출 거래일 수 (52주≈250)
    pct: float = Field(ge=0)                           # 고점 대비 하락 허용폭(%). 양수, 라벨에 "−" 표기
    side: Literal["within", "outside"] = "within"      # within: 고점 −pct% 이내 / outside: 이외

class DepthPeakParams(BaseModel):                      # 매도/매수 총잔량 분봉 peak 신고
    lookback: int = Field(ge=1)                        # N: 비교 대상 과거 거래일 수
    # 당일 peak ≥ (threshold_pct/100) × 지난 N일 peak. 100=신고 돌파, <100=근접,
    # >100=초과 돌파. 단일 비율 파라미터로 "보다 클 때"와 "N% 이상"을 통합.
    threshold_pct: float = Field(default=100.0, ge=1)

class TradeValueLeaf(BaseModel):
    type: Literal["trade_value"] = "trade_value"
    id: str
    params: TradeValueParams

class TradeValuePeriodLeaf(BaseModel):
    type: Literal["trade_value_period"] = "trade_value_period"
    id: str
    params: TradeValuePeriodParams

class NewHighLeaf(BaseModel):
    type: Literal["new_high"] = "new_high"
    id: str
    params: BreakoutParams

class NewHighVolLeaf(BaseModel):
    type: Literal["new_high_vol"] = "new_high_vol"
    id: str
    params: BreakoutParams

class NewHighTodayLeaf(BaseModel):
    type: Literal["new_high_today"] = "new_high_today"
    id: str
    params: PeriodParams

class NewHighVolTodayLeaf(BaseModel):
    type: Literal["new_high_vol_today"] = "new_high_vol_today"
    id: str
    params: PeriodParams

class ChangePctLeaf(BaseModel):
    type: Literal["change_pct"] = "change_pct"
    id: str
    params: ChangePctParams

class PriceRangeLeaf(BaseModel):
    type: Literal["price_range"] = "price_range"
    id: str
    params: PriceRangeParams

class MaLeaf(BaseModel):
    type: Literal["ma"] = "ma"
    id: str
    params: MaParams

class HighOffPeakLeaf(BaseModel):
    type: Literal["high_off_peak"] = "high_off_peak"
    id: str
    params: HighOffPeakParams

class AskDepthNewHighLeaf(BaseModel):
    type: Literal["ask_depth_new_high"] = "ask_depth_new_high"
    id: str
    params: DepthPeakParams

class BidDepthNewHighLeaf(BaseModel):
    type: Literal["bid_depth_new_high"] = "bid_depth_new_high"
    id: str
    params: DepthPeakParams

ConditionLeaf = Annotated[
    Union[TradeValueLeaf, TradeValuePeriodLeaf, NewHighTodayLeaf, NewHighLeaf,
          NewHighVolTodayLeaf, NewHighVolLeaf, HighOffPeakLeaf, ChangePctLeaf,
          PriceRangeLeaf, MaLeaf, AskDepthNewHighLeaf, BidDepthNewHighLeaf],
    Field(discriminator="type"),
]


# === Saved-screener scan request / response / persistence models ===

class ScreenerUniverse(BaseModel):
    markets: list[Literal["KOSPI", "KOSDAQ"]] = Field(default_factory=list)
    exclude_etf: bool = False
    exclude_halted: bool = False
    # 조회 유니버스를 캡처 대상 집합으로 좁힌다(빈 리스트 = 전체 시장, 기존 동작).
    # 체크된 스코프의 합집합 ∩ 나머지 필터. 관심∪히트맵은 총잔량 데이터가 정의되는
    # 집합과 동일(screener_depth._depth_universe). 기존 저장본은 키 부재 → default 로
    # 하위호환. 스크리너 실시간 모니터링의 리소스 절감 축(intraday fetch 유니버스 축소).
    scopes: list[Literal["watchlist", "heatmap"]] = Field(default_factory=list)

ScanBasis = Literal["eod", "intraday"]


class ScanRequest(BaseModel):
    conditions: list[ConditionLeaf] = Field(default_factory=list)
    universe: ScreenerUniverse = Field(default_factory=ScreenerUniverse)
    limit: int = Field(1000, ge=1, le=2000)
    basis: ScanBasis = "eod"

class ScreenerRow(BaseModel):                          # 평면형 — 조건 배지 없음
    code: str = Field(pattern=CODE_PATTERN)
    name: str
    market: Literal["KOSPI", "KOSDAQ"]
    price: int
    trade_value_won: int
    change_pct: float | None

class DepthCoverageCode(BaseModel):                    # 총잔량 조건 커버리지 한 종목
    code: str = Field(pattern=CODE_PATTERN)
    name: str
    have_days: int                                     # 지난 N거래일 중 hogaplay 보유 일수
    need_days: int                                     # N

class DepthCoverage(BaseModel):
    """총잔량 신고 조건의 hogaplay 데이터 커버리지 리포트(가장 넓은 N 기준).

    excluded = 보유 0일(비교 불가, 결과 제외 + 수집 요청 대상). partial = 0<보유<N
    (보유분만으로 비교 — 과거 peak 과소평가 가능, 결과 행에 배지). 평가 유니버스는
    관심∪히트맵(캡처 대상 집합)으로, 총잔량 데이터가 정의되는 종목만 대상.
    """
    lookback: int
    evaluated: int
    excluded: list[DepthCoverageCode] = Field(default_factory=list)
    partial: list[DepthCoverageCode] = Field(default_factory=list)

class DepthPeakValue(BaseModel):                       # 결과 행 검증용 사이드카(코드→값)
    # side별 당일/과거 peak + 보유일 — 배지는 활성 조건 side만, 각 side의 자기 N 기준.
    ask_today: int | None = None
    ask_past_peak: int | None = None
    ask_have_days: int = 0
    ask_need_days: int = 0
    bid_today: int | None = None
    bid_past_peak: int | None = None
    bid_have_days: int = 0
    bid_need_days: int = 0

class ScreenerResponse(BaseModel):
    status: Literal["ok", "not_seeded", "building"]
    rows: list[ScreenerRow]
    warnings: list[str] = Field(default_factory=list)
    # 총잔량 신고 조건이 있을 때만 채워진다(없으면 None — 기존 응답과 하위호환).
    depth_coverage: DepthCoverage | None = None
    depth_values: dict[str, DepthPeakValue] | None = None

class ScreenerSaveWriteRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    conditions: list[ConditionLeaf] = Field(default_factory=list)
    universe: ScreenerUniverse = Field(default_factory=ScreenerUniverse)

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str) -> str:
        # min_length=1 alone accepts whitespace-only names ("   "); spec
        # requires 이름 공백 → 422. Strip and reject empty-after-strip.
        stripped = v.strip()
        if not stripped:
            raise ValueError("name must not be blank")
        return stripped

class SavedScreener(ScreenerSaveWriteRequest):
    id: str
    created_at_ms: int
    updated_at_ms: int

class SavedScreenersFile(BaseModel):
    schema_version: int = 1
    saves: list[SavedScreener] = Field(default_factory=list)


LiveTimeframeModel = Literal["1m", "3m", "5m", "10m", "15m", "30m", "D", "W", "M"]


def _ensure_finite(value: int | float) -> int | float:
    if not math.isfinite(float(value)):
        raise ValueError("must be finite")
    return value


def _strip_nonblank_name(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        raise ValueError("name must not be blank")
    return stripped


class StudyViewport(BaseModel):
    right_edge_ms: int
    #: 좌측 끝 실시각. 구 저장뷰에는 없어 optional — 그 경우 프론트가 bar_span
    #: 역산으로 폴백한다(우측 여백만큼 어긋나는 옛 동작).
    left_edge_ms: int | None = None
    bar_span: float
    at_live_edge: bool
    right_padding_bars: float | None = None

    @field_validator("right_edge_ms", "left_edge_ms", "bar_span", "right_padding_bars")
    @classmethod
    def _finite(cls, v: int | float | None):
        if v is None:
            return None
        return _ensure_finite(v)

    @model_validator(mode="after")
    def _valid_viewport(self):
        if self.bar_span <= 0:
            raise ValueError("bar_span must be positive")
        if self.right_padding_bars is not None and self.right_padding_bars < 0:
            raise ValueError("right_padding_bars must be non-negative")
        if self.left_edge_ms is not None and self.left_edge_ms > self.right_edge_ms:
            raise ValueError("left_edge_ms must not exceed right_edge_ms")
        return self


class StudyViewRange(BaseModel):
    from_date: str = Field(pattern=r"^\d{8}$")
    to_date: str = Field(pattern=r"^\d{8}$")
    from_ms: int
    to_ms: int

    @model_validator(mode="after")
    def _valid_range(self):
        if self.from_date > self.to_date:
            raise ValueError("from_date must be <= to_date")
        if self.from_ms > self.to_ms:
            raise ValueError("from_ms must be <= to_ms")
        kst = ZoneInfo("Asia/Seoul")
        from_ms_date = datetime.fromtimestamp(self.from_ms / 1000, tz=kst).strftime("%Y%m%d")
        to_ms_date = datetime.fromtimestamp(self.to_ms / 1000, tz=kst).strftime("%Y%m%d")
        if not (self.from_date <= from_ms_date <= self.to_date):
            raise ValueError("from_ms must fall within from_date/to_date")
        if not (self.from_date <= to_ms_date <= self.to_date):
            raise ValueError("to_ms must fall within from_date/to_date")
        return self


class StudyViewReferenceWriteRequest(BaseModel):
    name: str
    code: str = Field(pattern=CODE_PATTERN)
    label: str
    timeframe: LiveTimeframeModel
    range: StudyViewRange
    viewport: StudyViewport
    memo: str = ""
    tags: list[str] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return _strip_nonblank_name(v)

    @field_validator("memo", mode="before")
    @classmethod
    def _default_memo(cls, v: str | None) -> str:
        return "" if v is None else str(v).strip()

    @field_validator("tags", mode="before")
    @classmethod
    def _default_tags(cls, v: list[str] | None) -> list[str]:
        return [] if v is None else v


class StudyViewMetadataUpdateRequest(BaseModel):
    name: str | None = None
    memo: str | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _strip_nonblank_name(v)

    @field_validator("memo")
    @classmethod
    def _strip_memo(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return v.strip()

    @model_validator(mode="after")
    def _has_update(self):
        if self.name is None and self.memo is None:
            raise ValueError("at least one metadata field is required")
        return self


class StudyViewReference(BaseModel):
    schema_version: Literal[2] = 2
    id: str
    name: str
    code: str = Field(pattern=CODE_PATTERN)
    label: str
    timeframe: LiveTimeframeModel
    range: StudyViewRange
    viewport: StudyViewport
    memo: str = ""
    tags: list[str] = Field(default_factory=list)
    created_at_ms: int
    updated_at_ms: int

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return _strip_nonblank_name(v)


StudyViewListRow = StudyViewReference


class StudyViewsFile(BaseModel):
    schema_version: int = 1
    saves: list[StudyViewListRow] = Field(default_factory=list)


# ── Live layout presets (ADR-0114 §4 → ADR-0119 PR-E) ─────────────────────
# v3(PR-E, #713 §5): 프리셋 = **워크스페이스 전체 스냅샷**(창 목록·z순서·그룹→종목).
# 종목을 포함한다(TradingView 레이아웃 관례). 뷰포트·비영속 런타임은 담지 않는다(§6).
# 서버는 **얕은 구조 검증만** 하고 키셋을 강제하지 않는다 — 적용 시 프론트가 canonical
# 재정규화(readWindow 재사용)하므로 새 창 kind/지표 필드 추가에 백엔드 변경이 없다.
# payload 는 프론트-네이티브 camelCase 스냅샷을 그대로 담는 얕은 컨테이너다.
class LiveLayoutPresetPayload(BaseModel):
    # windows 원소·groupSymbols 값은 자유 구조(창 kind별 chart 설정 등) → dict 통과.
    windows: list[dict[str, Any]] = Field(default_factory=list)
    zOrder: list[str] = Field(default_factory=list)
    groupSymbols: dict[str, dict[str, Any]] = Field(default_factory=dict)


class LiveLayoutPresetWriteRequest(BaseModel):
    name: str
    payload: LiveLayoutPresetPayload

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return _strip_nonblank_name(v)


class LiveLayoutPreset(BaseModel):
    # v3 (PR-E, #713 §5): payload 가 워크스페이스 스냅샷으로 바뀜. 폐기는 파일 레벨
    # 버전(LiveLayoutPresetsFile.schema_version)이 단일 기준 — load_presets 참조.
    # 여긴 정보용 int(구 preset 도 관용 로드시켜 파일 레벨 가드가 폐기하게 둔다).
    schema_version: int = 3
    id: str
    name: str
    payload: LiveLayoutPresetPayload
    created_at_ms: int
    updated_at_ms: int

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return _strip_nonblank_name(v)


LiveLayoutPresetListRow = LiveLayoutPreset


class LiveLayoutPresetsFile(BaseModel):
    schema_version: int = 3
    presets: list[LiveLayoutPreset] = Field(default_factory=list)
