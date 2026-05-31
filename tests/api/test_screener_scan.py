import duckdb, datetime as dt
from pathlib import Path
from hoga.api import screener_scan
from hoga.api.models import ScreenerUniverse, TradeValueLeaf, TradeValueParams


def _seed(tmp_path: Path, rows: list[tuple], stocks: list[tuple]) -> tuple[Path, Path]:
    # rows: (code, 'YYYY-MM-DD', open, high, low, close, volume); stocks: (code,name,market,is_etf,is_halted)
    adj, stk = tmp_path / "adj.parquet", tmp_path / "stk.parquet"
    con = duckdb.connect(":memory:")
    con.execute("CREATE TABLE d(code VARCHAR, date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)")
    con.executemany("INSERT INTO d VALUES (?,?,?,?,?,?,?)", [(c, dt.date.fromisoformat(da), o, h, l, cl, v) for (c, da, o, h, l, cl, v) in rows])
    con.execute(f"COPY d TO '{adj}' (FORMAT parquet)")
    con.execute("CREATE TABLE s(code VARCHAR, name VARCHAR, market VARCHAR, is_etf BOOLEAN, is_halted BOOLEAN)")
    con.executemany("INSERT INTO s VALUES (?,?,?,?,?)", stocks)
    con.execute(f"COPY s TO '{stk}' (FORMAT parquet)")
    return adj, stk


def test_trade_value_filters_latest_day(tmp_path):
    adj, stk = _seed(tmp_path,
        rows=[("005930", "2026-05-29", 100, 100, 100, 100, 2_000_000),   # 2억
              ("005930", "2026-05-30", 100, 100, 100, 100, 6_000_000),   # 6억 latest
              ("000660", "2026-05-30", 100, 100, 100, 100, 1_000_000)],  # 1억
        stocks=[("005930", "삼성전자", "KOSPI", False, False),
                ("000660", "하이닉스", "KOSPI", False, False)])
    leaf = TradeValueLeaf(id="t", params=TradeValueParams(min_eok=5))
    rows = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in rows] == ["005930"]
    assert rows[0].code == "005930" and rows[0].trade_value_won == 600_000_000


from hoga.api.models import ChangePctLeaf, ChangePctParams

def test_change_pct_gte_latest_day(tmp_path):
    adj, stk = _seed(tmp_path,
        rows=[("005930", "2026-05-29", 100, 100, 100, 100, 1),
              ("005930", "2026-05-30", 100, 100, 100, 106, 1),    # +6%
              ("000660", "2026-05-29", 100, 100, 100, 100, 1),
              ("000660", "2026-05-30", 100, 100, 100, 103, 1)],   # +3%
        stocks=[("005930", "삼성", "KOSPI", False, False), ("000660", "하닉", "KOSPI", False, False)])
    leaf = ChangePctLeaf(id="c", params=ChangePctParams(op="gte", pct=5))
    rows = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in rows] == ["005930"]
    assert rows[0].change_pct == 6.0
