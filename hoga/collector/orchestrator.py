"""Page Step pagination loop for hogaplay first.php + chart.php capture."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import time as _time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from hoga.api.timeenc import HogaMs
from hoga.collector.page_step import PageStepController

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


def page_sort_key(path: Path) -> int:
    """Numeric sort key for `first_NNN.tsv` page files.

    Lexical sort breaks once page indices cross a decimal-digit-width boundary
    (e.g. `first_1000.tsv` sorts BEFORE `first_997.tsv` alphabetically). The
    parser's dedup-first-occurrence-wins semantics then assigns out-of-time
    seqs to the wrong page, which silently re-orders rows with identical
    millisecond timestamps and breaks trades.validate()'s cum_vol monotonicity
    check. Confirmed root cause for the 005930/20260520 capture failure
    (qa-3-rows real cookie test, 1756 pages).

    Used everywhere `raw_dir.glob("first_*.tsv")` is sorted.
    """
    return int(path.stem.split("_", 1)[1])

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
    """Capture target is today (KST) and now.hour < 18 — policy refuses regardless of Data Window state."""


class CaptureCancelled(RuntimeError):
    """Raised by collect_stock_date when its CancelToken is set."""


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


@dataclass
class CollectResult:
    raw_dir: Path
    pages_written: int
    unique_events: int


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


def now_kst() -> dt.datetime:
    """Current KST instant. Single source of truth — both captures.py
    (item-id stamping, today_too_early route guard) and calendar.py
    (today_locked overlay) import this rather than redefining locally.
    """
    return dt.datetime.now(tz=KST)


# Internal alias preserved so tests that monkeypatch `_now_kst` at
# orchestrator scope keep working through the rename. New callers
# should import `now_kst` directly.
_now_kst = now_kst


# Policy cutoff for "is it too early to capture today?" — distinct from
# _DATA_WINDOW_CLOSE_HOUR (= 16, when raw data stops). The 2-hour buffer
# accounts for hogaplay's post-close aggregation lag. See spec §11 Q14.
_TODAY_TOO_EARLY_HOUR = 18


def is_today_too_early(date: str, now: dt.datetime) -> bool:
    try:
        d = dt.date(int(date[:4]), int(date[4:6]), int(date[6:8]))
    except (ValueError, IndexError):
        return False
    if d != now.date():
        return False
    return now.hour < _TODAY_TOO_EARLY_HOUR


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
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _resume_state(raw_dir: Path) -> tuple[set[int], int, int]:
    seen: set[int] = set()
    last_idx = 0
    for page_path in sorted(raw_dir.glob("first_*.tsv"), key=page_sort_key):
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
        # :05d so lexical sort stays correct up to 99999 pages (a single
        # Stock-Date Data Window rarely exceeds ~2000 pages, but pre-padding
        # is cheap insurance even though page_sort_key handles mixed widths).
        (raw_dir / f"first_{page_idx:05d}.tsv").write_text(body, encoding="utf-8")
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
    initial_step_ms: int = 60000,  # exposed for Phase 1 matrix experiments
) -> tuple[set[int], int, int]:
    progress_path = raw_dir / "_progress.json"
    controller = PageStepController(initial_t=t, initial_step_ms=initial_step_ms)
    profile_enabled = os.environ.get("HOGA_PROFILE") == "1"
    profile_path = raw_dir / "_profile.jsonl" if profile_enabled else None

    last_emitted_t = -1
    last_emitted_pages = -1
    iter_idx = 0
    while True:
        if cancel_token is not None and cancel_token.cancelled:
            raise CaptureCancelled(f"capture cancelled at page {page_idx}")
        iter_idx += 1
        t_in = controller.next_t
        step_before = controller.step_ms
        http_t0 = _time.perf_counter()
        body, page_idx, new_seqs = _fetch_and_store_page(
            raw_dir, client, code, date, t_in, page_idx, seen_seqs
        )
        http_ms = (_time.perf_counter() - http_t0) * 1000
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
            cap_hit = max_t is not None and max_t < (t_in + step_before)
            post_window = t_in >= 160_000_000
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
            ))
            last_emitted_t = decision.progress_t
            last_emitted_pages = page_idx
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
    if is_today_too_early(date, now):
        raise TodayTooEarlyRefused(
            f"date={date} is today (KST) and now.hour={now.hour} < {_TODAY_TOO_EARLY_HOUR}. "
            "Wait until 18:00 KST."
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
        finished=True,
    )

    return CollectResult(raw_dir=raw_dir, pages_written=page_idx, unique_events=len(seen_seqs))
