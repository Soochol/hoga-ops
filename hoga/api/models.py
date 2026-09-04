"""API response container models. Per-entity models live in their table
module (``hoga/tables/{trades,snapshots,brokers,candles}.py``).
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from datetime import datetime
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from hoga.api.error_codes import UpstreamCode
from hoga.api.params import CODE_PATTERN
from hoga.api.sources import SourceName
from hoga.tables.candles import ApiCandle
from hoga.tables.snapshots import ApiOrderbookSnapshot


class StockDateVenue(BaseModel):
    """한 venue 의 디스크 상태 — 보관함 날짜 행의 venue 배지 하나에 대응한다.

    **목록에 없는 venue 는 '없어야 정상'이다.** 미상장 종목의 NXT 를 빈 배지로
    그리면 결손처럼 읽힌다 — 자리 자체를 안 만드는 것이 '정상적으로 없음'을
    모양으로 말하는 방법이다(ADR-0140 §7). 그래서 이 목록은 `expected_venues`
    (`kiwoom_live/meta.json`, PR-E)로 만든다.
    """

    venue: str
    """"KRX" | "NXT" | "UN"."""
    disk_state: str | None = None
    """이 venue 의 `DiskStateValue`. ``None`` = **기대됐으나 아직 없음** —
    배지 자리는 있고 내용이 비어 있다. 그 구분이 요점이다: 자리가 없으면
    '이 시장에 상장 안 됨'이고, 자리가 비면 '있어야 하는데 없음'이다."""
    file_size_bytes: int = 0


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
    upstream_gap_confirmed: bool = False
    """이 ``source_partial`` 이 **재캡처로 나아지지 않는다**고 판정됐는가
    (:func:`eligibility.is_terminal_partial`). 워커가 ``upstream_gap`` 으로
    건너뛰는 바로 그 조건이다.

    ``identical_capture_count >= 2`` 로 대신할 수 없어서 필드로 싣는다. 그건
    확정 경로 셋 중 하나(ADR-0093)일 뿐이고, 나머지 둘 — 세션 경계 접촉
    (ADR-0126)·보유 창 밖 미확정(ADR-0131) — 은 meta 단독으로도, 카운터
    단독으로도 클라이언트가 재현할 수 없다(후자는 **오늘 날짜**가 있어야 한다).

    ``disk_state`` 를 쪼개는 대신 불리언을 더한 이유: ``disk_state ==
    "source_partial"`` 이 결손 패널 노출·정렬 severity·재캡처 게이트를 좌우해서,
    값을 나누면 정작 확정 행에서 상세가 사라진다. 확정 여부는 **표시 축**이지
    상태 축이 아니다."""
    fail_streak: int = 0
    """ADR-0042: consecutive failed+skipped count since last success/unblock.
    Joined from QueueManifest.fail_streaks at the route layer. 0 means
    "no recent failures". When ``>= 5`` the row is also ``blocked``."""
    blocked: bool = False
    """ADR-0042: ``fail_streak >= 5``. Renders a 차단됨 badge + 잠금 해제
    button on the inventory row; enqueue requests for this (Code, Stock-Date)
    are rejected with HTTP 409 until the user clears the counter."""
    venues: list[StockDateVenue] = Field(default_factory=list)
    """이 Stock-Date 의 `kiwoom_live` venue 별 디스크 상태 (ADR-0140 §7).

    **빈 목록 = venue 축이 없는 행**이다 — `kiwoom_live` 가 없거나(hogaplay 전용
    캡처) 마이그레이션 전 평면 레이아웃이다. 프론트는 빈 목록에 아무것도 그리지
    않는다(현행 화면 그대로).

    이 행의 주 상태(`disk_state`)는 여전히 **hogaplay** 것이다 — 인벤토리 행은
    `_find_winning_meta` 가 고른 hogaplay/평면 meta 로 만든다. 여기 실리는 것은
    같은 (날짜, 종목)에 대해 `kiwoom_live` 가 별도로 가진 상태이고, 두 소스는
    커버 구간이 다르다(hogaplay=KRX 정규장, kiwoom_live=venue 별 창)."""


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
    ``traded_*`` arrays = **동일분 터치** 벽의 랭킹 배열(ADR-0156 — 그 벽이 관측된
    1분 안에서 체결이 그 가격을 친 벽); single ``price``/``max_price`` remain the
    legacy rank-1 compatibility fields. 와이어 이름 ``traded_*`` 는 캐시·API 이관
    비용을 피해 유지한다(ADR-0084 의 규약 계승).
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
    traded_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    traded_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    # 기록 갱신 시퀀스(시간순 prefix maxima, ≤128) — 최대벽 강도 pane 의 "그 시점까지
    # 체결된 벽 중 최대" 복원용. traded_*(최종 크기순 top-3)와 축이 다르다:
    # snapshots._peak_record_sequence docstring 참조. 봉 무관(cont 절반과 같은 취급).
    traded_record_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    traded_record_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    all_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    all_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    # 미도달 벽(당일 고가 위) — cont 단일 계열 rank-1 스칼라 + top-3. top-3 은 최대
    # 3개라 all_peaks 처럼 벗기지 않는다(_without_all_peak_rankings 대상 아님).
    # None/[] = 구 캐시·legacy payload(그날은 프론트가 선을 건너뛴다).
    unreached_price: int | None = None
    unreached_qty: int | None = None
    unreached_t_ms: int | None = None
    unreached_peaks: list[AskPeakCandidate] = Field(default_factory=list)


class BidPeak(BaseModel):
    """한 거래일 연속거래 중 단일 매수 호가단계 최대 물량·가격(Day Bid Peak).

    Mirrors ``AskPeak`` on the bid side. ``traded_*`` arrays are the **동일분
    터치** ranked wire (ADR-0156), while single ``price``/``max_price`` stay as
    legacy rank-1 compatibility fields.
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
    traded_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    traded_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    # 기록 갱신 시퀀스(시간순 prefix maxima, ≤128) — 최대벽 강도 pane 의 "그 시점까지
    # 체결된 벽 중 최대" 복원용. traded_*(최종 크기순 top-3)와 축이 다르다:
    # snapshots._peak_record_sequence docstring 참조. 봉 무관(cont 절반과 같은 취급).
    traded_record_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    traded_record_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    all_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    all_max_peaks: list[AskPeakCandidate] = Field(default_factory=list)
    # 미도달 벽(당일 저가 아래) — AskPeak 의 같은 필드 주석 참조(대칭 미러).
    unreached_price: int | None = None
    unreached_qty: int | None = None
    unreached_t_ms: int | None = None
    unreached_peaks: list[AskPeakCandidate] = Field(default_factory=list)


class QuoteRatioPoint(BaseModel):
    t: int          # Unix ms
    bid_total: int
    ask_total: int
    # Intra-Bar Max (ADR-0076) — 종가 옆에 항상 동봉(순수 렌더 스위치; mode= 파라미터 없음).
    bid_max: int        # 버킷 내 매수 총잔량 독립 최댓값
    ask_max: int        # 버킷 내 매도 총잔량 독립 최댓값
    imb_max_bid: int    # |imbalance| 최대 스냅샷의 bid_total
    imb_max_ask: int    # |imbalance| 최대 스냅샷의 ask_total
    # 대표 스냅샷의 10호가 사다리 폭(중간가 대비 %). 총잔량은 "고정된 가격 폭"이
    # 아니라 "고정된 호가 단계 수"로 잰 값이라, 호가단위가 바뀌면 같은 물량이 다른
    # 숫자로 나온다 — 소비자가 그 자의 변화를 볼 수 있게 동반한다.
    # `docs/research/2026-08-19-hoga-tick-band-totals-normalization.md`
    band_pct: float = 0.0
    # 대표 스냅샷 중간가의 KRX 호가단위(원). 급증 보정의 **트리거** — 가격의 결정론적
    # 함수라 빈 호가 잡음이 못 건드린다. band_pct 는 그 트리거를 **확인**하는 용도로
    # 함께 쓰인다(ETF 처럼 표가 틀리는 종목군에서 거부권). 0 = 모름.
    tick: int = 0


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
    # start/end 의 대안. 날짜는 디렉터리 경로 세그먼트가 되므로(raw/<code>/<date>)
    # 형식을 여기서 못 박는다 — 패턴 없이는 "../" 류가 경로로 흘러든다.
    dates: list[Annotated[str, Field(pattern=r"^\d{8}$")]] | None = None
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
    #: 성공했지만 **품질이 떨어진 채** 진행했음을 알린다. 현재 유일한 값은
    #: ``kis_credentials_missing`` — KIS 거래일 목록을 못 얻어 **평일 기준**으로 날짜를
    #: 담았다는 뜻이다(휴장일이 섞일 수 있다). 실패가 아니므로 에러 채널이 아니라
    #: 여기에 싣는다 — 조용히 폴백하면 나중에 "왜 휴장일이 큐에 있지?" 로 돌아온다.
    warning: UpstreamCode | None = None


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
    # EnqueueRequest.dates 와 같은 이유로 형식 고정(경로 세그먼트).
    dates: list[Annotated[str, Field(pattern=r"^\d{8}$")]] = Field(min_length=1)


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
    #: NXT 상장 여부. ``None`` = **모름**(판별 불가), ``False`` = 미상장 — 둘을 합치면
    #: 안 된다(ADR-0140 §4). 프론트가 "이 시장에 없음"을 표시하려면 이 값이 필요하다
    #: (#1132) — 없으면 빈 시세와 수집 장애를 구분할 수 없다.
    nxt_enabled: bool | None = None
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
    # SOURCE_PARTIAL 의 정제(refinement): 이 부분 결손은 **더 나아지지 않는다**.
    # `source_partial` 은 "구멍이 있다" 까지만 말하는데, 그 안에는 재캡처가 채워 줄
    # 수 있는 것과 업스트림에 영영 없는 것이 섞여 있다. 후자를 셀에서 갈라 내지
    # 않으면 사용자가 무의미한 재캡처를 반복하고, decide_capture 는 조용히
    # `upstream_gap` 으로 건너뛴다 — 표시와 동작이 어긋난 상태다.
    "source_partial_confirmed",
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
    3_600_000,   # 60m — 정규장 마감(15:30)이 버킷 경계가 아닌 첫 tf.
                 # 근거·실측은 frontend `MINUTE_TIMEFRAMES` 주석 참조.
    7_200_000,   # 120m ┐ 집계 **전에** 정규장으로 클립한다(`downsample_candles`).
    14_400_000,  # 240m ┘ 클립 없이는 NXT·UN 에서 애프터마켓이 정규장 봉에 섞여
                 #        종가가 +1.08%/+1.30% 어긋난다(2026-08-07 실측).
)

#: 집계 전에 정규장으로 클립하는 버킷. 프론트 `CLIPPED_TIMEFRAMES` 의 짝이고,
#: 값이 갈리면 벤더 경로(프론트 집계)와 디스크 경로(여기)가 **다른 봉을 그린다**.
#: 60m 가 빠진 이유도 그쪽 주석과 같다 — 실측 오차가 작아 클립 없이 내보냈고
#: (#1252), 산술 조건으로 바꾸면 그 결정이 조용히 뒤집힌다.
CLIPPED_TIMEFRAME_MS: frozenset[int] = frozenset({7_200_000, 14_400_000})


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

    #: 이 세그먼트를 그린 소스의 **정규장 결손 총량(ms)**. 소스 배지가 읽는다.
    #:
    #: `None` 과 `0` 은 다르다 — **`None` = 정보 없음**(구 백엔드 응답·meta 판독 실패),
    #: **`0` = 결손 없음**. 프론트에서 `?? 0` 으로 합치지 말 것: 그러면 정보가 없는
    #: 상태가 "완전함"으로 둔갑해 배지가 조용해진다(계약 드리프트 무증상화, #1183).
    #:
    #: **`is_partial` 이 아니라 크기를 싣는 이유**: 그 필드는 이진값이라 3분 구멍과
    #: 4시간 구멍을 구분하지 못한다. 실측(2026-08-07, 겹치는 2,134칸): hogaplay 가
    #: "결손 있음" 으로 찍힌 992칸의 **중앙 결손이 688초(정규장의 2.9%)** 이고 그 중
    #: 26.8%는 5분 이하인데, 그 칸들에서 hogaplay 는 **100%** 더 촘촘하다
    #: (중앙 24,005행 vs 2,402행). 등급만 보고 자동 전환하면 21,603행을 버린다.
    gap_ms: int | None = None


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


MissingDateReason = Literal[
    # --- `sources.MissingReason` 과 공유하는 값 (사다리가 판정) ---
    "venue_unsupported",   # 이 venue 를 줄 수 있는 source 가 정책 사다리에 없다
    "source_missing",      # 사다리 승자의 디렉터리가 그 날 없다(NXT 미기록의 통상 형태)
    "stock_date_missing",  # 사다리가 그 (날짜,종목) 디렉터리를 못 찾았다
    # --- 조립점(bundle.py)에서만 생기는 값 ---
    "meta_unreadable",     # 경로는 있는데 meta.json 을 읽지 못했다(손상)
    # 아래 둘은 `list_stock_dates_in_range` 목록에 **애초에 없던** 날이다. 사다리는
    # 이들을 볼 기회조차 없으므로 `sources.MissingReason` 에는 대응 값이 없다.
    # hogaplay 가 그날을 못 준다. 영구. **형태가 둘**이다 — ADR-0021 센티넬(파일이
    # 아예 없다)과 만료 스텁(close_ms=0 파일이 있다, `is_expired_upstream_stub`).
    # 사용자가 할 수 있는 일이 같아서(없다·재캡처 무의미) 한 값을 쓴다.
    "no_upstream_data",
    "not_captured",        # 아직 캡처하지 않았다. 캡처하면 채워진다.
]
"""`MissingDate.reason` 의 전체 값 — 프론트 `RangeMissingDate['reason']` 의 미러 원본.

**둘의 차이가 곧 사용자의 선택지다.** `no_upstream_data` 는 할 수 있는 일이 없고
`not_captured` 는 캡처 한 번이면 채워진다 — 화면이 이를 같게 말하면 사용자는 되는 일에
손을 안 대고 안 되는 일에 시간을 쓴다(006800/20251218 조사, 2026-08-16).

값을 늘리면 **같은 PR 에서** 프론트 union 도 고친다(ADR-0004). 좁혀 둔 이유가 그것이다 —
`reason: str` 이던 시절엔 `meta_unreadable` 이 `sources.MissingReason` 밖에서 조용히
생산되고 있었고, 손 미러는 그 드리프트를 원리적으로 못 잡는다.
"""


class MissingDate(BaseModel):
    """번들에 **데이터가 없어서** 빠진 거래일과 그 사유 (#1133).

    `ExcludedDate` 와 다른 것이다 — 저쪽은 데이터가 있는데 불변식을 어겨 **버린** 날이고,
    이쪽은 애초에 읽을 것이 **없는** 날이다. 둘을 한 필드에 섞으면 UI 가 "고장" 과
    "원래 없음" 을 가를 수 없다.

    ⚠ **한 클래스만 두 배열에 함께 실린다**(2026-08-24): 업스트림 만료 스텁
    (`close_ms=0`)은 파일이 있으므로 excluded 이면서, 쓸 수 있는 데이터가 없으므로
    missing 이다. 둘 다 사실이라 어느 쪽을 빼도 정보가 준다 — 소비자가 다르기
    때문이다(excluded=진단, missing=키움 보충의 입력). **서로소로 되돌리지 말 것**:
    missing 에서 빼면 그 거래일은 재캡처도 보충도 닿지 않는 사각지대로 돌아간다
    (`hoga/api/eligibility.py` 의 `is_expired_upstream_stub` 이 경위를 적는다).

    이 필드가 필요한 이유는 venue 축 때문이다. NXT·통합은 그 시장을 서빙할 수 있는
    source(`kiwoom_live`)가 저장을 시작한 날부터만 존재하므로, 그 이전 구간은 **정상적으로**
    빈다. 사유 없이 빈 배열만 보내면 프론트는 그것을 장애와 구별할 수 없고, 실제로
    빈 pane 을 그대로 렌더해 사용자에게 아무 설명도 못 했다.

    `reason` 은 `MissingDateReason` — `sources.MissingReason` 의 상위집합이다(조립점에서만
    생기는 사유가 있어서 두 타입이 갈린다).
    """
    date: str
    reason: MissingDateReason


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

    ``asks_price_max``/``bids_price_max``는 **가격대마다 따로** 잰 최댓값이다.
    앞의 두 계열과 달리 **한 순간의 호가창이 아니다** — 가격마다 자기 최고점이
    서로 다른 순간에서 오므로, 이 배열을 세로로 읽으면 실제로 동시에 존재한 적
    없는 호가창이 된다. 그 대가로 각 셀은 「당일 최대벽」이 재는 값과 정확히
    같아진다(그 지표도 가격당 최댓값이다). 정렬 규약은 동일하고 **길이는 10 고정이
    아니다**(그 버킷에 등장한 distinct 가격 수).
    """

    t_ms: int
    asks: list[list[int]] = Field(default_factory=list)
    bids: list[list[int]] = Field(default_factory=list)
    asks_max: list[list[int]] = Field(default_factory=list)
    bids_max: list[list[int]] = Field(default_factory=list)
    asks_price_max: list[list[int]] = Field(default_factory=list)
    bids_price_max: list[list[int]] = Field(default_factory=list)


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
    #: 이 (code, source, venue) 의 **가장 오래된 캡처 거래일**(YYYYMMDD). 캡처가 없으면 None.
    #:
    #: 디스크 모드(hogaplay 우회) 분봉의 **좌측 팬 바닥**이다. 벤더 모드에는 250일 벽이
    #: 있지만 디스크 모드의 끝은 벽이 아니라 캡처 유무이고, 프론트는 그걸 알 방법이
    #: 없었다 — 그래서 사용자가 캡처 시작 이전으로 무한히 팬해 **빈 화면 + 「과거
    #: 불러오는 중」이 계속** 뜨는 상태가 됐다(2026-08-26 신고). 프론트가 이 값을
    #: `minuteScrollbackFloorDate` 에 물리면 `planFillStep` 의 정지 조건과 벽 도달
    #: 안내가 우회 모드에서도 살아난다.
    earliest_captured_date: str | None = None
    excluded_dates: list[ExcludedDate] = []
    data_warnings: list[DateWarning] = []
    # 읽을 데이터가 없어 빠진 거래일 + 사유(#1133). 기본 []라 기존 클라 무영향.
    missing_dates: list[MissingDate] = Field(default_factory=list)
    # 거래일별 매도 최대벽(연속거래만) — 범위 내 데이터 있는 각 거래일당 1개. 프론트가 각 항목을
    # 그날 segment x-구간의 수평 세그먼트로 그린다. 오늘 항목은 클라 ratchet이 live.ob로 갱신.
    # D·W·M/무데이터는 빈 리스트. 기본 []라 기존 클라 무영향.
    ask_peaks: list[AskPeak] = []
    bid_peaks: list[BidPeak] = Field(default_factory=list)
    # 분봉 버킷별 대표 스냅샷 10호가 잔량 분포(호가 잔량 히트맵). 기본 []라 기존 클라 무영향.
    depth_heatmap: list[DepthHeatmapPoint] = Field(default_factory=list)
    broker_late_entries: list[BrokerLateEntryEvent] = Field(default_factory=list)
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


class BrokerLateEntryEvent(BaseModel):
    t_ms: int
    broker: str
    side: Literal["buy", "sell"]
    net: int


# --- Watchlist (see spec 2026-05-26 and ADR-0034) --------------------------


# 메모 텍스트 상한 — 패널 종목명 컬럼 폭에 맞춘 값. 넘으면 UI 가 truncate 하는 게
# 아니라 요청이 422 로 거절된다(저장된 값은 항상 표시 가능한 길이).
WATCHLIST_MEMO_MAX_LEN = 80

# 메모 아이템 id — 폴더 `f_` 관례와 대칭. 6자리 종목코드와 prefix 로 구별되므로
# 프론트 dnd sortable id 파서가 kind 를 문자열만 보고 가를 수 있다.
MEMO_ID_PATTERN = r"^m_[0-9a-f]{8}$"


class WatchlistCodeItem(BaseModel):
    """폴더 items 의 종목 항목(v4). v3 의 `member_codes` 원소가 이것으로 승격됐다."""

    kind: Literal["code"] = "code"
    code: str = Field(pattern=CODE_PATTERN)


class WatchlistMemoItem(BaseModel):
    """폴더 items 의 메모 항목(v4) — 리스트에 끼워 넣는 "빈칸".

    `text=""` 가 **정상 상태**(빈 줄)다. 폴더 이름(_FolderNameBody)과 정반대이므로
    그쪽 blank-거부 validator 를 재사용하면 이 기능이 통째로 죽는다.
    """

    kind: Literal["memo"] = "memo"
    id: str = Field(pattern=MEMO_ID_PATTERN)
    text: str = Field(default="", max_length=WATCHLIST_MEMO_MAX_LEN)


# discriminated union — 알 수 없는 `kind` 는 ValidationError 가 되어 load_document 의
# corruption 경로(backup + empty)로 간다. 읽기 경로에서 조용히 드롭하면 다음 save 가
# 그 드롭을 영속시켜 read-path wipe 가 된다(ADR-0065 위반).
WatchlistItem = Annotated[
    WatchlistCodeItem | WatchlistMemoItem, Field(discriminator="kind")
]


def code_items(codes: Iterable[str]) -> list[WatchlistItem]:
    """코드 리스트 → code item 리스트 (v4 폴더를 코드만으로 세우는 단위 연산).

    `WatchlistFolder(items=code_items([...]))` 가 v3 의
    `WatchlistFolder(member_codes=[...])` 를 대신한다. 반환형이 좁은
    `list[WatchlistCodeItem]` 이 아니라 `list[WatchlistItem]` 인 것은 의도다 —
    `list` 는 불변(invariant)이라 좁게 선언하면 모든 호출부가 타입 에러가 난다.
    """
    return [WatchlistCodeItem(code=c) for c in codes]


class WatchlistFolder(BaseModel):
    """A named, ordered grouping that OWNS its ordered items (v4, ADR-0070).
    `items` order = the folder's in-display order, mixing Codes and memo rows.
    `id` is backend-minted and stable across renames. STORE model — the wire
    ships WatchlistFolderView (items dropped, ADR-0004 Entity≠Wire).

    v3 까지 이 자리는 `member_codes: list[str]` 였다. 그 이름은 **의도적으로
    남기지 않았다** — 읽기 전용 property 로 남기면 기존
    `model_copy(update={"member_codes": ...})` 호출부가 에러도 경고도 없이 무시된다
    (pydantic v2 는 update dict 를 __dict__ 에 넣지만 클래스 property 가 이긴다).
    코드 멤버만 필요하면 watchlist.code_members(folder) 를 쓴다.
    """

    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)
    items: list[WatchlistItem] = Field(default_factory=list)

    def code_members(self) -> list[str]:
        """이 폴더의 **종목 코드만**, items 순서대로.

        v3 의 `member_codes` 필드 자리를 대신하는 읽기 뷰다. 캡처 플래너·Live Set·
        히트맵 시드로 가는 projection 이 이 메서드만 통과하면 메모 항목은
        **원리적으로** 그 경로에 샐 수 없다.

        메서드인 것이 중요하다 — property 였다면 기존
        `model_copy(update={"member_codes": ...})` 호출부가 에러도 경고도 없이
        무시됐을 것이다(pydantic v2 는 update dict 를 __dict__ 에 넣지만 클래스
        property 가 이긴다).
        """
        return [i.code for i in self.items if isinstance(i, WatchlistCodeItem)]


class WatchlistEntry(BaseModel):
    """One Code's backfill record (v4). Folder membership + ordering live on
    WatchlistFolder.items — the entry holds only capture markers. Memo items
    have no entry (they are not Codes). STORE model; the wire ships the
    exploded WatchlistEntryView."""

    code: str = Field(pattern=CODE_PATTERN)
    name: str
    registered_at_kst_date: str = Field(pattern=r"^\d{8}$")
    last_success_date: str | None = Field(default=None, pattern=r"^\d{8}$")


class WatchlistDocument(BaseModel):
    """On-disk watchlist.json (v4). Typed envelope, validated on load via
    model_validate. Every writer round-trips the WHOLE document under one
    lock so folders survive a capture-success write (ADR-0065). The invariant
    {e.code} == ⋃ folder 의 code items 는 write-path/migration concern — NOT
    a raising validator (read path must not crash/wipe on drift, ADR-0065).
    Memo items sit outside that invariant entirely."""

    schema_version: int = 4
    folders: list[WatchlistFolder] = Field(default_factory=list)
    entries: list[WatchlistEntry] = Field(default_factory=list)


# --- Wire (Wire Model = consumer shape; ADR-0004) --------------------------
# The store keeps items on folders + slim per-Code entries; the wire ships the
# shape the frontend consumes verbatim: folders {id,name,order}, entries
# EXPLODED to one (folder, code) row each (a multi-folder Code appears once per
# folder), and memos in a SEPARATE array. The backend route builds these from
# the document — no client adapter (ADR-0070 option B).
#
# 메모를 `entries` 에 판별 유니온으로 섞지 않는 이유: `entries` 는 히트맵·라이브 등
# 여러 소비자가 읽는 배열이라, 유니온을 섞으면 메모를 모르는 소비자가 전부 바뀐다.
# 별도 배열이면 기존 소비자는 무영향이고, 순서는 `order`(둘 다 folder items 인덱스)로
# 프론트에서 병합한다 — entries∪memos 는 폴더당 0..N-1 로 조밀하다.


class WatchlistFolderView(BaseModel):
    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)


class WatchlistEntryView(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    name: str
    registered_at_kst_date: str = Field(pattern=r"^\d{8}$")
    last_success_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    folder_id: str = Field(pattern=r"^f_[0-9a-f]{8}$")  # v3: never null
    # v4: index within the folder's ITEMS (memo rows included), not a code-only
    # index. Values are sparse across this array alone; entries∪memos is dense.
    order: int = Field(default=0, ge=0)


class WatchlistMemoView(BaseModel):
    """A memo ("빈칸") row in a folder's display order (v4).

    `text=""` is the blank-line state and is intentionally valid — see
    WatchlistMemoItem.
    """

    id: str = Field(pattern=MEMO_ID_PATTERN)
    folder_id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    order: int = Field(default=0, ge=0)  # index within the folder's items
    text: str = Field(default="", max_length=WATCHLIST_MEMO_MAX_LEN)


class WatchlistResponse(BaseModel):
    folders: list[WatchlistFolderView] = Field(default_factory=list)
    entries: list[WatchlistEntryView]
    memos: list[WatchlistMemoView] = Field(default_factory=list)
    next_run_at_ms: int  # Unix-ms of next KST 17:00 boundary (ADR-0003)


class WatchlistAddRequest(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)


class MemberAddRequest(BaseModel):
    """Body for POST /api/watchlist/folders/{folder_id}/members (v3, ADR-0070).

    `at` = 삽입할 items 인덱스. MemoCreateRequest.at 과 **같은 축·같은 클램프
    시맨틱**이다(패널 행 우클릭 "위에 종목 추가"). None 이면 폴더 맨 아래.
    이미 멤버인 코드면 at 은 무시된다 — add 는 멱등 no-op 계약이다.
    """

    code: str = Field(pattern=CODE_PATTERN)
    at: int | None = Field(default=None, ge=0)


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


class FolderReorderRequest(BaseModel):
    ordered_ids: list[str]


class _MemoTextBody(BaseModel):
    """Shared request body for memo create/update — one memo text.

    ⚠ `_FolderNameBody` 와 **정반대** 계약이다: 빈 문자열이 정상 값(빈 줄)이므로
    strip 만 하고 blank 를 거절하지 않는다. 저 validator 를 재사용하면 "빈칸" 기능이
    통째로 죽는다 — 그래서 상속하지 않고 따로 둔다.
    """

    text: str = Field(default="", max_length=WATCHLIST_MEMO_MAX_LEN)

    @field_validator("text")
    @classmethod
    def _strip(cls, v: str) -> str:
        # 공백만 입력 → "" (빈 줄). 거절이 아니라 정규화다.
        return v.strip()


class MemoCreateRequest(_MemoTextBody):
    """Body for POST /api/watchlist/folders/{folder_id}/memos.

    `at` = 삽입할 items 인덱스. None 이면 폴더 맨 아래. 범위를 벗어난 값은 끝으로
    클램프한다(422 로 거절하지 않는다 — 동시 편집으로 길이가 줄었을 뿐인 흔한 경우라
    사용자에게 에러를 보일 이유가 없다).
    """

    at: int | None = Field(default=None, ge=0)


class MemoUpdateRequest(_MemoTextBody):
    """Body for PATCH /api/watchlist/memos/{memo_id}."""


class LiveSettingsResponse(BaseModel):
    """KIS REST 호가 캡처(rest30)·storage_policy·heatmap_capture_enabled는 제거됨
    (2026-07-17 정책: 호가는 api로 받지 않는다 — 관심종목=KIS WS, 히트맵=키움 WS).
    디스크의 옛 live_settings.json에 남은 키는 pydantic 기본(extra ignore)이 무시."""

    schema_version: int = 1
    # **REST 우회 토글.** 2026-08-04까지 `kis_rest_bypass_enabled` 였다(PR-J·#1046).
    # 벤더가 키움으로 바뀌었으므로 이름에서 `kis_` 를 걷어내되 **기능은 유지**한다
    # — 지도가 "bypass 토글은 그대로 적용하되 REST 우회 의미로" 로 확정했다.
    #
    # 이름 교체는 expand/contract 로 했고 3단계까지 끝났다(응답 이중 노출 제거).
    #
    # **읽기 별칭만 영구히 남는다.** `LiveSettings` 가 이 모델의 별칭이라 이건
    # 와이어 타입이면서 **디스크 타입**이다 — 사용자 머신의 `live_settings.json` 에
    # 여전히 옛 키가 들어 있고, 그건 배포와 무관하게 살아 있다. 별칭을 지우면
    # pydantic 의 extra-ignore 가 그 키를 **조용히 버려** 사용자가 켜 둔 우회
    # 설정이 False 로 리셋된다. 디스크가 한 번 새 키로 다시 써지기 전까지는
    # 지울 수 없고, 그 시점을 알 방법이 없으므로 남긴다.
    rest_bypass_enabled: bool = Field(
        default=False,
        validation_alias=AliasChoices("rest_bypass_enabled", "kis_rest_bypass_enabled"),
    )

    # 스크리너 총잔량 조건에서 hogaplay 결측 종목을 발견하면 자동으로 지난 N일치 수집을
    # 큐에 적재할지. 기본 False — 스캔은 탐색적으로 반복 실행되므로 묵시적 큐 증가를 막고
    # 명시적 [수집 요청] 버튼을 1차 UX 로 둔다.
    screener_depth_autocollect: bool = False

    # **KRX 호가·체결을 hogaplay 우선으로.** 기본 False(=키움 고정 사다리).
    #
    # #1172 가 2026-08-07 에 소스 선호 옵션을 폐지했는데 이건 그 결정과 정면으로 만난다.
    # 되살리는 근거는 **폐지 근거의 사실 기반이 같은 날 뒤집혔다**는 것이다: 사다리
    # 주석은 "hogaplay 0~25건/일, 죽어가는 폴백" 을 전제했는데, ADR-0142 가 같은 날
    # hogaplay 를 271종목/일 로 되돌렸다.
    #
    # 폐지 사유 자체(venue 토글 시 시장과 소스가 함께 바뀌어 비교가 깨진다)는 여전히
    # 유효하므로 **기본값으로 되돌리지 않고 옵트인으로 둔다** — 기본은 비교 가능성,
    # 옵트인은 해상도, 그리고 소스 배지가 무엇을 보고 있는지 알린다.
    #
    # 이름이 `krx_` 인 이유: hogaplay 는 KRX 만 덮으므로(`SOURCE_VENUES`) NXT·통합에는
    # 원리적으로 적용되지 않는다. `resolve_source_result` 가 사다리 정렬 **뒤에**
    # venue 필터를 걸어 자동으로 걸러낸다 — 별도 분기가 필요 없다.
    krx_prefer_hogaplay: bool = False

    # 키움 WS 실시간 활성화 스위치는 폐지(ADR-0118, 2026-07-18). 실시간=키움 WS 유일
    # 소스이므로 '쓸지 말지'는 선택지가 아니다 — 활성화는 오직 자격증명 존재(n_kiwoom>0)
    # 로 게이트된다(키 있으면 항상 ON). 옛 live_settings.json의 kiwoom_enabled 키는
    # pydantic extra-ignore로 무시된다(마이그레이션 불필요).
    # 프로그램 순매수 저장 스위치(program_trade_storage_enabled)도 같은 이유로 폐지
    # (2026-07-21) — 키움 0w push 로 전환되며 수집 한계비용이 0 이 됐고, 거래원(0F)과
    # 마찬가지로 항시 저장한다. 옛 키 역시 extra-ignore 로 무시된다.


class LiveSettingsUpdate(BaseModel):
    # **순수 와이어 타입이라 별칭이 필요 없다** — 디스크에 저장되지 않는다.
    # 프론트가 새 이름으로 갈아탔으므로(#1046 2단계) 옛 이름 수용을 거뒀다.
    rest_bypass_enabled: bool | None = None
    screener_depth_autocollect: bool | None = None
    krx_prefer_hogaplay: bool | None = None


SignalAlertSource = Literal["ws", "rest"]
SignalAlertName = Literal["sell_total_renewal"]
SignalAlertScope = Literal["inbox", "all"]


def validate_session_start_hhmm(value: int) -> int:
    """장중 기준시각 HHMM(0900~1520 KST) 검증. 유효하면 그대로 반환.

    실시간 알림(:class:`SellTotalRenewalSettings`)과 스크리너 조건
    (:class:`DepthRenewalParams`)이 **같은 의미의 기준시각**을 받는다 — 판정 로직은
    표면마다 다르지만(알림=이벤트 스트림+재무장, 스크리너=당일 집합) 허용 범위가
    갈리면 한쪽에서만 저장되는 값이 생긴다. 검증기는 하나로 둔다.
    """
    hh = value // 100
    mm = value % 100
    if hh < 9 or hh > 15 or mm < 0 or mm > 59 or (hh == 15 and mm > 20):  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        raise ValueError("start_hhmm must be between 0900 and 1520 KST")
    return value


class SellTotalRenewalSettings(BaseModel):
    enabled: bool = True
    start_hhmm: int = 1100
    threshold_pct: int = 100
    use_intra_minute_max: bool = True

    @field_validator("start_hhmm")
    @classmethod
    def _valid_hhmm(cls, value: int) -> int:
        return validate_session_start_hhmm(value)

    @field_validator("threshold_pct")
    @classmethod
    def _valid_threshold(cls, value: int) -> int:
        if value < 50 or value > 150:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
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
    """"이 폴더의 **종목 순서**를 이렇게" — 메모는 items 인덱스에 고정된다(v4).

    편집 모달이 쓴다. 그 화면은 메모를 표시하지 않으므로 메모 위치에 의견이 없고,
    의견 없는 표면에 전체 순서를 정하게 하면 어떻게 정하든 조용한 이동이 된다.
    표시 순서 전체를 바꾸는 것은 ItemsReorderRequest(패널 dnd)의 몫이다.
    """

    folder_id: str = Field(pattern=r"^f_[0-9a-f]{8}$")  # v3: reorder is within one real folder
    ordered_codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]]


class CodeItemRef(BaseModel):
    kind: Literal["code"] = "code"
    code: str = Field(pattern=CODE_PATTERN)


class MemoItemRef(BaseModel):
    kind: Literal["memo"] = "memo"
    id: str = Field(pattern=MEMO_ID_PATTERN)


# 요청 전용 판별 유니온 — 프론트 미러는 frontend/src/api/watchlist.ts::WatchlistItemRef.
# 저장 모델(WatchlistItem)과 모양이 비슷하지만 별개다: 여기엔 memo `text` 가 없다
# (재배열은 내용을 옮기지 않는다 — id 로 지목만 한다).
WatchlistItemRef = Annotated[CodeItemRef | MemoItemRef, Field(discriminator="kind")]


class ItemsReorderRequest(BaseModel):
    """"이 폴더의 **표시 순서 전체**를 이렇게" — 코드와 메모를 한 리스트로 받는다(v4).

    패널 dnd 가 쓴다. 폴더의 현재 items 집합과 **정확히 일치**해야 한다(불일치 409) —
    EntriesReorderRequest 와 같은 authoritative-list 계약.
    """

    ordered_items: list[WatchlistItemRef]


class EntriesRemoveRequest(BaseModel):
    codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]]


class MembersRemoveRequest(BaseModel):
    """폴더 **멤버십**을 벌크로 뺀다. `EntriesRemoveRequest` 와 shape 는 같지만 의미가
    다르다 — 저쪽은 모든 폴더에서 빼는 전역 제거이고, 이쪽은 한 폴더에서만 뺀다
    (다른 폴더에 남아 있으면 Watchlist 에 남는다)."""

    codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]]


# --- Heatmap (independent monitoring store, ADR-0068) ----------------------
# Parallel to the Watchlist but WITHOUT capture fields: the heatmap is a
# monitoring board, not a capture target. Folders + the folder/entry request
# bodies above (FolderCreateRequest, EntriesMoveRequest, ...) and
# WatchlistAddRequest are SHARED. Seeded once from the watchlist at first boot,
# then fully independent (no continuous sync).


class HeatmapEntry(BaseModel):
    """One Code IN ONE GROUP on the Heatmap. Mirrors WatchlistEntry MINUS the
    capture markers (registered_at_kst_date / last_success_date) — the heatmap
    drives no captures (ADR-0068). v3 (ADR-0112): folder_id is REQUIRED — every
    entry belongs to a real folder; the 미분류(null) render-group no longer exists.

    Entry identity is the PAIR ``(folder_id, code)``, not the code alone: one
    Code may be registered in several groups at once (multi-group membership).
    A Code is therefore no longer a key into ``entries`` — every command that
    targets one registration (remove / move) must carry the folder too."""

    code: str = Field(pattern=CODE_PATTERN)
    name: str
    folder_id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    order: int = Field(default=0, ge=0)


class HeatmapEntriesMoveRequest(BaseModel):
    """POST /api/heatmap/move body. The watchlist's shared EntriesMoveRequest
    allows folder_id=null; the heatmap has no null group (ADR-0112), so the
    wire itself rejects a null destination (422, not a silent reparent).

    ``from_folder_id`` is REQUIRED because a Code may now live in several groups
    (multi-group membership): without the source group "move 005930 to X" would
    be ambiguous — it could mean any of its registrations. Callers always know
    the row they dragged, so the wire demands it rather than guessing."""

    codes: list[Annotated[str, Field(pattern=CODE_PATTERN)]]
    from_folder_id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    folder_id: str = Field(pattern=r"^f_[0-9a-f]{8}$")


class HeatmapFolderView(BaseModel):
    """Heatmap folder Wire Model. The store may reuse WatchlistFolder, but the
    heatmap wire must not expose member_codes (ADR-0004 Entity≠Wire)."""

    id: str = Field(pattern=r"^f_[0-9a-f]{8}$")
    name: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=0)


class HeatmapDocument(BaseModel):
    """On-disk heatmap.json (v4, ADR-0142). Same envelope discipline as
    WatchlistDocument (ADR-0065 applied independently); entries are
    HeatmapEntry (folder_id required). Folders reuse WatchlistFolder.

    v4 adds ``capture_markers`` — the heatmap became a daily-capture target
    (ADR-0142), so it needs the "latest COMPLETE on disk" marker the watchlist
    keeps on its entries. It canNOT live on ``HeatmapEntry``: entry identity is
    ``(folder_id, code)``, so a Code in three groups would carry three markers
    that drift apart, while the capture itself is keyed ``(code, date)``. A
    code-keyed side table is the only shape that matches the thing it tracks.

    ``registered_at_kst_date`` has NO counterpart here — the watchlist kept it
    solely as the catch-up backfill floor, and catch-up is same-day only since
    ADR-0142. Absent marker = never captured, which is exactly what the UI
    shows for a freshly added Code.
    """

    schema_version: int = 4
    folders: list[WatchlistFolder] = Field(default_factory=list)
    entries: list[HeatmapEntry] = Field(default_factory=list)
    capture_markers: dict[
        Annotated[str, Field(pattern=CODE_PATTERN)],
        Annotated[str, Field(pattern=r"^\d{8}$")],
    ] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _no_dangling_folder_id(self) -> HeatmapDocument:
        valid = {f.id for f in self.folders}
        for e in self.entries:
            if e.folder_id not in valid:
                raise ValueError(
                    f"entry {e.code} references unknown folder {e.folder_id}"
                )
        return self

    @model_validator(mode="after")
    def _unique_within_folder(self) -> HeatmapDocument:
        """The same Code twice in the SAME group is still a bug — across groups
        it is the feature (multi-group membership). Enforcing the pair keeps
        per-folder commands (reorder_entries' ordered_codes, the drag ids)
        keyed by code WITHIN a folder, which is what the whole UI assumes."""
        seen: set[tuple[str, str]] = set()
        for e in self.entries:
            key = (e.folder_id, e.code)
            if key in seen:
                raise ValueError(
                    f"entry {e.code} appears twice in folder {e.folder_id}"
                )
            seen.add(key)
        return self


class HeatmapResponse(BaseModel):
    """GET /api/heatmap.

    ``capture_markers`` is code-keyed while ``entries`` is per-registration —
    the wire mirrors the store rather than exploding the marker onto every row,
    so the frontend cannot accidentally render two different "last collected"
    values for one Code shown in two groups (ADR-0142).

    ``next_run_at_ms`` is shared with the watchlist: since ADR-0142 the same
    17:00 KST daily run enqueues both lists, so the heatmap has a next run.
    """

    folders: list[HeatmapFolderView] = Field(default_factory=list)
    entries: list[HeatmapEntry]
    capture_markers: dict[str, str] = Field(default_factory=dict)
    next_run_at_ms: int


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
    def _check(self) -> ChangePctParams:
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
    def _check(self) -> PriceRangeParams:
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

class DepthPeakPeriodParams(BaseModel):                # 기간내 매도/매수 총잔량 peak 신고
    # ⚠ 형제인 DepthPeakParams 와 `lookback` 의 의미가 **뒤집혀 있다**. 저쪽의
    # lookback 은 "비교 대상 과거 거래일 수"(당일 하나를 지난 N일과 견준다)지만,
    # 여기서는 BreakoutParams·TradeValuePeriodParams 의 지배적 규약을 따라 "기간내"
    # 의 그 기간 — 판정을 시도할 최근 거래일 수다. 비교 기준 창은 `period` 가 진다.
    # 어느 쪽에 맞춰도 한쪽 형제와는 어긋나는 구조라, 조건 이름(`..._period`)이
    # 가리키는 규약(`trade_value_period`·`new_high`)을 택했다.
    lookback: int = Field(ge=1)                        # N: 판정 대상 최근 거래일 수
    period: int = Field(ge=1)                          # M: 각 날의 비교 기준 창(그 날 **제외**)
    # 판정: 최근 N거래일 중 **어느 하루 d 라도** peak(d) ≥ (threshold_pct/100) ×
    # max(peak, d 직전 M거래일). 비율 규약은 DepthPeakParams 와 같다(100=신고 돌파,
    # 동률 포함 · <100=근접 · >100=초과 돌파).
    threshold_pct: float = Field(default=100.0, ge=1)

class DepthRenewalParams(BaseModel):                   # 매도 총잔량 기준시각 돌파 — 당일 전용
    # 판정: start_hhmm 이후 최댓값 ≥ (threshold_pct/100) × 개장~start_hhmm 최댓값.
    # 두 창 모두 유효 스냅샷이 있어야 하며, 이후 창의 **최댓값**으로 보므로 하루 중
    # 한 번이라도 돌파하면 그 뒤 재조회에도 계속 잡힌다(스크리너는 이벤트 스트림이
    # 아니라 집합이다 — 15~30초 폴링 사이에 지나간 순간을 놓치지 않게 하는 것이 요점).
    start_hhmm: int = 1200
    # DepthPeakParams·SellTotalRenewalSettings 와 **같은 식(≥)** 이다. 100 이면 동률도
    # 통과하는데, 이는 신호 정의가 "renews or revisits a high"(signal-alerts 설계)이기
    # 때문 — 매도벽이 그만큼 다시 쌓인 것도 신호다. 엄밀히 더 큰 것만 원하면 101 이상,
    # 근접까지 보려면 100 미만을 쓴다.
    threshold_pct: float = Field(default=100.0, ge=1)

    @field_validator("start_hhmm")
    @classmethod
    def _valid_hhmm(cls, value: int) -> int:
        return validate_session_start_hhmm(value)

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

class AskDepthNewHighPeriodLeaf(BaseModel):
    type: Literal["ask_depth_new_high_period"] = "ask_depth_new_high_period"
    id: str
    params: DepthPeakPeriodParams

class BidDepthNewHighPeriodLeaf(BaseModel):
    type: Literal["bid_depth_new_high_period"] = "bid_depth_new_high_period"
    id: str
    params: DepthPeakPeriodParams

class AskDepthRenewalLeaf(BaseModel):
    type: Literal["ask_depth_renewal"] = "ask_depth_renewal"
    id: str
    params: DepthRenewalParams

class BidDepthRenewalLeaf(BaseModel):
    type: Literal["bid_depth_renewal"] = "bid_depth_renewal"
    id: str
    params: DepthRenewalParams

ConditionLeaf = Annotated[
    TradeValueLeaf | TradeValuePeriodLeaf | NewHighTodayLeaf | NewHighLeaf | NewHighVolTodayLeaf | NewHighVolLeaf | HighOffPeakLeaf | ChangePctLeaf | PriceRangeLeaf | MaLeaf | AskDepthNewHighLeaf | BidDepthNewHighLeaf | AskDepthNewHighPeriodLeaf | BidDepthNewHighPeriodLeaf | AskDepthRenewalLeaf | BidDepthRenewalLeaf,  # noqa: E501 — 줄바꿈이 오히려 읽기 어려운 자리(정렬 표·URL·긴 한글 주석)
    Field(discriminator="type"),
]


# === Saved-screener scan request / response / persistence models ===

class ScreenerUniverse(BaseModel):
    markets: list[Literal["KOSPI", "KOSDAQ"]] = Field(default_factory=list)
    # **기본이 제외다**(2026-08-23 사용자 결정). 유니버스 4,690 중 ETF 1,160 + ETN 370 =
    # 1,530(33%)이 이 축의 사정권인데, 스크리너 조건(거래대금·신고가·이동평균 …)은
    # 개별 기업을 겨눈 것이라 지수·레버리지 상품이 같은 표에서 랭킹되면 상단이 그쪽으로
    # 채워진다.
    #
    # ⚠ **`False` 는 이제 「사용자가 명시적으로 포함시켰다」는 뜻이다.** 프론트가
    # 언체크를 `undefined` 로 정규화하던 규약(키 부재 = 꺼짐)을 같은 PR 에서 걷었다 —
    # 안 걷으면 사용자가 끈 것이 기본값(제외)으로 읽혀 정확히 반대로 동작한다.
    #
    # ⚠ **기존 저장 스크리너는 키가 없어 이 기본값을 따른다** — 즉 결과가 바뀐다.
    # 그것이 이 변경의 목적이다(저장된 것은 결과가 아니라 **질의**이고, 질의는 매번
    # 현재 데이터로 다시 돈다). 되돌리려면 그 스크리너에서 「ETF 제외」를 끄면 된다.
    exclude_etf: bool = True
    exclude_halted: bool = False
    # 조회 유니버스를 캡처 대상 집합으로 좁힌다(빈 리스트 = 전체 시장, 기존 동작).
    # 체크된 스코프의 합집합 ∩ 나머지 필터. 관심∪히트맵은 총잔량 데이터가 정의되는
    # 집합과 동일(screener_depth._depth_universe). 기존 저장본은 키 부재 → default 로
    # 하위호환. 스크리너 실시간 모니터링의 리소스 절감 축(intraday fetch 유니버스 축소).
    scopes: list[Literal["watchlist", "heatmap"]] = Field(default_factory=list)

ScanBasis = Literal["eod", "intraday"]

#: ``POST /api/screener/update`` 가 "작업 없음" 으로 끝난 사유.
#:
#: **달력 실패가 둘로 갈려 있다** — 하나로 뭉치면 화면만 보고 어느 쪽인지 알 수 없다.
#: ``calendar_source_missing`` 은 달력 소스를 못 읽는다는 뜻이라 **배포·로그**를 봐야
#: 하고, ``calendar_coverage_behind`` 는 시드 이후 구간을 밀어 주는 **스케줄러가
#: 멎었다**는 신호다. 둘 다 재시도로 풀리지 않으므로 안내도 달라야 한다.
#: (PR-H·#1044 이전에는 원격 조회라 "일시 장애 → 잠시 후 재시도" 가 맞았다.
#: 지금은 조회 경로에 벤더가 없어 그 사건 자체가 없다 — `hoga/api/trading_days.py`.)
ScreenerUpdateSkipReason = Literal[
    "no_gap",
    "not_seeded",
    "creds_missing",
    "calendar_source_missing",
    "calendar_coverage_behind",
]


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
    # 기준시각 돌파 조건(ask/bid_depth_renewal) 전용 — 개장~기준시각 / 기준시각~현재의
    # 당일 최댓값. peak 조건의 ask_today/ask_past_peak 과 **의미가 다르므로** 필드를
    # 나눈다(그쪽 배지는 "지난 N일 peak" 이라고 쓴다 — 여기 값을 끼우면 문구가 거짓이
    # 된다). 조건이 없으면 None 이고, 그때 배지는 그 행을 그리지 않는다.
    #
    # 기준시각도 side 별이다. 매도 12:00 · 매수 13:00 처럼 섞어 쓸 수 있는데 한 벌만
    # 실으면 한쪽 배지가 남의 시각을 달고 나온다 — peak 조건이 ask_need_days/
    # bid_need_days 로 같은 문제를 푼 것과 같은 이유다.
    ask_pre_max: int | None = None
    ask_post_max: int | None = None
    ask_renewal_start_hhmm: int | None = None
    bid_pre_max: int | None = None
    bid_post_max: int | None = None
    bid_renewal_start_hhmm: int | None = None

class ScreenerResponse(BaseModel):
    status: Literal["ok", "not_seeded", "building"]
    rows: list[ScreenerRow]
    #: 상태 태그의 평평한 목록 — 장중 오버레이·depth·ETF 필터가 한 평면에 섞이므로
    #: 접두(`intraday_` 등)가 네임스페이스 역할을 한다.
    warnings: list[str] = Field(default_factory=list)
    #: 장중 오버레이가 실패했을 때의 **구조화된 사유**(ADR-0143). `make_data_warning`
    #: 산출이라 `reason`·`kind`·`is_failure` 를 담고 **접두가 없다** — 위 배열과 달리
    #: 자체 필드라 이름이 충돌하지 않는다. 실패가 없으면 None.
    intraday_failure: dict | None = None
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

# ── 봉 패턴 검색 (ADR-0166) ────────────────────────────────────────────────────

#: 검색 모드. `now` = 각 종목의 최신 L봉 한 창 · `history` = 전 기간 슬라이딩.
#: **다른 기능이다** — now 는 여러 길이를 한 응답에 담고, history 는 길이 하나에
#: 이후 수익률·베이스라인을 붙인다.
PatternSearchMode = Literal["now", "history"]
#: 이평 프리셋. 이름이 「무엇을 찾는지」를 말한다 — `short` 는 단기 배열 속의 캔들,
#: `mid` 는 중기 추세 속의 캔들이다. 값을 늘리면 `hoga/api/screener_pattern.py` 의
#: `MA_PRESETS` 와 프론트 union 을 **같은 PR 에서** 고친다(ADR-0004).
PatternMaPreset = Literal["off", "short", "mid"]

#: 구조 게이트의 **기준선**을 어디서 잡는가 (ADR-0166 결정 13).
#:
#: * `running` — 봉마다 올라가는 「직전까지 최고/최저」.
#: * `first2` — **첫 두 봉의 최고/최저로 고정**. 「첫 두 봉이 만든 선을 뒤 봉들이
#:   시험한다」가 질문일 때 정확하다.
#:
#: 하나를 고르지 않는 이유는 **어느 쪽이 선택적인지가 쿼리마다 뒤집히기** 때문이다
#: (실측: 삼천당제약 5봉 97 vs 108창인데 삼성전자 7봉은 12 vs **440**창).
PatternStructAnchor = Literal["running", "first2"]

#: 봉 패턴 검색의 **봉 단위**. `"W"` 코퍼스는 일봉에서 파생한다 — 종목 주봉을 주는
#: 벤더 경로가 없다(키움 W/M TR 은 지수 전용).
#:
#: ⚠ **부재는 `"D"` 다.** 저장된 검색에 이 값이 없으면 일봉으로 읽어야 기존 저장이
#: 산다(#1711 의 「부재는 공장값을 따른다」와 같은 규칙).
#:
#: ⚠ 값을 늘리면 프론트 union 도 **같은 PR 에서** 고친다(ADR-0004). 그 대조는
#: `WIRE_ENUM_MIRRORS` 에 등록돼 있다.
PatternTimeframe = Literal["D", "W", "M"]

#: 결과가 **왜 비었는가**. `results` 가 빈 응답에만 실린다.
#:
#: 이 값이 없던 시절 프론트는 빈 응답 하나를 「그은 구간에 해당하는 일봉이 없다」로
#: 번역했는데, 서버가 그 문장으로 답하는 경로는 **넷**이라 서로 다른 실패가 한 문장에
#: 뭉쳤다(조사 2026-09-04). 특히 `window` 는 「차트엔 캔들이 보이는데 코퍼스는 그
#: 종목의 그 시기를 안 담는다」인데, 그 사실을 화면이 말할 방법이 아예 없었다 —
#: 사용자는 기간·모드·봉수를 아무리 바꿔도 같은 문장을 봤다.
#:
#: * `code_missing` — 코퍼스에 그 종목 계열이 없다. **드로어의 어떤 조작도 못 고친다.**
#: * `window` — 요청한 구간/길이에 코퍼스 봉이 모자라거나(5 미만) 너무 많다(30 초과).
#:   `coverage_from`/`coverage_to` 가 그 종목의 검색 가능 구간을 말한다.
#: * `flat` — 쿼리 창이 평탄하거나 이평 워밍업이 안 찼다(`query_vector` → None).
#:   둘은 서버에서 구별되지 않으므로 문구도 구별하지 않는다.
#: * `no_candidates` — 비교할 후보 창이 하나도 안 남았다(기간·거래대금·forward 필터).
#:   **기간을 넓히면 풀린다** — 넷 중 유일하게 조건으로 구제되는 값이다.
#:
#: ⚠ 값을 늘리면 프론트 union 도 **같은 PR 에서** 고친다(ADR-0004). 그 대조는
#: `WIRE_ENUM_MIRRORS` 에 등록돼 있다.
PatternEmptyReason = Literal["code_missing", "window", "flat", "no_candidates"]

#: 봉 패턴 창의 길이 한계. 하한 5 는 사용자 요구("캔들 5~10개")의 최소이고, 상한 30 은
#: 응답 시간을 바운드한다(history 는 길이당 ~0.4s).
PATTERN_MIN_BARS = 5
#: 상한은 응답 시간을 바운드한다. ⚠ 이 검증은 요청이 길이를 **말할 때만** 걸린다 —
#: `from`/`to` 경로는 길이를 구간에서 뽑으므로 `screener_pattern.PATTERN_CEILING` 이
#: 같은 값을 따로 지킨다. 둘을 함께 고칠 것.
PATTERN_MAX_BARS = 30
#: `now` 가 한 요청에 담을 수 있는 길이 개수 — 프론트 봉수 스크럽의 전제(ADR-0166 결정 3).
PATTERN_MAX_LENGTHS = 11
#: 구조 게이트의 허용 불일치 상한. 화면은 0~3 만 열고, 그 위는 「사실상 끄기」라 열지
#: 않는다(실측 5봉·20관계: 0→92 · 1→1,113 · 2→6,191 · 3→20,965 창).
PATTERN_STRUCT_MAX_TOLERANCE = 10


class PatternSearchRequest(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    mode: PatternSearchMode = "now"
    #: 비교할 봉수들. `history` 는 첫 값만 쓴다(길이당 비용이 커서 묶지 않는다).
    lengths: list[int] = Field(default_factory=lambda: [7])
    #: 쿼리 구간을 날짜로 지정(둘 다 주거나 둘 다 비운다). 비우면 **최신 L봉**이다.
    from_: str | None = Field(None, alias="from", pattern=r"^\d{8}$")
    to: str | None = Field(None, pattern=r"^\d{8}$")
    top: int = Field(15, ge=1, le=100)
    min_tv_eok: float = Field(10.0, ge=0)
    exclude_etf: bool = True
    #: `history` 전용 — 쿼리와 날짜가 겹치는 창을 뺀다. 안 빼면 동시대 매치가 상위를
    #: 지배한다(ADR-0166 결정 2).
    no_overlap: bool = True
    #: 이후 수익률의 지평(거래일). `history` 에서만 의미가 있다.
    forward_days: int = Field(20, ge=1, le=120)
    #: `history` 전용 — 한 종목에서 남길 매치 수. 1 은 다양성, 늘리면 "그 패턴이 나온
    #: 자리를 전부" 본다. 두 번째부터는 겹침 배제(창 길이의 절반)가 걸린다.
    per_code: int = Field(1, ge=1, le=5)
    #: `history` 전용 — 이 날짜(YYYYMMDD) **이후**에 시작하는 창만 본다.
    #:
    #: ⚠ 이것만 서버에 온다. 유사도 하한·결과 수는 **프론트가 받아 둔 결과를 자르는**
    #: 것이라 서버 파라미터가 아니다 — 기간은 **후보 모집단을 바꾸고**, 나머지 둘은
    #: **이미 뽑은 결과를 자른다**. 이 구분이 흐려지면 "40개 중 자르기" 와 "모집단
    #: 자르기" 가 한 필드에 섞인다.
    since: str | None = Field(None, pattern=r"^\d{8}$")
    #: 길이 유연 검색의 폭(±봉). 0 이면 끈다.
    #:
    #: 「7봉 패턴이 10봉에 걸쳐 나타난 것」 을 찾는 요구의 답이다. **DTW 가 아니라**
    #: 쿼리를 시간축으로 리샘플해 길이별로 같은 커널을 돌린다 — 심은 신축 사본을
    #: corr 1.0 으로 잡고 비용이 DTW 전수의 1/12 다(ADR-0166 결정 10).
    #:
    #: ⚠ 잡는 것은 **균일 신축**뿐이다. 앞은 빠르고 뒤는 느린 국소 신축은 DTW 만 잡는다.
    flex_bars: int = Field(0, ge=0, le=5)
    #: 거래량 축의 비중(0~1). 0 이면 가격만 — 그때 거래량 계산은 **아예 돌지 않는다**.
    #: 유사도가 `가격 상관 × (1-w) + 거래량 상관 × w` 가 되며, **w 는 화면의 스위치**다
    #: (서버가 발명한 상수가 아니다 — ADR-0166 결정 9).
    volume_weight: float = Field(0.0, ge=0, le=1)
    #: 이평선을 매칭 축에 넣을지. 「캔들이 5·20 이평을 끼고 있다」 같은 형세가 매치에
    #: 전달된다 — 실측으로 그 배치가 상위 20 중 4.5개 → 12.8개로 늘고, 정배열/역배열은
    #: **20/20** 으로 갈린다(캔들만 보면 6~14/20 = 우연 수준).
    #:
    #: 이평은 거래량과 달리 **가격과 같은 축**이라 공유 스케일에 그대로 섞인다
    #: (별도 정규화하면 7봉 창의 MA20 은 거의 직선이라 위치가 사라진다).
    #:
    #: ⚠ **자유 조합을 열지 않는다.** 조합마다 답이 크게 갈리지만(5·20 대비 20·60 은
    #: 상위 20 중 3개만 겹친다) 그건 판별력이 아니라 **질문이 바뀌는 것**이고,
    #: 체크박스는 그 사실을 화면에서 말해 주지 못한다(ADR-0166 결정 11).
    ma_preset: PatternMaPreset = "off"
    #: 구조 게이트 — 쿼리 창의 «봉별 색·전고·전저 관계» 부호열과 **몇 개까지 달라도**
    #: 후보로 남길지. `None` 이면 끈다(서명 계산 자체를 안 한다).
    #:
    #: 게이트이지 점수가 아니다 — 통과한 창의 순서는 여전히 상관이고, `dist`·`baseline` 은
    #: 통과 **전** 모집단이다(ADR-0166 결정 12). 상관이 원리적으로 못 보는 국소 부등식
    #: (「고가는 전고를 넘었는데 종가는 못 넘었다」)을 이 축이 본다.
    struct_tolerance: int | None = Field(None, ge=0, le=PATTERN_STRUCT_MAX_TOLERANCE)
    #: 구조 게이트의 기준선 방식. `struct_tolerance` 가 `None` 이면 아무 뜻이 없다.
    struct_anchor: PatternStructAnchor = "running"
    #: 봉 단위. 코퍼스가 이 값으로 갈린다(주봉은 일봉에서 파생).
    #:
    #: ⚠ **길이·기간·수익률 지평은 전부 «봉» 을 센다.** 그래서 같은 `forward_days=20`
    #: 이 일봉에서 20일, 주봉에서 **20주**다. 필드 이름이 「일」이라 오해하기 쉬운데
    #: 코드는 `min_after` 로 봉을 세고, 라벨과 timeframe 별 공장값은 프론트가 갖는다.
    timeframe: PatternTimeframe = "D"

    model_config = ConfigDict(populate_by_name=True)

    @field_validator("lengths")
    @classmethod
    def _valid_lengths(cls, v: list[int]) -> list[int]:
        if not v:
            raise ValueError("lengths must not be empty")
        if len(v) > PATTERN_MAX_LENGTHS:
            raise ValueError(f"at most {PATTERN_MAX_LENGTHS} lengths")
        for n in v:
            if not (PATTERN_MIN_BARS <= n <= PATTERN_MAX_BARS):
                raise ValueError(f"length must be {PATTERN_MIN_BARS}..{PATTERN_MAX_BARS}")
        if len(set(v)) != len(v):
            raise ValueError("lengths must be unique")
        return sorted(v)

    @model_validator(mode="after")
    def _valid_range(self):
        if (self.from_ is None) != (self.to is None):
            raise ValueError("from and to must be given together")
        if self.from_ is not None and self.to is not None and self.from_ > self.to:
            raise ValueError("from must be <= to")
        return self


#: 저장된 검색의 **기준 종류**.
#:
#: 이 값이 불러오기의 갈림길이다 — `recent` 는 「최근 N봉」 이라 **불러올 때마다 오늘
#: 기준으로 다시 계산**되고, `fixed` 는 그 날의 구간이라 **모양이 고정**된다.
#: 사용자가 고르는 값이 아니라 **저장 시점에 하고 있던 것**이 그대로 담긴다.
PatternSaveKind = Literal["recent", "fixed"]


class PatternSaveWindow(BaseModel):
    """기준 창. 종류에 따라 채워지는 필드가 다르다 — 둘 다 채우지 않는다."""

    kind: PatternSaveKind
    #: `recent` 전용 — 최신 몇 봉인가.
    bars: int | None = Field(None, ge=PATTERN_MIN_BARS, le=PATTERN_MAX_BARS)
    #: `fixed` 전용 — 그 날의 구간(YYYYMMDD).
    from_date: str | None = Field(None, pattern=r"^\d{8}$")
    to_date: str | None = Field(None, pattern=r"^\d{8}$")

    @model_validator(mode="after")
    def _shape_matches_kind(self):
        if self.kind == "recent":
            if self.bars is None:
                raise ValueError("recent window needs bars")
        elif self.from_date is None or self.to_date is None:
            raise ValueError("fixed window needs from_date and to_date")
        elif self.from_date > self.to_date:
            raise ValueError("from_date must be <= to_date")
        return self


class PatternSaveConditions(BaseModel):
    """화면의 조건 묶음 그대로. **결과는 담지 않는다** — 코퍼스가 매일 자라므로
    「그때 나온 매치」 는 재현이 아니라 스냅샷이고, 저장되는 것은 질문이지 답이 아니다."""

    mode: PatternSearchMode = "history"
    #: 기간(YYYYMMDD). 없으면 전체.
    since: str | None = Field(None, pattern=r"^\d{8}$")
    count: int = Field(40, ge=1, le=100)
    #: 유사도 하한 — 프론트가 받아 둔 목록을 자르는 값이라 검색 요청에는 안 실린다.
    sim_floor: float = Field(0.0, ge=0, le=1)
    min_tv_eok: float = Field(10.0, ge=0)
    exclude_etf: bool = True
    no_overlap: bool = True
    per_code: int = Field(5, ge=1, le=5)
    volume_weight: float = Field(0.0, ge=0, le=1)
    #: 이평 프리셋. 유사도 자체를 바꾸는 조건이라 빠지면 **다른 검색이 복원된다**.
    #:
    #: ⚠ **`None` 은 「끄기」가 아니라 「그 축이 없던 시절의 저장」이다.** 부재와 선택은
    #: 다른 계약이라(CLAUDE.md), 기본값으로 `"off"` 를 채우면 두 의미가 뭉개진다 —
    #: 실제로 이평 기능 이전의 저장을 불러오니 이평이 꺼진 채 복원됐다(2026-09-02).
    #: 화면은 `None` 을 **공장값**으로 읽는다. 새 저장은 항상 값을 담으므로, 일부러 끈
    #: 저장은 `"off"` 로 남아 그대로 복원된다.
    ma_preset: PatternMaPreset | None = None
    #: 봉 단위. **`None` 은 「주봉이 없던 시절의 저장」**이고 화면은 그것을 공장값(일봉)
    #: 으로 읽는다 — `ma_preset` 과 같은 규칙이다. 새 저장은 항상 값을 담는다.
    timeframe: PatternTimeframe | None = None
    #: 길이 유연 폭(±봉). `None` 의 뜻은 위 `ma_preset` 과 같다.
    flex_bars: int | None = Field(None, ge=0, le=5)
    #: 구조 게이트 허용 불일치. **`None` 이 「끄기」와 「그 축이 없던 시절의 저장」을 겸한다**
    #: — 공장값이 끄기라 오늘은 두 뜻이 같은 결과다.
    #:
    #: ⚠ 공장값을 켜는 쪽으로 바꾸면 그 순간 `ma_preset` 사고가 재현된다(옛 저장이 전부
    #: 켜진 채 되살아나거나, 일부러 끈 저장이 켜진다). 그때는 부재와 끄기를 **분리해서**
    #: 표현해야 한다 — 이 필드의 `None` 을 그대로 두고 공장값만 바꾸지 말 것.
    struct_tolerance: int | None = Field(None, ge=0, le=PATTERN_STRUCT_MAX_TOLERANCE)
    #: 기준선 방식. `None` 은 **「그 축이 없던 시절의 저장」**이고 화면이 공장값으로 읽는다
    #: (`ma_preset` 과 같은 규칙 — 공장값이 `running` 이라 오늘은 부재와 결과가 같다).
    struct_anchor: PatternStructAnchor | None = None


class PatternExclusion(BaseModel):
    """저장된 검색에서 **빼 둔 한 자리**. 종목이 아니라 「그 종목의 그 기간」이다.

    길이는 키에 넣지 않는다. 유연 검색이면 같은 (종목, 시작일)이 길이별로 여러 행이 되고
    (실측 500행 중 96건), 길이까지 맞춰 빼면 하나만 사라지고 다른 길이가 남아
    **「지웠는데 또 나온다」**가 된다.

    `from_date` 가 있으면 **그 자리 하나**, 없으면(`None`) **그 종목 전부**다. 자리만 빼면
    같은 종목의 다른 날짜는 남는데 — 상위 100 밖에 그런 자리가 15개 대기 중이라(실측)
    하나를 빼면 그 종목이 다른 날짜로 올라올 수 있다 — 그게 거슬리는 사용자를 위해
    종목 단위가 함께 있다(2026-09-03).
    """

    code: str = Field(pattern=CODE_PATTERN)
    #: 뺀 자리의 시작일. **`None` 이면 그 종목 전부**다.
    #:
    #: 두 뜻을 한 필드에 둔 이유는 복원 목록이 하나여야 하기 때문이다 — 목록을 둘로
    #: 나누면 「숨김 N」이 무엇의 N 인지 흐려지고, 되돌리기도 두 갈래가 된다.
    from_date: str | None = Field(None, pattern=r"^\d{8}$")
    #: 복원 목록이 이름을 보여주려고 함께 담는다 — 저장이 `stock_name` 을 담는 것과 같은 이유
    #: (그때마다 마스터를 조회하지 않는다).
    stock_name: str = ""


class PatternSaveWriteRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    code: str = Field(pattern=CODE_PATTERN)
    #: 저장 시점의 종목명 — 목록이 **종목별로 묶이고** 검색이 이름·종목을 함께 훑으므로
    #: 그때마다 마스터를 조회하지 않게 함께 담는다.
    stock_name: str = ""
    window: PatternSaveWindow
    conditions: PatternSaveConditions
    #: 결과에서 빼 둔 자리들. **`conditions` 밖에 있는 것이 계약이다** — 조건은 「질문」이고
    #: 이것은 「답의 편집」이라, 조건 복원(`loadSave`)이 이걸 조건으로 오해하면 안 된다.
    #:
    #: `| None` 이 아니라 `= []` 다. `ma_preset` 과 달리 **부재와 「비어 있음」이 같은 뜻**인
    #: 유일한 경우다 — 「한 번도 안 뺐다」와 「뺀 게 없다」는 구별할 이유가 없다.
    excluded: list[PatternExclusion] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("name must not be blank")
        return stripped


class PatternSave(PatternSaveWriteRequest):
    id: str
    created_at_ms: int
    updated_at_ms: int


class PatternSavesFile(BaseModel):
    schema_version: int = 1
    saves: list[PatternSave] = Field(default_factory=list)


class PatternDistribution(BaseModel):
    """후보 점수 분포. **유사도 절대값을 단독으로 내지 않기 위한 동반 데이터**다
    (ADR-0166 결정 7) — 1위 0.986 은 "98.6% 닮음" 이 아니라 "비교한 것 중 최고" 다."""

    p50: float
    p95: float
    p99: float
    #: `history` 에서만 유의미하다(후보창이 수백만이라 이 분위수가 매치의 대조군이 된다).
    p99_99: float | None = None
    #: 이 분포를 만든 표본 수 — now 는 종목 수, history 는 창 수다.
    sample: int


class PatternBaseline(BaseModel):
    """전 후보창의 이후 수익률. 프론트가 **끌 수 없는 표시**로 만든다(ADR-0166 결정 7)."""

    fwd_median_pct: float
    fwd_win_rate_pct: float
    sample: int


class PatternMatchRow(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    name: str
    from_date: str = Field(pattern=r"^\d{8}$")
    to_date: str = Field(pattern=r"^\d{8}$")
    corr: float
    #: 매치 구간의 원가격 봉 — `[open, high, low, close]` 가 길이 L 만큼. 썸네일용이다.
    bars: list[list[float]]
    #: `history` 전용 — 매치 **뒤** `forward_days` 봉의 종가. 「그 다음에 뭐가 왔나」가
    #: 이 기능의 핵심 질문이라 라인으로 이어 그린다. 계열 끝이면 짧거나 비어 있다.
    tail: list[float] | None = None
    #: `history` 전용 — `forward_days` 봉 뒤 수익률(%). 계열을 넘으면 null.
    forward_pct: float | None = None
    #: 이평 프리셋이 켜졌을 때만 — 기간별 **원가격** 이평값. 바깥 리스트가
    #: `PatternLengthResult.ma_periods` 와 **같은 순서**다. 썸네일이 이 선을 함께 그려야
    #: 왜 매치됐는지 보인다(캔들만 보면 이평 관계는 화면에 없다).
    ma: list[list[float]] | None = None
    #: 구조 게이트가 켜졌을 때만 — 이 창이 쿼리 부호열과 맞춘 관계 수. 분모는
    #: `PatternLengthResult.struct_total`. 꺼져 있으면 null(계산 자체를 안 한다).
    struct_match: int | None = None
    #: 구조 게이트가 켜졌을 때만 — 이 창이 **못 맞춘** 관계들의 인덱스
    #: (`PatternLengthResult.struct_relations` 의 인덱스). 완전 일치면 빈 목록. 허용을
    #: 열어 부분 일치가 섞일 때 「이 행이 왜 여기 있나」를 이름으로 답하는 데이터다.
    struct_miss: list[int] | None = None


class PatternQueryWindow(BaseModel):
    length: int
    from_date: str = Field(pattern=r"^\d{8}$")
    to_date: str = Field(pattern=r"^\d{8}$")
    bars: list[list[float]]
    #: 매치 행과 같은 규칙 — `ma_periods` 순서의 원가격 이평값.
    ma: list[list[float]] | None = None


class PatternLengthResult(BaseModel):
    """길이 하나의 결과. `now` 는 이 원소가 요청한 길이 수만큼 온다."""

    length: int
    query: PatternQueryWindow
    #: 이 결과에 실린 이평 기간들. 빈 리스트면 이평을 안 썼다는 뜻이고, 값이 있으면
    #: 매치·쿼리의 `ma` 바깥 리스트가 **이 순서**다.
    ma_periods: list[int] = []
    universe: int
    dist: PatternDistribution
    matches: list[PatternMatchRow]
    #: `history` 에서만 값이 있다. `now` 는 이후 수익률이라는 개념 자체가 없다(최신
    #: 창이라 「이후」가 미래다). **null 로 싣는다** — `response_model_exclude_none` 을
    #: 걸면 `PatternMatchRow.forward_pct` 의 정당한 null 까지 지워진다(CLAUDE.md).
    baseline: PatternBaseline | None = None
    #: 이 결과의 **마지막 봉이 미완성**이면 그 봉이 담은 거래일 수, 아니면 null.
    #:
    #: 주봉에서 수요일이면 마지막 봉은 3일치다. 화면이 그 봉을 그리므로 코퍼스도 담지만
    #: (빼면 `now` 가 사용자가 보고 있지 않은 질문에 답한다), **모든 매치의 마지막 봉이
    #: 같은 방식으로 왜곡**되므로 화면이 그 사실을 말할 수 있어야 한다. 실측상 포함/제외로
    #: `now` top20 이 10~16/20 만 겹친다.
    #:
    #: `now` 에서만 값이 있다 — `history` 의 창은 과거라 전부 완성이다. 일봉은 항상 null.
    partial_last_bucket_days: int | None = None
    #: 구조 게이트가 켜졌을 때만 — 판정에 들어간 관계 수(쿼리에서 부호가 0 인 관계는
    #: 뺀 뒤의 값이라 길이만으로 정해지지 않는다). 꺼져 있으면 null.
    struct_total: int | None = None
    #: 구조 게이트가 켜졌을 때만 — 인덱스 k 에 「k 개 맞춘 후보창 수」. 게이트를 걸기 **전**
    #: 모집단(다른 필터는 다 지난 창들)이라, 팝오버가 「이 단계를 고르면 몇 개 남나」를
    #: 재검색 없이 센다. 길이 `struct_total + 1`.
    struct_hist: list[int] | None = None
    #: 구조 게이트가 켜졌을 때만 — 관계마다 **쿼리가 기대하는 것**(「5봉 저가 > 전저」).
    #: 행의 `struct_miss` 가 이 목록의 인덱스다. 판정에서 뺀 관계(부호 0)도 자리를 지켜
    #: 길이가 `1 + 5(L−1)` 이다 — `struct_total` 과 다를 수 있다.
    struct_relations: list[str] | None = None
    elapsed_ms: float


class PatternSearchResponse(BaseModel):
    code: str = Field(pattern=CODE_PATTERN)
    name: str
    mode: PatternSearchMode
    #: 이 결과가 어느 봉 단위인가. 요청이 말한 값이지만 **응답도 싣는다** — 결과 행을
    #: 눌렀을 때 착지할 창의 timeframe 이고, 저장에도 그대로 담긴다.
    timeframe: PatternTimeframe = "D"
    results: list[PatternLengthResult]
    #: `results` 가 비었을 때 **왜** 비었는가. 결과가 있으면 `None` 이다.
    #:
    #: ⚠ `None` 과 부재를 구별할 필요가 없어 보이지만, 이 라우트에
    #: `response_model_exclude_none` 을 걸면 안 된다 — 아래 커버리지의 `None` 이
    #: 「그 종목이 코퍼스에 없다」는 **정보**이고, 지우면 「모른다」와 구별되지 않는다.
    empty_reason: PatternEmptyReason | None = None
    #: 이 종목이 코퍼스에서 **검색 가능한 구간**(YYYYMMDD). 종목이 코퍼스에 있으면
    #: 결과 유무와 무관하게 늘 싣는다.
    #:
    #: 이게 이 응답에서 가장 값진 필드다: 차트가 읽는 벤더 일봉과 코퍼스의 종목별
    #: 커버리지가 **다르다**(실측 2026-09-04 — 두산·CJ대한통운은 차트에 2019년 봉이
    #: 보이는데 코퍼스는 2024-01-02 부터다. ETF 제외 2,794종목 중 2019년 이전 구간은
    #: 48.2%가 이 상태). 화면이 그 경계를 말하지 못하면 사용자는 원인을 짚을 수 없다.
    #: 코퍼스가 야간 갱신이라 **오늘 봉이 없는** 경우도 같은 문장이 설명한다.
    coverage_from: str | None = Field(None, pattern=r"^\d{8}$")
    coverage_to: str | None = Field(None, pattern=r"^\d{8}$")


class SavedScreenersFile(BaseModel):
    schema_version: int = 1
    saves: list[SavedScreener] = Field(default_factory=list)


LiveTimeframeModel = Literal[
    "1m", "3m", "5m", "10m", "15m", "30m", "60m", "120m", "240m", "D", "W", "M"
]

#: `/api/range` 의 `mode` — **어떤 슬라이스 집합을 만드느냐**를 고르는 값이다.
#:
#: 여기 alias 로 둔 것은 두 가지를 위해서다. ① 라우트의 Query 검증이 이 목록에서
#: 파생되어 둘이 갈릴 수 없다. ② `WIRE_ENUM_MIRRORS`(ADR-0004 2층)가 프론트 union 과
#: 값을 대조할 수 있다 — 정규식 pattern 은 `get_args` 로 읽을 수 없어 가드 밖이었다.
#:
#: 퇴역한 값 `"full"` 은 2026-07-08 dead-path 제거로 사라졌다(WS2). 백엔드는 그때
#: 422 회귀 테스트까지 세웠지만 프론트 union 은 따라오지 않았고, 이 alias 가 없어
#: 2층 가드가 그 드리프트를 못 봤다.
RangeMode = Literal["hoga", "sidecar", "candles"]


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


# ── Live layout presets (ADR-0114 §4 → ADR-0119 PR-E → ADR-0159) ──────────
# 프리셋 = **창 목록·z순서**(배치) + 차트 창의 지표 세트. 뷰포트·비영속 런타임은
# 담지 않는다(§6).
# 서버는 **얕은 구조 검증만** 하고 키셋을 강제하지 않는다 — 적용 시 프론트가 canonical
# 재정규화(readWindow 재사용)하므로 새 창 kind/지표 필드 추가에 백엔드 변경이 없다.
# ADR-0159 가 그 설계를 실제로 썼다: 차트 창 원소에 `indicators`·`indicatorModal` 이
# 붙었지만 이 파일은 그대로다(아래 `dict[str, Any]` 통과).
# **schema_version 을 올리지 말 것** — 스토어의 stale 버전 가드가 불일치 시 파일을
# 빈 목록으로 대체하므로, 창 원소에 선택 키를 더하는 하위호환 변경에 버전을 올리면
# 사용자의 프리셋이 **전부 사라진다**. v3 안에서 양방향 호환이다(구 프론트는 모르는
# 키를 화이트리스트에서 무시하고, 새 프론트는 키 부재를 레거시로 읽는다).
# payload 는 프론트-네이티브 camelCase 스냅샷을 그대로 담는 얕은 컨테이너다.
class LiveLayoutPresetPayload(BaseModel):
    # windows 원소는 자유 구조(창 kind별 chart 설정 등) → dict 통과.
    windows: list[dict[str, Any]] = Field(default_factory=list)
    zOrder: list[str] = Field(default_factory=list)
    # 구 v3 의 그룹→종목. 프론트가 더 이상 쓰지 않는다(저장은 빈 객체, 적용은 무시) —
    # 배치를 바꾸려고 누른 프리셋이 보던 종목까지 교체하던 동작을 철회했다.
    # 지워도 옛 payload 는 그대로 로드된다(모르는 키는 조용히 무시된다) — 남기는 이유는
    # 프론트 미러가 아직 이 필드를 선언하고 있어서다(ADR-0004: 지우려면 wire 스냅샷과
    # 미러를 같이 손대야 하는데, 얻는 것이 없다). 저장된 값은 apply 시점에 버려진다.
    groupSymbols: dict[str, dict[str, Any]] = Field(default_factory=dict)


class LiveLayoutPresetWriteRequest(BaseModel):
    name: str
    payload: LiveLayoutPresetPayload
    # 낙관적 동시성 제어(PUT 전용, POST 는 무시). 클라이언트가 읽었던 시점의
    # updated_at_ms 를 실어 보내면, 그 사이 다른 탭·기기가 먼저 저장한 경우 409 로
    # 거절한다 — 낡은 워크스페이스 스냅샷이 조용히 최신본을 덮어쓰는 것을 막는다.
    # 생략(None) 시 종전대로 무조건 덮어쓴다(구 클라이언트 하위호환).
    expected_updated_at_ms: int | None = None

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


# ── 옵션 심리 패널 (ADR-0135) ────────────────────────────────────────────────
# 계층별 as_of 를 따로 싣는 이유: 전수(5분)와 ATM(30초)의 관측 시각이 다르다.
# 하나로 뭉치면 5분 전 GEX 와 30초 전 P/C 가 같은 시각으로 표시되어 오독을 부른다.


class PutCallRatioModel(BaseModel):
    volume_ratio: float | None
    oi_ratio: float | None
    call_volume: int
    put_volume: int
    call_oi: int
    put_oi: int


class StrikeOiModel(BaseModel):
    strike: float
    call_oi: int
    put_oi: int


class OiDistributionModel(BaseModel):
    strikes: list[StrikeOiModel]
    max_pain: float | None


class GexPointModel(BaseModel):
    strike: float
    gex: float


class GammaExposureModel(BaseModel):
    points: list[GexPointModel]
    total: float
    flip_strike: float | None


class IvPointModel(BaseModel):
    strike: float
    call_iv: float | None
    put_iv: float | None
    #: 행사가 미결제 합 — IV 신뢰도. 화면이 저유동성 포인트의 투명도를 감쇠한다.
    oi: int = 0


class IvSkewModel(BaseModel):
    points: list[IvPointModel]
    atm_iv: float | None
    risk_reversal_25d: float | None


class PutCallSeriesPointModel(BaseModel):
    t_ms: int
    volume_ratio: float | None
    oi_ratio: float | None


class OptionSentimentResponse(BaseModel):
    #: 휴면 사유. None 이 아니면 나머지 필드는 비어 있을 수 있다.
    unavailable: str | None = None
    expiry: str | None = None
    #: 근월물 체인 종목 수. 만기마다 다르므로(202608=780·202609=1012) 화면이
    #: 대기 안내 문구를 이 값으로 만든다 — 상수로 박으면 롤오버 때 조용히 틀린다.
    chain_size: int | None = None
    underlying: float | None = None
    #: 전 행사가 스냅샷 관측 시각 — Max Pain·GEX 의 as_of.
    full_as_of_ms: int | None = None
    #: ATM 창 스냅샷 관측 시각 — P/C·IV 스큐의 as_of.
    atm_as_of_ms: int | None = None
    put_call: PutCallRatioModel | None = None
    #: 당일 P/C 시계열(전수 5분마다 한 점, KST 자정 리셋, 프로세스 메모리 한정).
    put_call_series: list[PutCallSeriesPointModel] = Field(default_factory=list)

    oi_distribution: OiDistributionModel | None = None
    gamma_exposure: GammaExposureModel | None = None
    iv_skew: IvSkewModel | None = None
