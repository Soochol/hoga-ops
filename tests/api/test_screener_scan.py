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

def test_change_pct_lte_latest_day(tmp_path):
    # 005930 latest -6% (<= -5 → pass), 000660 latest -3% (excluded).
    adj, stk = _seed(tmp_path,
        rows=[("005930", "2026-05-29", 100, 100, 100, 100, 1),
              ("005930", "2026-05-30", 100, 100, 100, 94, 1),     # -6%
              ("000660", "2026-05-29", 100, 100, 100, 100, 1),
              ("000660", "2026-05-30", 100, 100, 100, 97, 1)],    # -3%
        stocks=[("005930", "삼성", "KOSPI", False, False), ("000660", "하닉", "KOSPI", False, False)])
    leaf = ChangePctLeaf(id="c", params=ChangePctParams(op="lte", pct=-5))
    rows = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in rows] == ["005930"]
    assert rows[0].change_pct == -6.0

def test_change_pct_between_latest_day(tmp_path):
    # 005930 latest +3% (within [2,5] → pass), 000660 latest +8% (out of range → excluded).
    adj, stk = _seed(tmp_path,
        rows=[("005930", "2026-05-29", 100, 100, 100, 100, 1),
              ("005930", "2026-05-30", 100, 100, 100, 103, 1),    # +3%
              ("000660", "2026-05-29", 100, 100, 100, 100, 1),
              ("000660", "2026-05-30", 100, 100, 100, 108, 1)],   # +8%
        stocks=[("005930", "삼성", "KOSPI", False, False), ("000660", "하닉", "KOSPI", False, False)])
    leaf = ChangePctLeaf(id="c", params=ChangePctParams(op="between", lo=2, hi=5))
    rows = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in rows] == ["005930"]
    assert rows[0].change_pct == 3.0


from hoga.api.models import PriceRangeLeaf, PriceRangeParams

def test_price_range_both_bounds(tmp_path):
    adj, stk = _seed(tmp_path,
        rows=[("005930", "2026-05-30", 0, 0, 0, 5000, 1),
              ("000660", "2026-05-30", 0, 0, 0, 25000, 1),
              ("035420", "2026-05-30", 0, 0, 0, 80000, 1)],
        stocks=[("005930","a","KOSPI",False,False),("000660","b","KOSPI",False,False),("035420","c","KOSPI",False,False)])
    leaf = PriceRangeLeaf(id="p", params=PriceRangeParams(min=10000, max=50000))
    rows = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in rows] == ["000660"]

def test_price_range_min_only(tmp_path):
    # min-only: 25000 passes >=10000, 5000 excluded.
    adj, stk = _seed(tmp_path,
        rows=[("005930", "2026-05-30", 0, 0, 0, 5000, 1),
              ("000660", "2026-05-30", 0, 0, 0, 25000, 1)],
        stocks=[("005930","a","KOSPI",False,False),("000660","b","KOSPI",False,False)])
    leaf = PriceRangeLeaf(id="p", params=PriceRangeParams(min=10000))
    rows = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in rows] == ["000660"]

def test_price_range_max_only(tmp_path):
    # max-only: 5000 passes <=10000, 25000 excluded.
    adj, stk = _seed(tmp_path,
        rows=[("005930", "2026-05-30", 0, 0, 0, 5000, 1),
              ("000660", "2026-05-30", 0, 0, 0, 25000, 1)],
        stocks=[("005930","a","KOSPI",False,False),("000660","b","KOSPI",False,False)])
    leaf = PriceRangeLeaf(id="p", params=PriceRangeParams(max=10000))
    rows = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in rows] == ["005930"]


from hoga.api.models import MaLeaf, MaParams

def _ramp(code, start, n, step):  # n 연속 거래일, close = start, start+step, ...
    return [(code, f"2026-0{3 + (d // 28)}-{(d % 28) + 1:02d}", 0, 0, 0, start + d * step, 1) for d in range(n)]

def test_ma_above_and_window_guard(tmp_path):
    # 000111: 25거래일 상승추세 → 최신 close > MA20 (above). wc=20 충족.
    # 000222: 10거래일만 상장 → wc<20 → MA20 평가 불가 → 제외.
    rows = _ramp("000111", 1000, 25, 100) + _ramp("000222", 1000, 10, 100)
    adj, stk = _seed(tmp_path, rows=rows,
        stocks=[("000111","a","KOSPI",False,False),("000222","b","KOSPI",False,False)])
    leaf = MaLeaf(id="m", params=MaParams(period=20, relation="above"))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000111"]           # 000222 excluded by wc<20

def test_ma_below(tmp_path):
    rows = _ramp("000111", 3500, 25, -100)               # 하락추세 → close < MA20
    adj, stk = _seed(tmp_path, rows=rows, stocks=[("000111","a","KOSPI",False,False)])
    leaf = MaLeaf(id="m", params=MaParams(period=20, relation="below"))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000111"]


from hoga.api.models import NewHighLeaf, BreakoutParams

def test_repeated_new_high_and(tmp_path):
    # AND of (20,20) and (5,5) new_high leaves.
    # 005930: 25거래일 꾸준 신고가(101..125) → 두 윈도우 모두 매칭.
    # 000660: d1..d20 고가 하락(200..181) → (20,20) 절대 불충족; d21..d25 저점 반등(120..124)
    #         → (5,5)만 매칭. AND이므로 (20,20) 실패로 제외돼야 함.
    rising = [("005930", f"2026-04-{d:02d}", 0, 100 + d, 0, 100 + d, 1) for d in range(1, 26)]
    decline = [("000660", f"2026-04-{d:02d}", 0, 200 - (d - 1), 0, 200 - (d - 1), 1) for d in range(1, 21)]
    bump = [("000660", f"2026-04-{d:02d}", 0, 120 + (d - 21), 0, 120 + (d - 21), 1) for d in range(21, 26)]
    adj, stk = _seed(tmp_path, rows=rising + decline + bump,
        stocks=[("005930","a","KOSPI",False,False),("000660","b","KOSPI",False,False)])
    leaves = [NewHighLeaf(id="h1", params=BreakoutParams(lookback=20, period=20)),
              NewHighLeaf(id="h2", params=BreakoutParams(lookback=5, period=5))]
    out = screener_scan.run_scan(adj, stk, conditions=leaves, universe=ScreenerUniverse())
    assert [r.code for r in out] == ["005930"]      # 000660 fails the (20,20) leaf → AND excludes it

def test_new_high_wc_window_guard(tmp_path):
    # wc=M partial-window guard: a code with fewer than M trading days can never
    # reach wc=M → excluded; a code with >= M rising-high days is included.
    short_hist = [("000111", "2026-05-13", 0, 100, 0, 100, 1),
                  ("000111", "2026-05-14", 0, 120, 0, 120, 1)]                 # 2 days < period 5
    full_hist = [("000222", f"2026-05-{d:02d}", 0, 100 + d, 0, 100 + d, 1) for d in range(10, 15)]  # 5 rising days
    adj, stk = _seed(tmp_path, rows=short_hist + full_hist,
        stocks=[("000111","a","KOSPI",False,False),("000222","b","KOSPI",False,False)])
    leaf = NewHighLeaf(id="g", params=BreakoutParams(lookback=1, period=5))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000222"]      # 000111 excluded by wc<5

def test_new_high_lookback_window_boundary(tmp_path):
    # Lookback Window: a genuine breakout (wc=M satisfied) that happened MORE than
    # N trading days ago is NOT matched; one within the last N days IS matched.
    # 000111 highs 100,110,105,102: real breakout at day-2 (wc=2), but the last 2
    #   days (105,102) sit below their window max → excluded by lookback alone.
    # 000222 highs 100,110,120,130: day-4 is a breakout inside the last 2 days.
    nm = [("000111", f"2026-04-0{d}", 0, h, 0, h, 1) for d, h in zip(range(1, 5), [100, 110, 105, 102])]
    m = [("000222", f"2026-04-0{d}", 0, h, 0, h, 1) for d, h in zip(range(1, 5), [100, 110, 120, 130])]
    adj, stk = _seed(tmp_path, rows=nm + m,
        stocks=[("000111","a","KOSPI",False,False),("000222","b","KOSPI",False,False)])
    leaf = NewHighLeaf(id="b", params=BreakoutParams(lookback=2, period=2))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000222"]      # 000111's breakout is outside the 2-day lookback

def test_new_high_tie_is_inclusive(tmp_path):
    # tie >=: a flat run (100,100,100) — the latest high EQUALS the trailing
    # M-window max, so v >= mx holds and the code matches (tie is a breakout).
    flat = [("000111", f"2026-05-{d:02d}", 0, 100, 0, 100, 1) for d in range(12, 15)]
    adj, stk = _seed(tmp_path, rows=flat, stocks=[("000111","a","KOSPI",False,False)])
    leaf = NewHighLeaf(id="t", params=BreakoutParams(lookback=1, period=3))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000111"]

def test_code_roundtrip_leading_zero(tmp_path):
    adj, stk = _seed(tmp_path, rows=[("005930", "2026-05-30", 0, 0, 0, 100, 9_999_999)],
        stocks=[("005930", "삼성전자", "KOSPI", False, False)])
    out = screener_scan.run_scan(adj, stk, conditions=[], universe=ScreenerUniverse())
    assert out[0].code == "005930"            # VARCHAR preserved, not 5930


def test_trade_value_uses_ohlc_average_price(tmp_path):
    # close*volume = 1억(<2) 이지만 avg(OHLC)*volume = 2.5억(>=2). 새 산식이
    # 임계값 매칭과 표시 trade_value_won 둘 다를 구동해야 한다.
    adj, stk = _seed(tmp_path,
        rows=[("005930", "2026-05-30", 300, 300, 300, 100, 1_000_000)],
        stocks=[("005930", "삼성", "KOSPI", False, False)])
    leaf = TradeValueLeaf(id="t", params=TradeValueParams(min_eok=2))
    rows = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in rows] == ["005930"]
    assert rows[0].trade_value_won == 250_000_000
