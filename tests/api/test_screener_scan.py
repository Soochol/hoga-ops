import polars as pl
from pathlib import Path
from hoga.api.screener_scan import run_scan
from hoga.api.models import BreakoutFilter


def _store(tmp_path, rows):
    # rows: list of (code, 'YYYY-MM-DD', high, volume); close=high, others=high
    df = pl.DataFrame({
        "code":[r[0] for r in rows], "date":[r[1] for r in rows],
        "open":[float(r[2]) for r in rows], "high":[float(r[2]) for r in rows],
        "low":[float(r[2]) for r in rows], "close":[float(r[2]) for r in rows],
        "volume":[r[3] for r in rows],
    }).with_columns(pl.col("date").str.to_date())
    p = tmp_path / "a.parquet"; df.write_parquet(p)
    s = tmp_path / "stocks.parquet"
    pl.DataFrame({"code":["000001"],"name":["에이"],"market":["KOSPI"],
                  "is_etf":[False],"is_halted":[False]}).write_parquet(s)
    return p, s


def test_new_high_hit_within_lookback(tmp_path: Path):
    rows = [("000001","2026-05-10",100,10),("000001","2026-05-11",110,10),
            ("000001","2026-05-12",105,10),("000001","2026-05-13",108,10),
            ("000001","2026-05-14",120,10)]
    p, s = _store(tmp_path, rows)
    out = run_scan(p, s, new_high=BreakoutFilter(lookback=1, period=4))
    assert len(out) == 1 and out[0].new_high.hit is True
    assert out[0].new_high.event_date == "20260514"


def test_partial_window_guard_excludes_short_history(tmp_path: Path):
    rows = [("000001","2026-05-13",100,10),("000001","2026-05-14",120,10)]  # 2 < period 5
    p, s = _store(tmp_path, rows)
    out = run_scan(p, s, new_high=BreakoutFilter(lookback=1, period=5))
    assert out == []


def test_trade_value_filter(tmp_path: Path):
    rows = [("000001","2026-05-14",100,10)]  # close*vol = 1000원
    p, s = _store(tmp_path, rows)
    assert run_scan(p, s, min_trade_value_eok=0.0)            # 통과
    assert run_scan(p, s, min_trade_value_eok=1.0) == []      # 1억 미달 → 제외


def test_days_ago_is_trading_days_not_calendar(tmp_path: Path):
    # 돌파일 05-08(금), 최신 05-13(수). 사이 주말 09-10. 거래일 거리=3, 달력=5.
    rows = [("000001","2026-05-06",10,10),("000001","2026-05-07",20,10),("000001","2026-05-08",50,10),
            ("000001","2026-05-11",15,10),("000001","2026-05-12",18,10),("000001","2026-05-13",16,10)]
    p, s = _store(tmp_path, rows)
    out = run_scan(p, s, new_high=BreakoutFilter(lookback=6, period=3))
    assert len(out) == 1
    assert out[0].new_high.event_date == "20260508"
    assert out[0].new_high.days_ago == 3          # 거래일(달력 5 아님)


def test_change_pct_populated(tmp_path: Path):
    # prev close=100 on 2026-05-13, latest close=110 on 2026-05-14 → +10.0%
    rows = [("000001", "2026-05-13", 100, 10), ("000001", "2026-05-14", 110, 10)]
    p, s = _store(tmp_path, rows)
    out = run_scan(p, s, min_trade_value_eok=0.0)
    assert len(out) == 1
    assert out[0].change_pct == 10.0


def test_change_pct_none_for_single_row(tmp_path: Path):
    # only one trading day — no previous close → change_pct must be None
    rows = [("000001", "2026-05-14", 110, 10)]
    p, s = _store(tmp_path, rows)
    out = run_scan(p, s, min_trade_value_eok=0.0)
    assert len(out) == 1
    assert out[0].change_pct is None
