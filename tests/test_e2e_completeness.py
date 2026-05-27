"""End-to-end: collect → parse → list_stock_dates round-trip preserves both bits."""
from __future__ import annotations

from pathlib import Path

from hoga.api.queries import QueryEngine
from hoga.collector.orchestrator import collect_stock_date
from hoga.parser import parse_stock_date


class _NaturalTermFakeClient:
    """A fake hogaplay client that returns a deterministic small event stream
    then drains to empty so the collector reaches natural termination."""
    def __init__(self) -> None:
        self.first_calls = 0

    def fetch_info(self, code: str, date: str) -> str:
        # info.tsv shape required by parser: code, name, then 17+ tab-separated fields.
        # parts[4]=regular_session_open_ms, parts[5]=regular_session_close_ms
        # (HHMMSSmmm encoding). Must fall in the meta.{open,close}_in_kst_range
        # invariant bands (04:00-12:00 / 12:00-18:00 KST) and
        # meta.close_after_open — otherwise classify_from_meta returns INVALID
        # before the test ever reaches the completeness assertion.
        del code, date
        fields = ["0"] * 20
        fields[2] = "90000000"   # 09:00:00.000 KST → parts[4]
        fields[3] = "153000000"  # 15:30:00.000 KST → parts[5]
        return "005930\t삼성전자\t" + "\t".join(fields) + "\n"

    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        del code, date, time_ms
        self.first_calls += 1
        if self.first_calls > 3:
            return ""
        seq_base = self.first_calls * 1000
        # Dense timestamps clustered near session open. The fake intentionally
        # does NOT cover the full Data Window — so is_partial should be True
        # even though collection_complete is True (collector reached natural
        # termination by exhausting available pages).
        t_base = 90000000 + (self.first_calls - 1) * 1000  # 1s apart
        # Section=2, type=2 is a trade row in the parser; section=1 type=1 is orderbook.
        # Use orderbook (section=1 type=1) so snapshots_list is populated and
        # has_meaningful_gaps has data to inspect.
        return "\n".join(
            f"1\t1\t0\t{seq_base + i}\t{t_base + i * 100}\t000\t1000"
            for i in range(5)
        ) + "\n"

    def fetch_chart(
        self, code: str, date: str, time_ms: int, bong: int = 1, gap: int = 60000,
    ) -> str:
        del code, date, time_ms, bong, gap
        return ""


def test_collect_then_parse_then_query_marks_complete(tmp_path: Path) -> None:
    # initial_step_ms=40_000_000: after 3 captured pages we land past
    # DATA_WINDOW_END_MS within a handful of empty drains so the loop
    # terminates via EMPTY_STREAK (StopReason). With the default 60_000 step
    # the synthetic fake would stay flat long enough to trip the stagnation
    # guard (200 stagnant pages) before reaching the window end, which now
    # correctly classifies the result as abort_reason="stagnation_abort"
    # rather than a clean completion — see hoga/collector/page_step.py.
    collect_stock_date(
        client=_NaturalTermFakeClient(),
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
        initial_step_ms=40_000_000,
    )
    parse_stock_date(code="005930", date="20260520", data_dir=tmp_path, lenient=True)
    eng = QueryEngine(tmp_path)
    try:
        rows = eng.list_stock_dates()
    finally:
        eng.close()
    assert len(rows) == 1
    # Collector reached natural termination → collection_complete True.
    assert rows[0].collection_complete is True
    # Fake's events span ~3 seconds total; the rest of the trading day is empty
    # → has_meaningful_gaps returns True → is_partial True.
    assert rows[0].is_partial is True
