"""API response container models. Per-entity models live in their table
module (``hoga/tables/{trades,snapshots,brokers,candles}.py``).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from hoga.api.error_codes import UpstreamCode
from hoga.tables.candles import ApiCandle
from hoga.tables.snapshots import ApiOrderbookSnapshot
from hoga.tables.trades import ApiTrade


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


class OrderbookResponse(BaseModel):
    available_from: int | None = None
    snapshot: ApiOrderbookSnapshot | None


class TradesResponse(BaseModel):
    trades: list[ApiTrade]


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


class QuoteRatioPoint(BaseModel):
    t: int          # Unix ms
    bid_total: int
    ask_total: int


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


CapturePhase = Literal[
    "queued", "deciding", "capturing", "parsing",
    "done", "failed", "cancelled", "skipped",
]
SkipReason = Literal["already_complete", "source_partial"]


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
    force_retry: bool          # frozen at enqueue per spec §11 Q16
    pause_origin: bool         # True when cancelled by cookie-expired pool pause
    enqueued_at_ms: int
    started_at_ms: int | None = None
    progress: CaptureProgress | None = None
    result: CaptureResult | None = None
    error: CaptureError | None = None
    skip_reason: SkipReason | None = None



# SSE event Wire Models — same ADR-0004 rule applies to events as to HTTP responses:
# the schema is declared once here and shipped verbatim to consumers. Frontend
# types.ts hand-mirrors these; drift is caught by TypeScript at compile time.
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


class QueueSnapshot(BaseModel):
    """Wire model for the full queue/worker state at one moment in time."""

    active: list[QueueItem]
    queued: list[QueueItem]
    done: list[QueueItem]
    paused: bool
    max_concurrent: int


# --- POST /api/captures/items request/response (Plan B Task 7) --------------


class EnqueueRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    start_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    end_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    dates: list[str] | None = None       # alternative to start/end
    force_retry: bool = False


class EnqueueDedupedRow(BaseModel):
    code: str
    date: str
    reason: Literal["already_in_queue", "already_running"]


class EnqueueResponse(BaseModel):
    enqueued: list[QueueItem]
    deduped: list[EnqueueDedupedRow]


# --- Sibling-endpoint wire models (Tasks 16–17) -----------------------------


class SymbolHit(BaseModel):
    code: str
    name: str
    market: Literal["KOSPI", "KOSDAQ"]
    captured_count: int                 # complete only — headline number (spec §11 Q18)
    captured_breakdown: dict[str, int]  # {"complete": N, "source_partial": M, "client_incomplete": K}


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
    "complete", "source_partial", "client_incomplete", "none",
    "weekend", "holiday", "future", "today_locked",
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


class RangeBundle(BaseModel):
    """The sole read-path Wire Model for a Stock-Date Range (ADR-0013).

    All series aggregated at the same Timeframe (ADR-0014).

    volume_profile is per-segment (volume_profile_by_day) because each
    Stock-Date has its own price grid (price_min/price_max/price_step) — the
    grids cannot be concatenated meaningfully. QuoteRatio.points and
    FillStrength.points ARE concatenated across segments because they are flat
    (t, value) point arrays with no per-day grid dependency.
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
