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
        # Minimum that parses successfully — pad with zeros.
        del code, date
        return (
            "005930\t삼성전자\t" + "\t".join(["0"] * 20) + "\n"
        )

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
    collect_stock_date(
        client=_NaturalTermFakeClient(),
        code="005930",
        date="20260520",
        data_dir=tmp_path,
        rate_limit_s=0.0,
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
