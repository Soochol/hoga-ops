# Intraday Screener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Implementation status (2026-06-25):** Implemented in this worktree with focused backend/frontend verification. See final task report in the Codex thread for exact commands and results.

**Goal:** Let `/screener` evaluate all existing OHLCV-based conditions against today's intraday KIS quote snapshot while preserving the existing EOD parquet corpus.

**Architecture:** Keep the current DuckDB condition engine and make its input dataset extensible. Build a short-lived intraday OHLCV overlay from KIS multi-price quotes, register it as an in-memory DuckDB relation, union it with `daily_adjusted.parquet`, and run the existing condition compilers over that combined `adj` view. Future conditions that depend on `code/date/open/high/low/close/volume` should need only a new compiler, not new KIS fetch logic.

**Tech Stack:** Python/FastAPI, DuckDB, Polars, Pydantic, KIS Open API multi-price, React/TypeScript, TanStack Query.

## Global Constraints

- Do not write intraday rows into `daily_unadjusted.parquet` or `daily_adjusted.parquet`; they are query-time overlay data only.
- Preserve current `basis=eod` behavior as the compatibility path.
- Intraday rows must use the same schema as `daily_adjusted.parquet`: `code`, `date`, `open`, `high`, `low`, `close`, `volume`.
- Conditions must not call KIS directly. KIS access belongs in the intraday overlay service.
- Full intraday mode requires a confirmed batched KIS source for cumulative `volume`. If cumulative volume is unavailable, do not partially intraday-evaluate volume-dependent conditions; return EOD with a visible warning.
- Keep the existing domain definition of `거래대금`: `(open + high + low + close) / 4 * volume`. Do not switch condition semantics to a KIS raw trade-amount field without a separate ADR.
- If intraday quote fetching fails, return an EOD result with a warning instead of 500; the UI must make the fallback visible.
- Keep existing saved screener condition schema compatible; adding `basis` to scan requests must not break saved conditions.
- Apply `ScreenerUniverse` before fetching KIS quotes so the overlay fetches only eligible universe codes, not all stocks unconditionally.
- The `/api/screener/scan` wire default remains `basis=eod`. The full `/screener` page may default to intraday, but the right-rail Screener Panel remains EOD unless a separate saved-basis/panel UX is added.
- Intraday basis is available only for a KST trading day and supported quote phase. Before open, weekends, and holidays fall back to EOD with a warning. After close but before EOD parquet refresh, settled KIS quote rows may still be used as `intraday`.
- This plan amends ADR-0056's previous "Live Quote is display-only; Screener filter stays EOD" decision. Documentation must be updated as part of the implementation.

---

## Grill Questions And Engineering Answers

1. **Does this contradict ADR-0056?** Yes. ADR-0056 intentionally accepted `filter=EOD, display=live`; this plan introduces an explicit `basis="intraday"` path that makes live quotes part of filtering. Best answer: keep `basis="eod"` as API compatibility, add an opt-in intraday path, and update ADR/CONTEXT when implemented.
2. **Can KIS `intstock-multprice` support all B conditions?** Not yet proven. Existing docs say trade amount is absent, and volume is not currently parsed. Best answer: add a hard Task 0 to verify cumulative volume from the batched endpoint or another batched KIS source before claiming full intraday support.
3. **Do we need KIS raw `trade_value_won`?** No for condition semantics. The Screener glossary defines 거래대금 as average OHLC times volume. Best answer: only `volume` is required; raw trade amount, if present, is diagnostic and must not drive `trade_value` conditions.
4. **What happens if volume is missing but price/high/low exist?** Returning mixed semantics would be misleading. Best answer: for `basis="intraday"`, either provide a complete OHLCV overlay for all requested intraday conditions or fall back to EOD with `intraday_volume_unavailable`.
5. **Should intraday rows be adjusted?** The scan corpus is `daily_adjusted.parquet`. Today's current quote is normally on the same current-share basis as adjusted history, but corporate-action day edge cases can drift. Best answer: use current KIS quote as today's adjusted row, and add a warning/fallback if the historical adjusted corpus is stale beyond the previous trading day.
6. **Which codes should be fetched from KIS?** Not the whole stock table blindly. Best answer: apply `ScreenerUniverse` first, then fetch only the eligible codes; conditions still run in DuckDB after the overlay is built.
7. **Do saved screeners store `basis`?** Not in this plan. Best answer: treat basis as an execution option for the full page; saved condition schema remains unchanged, and right-rail saved screener scans stay EOD.
8. **Can cache stampede happen?** Yes, multiple scan clicks or browser tabs can request the same universe at once. Best answer: key the cache by `(data_dir, today, universe_signature)` and use singleflight locking so one KIS fetch populates concurrent callers.
9. **What should happen before market open or on holidays?** Intraday quote values are either unavailable or semantically noisy. Best answer: use the same market-phase/trading-day policy as Live Quote where possible; before open/weekend/holiday returns EOD fallback, after close can use settled KIS quotes until the EOD corpus catches up.
10. **Should `/api/live/quotes` expose the new fields?** Not unless the UI needs them. Best answer: extend `KisQuote` internally and use it in the overlay; avoid widening the public live quote wire model for this feature unless tests show the shared fetcher requires it.
11. **How should DuckDB combine historical and intraday rows?** Prefer a simple exclusion union. Best answer: create `adj_hist`, remove historical rows with the same `(code, date)` as intraday rows, then `UNION ALL` the overlay. Avoid clever `QUALIFY` SQL when a clearer relation works.
12. **Will the status chip confuse users?** Yes, because EOD corpus may be one day behind while intraday is current. Best answer: keep EOD staleness wording explicit (`EOD 마지막`) and add a separate intraday snapshot age/warning indicator.
13. **Is this too many files for the first pass?** It is larger than a minimal change, but the user selected full B. Best answer: accept the complexity, but keep it behind one overlay service and one scan-basis branch rather than scattering KIS calls through conditions.
14. **What performance budget is acceptable?** Full KOSPI/KOSDAQ can require many 30-code KIS chunks. Best answer: universe-prefilter first, TTL cache second, singleflight third; warn or fallback on fetch timeout instead of blocking the UI indefinitely.
15. **What tests prove "전체 조건 장중화"?** Unit tests must cover `new_high_today`, `new_high_vol_today`, `change_pct`, `price_range`, `trade_value`, and `trade_value_period` with intraday rows. Route tests must prove fallback warnings and EOD default.

---

## File Structure

- Modify: `hoga/live/kis_client.py` — extend `KisQuote` and `_parse_quote` with confirmed cumulative `volume`.
- Create: `hoga/api/screener_intraday.py` — build and cache intraday daily-bar overlays.
- Modify: `hoga/api/screener_scan.py` — accept optional intraday rows and create a combined DuckDB `adj` view.
- Modify: `hoga/api/models.py` — add `ScanBasis = Literal["eod", "intraday"]` and `ScanRequest.basis`.
- Modify: `hoga/api/screener.py` — route `basis="intraday"` scans through the overlay service.
- Modify: `frontend/src/api/screener.ts` — add `basis` type.
- Modify: `frontend/src/pages/Screener.tsx` — add basis state and pass it to scans.
- Modify: `docs/adr/0056-live-quote-overlay.md` or add a new ADR — document the new intraday scan basis and why it supersedes display-only for explicit intraday scans.
- Modify: `CONTEXT.md` — update `Screener`, `Condition`, and `Live Quote` glossary entries after implementation lands.
- Test: `tests/unit/live/test_kis_multi_price.py`, `tests/api/test_screener_scan.py`, `tests/api/test_screener_routes.py`, `tests/api/test_screener_intraday.py`, `frontend/src/api/screener.test.ts`, `frontend/src/pages/Screener.test.tsx`.

## Interfaces

```python
# hoga/api/screener_intraday.py
@dataclass(frozen=True)
class IntradayDailyOverlay:
    rows: pl.DataFrame
    fetched_at_ms: int | None
    warnings: list[str]

async def build_intraday_overlay(
    *,
    data_dir: Path,
    codes: list[str],
    today: str,
    universe: ScreenerUniverse,
    now_ms: int,
    ttl_ms: int = 15_000,
) -> IntradayDailyOverlay: ...
```

```python
# hoga/api/screener_scan.py
def run_scan(
    adjusted_path: Path,
    stocks_path: Path,
    *,
    conditions: list[ConditionLeaf],
    universe: ScreenerUniverse,
    limit: int = 1000,
    intraday_rows: pl.DataFrame | None = None,
) -> list[ScreenerRow]: ...
```

```ts
// frontend/src/api/screener.ts
export type ScanBasis = 'eod' | 'intraday';
export interface ScanRequest {
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  limit?: number;
  basis?: ScanBasis;
}
```

---

### Task 0: Confirm Batched KIS OHLCV Capability

**Files:**
- Inspect: `hoga/live/kis_client.py`
- Inspect: `tests/unit/live/test_kis_multi_price.py`
- Inspect/update: `docs/adr/0056-live-quote-overlay.md`

**Interfaces:**
- Produces: a confirmed field mapping for cumulative intraday `volume` from KIS batched quotes, or a documented fallback/blocker.
- Consumes: existing `KisClient.fetch_multi_price(codes)` and `_parse_quote(row: dict) -> KisQuote | None`.

- [ ] **Step 1: Verify official/sample response shape**

Confirm whether KIS `FHKST11300006` (`intstock-multprice`) returns cumulative intraday volume per row. Use the safest available source in this order:

1. Existing repo fixtures or recorded tests.
2. Official KIS documentation/sample response.
3. A single diagnostic call through `KisClient._get(..., retry=False)` in a non-production probe, if credentials are available.

Record the actual field name in this task before implementing parser changes. Do not assume `acml_vol` exists in `intstock-multprice` just because other KIS endpoints use that name.

- [ ] **Step 2: Decide capability gate**

If a batched cumulative volume field is confirmed:

- Continue with Task 1 and parse that field into `KisQuote.volume`.
- Keep `trade_value` condition semantics as `(open+high+low+close)/4 * volume`.

If no batched cumulative volume field is available:

- Do not ship full intraday B.
- Implement `basis="intraday"` as EOD fallback with `intraday_volume_unavailable` for volume-dependent conditions, or split the project into a smaller price-only intraday plan.
- Add a note to the ADR update explaining why full intraday volume conditions are blocked.

- [ ] **Step 3: Update ADR decision note**

Update `docs/adr/0056-live-quote-overlay.md` or create a new ADR to state:

- Prior decision: Live Quote was display-only; Screener filters were EOD.
- New explicit basis: `basis="intraday"` may use KIS quote-derived OHLCV rows in the Screener condition engine.
- Constraint: full intraday support depends on a confirmed batched cumulative volume source.

---

### Task 1: Extend KIS Multi-Price Quote Fields

**Files:**
- Modify: `hoga/live/kis_client.py`
- Test: `tests/unit/live/test_kis_multi_price.py`

**Interfaces:**
- Produces: `KisQuote.volume: int | None`
- Consumes: existing `_parse_quote(row: dict) -> KisQuote | None`

- [ ] **Step 1: Write failing parser test**

Add to `tests/unit/live/test_kis_multi_price.py` near the existing `_parse_quote`/multi-price parser tests. Use the confirmed cumulative volume field name from Task 0. The example below assumes Task 0 confirmed `acml_vol`; if Task 0 confirms a different field, use that actual field instead:

```python
from hoga.live.kis_client import _parse_quote


def test_parse_multi_price_quote_includes_intraday_ohlcv_and_volume() -> None:
    row = {
        "inter_shrn_iscd": "005930",
        "inter2_prpr": "80100",
        "prdy_ctrt": "3.12",
        "prdy_vrss_sign": "2",
        "inter2_prdy_vrss": "2400",
        "inter2_oprc": "78000",
        "inter2_hgpr": "80500",
        "inter2_lwpr": "77700",
        "acml_vol": "1234567",
    }

    q = _parse_quote(row)

    assert q is not None
    assert q.code == "005930"
    assert q.price == 80100
    assert q.open == 78000
    assert q.high == 80500
    assert q.low == 77700
    assert q.volume == 1_234_567
```

- [ ] **Step 2: Run failing test**

Run: `uv run --extra dev pytest tests/unit/live/test_kis_multi_price.py::test_parse_multi_price_quote_includes_intraday_ohlcv_and_volume -v`

Expected: FAIL because `KisQuote` has no `volume`.

- [ ] **Step 3: Implement quote fields**

In `hoga/live/kis_client.py`, extend `KisQuote`:

```python
@dataclass(frozen=True)
class KisQuote:
    """One row of intstock-multprice for a Code."""
    code: str
    price: int
    change_pct: float | None
    change_won: int | None = None
    open: int | None = None
    high: int | None = None
    low: int | None = None
    volume: int | None = None
```

Add a small parser near `_parse_ohlc_field`:

```python
def _parse_optional_int_field(raw: object) -> int | None:
    if raw in (None, ""):
        return None
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return None
```

Update `_parse_quote`:

```python
return KisQuote(
    code=code, price=price, change_pct=change_pct, change_won=change_won,
    open=_parse_ohlc_field(row.get("inter2_oprc")),
    high=_parse_ohlc_field(row.get("inter2_hgpr")),
    low=_parse_ohlc_field(row.get("inter2_lwpr")),
    volume=_parse_optional_int_field(row.get("acml_vol")),
)
```

If Task 0 confirms a different field name, use that field instead of `acml_vol`; do not parse a guessed fallback chain without a fixture proving each candidate.

Do not widen the public `LiveQuote` wire model in this task unless a frontend consumer explicitly needs volume. The intraday overlay may use `KisClient.fetch_multi_price` internally.

- [ ] **Step 4: Verify**

Run:

```bash
uv run --extra dev pytest tests/unit/live/test_kis_multi_price.py::test_parse_multi_price_quote_includes_intraday_ohlcv_and_volume -v
```

Expected: PASS.

---

### Task 2: Add Scan Basis to Wire Models

**Files:**
- Modify: `hoga/api/models.py`
- Test: `tests/api/test_screener_models.py`

**Interfaces:**
- Produces: `ScanRequest.basis: Literal["eod", "intraday"] = "eod"`
- Consumes: existing `ScanRequest`

- [ ] **Step 1: Write failing model tests**

Add to `tests/api/test_screener_models.py`:

```python
from hoga.api.models import ScanRequest


def test_scan_request_defaults_to_eod_basis():
    req = ScanRequest.model_validate({"conditions": [], "universe": {}})
    assert req.basis == "eod"


def test_scan_request_accepts_intraday_basis():
    req = ScanRequest.model_validate({"conditions": [], "universe": {}, "basis": "intraday"})
    assert req.basis == "intraday"
```

- [ ] **Step 2: Run failing test**

Run: `uv run --extra dev pytest tests/api/test_screener_models.py::test_scan_request_defaults_to_eod_basis tests/api/test_screener_models.py::test_scan_request_accepts_intraday_basis -v`

Expected: FAIL because `basis` is missing.

- [ ] **Step 3: Implement model field**

In `hoga/api/models.py`, define and use:

```python
ScanBasis = Literal["eod", "intraday"]

class ScanRequest(BaseModel):
    conditions: list[ConditionLeaf] = Field(default_factory=list)
    universe: ScreenerUniverse = Field(default_factory=ScreenerUniverse)
    limit: int = Field(1000, ge=1, le=2000)
    basis: ScanBasis = "eod"
```

- [ ] **Step 4: Verify**

Run: `uv run --extra dev pytest tests/api/test_screener_models.py -v`

Expected: PASS.

---

### Task 3: Make `run_scan` Accept Intraday Rows

**Files:**
- Modify: `hoga/api/screener_scan.py`
- Test: `tests/api/test_screener_scan.py`

**Interfaces:**
- Consumes: `intraday_rows: pl.DataFrame | None`
- Produces: combined DuckDB `adj` view with historical rows plus intraday rows replacing any same `code/date` row.

- [ ] **Step 1: Write failing scan test**

Add to `tests/api/test_screener_scan.py`:

```python
import datetime as dt
import polars as pl
from hoga.api.models import NewHighTodayLeaf, PeriodParams, ScreenerUniverse


def test_intraday_rows_participate_in_new_high_today(tmp_path):
    rows = [
        ("000111", "2026-06-20", 100, 100, 100, 100, 10),
        ("000111", "2026-06-23", 100, 101, 100, 100, 10),
        ("000111", "2026-06-24", 100, 102, 100, 100, 10),
    ]
    adj, stk = _seed(
        tmp_path,
        rows=rows,
        stocks=[("000111", "a", "KOSPI", False, False)],
    )
    intraday = pl.DataFrame({
        "code": ["000111"],
        "date": [dt.date(2026, 6, 25)],
        "open": [100.0],
        "high": [110.0],
        "low": [99.0],
        "close": [109.0],
        "volume": [100],
    })

    out = screener_scan.run_scan(
        adj,
        stk,
        conditions=[NewHighTodayLeaf(id="t", params=PeriodParams(period=3))],
        universe=ScreenerUniverse(),
        intraday_rows=intraday,
    )

    assert [r.code for r in out] == ["000111"]
    assert out[0].price == 109
```

- [ ] **Step 2: Run failing test**

Run: `uv run --extra dev pytest tests/api/test_screener_scan.py::test_intraday_rows_participate_in_new_high_today -v`

Expected: FAIL because `run_scan` does not accept `intraday_rows`.

- [ ] **Step 3: Implement combined relation**

In `hoga/api/screener_scan.py`, import Polars:

```python
import polars as pl
```

Change `run_scan` signature:

```python
def run_scan(
    adjusted_path: Path,
    stocks_path: Path,
    *,
    conditions: list[ConditionLeaf],
    universe: ScreenerUniverse,
    limit: int = 1000,
    intraday_rows: pl.DataFrame | None = None,
) -> list[ScreenerRow]:
```

Replace `CREATE VIEW adj` with:

```python
con.execute(f"CREATE VIEW adj_hist AS SELECT * FROM '{adjusted_path}'")
if intraday_rows is not None and intraday_rows.height > 0:
    con.register("intraday_rows", intraday_rows)
    con.execute("""
        CREATE VIEW adj AS
        SELECT * FROM (
          SELECT * FROM adj_hist
          UNION ALL
          SELECT code, date, open, high, low, close, volume FROM intraday_rows
        )
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY code, date ORDER BY CASE WHEN code IN (SELECT code FROM intraday_rows) THEN 1 ELSE 0 END DESC
        ) = 1
    """)
else:
    con.execute("CREATE VIEW adj AS SELECT * FROM adj_hist")
```

Prefer the simpler same-date exclusion form; use it even if both pass because it is easier to reason about:

```sql
CREATE VIEW adj AS
SELECT * FROM adj_hist h
WHERE NOT EXISTS (
  SELECT 1 FROM intraday_rows i WHERE i.code = h.code AND i.date = h.date
)
UNION ALL
SELECT code, date, open, high, low, close, volume FROM intraday_rows
```

Use the simpler form if both pass; it is easier to reason about.

- [ ] **Step 4: Verify core scan behavior**

Run:

```bash
uv run --extra dev pytest tests/api/test_screener_scan.py::test_intraday_rows_participate_in_new_high_today -v
uv run --extra dev pytest tests/api/test_screener_scan.py -v
```

Expected: PASS.

---

### Task 4: Build Intraday Overlay Service

**Files:**
- Create: `hoga/api/screener_intraday.py`
- Test: `tests/api/test_screener_intraday.py`

**Interfaces:**
- Consumes: `kis_access.kis_for_role("background", data_dir)` and `KisClient.fetch_multi_price(codes)`
- Consumes: `ScreenerUniverse` to prefilter the stock table before KIS fetch.
- Produces: `IntradayDailyOverlay(rows, fetched_at_ms, warnings)`

- [ ] **Step 1: Write failing unit tests**

Create `tests/api/test_screener_intraday.py`:

```python
import datetime as dt
from dataclasses import dataclass
from pathlib import Path

import pytest

from hoga.api import screener_intraday


@dataclass(frozen=True)
class Quote:
    code: str
    price: int
    change_pct: float | None = None
    change_won: int | None = None
    open: int | None = None
    high: int | None = None
    low: int | None = None
    volume: int | None = None


class FakeKis:
    def __init__(self, quotes):
        self.quotes = quotes
        self.calls = 0

    async def fetch_multi_price(self, codes):
        self.calls += 1
        return [q for q in self.quotes if q.code in codes]


@pytest.mark.asyncio
async def test_build_intraday_overlay_creates_daily_rows(monkeypatch, tmp_path: Path):
    fake = FakeKis([
        Quote("000111", price=109, open=100, high=110, low=99, volume=1234),
        Quote("000222", price=0, open=0, high=0, low=0, volume=0),
    ])
    monkeypatch.setattr(screener_intraday.kis_access, "kis_for_role", lambda role, data_dir: fake)

    overlay = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path,
        codes=["000111", "000222"],
        today="20260625",
        universe=None,
        now_ms=1_000,
        ttl_ms=15_000,
    )

    assert overlay.fetched_at_ms == 1_000
    assert overlay.rows.height == 1
    row = overlay.rows.to_dicts()[0]
    assert row["code"] == "000111"
    assert row["date"] == dt.date(2026, 6, 25)
    assert row["close"] == 109.0
    assert row["high"] == 110.0
    assert row["volume"] == 1234
    assert "intraday_quote_invalid" in overlay.warnings


@pytest.mark.asyncio
async def test_build_intraday_overlay_reuses_ttl_cache(monkeypatch, tmp_path: Path):
    fake = FakeKis([Quote("000111", price=109, open=100, high=110, low=99, volume=1234)])
    monkeypatch.setattr(screener_intraday.kis_access, "kis_for_role", lambda role, data_dir: fake)

    first = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path, codes=["000111"], today="20260625", universe=None, now_ms=1_000, ttl_ms=15_000,
    )
    second = await screener_intraday.build_intraday_overlay(
        data_dir=tmp_path, codes=["000111"], today="20260625", universe=None, now_ms=2_000, ttl_ms=15_000,
    )

    assert fake.calls == 1
    assert first.rows.to_dicts() == second.rows.to_dicts()
```

- [ ] **Step 2: Run failing tests**

Run: `uv run --extra dev pytest tests/api/test_screener_intraday.py -v`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement overlay service**

Create `hoga/api/screener_intraday.py`:

```python
from __future__ import annotations

import datetime as dt
import asyncio
from dataclasses import dataclass
from pathlib import Path

import polars as pl

from hoga.live import kis_access

_SCHEMA = {
    "code": pl.Utf8,
    "date": pl.Date,
    "open": pl.Float64,
    "high": pl.Float64,
    "low": pl.Float64,
    "close": pl.Float64,
    "volume": pl.Int64,
}


@dataclass(frozen=True)
class IntradayDailyOverlay:
    rows: pl.DataFrame
    fetched_at_ms: int | None
    warnings: list[str]


_CACHE: dict[tuple[Path, str, tuple[str, ...]], IntradayDailyOverlay] = {}
_CACHE_AT: dict[tuple[Path, str, tuple[str, ...]], int] = {}
_LOCKS: dict[tuple[Path, str, tuple[str, ...]], asyncio.Lock] = {}


def _empty(warnings: list[str] | None = None) -> IntradayDailyOverlay:
    return IntradayDailyOverlay(
        rows=pl.DataFrame(schema=_SCHEMA),
        fetched_at_ms=None,
        warnings=warnings or [],
    )


def _date(yyyymmdd: str) -> dt.date:
    return dt.datetime.strptime(yyyymmdd, "%Y%m%d").date()


def _valid_quote(q) -> bool:
    nums = [q.price, q.open, q.high, q.low, q.volume]
    return all(isinstance(v, int) and v > 0 for v in nums) and q.high >= max(q.open, q.price) and q.low <= min(q.open, q.price)


async def build_intraday_overlay(
    *,
    data_dir: Path,
    codes: list[str],
    today: str,
    universe: object | None,
    now_ms: int,
    ttl_ms: int = 15_000,
) -> IntradayDailyOverlay:
    unique_codes = tuple(sorted({c for c in codes if len(c) == 6}))
    if not unique_codes:
        return _empty()
    key = (data_dir, today, unique_codes)
    cached = _CACHE.get(key)
    cached_at = _CACHE_AT.get(key)
    if cached is not None and cached_at is not None and now_ms - cached_at <= ttl_ms:
        return cached

    lock = _LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        cached = _CACHE.get(key)
        cached_at = _CACHE_AT.get(key)
        if cached is not None and cached_at is not None and now_ms - cached_at <= ttl_ms:
            return cached

        kis = kis_access.kis_for_role("background", data_dir)
        if kis is None:
            return _empty(["intraday_kis_unavailable"])

        try:
            quotes = await kis.fetch_multi_price(list(unique_codes))
        except Exception:
            return _empty(["intraday_quote_fetch_failed"])

        rows = []
        invalid = False
        d = _date(today)
        for q in quotes:
            if not _valid_quote(q):
                invalid = True
                continue
            rows.append({
                "code": q.code,
                "date": d,
                "open": float(q.open),
                "high": float(q.high),
                "low": float(q.low),
                "close": float(q.price),
                "volume": int(q.volume),
            })
        warnings = ["intraday_quote_invalid"] if invalid else []
        overlay = IntradayDailyOverlay(
            rows=pl.DataFrame(rows, schema=_SCHEMA) if rows else pl.DataFrame(schema=_SCHEMA),
            fetched_at_ms=now_ms,
            warnings=warnings,
        )
        _CACHE[key] = overlay
        _CACHE_AT[key] = now_ms
        return overlay
```

- [ ] **Step 4: Add universe prefilter**

Add a helper that reads `stocks.parquet` and applies the same `ScreenerUniverse` market/ETF/halted filters before calling `build_intraday_overlay`. Use this helper from the route so KIS fetch volume is bounded by the selected universe, not by every listed stock.

- [ ] **Step 5: Add concurrent cache test**

Add a test that launches two `build_intraday_overlay(...)` calls concurrently for the same key and asserts `fake.calls == 1`.

- [ ] **Step 6: Verify**

Run: `uv run --extra dev pytest tests/api/test_screener_intraday.py -v`

Expected: PASS.

---

### Task 5: Wire Intraday Basis Into `/api/screener/scan`

**Files:**
- Modify: `hoga/api/screener.py`
- Test: `tests/api/test_screener_routes.py`

**Interfaces:**
- Consumes: `ScanRequest.basis`
- Produces: `ScreenerResponse.warnings` including intraday warnings.
- Keeps default `/scan` behavior EOD when `basis` is omitted.

- [ ] **Step 1: Write route test**

Add to `tests/api/test_screener_routes.py`:

```python
import datetime as dt
from hoga.api.screener_intraday import IntradayDailyOverlay


def test_scan_intraday_basis_uses_overlay(tmp_path, monkeypatch):
    import hoga.api.screener as screener_mod

    async def fake_overlay(**kwargs):
        return IntradayDailyOverlay(
            rows=pl.DataFrame({
                "code": ["000001"],
                "date": [dt.date(2026, 5, 15)],
                "open": [100.0],
                "high": [130.0],
                "low": [99.0],
                "close": [125.0],
                "volume": [100],
            }),
            fetched_at_ms=123,
            warnings=[],
        )

    monkeypatch.setattr(screener_mod.screener_intraday, "build_intraday_overlay", fake_overlay)
    monkeypatch.setattr(screener_mod, "now_kst", lambda: dt.datetime(2026, 5, 15, 10, 0))

    c = TestClient(_app(tmp_path))
    resp = c.post("/api/screener/scan", json={
        "basis": "intraday",
        "conditions": [{"id": "a", "type": "price_range", "params": {"min": 120}}],
        "universe": {"markets": ["KOSPI"]},
    })

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["rows"][0]["price"] == 125
```

- [ ] **Step 2: Run failing route test**

Run: `uv run --extra dev pytest tests/api/test_screener_routes.py::test_scan_intraday_basis_uses_overlay -v`

Expected: FAIL because route does not use overlay.

- [ ] **Step 3: Implement route wiring**

In `hoga/api/screener.py`, import the new module:

```python
from hoga.api import screener_intraday
```

Change `scan` from sync to async and branch on basis:

```python
@router.post("/scan")
async def scan(req: ScanRequest) -> ScreenerResponse:
    if not (sdir / "status.json").exists():
        return ScreenerResponse(status="not_seeded", rows=[])
    warnings: list[str] = []
    intraday_rows = None
    if req.basis == "intraday":
        codes = await asyncio.to_thread(
            screener_intraday.codes_for_universe,
            sdir / "stocks.parquet",
            req.universe,
        )
        today = now_kst().strftime("%Y%m%d")
        overlay = await screener_intraday.build_intraday_overlay(
            data_dir=data_dir,
            codes=codes,
            today=today,
            universe=req.universe,
            now_ms=int(time.time() * 1000),
        )
        intraday_rows = overlay.rows
        warnings.extend(overlay.warnings)
        if overlay.rows.height == 0:
            warnings.append("intraday_fallback_eod")
    rows = await asyncio.to_thread(
        screener_scan.run_scan,
        sdir / "daily_adjusted.parquet",
        sdir / "stocks.parquet",
        conditions=req.conditions,
        universe=req.universe,
        limit=req.limit,
        intraday_rows=intraday_rows,
    )
    return ScreenerResponse(status="ok", rows=rows, warnings=warnings)
```

- [ ] **Step 4: Add fallback/default tests**

Add route tests proving:

- Omitting `basis` does not call `build_intraday_overlay`.
- `basis="intraday"` with empty/failed overlay returns EOD rows plus `intraday_fallback_eod`.
- Universe filters are applied before KIS fetch; a KOSPI-only scan does not request KOSDAQ codes.

- [ ] **Step 5: Verify route behavior**

Run:

```bash
uv run --extra dev pytest tests/api/test_screener_routes.py::test_scan_intraday_basis_uses_overlay -v
uv run --extra dev pytest tests/api/test_screener_routes.py tests/api/test_screener_scan.py tests/api/test_screener_intraday.py -v
```

Expected: PASS.

---

### Task 6: Add Frontend Basis Request

**Files:**
- Modify: `frontend/src/api/screener.ts`
- Modify: `frontend/src/pages/Screener.tsx`
- Test: `frontend/src/api/screener.test.ts`
- Test: `frontend/src/pages/Screener.test.tsx`

**Interfaces:**
- Consumes: `ScanRequest.basis?: 'eod' | 'intraday'`
- Produces: page scan requests with selected basis.
- Produces: visible basis/fallback state so users can distinguish EOD corpus staleness from intraday snapshot freshness.

- [ ] **Step 1: Update API test**

Modify `frontend/src/api/screener.test.ts` scan body:

```ts
await runScan({
  conditions: [{ id: 'a', type: 'new_high', params: { lookback: 200, period: 500 } }],
  universe: { markets: ['KOSPI'] },
  limit: 20,
  basis: 'intraday',
});
```

Add expectation:

```ts
expect(body.basis).toBe('intraday');
```

- [ ] **Step 2: Run failing frontend API test**

Run: `cd frontend && npx vitest run src/api/screener.test.ts`

Expected: PASS at runtime but TypeScript may fail until types are added.

- [ ] **Step 3: Add basis type**

In `frontend/src/api/screener.ts`:

```ts
export type ScanBasis = 'eod' | 'intraday';

export interface ScanRequest {
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  limit?: number;
  basis?: ScanBasis;
}
```

- [ ] **Step 4: Add page state and controls**

In `frontend/src/pages/Screener.tsx`, import the type:

```ts
import type { ScanBasis } from '../api/screener';
```

Add state:

```ts
const [basis, setBasis] = useState<ScanBasis>('intraday');
```

Include it in scan body:

```ts
const scanBody = useMemo(
  () => ({ conditions: editor.conditions, universe: editor.universe, basis }),
  [editor.conditions, editor.universe, basis],
);
```

Add a compact segmented control near the 조회 button:

```tsx
<div className="inline-flex rounded-lg border border-border bg-bg-input overflow-hidden">
  {(['intraday', 'eod'] as const).map((value) => (
    <button
      key={value}
      type="button"
      onClick={() => setBasis(value)}
      className={`px-3 py-[7px] text-sm ${basis === value ? 'bg-tint-selection text-accent' : 'text-fg-dim hover:bg-bg-input-hover'}`}
    >
      {value === 'intraday' ? '오늘 장중' : '전일 확정'}
    </button>
  ))}
</div>
```

- [ ] **Step 5: Surface basis and fallback state**

Update the status area so:

- The existing staleness chip reads as EOD corpus status, for example `EOD 마지막: 20260624 · 1거래일 뒤처짐`.
- When `basis === 'intraday'` and the response has `intraday_fallback_eod`, show a visible warning that the current result used EOD data.
- When `basis === 'intraday'` and overlay data is used, show intraday snapshot age if the backend exposes it in warnings/metadata; if not exposed in this first pass, show only the selected basis.

- [ ] **Step 6: Verify frontend**

Run:

```bash
cd frontend
npx vitest run src/api/screener.test.ts src/pages/Screener.test.tsx
npx tsc -p tsconfig.app.json --noEmit
```

Expected: PASS.

---

### Task 7: End-to-End Verification and Regression Sweep

**Files:**
- No new source files unless failures reveal missing coverage.

**Interfaces:**
- Consumes all previous tasks.
- Produces confidence that EOD and intraday paths both work.

- [ ] **Step 1: Run backend focused suite**

Run:

```bash
uv run --extra dev pytest \
  tests/api/test_screener_models.py \
  tests/api/test_screener_scan.py \
  tests/api/test_screener_intraday.py \
  tests/api/test_screener_routes.py \
  tests/unit/live/test_kis_multi_price.py -v
```

Expected: PASS.

- [ ] **Step 2: Run frontend focused suite**

Run:

```bash
cd frontend
npx vitest run src/api/screener.test.ts src/pages/Screener.test.tsx src/screener/useScreenerRowsLive.test.tsx
npx tsc -p tsconfig.app.json --noEmit
```

Expected: PASS.

- [ ] **Step 3: Manual smoke test**

Start the app with the project’s normal dev command. Open `http://localhost:5173/screener`.

Verify:

- `오늘 장중` is selected by default.
- Running a scan sends `"basis":"intraday"` in the request body.
- If KIS credentials are available, result conditions use intraday prices.
- If KIS credentials are unavailable, scan still returns EOD rows and includes `intraday_fallback_eod` in warnings.
- Switching to `전일 확정` sends `"basis":"eod"` and preserves prior EOD behavior.

## Self-Review Checklist

- Spec coverage: full intraday basis is covered for all existing OHLCV-based conditions because the combined `adj` view is the sole data source for condition compilers.
- Placeholder scan: no unresolved placeholder markers or “similar to” steps remain.
- Type consistency: `basis`, `intraday_rows`, `IntradayDailyOverlay`, and `volume` names are consistent across tasks.
- Scope note: KIS HTS server-stored 조건검색 is intentionally out of scope for this plan; this plan upgrades the existing self-hosted screener.

## GSTACK REVIEW REPORT

- **Not in scope:** KIS HTS/eFriend server-stored 조건검색 creation, background quote poller/cache daemon, persisting intraday rows to parquet, OR/grouped conditions, saving basis into `SavedScreener`, changing 거래대금 semantics, and making the right-rail Screener Panel intraday.
- **What already exists:** `KisClient.fetch_multi_price`, background KIS role routing, the DuckDB condition compiler model, `daily_adjusted.parquet` as scan target, `ScreenerUniverse`, and the display-only Live Quote overlay.
- **Architecture decision:** add an explicit `ScanBasis` and an intraday OHLCV overlay relation instead of teaching each condition to call KIS.
- **Required ADR/doc update:** amend ADR-0056 or add a new ADR because explicit intraday scan basis supersedes the old display-only rule.
- **Main failure modes:** missing batched cumulative volume, KIS auth/rate-limit failure, stale adjusted corpus around corporate actions, market-closed/holiday semantics, concurrent scan stampede, and user confusion between EOD corpus freshness and intraday snapshot freshness.
- **Parallelization strategy:** backend parser/model/scan tests can run independently from frontend basis UI work after Task 0 resolves KIS field capability; route wiring depends on scan and overlay interfaces.
