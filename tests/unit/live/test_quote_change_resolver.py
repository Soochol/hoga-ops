import datetime as dt
import logging

import duckdb

from hoga.live.quote_change_resolver import QuoteChangeResolver
from hoga.live.quote_models import Quote


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

    q = Quote(code="049080", price=7770, change_pct=682.48, change_won=None)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == -21.75
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 9930
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_uses_kis_previous_close_before_adjusted_daily(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=111, change_pct=99.0, change_won=99, previous_close=110)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 0.91
    assert out.change_won == 1
    assert out.change_pct_source == "kis"
    assert out.baseline_price == 110
    assert out.baseline_date is None
    assert out.warnings == []


def test_uses_adjusted_baseline_without_warning_when_kis_matches(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=103, change_pct=3.0, change_won=3)
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

    q = Quote(code="005930", price=105, change_pct=2.1, change_won=2)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 5.0
    assert out.change_won == 5
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_hides_change_rate_when_adjusted_baseline_scale_mismatches_quote(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("049080", "2026-06-26", 993, 993, 993, 993, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(
        code="049080",
        price=6290,
        change_pct=533.43,
        change_won=5297,
        open=7550,
        high=7660,
        low=6080,
    )
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct is None
    assert out.change_won is None
    assert out.change_pct_source == "unavailable"
    assert out.baseline_price == 993
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == ["adjusted_baseline_scale_mismatch"]


def test_hides_change_rate_when_adjusted_baseline_is_stale_for_today(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=105, change_pct=2.1, change_won=2)
    out = resolver.resolve_quote(q, phase="open", today=dt.date(2026, 6, 30))

    assert out.change_pct is None
    assert out.change_won is None
    assert out.change_pct_source == "unavailable"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == ["adjusted_baseline_stale"]


def test_friday_adjusted_baseline_is_valid_on_monday(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=105, change_pct=2.1, change_won=2)
    out = resolver.resolve_quote(q, phase="open", today=dt.date(2026, 6, 29))

    assert out.change_pct == 5.0
    assert out.change_won == 5
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_ignores_same_day_adjusted_row_when_selecting_baseline(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [
            ("005930", "2026-06-29", 100, 100, 100, 100, 100),
            ("005930", "2026-06-30", 105, 105, 105, 105, 100),
        ],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=110, change_pct=1.0, change_won=1)
    out = resolver.resolve_quote(q, phase="open", today=dt.date(2026, 6, 30))

    assert out.change_pct == 10.0
    assert out.change_won == 10
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-29"
    assert out.warnings == []


def test_missing_adjusted_file_falls_back_to_kis_without_warning(tmp_path):
    resolver = QuoteChangeResolver(adjusted_daily_path=tmp_path / "missing.parquet")

    q = Quote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 3.0
    assert out.change_won == 3
    assert out.change_pct_source == "kis"
    assert out.baseline_price is None
    assert out.baseline_date is None
    assert out.warnings == []


def test_unreadable_adjusted_file_is_logged_not_swallowed(tmp_path, caplog):
    """읽기 실패는 "unavailable" 로만 나가면 원인을 못 알아본다.

    change_pct_source 의 "unavailable" 은 "코퍼스에 그 종목이 없음"(정상)과
    "parquet 읽기가 터짐"(고장)을 구분하지 못한다. 후자만 로그로 갈라진다.
    """
    daily = tmp_path / "daily_adjusted.parquet"
    daily.write_bytes(b"not a parquet file")
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=103, change_pct=None, change_won=None)
    with caplog.at_level(logging.WARNING, logger="hoga.live.quote_change_resolver"):
        out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct_source == "unavailable"  # 응답은 여전히 죽지 않는다
    records = [r for r in caplog.records if "baseline read failed" in r.getMessage()]
    assert len(records) == 1
    assert "005930" in records[0].getMessage()
    assert records[0].exc_info is not None  # 원인 예외가 붙어 있어야 손댈 수 있다


def test_unreadable_adjusted_file_logs_once_per_code(tmp_path, caplog):
    """_baseline_for 의 (code, today) 캐시가 로그 폭주를 막는다는 전제를 고정한다.

    이 캐시가 없으면 시세 폴링 주기마다 종목 수만큼 스택트레이스가 쏟아진다 —
    그러면 다음 사람이 로그를 지우게 되고, 진단 능력이 조용히 사라진다.
    """
    daily = tmp_path / "daily_adjusted.parquet"
    daily.write_bytes(b"not a parquet file")
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=103, change_pct=None, change_won=None)
    with caplog.at_level(logging.WARNING, logger="hoga.live.quote_change_resolver"):
        for _ in range(5):
            resolver.resolve_quote(q, phase="open")

    assert sum("baseline read failed" in r.getMessage() for r in caplog.records) == 1


def test_missing_adjusted_file_does_not_cache_absent_baseline(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = Quote(code="005930", price=103, change_pct=None, change_won=None)
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

    q = Quote(code="005930", price=103, change_pct=3.0, change_won=3)
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

    q = Quote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="pre_open")

    assert out.change_pct is None
    assert out.change_won is None
    assert out.change_pct_source == "hidden_pre_open"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []
