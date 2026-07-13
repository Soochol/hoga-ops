"""Page Step pagination loop for hogaplay first.php + chart.php capture."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import time as _time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Protocol

from hoga.api.timeenc import HogaMs
from hoga.collector.client import HogaplayHTTPError
from hoga.collector.timing import CaptureTimingCollector
from hoga.collector.page_step import (
    DATA_WINDOW_END_MS,
    DEFAULT_PAGE_STEP_MS,
    MIN_PAGE_STEP_MS,
    PageStepController,
    StopReason,
)

# Time constants — HogaMs (HHMMSSmmm) per ADR-0003. The type alias makes
# the encoding explicit at every call site, so Pyright catches accidental
# Unix-ms mixups (the relevant footgun once Plan B adds worker pools).
DATA_WINDOW_START_MS: HogaMs = HogaMs(84000000)   # 08:40:00.000
CHART_FINAL_TIME_MS: HogaMs = HogaMs(153100000)   # 15:31:00.000

# Field index constants for TSV row parsing.
_IDX_GLOBAL_SEQ = 3
_IDX_EVENT_TIME = 4
_MIN_FIELDS_EVENT_TIME = 5
_MIN_FIELDS_GLOBAL_SEQ = 4

# Default sleep between consecutive first.php requests. 0.05 adopted by
# ADR-0017 (Phase 1 matrix sweep). Lowering this further (toward 0) increases
# throttle risk; raising it back to 0.2 was the pre-tuning value.
DEFAULT_RATE_LIMIT_S = 0.05

# Throttle-aware backoff constants — see spec §8.2.
THROTTLE_BACKOFF_FACTOR = 2.0
THROTTLE_BACKOFF_HOLD_PAGES = 10  # Open Question #3: revisit if Phase 2 says otherwise

# Rolling window (pages) for the ProgressEvent.recent_http_p50_ms telemetry.
# 30 pages ≈ 2.4s of wall time on a fast day — long enough to smooth jitter,
# short enough to react to an upstream slowdown within one progress tick.
RECENT_HTTP_WINDOW = 30
# Only 429 surfaces here as-is. 503 is retried internally by HogaplayClient
# (with exponential backoff) and only escapes as an "exhausted retries"
# HogaplayHTTPError with status_code=None — caller-killing intentionally.
THROTTLED_STATUSES = frozenset({429})


# Single owner of the raw first.php Page-file layout contract (the glob
# pattern, the numeric-not-lexical sort, and the zero-padded write name). The
# read side (raw_pages) and the write side (page_filename) live here together
# so a future change to one can't silently desync from the other; parser
# imports raw_pages instead of re-spelling the glob. (disk_state.py keeps its
# own inline existence-only glob to avoid an api->collector import.)
PAGE_GLOB = "first_*.tsv"


def page_sort_key(path: Path) -> int:
    """Numeric sort key for `first_NNN.tsv` page files.

    Lexical sort breaks once page indices cross a decimal-digit-width boundary
    (e.g. `first_1000.tsv` sorts BEFORE `first_997.tsv` alphabetically). The
    parser's dedup-first-occurrence-wins semantics then assigns out-of-time
    seqs to the wrong page, which silently re-orders rows with identical
    millisecond timestamps and breaks trades.validate()'s cum_vol monotonicity
    check. Confirmed root cause for the 005930/20260520 capture failure
    (qa-3-rows real cookie test, 1756 pages).

    Internal helper for raw_pages(); not called directly outside this module.
    """
    return int(path.stem.split("_", 1)[1])


def raw_pages(raw_dir: Path) -> list[Path]:
    """All Page files in `raw_dir`, in ascending page-index order.

    The single read-side enumeration of the page layout. Numeric ordering (via
    page_sort_key) is load-bearing — see page_sort_key for why a lexical sort
    corrupts dedup ordering. A missing `raw_dir` yields `[]` (pathlib globs an
    absent directory to nothing rather than raising).
    """
    return sorted(raw_dir.glob(PAGE_GLOB), key=page_sort_key)


def page_filename(page_idx: int) -> str:
    """Write-side name for raw Page `page_idx`, zero-padded to 5 digits.

    The `:05d` pad keeps even a naive lexical sort correct up to 99999 pages (a
    single Stock-Date Data Window rarely exceeds ~2000); raw_pages' numeric sort
    already handles any width, so the padding is cheap belt-and-suspenders.
    """
    return f"first_{page_idx:05d}.tsv"

# Data Window closes at 16:00 KST (Regular Session close 15:30 +
# Auction Cross + After-Hours Trading 15:30–16:00). Captures before
# 16:00 on a today-date are partial — see CONTEXT.md.
_DATA_WINDOW_CLOSE_HOUR = 16

KST = dt.timezone(dt.timedelta(hours=9))


class HogaplayClientProto(Protocol):
    def fetch_info(self, code: str, date: str) -> str: ...
    def fetch_first(self, code: str, date: str, time_ms: int) -> str: ...
    def fetch_chart(
        self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000
    ) -> str: ...


class TodayTooEarlyRefused(RuntimeError):
    """Capture target is today (KST) and now < 16:30 KST — policy refuses regardless of Data Window state."""


class CaptureCancelled(RuntimeError):
    """Raised by collect_stock_date when its CancelToken is set."""


class UpstreamNoDataError(RuntimeError):
    """Raised when hogaplay's info.php returns a HTTP 200 no-data status body
    for a (code, date) that has no replay data — the upstream signal that no
    data exists. See ADR-0021.

    Two observed no-data body forms, both HTTP 200 (see _is_info_no_data):
      * an empty / whitespace-only body (ADR-0021, the original signal);
      * a bare status body of ``"2"`` — the newly-observed variant for
        suspended / no-replay stocks (confirmed stable across retries on
        2025-04-24 258540 and 2025-08-11 086460, 2026-07-04).
    """
    def __init__(self, code: str, date: str) -> None:
        super().__init__(f"hogaplay returned no-data info.php for {code}/{date}")
        self.code = code
        self.date = date


# hogaplay signals "no replay data for this (code, date)" from info.php in two
# observed forms, both HTTP 200: an empty/whitespace-only body (ADR-0021) and a
# bare status body of "2" (suspended / no-replay stocks). Both must be caught at
# the collector boundary — otherwise the status body is persisted verbatim as a
# garbage 1-byte info.tsv that fails parsing forever with FieldCountError and is
# re-fetched on every watchlist pass (34 such dirs found+deleted 2026-07-04).
# A genuine info row is a long tab-separated record whose first field is "1", so
# these bare single-token bodies never collide with real data.
_INFO_NO_DATA_STATUS_BODIES: frozenset[str] = frozenset({"", "2"})


def _is_info_no_data(info_body: str) -> bool:
    """True when an info.php body is one of hogaplay's no-data status bodies."""
    return info_body.strip() in _INFO_NO_DATA_STATUS_BODIES


class CancelToken:
    """Thin asyncio.Event wrapper for cooperative cancellation.

    The API layer creates one token per queue item, passes it to
    collect_stock_date, and calls .cancel() on
    POST /api/captures/items/{item_id}/cancel.
    """

    def __init__(self) -> None:
        self._event = asyncio.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()


# Cooperative cancellation poll interval used inside long sleeps (the 1.0s
# throttle backoff). Matches the lowest production rate_limit_s so cancel
# response time inside backoff is bounded by the same interval that bounds
# it everywhere else in the loop.
_CANCEL_POLL_INTERVAL_S = 0.05


def _cancellable_sleep(seconds: float, cancel_token: CancelToken | None) -> None:
    """Sleep for ``seconds`` while polling ``cancel_token`` every
    _CANCEL_POLL_INTERVAL_S. Raises CaptureCancelled if the token fires
    during the sleep. Equivalent to _time.sleep when cancel_token is None.
    """
    if cancel_token is None:
        _time.sleep(seconds)
        return
    deadline = _time.monotonic() + seconds
    while True:
        if cancel_token.cancelled:
            raise CaptureCancelled("capture cancelled during backoff sleep")
        remaining = deadline - _time.monotonic()
        if remaining <= 0:
            return
        _time.sleep(min(_CANCEL_POLL_INTERVAL_S, remaining))


@dataclass
class CollectResult:
    raw_dir: Path
    pages_written: int
    unique_events: int
    # None on normal completion; "stagnation_abort" when the page step loop
    # exited via the stagnation guard (hogaplay response freeze). Callers
    # downstream (parser, captures.py SSE emitter) MUST surface this to
    # operators — silently treating partial data as complete is the failure
    # the guard was added to prevent.
    abort_reason: str | None = None


@dataclass(frozen=True)
class ProgressEvent:
    """Snapshot of capture progress, emitted after each Page write.

    `frontier` is a HogaMs value (HHMMSSmmm encoding — see CONTEXT.md
    `Capture Frontier`). The API layer converts to Unix-ms before publishing
    to clients per ADR-0003. The HogaMs type enforces this at check time —
    accidental Unix-ms assignment fails Pyright.
    """
    code: str
    date: str
    pages_done: int
    events_seen: int
    frontier: HogaMs
    # Upstream-health telemetry ("why is this capture slow?" observability).
    # Median wall-ms of the last ≤ RECENT_HTTP_WINDOW first.php fetches, and
    # the cumulative count of 429-throttled fetch attempts. Slow-but-not-
    # throttled (p50 high, throttled==0) means hogaplay itself is slow —
    # measured 2026-07-09: 30ms/page days vs 500–1600ms/page days with zero
    # 429s. Defaults keep legacy emitters (tests, resume paths) valid.
    recent_http_p50_ms: float | None = None
    throttled_pages: int = 0


def now_kst() -> dt.datetime:
    """Current KST instant. Single source of truth — both captures.py
    (item-id stamping, today_too_early route guard) and calendar.py
    (today_locked overlay) import this rather than redefining locally.
    """
    return dt.datetime.now(tz=KST)


def next_kst_day(yyyymmdd: str) -> str:
    """YYYYMMDD 다음 날(KST 달력) → YYYYMMDD. 거래일 갭 계산의 단일 출처 — scheduler
    의 day-stepping 과 screener 의 gap/freshness 가 공유(월·연·윤일 경계가 한 곳)."""
    d = dt.date(int(yyyymmdd[0:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]))
    return (d + dt.timedelta(days=1)).strftime("%Y%m%d")


# Internal alias preserved so tests that monkeypatch `_now_kst` at
# orchestrator scope keep working through the rename. New callers
# should import `now_kst` directly.
_now_kst = now_kst


# Policy cutoff for "is it too early to capture today?" — distinct from
# _DATA_WINDOW_CLOSE_HOUR (= 16, when raw data stops). The 30-minute buffer
# accounts for hogaplay's post-close aggregation lag. See spec §11 Q14.
_TODAY_TOO_EARLY_CUTOFF = dt.time(16, 30)


def is_today_too_early(date: str, now: dt.datetime) -> bool:
    try:
        d = dt.date(int(date[:4]), int(date[4:6]), int(date[6:8]))
    except (ValueError, IndexError):
        return False
    if d != now.date():
        return False
    return now.time() < _TODAY_TOO_EARLY_CUTOFF


def _max_event_time(page_body: str) -> int | None:
    best: int | None = None
    for line in page_body.splitlines():
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < _MIN_FIELDS_EVENT_TIME:
            continue
        try:
            t = int(parts[_IDX_EVENT_TIME])
        except ValueError:
            continue
        if best is None or t > best:
            best = t
    return best


def _seqs(page_body: str) -> set[int]:
    out: set[int] = set()
    for line in page_body.splitlines():
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < _MIN_FIELDS_GLOBAL_SEQ:
            continue
        try:
            out.add(int(parts[_IDX_GLOBAL_SEQ]))
        except ValueError:
            continue
    return out


def _write_progress(
    path: Path,
    *,
    last_time_ms: int,
    pages_done: int,
    seq_count: int,
    started_at: str,
    finished_at: str | None,
    finished: bool = False,
    abort_reason: str | None = None,
) -> None:
    path.write_text(
        json.dumps(
            {
                "last_time_ms": last_time_ms,
                "pages_done": pages_done,
                "global_seqs_seen": seq_count,
                "started_at": started_at,
                "finished_at": finished_at,
                "finished": finished,
                "abort_reason": abort_reason,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _resume_state(raw_dir: Path) -> tuple[set[int], int, int]:
    seen: set[int] = set()
    last_idx = 0
    for page_path in raw_pages(raw_dir):
        last_idx += 1
        text = page_path.read_text(encoding="utf-8")
        seen.update(_seqs(text))
    last_t = DATA_WINDOW_START_MS
    progress_path = raw_dir / "_progress.json"
    if progress_path.exists():
        try:
            data = json.loads(progress_path.read_text(encoding="utf-8"))
            last_t = int(data.get("last_time_ms", DATA_WINDOW_START_MS))
        except (ValueError, KeyError):
            pass
    return seen, last_idx, last_t


def _fetch_first_body(
    client: HogaplayClientProto,
    *,
    code: str,
    date: str,
    time_ms: int,
) -> str:
    """HTTP-only half of _fetch_and_store_page: fetch one first.php Page body.

    Network errors (HogaplayHTTPError, including throttled 429s) surface to
    the caller unchanged — _page_step_loop's ADR-0017 backoff machinery
    depends on observing them here.
    """
    return client.fetch_first(code, date, time_ms)


def _store_page_body(
    raw_dir: Path,
    body: str,
    *,
    page_idx: int,
    seen_seqs: set[int],
) -> tuple[int, set[int]]:
    """TSV-write-only half of _fetch_and_store_page.

    Returns (new_page_idx, new_seqs). When body is empty (hogaplay's
    end-of-window signal), page_idx is unchanged and no file is written —
    matches the `if body:` guard in the original composite. Mutates
    seen_seqs in place to match the existing contract.
    """
    page_seqs = _seqs(body)
    new_seqs = page_seqs - seen_seqs
    if body:
        page_idx += 1
        (raw_dir / page_filename(page_idx)).write_text(body, encoding="utf-8")
        seen_seqs.update(page_seqs)
    return page_idx, new_seqs



def _page_step_loop(
    raw_dir: Path,
    client: HogaplayClientProto,
    code: str,
    date: str,
    started_at: str,
    rate_limit_s: float,
    seen_seqs: set[int],
    page_idx: int,
    t: int,
    on_progress: Callable[[ProgressEvent], None] | None = None,
    cancel_token: CancelToken | None = None,
    collector: CaptureTimingCollector | None = None,
    initial_step_ms: int = DEFAULT_PAGE_STEP_MS,
) -> tuple[set[int], int, int, StopReason | None]:
    """Run the Page Step pagination loop; return (seen_seqs, page_idx, final_t, stop_reason).

    When env var HOGA_PROFILE=1, also writes one JSONL line per iteration
    to raw_dir/_profile.jsonl for post-hoc throughput analysis.

    initial_step_ms tunes the PageStepController's step ceiling (Phase 1
    matrix experiments). Defaults to DEFAULT_PAGE_STEP_MS for production.
    """
    progress_path = raw_dir / "_progress.json"
    controller = PageStepController(initial_t=t, initial_step_ms=initial_step_ms)
    profile_enabled = os.environ.get("HOGA_PROFILE") == "1"
    profile_path = raw_dir / "_profile.jsonl" if profile_enabled else None

    last_emitted_t = -1
    last_emitted_pages = -1
    iter_idx = 0
    backoff_remaining = 0  # countdown of pages held at doubled rate after a 429
    recent_http_ms: deque[float] = deque(maxlen=RECENT_HTTP_WINDOW)
    throttled_total = 0  # cumulative 429 fetch attempts this run
    # Retry-aware page boundary flag (S2): start True so the first iteration
    # opens PageTiming row 0; set False after the boundary is marked; set
    # True again only after a SUCCESSFUL store. On a 429 retry path we hit
    # `continue` with the flag still False — so the retry stays on the same
    # PageTiming row instead of creating a phantom ~0-event row.
    pending_boundary = True
    while True:
        if cancel_token is not None and cancel_token.cancelled:
            raise CaptureCancelled(f"capture cancelled at page {page_idx}")
        iter_idx += 1
        t_in = controller.next_t
        step_before = controller.step_ms
        if collector is not None and pending_boundary:
            collector.mark_page_boundary()
            pending_boundary = False
        try:
            http_t0 = _time.perf_counter()
            if collector is not None:
                with collector.phase("http_fetch"):
                    body = _fetch_first_body(client, code=code, date=date, time_ms=t_in)
            else:
                body = _fetch_first_body(client, code=code, date=date, time_ms=t_in)
            if collector is not None:
                with collector.phase("disk_write"):
                    page_idx, new_seqs = _store_page_body(
                        raw_dir, body, page_idx=page_idx, seen_seqs=seen_seqs
                    )
            else:
                page_idx, new_seqs = _store_page_body(
                    raw_dir, body, page_idx=page_idx, seen_seqs=seen_seqs
                )
            http_ms = (_time.perf_counter() - http_t0) * 1000
            recent_http_ms.append(http_ms)
        except HogaplayHTTPError as e:
            if e.status_code in THROTTLED_STATUSES:
                throttled_total += 1
                if profile_path is not None:
                    marker = json.dumps({
                        "iter": iter_idx, "t_in": t_in,
                        "throttled": True, "status_code": e.status_code,
                    })
                    with profile_path.open("a", encoding="utf-8") as f:
                        f.write(marker + "\n")
                if collector is not None:
                    collector.record_error(f"http_{e.status_code}")
                if collector is not None:
                    with collector.phase("rate_limit"):
                        _cancellable_sleep(
                            max(rate_limit_s * THROTTLE_BACKOFF_FACTOR, 1.0),
                            cancel_token,
                        )
                else:
                    _cancellable_sleep(
                        max(rate_limit_s * THROTTLE_BACKOFF_FACTOR, 1.0),
                        cancel_token,
                    )
                backoff_remaining = THROTTLE_BACKOFF_HOLD_PAGES
                iter_idx -= 1
                # Leave pending_boundary False so the retry stays on the same
                # PageTiming row (S2 retry-aware semantics).
                continue  # retry same t_in, do not advance controller
            raise
        if collector is not None:
            collector.record_event_count(len(new_seqs))
            pending_boundary = True  # next iteration opens a new PageTiming row
        max_t = _max_event_time(body)
        decision = controller.observe(max_event_time=max_t, new_seqs=len(new_seqs))
        _write_progress(
            progress_path,
            last_time_ms=decision.progress_t,
            pages_done=page_idx,
            seq_count=len(seen_seqs),
            started_at=started_at,
            finished_at=None,
        )
        if profile_path is not None:
            cap_hit = (
                max_t is not None
                and max_t < (t_in + step_before)
                and step_before > MIN_PAGE_STEP_MS
                and t_in < DATA_WINDOW_END_MS
            )
            post_window = t_in >= DATA_WINDOW_END_MS
            line = json.dumps({
                "iter": iter_idx, "t_in": t_in, "step_ms": step_before,
                "http_ms": round(http_ms, 2), "body_len": len(body),
                "new_seqs": len(new_seqs), "max_event_time": max_t,
                "cap_hit": cap_hit, "empty_streak": controller._empty_in_a_row,
                "post_window": post_window, "page_idx": page_idx,
            })
            with profile_path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        # Skip the callback when neither frontier nor pages_done advanced.
        # The empty-page termination drain runs ~1262 iterations after the
        # Data Window end; without this guard, every drain tick fires a
        # no-op on_progress event that the API layer then ships across the
        # SSE bus, swamping the queue and re-rendering the frontend.
        if on_progress is not None and (
            decision.progress_t != last_emitted_t or page_idx != last_emitted_pages
        ):
            on_progress(ProgressEvent(
                code=code,
                date=date,
                pages_done=page_idx,
                events_seen=len(seen_seqs),
                frontier=HogaMs(decision.progress_t),
                recent_http_p50_ms=(
                    median(recent_http_ms) if recent_http_ms else None
                ),
                throttled_pages=throttled_total,
            ))
            last_emitted_t = decision.progress_t
            last_emitted_pages = page_idx
        if decision.should_stop:
            return seen_seqs, page_idx, controller.next_t, decision.stop_reason
        effective_rate = (rate_limit_s * THROTTLE_BACKOFF_FACTOR) if backoff_remaining > 0 else rate_limit_s
        if backoff_remaining > 0:
            backoff_remaining -= 1
        if effective_rate > 0:
            if collector is not None:
                with collector.phase("rate_limit"):
                    _time.sleep(effective_rate)
            else:
                _time.sleep(effective_rate)


def collect_stock_date(
    *,
    client: HogaplayClientProto,
    code: str,
    date: str,
    data_dir: Path,
    rate_limit_s: float = DEFAULT_RATE_LIMIT_S,  # was 0.2 — see ADR-0017 / Phase 1 matrix sweep
    resume: bool = False,
    on_progress: Callable[[ProgressEvent], None] | None = None,
    cancel_token: CancelToken | None = None,
    collector: CaptureTimingCollector | None = None,
    initial_step_ms: int = DEFAULT_PAGE_STEP_MS,
) -> CollectResult:
    """Drive the full capture for one Stock-Date.

    Strategy:
      1. info.php once (skipped on resume if info.tsv exists).
      2. Page Step loop on first.php from DATA_WINDOW_START_MS (or last_time_ms on resume).
         If a Page does not cover the requested window, halve the step and retry from
         t + new_step.
      3. Terminate when t >= DATA_WINDOW_END_MS and TERMINATION_EMPTY_PAGES consecutive
         Pages contain no new global_seq.
      4. chart.php once at CHART_FINAL_TIME_MS.
    """
    now = _now_kst()
    if is_today_too_early(date, now):
        raise TodayTooEarlyRefused(
            f"date={date} is today (KST) and now={now:%H:%M} < "
            f"{_TODAY_TOO_EARLY_CUTOFF:%H:%M}. Wait until 16:30 KST."
        )

    raw_dir = data_dir / "raw" / date / code
    raw_dir.mkdir(parents=True, exist_ok=True)
    started_at = now.isoformat()

    # 1. info.php — hogaplay signals "no data for this (code, date)" via a
    # HTTP 200 no-data status body: an empty body (ADR-0021) or a bare "2"
    # (see _is_info_no_data). Detect at the collector boundary before the
    # status body is persisted as a garbage 1-byte info.tsv.
    info_path = raw_dir / "info.tsv"
    if not (resume and info_path.exists()):
        if collector is not None:
            with collector.phase("http_fetch"):
                info_body = client.fetch_info(code, date)
        else:
            info_body = client.fetch_info(code, date)
        if _is_info_no_data(info_body):
            raise UpstreamNoDataError(code, date)
        if collector is not None:
            with collector.phase("disk_write"):
                info_path.write_text(info_body, encoding="utf-8")
        else:
            info_path.write_text(info_body, encoding="utf-8")
        if rate_limit_s > 0:
            if collector is not None:
                with collector.phase("rate_limit"):
                    _time.sleep(rate_limit_s)
            else:
                _time.sleep(rate_limit_s)

    # 2. Page Step loop
    if resume:
        seen_seqs, page_idx, t = _resume_state(raw_dir)
    else:
        seen_seqs = set()
        page_idx = 0
        t = DATA_WINDOW_START_MS

    seen_seqs, page_idx, t, stop_reason = _page_step_loop(
        raw_dir, client, code, date, started_at, rate_limit_s, seen_seqs, page_idx, t,
        on_progress=on_progress,
        cancel_token=cancel_token,
        collector=collector,
        initial_step_ms=initial_step_ms,
    )

    # 3. chart.php once
    if cancel_token is not None and cancel_token.cancelled:
        raise CaptureCancelled("capture cancelled before chart fetch")
    if collector is not None:
        with collector.phase("http_fetch"):
            chart_body = client.fetch_chart(code, date, CHART_FINAL_TIME_MS)
    else:
        chart_body = client.fetch_chart(code, date, CHART_FINAL_TIME_MS)
    if collector is not None:
        with collector.phase("disk_write"):
            (raw_dir / "chart.tsv").write_text(chart_body, encoding="utf-8")
    else:
        (raw_dir / "chart.tsv").write_text(chart_body, encoding="utf-8")

    # Stagnation abort writes finished=False so the parser's
    # ``collection_complete`` flag stays False and the resulting parquet is
    # classified CLIENT_INCOMPLETE rather than COMPLETE.
    is_stagnation = stop_reason is StopReason.STAGNATION
    abort_reason = stop_reason.value if is_stagnation else None
    finished_at = _now_kst().isoformat()
    _write_progress(
        raw_dir / "_progress.json",
        last_time_ms=t,
        pages_done=page_idx,
        seq_count=len(seen_seqs),
        started_at=started_at,
        finished_at=finished_at,
        finished=not is_stagnation,
        abort_reason=abort_reason,
    )

    return CollectResult(
        raw_dir=raw_dir,
        pages_written=page_idx,
        unique_events=len(seen_seqs),
        abort_reason=abort_reason,
    )
