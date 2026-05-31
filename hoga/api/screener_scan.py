from __future__ import annotations
from pathlib import Path
from typing import Literal
import duckdb
from hoga.api.models import BreakoutFilter, ScreenerRow, BreakoutHit, BreakoutMiss

_WON_PER_EOK = 100_000_000


def _breakout_cte(name: str, col: str, f: BreakoutFilter) -> str:
    """col(high|volume) 의 (lookback,period) 돌파 이력 CTE."""
    N, M = f.lookback, f.period
    return f"""
    {name}_lb AS (
      SELECT code, MIN(date) lb_start FROM (
        SELECT code, date, ROW_NUMBER() OVER (PARTITION BY code ORDER BY date DESC) rn
        FROM adj) t WHERE rn <= {N} GROUP BY code),
    {name}_win AS (
      SELECT code, date, {col} AS v,
        MAX({col}) OVER (PARTITION BY code ORDER BY date
                         ROWS BETWEEN {M - 1} PRECEDING AND CURRENT ROW) mx,
        COUNT(*) OVER (PARTITION BY code ORDER BY date
                      ROWS BETWEEN {M - 1} PRECEDING AND CURRENT ROW) wc
      FROM adj),
    {name} AS (
      SELECT DISTINCT ON (w.code) w.code, w.date event_date, CAST(w.v AS BIGINT) period_extreme,
        (SELECT count(*) FROM adj a WHERE a.code=w.code AND a.date > w.date) AS days_ago
      FROM {name}_win w JOIN {name}_lb l ON l.code=w.code
      WHERE w.date >= l.lb_start AND w.v >= w.mx AND w.wc = {M}
      ORDER BY w.code, w.date DESC)"""


def run_scan(adjusted_path: Path, stocks_path: Path, *,
             new_high: BreakoutFilter | None = None,
             new_high_vol: BreakoutFilter | None = None,
             min_trade_value_eok: float | None = None,
             markets: list[Literal["KOSPI", "KOSDAQ"]] | None = None,
             exclude_etf: bool = False, exclude_halted: bool = False,
             q: str | None = None, limit: int = 1000) -> list[ScreenerRow]:
    con = duckdb.connect(":memory:")
    con.execute(f"CREATE VIEW adj AS SELECT * FROM '{adjusted_path}'")
    con.execute(f"CREATE VIEW stk AS SELECT * FROM '{stocks_path}'")

    ctes = ["base AS (SELECT DISTINCT ON (code) code, date, high, close, volume "
            "FROM adj ORDER BY code, date DESC)"]
    joins: list[str] = []
    if new_high:
        ctes.append(_breakout_cte("nh", "high", new_high)); joins.append("nh")
    if new_high_vol:
        ctes.append(_breakout_cte("nhv", "volume", new_high_vol)); joins.append("nhv")

    sel = ["base.code", "stk.name", "stk.market", "base.close::BIGINT price",
           "(base.close*base.volume)::BIGINT trade_value_won"]
    sel.append("nh.event_date nh_date, nh.days_ago nh_days, nh.period_extreme nh_ext"
               if new_high else "NULL nh_date, NULL nh_days, NULL nh_ext")
    sel.append("nhv.event_date nhv_date, nhv.days_ago nhv_days, nhv.period_extreme nhv_ext"
               if new_high_vol else "NULL nhv_date, NULL nhv_days, NULL nhv_ext")

    join_sql = "JOIN stk ON stk.code=base.code "
    for j in joins:
        join_sql += f"JOIN {j} ON {j}.code=base.code "

    wheres: list[str] = []
    params: list = []
    if min_trade_value_eok is not None:
        wheres.append("base.close*base.volume >= ?"); params.append(int(min_trade_value_eok * _WON_PER_EOK))
    if markets:
        wheres.append(f"stk.market IN ({','.join('?' * len(markets))})"); params += list(markets)
    if exclude_etf:
        wheres.append("NOT stk.is_etf")
    if exclude_halted:
        wheres.append("NOT stk.is_halted")
    if q:
        wheres.append("(stk.name LIKE ? OR base.code LIKE ?)"); params += [f"%{q}%", f"{q}%"]
    where_sql = ("WHERE " + " AND ".join(wheres)) if wheres else ""

    sql = (f"WITH {', '.join(ctes)} SELECT {', '.join(sel)} FROM base {join_sql}"
           f"{where_sql} ORDER BY trade_value_won DESC LIMIT {int(limit)}")
    cur = con.execute(sql, params)
    cols = [c[0] for c in cur.description]

    def _bk(date, days, ext):
        return (BreakoutHit(hit=True, event_date=date.strftime("%Y%m%d"),
                            days_ago=int(days), period_extreme=int(ext))
                if date is not None else BreakoutMiss(hit=False))

    out: list[ScreenerRow] = []
    for r in cur.fetchall():
        d = dict(zip(cols, r))
        out.append(ScreenerRow(
            code=d["code"], name=d["name"], market=d["market"], price=int(d["price"]),
            trade_value_won=int(d["trade_value_won"]), change_pct=None,
            new_high=_bk(d["nh_date"], d["nh_days"], d["nh_ext"]) if new_high else None,
            new_high_vol=_bk(d["nhv_date"], d["nhv_days"], d["nhv_ext"]) if new_high_vol else None,
        ))
    return out
