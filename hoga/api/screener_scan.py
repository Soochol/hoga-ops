from __future__ import annotations
from collections.abc import Callable
from pathlib import Path
import duckdb
from hoga.api.models import (
    BreakoutParams, ConditionLeaf, ScreenerRow, ScreenerUniverse,
)

_WON_PER_EOK = 100_000_000


def _breakout_cte(name: str, col: str, f: BreakoutParams) -> str:
    """col(high|volume) 의 (lookback,period) 돌파 이력 CTE. VERBATIM — 재작성 금지."""
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
      SELECT DISTINCT ON (w.code) w.code
      FROM {name}_win w JOIN {name}_lb l ON l.code=w.code
      WHERE w.date >= l.lb_start AND w.v >= w.mx AND w.wc = {M}
      ORDER BY w.code, w.date DESC)"""


# A leaf compiler: (leaf, i) -> (cte_sql_defining_cond_i, sql_params)
LeafCompiler = Callable[[ConditionLeaf, int], tuple[str, list]]


def _compile_trade_value(leaf, i):
    return f"cond_{i} AS (SELECT code FROM base WHERE close*volume >= ?)", [int(leaf.params.min_eok * _WON_PER_EOK)]


def _breakout(col: str) -> LeafCompiler:
    return lambda leaf, i: (_breakout_cte(f"cond_{i}", col, leaf.params), [])


def _compile_change_pct(leaf, i):
    guard = "prev_close IS NOT NULL AND prev_close <> 0"
    expr = "(close/prev_close - 1) * 100"
    op = leaf.params.op
    if op == "gte":
        return f"cond_{i} AS (SELECT code FROM base WHERE {guard} AND {expr} >= ?)", [leaf.params.pct]
    if op == "lte":
        return f"cond_{i} AS (SELECT code FROM base WHERE {guard} AND {expr} <= ?)", [leaf.params.pct]
    return (f"cond_{i} AS (SELECT code FROM base WHERE {guard} AND {expr} BETWEEN ? AND ?)",
            [leaf.params.lo, leaf.params.hi])


CONDITION_COMPILERS: dict[str, LeafCompiler] = {
    "trade_value": _compile_trade_value,
    "new_high": _breakout("high"),
    "new_high_vol": _breakout("volume"),
    "change_pct": _compile_change_pct,
    # price_range / ma added in B3/B4
}


def _universe_wheres(u: ScreenerUniverse) -> tuple[list[str], list]:
    wheres, params = [], []
    if u.markets:
        wheres.append(f"stk.market IN ({','.join('?' * len(u.markets))})"); params += list(u.markets)
    if u.exclude_etf:
        wheres.append("NOT stk.is_etf")
    if u.exclude_halted:
        wheres.append("NOT stk.is_halted")
    return wheres, params


def run_scan(adjusted_path: Path, stocks_path: Path, *,
             conditions: list[ConditionLeaf], universe: ScreenerUniverse,
             limit: int = 1000) -> list[ScreenerRow]:
    con = duckdb.connect(":memory:")
    con.execute(f"CREATE VIEW adj AS SELECT * FROM '{adjusted_path}'")
    con.execute(f"CREATE VIEW stk AS SELECT * FROM '{stocks_path}'")

    ctes = ["base AS (SELECT DISTINCT ON (code) code, date, high, close, volume, "
            "LAG(close) OVER (PARTITION BY code ORDER BY date) AS prev_close "
            "FROM adj ORDER BY code, date DESC)"]
    joins: list[str] = []
    params: list = []
    for i, leaf in enumerate(conditions):
        cte, p = CONDITION_COMPILERS[leaf.type](leaf, i)
        ctes.append(cte)
        joins.append(f"JOIN cond_{i} ON cond_{i}.code = base.code")
        params += p

    uwheres, uparams = _universe_wheres(universe)
    params += uparams
    where_sql = ("WHERE " + " AND ".join(uwheres)) if uwheres else ""

    sel = ("base.code, stk.name, stk.market, base.close::BIGINT price, "
           "(base.close*base.volume)::BIGINT trade_value_won, "
           "CASE WHEN base.prev_close IS NULL OR base.prev_close = 0 THEN NULL "
           "ELSE round((base.close / base.prev_close - 1) * 100, 2) END change_pct")
    sql = (f"WITH {', '.join(ctes)} SELECT {sel} FROM base JOIN stk ON stk.code=base.code "
           f"{' '.join(joins)} {where_sql} ORDER BY trade_value_won DESC LIMIT {int(limit)}")

    cur = con.execute(sql, params)
    cols = [c[0] for c in cur.description]
    out: list[ScreenerRow] = []
    for r in cur.fetchall():
        d = dict(zip(cols, r))
        out.append(ScreenerRow(
            code=d["code"], name=d["name"], market=d["market"], price=int(d["price"]),
            trade_value_won=int(d["trade_value_won"]),
            change_pct=float(d["change_pct"]) if d["change_pct"] is not None else None))
    return out
