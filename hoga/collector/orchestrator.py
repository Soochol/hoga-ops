"""Page Step pagination loop for hogaplay first.php + chart.php capture."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import time as _time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from hoga.collector.page_step import PageStepController

# Time constants in HHMMSSmmm encoding.
DATA_WINDOW_START_MS = 84000000  # 08:40:00.000
CHART_FINAL_TIME_MS = 153100000  # 15:31:00.000

# Field index constants for TSV row parsing.
_IDX_GLOBAL_SEQ = 3
_IDX_EVENT_TIME = 4
_MIN_FIELDS_EVENT_TIME = 5
_MIN_FIELDS_GLOBAL_SEQ = 4

# Regular Session closes at 16:00 KST; captures before that hour are partial.
_REGULAR_SESSION_CLOSE_HOUR = 16

KST = dt.timezone(dt.timedelta(hours=9))


class HogaplayClientProto(Protocol):
    def fetch_info(self, code: str, date: str) -> str: ...
    def fetch_first(self, code: str, date: str, time_ms: int) -> str: ...
    def fetch_chart(
        self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000
    ) -> str: ...


class PartialCaptureRefused(RuntimeError):
    """Capture target is today + Regular Session not yet closed and allow_partial=False."""


class CaptureCancelled(RuntimeError):
    """Raised by collect_stock_date when its CancelToken is set."""


class CancelToken:
    """Thin asyncio.Event wrapper for cooperative cancellation.

    The API layer creates one token per job, passes it to collect_stock_date,
    and calls .cancel() on POST /api/captures/latest/cancel.
    """

    def __init__(self) -> None:
        self._event = asyncio.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()


@dataclass
class CollectResult:
    raw_dir: Path
    pages_written: int
    unique_events: int


@dataclass(frozen=True)
class ProgressEvent:
    """Snapshot of capture progress, emitted after each Page write.

    `frontier_hhmmss` is the raw HHMMSSmmm value (collector encoding); the
    API layer converts to Unix-ms before publishing to clients (see
    CONTEXT.md `Capture Frontier`).
    """
    code: str
    date: str
    pages_done: int
    events_seen: int
    frontier_hhmmss: int


def _now_kst() -> dt.datetime:
    return dt.datetime.now(tz=KST)


def _is_partial_capture(date: str, now: dt.datetime) -> bool:
    try:
        d = dt.date(int(date[:4]), int(date[4:6]), int(date[6:8]))
    except (ValueError, IndexError):
        return False
    if d != now.date():
        return False
    return now.hour < _REGULAR_SESSION_CLOSE_HOUR


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
) -> None:
    path.write_text(
        json.dumps(
            {
                "last_time_ms": last_time_ms,
                "pages_done": pages_done,
                "global_seqs_seen": seq_count,
                "started_at": started_at,
                "finished_at": finished_at,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _resume_state(raw_dir: Path) -> tuple[set[int], int, int]:
    seen: set[int] = set()
    last_idx = 0
    for page_path in sorted(raw_dir.glob("first_*.tsv")):
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


def _fetch_and_store_page(
    raw_dir: Path,
    client: HogaplayClientProto,
    code: str,
    date: str,
    t: int,
    page_idx: int,
    seen_seqs: set[int],
) -> tuple[str, int, set[int]]:
    """Fetch one first.php Page, store it if non-empty, return (body, new_page_idx, new_seqs)."""
    body = client.fetch_first(code, date, t)
    page_seqs = _seqs(body)
    new_seqs = page_seqs - seen_seqs
    if body:
        page_idx += 1
        (raw_dir / f"first_{page_idx:03d}.tsv").write_text(body, encoding="utf-8")
        seen_seqs.update(page_seqs)
    return body, page_idx, new_seqs


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
) -> tuple[set[int], int, int]:
    """Run the Page Step pagination loop; return (seen_seqs, page_idx, final_t)."""
    progress_path = raw_dir / "_progress.json"
    controller = PageStepController(initial_t=t)

    while True:
        if cancel_token is not None and cancel_token.cancelled:
            raise CaptureCancelled(f"capture cancelled at page {page_idx}")
        body, page_idx, new_seqs = _fetch_and_store_page(
            raw_dir, client, code, date, controller.next_t, page_idx, seen_seqs
        )
        decision = controller.observe(max_event_time=_max_event_time(body), new_seqs=len(new_seqs))
        _write_progress(
            progress_path,
            last_time_ms=decision.progress_t,
            pages_done=page_idx,
            seq_count=len(seen_seqs),
            started_at=started_at,
            finished_at=None,
        )
        if on_progress is not None:
            on_progress(ProgressEvent(
                code=code,
                date=date,
                pages_done=page_idx,
                events_seen=len(seen_seqs),
                frontier_hhmmss=decision.progress_t,
            ))
        if decision.should_stop:
            break
        if rate_limit_s > 0:
            _time.sleep(rate_limit_s)

    return seen_seqs, page_idx, controller.next_t


def collect_stock_date(
    *,
    client: HogaplayClientProto,
    code: str,
    date: str,
    data_dir: Path,
    rate_limit_s: float = 0.2,
    allow_partial: bool = False,
    resume: bool = False,
    on_progress: Callable[[ProgressEvent], None] | None = None,
    cancel_token: CancelToken | None = None,
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
    if not allow_partial and _is_partial_capture(date, now):
        raise PartialCaptureRefused(
            f"date={date} is today (KST) and Regular Session has not closed. "
            "Pass --allow-partial to capture anyway."
        )

    raw_dir = data_dir / "raw" / date / code
    raw_dir.mkdir(parents=True, exist_ok=True)
    started_at = now.isoformat()

    # 1. info.php
    info_path = raw_dir / "info.tsv"
    if not (resume and info_path.exists()):
        info_body = client.fetch_info(code, date)
        info_path.write_text(info_body, encoding="utf-8")
        if rate_limit_s > 0:
            _time.sleep(rate_limit_s)

    # 2. Page Step loop
    if resume:
        seen_seqs, page_idx, t = _resume_state(raw_dir)
    else:
        seen_seqs = set()
        page_idx = 0
        t = DATA_WINDOW_START_MS

    seen_seqs, page_idx, t = _page_step_loop(
        raw_dir, client, code, date, started_at, rate_limit_s, seen_seqs, page_idx, t,
        on_progress=on_progress,
        cancel_token=cancel_token,
    )

    # 3. chart.php once
    if cancel_token is not None and cancel_token.cancelled:
        raise CaptureCancelled("capture cancelled before chart fetch")
    chart_body = client.fetch_chart(code, date, CHART_FINAL_TIME_MS)
    (raw_dir / "chart.tsv").write_text(chart_body, encoding="utf-8")

    finished_at = _now_kst().isoformat()
    _write_progress(
        raw_dir / "_progress.json",
        last_time_ms=t,
        pages_done=page_idx,
        seq_count=len(seen_seqs),
        started_at=started_at,
        finished_at=finished_at,
    )

    return CollectResult(raw_dir=raw_dir, pages_written=page_idx, unique_events=len(seen_seqs))
