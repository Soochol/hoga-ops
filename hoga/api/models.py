"""API response container models. Per-entity models live in their table
module (``hoga/tables/{trades,snapshots,brokers,candles}.py``).
"""

from __future__ import annotations

import math
from typing import Annotated, Literal, Union

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
    ``untraded_*`` = 당일 고가보다 큰 ask price 기준. None이면 후보 없음 또는 legacy payload.
    """
    date: str
    price: int
    qty: int
    t_ms: int
    max_price: int
    max_qty: int
    max_t_ms: int
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


class BidPeak(BaseModel):
    """한 거래일 연속거래 중 단일 매수 호가단계 최대 물량·가격(Day Bid Peak).

    Mirrors ``AskPeak`` on the bid side. ``untraded_*`` fields are bid prices
    below the day's traded low.
    """

    date: str
    price: int
    qty: int
    t_ms: int
    max_price: int
    max_qty: int
    max_t_ms: int
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
SkipReason = Literal["already_complete", "source_partial", "no_upstream_data"]


class CaptureProgress(BaseModel):
    pages_done: int
    events_seen: int
    frontier_ms: int  # Unix epoch ms per ADR-0003 (converted from HHMMSSmmm)
    estimate_pct: int  # 0..98 — backend-computed (see spec §5.5)
    elapsed_ms: int


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
    price_level_hits: list[PriceLevelHit] = Field(default_factory=list)
    trade_volume_pocs: list[TradeVolumePoc] = Field(default_factory=list)
    volume_distributions: list[DayVolumeDistribution] = Field(default_factory=list)
    program_trade: ProgramTradeSeries = Field(default_factory=ProgramTradeSeries)


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


LiveStoragePolicy = Literal["ws_only", "ws_plus_rest", "rest_only"]


class LiveSettingsResponse(BaseModel):
    schema_version: int = 1
    storage_policy: LiveStoragePolicy = "ws_plus_rest"
    program_trade_storage_enabled: bool = False


class LiveSettingsUpdate(BaseModel):
    storage_policy: LiveStoragePolicy
    program_trade_storage_enabled: bool | None = None


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
    no captures (ADR-0068)."""

    code: str = Field(pattern=CODE_PATTERN)
    name: str
    folder_id: str | None = Field(default=None, pattern=r"^f_[0-9a-f]{8}$")
    order: int = Field(default=0, ge=0)


class HeatmapFolderView(BaseModel):
    """Heatmap folder Wire Model. The store may reuse WatchlistFolder, but the
    heatmap wire must not expose member_codes (ADR-0004 Entity≠Wire)."""

    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)


class HeatmapDocument(BaseModel):
    """On-disk heatmap.json (v2). Same envelope discipline as
    WatchlistDocument (ADR-0065 applied independently); entries are
    HeatmapEntry (no capture fields). Folders reuse WatchlistFolder."""

    schema_version: int = 2
    folders: list[WatchlistFolder] = Field(default_factory=list)
    entries: list[HeatmapEntry] = Field(default_factory=list)

    @model_validator(mode="after")
    def _no_dangling_folder_id(self) -> "HeatmapDocument":
        valid = {f.id for f in self.folders}
        for e in self.entries:
            if e.folder_id is not None and e.folder_id not in valid:
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

ConditionLeaf = Annotated[
    Union[TradeValueLeaf, TradeValuePeriodLeaf, NewHighTodayLeaf, NewHighLeaf,
          NewHighVolTodayLeaf, NewHighVolLeaf, ChangePctLeaf, PriceRangeLeaf, MaLeaf],
    Field(discriminator="type"),
]


# === Saved-screener scan request / response / persistence models ===

class ScreenerUniverse(BaseModel):
    markets: list[Literal["KOSPI", "KOSDAQ"]] = Field(default_factory=list)
    exclude_etf: bool = False
    exclude_halted: bool = False

class ScanRequest(BaseModel):
    conditions: list[ConditionLeaf] = Field(default_factory=list)
    universe: ScreenerUniverse = Field(default_factory=ScreenerUniverse)
    limit: int = Field(1000, ge=1, le=2000)

class ScreenerRow(BaseModel):                          # 평면형 — 조건 배지 없음
    code: str = Field(pattern=CODE_PATTERN)
    name: str
    market: Literal["KOSPI", "KOSDAQ"]
    price: int
    trade_value_won: int
    change_pct: float | None

class ScreenerResponse(BaseModel):
    status: Literal["ok", "not_seeded", "building"]
    rows: list[ScreenerRow]
    warnings: list[str] = Field(default_factory=list)

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
StudyAggregationBasis = Literal["close", "intra_period_max"]
StudySavedFromRoute = Literal["/live", "/study"]
StudyDataProvenance = Literal["live_mixed", "study_snapshot", "unknown"]


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
    bar_span: float
    at_live_edge: bool

    @field_validator("right_edge_ms", "bar_span")
    @classmethod
    def _finite(cls, v: int | float):
        return _ensure_finite(v)

    @model_validator(mode="after")
    def _bar_span_positive(self):
        if self.bar_span <= 0:
            raise ValueError("bar_span must be positive")
        return self


class StudyMovingAverageConfig(BaseModel):
    id: str
    enabled: bool
    period: int = Field(ge=2, le=400)
    color: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")
    line_width: Literal[1, 2, 3, 4]
    source: Literal["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"]

    @field_validator("id")
    @classmethod
    def _nonblank_id(cls, v: str) -> str:
        if not v:
            raise ValueError("id must not be blank")
        return v


class StudyIndicatorState(BaseModel):
    volume_enabled: bool
    quote_totals_enabled: bool
    ratio_enabled: bool
    fill_strength_enabled: bool
    aggregation_basis: StudyAggregationBasis
    auction_window_mask: bool
    ratio_outlier_filter_enabled: bool
    ratio_outlier_threshold: float
    daily_moving_averages: list[StudyMovingAverageConfig] = Field(default_factory=list)
    daily_moving_average_enabled: bool = False
    daily_moving_average_hidden: bool = False
    program_trade_enabled: bool = True
    trade_volume_poc_enabled: bool = True
    trade_volume_poc_band_pct: float = 0.005
    trade_volume_poc_color: str = Field(default="#A855F7", pattern=r"^#[0-9A-Fa-f]{6}$")
    trade_volume_poc_opacity: float = Field(default=0.12, ge=0, le=1)
    volume_distribution_enabled: bool = True
    volume_distribution_range_count: int = Field(default=10, ge=5, le=30)
    volume_distribution_color: str = Field(default="#64748B", pattern=r"^#[0-9A-Fa-f]{6}$")
    volume_distribution_max_color: str = Field(default="#EAB308", pattern=r"^#[0-9A-Fa-f]{6}$")

    @field_validator("ratio_outlier_threshold")
    @classmethod
    def _finite(cls, v: float):
        return _ensure_finite(v)


class StudyProvenance(BaseModel):
    saved_from_route: StudySavedFromRoute
    data_provenance: StudyDataProvenance


class StudySegment(BaseModel):
    date: str
    session_open_ms: int
    session_close_ms: int
    source: SourceName = "hogaplay"


class StudyCandlePoint(BaseModel):
    t: int
    open: float
    high: float
    low: float
    close: float
    volume: float

    @field_validator("open", "high", "low", "close", "volume")
    @classmethod
    def _finite(cls, v: float):
        return _ensure_finite(v)


class StudyQuoteTotalsPoint(BaseModel):
    t: int
    bid_total: float | None = None
    ask_total: float | None = None
    visible: bool

    @field_validator("bid_total", "ask_total")
    @classmethod
    def _finite_optional(cls, v: float | None):
        return None if v is None else _ensure_finite(v)

    @model_validator(mode="after")
    def _visible_has_values(self):
        if self.visible and (self.bid_total is None or self.ask_total is None):
            raise ValueError("visible quote total points require bid_total and ask_total")
        return self


class StudyRatioPoint(BaseModel):
    t: int
    value: float | None = None
    visible: bool

    @field_validator("value")
    @classmethod
    def _finite_optional(cls, v: float | None):
        return None if v is None else _ensure_finite(v)

    @model_validator(mode="after")
    def _visible_has_value(self):
        if self.visible and self.value is None:
            raise ValueError("visible ratio points require value")
        return self


class StudyFillStrengthPoint(BaseModel):
    t: int
    buy_qty: float | None = None
    sell_qty: float | None = None
    visible: bool

    @field_validator("buy_qty", "sell_qty")
    @classmethod
    def _finite_optional(cls, v: float | None):
        return None if v is None else _ensure_finite(v)

    @model_validator(mode="after")
    def _visible_has_values(self):
        if self.visible and (self.buy_qty is None or self.sell_qty is None):
            raise ValueError("visible fill strength points require buy_qty and sell_qty")
        return self


class StudyOrderbookBucket(BaseModel):
    t: int
    snapshot: ApiOrderbookSnapshot | None = None
    available: bool

    @model_validator(mode="after")
    def _available_has_snapshot(self):
        if self.available and self.snapshot is None:
            raise ValueError("available orderbook buckets require snapshot")
        return self


class StudyBrokerDetail(BaseModel):
    broker: str
    net: int
    dominant_side: Literal["buy", "sell"]


class StudyBrokerBucket(BaseModel):
    t: int
    brokers: list[StudyBrokerDetail]
    available: bool

    @model_validator(mode="after")
    def _available_has_brokers(self):
        if self.available and not self.brokers:
            raise ValueError("available broker buckets require brokers")
        return self


class StudyDetailWarning(BaseModel):
    kind: Literal["orderbook", "broker"]
    t: int | None = None
    code: str = Field(pattern=CODE_PATTERN)
    date: str | None = None
    message: str


class StudySnapshotBundle(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    timeframe: LiveTimeframeModel
    snapshot_from_ms: int
    snapshot_to_ms: int
    segments: list[StudySegment]
    candles: list[StudyCandlePoint]
    quote_totals: list[StudyQuoteTotalsPoint]
    ratio: list[StudyRatioPoint]
    fill_strength: list[StudyFillStrengthPoint]
    program_trade: ProgramTradeSeries = Field(default_factory=ProgramTradeSeries)
    ask_peaks: list[AskPeak] = Field(default_factory=list)
    bid_peaks: list[BidPeak] = Field(default_factory=list)
    trade_volume_pocs: list[TradeVolumePoc] = Field(default_factory=list)
    volume_distributions: list[DayVolumeDistribution] = Field(default_factory=list)
    data_warnings: list[str] = Field(default_factory=list)
    orderbook_buckets: list[StudyOrderbookBucket] = Field(default_factory=list)
    broker_buckets: list[StudyBrokerBucket] = Field(default_factory=list)
    detail_warnings: list[StudyDetailWarning] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_bundle(self):
        if self.snapshot_from_ms > self.snapshot_to_ms:
            raise ValueError("snapshot_from_ms must be <= snapshot_to_ms")
        for name in ("candles", "quote_totals", "ratio", "fill_strength"):
            points = getattr(self, name)
            ts = [p.t for p in points]
            if ts != sorted(ts):
                raise ValueError(f"{name} must be sorted by t")
        candle_ts = [p.t for p in self.candles]
        for name in ("orderbook_buckets", "broker_buckets"):
            detail = getattr(self, name)
            if not detail:
                continue
            detail_ts = [p.t for p in detail]
            if detail_ts != candle_ts:
                raise ValueError(f"{name} must align with candles by t")
        return self


class ParquetStudySnapshot(BaseModel):
    schema_version: Literal[1] = 1
    source_policy: Literal["fixed"] = "fixed"
    code: str = Field(pattern=CODE_PATTERN)
    label: str
    timeframe: LiveTimeframeModel
    snapshot_from_ms: int
    snapshot_to_ms: int
    bucket_kind: LiveTimeframeModel
    viewport: StudyViewport
    indicator_state: StudyIndicatorState
    provenance: StudyProvenance
    bundle: StudySnapshotBundle
    captured_at_ms: int

    @model_validator(mode="after")
    def _metadata_matches_bundle(self):
        if self.snapshot_from_ms > self.snapshot_to_ms:
            raise ValueError("snapshot_from_ms must be <= snapshot_to_ms")
        if self.bundle.code != self.code:
            raise ValueError("snapshot bundle code mismatch")
        if self.bundle.timeframe != self.timeframe:
            raise ValueError("snapshot bundle timeframe mismatch")
        if self.bundle.snapshot_from_ms != self.snapshot_from_ms:
            raise ValueError("snapshot bundle from bound mismatch")
        if self.bundle.snapshot_to_ms != self.snapshot_to_ms:
            raise ValueError("snapshot bundle to bound mismatch")
        return self


class ParquetStudyViewWriteRequest(BaseModel):
    name: str
    code: str = Field(pattern=CODE_PATTERN)
    label: str
    timeframe: LiveTimeframeModel
    snapshot_from_ms: int
    snapshot_to_ms: int
    viewport: StudyViewport
    indicator_state: StudyIndicatorState
    snapshot: ParquetStudySnapshot
    provenance: StudyProvenance
    memo: str = ""
    tags: list[str] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return _strip_nonblank_name(v)

    @model_validator(mode="after")
    def _request_matches_snapshot(self):
        if self.snapshot_from_ms > self.snapshot_to_ms:
            raise ValueError("snapshot_from_ms must be <= snapshot_to_ms")
        fields = ("code", "label", "timeframe", "snapshot_from_ms", "snapshot_to_ms")
        for field in fields:
            if getattr(self.snapshot, field) != getattr(self, field):
                raise ValueError(f"snapshot {field} mismatch")
        if self.snapshot.viewport != self.viewport:
            raise ValueError("snapshot viewport mismatch")
        if self.snapshot.indicator_state != self.indicator_state:
            raise ValueError("snapshot indicator_state mismatch")
        if self.snapshot.provenance != self.provenance:
            raise ValueError("snapshot provenance mismatch")
        return self


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


class ParquetStudyView(BaseModel):
    id: str
    name: str
    code: str = Field(pattern=CODE_PATTERN)
    label: str
    timeframe: LiveTimeframeModel
    snapshot_from_ms: int
    snapshot_to_ms: int
    viewport: StudyViewport
    indicator_state: StudyIndicatorState
    memo: str
    tags: list[str]
    provenance: StudyProvenance
    snapshot_schema_version: int
    snapshot_path: str
    snapshot_size_bytes: int
    created_at_ms: int
    updated_at_ms: int

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return _strip_nonblank_name(v)

    @model_validator(mode="after")
    def _bounds_are_ordered(self):
        if self.snapshot_from_ms > self.snapshot_to_ms:
            raise ValueError("snapshot_from_ms must be <= snapshot_to_ms")
        return self


class StudyViewsFile(BaseModel):
    schema_version: int = 1
    saves: list[ParquetStudyView] = Field(default_factory=list)
