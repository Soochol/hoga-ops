import datetime as dt

import duckdb

from hoga.live.kis_client import KisQuote
from hoga.live.quote_change_resolver import QuoteChangeResolver


def _write_adjusted_daily(path, rows):
    with duckdb.connect(":memory:") as con:
        con.execute(
            "CREATE TABLE d(code VARCHAR, date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)"
        )
        con.executemany(
            "INSERT INTO d VALUES (?,?,?,?,?,?,?)",
            [
                (code, dt.date.fromisoformat(date_s), open_, high, low, close, volume)
                for code, date_s, open_, high, low, close, volume in rows
            ],
        )
        con.execute(f"COPY d TO '{path}' (FORMAT parquet)")


def test_uses_adjusted_baseline_when_kis_change_rate_disagrees(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("049080", "2026-06-26", 9930, 9930, 9930, 9930, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = KisQuote(code="049080", price=7770, change_pct=682.48, change_won=None)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == -21.75
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 9930
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_uses_adjusted_baseline_without_warning_when_kis_matches(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = KisQuote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 3.0
    assert out.change_won == 3
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_recomputes_change_rate_from_adjusted_baseline_even_when_kis_diff_is_small(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = KisQuote(code="005930", price=105, change_pct=2.1, change_won=2)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 5.0
    assert out.change_won == 5
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_missing_adjusted_file_falls_back_to_kis_without_warning(tmp_path):
    resolver = QuoteChangeResolver(adjusted_daily_path=tmp_path / "missing.parquet")

    q = KisQuote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 3.0
    assert out.change_won == 3
    assert out.change_pct_source == "kis"
    assert out.baseline_price is None
    assert out.baseline_date is None
    assert out.warnings == []


def test_missing_adjusted_file_does_not_cache_absent_baseline(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = KisQuote(code="005930", price=103, change_pct=None, change_won=None)
    before = resolver.resolve_quote(q, phase="open")
    assert before.change_pct is None
    assert before.change_pct_source == "unavailable"

    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )

    after = resolver.resolve_quote(q, phase="open")
    assert after.change_pct == 3.0
    assert after.change_won == 3
    assert after.baseline_price == 100
    assert after.baseline_date == "2026-06-26"
    assert after.change_pct_source == "adjusted_daily"


def test_invalid_baseline_falls_back_to_kis_and_marks_warning(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 0, 0, 0, 0, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = KisQuote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 3.0
    assert out.change_pct_source == "kis"
    assert out.baseline_price is None
    assert out.baseline_date is None
    assert out.warnings == ["adjusted_baseline_unavailable"]


def test_pre_open_hides_change_fields_even_with_baseline(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = KisQuote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="pre_open")

    assert out.change_pct is None
    assert out.change_won is None
    assert out.change_pct_source == "hidden_pre_open"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []
