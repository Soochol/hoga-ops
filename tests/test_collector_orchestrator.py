from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from hoga.collector import orchestrator as orch
from hoga.collector.orchestrator import (
    PAGE_GLOB,
    CancelToken,
    CaptureCancelled,
    collect_stock_date,
    page_filename,
    page_sort_key,
    raw_pages,
)

# Magic constants used across tests.
_UNIQUE_EVENTS_BASIC = 3
_UNIQUE_EVENTS_DEDUP = 3
_UNIQUE_EVENTS_CAP = 4
_CAP_RETRY_LOW = 84015001
_CAP_RETRY_HIGH = 84060000


@dataclass
class _Call:
    endpoint: str
    code: str
    date: str
    time_ms: int


class FakeClient:
    """Test double matching the HogaplayClient surface."""

    def __init__(self, info_body: str, first_pages: dict[int, str], chart_body: str) -> None:
        self.info_body = info_body
        self.first_pages = first_pages
        self.chart_body = chart_body
        self.calls: list[_Call] = []

    def fetch_info(self, code: str, date: str) -> str:
        self.calls.append(_Call("info", code, date, 0))
        return self.info_body

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        self.calls.append(_Call("first", code, date, time_ms))
        return self.first_pages.get(time_ms, "")

    def fetch_chart(
        self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000
    ) -> str:
        self.calls.append(_Call("chart", code, date, time_ms))
        return self.chart_body


def _row(tsv_section: int, etype: int, sub_seq: int, global_seq: int, event_time: int) -> str:
    """Build a minimal TSV row with required first 5 fields.

    Other fields are zeros to keep field count valid per event type.
    """
    if etype == 1:  # trade: 18 significant fields
        return (
            "\t".join(
                [
                    str(tsv_section),
                    "1",
                    str(sub_seq),
                    str(global_seq),
                    str(event_time),
                    "0",
                    "0",
                    "0",
                    "+1",
                    "1",
                    "1",
                    "0",
                    "0",
                    "0",
                    "0",
                    "0",
                    "0",
                    "0",
                ]
            )
            + "\n"
        )
    _ETYPE_ORDERBOOK = 2
    if etype == _ETYPE_ORDERBOOK:  # orderbook: 70 significant fields + trailing tab
        fields = [str(tsv_section), "2", str(sub_seq), str(global_seq), str(event_time), "0"]
        fields += ["0"] * 64  # 10*6 level fields + 4 totals = 64
        return "\t".join(fields) + "\t\n"
    raise ValueError(f"unsupported etype {etype} for test row")


def test_collect_writes_info_first_chart_progress(tmp_path: Path) -> None:
    page_body = (
        _row(1, 1, 0, 1, 84000000) + _row(2, 2, 1, 2, 84000060) + _row(2, 2, 2, 3, 159000000)
    )
    fake = FakeClient(
        info_body="1\t003490\t테스트\t0\t90000000\t153000000\n",
        first_pages={t: page_body for t in range(84000000, 160000001, 60000)},
        chart_body="55140000\t15:19:02\t100\t100\t100\t100\t1\t1\t0\t1\t1\n",
    )

    result = collect_stock_date(
        client=fake,
        code="003490",
        date="20260519",
        data_dir=tmp_path / "data",
        rate_limit_s=0.0,
    )

    raw_dir = tmp_path / "data" / "raw" / "20260519" / "003490"
    assert (raw_dir / "info.tsv").read_text(encoding="utf-8").startswith("1\t003490")
    assert (raw_dir / "chart.tsv").read_text(encoding="utf-8").startswith("55140000")
    assert (raw_dir / "_progress.json").exists()
    first_files = sorted(raw_dir.glob("first_*.tsv"))
    assert len(first_files) >= 1
    assert result.unique_events >= _UNIQUE_EVENTS_BASIC


def test_collect_dedupes_overlapping_pages(tmp_path: Path) -> None:
    page_a = _row(1, 1, 0, 1, 84000000) + _row(2, 1, 1, 2, 84060000)
    page_b = _row(1, 1, 0, 2, 84060000) + _row(2, 1, 1, 3, 84120000)
    pages: dict[int, str] = {84000000: page_a, 84060000: page_b}
    pages.update({t: "" for t in range(84120000, 160000001, 60000)})

    fake = FakeClient(
        info_body="1\t003490\t테스트\t0\t90000000\t153000000\n",
        first_pages=pages,
        chart_body="",
    )
    result = collect_stock_date(
        client=fake,
        code="003490",
        date="20260519",
        data_dir=tmp_path / "data",
        rate_limit_s=0.0,
    )
    assert result.unique_events == _UNIQUE_EVENTS_DEDUP


def test_collect_cap_detection_halves_step(tmp_path: Path) -> None:
    """Cap detection: first page's max event time is well short of the requested window.

    Setup: at t=84000000 the response covers only up to 84015000 (15 seconds of data),
    which is way short of t+60s=84060000. The orchestrator should halve the step and
    request again at the next time (max_t + 1 = 84015001 or similar -- whatever the
    orchestrator picks).
    """
    page_short = _row(2, 1, 0, 1, 84000000) + _row(2, 1, 1, 2, 84015000)
    page_normal = _row(2, 1, 0, 3, 84030000) + _row(2, 1, 1, 4, 84089000)
    pages: dict[int, str] = {
        84000000: page_short,
        84030000: page_normal,
    }
    pages.update({t: "" for t in range(84060000, 160000001, 60000)})

    fake = FakeClient(
        info_body="1\t003490\t테스트\t0\t90000000\t153000000\n",
        first_pages=pages,
        chart_body="",
    )
    result = collect_stock_date(
        client=fake,
        code="003490",
        date="20260519",
        data_dir=tmp_path / "data",
        rate_limit_s=0.0,
    )
    assert result.unique_events == _UNIQUE_EVENTS_CAP
    first_times = [c.time_ms for c in fake.calls if c.endpoint == "first"]
    # Some call between _CAP_RETRY_LOW and _CAP_RETRY_HIGH (the cap-halved retry zone)
    retry_calls = [t for t in first_times if _CAP_RETRY_LOW <= t < _CAP_RETRY_HIGH]
    assert retry_calls, (
        f"expected a step-halved retry between {_CAP_RETRY_LOW} and {_CAP_RETRY_HIGH},"
        f" got {first_times[:5]}"
    )


def test_collect_stock_date_today_too_early_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Today's date + now < 16:30 KST raises TodayTooEarlyRefused."""
    fixed_now = dt.datetime(2026, 5, 22, 16, 29, 0, tzinfo=dt.timezone(dt.timedelta(hours=9)))
    monkeypatch.setattr(orch, "_now_kst", lambda: fixed_now)

    fake = FakeClient(info_body="", first_pages={}, chart_body="")
    with pytest.raises(orch.TodayTooEarlyRefused):
        collect_stock_date(
            client=fake,
            code="003490",
            date="20260522",  # same day as fixed_now
            data_dir=tmp_path / "data",
            rate_limit_s=0.0,
        )


def test_collect_stock_date_today_after_1630_allowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Today's date + now >= 16:30 KST proceeds normally."""
    fixed_now = dt.datetime(2026, 5, 22, 16, 30, 0, tzinfo=dt.timezone(dt.timedelta(hours=9)))
    monkeypatch.setattr(orch, "_now_kst", lambda: fixed_now)

    fake = FakeClient(
        info_body="1\t003490\t테스트\t0\t90000000\t153000000\n",
        first_pages={t: "" for t in range(84000000, 160000001, 60000)},
        chart_body="",
    )
    collect_stock_date(
        client=fake,
        code="003490",
        date="20260522",
        data_dir=tmp_path / "data",
        rate_limit_s=0.0,
    )


def test_page_sort_key_numeric_across_digit_widths(tmp_path: Path) -> None:
    # Regression: real capture for 005930/20260520 (1756 pages) failed because
    # legacy `first_{idx:03d}.tsv` rolls over to 4 digits at idx=1000, and the
    # parser's `sorted(glob)` then puts `first_1000.tsv` BEFORE `first_997.tsv`
    # lexically. The dedup-first-occurrence-wins flow then assigned same-ms
    # rows to the wrong order and broke cum_vol monotonicity downstream.
    # page_sort_key must restore numeric ordering regardless of padding width.
    raw = tmp_path
    for idx in [1, 9, 10, 99, 100, 997, 998, 999, 1000, 1500]:
        (raw / f"first_{idx:03d}.tsv").touch()
    pages = sorted(raw.glob("first_*.tsv"), key=page_sort_key)
    indices = [page_sort_key(p) for p in pages]
    assert indices == [1, 9, 10, 99, 100, 997, 998, 999, 1000, 1500]
    # Sanity: plain lexical sort would NOT match (proves the test is meaningful).
    lexical = [page_sort_key(p) for p in sorted(raw.glob("first_*.tsv"))]
    assert lexical != indices


def test_page_glob_matches_only_first_pages(tmp_path: Path) -> None:
    # PAGE_GLOB is the single owner of the on-disk page filename pattern.
    (tmp_path / "first_00001.tsv").touch()
    (tmp_path / "info.tsv").touch()
    (tmp_path / "chart.tsv").touch()
    (tmp_path / "_progress.json").touch()
    matched = sorted(p.name for p in tmp_path.glob(PAGE_GLOB))
    assert matched == ["first_00001.tsv"]


def test_page_filename_zero_pads_to_five_digits() -> None:
    assert page_filename(1) == "first_00001.tsv"
    assert page_filename(997) == "first_00997.tsv"
    assert page_filename(1500) == "first_01500.tsv"
    # Beyond the pad width it does not truncate — page_sort_key still recovers it.
    assert page_filename(123456) == "first_123456.tsv"


def test_raw_pages_missing_dir_returns_empty(tmp_path: Path) -> None:
    assert raw_pages(tmp_path / "does_not_exist") == []


def test_raw_pages_ignores_non_page_files(tmp_path: Path) -> None:
    (tmp_path / "first_00001.tsv").touch()
    (tmp_path / "chart.tsv").touch()
    (tmp_path / "info.tsv").touch()
    assert [p.name for p in raw_pages(tmp_path)] == ["first_00001.tsv"]


def test_page_filename_raw_pages_write_read_roundtrip(tmp_path: Path) -> None:
    # The write side (page_filename) and the read side (raw_pages) are one
    # contract: files created in scrambled index order — crossing the
    # digit-width boundary that broke the 005930/20260520 capture — must be
    # enumerated back in ascending page-index order.
    indices = [1500, 1, 1000, 9, 997, 100, 10]
    for idx in indices:
        (tmp_path / page_filename(idx)).write_text(f"page-{idx}\n", encoding="utf-8")
    recovered = [page_sort_key(p) for p in raw_pages(tmp_path)]
    assert recovered == sorted(indices)


def test_profile_jsonl_not_created_when_env_unset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Default behaviour: no _profile.jsonl created (zero-cost when disabled)."""
    monkeypatch.delenv("HOGA_PROFILE", raising=False)
    fake = FakeClient(
        info_body="info\n",
        first_pages={84000000: _row(1, 1, 1, 1001, 84001000)},
        chart_body="chart\n",
    )
    collect_stock_date(
        client=fake, code="003490", date="20260519",
        data_dir=tmp_path, rate_limit_s=0,
    )
    profile = tmp_path / "raw" / "20260519" / "003490" / "_profile.jsonl"
    assert not profile.exists()


def test_profile_jsonl_created_and_line_format_when_env_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """HOGA_PROFILE=1: one JSONL line per fetch iteration with required fields."""
    monkeypatch.setenv("HOGA_PROFILE", "1")
    fake = FakeClient(
        info_body="info\n",
        first_pages={84000000: _row(1, 1, 1, 1001, 84001000)},
        chart_body="chart\n",
    )
    collect_stock_date(
        client=fake, code="003490", date="20260519",
        data_dir=tmp_path, rate_limit_s=0,
    )
    profile = tmp_path / "raw" / "20260519" / "003490" / "_profile.jsonl"
    assert profile.exists()
    lines = [json.loads(line) for line in profile.read_text().splitlines() if line]
    assert len(lines) >= 1
    required = {"iter", "t_in", "step_ms", "http_ms", "body_len",
               "new_seqs", "max_event_time", "cap_hit", "empty_streak",
               "post_window", "page_idx"}
    assert required.issubset(lines[0].keys())


def test_collect_stock_date_accepts_initial_step_ms(tmp_path: Path) -> None:
    """initial_step_ms parameter threads through to PageStepController."""
    # With step_ms=120000, the first fetch is at t=84000000, the second at
    # t=84120000 (if no cap-hit). We confirm via the recorded calls.
    fake = FakeClient(
        info_body="info\n",
        first_pages={
            84000000: _row(1, 1, 1, 1001, 84120000),  # max_t == target → no cap-hit
            84120000: _row(1, 1, 1, 1002, 84121000),
        },
        chart_body="chart\n",
    )
    collect_stock_date(
        client=fake, code="003490", date="20260519",
        data_dir=tmp_path, rate_limit_s=0, initial_step_ms=120000,
    )
    first_times = [c.time_ms for c in fake.calls if c.endpoint == "first"]
    assert first_times[:2] == [84000000, 84120000]


def test_collect_backs_off_rate_limit_on_429(tmp_path: Path) -> None:
    """When hogaplay returns 429, rate_limit_s doubles for the next N pages,
    then restores to the configured value if no further 4xx occurs."""
    from hoga.collector.client import HogaplayHTTPError

    class ThrottlingFake(FakeClient):
        def __init__(self) -> None:
            super().__init__(
                info_body="info\n",
                first_pages={
                    84000000: _row(1, 1, 1, 1001, 84001000),
                    84060000: _row(1, 1, 1, 1002, 84061000),
                    84120000: _row(1, 1, 1, 1003, 84121000),
                },
                chart_body="chart\n",
            )
            self.throttle_at_iter = 2
            self._iter = 0

        def fetch_first(self, code: str, date: str, time_ms: int) -> str:
            self._iter += 1
            if self._iter == self.throttle_at_iter:
                self.calls.append(_Call("first", code, date, time_ms))
                raise HogaplayHTTPError("throttled", status_code=429)
            return super().fetch_first(code, date, time_ms)

    fake = ThrottlingFake()
    # rate_limit_s starts at 0 so timing is dominated by backoff.
    result = collect_stock_date(
        client=fake, code="003490", date="20260519",
        data_dir=tmp_path, rate_limit_s=0,
    )
    # The capture should complete (not crash), and the 429 must have been
    # absorbed by backoff (retry of the same time_ms).
    first_calls = [c.time_ms for c in fake.calls if c.endpoint == "first"]
    # The throttled time_ms should appear twice (retry after backoff).
    from collections import Counter
    counts = Counter(first_calls)
    assert any(c == 2 for c in counts.values()), "throttled page should be retried after backoff"


def test_collect_doubles_rate_for_THROTTLE_BACKOFF_HOLD_PAGES_after_429(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After a 429, next 10 pages sleep at 2x rate_limit_s, then page 11 returns to 1x."""
    from hoga.collector.client import HogaplayHTTPError
    from hoga.collector import orchestrator as orch

    sleeps: list[float] = []
    monkeypatch.setattr(orch._time, "sleep", lambda s: sleeps.append(s))

    # Build a fake with 15 sequential pages so we can observe rate over 10+ post-throttle pages.
    first_pages = {84000000 + i*60000: _row(1, 1, 1, 2000+i, 84000000+i*60000+1000) for i in range(15)}

    class ThrottleOnce(FakeClient):
        def __init__(self) -> None:
            super().__init__(info_body="info\n", first_pages=first_pages, chart_body="chart\n")
            self._iter = 0
        def fetch_first(self, code: str, date: str, time_ms: int) -> str:
            self._iter += 1
            if self._iter == 3:  # throttle on the 3rd call
                self.calls.append(_Call("first", code, date, time_ms))
                raise HogaplayHTTPError("throttled", status_code=429)
            return super().fetch_first(code, date, time_ms)

    fake = ThrottleOnce()
    collect_stock_date(
        client=fake, code="003490", date="20260519",
        data_dir=tmp_path, rate_limit_s=0.05,
    )

    # The throttle backoff sleep is max(0.05*2.0, 1.0) = 1.0
    assert 1.0 in sleeps, f"throttle backoff sleep (1.0) not found in {sleeps}"
    # After throttle: 10 pages at 2x rate (0.10), then back to 0.05
    doubled = sleeps.count(0.1)
    normal_after = sleeps.count(0.05)
    assert doubled >= 10, f"expected ≥10 doubled-rate sleeps after throttle, got {doubled} (all sleeps: {sleeps})"
    assert normal_after >= 1, f"expected return to normal rate after 10 pages, got {normal_after}"


def test_throttle_backoff_aborts_on_cancel_within_poll_interval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """During a 429 backoff sleep the cancel token must be observed within
    one poll interval (~50ms), not held hostage by the full 1.0s floor.
    Prior to the fix _time.sleep(1.0) blocked Cancel for the full second.
    """
    from hoga.collector.client import HogaplayHTTPError
    from hoga.collector import orchestrator as orch

    sleeps: list[float] = []

    def fake_sleep(s: float) -> None:
        sleeps.append(s)
        # After the first slice of the backoff sleep, the user cancels.
        if s <= orch._CANCEL_POLL_INTERVAL_S and len(sleeps) >= 1:
            token.cancel()

    monkeypatch.setattr(orch._time, "sleep", fake_sleep)
    # Drive monotonic forward by sleep duration so the deadline loop exits
    # naturally if cancel never fires (sanity).
    base = [1000.0]
    monkeypatch.setattr(orch._time, "monotonic", lambda: base[0])
    orig_sleep = fake_sleep
    def advancing_sleep(s: float) -> None:
        base[0] += s
        orig_sleep(s)
    monkeypatch.setattr(orch._time, "sleep", advancing_sleep)

    class ThrottleAlways(FakeClient):
        def fetch_first(self, code: str, date: str, time_ms: int) -> str:
            self.calls.append(_Call("first", code, date, time_ms))
            raise HogaplayHTTPError("throttled", status_code=429)

    token = CancelToken()
    fake = ThrottleAlways(info_body="info\n", first_pages={}, chart_body="chart\n")
    with pytest.raises(CaptureCancelled):
        collect_stock_date(
            client=fake, code="003490", date="20260519",
            data_dir=tmp_path, rate_limit_s=0.05,
            cancel_token=token,
        )
    # The cancel should fire on the first poll slice (≤50ms), not after the
    # full 1.0s floor.
    assert sum(sleeps) < 0.2, (
        f"expected cancel to interrupt backoff in <0.2s of sleep budget, "
        f"observed {sleeps}"
    )


def test_collect_records_stagnation_abort_in_progress_and_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the page step loop exits via the stagnation guard, _progress.json
    must record finished=False with abort_reason="stagnation_abort" so the
    parser classifies the parquet as CLIENT_INCOMPLETE, and CollectResult
    surfaces the same reason to the API layer for SSE/UI propagation.

    Without this contract the stagnation guard would silently drop the user
    into a "looks complete but is partial" data state — the exact failure
    the guard was added to detect.
    """
    from hoga.collector.page_step import StopReason
    from hoga.collector import orchestrator as orch

    # Patch _page_step_loop to skip the real pagination and force a STAGNATION
    # exit. This isolates orchestrator's stop_reason handling from the page
    # step state machine (covered in test_page_step.py).
    def fake_loop(raw_dir, client, code, date, started_at, rate_limit_s,  # noqa: ARG001
                  seen_seqs, page_idx, t, **_kwargs):
        # Simulate one captured page so the parser-state classification has
        # something to look at.
        (raw_dir / "first_00001.tsv").write_text("", encoding="utf-8")
        return seen_seqs, page_idx + 1, t, StopReason.STAGNATION

    monkeypatch.setattr(orch, "_page_step_loop", fake_loop)

    fake = FakeClient(
        info_body="info\n",
        first_pages={},
        chart_body="chart\n",
    )
    result = collect_stock_date(
        client=fake, code="003490", date="20260519",
        data_dir=tmp_path, rate_limit_s=0.0,
    )

    assert result.abort_reason == "stagnation_abort"

    progress = json.loads(
        (tmp_path / "raw" / "20260519" / "003490" / "_progress.json").read_text("utf-8")
    )
    assert progress["finished"] is False
    assert progress["abort_reason"] == "stagnation_abort"


def test_collect_raises_when_info_body_empty(tmp_path: Path) -> None:
    """hogaplay returning HTTP 200 + empty body for info.php is the
    'upstream has no data for this (code, date)' signal. The collector
    must raise UpstreamNoDataError immediately instead of writing a
    zero-byte info.tsv that later crashes the parser."""
    from hoga.collector.orchestrator import UpstreamNoDataError

    client = FakeClient(info_body="", first_pages={}, chart_body="")
    with pytest.raises(UpstreamNoDataError) as exc_info:
        collect_stock_date(
            client=client,
            code="003490",
            date="20260319",
            data_dir=tmp_path,
            rate_limit_s=0.0,
            resume=False,
        )
    assert exc_info.value.code == "003490"
    assert exc_info.value.date == "20260319"
    # info.tsv must NOT be written when the body is empty.
    info_path = tmp_path / "raw" / "20260319" / "003490" / "info.tsv"
    assert not info_path.exists()


def test_collect_raises_when_info_body_is_status_2(tmp_path: Path) -> None:
    """hogaplay's other HTTP 200 no-data status body is the bare string "2"
    (suspended / no-replay stocks — confirmed stable across retries on
    2025-04-24 258540 and 2025-08-11 086460). Like the empty body, it must
    raise UpstreamNoDataError instead of persisting a garbage 1-byte info.tsv
    that fails parsing forever with FieldCountError and is re-fetched on every
    watchlist pass. See ADR-0021 + orchestrator._is_info_no_data."""
    from hoga.collector.orchestrator import UpstreamNoDataError

    client = FakeClient(info_body="2", first_pages={}, chart_body="")
    with pytest.raises(UpstreamNoDataError) as exc_info:
        collect_stock_date(
            client=client,
            code="258540",
            date="20250424",
            data_dir=tmp_path,
            rate_limit_s=0.0,
            resume=False,
        )
    assert exc_info.value.code == "258540"
    assert exc_info.value.date == "20250424"
    # The "2" status body must NOT be persisted as info.tsv.
    info_path = tmp_path / "raw" / "20250424" / "258540" / "info.tsv"
    assert not info_path.exists()
