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


def test_scan_filters_noncorpus_market_and_null_name(tmp_path):
    # #12: 상류 stocks 에 KONEX/NULL-name 행이 섞여도 한 행이 ScreenerRow(Literal
    # market·필수 name) 생성을 깨 전체 스캔을 500 시키지 않는다 — SQL 가드로 걸러
    # 유효 KOSPI/KOSDAQ·non-null name 행만 반환(기본 universe=markets 무제한이어도).
    adj, stk = _seed(tmp_path,
        rows=[("005930", "2026-05-30", 100, 100, 100, 100, 1),
              ("111111", "2026-05-30", 100, 100, 100, 100, 1),   # KONEX
              ("222222", "2026-05-30", 100, 100, 100, 100, 1)],  # NULL name
        stocks=[("005930", "삼성", "KOSPI", False, False),
                ("111111", "코넥스주", "KONEX", False, False),
                ("222222", None, "KOSDAQ", False, False)])
    rows = screener_scan.run_scan(adj, stk, conditions=[], universe=ScreenerUniverse())
    assert [r.code for r in rows] == ["005930"]   # 불량 2행 제외, 크래시 없음


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


# ---------------------------------------------------------------------------
# Drift guard: ConditionLeaf union type literals == CONDITION_COMPILERS keys
# ---------------------------------------------------------------------------
from typing import get_args

from hoga.api.models import ConditionLeaf
from hoga.api.screener_scan import CONDITION_COMPILERS


def test_every_condition_leaf_has_a_compiler():
    # ConditionLeaf = Annotated[Union[...Leaf], Field(discriminator="type")]
    # get_args(Annotated[X, meta]) -> (X, meta); unwrap to the Union, then its members.
    union = get_args(ConditionLeaf)[0]
    leaf_models = get_args(union)
    leaf_types = {m.model_fields["type"].default for m in leaf_models}

    # Non-vacuous: introspection must actually have extracted the literals.
    assert leaf_types, "failed to introspect ConditionLeaf union type literals"
    assert len(leaf_types) == len(leaf_models)  # each leaf has a distinct type literal

    assert leaf_types == set(CONDITION_COMPILERS), (
        f"condition drift — union types {leaf_types} != compilers {set(CONDITION_COMPILERS)}"
    )


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


from hoga.api.models import TradeValuePeriodLeaf, TradeValuePeriodParams

def test_trade_value_period_threshold_within_lookback(tmp_path):
    # 005930: 3억 날이 2거래일 전(lookback 3 안) → 매치.
    # 000660: 유일한 3억 날이 5거래일 전(lookback 3 밖) → 미스. OHLC 평탄(avg=close).
    rows = [("005930","2026-05-26",100,100,100,100,1_000_000),
            ("005930","2026-05-27",100,100,100,100,3_000_000),   # 3억, 2일 전(rn=3)
            ("005930","2026-05-28",100,100,100,100,1_000_000),
            ("005930","2026-05-29",100,100,100,100,1_000_000),
            ("000660","2026-05-25",100,100,100,100,3_000_000),   # 3억, 5일 전(rn=5)
            ("000660","2026-05-26",100,100,100,100,1_000_000),
            ("000660","2026-05-27",100,100,100,100,1_000_000),
            ("000660","2026-05-28",100,100,100,100,1_000_000),
            ("000660","2026-05-29",100,100,100,100,1_000_000)]
    adj, stk = _seed(tmp_path, rows=rows,
        stocks=[("005930","a","KOSPI",False,False),("000660","b","KOSPI",False,False)])
    leaf = TradeValuePeriodLeaf(id="tp", params=TradeValuePeriodParams(lookback=3, min_eok=3))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["005930"]

def test_trade_value_period_short_history_eligible(tmp_path):
    # 임계값 가족은 wc 가드 없음 — 상장 2일짜리도 보유일 중 도달하면 매치.
    rows = [("000111","2026-05-28",100,100,100,100,1_000_000),
            ("000111","2026-05-29",100,100,100,100,3_000_000)]
    adj, stk = _seed(tmp_path, rows=rows, stocks=[("000111","a","KOSPI",False,False)])
    leaf = TradeValuePeriodLeaf(id="tp", params=TradeValuePeriodParams(lookback=60, min_eok=3))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000111"]


from hoga.api.models import NewHighTodayLeaf, NewHighVolTodayLeaf, PeriodParams

def test_new_high_today_vs_period_divergence(tmp_path):
    # A(000111): 최신일까지 상승 → 오늘이 5일 신고가.
    # B(000222): 5일 신고가를 day5에 찍고 이후 하락 → 오늘은 신고가 아님, 그러나
    #            최근 5일 내 돌파 이력은 있음. 당일/기간내가 갈려야 신규 타입이 진짜 다름.
    a = [("000111", f"2026-04-{d:02d}", 0, 100+d, 0, 100+d, 1) for d in range(1, 9)]   # 고가 101..108
    bh = [100, 101, 102, 103, 104, 103, 102, 101]                                       # day5=104 peak
    b = [("000222", f"2026-04-{d:02d}", 0, h, 0, h, 1) for d, h in zip(range(1, 9), bh)]
    adj, stk = _seed(tmp_path, rows=a + b,
        stocks=[("000111","a","KOSPI",False,False),("000222","b","KOSPI",False,False)])
    today = NewHighTodayLeaf(id="t", params=PeriodParams(period=5))
    period = NewHighLeaf(id="p", params=BreakoutParams(lookback=5, period=5))
    out_today = screener_scan.run_scan(adj, stk, conditions=[today], universe=ScreenerUniverse())
    out_period = screener_scan.run_scan(adj, stk, conditions=[period], universe=ScreenerUniverse())
    assert [r.code for r in out_today] == ["000111"]                       # 당일: 오늘 신고만
    assert sorted(r.code for r in out_period) == ["000111", "000222"]      # 기간내: 둘 다

def test_new_high_today_wc_window_guard(tmp_path):
    # period=5: 상장 3일 종목은 wc=5 불충족 → 제외; 6일 상승 종목은 오늘이 신고 → 포함.
    short = [("000111", f"2026-05-{d:02d}", 0, 100+d, 0, 100+d, 1) for d in range(10, 13)]
    full = [("000222", f"2026-05-{d:02d}", 0, 100+d, 0, 100+d, 1) for d in range(10, 16)]
    adj, stk = _seed(tmp_path, rows=short + full,
        stocks=[("000111","a","KOSPI",False,False),("000222","b","KOSPI",False,False)])
    leaf = NewHighTodayLeaf(id="g", params=PeriodParams(period=5))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000222"]

def test_new_high_vol_today_latest_is_volume_peak(tmp_path):
    # A: 거래량이 오늘 최고; B: 거래량이 과거에 최고, 오늘은 최저.
    a = [("000111", f"2026-05-{d:02d}", 0, 1, 0, 1, vol) for d, vol in zip(range(10, 14), [10, 20, 30, 40])]
    b = [("000222", f"2026-05-{d:02d}", 0, 1, 0, 1, vol) for d, vol in zip(range(10, 14), [40, 30, 20, 10])]
    adj, stk = _seed(tmp_path, rows=a + b,
        stocks=[("000111","a","KOSPI",False,False),("000222","b","KOSPI",False,False)])
    leaf = NewHighVolTodayLeaf(id="v", params=PeriodParams(period=4))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["000111"]

def test_new_high_today_equals_breakout_lookback1(tmp_path):
    # 동치 보증: new_high_today(P) == new_high(lookback=1, period=P).
    hs = [100, 105, 103, 108, 107, 110, 109, 112]
    rows = [("000111", f"2026-05-{d:02d}", 0, h, 0, h, 1) for d, h in zip(range(10, 18), hs)]
    adj, stk = _seed(tmp_path, rows=rows, stocks=[("000111","a","KOSPI",False,False)])
    today = screener_scan.run_scan(adj, stk,
        conditions=[NewHighTodayLeaf(id="t", params=PeriodParams(period=5))], universe=ScreenerUniverse())
    bk1 = screener_scan.run_scan(adj, stk,
        conditions=[NewHighLeaf(id="b", params=BreakoutParams(lookback=1, period=5))], universe=ScreenerUniverse())
    assert [r.code for r in today] == [r.code for r in bk1]
