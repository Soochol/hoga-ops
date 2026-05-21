"""API response container models. Per-entity models live in their table
module (``hoga/tables/{trades,snapshots,brokers,candles}.py``).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

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


class DepthIntensity(BaseModel):
    bucket_ms: int
    price_min: int
    price_max: int
    price_step: int
    times: list[int]              # Unix ms per bucket
    bid_grid: list[list[float]]   # len(times) × price_bins
    ask_grid: list[list[float]]


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


class SessionBundle(BaseModel):
    code: str
    date: str
    session_open_ms: int
    session_close_ms: int
    candles: list[ApiCandle]
    quote_ratio: QuoteRatio
    depth_intensity: DepthIntensity
    volume_profile: VolumeProfile
    fill_strength: FillStrength


CapturePhase = Literal["capturing", "parsing", "done", "failed", "cancelled"]


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


class CaptureJob(BaseModel):
    job_id: str
    code: str
    date: str
    phase: CapturePhase
    options: dict  # {allow_partial, resume, capture_only}
    started_at_ms: int  # Unix ms, set just before collect_stock_date call
    progress: CaptureProgress | None = None
    result: CaptureResult | None = None
    error: CaptureError | None = None


# SSE event Wire Models — same ADR-0004 rule applies to events as to HTTP responses:
# the schema is declared once here and shipped verbatim to consumers. Frontend
# types.ts hand-mirrors these; drift is caught by TypeScript at compile time.
#
# Each subclass carries its own `type` Literal so pydantic serializes the
# discriminator automatically — class name is the source of truth, no manual
# string juggling.


class _CaptureEventBase(BaseModel):
    job_id: str
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
    """Terminal event. `phase` is one of done | failed | cancelled."""

    type: Literal["capture_finished"] = "capture_finished"
    result: CaptureResult | None = None
    error: CaptureError | None = None
