# 저장형 스크리너 (Saved Screener) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 하드코딩 스크리너 패널을, 빌트인 조건 카탈로그(6종)에서 고른 조건을 AND로 조합해 이름 붙여 저장/조회하는 사용자 정의 저장형 스크리너로 교체한다.

**Architecture:** 백엔드는 조건을 `cond_i` CTE(매칭 Code 집합)로 컴파일하는 **레지스트리** + 그걸 INNER JOIN(=AND)하는 `run_scan`. 결과는 평면 `ScreenerRow`(조건 배지 없음). 저장은 watchlist JSON 패턴(파일=SSOT). 프론트는 `CONDITION_CATALOG` 레지스트리 기반 빌더(C 3열, 요약+펼치기, 숫자 입력) + 저장 목록 CRUD.

**Tech Stack:** Python/FastAPI/Pydantic v2, DuckDB-over-parquet, pytest(`uv run --extra dev pytest`); React/TS, @tanstack/react-query, Vite/vitest, Tailwind(DESIGN.md 토큰).

**Source of truth:** `docs/superpowers/specs/2026-05-31-saved-screener-design.md`. **불변식**: `_breakout_cte` verbatim 재사용(재작성 금지), 수정주가 기준, Code 6자리 VARCHAR, 파일=SSOT(쓰기 OSError 전파).

---

## File Structure

**Backend**
- `hoga/api/models.py` (modify) — 조건 leaf 판별 union·params·ScanRequest·평면 ScreenerRow·저장 모델 추가; 기존 `BreakoutHit/BreakoutMiss/Breakout` 제거, `BreakoutFilter`→`BreakoutParams` 일원화, 기존 ScreenerRow 슬롯 제거.
- `hoga/api/screener_scan.py` (modify) — `_breakout_cte` 보존(type hint만 `BreakoutParams`), 6개 leaf 컴파일러 + `CONDITION_COMPILERS` 레지스트리 + `run_scan` 재작성.
- `hoga/api/screener_saves.py` (create) — 저장 영속 + CRUD(watchlist 패턴).
- `hoga/api/screener.py` (modify) — `GET /api/screener`→`POST /api/screener/scan`, `/saves` CRUD 5라우트 추가.
- `hoga/api/app.py` (modify) — CORS `allow_methods`에 `PUT`.

**Frontend**
- `frontend/src/api/screener.ts` (modify) — 신 타입 + `runScan`(POST). 구 `ScreenerFilters`/`runScreener` 제거.
- `frontend/src/api/savedScreeners.ts` (create) — 저장 CRUD 클라이언트.
- `frontend/src/screener/catalog.tsx` (create), `paramForms.tsx` (create), `ConditionBuilder.tsx` (create), `ConditionRow.tsx` (create), `SavedScreenerList.tsx` (create), `useSavedScreeners.ts` (create).
- `frontend/src/screener/useScreener.ts` (modify), `ResultTable.tsx` (modify), `frontend/src/pages/Screener.tsx` (modify).
- `frontend/src/screener/ConditionPanel.tsx` (delete), `BreakoutBadge.tsx` (delete).

**Tests**
- `tests/api/test_screener_scan.py` (modify/extend), `tests/api/test_screener_saves.py` (create), `tests/api/test_screener_routes.py` (migrate).
- `frontend/src/screener/ConditionBuilder.test.tsx` (create), `SavedScreenerList.test.tsx` (create), `frontend/src/pages/Screener.test.tsx` (migrate).

---

## Phase A — Backend wire models

### Task A1: 조건 params + leaf 판별 union

**Files:** Modify `hoga/api/models.py` (Screener Wire Models 블록 ~L660); Test `tests/api/test_screener_models.py`

- [ ] **Step 1: Write failing test**

```python
# tests/api/test_screener_models.py  (append)
import pytest
from pydantic import ValidationError, TypeAdapter
from hoga.api.models import ConditionLeaf

_A = TypeAdapter(ConditionLeaf)

def test_leaf_discriminates_by_type():
    leaf = _A.validate_python({"id": "x1", "type": "new_high", "params": {"lookback": 200, "period": 500}})
    assert leaf.type == "new_high" and leaf.params.lookback == 200

def test_change_pct_gte_requires_pct():
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "change_pct", "params": {"op": "gte"}})

def test_change_pct_between_requires_lo_le_hi():
    ok = _A.validate_python({"id": "x", "type": "change_pct", "params": {"op": "between", "lo": 2, "hi": 5}})
    assert ok.params.lo == 2
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "change_pct", "params": {"op": "between", "lo": 5, "hi": 2}})

def test_price_range_needs_at_least_one_bound():
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "price_range", "params": {}})

def test_ma_relation_literal():
    with pytest.raises(ValidationError):
        _A.validate_python({"id": "x", "type": "ma", "params": {"period": 20, "relation": "sideways"}})
```

- [ ] **Step 2: Run — expect FAIL** (`ConditionLeaf` undefined)

Run: `uv run --extra dev pytest tests/api/test_screener_models.py -q`
Expected: FAIL (ImportError: cannot import name 'ConditionLeaf').

- [ ] **Step 3: Implement** — add to `hoga/api/models.py` after the existing Screener block. Keep `from typing import Annotated, Literal, Union` and `from pydantic import BaseModel, Field, model_validator` available.

```python
# === Saved-screener condition leaves (2026-05-31 saved-screener spec) ===

class TradeValueParams(BaseModel):
    min_eok: float = Field(ge=0)                       # 최신일 거래대금 ≥ N억

class BreakoutParams(BaseModel):                       # 신고가/신고거래량 공용 (구 BreakoutFilter)
    lookback: int = Field(ge=1)                        # N: Lookback Window
    period: int = Field(ge=1)                          # M: Record Period

class ChangePctParams(BaseModel):
    op: Literal["gte", "lte", "between"]
    pct: float | None = None                           # gte/lte
    lo: float | None = None                            # between
    hi: float | None = None

    @model_validator(mode="after")
    def _check(self) -> "ChangePctParams":
        if self.op in ("gte", "lte") and self.pct is None:
            raise ValueError("gte/lte requires pct")
        if self.op == "between":
            if self.lo is None or self.hi is None:
                raise ValueError("between requires lo and hi")
            if self.lo > self.hi:
                raise ValueError("lo must be <= hi")
        return self

class PriceRangeParams(BaseModel):
    min: int | None = None                             # 원
    max: int | None = None

    @model_validator(mode="after")
    def _check(self) -> "PriceRangeParams":
        if self.min is None and self.max is None:
            raise ValueError("price_range needs at least one of min/max")
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min must be <= max")
        return self

class MaParams(BaseModel):
    period: int = Field(ge=1)
    relation: Literal["above", "below"]                # close >= SMA / close <= SMA

class TradeValueLeaf(BaseModel):
    type: Literal["trade_value"] = "trade_value"
    id: str
    params: TradeValueParams

class NewHighLeaf(BaseModel):
    type: Literal["new_high"] = "new_high"
    id: str
    params: BreakoutParams

class NewHighVolLeaf(BaseModel):
    type: Literal["new_high_vol"] = "new_high_vol"
    id: str
    params: BreakoutParams

class ChangePctLeaf(BaseModel):
    type: Literal["change_pct"] = "change_pct"
    id: str
    params: ChangePctParams

class PriceRangeLeaf(BaseModel):
    type: Literal["price_range"] = "price_range"
    id: str
    params: PriceRangeParams

class MaLeaf(BaseModel):
    type: Literal["ma"] = "ma"
    id: str
    params: MaParams

ConditionLeaf = Annotated[
    Union[TradeValueLeaf, NewHighLeaf, NewHighVolLeaf, ChangePctLeaf, PriceRangeLeaf, MaLeaf],
    Field(discriminator="type"),
]
```

- [ ] **Step 4: Run — expect PASS**

Run: `uv run --extra dev pytest tests/api/test_screener_models.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/api/test_screener_models.py
git commit -m "feat(screener): condition leaf discriminated union + param validators"
```

### Task A2: ScanRequest / 평면 ScreenerRow / 저장 모델, 구 Breakout 슬롯 제거

**Files:** Modify `hoga/api/models.py`; Test `tests/api/test_screener_models.py`

- [ ] **Step 1: Write failing test**

```python
# tests/api/test_screener_models.py  (append)
from hoga.api.models import ScanRequest, ScreenerRow, ScreenerResponse, SavedScreener, ScreenerSaveWriteRequest

def test_scan_request_defaults():
    r = ScanRequest.model_validate({"conditions": [], "universe": {}})
    assert r.limit == 1000 and r.universe.markets == []

def test_screener_row_is_flat_no_matches():
    row = ScreenerRow(code="005930", name="삼성전자", market="KOSPI",
                      price=74200, trade_value_won=842_000_000_000, change_pct=5.8)
    assert not hasattr(row, "new_high") and not hasattr(row, "matches")

def test_saved_screener_roundtrip():
    req = ScreenerSaveWriteRequest(name="급등주", conditions=[
        {"id": "a", "type": "new_high", "params": {"lookback": 200, "period": 500}}], universe={})
    s = SavedScreener(id="srv1", created_at_ms=1, updated_at_ms=1, **req.model_dump())
    assert s.conditions[0].type == "new_high" and s.created_at_ms == 1
```

- [ ] **Step 2: Run — expect FAIL** (`ScanRequest` undefined).

- [ ] **Step 3: Implement** — append to `hoga/api/models.py`; then **replace** the old `ScreenerRow` (with `new_high`/`new_high_vol`) and **delete** `BreakoutHit`/`BreakoutMiss`/`Breakout`/`BreakoutFilter` (now unused; `BreakoutParams` replaces `BreakoutFilter`).

```python
class ScreenerUniverse(BaseModel):
    markets: list[Literal["KOSPI", "KOSDAQ"]] = Field(default_factory=list)
    exclude_etf: bool = False
    exclude_halted: bool = False

class ScanRequest(BaseModel):
    conditions: list[ConditionLeaf] = Field(default_factory=list)
    universe: ScreenerUniverse = Field(default_factory=ScreenerUniverse)
    limit: int = Field(1000, ge=1, le=2000)

class ScreenerRow(BaseModel):                          # 평면형 — 조건 배지 없음
    code: str = Field(pattern=r"^\d{6}$")
    name: str
    market: Literal["KOSPI", "KOSDAQ"]
    price: int
    trade_value_won: int
    change_pct: float | None

class ScreenerResponse(BaseModel):
    status: Literal["ok", "not_seeded", "building"]
    rows: list[ScreenerRow]
    warnings: list[str] = Field(default_factory=list)

class ScreenerSaveWriteRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    conditions: list[ConditionLeaf] = Field(default_factory=list)
    universe: ScreenerUniverse = Field(default_factory=ScreenerUniverse)

class SavedScreener(ScreenerSaveWriteRequest):
    id: str
    created_at_ms: int
    updated_at_ms: int

class SavedScreenersFile(BaseModel):
    schema_version: int = 1
    saves: list[SavedScreener] = Field(default_factory=list)
```

> Note: `ScreenerStatusFile` is unchanged. After deleting `BreakoutHit/Miss/Breakout/BreakoutFilter`, grep for stale imports: `grep -rn "BreakoutHit\|BreakoutMiss\|Breakout\b\|BreakoutFilter" hoga tests` and fix (only `screener_scan.py` should reference breakout, via `BreakoutParams` after Phase B).

- [ ] **Step 4: Run — expect PASS** (models test). The scan/route tests will be red until Phase B/C — that is expected.

Run: `uv run --extra dev pytest tests/api/test_screener_models.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/models.py tests/api/test_screener_models.py
git commit -m "feat(screener): flat ScreenerRow + ScanRequest + saved-screener models; drop fixed breakout slots"
```

---

## Phase B — Scan engine (registry + compilers)

### Task B1: 레지스트리 스캐폴드 + trade_value 컴파일러

**Files:** Modify `hoga/api/screener_scan.py`; Test `tests/api/test_screener_scan.py`

Replace the module. Keep `_breakout_cte` **verbatim** (only change its `f` type hint to `BreakoutParams`). Add a fixture helper for tests that writes a tiny adjusted+stocks parquet.

- [ ] **Step 1: Write failing test** — add a parquet fixture + trade_value test.

```python
# tests/api/test_screener_scan.py  (add near top; reuse existing fixtures if present)
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
```

- [ ] **Step 2: Run — expect FAIL** (`run_scan` signature/registry not present).

- [ ] **Step 3: Implement** — rewrite `hoga/api/screener_scan.py`:

```python
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


CONDITION_COMPILERS: dict[str, LeafCompiler] = {
    "trade_value": _compile_trade_value,
    "new_high": _breakout("high"),
    "new_high_vol": _breakout("volume"),
    # change_pct / price_range / ma added in B2/B3/B4
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
```

- [ ] **Step 4: Run — expect PASS**

Run: `uv run --extra dev pytest tests/api/test_screener_scan.py::test_trade_value_filters_latest_day -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener_scan.py tests/api/test_screener_scan.py
git commit -m "feat(screener): condition compiler registry + run_scan rewrite (trade_value, breakout reuse)"
```

### Task B2: change_pct 컴파일러

**Files:** Modify `hoga/api/screener_scan.py`; Test `tests/api/test_screener_scan.py`

- [ ] **Step 1: Write failing test**

```python
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
```

- [ ] **Step 2: Run — expect FAIL** (KeyError 'change_pct' in registry).

- [ ] **Step 3: Implement** — add to `screener_scan.py` and register:

```python
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
```
Register: add `"change_pct": _compile_change_pct,` to `CONDITION_COMPILERS`.

- [ ] **Step 4: Run — expect PASS**

Run: `uv run --extra dev pytest tests/api/test_screener_scan.py -k change_pct -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener_scan.py tests/api/test_screener_scan.py
git commit -m "feat(screener): change_pct condition compiler"
```

### Task B3: price_range 컴파일러

**Files:** Modify `hoga/api/screener_scan.py`; Test `tests/api/test_screener_scan.py`

- [ ] **Step 1: Write failing test**

```python
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
```

- [ ] **Step 2: Run — expect FAIL** (KeyError 'price_range').

- [ ] **Step 3: Implement** + register `"price_range": _compile_price_range`:

```python
def _compile_price_range(leaf, i):
    clauses, params = [], []
    if leaf.params.min is not None:
        clauses.append("close >= ?"); params.append(leaf.params.min)
    if leaf.params.max is not None:
        clauses.append("close <= ?"); params.append(leaf.params.max)
    return f"cond_{i} AS (SELECT code FROM base WHERE {' AND '.join(clauses)})", params
```

- [ ] **Step 4: Run — expect PASS** (`-k price_range`).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener_scan.py tests/api/test_screener_scan.py
git commit -m "feat(screener): price_range condition compiler"
```

### Task B4: ma 컴파일러 (윈도우 CTE — 최우선 TDD)

**Files:** Modify `hoga/api/screener_scan.py`; Test `tests/api/test_screener_scan.py`

- [ ] **Step 1: Write failing tests** (above/below + `wc=N` 가드)

```python
from hoga.api.models import MaLeaf, MaParams

def _ramp(code, start, n, step):  # n 연속 거래일, close = start, start+step, ...
    return [(code, f"2026-0{3 + (d // 28)}-{(d % 28) + 1:02d}", 0, 0, 0, start + d * step, 1) for d in range(n)]

def test_ma_above_and_window_guard(tmp_path):
    # AAA: 25거래일 상승추세 → 최신 close > MA20 (above). wc=20 충족.
    # BBB: 10거래일만 상장 → wc<20 → MA20 평가 불가 → 제외.
    rows = _ramp("AAA", 1000, 25, 100) + _ramp("BBB", 1000, 10, 100)
    adj, stk = _seed(tmp_path, rows=rows,
        stocks=[("AAA","a","KOSPI",False,False),("BBB","b","KOSPI",False,False)])
    leaf = MaLeaf(id="m", params=MaParams(period=20, relation="above"))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["AAA"]              # BBB excluded by wc<20

def test_ma_below(tmp_path):
    rows = _ramp("AAA", 3500, 25, -100)                  # 하락추세 → close < MA20
    adj, stk = _seed(tmp_path, rows=rows, stocks=[("AAA","a","KOSPI",False,False)])
    leaf = MaLeaf(id="m", params=MaParams(period=20, relation="below"))
    out = screener_scan.run_scan(adj, stk, conditions=[leaf], universe=ScreenerUniverse())
    assert [r.code for r in out] == ["AAA"]
```

- [ ] **Step 2: Run — expect FAIL** (KeyError 'ma').

- [ ] **Step 3: Implement** + register `"ma": _compile_ma`:

```python
def _compile_ma(leaf, i):
    N = leaf.params.period
    op = ">=" if leaf.params.relation == "above" else "<="
    return (
        f"cond_{i}_w AS (SELECT code, date, close, "
        f"AVG(close) OVER (PARTITION BY code ORDER BY date "
        f"ROWS BETWEEN {N - 1} PRECEDING AND CURRENT ROW) sma, "
        f"COUNT(*) OVER (PARTITION BY code ORDER BY date "
        f"ROWS BETWEEN {N - 1} PRECEDING AND CURRENT ROW) wc FROM adj), "
        f"cond_{i}_l AS (SELECT DISTINCT ON (code) code, close, sma, wc "
        f"FROM cond_{i}_w ORDER BY code, date DESC), "
        f"cond_{i} AS (SELECT code FROM cond_{i}_l WHERE wc = {N} AND close {op} sma)"
    ), []
```

- [ ] **Step 4: Run — expect PASS** (`-k ma`).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener_scan.py tests/api/test_screener_scan.py
git commit -m "feat(screener): moving-average condition compiler with wc=N window guard"
```

### Task B5: 반복·혼합 조건 AND + 신고가 회귀 (tie/wc 보존)

**Files:** Test `tests/api/test_screener_scan.py`

- [ ] **Step 1: Write failing/▶regression tests** — repeated same-type + breakout tie/`wc=M` still hold via the reused CTE.

```python
from hoga.api.models import NewHighLeaf

def test_repeated_new_high_and(tmp_path):
    # 005930: 강한 신고가(긴/짧은 윈도우 모두), 000660: 단기 신고가만 → AND(둘 다)면 005930만.
    long5 = [("005930", f"2026-04-{d:02d}", 0, 100 + d, 0, 100 + d, 1) for d in range(1, 26)]  # 꾸준 신고가
    short = [("000660", f"2026-04-{d:02d}", 0, 100, 0, 100, 1) for d in range(1, 24)] + [("000660", "2026-04-25", 0, 130, 0, 130, 1)]
    adj, stk = _seed(tmp_path, rows=long5 + short,
        stocks=[("005930","a","KOSPI",False,False),("000660","b","KOSPI",False,False)])
    leaves = [NewHighLeaf(id="h1", params=BreakoutParams(lookback=20, period=20)),
              NewHighLeaf(id="h2", params=BreakoutParams(lookback=5, period=5))]
    out = screener_scan.run_scan(adj, stk, conditions=leaves, universe=ScreenerUniverse())
    assert "005930" in [r.code for r in out]

def test_code_roundtrip_leading_zero(tmp_path):
    adj, stk = _seed(tmp_path, rows=[("005930", "2026-05-30", 0, 0, 0, 100, 9_999_999)],
        stocks=[("005930", "삼성전자", "KOSPI", False, False)])
    out = screener_scan.run_scan(adj, stk, conditions=[], universe=ScreenerUniverse())
    assert out[0].code == "005930"            # VARCHAR preserved, not 5930
```

- [ ] **Step 2–4:** Run `uv run --extra dev pytest tests/api/test_screener_scan.py -q`. These should PASS against the Task B1–B4 implementation (no new impl). If `test_repeated_new_high_and` reveals a CTE-name collision, confirm each leaf uses `cond_{i}` with unique `i`.

- [ ] **Step 5: Commit**

```bash
git add tests/api/test_screener_scan.py
git commit -m "test(screener): repeated-condition AND + Code round-trip regression"
```

---

## Phase C — Scan route

### Task C1: `POST /api/screener/scan` (replace `GET /api/screener`)

**Files:** Modify `hoga/api/screener.py`; migrate `tests/api/test_screener_routes.py`

- [ ] **Step 1: Update test** — replace GET-query assertions with POST-body. Example:

```python
# tests/api/test_screener_routes.py  (migrate the scan-route test)
def test_scan_post_not_seeded(client):                 # client = TestClient with empty data_dir
    resp = client.post("/api/screener/scan", json={"conditions": [], "universe": {}})
    assert resp.status_code == 200
    assert resp.json()["status"] == "not_seeded"

def test_scan_post_ok_shape(client_seeded):            # fixture that creates screener/status.json + parquet
    resp = client_seeded.post("/api/screener/scan", json={
        "conditions": [{"id": "a", "type": "trade_value", "params": {"min_eok": 0}}],
        "universe": {"markets": ["KOSPI"]}, "limit": 10})
    body = resp.json()
    assert body["status"] == "ok" and "warnings" in body
    assert all(set(r) >= {"code", "name", "market", "price", "trade_value_won", "change_pct"} for r in body["rows"])
    assert all("matches" not in r and "new_high" not in r for r in body["rows"])
```

- [ ] **Step 2: Run — expect FAIL** (route still GET).

- [ ] **Step 3: Implement** — in `hoga/api/screener.py` `build_router`, delete the `@router.get("")` scan + `_pair` helper, add:

```python
from hoga.api.models import ScanRequest, ScreenerResponse

    @router.post("/scan")
    def scan(req: ScanRequest) -> ScreenerResponse:
        if not (sdir / "status.json").exists():
            return ScreenerResponse(status="not_seeded", rows=[])
        rows = screener_scan.run_scan(
            sdir / "daily_adjusted.parquet", sdir / "stocks.parquet",
            conditions=req.conditions, universe=req.universe, limit=req.limit)
        return ScreenerResponse(status="ok", rows=rows)
```
Update imports (drop `BreakoutFilter`, `HTTPException`/`Query` if now unused by scan; keep what saves routes need). `/status` and `/update` routes unchanged.

- [ ] **Step 4: Run — expect PASS**

Run: `uv run --extra dev pytest tests/api/test_screener_routes.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener.py tests/api/test_screener_routes.py
git commit -m "feat(screener): POST /api/screener/scan with condition body (replaces GET)"
```

---

## Phase D — Saved-screener persistence

### Task D1: `screener_saves.py` load/save/quarantine

**Files:** Create `hoga/api/screener_saves.py`; Test `tests/api/test_screener_saves.py`

- [ ] **Step 1: Write failing test**

```python
# tests/api/test_screener_saves.py
import json
from pathlib import Path
from hoga.api import screener_saves as ss
from hoga.api.models import SavedScreenersFile

def test_load_missing_returns_empty(tmp_path):
    assert ss.load_saves(tmp_path).saves == []

def test_save_then_load_roundtrip(tmp_path):
    f = SavedScreenersFile(saves=[])
    ss.save_saves(tmp_path, f)
    assert (tmp_path / "screener" / "saves.json").exists()
    assert ss.load_saves(tmp_path).schema_version == 1

def test_corrupt_file_quarantined(tmp_path):
    p = tmp_path / "screener" / "saves.json"
    p.parent.mkdir(parents=True); p.write_text("{ not json", encoding="utf-8")
    assert ss.load_saves(tmp_path).saves == []           # empty
    assert list(p.parent.glob("saves.json.corrupt-*"))    # renamed

def test_future_version_quarantined(tmp_path):
    p = tmp_path / "screener" / "saves.json"
    p.parent.mkdir(parents=True); p.write_text(json.dumps({"schema_version": 99, "saves": []}), encoding="utf-8")
    assert ss.load_saves(tmp_path).saves == []
    assert list(p.parent.glob("saves.json.corrupt-*"))
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement** `hoga/api/screener_saves.py`:

```python
"""SavedScreener persistence + async-safe CRUD. Mirrors watchlist.py:
file=SSOT, module _lock, lock-free reads, atomic writes (OSError propagates).
See docs/superpowers/specs/2026-05-31-saved-screener-design.md + ADR-0019."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import (
    SavedScreener, SavedScreenersFile, ScreenerSaveWriteRequest,
)

log = logging.getLogger(__name__)
_lock = asyncio.Lock()
_CURRENT_VERSION = 1


def _path(data_dir: Path) -> Path:
    return data_dir / "screener" / "saves.json"


def _quarantine(p: Path, reason: str) -> SavedScreenersFile:
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    backup = p.with_name(f"saves.json.corrupt-{stamp}-{reason}")
    try:
        p.rename(backup)
    except OSError:
        log.exception("could not back up corrupt saves.json")
    log.warning("screener saves.json unusable (%s); backed up to %s", reason, backup)
    return SavedScreenersFile()


def load_saves(data_dir: Path) -> SavedScreenersFile:
    """Pure read: missing→empty; future version / corrupt→quarantine+empty.
    Migrates older versions in-memory (v1 has no predecessor yet)."""
    p = _path(data_dir)
    if not p.exists():
        return SavedScreenersFile()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return _quarantine(p, "badjson")
    if raw.get("schema_version", 0) > _CURRENT_VERSION:
        return _quarantine(p, "future-version")
    try:
        return SavedScreenersFile.model_validate(raw)
    except ValidationError:
        return _quarantine(p, "schema")


def save_saves(data_dir: Path, file: SavedScreenersFile) -> None:
    """Atomic write. OSError PROPAGATES (file=SSOT → swallowing = silent loss)."""
    atomic_write_json(_path(data_dir), file.model_dump(mode="json"))
```

- [ ] **Step 4: Run — expect PASS** (D1 tests).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener_saves.py tests/api/test_screener_saves.py
git commit -m "feat(screener): saved-screener persistence (watchlist pattern, file=SSOT, quarantine)"
```

### Task D2: CRUD helpers + not-found

**Files:** Modify `hoga/api/screener_saves.py`; Test `tests/api/test_screener_saves.py`

- [ ] **Step 1: Write failing test**

```python
import pytest
from hoga.api.models import ScreenerSaveWriteRequest

def _req(name="급등주"):
    return ScreenerSaveWriteRequest(name=name, conditions=[
        {"id": "a", "type": "new_high", "params": {"lookback": 200, "period": 500}}], universe={})

async def test_crud_roundtrip(tmp_path):
    s = await ss.create_save(tmp_path, req=_req(), id="srv1", now_ms=100)
    assert s.id == "srv1" and s.created_at_ms == 100
    assert [x.id for x in await ss.list_saves(tmp_path)] == ["srv1"]
    upd = await ss.update_save(tmp_path, id="srv1", req=_req("이름변경"), now_ms=200)
    assert upd.name == "이름변경" and upd.created_at_ms == 100 and upd.updated_at_ms == 200
    await ss.delete_save(tmp_path, id="srv1")
    assert await ss.list_saves(tmp_path) == []

async def test_update_missing_raises(tmp_path):
    with pytest.raises(ss.ScreenerSaveNotFoundError):
        await ss.update_save(tmp_path, id="nope", req=_req(), now_ms=1)

async def test_delete_missing_raises(tmp_path):
    with pytest.raises(ss.ScreenerSaveNotFoundError):
        await ss.delete_save(tmp_path, id="nope")
```
(`pyproject.toml` has `asyncio_mode=auto`, so `async def test_` runs directly.)

- [ ] **Step 2: Run — expect FAIL** (helpers missing).

- [ ] **Step 3: Implement** — append to `screener_saves.py`:

```python
class ScreenerSaveNotFoundError(Exception):
    """Raised when a SavedScreener id is absent."""


async def list_saves(data_dir: Path) -> list[SavedScreener]:
    return load_saves(data_dir).saves


async def get_save(data_dir: Path, *, id: str) -> SavedScreener:
    for s in load_saves(data_dir).saves:
        if s.id == id:
            return s
    raise ScreenerSaveNotFoundError(id)


async def create_save(data_dir: Path, *, req: ScreenerSaveWriteRequest, id: str, now_ms: int) -> SavedScreener:
    async with _lock:
        f = load_saves(data_dir)
        s = SavedScreener(id=id, created_at_ms=now_ms, updated_at_ms=now_ms, **req.model_dump())
        f.saves.append(s)
        save_saves(data_dir, f)
        return s


async def update_save(data_dir: Path, *, id: str, req: ScreenerSaveWriteRequest, now_ms: int) -> SavedScreener:
    async with _lock:
        f = load_saves(data_dir)
        for idx, old in enumerate(f.saves):
            if old.id == id:
                new = SavedScreener(id=id, created_at_ms=old.created_at_ms,
                                    updated_at_ms=now_ms, **req.model_dump())
                f.saves[idx] = new
                save_saves(data_dir, f)
                return new
        raise ScreenerSaveNotFoundError(id)


async def delete_save(data_dir: Path, *, id: str) -> None:
    async with _lock:
        f = load_saves(data_dir)
        if not any(s.id == id for s in f.saves):
            raise ScreenerSaveNotFoundError(id)
        f.saves = [s for s in f.saves if s.id != id]
        save_saves(data_dir, f)
```

- [ ] **Step 4: Run — expect PASS** (`tests/api/test_screener_saves.py`).

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener_saves.py tests/api/test_screener_saves.py
git commit -m "feat(screener): saved-screener CRUD helpers"
```

---

## Phase E — Saved-screener routes + CORS

### Task E1: 5 CRUD routes

**Files:** Modify `hoga/api/screener.py`; Test `tests/api/test_screener_saves.py` (route-level)

- [ ] **Step 1: Write failing test**

```python
def test_saves_routes_crud(client):                       # TestClient, fresh data_dir
    # create
    r = client.post("/api/screener/saves", json={"name": "급등주",
        "conditions": [{"id": "a", "type": "new_high", "params": {"lookback": 200, "period": 500}}], "universe": {}})
    assert r.status_code == 201
    sid = r.json()["id"]
    # list
    assert [s["id"] for s in client.get("/api/screener/saves").json()["saves"]] == [sid]
    # put (rename)
    r2 = client.put(f"/api/screener/saves/{sid}", json={"name": "이름변경", "conditions": [], "universe": {}})
    assert r2.status_code == 200 and r2.json()["name"] == "이름변경"
    # delete
    assert client.delete(f"/api/screener/saves/{sid}").status_code == 204
    assert client.get(f"/api/screener/saves/{sid}").status_code == 404

def test_save_blank_name_422(client):
    assert client.post("/api/screener/saves", json={"name": "", "conditions": [], "universe": {}}).status_code == 422
```

- [ ] **Step 2: Run — expect FAIL** (routes missing).

- [ ] **Step 3: Implement** — in `build_router`, add (uses `data_dir` in scope):

```python
import time, uuid
from fastapi import HTTPException
from hoga.api import screener_saves
from hoga.api.models import SavedScreener, ScreenerSaveWriteRequest

    @router.post("/saves", status_code=201, response_model=SavedScreener)
    async def create_save(req: ScreenerSaveWriteRequest) -> SavedScreener:
        return await screener_saves.create_save(
            data_dir, req=req, id=uuid.uuid4().hex, now_ms=int(time.time() * 1000))

    @router.get("/saves")
    async def list_saves() -> dict:
        return {"schema_version": 1, "saves": await screener_saves.list_saves(data_dir)}

    @router.get("/saves/{save_id}", response_model=SavedScreener)
    async def get_save(save_id: str) -> SavedScreener:
        try:
            return await screener_saves.get_save(data_dir, id=save_id)
        except screener_saves.ScreenerSaveNotFoundError as e:
            raise HTTPException(404, {"code": "save_not_found", "message": f"No saved screener {save_id}"}) from e

    @router.put("/saves/{save_id}", response_model=SavedScreener)
    async def update_save(save_id: str, req: ScreenerSaveWriteRequest) -> SavedScreener:
        try:
            return await screener_saves.update_save(data_dir, id=save_id, req=req, now_ms=int(time.time() * 1000))
        except screener_saves.ScreenerSaveNotFoundError as e:
            raise HTTPException(404, {"code": "save_not_found", "message": f"No saved screener {save_id}"}) from e

    @router.delete("/saves/{save_id}", status_code=204)
    async def delete_save(save_id: str) -> None:
        try:
            await screener_saves.delete_save(data_dir, id=save_id)
        except screener_saves.ScreenerSaveNotFoundError as e:
            raise HTTPException(404, {"code": "save_not_found", "message": f"No saved screener {save_id}"}) from e
```

- [ ] **Step 4: Run — expect PASS**

Run: `uv run --extra dev pytest tests/api/test_screener_saves.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/screener.py tests/api/test_screener_saves.py
git commit -m "feat(screener): saved-screener CRUD routes under /api/screener/saves"
```

### Task E2: CORS allow PUT

**Files:** Modify `hoga/api/app.py`

- [ ] **Step 1:** Locate `allow_methods` in `app.py` (`grep -n allow_methods hoga/api/app.py`). It lists `["GET","POST","DELETE"]`.

- [ ] **Step 2: Implement** — add `"PUT"`:

```python
allow_methods=["GET", "POST", "PUT", "DELETE"],
```

- [ ] **Step 3: Run — full backend suite**

Run: `uv run --extra dev pytest tests/api/test_screener_scan.py tests/api/test_screener_saves.py tests/api/test_screener_routes.py tests/api/test_screener_models.py -q`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add hoga/api/app.py
git commit -m "fix(api): allow PUT in CORS for saved-screener edit"
```

---

## Phase F — Frontend types + API client

### Task F1: `api/screener.ts` — types + `runScan`

**Files:** Modify `frontend/src/api/screener.ts`

- [ ] **Step 1: Implement** — replace the file body (remove `ScreenerFilters`, `BreakoutFilter`, `Breakout`, fixed-slot `ScreenerRow`, `runScreener`). Keep `getScreenerStatus`, `triggerScreenerUpdate`, `ScreenerStatus`.

```typescript
import { apiCall } from './client';

// --- condition params (one per catalog type; type keys MUST match backend) ---
export interface TradeValueParams { min_eok: number }
export interface BreakoutParams { lookback: number; period: number }
export type ChangePctOp = 'gte' | 'lte' | 'between';
export interface ChangePctParams { op: ChangePctOp; pct?: number; lo?: number; hi?: number }
export interface PriceRangeParams { min?: number; max?: number }
export type MaRelation = 'above' | 'below';
export interface MaParams { period: number; relation: MaRelation }

export type ConditionLeaf =
  | { id: string; type: 'trade_value'; params: TradeValueParams }
  | { id: string; type: 'new_high'; params: BreakoutParams }
  | { id: string; type: 'new_high_vol'; params: BreakoutParams }
  | { id: string; type: 'change_pct'; params: ChangePctParams }
  | { id: string; type: 'price_range'; params: PriceRangeParams }
  | { id: string; type: 'ma'; params: MaParams };
export type ConditionType = ConditionLeaf['type'];

export interface ScreenerUniverse {
  markets?: ('KOSPI' | 'KOSDAQ')[];
  exclude_etf?: boolean;
  exclude_halted?: boolean;
}

export interface ScanRequest {
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  limit?: number;
}

export interface ScreenerRow {
  code: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  price: number;
  trade_value_won: number;
  change_pct: number | null;
}

export interface ScreenerResponse {
  status: 'ok' | 'not_seeded' | 'building';
  rows: ScreenerRow[];
  warnings: string[];
}

export interface ScreenerStatus {
  status: string;
  last_raw_date?: string;
  universe_size?: number;
  days_behind?: number | null;
}

export function runScan(body: ScanRequest): Promise<ScreenerResponse> {
  return apiCall<ScreenerResponse>('/api/screener/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const getScreenerStatus = () => apiCall<ScreenerStatus>('/api/screener/status');
export const triggerScreenerUpdate = () => apiCall('/api/screener/update', { method: 'POST' });
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: errors ONLY in not-yet-migrated consumers (ConditionPanel, ResultTable, Screener, useScreener) — fixed in later tasks.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/screener.ts
git commit -m "feat(screener-fe): condition leaf types + runScan POST client"
```

### Task F2: `api/savedScreeners.ts` — CRUD client

**Files:** Create `frontend/src/api/savedScreeners.ts`

- [ ] **Step 1: Implement**

```typescript
import { apiCall, apiAction } from './client';
import type { ConditionLeaf, ScreenerUniverse } from './screener';

export interface SavedScreener {
  id: string;
  name: string;
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  created_at_ms: number;
  updated_at_ms: number;
}
export interface SavedScreenerListResponse { schema_version: number; saves: SavedScreener[] }
export interface SaveWriteRequest { name: string; conditions: ConditionLeaf[]; universe: ScreenerUniverse }

const J = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const listSaves = () => apiCall<SavedScreenerListResponse>('/api/screener/saves');
export const createSave = (b: SaveWriteRequest) =>
  apiCall<SavedScreener>('/api/screener/saves', { method: 'POST', ...J(b) });
export const updateSave = (id: string, b: SaveWriteRequest) =>
  apiCall<SavedScreener>(`/api/screener/saves/${id}`, { method: 'PUT', ...J(b) });
export const deleteSave = (id: string) =>
  apiAction(`/api/screener/saves/${id}`, { method: 'DELETE' });
```

- [ ] **Step 2: Typecheck** `cd frontend && npx tsc --noEmit` (no new errors in this file).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/savedScreeners.ts
git commit -m "feat(screener-fe): saved-screener CRUD api client"
```

---

## Phase G — Catalog + param forms

### Task G1: `paramForms.tsx` (숫자 입력, PresetGroup 제거)

**Files:** Create `frontend/src/screener/paramForms.tsx`

- [ ] **Step 1: Implement** — shared primitives + one form per type. All numeric inputs (no preset pills). DESIGN tokens.

```tsx
import type {
  TradeValueParams, BreakoutParams, ChangePctParams, PriceRangeParams, MaParams,
} from '../api/screener';

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-dimmer">{children}</div>;
}
function Num({ value, onChange, label, w = 'w-20' }: {
  value: number | undefined; onChange: (n: number | undefined) => void; label?: string; w?: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      {label && <span className="text-[10.5px] text-fg-dimmer">{label}</span>}
      <input type="number" inputMode="numeric" aria-label={label}
        value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className={`${w} bg-bg-input border border-border rounded-md px-2 py-1 font-mono text-sm tabular-nums text-fg`} />
    </label>
  );
}
function Select<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: [T, string][]; label: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}
      className="bg-bg-input border border-border-strong rounded-md px-2 py-1 text-sm text-fg">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export function TradeValueForm({ params, onChange }: { params: TradeValueParams; onChange: (p: TradeValueParams) => void }) {
  return <div className="flex items-center gap-2"><span className="text-sm text-fg-dim">≥</span>
    <Num value={params.min_eok} onChange={(n) => onChange({ min_eok: n ?? 0 })} /><span className="text-sm text-fg-dimmer">억</span></div>;
}
export function BreakoutForm({ params, onChange }: { params: BreakoutParams; onChange: (p: BreakoutParams) => void }) {
  return <div className="flex items-center gap-3 flex-wrap">
    <Num label="lookback (N)" value={params.lookback} onChange={(n) => onChange({ ...params, lookback: n ?? 1 })} />
    <Num label="period (M)" value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} /></div>;
}
export function ChangePctForm({ params, onChange }: { params: ChangePctParams; onChange: (p: ChangePctParams) => void }) {
  return <div className="flex items-center gap-2 flex-wrap">
    <Select label="등락률 연산" value={params.op} onChange={(op) => onChange({ ...params, op })}
      options={[['gte', '≥'], ['lte', '≤'], ['between', '사이']]} />
    {params.op === 'between' ? (<>
      <Num label="lo" value={params.lo} onChange={(n) => onChange({ ...params, lo: n })} w="w-16" />
      <span className="text-fg-dimmer">~</span>
      <Num label="hi" value={params.hi} onChange={(n) => onChange({ ...params, hi: n })} w="w-16" /></>
    ) : <Num value={params.pct} onChange={(n) => onChange({ ...params, pct: n })} w="w-16" />}
    <span className="text-sm text-fg-dimmer">%</span></div>;
}
export function PriceRangeForm({ params, onChange }: { params: PriceRangeParams; onChange: (p: PriceRangeParams) => void }) {
  return <div className="flex items-center gap-2">
    <Num label="min" value={params.min} onChange={(n) => onChange({ ...params, min: n })} w="w-24" />
    <span className="text-fg-dimmer">~</span>
    <Num label="max" value={params.max} onChange={(n) => onChange({ ...params, max: n })} w="w-24" />
    <span className="text-sm text-fg-dimmer">원</span></div>;
}
export function MaForm({ params, onChange }: { params: MaParams; onChange: (p: MaParams) => void }) {
  return <div className="flex items-center gap-2">
    <span className="text-sm text-fg-dim">MA</span>
    <Num value={params.period} onChange={(n) => onChange({ ...params, period: n ?? 1 })} w="w-16" />
    <Select label="이평선 관계" value={params.relation} onChange={(relation) => onChange({ ...params, relation })}
      options={[['above', '위'], ['below', '아래']]} /></div>;
}
```

- [ ] **Step 2: Typecheck** `cd frontend && npx tsc --noEmit` (no new errors in this file).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/screener/paramForms.tsx
git commit -m "feat(screener-fe): per-type condition param forms (numeric inputs)"
```

### Task G2: `catalog.tsx` registry

**Files:** Create `frontend/src/screener/catalog.tsx`; Test `frontend/src/screener/catalog.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// frontend/src/screener/catalog.test.tsx
import { describe, it, expect } from 'vitest';
import { CONDITION_CATALOG, CONDITION_ORDER, makeLeaf } from './catalog';

describe('catalog', () => {
  it('covers all 6 types', () => {
    expect(CONDITION_ORDER).toHaveLength(6);
    expect(Object.keys(CONDITION_CATALOG).sort()).toEqual(
      ['change_pct', 'ma', 'new_high', 'new_high_vol', 'price_range', 'trade_value']);
  });
  it('makeLeaf assigns id + default params', () => {
    const a = makeLeaf('new_high'); const b = makeLeaf('new_high');
    expect(a.type).toBe('new_high'); expect(a.params).toEqual({ lookback: 200, period: 500 });
    expect(a.id).not.toBe(b.id);                       // distinct ids → repeatable
  });
  it('summarize renders sublabels', () => {
    expect(CONDITION_CATALOG.new_high.summarize({ lookback: 200, period: 500 })).toBe('200·500');
    expect(CONDITION_CATALOG.change_pct.summarize({ op: 'gte', pct: 5 })).toBe('≥ 5%');
    expect(CONDITION_CATALOG.ma.summarize({ period: 20, relation: 'above' })).toBe('MA20 위');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`cd frontend && npx vitest run src/screener/catalog.test.tsx`).

- [ ] **Step 3: Implement** `frontend/src/screener/catalog.tsx`:

```tsx
import { nanoid } from 'nanoid';
import type { ConditionLeaf, ConditionType } from '../api/screener';
import { TradeValueForm, BreakoutForm, ChangePctForm, PriceRangeForm, MaForm } from './paramForms';

interface CatalogEntry {
  label: string;
  defaultParams: ConditionLeaf['params'];
  ParamForm: React.FC<{ params: any; onChange: (p: any) => void }>;
  summarize: (p: any) => string;
}

export const CONDITION_ORDER: ConditionType[] =
  ['trade_value', 'new_high', 'new_high_vol', 'change_pct', 'price_range', 'ma'];

const OP = { gte: '≥', lte: '≤', between: '사이' } as const;

export const CONDITION_CATALOG: Record<ConditionType, CatalogEntry> = {
  trade_value: { label: '거래대금', defaultParams: { min_eok: 50 }, ParamForm: TradeValueForm,
    summarize: (p) => `≥ ${p.min_eok}억` },
  new_high: { label: '신고가', defaultParams: { lookback: 200, period: 500 }, ParamForm: BreakoutForm,
    summarize: (p) => `${p.lookback}·${p.period}` },
  new_high_vol: { label: '신고거래량', defaultParams: { lookback: 60, period: 250 }, ParamForm: BreakoutForm,
    summarize: (p) => `${p.lookback}·${p.period}` },
  change_pct: { label: '등락률', defaultParams: { op: 'gte', pct: 5 }, ParamForm: ChangePctForm,
    summarize: (p) => p.op === 'between' ? `${p.lo}~${p.hi}%` : `${OP[p.op as 'gte' | 'lte']} ${p.pct}%` },
  price_range: { label: '현재가 범위', defaultParams: { min: 1000 }, ParamForm: PriceRangeForm,    // valid single bound — {} would 422
    summarize: (p) => p.min != null && p.max != null ? `${p.min}~${p.max}원` : p.min != null ? `≥ ${p.min}원` : p.max != null ? `≤ ${p.max}원` : '—' },
  ma: { label: '이동평균', defaultParams: { period: 20, relation: 'above' }, ParamForm: MaForm,
    summarize: (p) => `MA${p.period} ${p.relation === 'above' ? '위' : '아래'}` },
};

export function makeLeaf(type: ConditionType): ConditionLeaf {
  return { id: nanoid(8), type, params: structuredClone(CONDITION_CATALOG[type].defaultParams) } as ConditionLeaf;
}
```

- [ ] **Step 4: Run — expect PASS** (`npx vitest run src/screener/catalog.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screener/catalog.tsx frontend/src/screener/catalog.test.tsx
git commit -m "feat(screener-fe): CONDITION_CATALOG registry + makeLeaf"
```

---

## Phase H — Condition builder

### Task H1: `ConditionRow.tsx`

**Files:** Create `frontend/src/screener/ConditionRow.tsx`

- [ ] **Step 1: Implement** — summary+expand (B), reuses catalog ParamForm.

```tsx
import { useState } from 'react';
import type { ConditionLeaf } from '../api/screener';
import { CONDITION_CATALOG } from './catalog';

export function ConditionRow({ leaf, onChange, onRemove }: {
  leaf: ConditionLeaf; onChange: (next: ConditionLeaf) => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const entry = CONDITION_CATALOG[leaf.type];
  const ParamForm = entry.ParamForm;
  return (
    <div className="border border-border bg-bg-subtle rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button type="button" aria-label={open ? '접기' : '펼치기'} onClick={() => setOpen((o) => !o)}
          className="text-fg-dimmer text-[10px] bg-transparent border-none cursor-pointer">{open ? '▾' : '▸'}</button>
        <span className="text-sm font-medium">{entry.label}</span>
        <span className="font-mono text-xs text-fg-dim">{entry.summarize(leaf.params)}</span>
        <button type="button" aria-label="조건 제거" onClick={onRemove}
          className="ml-auto text-fg-dimmer hover:text-fg bg-transparent border-none cursor-pointer leading-none">×</button>
      </div>
      {open && (
        <div className="px-2.5 pb-2.5">
          <ParamForm params={leaf.params} onChange={(params: ConditionLeaf['params']) => onChange({ ...leaf, params } as ConditionLeaf)} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck** `cd frontend && npx tsc --noEmit` (no new errors in this file).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/screener/ConditionRow.tsx
git commit -m "feat(screener-fe): ConditionRow (summary + expand-to-edit)"
```

### Task H2: `ConditionBuilder.tsx` + test

**Files:** Create `frontend/src/screener/ConditionBuilder.tsx`, `frontend/src/screener/ConditionBuilder.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// frontend/src/screener/ConditionBuilder.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConditionBuilder } from './ConditionBuilder';

const base = { conditions: [], universe: {} };

describe('ConditionBuilder', () => {
  it('adds a condition from the catalog menu', () => {
    const onConditions = vi.fn();
    render(<ConditionBuilder {...base} onConditionsChange={onConditions} onUniverseChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '조건 추가' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /신고가$/ }));
    expect(onConditions).toHaveBeenCalledWith([expect.objectContaining({ type: 'new_high' })]);
  });

  it('repeated same-type leaves keep distinct ids', () => {
    const two = [{ id: 'p', type: 'new_high', params: { lookback: 200, period: 500 } },
                 { id: 'q', type: 'new_high', params: { lookback: 20, period: 60 } }] as any;
    render(<ConditionBuilder conditions={two} universe={{}} onConditionsChange={vi.fn()} onUniverseChange={vi.fn()} />);
    expect(screen.getAllByText('신고가')).toHaveLength(2);
  });

  it('toggles a market pre-filter', () => {
    const onUniverse = vi.fn();
    render(<ConditionBuilder {...base} onConditionsChange={vi.fn()} onUniverseChange={onUniverse} />);
    fireEvent.click(screen.getByRole('button', { name: 'KOSPI' }));
    expect(onUniverse).toHaveBeenCalledWith({ markets: ['KOSPI'] });
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npx vitest run src/screener/ConditionBuilder.test.tsx`).

- [ ] **Step 3: Implement** `frontend/src/screener/ConditionBuilder.tsx`:

```tsx
import { useState } from 'react';
import type { ConditionLeaf, ConditionType, ScreenerUniverse } from '../api/screener';
import { CONDITION_CATALOG, CONDITION_ORDER, makeLeaf } from './catalog';
import { ConditionRow } from './ConditionRow';
import { SectionLabel } from './paramForms';

const MARKETS = ['KOSPI', 'KOSDAQ'] as const;

export function ConditionBuilder({ conditions, universe, onConditionsChange, onUniverseChange }: {
  conditions: ConditionLeaf[]; universe: ScreenerUniverse;
  onConditionsChange: (c: ConditionLeaf[]) => void; onUniverseChange: (u: ScreenerUniverse) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const add = (t: ConditionType) => { onConditionsChange([...conditions, makeLeaf(t)]); setMenuOpen(false); };
  const replace = (id: string, next: ConditionLeaf) => onConditionsChange(conditions.map((c) => c.id === id ? next : c));
  const remove = (id: string) => onConditionsChange(conditions.filter((c) => c.id !== id));

  const markets = universe.markets ?? [];
  const toggleMarket = (m: (typeof MARKETS)[number]) => {
    const next = markets.includes(m) ? markets.filter((x) => x !== m) : [...markets, m];
    onUniverseChange({ ...universe, markets: next.length ? next : undefined });
  };

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm min-h-0 overflow-auto">
      <div className="relative">
        <button type="button" aria-label="조건 추가" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}
          className="w-full border border-dashed border-border-strong rounded-md text-fg-dim text-sm py-2 hover:bg-bg-input-hover">
          ＋ 조건 추가 ▾
        </button>
        {menuOpen && (
          <ul role="menu" className="absolute z-10 mt-1 w-full bg-bg-subtle border border-border-strong rounded-md shadow-lg overflow-hidden">
            {CONDITION_ORDER.map((t) => (
              <li key={t}><button type="button" role="menuitem" aria-label={CONDITION_CATALOG[t].label} onClick={() => add(t)}
                className="w-full text-left px-3 py-2 text-sm text-fg hover:bg-bg-input-hover">{CONDITION_CATALOG[t].label}</button></li>
            ))}
          </ul>
        )}
      </div>

      {conditions.length > 0 && (
        <div className="text-[10px] tracking-[0.06em] text-fg-dimmer text-center">모두 충족 · AND</div>
      )}
      {conditions.map((leaf) => (
        <ConditionRow key={leaf.id} leaf={leaf} onChange={(n) => replace(leaf.id, n)} onRemove={() => remove(leaf.id)} />
      ))}

      <div className="mt-auto pt-md border-t flex flex-col gap-sm">
        <SectionLabel>전역 사전필터</SectionLabel>
        <div className="flex gap-px p-[2px] bg-bg-input rounded-md w-fit">
          {MARKETS.map((m) => {
            const active = markets.includes(m);
            return <button key={m} type="button" aria-label={m} aria-pressed={active} onClick={() => toggleMarket(m)}
              className={`px-2.5 py-[0.15rem] rounded-sm font-mono text-xs transition-colors ${active ? 'bg-accent text-accent-fg' : 'text-fg-dim hover:bg-bg-input-hover'}`}>{m}</button>;
          })}
        </div>
        <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
          <input type="checkbox" checked={!!universe.exclude_etf}
            onChange={(e) => onUniverseChange({ ...universe, exclude_etf: e.target.checked || undefined })}
            className="accent-[var(--accent)]" />ETF 제외</label>
        <label className="flex items-center gap-2 text-sm text-fg cursor-pointer select-none">
          <input type="checkbox" checked={!!universe.exclude_halted}
            onChange={(e) => onUniverseChange({ ...universe, exclude_halted: e.target.checked || undefined })}
            className="accent-[var(--accent)]" />거래정지 제외</label>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS** (`npx vitest run src/screener/ConditionBuilder.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screener/ConditionBuilder.tsx frontend/src/screener/ConditionBuilder.test.tsx
git commit -m "feat(screener-fe): ConditionBuilder (catalog menu, AND list, global pre-filters)"
```

---

## Phase I — Saved-screener list

### Task I1: `useSavedScreeners.ts`

**Files:** Create `frontend/src/screener/useSavedScreeners.ts`

- [ ] **Step 1: Implement**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listSaves, createSave, updateSave, deleteSave, type SaveWriteRequest } from '../api/savedScreeners';

const KEY = ['screener-saves'];

export const useSavedScreeners = () => useQuery({ queryKey: KEY, queryFn: listSaves });

export function useSaveMutations() {
  const qc = useQueryClient();
  const opts = { onSuccess: () => qc.invalidateQueries({ queryKey: KEY }) };
  return {
    create: useMutation({ mutationFn: (b: SaveWriteRequest) => createSave(b), ...opts }),
    update: useMutation({ mutationFn: ({ id, body }: { id: string; body: SaveWriteRequest }) => updateSave(id, body), ...opts }),
    remove: useMutation({ mutationFn: (id: string) => deleteSave(id), ...opts }),
  };
}
```

- [ ] **Step 2: Typecheck** `cd frontend && npx tsc --noEmit`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/screener/useSavedScreeners.ts
git commit -m "feat(screener-fe): useSavedScreeners react-query hooks"
```

### Task I2: `SavedScreenerList.tsx` + test

**Files:** Create `frontend/src/screener/SavedScreenerList.tsx`, `frontend/src/screener/SavedScreenerList.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// frontend/src/screener/SavedScreenerList.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SavedScreenerList } from './SavedScreenerList';

vi.mock('../api/savedScreeners', () => ({
  listSaves: vi.fn(() => Promise.resolve({ schema_version: 1, saves: [
    { id: 's1', name: '급등주', conditions: [], universe: {}, created_at_ms: 1, updated_at_ms: 1 }] })),
  createSave: vi.fn(() => Promise.resolve({ id: 's2' })),
  updateSave: vi.fn(() => Promise.resolve({})),
  deleteSave: vi.fn(() => Promise.resolve()),
}));
import * as api from '../api/savedScreeners';

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

beforeEach(() => vi.clearAllMocks());

describe('SavedScreenerList', () => {
  it('renders saved names and loads (no scan) on click', async () => {
    const onLoad = vi.fn();
    wrap(<SavedScreenerList current={{ conditions: [], universe: {} }} onLoad={onLoad} />);
    const item = await screen.findByText('급등주');
    fireEvent.click(item);
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });

  it('creates a new save with a name', async () => {
    wrap(<SavedScreenerList current={{ conditions: [], universe: {} }} onLoad={vi.fn()} />);
    await screen.findByText('급등주');
    vi.spyOn(window, 'prompt').mockReturnValue('새이름');
    fireEvent.click(screen.getByRole('button', { name: '새로 저장' }));
    await waitFor(() => expect(api.createSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: '새이름' })));
  });
});
```

- [ ] **Step 2: Run — expect FAIL**.

- [ ] **Step 3: Implement** `frontend/src/screener/SavedScreenerList.tsx`:

```tsx
import { useState } from 'react';
import type { ConditionLeaf, ScreenerUniverse } from '../api/screener';
import type { SavedScreener } from '../api/savedScreeners';
import { useSavedScreeners, useSaveMutations } from './useSavedScreeners';

interface Current { conditions: ConditionLeaf[]; universe: ScreenerUniverse }

export function SavedScreenerList({ current, onLoad }: { current: Current; onLoad: (s: SavedScreener) => void }) {
  const { data } = useSavedScreeners();
  const { create, update, remove } = useSaveMutations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const saves = data?.saves ?? [];

  const body = (name: string) => ({ name, conditions: current.conditions, universe: current.universe });

  const onCreate = () => { const name = window.prompt('조건검색 이름'); if (name) create.mutate(body(name)); };
  const onRename = (s: SavedScreener) => { const name = window.prompt('새 이름', s.name); if (name) update.mutate({ id: s.id, body: body(name) }); };
  const onDelete = (s: SavedScreener) => { if (window.confirm(`"${s.name}" 삭제?`)) remove.mutate(s.id); };

  return (
    <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm min-h-0 overflow-auto">
      <div className="flex items-center gap-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-dimmer">저장한 조건검색</span>
        <button type="button" aria-label="새로 저장" onClick={onCreate}
          className="ml-auto w-[22px] h-[22px] rounded-md bg-bg-input border text-fg-dim hover:text-fg">＋</button>
      </div>
      <div className="flex flex-col gap-1">
        {saves.map((s) => {
          const active = s.id === selectedId;
          return (
            <div key={s.id} role="button" tabIndex={0}
              onClick={() => { setSelectedId(s.id); onLoad(s); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setSelectedId(s.id); onLoad(s); } }}
              className={`group flex items-center gap-2 px-2.5 py-2 rounded-md text-sm cursor-pointer ${active ? 'bg-[rgba(20,184,166,0.14)] text-fg shadow-[inset_2px_0_0_var(--accent)]' : 'bg-bg-input text-fg-dim hover:bg-bg-input-hover'}`}>
              <span className="truncate flex-1">{s.name}</span>
              <button type="button" aria-label="이름변경" onClick={(e) => { e.stopPropagation(); onRename(s); }}
                className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">✎</button>
              <button type="button" aria-label="삭제" onClick={(e) => { e.stopPropagation(); onDelete(s); }}
                className="opacity-0 group-hover:opacity-100 text-fg-dimmer hover:text-fg">🗑</button>
            </div>
          );
        })}
        {saves.length === 0 && <div className="text-fg-dimmer text-xs px-1 py-2">저장된 조건검색이 없습니다. ＋ 로 현재 조건을 저장하세요.</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screener/SavedScreenerList.tsx frontend/src/screener/SavedScreenerList.test.tsx
git commit -m "feat(screener-fe): SavedScreenerList CRUD (load-only on select)"
```

---

## Phase J — Results + page wiring

### Task J1: `useScreener.ts` + `ResultTable.tsx` (배지 칼럼 제거)

**Files:** Modify `frontend/src/screener/useScreener.ts`, `frontend/src/screener/ResultTable.tsx`

- [ ] **Step 1: Implement** `useScreener.ts`:

```typescript
import { useMutation } from '@tanstack/react-query';
import { runScan, type ScanRequest } from '../api/screener';

export const useScreener = () => useMutation({ mutationFn: (b: ScanRequest) => runScan(b) });
```

- [ ] **Step 2: Implement** `ResultTable.tsx` — drop the `filters` prop, the `돌파` column, and the two `<BreakoutBadge>`. New grid has 7 cols (코드/종목명/시장/현재가/등락률/거래대금/액션). Keep `ChangeCell`, `toEok`, row click/keyboard, ♥/📥.

```tsx
import type { ScreenerRow } from '../api/screener';

interface Props {
  rows: ScreenerRow[];
  onActivate: (code: string) => void;
  onWatch: (code: string) => void;
  onCapture: (code: string) => void;
}

function ChangeCell({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-fg-dim">—</span>;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const cls = dir === 'up' ? 'text-price-up' : dir === 'down' ? 'text-price-down' : 'text-fg-dim';
  const glyph = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '';
  return <span className={cls}>{glyph}{glyph && ' '}{pct > 0 ? '+' : ''}{pct.toFixed(2)}%</span>;
}
const COLS = 'grid-cols-[3.5rem_1fr_4rem_6rem_5rem_6rem_3.2rem]';
const toEok = (won: number) => Math.round(won / 1e8).toLocaleString('ko-KR');

export function ResultTable({ rows, onActivate, onWatch, onCapture }: Props) {
  return (
    <div className="bg-bg-card border rounded-lg flex flex-col min-h-0 overflow-hidden">
      <div className={`grid ${COLS} items-center gap-2 px-sm py-1 border-b text-xs font-semibold uppercase tracking-[0.06em] text-fg-dimmer`}>
        <span>코드</span><span>종목명</span><span>시장</span>
        <span className="text-right">현재가</span><span className="text-right">등락률</span>
        <span className="text-right">거래대금(억)</span><span className="text-right">액션</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {rows.length === 0 ? (
          <div className="p-md text-fg-dim text-sm">조건에 맞는 종목이 없습니다.</div>
        ) : rows.map((r) => {
          const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(r.code); }
          };
          return (
            <div key={r.code} role="button" tabIndex={0} aria-label={`${r.name} ${r.code} 호가창 열기`}
              onClick={() => onActivate(r.code)} onKeyDown={onKeyDown}
              className={`grid ${COLS} items-center gap-2 px-sm h-orderbook-row border-b text-sm text-fg cursor-pointer outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover`}>
              <span className="font-mono tabular-nums text-fg-dim">{r.code}</span>
              <span className="truncate">{r.name}</span>
              <span className="font-mono text-xs text-fg-dim">{r.market}</span>
              <span className="font-mono tabular-nums text-right">{r.price.toLocaleString('ko-KR')}</span>
              <span className="font-mono tabular-nums text-right"><ChangeCell pct={r.change_pct} /></span>
              <span className="font-mono tabular-nums text-right text-fg-dim">{toEok(r.trade_value_won)}</span>
              <span className="flex items-center justify-end gap-2">
                <button type="button" aria-label="관심종목 추가" onClick={(e) => { e.stopPropagation(); onWatch(r.code); }}
                  className="bg-transparent border-none text-fg-dimmer hover:text-fg cursor-pointer leading-none p-0">♥</button>
                <button type="button" aria-label="캡처 큐 추가" onClick={(e) => { e.stopPropagation(); onCapture(r.code); }}
                  className="bg-transparent border-none text-fg-dimmer hover:text-fg cursor-pointer leading-none p-0">📥</button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck** `cd frontend && npx tsc --noEmit` (errors now only in Screener.tsx — next task).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/screener/useScreener.ts frontend/src/screener/ResultTable.tsx
git commit -m "feat(screener-fe): runScan mutation + ResultTable without condition badges"
```

### Task J2: `Screener.tsx` (C 3열) + delete dead files + migrate page test

**Files:** Modify `frontend/src/pages/Screener.tsx`; Delete `frontend/src/screener/ConditionPanel.tsx`, `frontend/src/screener/BreakoutBadge.tsx`; Migrate `frontend/src/pages/Screener.test.tsx`

- [ ] **Step 1: Migrate page test** — mock `runScan` (flat rows), assert 조회→row→click→setActiveCode, and 3-col presence.

```tsx
// frontend/src/pages/Screener.test.tsx  (replace screener-api mock + scan assertions)
vi.mock('../api/screener', async (orig) => ({
  ...(await orig<typeof import('../api/screener')>()),
  runScan: vi.fn(() => Promise.resolve({ status: 'ok', warnings: [], rows: [
    { code: '005930', name: '삼성전자', market: 'KOSPI', price: 74200, trade_value_won: 842_000_000_000, change_pct: 5.8 }] })),
  getScreenerStatus: vi.fn(() => Promise.resolve({ status: 'ok', last_raw_date: '20260530', days_behind: 0 })),
  triggerScreenerUpdate: vi.fn(),
}));
vi.mock('../api/savedScreeners', () => ({
  listSaves: vi.fn(() => Promise.resolve({ schema_version: 1, saves: [] })),
  createSave: vi.fn(), updateSave: vi.fn(), deleteSave: vi.fn(),
}));
// keep existing useLivePageStore/setActiveCode hoisted mock; then:
it('runs scan and opens /live on row click', async () => {
  renderScreener();                               // existing helper w/ QueryClient + MemoryRouter
  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  const row = await screen.findByText('삼성전자');
  fireEvent.click(row);
  expect(setActiveCode).toHaveBeenCalledWith('005930');
});
```

- [ ] **Step 2: Run — expect FAIL** (page still imports ConditionPanel/old ScreenerFilters).

- [ ] **Step 3: Implement** `frontend/src/pages/Screener.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { PageContainer } from '../layout/PageContainer';
import { useLivePageStore } from '../state/livePage';
import { useScreener } from '../screener/useScreener';
import { useScreenerStatus } from '../screener/useScreenerStatus';
import { ConditionBuilder } from '../screener/ConditionBuilder';
import { SavedScreenerList } from '../screener/SavedScreenerList';
import { ResultTable } from '../screener/ResultTable';
import { StalenessChip } from '../screener/StalenessChip';
import { triggerScreenerUpdate, type ConditionLeaf, type ScreenerUniverse } from '../api/screener';
import { makeLeaf } from '../screener/catalog';
import { addToWatchlist } from '../api/watchlist';
import { addItems } from '../api/captures';

export function Screener() {
  const navigate = useNavigate();
  const setActiveCode = useLivePageStore((s) => s.setActiveCode);
  const [conditions, setConditions] = useState<ConditionLeaf[]>(() => [makeLeaf('new_high')]);
  const [universe, setUniverse] = useState<ScreenerUniverse>({});

  const screener = useScreener();
  const { data: status } = useScreenerStatus();
  const watch = useMutation({ mutationFn: (code: string) => addToWatchlist(code) });
  const capture = useMutation({ mutationFn: (code: string) => addItems({ code, force_retry: false }) });
  const update = useMutation({ mutationFn: () => triggerScreenerUpdate() });

  const notSeeded = screener.data?.status === 'not_seeded' || status?.status === 'not_seeded';
  const openLive = (code: string) => { setActiveCode(code); navigate('/live'); };
  const runScan = () => screener.mutate({ conditions, universe });

  return (
    <PageContainer className="grid gap-md min-h-0"
      style={{ gridTemplateColumns: '236px 336px 1fr', gridTemplateRows: 'auto 1fr' }}>
      <div className="col-span-3 flex items-center gap-md">
        <button type="button" onClick={runScan} disabled={screener.isPending || notSeeded}
          className="px-lg py-sm rounded-lg bg-accent text-accent-fg font-semibold text-base hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed">
          {screener.isPending ? '조회 중…' : '조회'}
        </button>
        {!notSeeded && (
          <button type="button" aria-label="데이터 갱신" onClick={() => update.mutate()} disabled={update.isPending}
            className="px-3 py-[7px] rounded-lg bg-bg-input border text-fg-dim text-sm hover:bg-bg-input-hover disabled:opacity-50 disabled:cursor-not-allowed">
            {update.isPending ? '갱신 중…' : '갱신'}
          </button>
        )}
        <div className="flex-1" />
        <StalenessChip status={status} />
      </div>

      <SavedScreenerList current={{ conditions, universe }}
        onLoad={(s) => { setConditions(s.conditions); setUniverse(s.universe); }} />
      <ConditionBuilder conditions={conditions} universe={universe}
        onConditionsChange={setConditions} onUniverseChange={setUniverse} />

      {notSeeded ? (
        <div className="bg-bg-card border rounded-lg p-md flex flex-col gap-sm text-sm text-fg-dim">
          <span className="font-semibold" style={{ color: 'var(--warn)' }}>시드 필요</span>
          <span>스크리너 인덱스가 아직 시드되지 않았습니다. 운영자 CLI로 일회성 시드를 수행한 뒤 다시 조회하세요.</span>
        </div>
      ) : (
        <ResultTable rows={screener.data?.rows ?? []} onActivate={openLive}
          onWatch={(code) => watch.mutate(code)} onCapture={(code) => capture.mutate(code)} />
      )}
    </PageContainer>
  );
}
```

- [ ] **Step 4: Delete dead files + run**

```bash
git rm frontend/src/screener/ConditionPanel.tsx frontend/src/screener/BreakoutBadge.tsx
# remove their now-orphaned tests if any: git rm frontend/src/screener/BreakoutBadge.test.tsx (if exists)
```
Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all screener tests PASS. Fix any remaining references to deleted symbols.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(screener-fe): 3-column Screener page (saved list + builder + results); remove ConditionPanel/BreakoutBadge"
```

---

## Phase K — End-to-end verification

### Task K1: Full suite + manual dogfood

- [ ] **Step 1: Backend + frontend suites**

Run: `uv run --extra dev pytest tests/api -q && cd frontend && npx tsc --noEmit && npx vitest run`
Expected: all PASS, typecheck clean.

- [ ] **Step 2: Hot-reload servers** (CLAUDE.md dev-server section)

```bash
uv run uvicorn hoga.api.app:default_app --factory --host 127.0.0.1 --port 8000 --reload --reload-dir hoga &
cd frontend && npm run dev &
```

- [ ] **Step 3: API smoke** (seeded data_dir)

```bash
curl -s -X POST :8000/api/screener/scan -H 'Content-Type: application/json' \
  -d '{"conditions":[{"id":"a","type":"new_high","params":{"lookback":200,"period":500}},{"id":"b","type":"change_pct","params":{"op":"gte","pct":5}}],"universe":{"markets":["KOSPI"]},"limit":20}' | head
curl -s -X POST :8000/api/screener/saves -H 'Content-Type: application/json' \
  -d '{"name":"급등주","conditions":[{"id":"a","type":"new_high","params":{"lookback":200,"period":500}}],"universe":{}}'
curl -s :8000/api/screener/saves
```
Expected: scan returns `{status, rows:[...flat...], warnings}`; saves create→list round-trips.

- [ ] **Step 4: Browser dogfood** (`/browse`, per CLAUDE.md)

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/screener
$B console --errors
```
Verify: 3-column layout; ＋조건 추가 lists 6 types; add 신고가(숫자 입력 200/500) + 등락률(≥5%); 조회 → rows; ＋새로 저장(이름) → appears in left list; select → loads into builder (no auto-run) → 조회; ✎이름변경 / 🗑삭제; row click → `/live`; not_seeded notice when unseeded.

- [ ] **Step 5: Commit (if any verification fixups)**

```bash
git add -A && git commit -m "test(screener): e2e verification fixups"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** 6 conditions (A1, B1–B5) · flat result/no badges (A2, J1) · scan POST (C1) · saved CRUD (D, E) · CORS PUT (E2) · 3-col/B-builder/numeric inputs (G, H, J2) · extensibility registry (B1 + G2). 전역 사전필터 (H2). select=load-only (I2).
- **Type consistency:** type 키 문자열은 백엔드 `Literal`(models.py) ↔ 프론트 `ConditionType`(screener.ts) ↔ `CONDITION_ORDER`/`CONDITION_CATALOG` 키가 byte-for-byte 동일해야 함: `trade_value|new_high|new_high_vol|change_pct|price_range|ma`. `ScreenerRow` 필드 동일.
- **불변식:** `_breakout_cte` 재작성 금지(B1) — `name=cond_{i}`, `f=BreakoutParams`(duck-typed), `run_scan`이 `adj`/`stk` 뷰 생성 유지. 쓰기 OSError 전파(D1). Code VARCHAR round-trip(B5).
- **마이그레이션(추가 아님):** `test_screener_routes.py`(C1)·`Screener.test.tsx`(J2) 는 구 형태에서 깨지므로 같은 변경셋에서 교체.
