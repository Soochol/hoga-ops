"""호가벽 급증 (Wall Surge) 탐지 프로토타입 — 매도·매수 양측.

설계 문서: docs/superpowers/specs/2026-08-14-sell-wall-surge-indicator-design.md

호가창은 체결가를 따라 움직이는 슬라이딩 윈도우라, 레벨이 '새로 보이는' 데는 두
원인이 있고 하나만 신호다. baseline 을 **직전 호가창(rn-1)** 에서 구해 셋으로 가른다.

매도(ask) 기준:
  · px <  직전 ask_p1   → 매수측/스프레드였던 자리. 매도 잔량 0 이 확실(즉시체결
                          대상이라 물량이 있을 수 없다). baseline = 0. **신호**
  · 직전 ask_p1..ask_p10 → 관측된 레벨. baseline = 그 값(레벨 부재면 0)
  · px >  직전 ask_p10  → 시야 밖 상단. baseline 미관측 → 판정 불가, **제외**

매수(bid)는 그 거울이다. 다만 부등호만 뒤집는 것이 아니라 **세 축이 함께** 뒤집힌다:
가격 정렬(bid_p1 이 최고가), 관통 방향(위쪽 스프레드에서 들어온다), 그리고 벽을
소화하는 체결 부호(매수벽은 매도공격 side=-1 이 먹는다).

사용:
    uv run --extra dev python tools/scan_wall_surge.py 20260812 028050
    uv run --extra dev python tools/scan_wall_surge.py 20260812 028050 --side bid
    uv run --extra dev python tools/scan_wall_surge.py 20260812 028050 --side both -q
"""

from __future__ import annotations

import sys
from dataclasses import dataclass

import duckdb

DATA_ROOT = "/home/dev/.local/share/hoga-ops/data/parquet"

# ── 임계는 **당일 기준**이다. 전일 이월도, 종목별 절대 주수도 쓰지 않는다 ──────
# 다만 "당일" 을 하루 전체 통계로 잡으면 09:30 판정에 14:00 데이터가 섞여 미래를
# 보게 된다(look-ahead). 실시간에서 재현 불가능한 값이 되므로, **그 시점까지 관측된
# 당일 데이터**만 쓰는 러닝 기준으로 간다 — `sell_total_renewal` 이 baseline 을
# start_hhmm 이전 최대치로 잡고 그 전엔 발동하지 않는 것과 같은 구조다.
QTY_FLOOR_RATIO = 0.1  # 최소 증가량 = 당일 러닝 평균 총잔량 × 이 비율
MIN_SHARE = 0.15  # 그 시점 해당 측 총잔량 대비 최소 비중
WARMUP_HHMM = 930  # 이 시각 전에는 통계만 쌓고 발동하지 않는다(표본 부족 구간)
# 종목별 발동 밀도는 여전히 갈린다(028050 17 · 005930 10 · 000660 226). z-score
# 정규화(당일 러닝 μ·σ)를 시도했으나 **더 갈렸다**(36 · 150 · 191) — 증가량 분포가
# 정규분포가 아니라 같은 z 가 종목마다 다른 백분위에 걸린다. 설계 문서 §3.6 참조.
OUTCOME_MS = 120_000  # 결말 추적 창
CONSUMED = 0.5  # 체결로 소화됐다고 볼 비율
GONE_RATIO = 0.2  # 벽이 소멸했다고 볼 잔량 비율
# 직전 호가창이 이보다 오래됐으면 판정하지 않는다. 캡처 갭(실측 최대 29분) 너머의
# 느린 축적이 '급증' 으로 뒤집히는 것을 막는 유일한 가드다.
MAX_STALE_MS = 10_000

SESSION_START, SESSION_END = 90000000, 152000000


def hhmm_to_ms(hhmm: int) -> int:
    """HHMM(예: 930)을 자정 기준 밀리초로."""
    return (hhmm // 100) * 3600000 + (hhmm % 100) * 60000


@dataclass(frozen=True)
class SideSpec:
    """한쪽 호가의 대칭 파라미터 묶음.

    매도/매수를 가르는 축은 넷이고, 부등호 하나가 아니라 **넷이 함께** 뒤집힌다.
    """

    name: str
    label: str
    price_col: str  # 레벨 가격 컬럼 접두 (ask_p / bid_p)
    qty_col: str
    total_col: str  # 그 측 총잔량
    best: str  # 최우선 호가 (ask_p1 / bid_p1)
    far: str  # 최말단 호가 (ask_p10 / bid_p10)
    opposite_best: str  # 반대측 최우선 — 가격돌파 판정에 쓴다
    # 관통(신규유입) 조건: 직전 최우선 호가 대비 어느 쪽이면 '반대측이었다' 인가
    pierce_op: str  # ask: '<'  · bid: '>'
    # 시야 밖(판정 불가) 조건
    unseen_op: str  # ask: '>'  · bid: '<'
    # 가격돌파: 그 가격이 반대측 최우선에 닿으면 벽을 넘어선 것
    escape_op: str  # ask: '>=' (bid_p1 >= px) · bid: '<=' (ask_p1 <= px)
    fill_side: int  # 벽을 소화하는 체결 부호. 매도벽=+1(매수공격), 매수벽=-1


ASK = SideSpec(
    name="ask",
    label="매도",
    price_col="ask_p",
    qty_col="ask_q",
    total_col="tot_ask",
    best="ask_p1",
    far="ask_p10",
    opposite_best="bid_p1",
    pierce_op="<",
    unseen_op=">",
    escape_op=">=",
    fill_side=1,
)
BID = SideSpec(
    name="bid",
    label="매수",
    price_col="bid_p",
    qty_col="bid_q",
    total_col="tot_bid",
    best="bid_p1",
    far="bid_p10",
    opposite_best="ask_p1",
    pierce_op=">",
    unseen_op="<",
    escape_op="<=",
    fill_side=-1,
)


def to_ms(expr: str) -> str:
    """HHMMSSmmm 인코딩 컬럼을 자정 기준 선형 밀리초로 바꾸는 SQL 조각."""
    return (
        f"(({expr})/10000000)::bigint*3600000"
        f"+(({expr})/100000%100)::bigint*60000"
        f"+(({expr})/1000%100)::bigint*1000"
        f"+({expr})%1000"
    )


def build_views(con: duckdb.DuckDBPyConnection, base: str, spec: SideSpec) -> None:
    """스냅샷(1행/시각)과 레벨 롱 포맷(10행/시각) 뷰를 만든다.

    연속호가 10레벨만 본다 — 단일가(동시호가·VI)는 3레벨로 붕괴해 레벨 비교가 무의미하다.
    """
    cont = "ask_q4>0 and ask_q10>0 and bid_q4>0 and bid_q10>0"
    where = f"where {cont} and ts_ms between {SESSION_START} and {SESSION_END}"
    # tot_run = 장 시작부터 그 시각까지의 총잔량 평균. **당일 러닝** 기준이라
    # 미래 구간을 보지 않는다 — 실시간에서도 같은 값이 나온다.
    con.execute(f"""
        create or replace view snap as
        select *, avg(tot) over (order by t rows between unbounded preceding and current row) as tot_run
        from (select row_number() over (order by t) as rn, * from
              (select ts_ms, {to_ms('ts_ms')} as t, {spec.total_col} as tot,
                      {spec.best} as best, {spec.far} as far, {spec.opposite_best} as opp
               from '{base}/snapshots.parquet' {where}))
    """)
    union = " union all ".join(
        f"select ts_ms, {spec.price_col}{i} as px, {spec.qty_col}{i} as qty "
        f"from '{base}/snapshots.parquet' {where} and {spec.price_col}{i}>0"
        for i in range(1, 11)
    )
    con.execute(f"""
        create or replace view lvl as
        select s.rn, s.t, u.px, u.qty from ({union}) u join snap s on s.ts_ms=u.ts_ms
    """)


def find_events(con: duckdb.DuckDBPyConnection, spec: SideSpec) -> list[tuple]:
    """발동 후보를 뽑고 가격별로 OUTCOME_MS 디바운스한다."""
    rows = con.execute(f"""
        with cur as (
            select l.rn, l.t, l.px, l.qty, s.tot, s.tot_run,
                   p.best as p_best, p.far as p_far, s.t - p.t as stale
            from lvl l join snap s on s.rn=l.rn join snap p on p.rn=l.rn-1),
        j as (
            select cur.*, coalesce(pl.qty, 0) as prev_qty
            from cur left join lvl pl on pl.rn=cur.rn-1 and pl.px=cur.px),
        b as (
            select *, case when px {spec.pierce_op} p_best then 0
                           when px {spec.unseen_op} p_far then null
                           else prev_qty end as base
            from j)
        select rn, t, px, qty, qty-base as jump, tot, (px {spec.pierce_op} p_best) as pierce
        from b
        where base is not null and stale <= {MAX_STALE_MS}
          and t >= {hhmm_to_ms(WARMUP_HHMM)}
          and qty-base >= {QTY_FLOOR_RATIO}*tot_run and (qty-base) >= {MIN_SHARE}*tot
        order by t
    """).fetchall()

    seen: dict[int, int] = {}
    events: list[tuple] = []
    for row in rows:
        t, px = row[1], row[2]
        if px in seen and t - seen[px] < OUTCOME_MS:
            seen[px] = t
            continue
        seen[px] = t
        events.append(row)
    return events


def scalar(con: duckdb.DuckDBPyConnection, sql: str):
    """단일 스칼라를 꺼낸다 (빈 결과는 None)."""
    row = con.execute(sql).fetchone()
    return row[0] if row is not None else None


def classify(
    con: duckdb.DuckDBPyConnection, base: str, spec: SideSpec, t: int, px: int, qty: int
) -> tuple[str, int | None]:
    """발동 이후 OUTCOME_MS 안의 결말을 넷으로 가른다."""
    gone = scalar(
        con,
        f"select min(t) from lvl where px={px} and t>{t} and t<={t + OUTCOME_MS} "
        f"and qty<={qty * GONE_RATIO}",
    )
    # 반대측 최우선 호가가 이 가격에 닿으면 벽을 넘어선 것
    escaped = scalar(
        con,
        f"select min(t) from snap where t>{t} and t<={t + OUTCOME_MS} "
        f"and opp {spec.escape_op} {px}",
    )
    # 벽 소화는 **그 벽을 때리는 공격 방향** 체결만 센다. 매도벽은 매수공격(side=+1),
    # 매수벽은 매도공격(side=-1). 반대 부호는 그 레벨이 건너편으로 넘어간 뒤의
    # 체결이라 벽 소화가 아니며, 함께 세면 "소화됨" 이 부풀려진다.
    filled = (
        scalar(
            con,
            f"select coalesce(sum(qty),0) from '{base}/trades.parquet' "
            f"where price={px} and side={spec.fill_side} "
            f"and {to_ms('ts_ms')} between {t} and {t + OUTCOME_MS}",
        )
        or 0
    )

    if gone is None and escaped is None:
        return "잔존(저항선)" if spec is ASK else "잔존(지지선)", None
    duration = min(x for x in (gone, escaped) if x is not None) - t
    attacker = "매수" if spec.fill_side == 1 else "매도"
    if filled >= qty * CONSUMED:
        return f"체결소화 {filled:,}주", duration
    if escaped is not None and (gone is None or escaped <= gone):
        return f"가격돌파({attacker}체결 {filled:,})", duration
    return f"취소 {filled:,}", duration


def scan(date: str, code: str, spec: SideSpec, quiet: bool) -> None:
    base = f"{DATA_ROOT}/{date}/{code}/hogaplay"
    con = duckdb.connect()
    build_views(con, base, spec)
    events = find_events(con, spec)

    print(
        f"=== {date} {code} · {spec.label}벽 급증 {len(events)}건 "
        f"(당일 기준: 러닝평균 {QTY_FLOOR_RATIO:.0%} & 현재 {spec.label}총잔량 "
        f"{MIN_SHARE:.0%}, {WARMUP_HHMM // 100:02d}:{WARMUP_HHMM % 100:02d} 이후) ==="
    )
    if quiet or not events:
        return

    print(f"{'시각':>10} {'가격':>8} {'벽':>7} {'증가':>7} {'총比':>5} {'유형':>10} {'지속':>7}  결말")
    for _, t, px, qty, jump, tot, pierce in events:
        verdict, duration = classify(con, base, spec, t, px, qty)
        clock = f"{t // 3600000:02d}:{t // 60000 % 60:02d}:{t // 1000 % 60:02d}"
        kind = "스프레드관통" if pierce else "레벨증량"
        dur = f"{duration / 1000:.1f}s" if duration is not None else "  —"
        print(
            f"{clock:>10} {px:>8,} {qty:>7,} {jump:>7,} "
            f"{jump / tot:>4.0%} {kind:>10} {dur:>7}  {verdict}"
        )


def main() -> None:
    argv = sys.argv[1:]
    side = "ask"
    if "--side" in argv:
        idx = argv.index("--side")
        side = argv[idx + 1] if idx + 1 < len(argv) else "ask"
        argv = argv[:idx] + argv[idx + 2 :]
    positional = [a for a in argv if not a.startswith("-")]
    date = positional[0] if positional else "20260812"
    code = positional[1] if len(positional) > 1 else "028050"
    quiet = "-q" in argv

    specs = {"ask": [ASK], "bid": [BID], "both": [ASK, BID]}.get(side)
    if specs is None:
        print(f"알 수 없는 --side: {side} (ask | bid | both)")
        raise SystemExit(2)
    for spec in specs:
        scan(date, code, spec, quiet)


if __name__ == "__main__":
    main()
