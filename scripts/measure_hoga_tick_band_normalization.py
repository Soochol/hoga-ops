"""호가단위 밴드폭이 총잔량 지표를 왜곡하는 정도를 실측한다.

`docs/research/2026-08-19-hoga-tick-band-totals-normalization.md` 의 모든 수치를
재생산하는 스크립트. 캡처 파케이만 읽고 벤더를 부르지 않는다(읽기 전용).

    uv run python scripts/measure_hoga_tick_band_normalization.py band
    uv run python scripts/measure_hoga_tick_band_normalization.py crossings
    uv run python scripts/measure_hoga_tick_band_normalization.py pure
    uv run python scripts/measure_hoga_tick_band_normalization.py placebo
    uv run python scripts/measure_hoga_tick_band_normalization.py surge
    uv run python scripts/measure_hoga_tick_band_normalization.py profile
    uv run python scripts/measure_hoga_tick_band_normalization.py ratio
    uv run python scripts/measure_hoga_tick_band_normalization.py case 006400 20260818 500000

소스는 **hogaplay 단일**로 고정한다 — kiwoom_live 는 KRX/NXT/UN 으로 갈려 venue 별
사다리가 섞이므로 이 측정에는 부적합하다.

시간 인코딩 함정이 둘이다(둘을 섞으면 필터가 전부 비어 조용히 0건이 된다):
  snapshots.parquet `ts_ms` = HHMMSSmmm native  → 09:00~15:30 은 90000000~153000000
  candles.parquet   `ts_ms` = 자정부터 선형 ms  → 09:00~15:30 은 32400000~55800000
"""

from __future__ import annotations

import glob
import json
import os
import random
import sys
from collections import defaultdict
from pathlib import Path

import duckdb

# --- 공통 -----------------------------------------------------------------

DATA_ROOT = Path(
    os.environ.get("HOGA_DATA_DIR", Path.home() / ".local/share/hoga-ops/data")
) / "parquet"
SCRATCH = Path(os.environ.get("TMPDIR", "/tmp")) / "hoga-tick-band"

#: 연속거래 호가창 술어 — hoga.tables.snapshots._DEEP_BOOK_SQL 과 글자 그대로 같다.
DEEP = (
    "(" + "+".join(f"ask_q{i}::BIGINT" for i in range(4, 11)) + ") > 0 AND ("
    + "+".join(f"bid_q{i}::BIGINT" for i in range(4, 11)) + ") > 0"
)
AQ = "+".join(f"ask_q{i}::BIGINT" for i in range(1, 11))
BQ = "+".join(f"bid_q{i}::BIGINT" for i in range(1, 11))
SESSION = "ts_ms BETWEEN 90000000 AND 153000000"          # snapshots: HHMMSSmmm
SESSION_CANDLE = "ts_ms BETWEEN 32400000 AND 55800000"    # candles: 선형 ms
FULL_BOOK = "ask_p1>0 AND bid_p1>0 AND ask_p10>0 AND bid_p10>0"

#: §2 에서 사다리 인접 호가 간격으로 **역산해 확인한** KRX 주식 호가단위 경계.
#: 코드가 이 표에 의존하지 않도록, 경계 탐색에만 쓰고 지표 계산에는 쓰지 않는다.
BOUNDS = (2_000, 5_000, 20_000, 50_000, 200_000, 500_000)

#: 고정 %밴드안(C안)의 기본 X. §5 의 "X 선택" 갈림길이 열려 있는 잠정값이다.
FIXED_BAND = 0.004

#: 위약군 선정 — 경계 통과군과 **가격 이동폭을 맞추기 위한** 하한. 통과군의 일중폭
#: 중앙값 언저리다. 이 값을 낮추면 거의 움직이지 않은 종목이 섞여 대조가 무력해진다.
MIN_INTRADAY_RANGE = 0.05
#: 급증 검출에 필요한 최소 1분봉 수. 반나절 이하 캡처는 running peak 이 안 선다.
MIN_BUCKETS = 60
#: 사다리 위치 코드 — 0 가는틱 / 1 걸침 / 2 굵은틱.
REG_FINE, REG_STRADDLE, REG_COARSE = 0, 1, 2


def fixed_band_sql(r: float = FIXED_BAND) -> tuple[str, str]:
    """mid ±r 안의 매도/매수 잔량 합 SQL. 호가단위표가 필요 없다는 것이 C안의 요점."""
    ask = "+".join(
        f"CASE WHEN ask_p{i}>0 AND ask_p{i}<=mid*(1+{r}) THEN ask_q{i} ELSE 0 END"
        for i in range(1, 11)
    )
    bid = "+".join(
        f"CASE WHEN bid_p{i}>0 AND bid_p{i}>=mid*(1-{r}) THEN bid_q{i} ELSE 0 END"
        for i in range(1, 11)
    )
    return ask, bid


def connect() -> duckdb.DuckDBPyConnection:
    return duckdb.connect(config={"memory_limit": "4GB", "threads": "4"})


def trading_days(n: int) -> list[str]:
    return sorted(d for d in os.listdir(DATA_ROOT) if d.startswith("20"))[-n:]


def snapshots_of(day: str, code: str) -> Path:
    return DATA_ROOT / day / code / "hogaplay" / "snapshots.parquet"


def table(title: str, header: list[str], rows: list[tuple]) -> None:
    print("===", title)
    print(" | ".join(header))
    for r in rows:
        print(" | ".join(
            "" if v is None else (f"{v:,.3f}" if isinstance(v, float) else str(v))
            for v in r
        ))
    print()


# --- band: 10호가가 덮는 %폭 · 실측 호가단위표 -----------------------------

def cmd_band(day: str = "20260818") -> None:
    con = connect()
    con.execute(
        "CREATE TABLE o(code VARCHAR, n BIGINT, mid DOUBLE, tick DOUBLE,"
        " tick_pct DOUBLE, band_pct DOUBLE, spread_gt1_pct DOUBLE, span_ticks DOUBLE)"
    )
    for f in sorted(glob.glob(str(DATA_ROOT / day / "*" / "hogaplay" / "snapshots.parquet"))):
        code = f.split("/")[-3]
        # 틱 추정은 **인접 호가 간격의 최솟값**이다. 빈 단계가 있으면 간격이 틱의
        # 배수로 나오므로 최솟값이 참값에 가장 가깝다.
        con.execute(f"""INSERT INTO o
        WITH s AS (SELECT ask_p1,bid_p1,ask_p2,bid_p2,ask_p10,bid_p10
          FROM read_parquet('{f}') WHERE {DEEP} AND {SESSION} AND {FULL_BOOK}),
        t AS (SELECT (ask_p1+bid_p1)/2.0 mid,
                LEAST(ask_p2-ask_p1, bid_p1-bid_p2) tick,
                (ask_p1-bid_p1) spread, (ask_p10-bid_p10)::DOUBLE band
              FROM s WHERE ask_p2>ask_p1 AND bid_p1>bid_p2)
        SELECT '{code}', count(*), median(mid), median(tick), median(tick/mid*100),
          median(band/mid*100), avg(CASE WHEN spread>tick THEN 1.0 ELSE 0.0 END)*100,
          median(band/tick) FROM t""")
    table("10호가가 덮는 %폭 — 종목별 중앙값의 분포", ["min", "p10", "p50", "p90", "max"],
          con.execute("""SELECT min(band_pct), quantile_cont(band_pct,0.1), median(band_pct),
            quantile_cont(band_pct,0.9), max(band_pct) FROM o WHERE n>0""").fetchall())
    table("스프레드 > 1틱인 스냅샷 비율", ["p10", "p50", "p90", "max"],
          con.execute("""SELECT quantile_cont(spread_gt1_pct,0.1), median(spread_gt1_pct),
            quantile_cont(spread_gt1_pct,0.9), max(spread_gt1_pct) FROM o WHERE n>0""").fetchall())
    table("실측 호가단위표 (역산)", ["tick", "codes", "price_min", "price_max", "tick%", "band%", "span_ticks"],
          con.execute("""SELECT tick, count(*), min(mid), max(mid), median(tick_pct),
            median(band_pct), median(span_ticks) FROM o WHERE n>0 GROUP BY 1 ORDER BY 1""").fetchall())


# --- crossings: 경계 통과 종목일 탐색 --------------------------------------

def cmd_crossings(days: int = 25) -> list[tuple]:
    """candles 저·고가로 싸게 후보를 좁힌다(스냅샷 전수 스캔 회피)."""
    con, hits, scanned = connect(), [], 0
    for day in trading_days(days):
        files = sorted(glob.glob(str(DATA_ROOT / day / "*" / "hogaplay" / "candles.parquet")))
        if not files:
            continue
        rows = con.execute(f"""
          SELECT regexp_extract(filename,'/([0-9A-Z]+)/hogaplay/',1) code, min(low), max(high)
          FROM read_parquet({files!r}, filename=true)
          WHERE low>0 AND {SESSION_CANDLE} GROUP BY 1""").fetchall()
        scanned += len(rows)
        hits += [(day, c, lo, hi, b) for c, lo, hi in rows for b in BOUNDS if lo < b <= hi]
    SCRATCH.mkdir(parents=True, exist_ok=True)
    (SCRATCH / "crossings.json").write_text(json.dumps(hits))
    print(f"stock-day {scanned}건 중 경계 통과 {len(hits)}건 = {len(hits)/max(scanned,1)*100:.2f}%")
    return hits


def _crossings_cached(days: int = 25) -> list[tuple]:
    p = SCRATCH / "crossings.json"
    if p.exists():
        return [tuple(x) for x in json.loads(p.read_text())]
    return cmd_crossings(days)


# --- pure: 순수 틱영역 대조 (raw / ÷폭 / 고정밴드) --------------------------

def cmd_pure() -> None:
    fa, fb = fixed_band_sql()
    con = connect()
    con.execute("""CREATE TABLE r(bound BIGINT, n_lo BIGINT, n_hi BIGINT,
      mid_lo DOUBLE, mid_hi DOUBLE, band_lo DOUBLE, band_hi DOUBLE,
      araw_lo DOUBLE, araw_hi DOUBLE, braw_lo DOUBLE, braw_hi DOUBLE,
      aper_lo DOUBLE, aper_hi DOUBLE, bper_lo DOUBLE, bper_hi DOUBLE,
      afix_lo DOUBLE, afix_hi DOUBLE, bfix_lo DOUBLE, bfix_hi DOUBLE)""")
    for day, code, _lo, _hi, b in _crossings_cached():
        f = snapshots_of(day, code)
        if not f.exists():
            continue
        # 'lo' = 사다리 **전체**가 경계 아래(가는 틱), 'hi' = 전체가 위(굵은 틱).
        # 걸친 스냅샷을 빼는 것이 이 대조의 핵심 — 안 빼면 두 틱이 섞여 희석된다.
        con.execute(f"""INSERT INTO r
        WITH s AS (SELECT *, (ask_p1+bid_p1)/2.0 mid FROM read_parquet('{f}')
          WHERE {DEEP} AND {SESSION} AND {FULL_BOOK}),
        t AS (SELECT mid, ({AQ})::DOUBLE aq, ({BQ})::DOUBLE bq,
                (ask_p10-bid_p10)/mid*100 bandpct, ({fa})::DOUBLE af, ({fb})::DOUBLE bf,
                CASE WHEN ask_p10 < {b} THEN 'lo' WHEN bid_p10 >= {b} THEN 'hi' END reg
              FROM s WHERE mid BETWEEN {b}*0.95 AND {b}*1.05)
        SELECT {b}, count(*) FILTER (WHERE reg='lo'), count(*) FILTER (WHERE reg='hi'),
          median(mid) FILTER (WHERE reg='lo'), median(mid) FILTER (WHERE reg='hi'),
          median(bandpct) FILTER (WHERE reg='lo'), median(bandpct) FILTER (WHERE reg='hi'),
          median(aq) FILTER (WHERE reg='lo'), median(aq) FILTER (WHERE reg='hi'),
          median(bq) FILTER (WHERE reg='lo'), median(bq) FILTER (WHERE reg='hi'),
          median(aq/bandpct) FILTER (WHERE reg='lo'), median(aq/bandpct) FILTER (WHERE reg='hi'),
          median(bq/bandpct) FILTER (WHERE reg='lo'), median(bq/bandpct) FILTER (WHERE reg='hi'),
          median(af) FILTER (WHERE reg='lo'), median(af) FILTER (WHERE reg='hi'),
          median(bf) FILTER (WHERE reg='lo'), median(bf) FILTER (WHERE reg='hi') FROM t""")
    g = "n_lo>=200 AND n_hi>=200 AND araw_lo>0 AND braw_lo>0 AND afix_lo>0 AND bfix_lo>0"
    table("굵은틱 / 가는틱 배율 (중앙값)",
          ["밴드폭", "가격", "raw매도", "raw매수", "÷폭매도", "÷폭매수", "고정매도", "고정매수", "n"],
          con.execute(f"""SELECT median(band_hi/band_lo), median(mid_hi/mid_lo),
            median(araw_hi/araw_lo), median(braw_hi/braw_lo),
            median(aper_hi/aper_lo), median(bper_hi/bper_lo),
            median(afix_hi/afix_lo), median(bfix_hi/bfix_lo), count(*)
            FROM r WHERE {g}""").fetchall())
    table("경계별", ["경계", "n", "밴드폭", "raw매도", "raw매수", "고정매도", "고정매수"],
          con.execute(f"""SELECT bound, count(*), median(band_hi/band_lo),
            median(araw_hi/araw_lo), median(braw_hi/braw_lo),
            median(afix_hi/afix_lo), median(bfix_hi/bfix_lo)
            FROM r WHERE {g} GROUP BY 1 ORDER BY 1""").fetchall())


# --- placebo: 경계를 지나지 않은 종목일 -------------------------------------

def _placebo_candidates(con, days: int, sample: int) -> list[tuple]:
    out = []
    for day in trading_days(days):
        files = sorted(glob.glob(str(DATA_ROOT / day / "*" / "hogaplay" / "candles.parquet")))
        if not files:
            continue
        for code, lo, hi in con.execute(f"""
            SELECT regexp_extract(filename,'/([0-9A-Z]+)/hogaplay/',1), min(low), max(high)
            FROM read_parquet({files!r}, filename=true)
            WHERE low>0 AND {SESSION_CANDLE} GROUP BY 1""").fetchall():
            # 일중폭 5% 이상 = 경계 통과군과 가격 이동폭을 맞춘다. 통과군은 제외.
            if (lo > 0 and (hi - lo) / lo >= MIN_INTRADAY_RANGE
                    and not any(lo < b <= hi for b in BOUNDS)):
                out.append((day, code, lo, hi))
    random.Random(0).shuffle(out)
    return out[:sample]


def cmd_placebo(days: int = 25, sample: int = 200) -> None:
    con = connect()
    con.execute("""CREATE TABLE c(n_lo BIGINT, n_hi BIGINT, mid_lo DOUBLE, mid_hi DOUBLE,
      band_lo DOUBLE, band_hi DOUBLE, araw_lo DOUBLE, araw_hi DOUBLE,
      braw_lo DOUBLE, braw_hi DOUBLE, rt_lo DOUBLE, rt_hi DOUBLE)""")
    for day, code, lo, hi in _placebo_candidates(con, days, sample):
        f = snapshots_of(day, code)
        if not f.exists():
            continue
        cut = (lo + hi) / 2.0
        con.execute(f"""INSERT INTO c
        WITH s AS (SELECT *, (ask_p1+bid_p1)/2.0 mid FROM read_parquet('{f}')
          WHERE {DEEP} AND {SESSION} AND {FULL_BOOK}),
        t AS (SELECT mid, ({AQ})::DOUBLE aq, ({BQ})::DOUBLE bq,
                (ask_p10-bid_p10)/mid*100 bandpct,
                CASE WHEN mid < {cut} THEN 'lo' ELSE 'hi' END reg FROM s WHERE ({BQ})>0)
        SELECT count(*) FILTER (WHERE reg='lo'), count(*) FILTER (WHERE reg='hi'),
          median(mid) FILTER (WHERE reg='lo'), median(mid) FILTER (WHERE reg='hi'),
          median(bandpct) FILTER (WHERE reg='lo'), median(bandpct) FILTER (WHERE reg='hi'),
          median(aq) FILTER (WHERE reg='lo'), median(aq) FILTER (WHERE reg='hi'),
          median(bq) FILTER (WHERE reg='lo'), median(bq) FILTER (WHERE reg='hi'),
          median(aq/bq) FILTER (WHERE reg='lo'), median(aq/bq) FILTER (WHERE reg='hi') FROM t""")
    g = "n_lo>=200 AND n_hi>=200 AND araw_lo>0 AND braw_lo>0"
    table("위약대조 — 틱 불변, 가격만 이동",
          ["n", "가격배율", "밴드폭배율", "raw매도", "raw매수", "호가비배율"],
          con.execute(f"""SELECT count(*), median(mid_hi/mid_lo), median(band_hi/band_lo),
            median(araw_hi/araw_lo), median(braw_hi/braw_lo), median(rt_hi/rt_lo)
            FROM c WHERE {g} AND rt_lo>0""").fetchall())


# --- surge: 실제 급증 검출기를 통과 직후에 돌린다 ---------------------------

def detect_surge(vals: list[float], approach: float = 0.95, rearm: float = 0.85) -> list[list]:
    """frontend/src/chart/surge/detectSurges.ts::detectSurgeSide 의 포팅.

    한 거래일 안에서만 돌리므로 원본의 거래일 경계 리셋은 생략한다.
    """
    out: list[list] = []
    running, armed, active = 0.0, False, -1
    for i, v in enumerate(vals):
        if running > 0:
            if v < rearm * running:
                armed, active = True, -1
            if armed and v >= approach * running:
                out.append([i, running, v])
                active, armed = len(out) - 1, False
            elif active >= 0 and v > running:
                out[active] = [i, out[active][1], v]
        running = max(running, v)
    return out


def cmd_surge(window: int = 6) -> None:
    """매도(ask) 측 급증 트랙만 돌린다.

    실제 마커는 매도·매수 독립 트랙이지만, §4 실측에서 매도 쪽 계단이 더 크므로
    (raw 4.44배 vs 2.44배) 두 트랙 중 **강한 쪽**을 본다. 매수도 보려면 aq/af 를
    bq/bf 로 바꾸면 된다.
    """
    fa, fb = fixed_band_sql()
    con, rows = connect(), []
    for day, code, _lo, _hi, b in _crossings_cached():
        f = snapshots_of(day, code)
        if not f.exists():
            continue
        # 1분 버킷 대표 = 그 버킷의 마지막 연속거래 스냅샷.
        # 백엔드 query_bucketed_ratio 의 대표 선정 규칙과 같은 정의여야 의미가 있다.
        recs = con.execute(f"""
        WITH s AS (SELECT *, (ask_p1+bid_p1)/2.0 mid,
             (ts_ms//10000000)*3600000 + ((ts_ms//100000)%100)*60000 + ((ts_ms//1000)%100)*1000 im
             FROM read_parquet('{f}') WHERE {DEEP} AND {SESSION} AND {FULL_BOOK}),
        t AS (SELECT im//60000 mb, im, ({AQ})::DOUBLE aq, ({fa})::DOUBLE af,
                CASE WHEN ask_p10 < {b} THEN {REG_FINE} WHEN bid_p10 >= {b} THEN {REG_COARSE}
                     ELSE {REG_STRADDLE} END reg FROM s)
        SELECT mb, arg_max(aq, im), arg_max(af, im), arg_max(reg, im)
        FROM t GROUP BY mb ORDER BY mb""").fetchall()
        if len(recs) < MIN_BUCKETS:
            continue
        cross, seen_lo = None, False
        for i, r in enumerate(recs):
            if r[3] == REG_FINE:
                seen_lo = True
            elif r[3] == REG_COARSE and seen_lo:
                cross = i
                break
        if cross is None:
            continue
        win = range(cross, min(cross + window, len(recs)))
        m_raw = detect_surge([r[1] for r in recs])
        m_fix = detect_surge([r[2] for r in recs])
        rows.append((len(recs), any(x[0] in win for x in m_raw),
                     any(x[0] in win for x in m_fix), len(m_raw), len(m_fix)))
    n = len(rows)
    if not n:
        print("표본 없음")
        return
    # 기저율 = 하루 마커 수 × 창 길이 / 하루 봉 수. "통과 직후에 몰렸는가"의 대조군.
    base_raw = sum(min(1.0, r[3] * window / r[0]) for r in rows) / n
    base_fix = sum(min(1.0, r[4] * window / r[0]) for r in rows) / n
    obs_raw = sum(1 for r in rows if r[1]) / n
    obs_fix = sum(1 for r in rows if r[2]) / n
    only = sum(1 for r in rows if r[1] and not r[2]) / n
    print(f"경계 통과 종목일 {n}건 (1분봉 평균 {sum(r[0] for r in rows)/n:.0f}개)")
    print(f"  raw   : 통과 직후 {window}분 발사율 {obs_raw*100:.1f}% vs 기저 {base_raw*100:.1f}%"
          f" → {obs_raw/base_raw:.1f}배")
    print(f"  고정밴드: {obs_fix*100:.1f}% vs 기저 {base_fix*100:.1f}% → {obs_fix/base_fix:.1f}배")
    print(f"  raw 에서만 발사(정규화하면 사라짐): {only*100:.1f}%")


# --- profile: 단계별 비중 · %거리 탄력성 ------------------------------------

def cmd_profile(day: str = "20260818", sample: int = 80) -> None:
    files = sorted(glob.glob(str(DATA_ROOT / day / "*" / "hogaplay" / "snapshots.parquet")))
    random.Random(1).shuffle(files)
    files = files[:sample]
    con = connect()
    at = "+".join(f"ask_q{i}" for i in range(1, 11))
    bt = "+".join(f"bid_q{i}" for i in range(1, 11))
    # ⚠ 비중은 **평균**으로 낸다. 중앙값을 단계별로 따로 내면 합이 1이 되지 않는다.
    sel = ", ".join(f"avg(ask_q{i}::DOUBLE/({at})), avg(bid_q{i}::DOUBLE/({bt}))"
                    for i in range(1, 11))
    r = con.execute(f"""WITH s AS (SELECT * FROM read_parquet({files!r})
      WHERE {DEEP} AND {SESSION} AND ({at})>0 AND ({bt})>0) SELECT {sel} FROM s""").fetchone()
    table("호가 단계별 잔량 비중(평균, 합=100%)", ["단계", "매도%", "매수%"],
          [(i + 1, r[2 * i] * 100, r[2 * i + 1] * 100) for i in range(10)])
    xs = [0.25, 0.5, 1.0, 2.0]
    cols = []
    for x in xs:
        fa, fb = fixed_band_sql(x / 100)
        cols += [f"avg(({fa})::DOUBLE)", f"avg(({fb})::DOUBLE)"]
    q = con.execute(f"""WITH s AS (SELECT *, (ask_p1+bid_p1)/2.0 mid FROM read_parquet({files!r})
      WHERE {DEEP} AND {SESSION} AND {FULL_BOOK})
      SELECT {', '.join(cols)}, count(*) FROM s
      WHERE ask_p10 >= mid*1.02 AND bid_p10 <= mid*0.98""").fetchone()
    out, prev = [], None
    for k, x in enumerate(xs):
        a, b = q[2 * k], q[2 * k + 1]
        out.append((f"±{x}%", a, b, "" if prev is None else f"{a/prev[0]:.2f} / {b/prev[1]:.2f}"))
        prev = (a, b)
    table(f"%거리 누적 깊이 (표본 {q[-1]:,} 스냅샷)", ["거리", "매도", "매수", "직전 대비"], out)


# --- ratio: 걸침 구간의 호가비 편향 -----------------------------------------

def cmd_ratio() -> None:
    fa, fb = fixed_band_sql()
    con = connect()
    con.execute("CREATE TABLE t(kind VARCHAR, n BIGINT, raw DOUBLE, fix DOUBLE, bias DOUBLE)")
    for day, code, _lo, _hi, b in _crossings_cached():
        f = snapshots_of(day, code)
        if not f.exists():
            continue
        con.execute(f"""INSERT INTO t
        WITH s AS (SELECT *, (ask_p1+bid_p1)/2.0 mid FROM read_parquet('{f}')
          WHERE {DEEP} AND {SESSION} AND {FULL_BOOK}),
        u AS (SELECT ({AQ})::DOUBLE aq, ({BQ})::DOUBLE bq, ({fa})::DOUBLE af, ({fb})::DOUBLE bf,
                CASE WHEN ask_p10 < {b} OR bid_p10 >= {b} THEN 'pure' ELSE 'straddle' END k FROM s)
        SELECT k, count(*), median(aq/bq), median(af/bf), median((aq/bq)/(af/bf))
        FROM u WHERE bq>0 AND bf>0 GROUP BY k""")
    table("호가비 — 사다리가 경계를 걸치면 면역이 깨진다",
          ["구간", "종목일", "스냅샷", "raw", "고정밴드", "편향", "p25", "p75"],
          con.execute("""SELECT kind, count(*), sum(n), median(raw), median(fix), median(bias),
            quantile_cont(bias,0.25), quantile_cont(bias,0.75)
            FROM t WHERE n>=200 GROUP BY 1 ORDER BY 1""").fetchall())


# --- case: 한 종목일을 구간별로 펼쳐 본다 -----------------------------------

def cmd_case(code: str, day: str, bound: int | str) -> None:
    bound = int(bound)   # CLI 에서 문자열로 들어온다(종목코드 보존 규칙, main 참조)
    fa, fb = fixed_band_sql()
    f = snapshots_of(day, code)
    con = connect()
    table(f"{code} · {day} · {bound:,}원 경계",
          ["구간", "스냅샷", "mid", "매도폭%", "매수폭%", "매도총잔량", "매수총잔량", "raw호가비", "고정밴드호가비"],
          con.execute(f"""
      WITH s AS (SELECT *, (ask_p1+bid_p1)/2.0 mid FROM read_parquet('{f}')
        WHERE {DEEP} AND {SESSION} AND {FULL_BOOK})
      SELECT CASE WHEN bid_p10 < {bound} AND ask_p10 >= {bound} THEN '걸침'
                  WHEN ask_p10 < {bound} THEN '전부 가는틱' ELSE '전부 굵은틱' END,
             count(*), median(mid), median((ask_p10-ask_p1)/mid*100),
             median((bid_p1-bid_p10)/mid*100), median(({AQ})::DOUBLE), median(({BQ})::DOUBLE),
             median(({AQ})::DOUBLE/({BQ})), median(({fa})::DOUBLE/NULLIF(({fb}),0))
      FROM s WHERE ({BQ})>0 GROUP BY 1 ORDER BY 3""").fetchall())


# --- straddle: 걸침 구간의 전체 노출 ----------------------------------------

def cmd_straddle(day: str = "20260818") -> None:
    con = connect()
    con.execute("CREATE TABLE p(code VARCHAR, n BIGINT, straddle BIGINT)")
    case = " OR ".join(f"(bid_p10 < {b} AND ask_p10 >= {b})" for b in BOUNDS)
    for f in sorted(glob.glob(str(DATA_ROOT / day / "*" / "hogaplay" / "snapshots.parquet"))):
        code = f.split("/")[-3]
        con.execute(f"""INSERT INTO p SELECT '{code}', count(*), count(*) FILTER (WHERE {case})
          FROM read_parquet('{f}') WHERE {DEEP} AND {SESSION} AND {FULL_BOOK}""")
    table(f"{day} 걸침 노출", ["스냅샷", "걸침", "%", "걸침 있던 종목", "절반 이상", "전체 종목"],
          con.execute("""SELECT sum(n), sum(straddle), sum(straddle)::DOUBLE/sum(n)*100,
            count(*) FILTER (WHERE straddle>0), count(*) FILTER (WHERE straddle::DOUBLE/n>0.5),
            count(*) FROM p WHERE n>0""").fetchall())
    table("걸침 비중 상위", ["code", "%", "걸침", "전체"],
          con.execute("""SELECT code, straddle::DOUBLE/n*100, straddle, n FROM p
            WHERE n>1000 ORDER BY 2 DESC LIMIT 10""").fetchall())


# --- lookback: 스크리너 기준선의 틱 영역 교차 --------------------------------

def cmd_lookback(days: int = 40) -> None:
    def tick_of(price: float) -> int:
        for b, t in zip(BOUNDS, (1, 5, 10, 50, 100, 500), strict=True):
            if price < b:
                return t
        return 1_000
    con, by_code = connect(), defaultdict(list)
    for day in trading_days(days):
        files = sorted(glob.glob(str(DATA_ROOT / day / "*" / "hogaplay" / "candles.parquet")))
        if not files:
            continue
        for code, med in con.execute(f"""
            SELECT regexp_extract(filename,'/([0-9A-Z]+)/hogaplay/',1), median(close)
            FROM read_parquet({files!r}, filename=true)
            WHERE close>0 AND {SESSION_CANDLE} GROUP BY 1""").fetchall():
            by_code[code].append((day, tick_of(med)))
    rows = []
    for n in (5, 10, 20):
        tot = mixed = 0
        for series in by_code.values():
            series.sort()
            for i in range(n, len(series)):
                tot += 1
                past = {t for _, t in series[i - n:i]}
                if series[i][1] not in past or len(past) > 1:
                    mixed += 1
        if tot:
            rows.append((n, mixed, tot, mixed / tot * 100))
    table("스크리너 신고 — 기준선이 틱 영역을 가로지르는 종목일",
          ["lookback N", "해당", "전체", "%"], rows)



# --- truncation: 고정 %밴드안(C) 의 X 후보별 잘림 노출 ------------------------

def cmd_truncation(day: str = "20260818") -> None:
    """X 후보별로 10호가가 밴드를 담는지. 위험은 '항상 잘림'이 아니라 **하루 중 뒤집힘**이다
    — 틱이 굵어지면 사다리가 넓어지므로, 전환이 고치려던 그 경계에서 일어나 새 계단을 만든다.
    """
    xs = [0.2, 0.3, 0.4, 0.5]
    con = connect()
    cols = ", ".join(
        f"avg(CASE WHEN ask_half >= {x} AND bid_half >= {x} THEN 1.0 ELSE 0.0 END) ok{k}"
        for k, x in enumerate(xs))
    con.execute("CREATE TABLE t(code VARCHAR, n BIGINT, half DOUBLE, "
                + ", ".join(f"ok{k} DOUBLE" for k in range(len(xs))) + ")")
    for f in sorted(glob.glob(str(DATA_ROOT / day / "*" / "hogaplay" / "snapshots.parquet"))):
        code = f.split("/")[-3]
        con.execute(f"""INSERT INTO t
          WITH s AS (SELECT (ask_p1+bid_p1)/2.0 mid, ask_p10, bid_p10 FROM read_parquet('{f}')
            WHERE {DEEP} AND {SESSION} AND {FULL_BOOK}),
          u AS (SELECT (ask_p10-mid)/mid*100 ask_half, (mid-bid_p10)/mid*100 bid_half FROM s)
          SELECT '{code}', count(*), median(LEAST(ask_half,bid_half)), {cols} FROM u""")
    table("10호가 반폭 분포", ["min", "p5", "p10", "p50", "p90"],
          con.execute("""SELECT min(half), quantile_cont(half,0.05), quantile_cont(half,0.1),
            median(half), quantile_cont(half,0.9) FROM t WHERE n>0""").fetchall())
    rows = []
    for k, x in enumerate(xs):
        rows.append((f"±{x}%", *con.execute(f"""SELECT count(*) FILTER (WHERE ok{k} > 0.999),
          count(*) FILTER (WHERE ok{k} < 0.001), count(*) FILTER (WHERE ok{k} BETWEEN 0.001 AND 0.999),
          count(*) FROM t WHERE n>0""").fetchone()))
    table("X 후보별", ["X", "항상 담김", "항상 잘림", "⚠하루 중 뒤집힘", "전체"], rows)


# --- proxy: 고정 %밴드가 원 신호를 보존하는가 (C안 기각 근거) ----------------

def cmd_proxy(days: int = 12, sample: int = 150) -> None:
    """**경계 미통과일**에서만 잰다 — 경계일은 raw 가 인위를 타므로 불일치가 정상이고,
    그 날을 빼야 '창을 좁혀서 잃은 것'만 남는다.
    """
    con = connect()
    xs = [0.3, 0.4]
    agree = {x: [0, 0] for x in xs}
    corr = {x: [] for x in xs}
    for day, code, _lo, _hi in _placebo_candidates(con, days, sample):
        recs = _minute_reps(con, snapshots_of(day, code),
                            extra=[f"({fixed_band_sql(x/100)[0]})::DOUBLE" for x in xs])
        if recs is None:
            continue
        raw = [r[1] for r in recs]
        # detect_surge 는 [index, prevPeak, value] 를 돌려준다 — 인덱스만 쓴다.
        m0 = {m[0] for m in detect_surge(raw)}
        for j, x in enumerate(xs):
            v = [r[2 + j] for r in recs]
            mf = {m[0] for m in detect_surge(v)}
            agree[x][0] += sum(1 for i in m0 if any(abs(i - k) <= 1 for k in mf))
            agree[x][1] += len(m0)
            corr[x].append(_pearson(raw, v))
    table("고정 %밴드가 raw 를 대신할 수 있는가 (경계 미통과일)",
          ["X", "raw 대비 상관 중앙", "마커 재현율"],
          [(f"±{x}%", sorted(corr[x])[len(corr[x])//2],
            f"{agree[x][0]}/{agree[x][1]} = {agree[x][0]/max(agree[x][1],1)*100:.1f}%") for x in xs])


# --- rebaseline: D안 — running peak 을 폭비로 환산 ---------------------------

def detect_surge_rebased(vals, widths, step, approach=0.95, rearm=0.85):
    """detect_surge 에 **폭 변화 시 running peak 환산**을 더한 변형.

    `step=None` 이면 원본과 동일. 폭이 안 변하면 아무 일도 일어나지 않으므로
    비경계일 동작이 보존된다 — C안이 실패한 지점이 바로 여기다.
    """
    out: list[int] = []
    running, armed, active, wref = 0.0, False, -1, None
    for i, (v, w) in enumerate(zip(vals, widths, strict=True)):
        if step is not None and w > 0:
            if wref is None:
                wref = w
            elif abs(w / wref - 1) > step:
                running *= w / wref
                wref = w
        if running > 0:
            if v < rearm * running:
                armed, active = True, -1
            if armed and v >= approach * running:
                out.append(i)
                active, armed = len(out) - 1, False
            elif active >= 0 and v > running:
                out[active] = i
        running = max(running, v)
    return out


def cmd_rebaseline(window: int = 6) -> None:
    steps = [None, 0.15, 0.25, 0.50]
    con, agg, cases, buckets = connect(), {s: [0, 0] for s in steps}, 0, 0
    for day, code, _lo, _hi, b in _crossings_cached():
        recs = _minute_reps(con, snapshots_of(day, code), bound=b,
                            extra=["(ask_p10-bid_p10)/mid*100"], min_buckets=MIN_BUCKETS)
        if recs is None:
            continue
        cross, seen = None, False
        for i, r in enumerate(recs):
            if r[-1] == REG_FINE:
                seen = True
            elif r[-1] == REG_COARSE and seen:
                cross = i
                break
        if cross is None:
            continue
        cases += 1
        buckets += len(recs)
        win = range(cross, min(cross + window, len(recs)))
        vals, widths = [r[1] for r in recs], [r[2] for r in recs]
        for st in steps:
            mk = detect_surge_rebased(vals, widths, st)
            agg[st][1] += len(mk)
            if any(i in win for i in mk):
                agg[st][0] += 1
    avg = buckets / max(cases, 1)
    rows = []
    for st in steps:
        obs = agg[st][0] / max(cases, 1)
        base = agg[st][1] / max(cases, 1) * window / avg
        rows.append(("현행" if st is None else f"{int(st*100)}%", f"{obs*100:.1f}%",
                     f"{base*100:.1f}%", f"{obs/base:.1f}배", f"{agg[st][1]/max(cases,1):.1f}"))
    table(f"running peak 환산 문턱별 (경계 통과 {cases} 종목일)",
          ["문턱", "통과직후 발사율", "기저", "배수", "마커/일"], rows)


def cmd_rebaseline_control(days: int = 12, sample: int = 150) -> None:
    """D안의 부작용 검사 — 경계 미통과일에 마커가 얼마나 바뀌나. C안은 여기서 죽었다."""
    con, steps = connect(), [0.15, 0.25, 0.50]
    agg = {s: [0, 0, 0] for s in steps}
    ndays = 0
    for day, code, _lo, _hi in _placebo_candidates(con, days, sample):
        recs = _minute_reps(con, snapshots_of(day, code), extra=["(ask_p10-bid_p10)/mid*100"])
        if recs is None:
            continue
        ndays += 1
        vals, widths = [r[1] for r in recs], [r[2] for r in recs]
        m0 = set(detect_surge_rebased(vals, widths, None))
        for st in steps:
            ms = set(detect_surge_rebased(vals, widths, st))
            agg[st][0] += sum(1 for i in m0 if any(abs(i - j) <= 1 for j in ms))
            agg[st][1] += len(m0)
            agg[st][2] += len(ms)
    table(f"D안 부작용 — 경계 미통과 {ndays} 종목일", ["문턱", "마커 보존율", "마커/일 현행→D"],
          [(f"{int(s*100)}%", f"{agg[s][0]}/{agg[s][1]} = {agg[s][0]/max(agg[s][1],1)*100:.1f}%",
            f"{agg[s][1]/max(ndays,1):.1f} → {agg[s][2]/max(ndays,1):.1f}") for s in steps])


# --- 공용 헬퍼 --------------------------------------------------------------

def _pearson(a: list[float], b: list[float]) -> float:
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    da = sum((x - ma) ** 2 for x in a) ** 0.5
    db = sum((y - mb) ** 2 for y in b) ** 0.5
    return sum((x - ma) * (y - mb) for x, y in zip(a, b, strict=True)) / (da * db) if da and db else 0.0


def _minute_reps(con, path, *, extra=None, bound=None, min_buckets=200):
    """1분 버킷 대표(= 그 버킷의 마지막 연속거래 스냅샷) 행들.

    대표 선정 규칙은 백엔드 query_bucketed_ratio 와 같아야 의미가 있다.
    반환: (mb, ask_total, *extra[, reg]) — bound 를 주면 마지막 열이 사다리 위치 코드.
    """
    if not path.exists():
        return None
    cols = [f"arg_max({e}, im)" for e in (extra or [])]
    if bound is not None:
        cols.append(f"arg_max(CASE WHEN ask_p10 < {bound} THEN {REG_FINE}"
                    f" WHEN bid_p10 >= {bound} THEN {REG_COARSE} ELSE {REG_STRADDLE} END, im)")
    recs = con.execute(f"""
      WITH s AS (SELECT *, (ask_p1+bid_p1)/2.0 mid,
          (ts_ms//10000000)*3600000 + ((ts_ms//100000)%100)*60000 + ((ts_ms//1000)%100)*1000 im
          FROM read_parquet('{path}') WHERE {DEEP} AND {SESSION} AND {FULL_BOOK})
      SELECT im//60000 mb, arg_max(({AQ})::DOUBLE, im){',' if cols else ''} {', '.join(cols)}
      FROM s GROUP BY 1 ORDER BY 1""").fetchall()
    return recs if len(recs) >= min_buckets else None


COMMANDS = {
    "band": cmd_band, "crossings": cmd_crossings, "pure": cmd_pure, "placebo": cmd_placebo,
    "surge": cmd_surge, "profile": cmd_profile, "ratio": cmd_ratio, "case": cmd_case,
    "straddle": cmd_straddle, "lookback": cmd_lookback,
    "truncation": cmd_truncation, "proxy": cmd_proxy,
    "rebaseline": cmd_rebaseline, "rebaseline-control": cmd_rebaseline_control,
}

def main(argv: list[str]) -> int:
    if not argv or argv[0] not in COMMANDS:
        print(__doc__)
        print("commands:", ", ".join(COMMANDS))
        return 1
    # 종목코드(006400)·날짜(20260818)는 숫자로 보이지만 문자열이어야 한다 —
    # 6자리 이상은 그대로 두고 짧은 것만 int 로 넘긴다.
    max_numeric_len = 5
    args = [int(a) if a.isdigit() and len(a) <= max_numeric_len else a for a in argv[1:]]
    COMMANDS[argv[0]](*args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
