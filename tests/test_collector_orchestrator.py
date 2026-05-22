from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path

import pytest

from hoga.collector import orchestrator as orch
from hoga.collector.orchestrator import collect_stock_date, page_sort_key

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
    """Today's date + now.hour < 18 raises TodayTooEarlyRefused."""
    fixed_now = dt.datetime(2026, 5, 22, 17, 30, 0, tzinfo=dt.timezone(dt.timedelta(hours=9)))
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


def test_collect_stock_date_today_after_18_allowed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Today's date + now.hour >= 18 proceeds normally."""
    fixed_now = dt.datetime(2026, 5, 22, 18, 0, 0, tzinfo=dt.timezone(dt.timedelta(hours=9)))
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
