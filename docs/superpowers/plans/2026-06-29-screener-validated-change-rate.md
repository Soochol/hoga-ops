# Screener Validated Change Rate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent corporate-action / halted-day anomalies such as GigaLane showing `+682.48%` by deriving displayed live change rates from a validated baseline instead of blindly trusting KIS `prdy_ctrt`.

**Architecture:** Add a backend quote-change resolver that treats KIS live price as authoritative for current price, but treats KIS live change rate as advisory. The resolver compares KIS `prdy_ctrt` against a locally derived adjusted-daily baseline and emits provenance fields so screeners and watchlists can display and sort on one verified `change_pct`.

**Tech Stack:** Python 3.13, FastAPI, Pydantic, DuckDB/Parquet, pytest, TypeScript, React Query, Vitest.

## Global Constraints

- Preserve existing `/api/live/quotes` fields: `code`, `price`, `change_pct`, `change_won`, `open`, `high`, `low`.
- New quote provenance fields must be optional on the frontend so older API responses remain type-compatible in tests.
- Do not special-case GigaLane or any single code; model this as a source validation problem.
- Backend quote overlay must never raise a 500 because KIS or local screener data is unavailable.
- Keep existing pre-open behavior: `change_pct` and `change_won` are hidden as `null` during `pre_open`.
- Keep existing closed behavior: serve the last-seen quote cache when available.

---

## File Structure

- Create: `hoga/live/quote_change_resolver.py`
  - Owns validated change-rate calculation and provenance.
  - Reads a small baseline map from `screener/daily_adjusted.parquet` when available.
  - Contains no FastAPI route code.

- Modify: `hoga/live/api.py`
  - Extends `LiveQuote` response model with optional provenance fields.
  - Wires `LiveQuoteFetcher` to call `QuoteChangeResolver` for `open` and `closed` quotes.
  - Leaves `pre_open` quote change fields hidden.

- Modify: `frontend/src/api/liveQuotes.ts`
  - Adds optional provenance fields to `LiveQuote`.

- Modify: `frontend/src/screener/useScreenerRowsLive.ts`
  - No behavioral branching needed if backend returns validated `change_pct`; update comments only if necessary.

- Test: `tests/unit/live/test_quote_change_resolver.py`
  - Unit coverage for corporate-action rejection, normal KIS acceptance, missing-baseline fallback, and zero/invalid baseline handling.

- Test: `tests/unit/live/test_live_quotes_route.py`
  - Route-level regression proving `/api/live/quotes` returns `-21.75` instead of `+682.48` when adjusted baseline is `9930` and live price is `7770`.

- Test: `frontend/src/api/liveQuotes.test.tsx` or existing type-adjacent tests if more appropriate
  - Verifies provenance fields are accepted by the frontend type/query layer.

---

### Task 1: Add Quote Change Resolver

**Files:**
- Create: `hoga/live/quote_change_resolver.py`
- Test: `tests/unit/live/test_quote_change_resolver.py`

**Interfaces:**
- Consumes: `hoga.live.kis_client.KisQuote`
- Produces:
  - `QuoteChangeResolution`
  - `QuoteChangeResolver.resolve_quote(q: KisQuote, phase: str) -> QuoteChangeResolution`

- [ ] **Step 1: Write the failing resolver tests**

Create `tests/unit/live/test_quote_change_resolver.py`:

```python
import datetime as dt

import duckdb

from hoga.live.kis_client import KisQuote
from hoga.live.quote_change_resolver import QuoteChangeResolver


def _write_adjusted_daily(path, rows):
    con = duckdb.connect(":memory:")
    con.execute(
        "CREATE TABLE d(code VARCHAR, date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)"
    )
    con.executemany(
        "INSERT INTO d VALUES (?,?,?,?,?,?,?)",
        [
            (code, dt.date.fromisoformat(date_s), open_, high, low, close, volume)
            for code, date_s, open_, high, low, close, volume in rows
        ],
    )
    con.execute(f"COPY d TO '{path}' (FORMAT parquet)")


def test_rejects_kis_change_rate_when_adjusted_baseline_disagrees(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("049080", "2026-06-26", 9930, 9930, 9930, 9930, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = KisQuote(code="049080", price=7770, change_pct=682.48, change_won=None)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == -21.75
    assert out.change_pct_source == "adjusted_daily"
    assert out.baseline_price == 9930
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == ["kis_change_pct_rejected"]


def test_accepts_kis_change_rate_when_it_matches_adjusted_baseline(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = KisQuote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 3.0
    assert out.change_won == 3
    assert out.change_pct_source == "kis"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []


def test_missing_adjusted_file_falls_back_to_kis_without_warning(tmp_path):
    resolver = QuoteChangeResolver(adjusted_daily_path=tmp_path / "missing.parquet")

    q = KisQuote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 3.0
    assert out.change_won == 3
    assert out.change_pct_source == "kis"
    assert out.baseline_price is None
    assert out.baseline_date is None
    assert out.warnings == []


def test_invalid_baseline_falls_back_to_kis_and_marks_warning(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 0, 0, 0, 0, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = KisQuote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="open")

    assert out.change_pct == 3.0
    assert out.change_pct_source == "kis"
    assert out.baseline_price is None
    assert out.baseline_date is None
    assert out.warnings == ["adjusted_baseline_unavailable"]


def test_pre_open_hides_change_fields_even_with_baseline(tmp_path):
    daily = tmp_path / "daily_adjusted.parquet"
    _write_adjusted_daily(
        daily,
        [("005930", "2026-06-26", 100, 100, 100, 100, 100)],
    )
    resolver = QuoteChangeResolver(adjusted_daily_path=daily)

    q = KisQuote(code="005930", price=103, change_pct=3.0, change_won=3)
    out = resolver.resolve_quote(q, phase="pre_open")

    assert out.change_pct is None
    assert out.change_won is None
    assert out.change_pct_source == "hidden_pre_open"
    assert out.baseline_price == 100
    assert out.baseline_date == "2026-06-26"
    assert out.warnings == []
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
uv run pytest tests/unit/live/test_quote_change_resolver.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.live.quote_change_resolver'`.

- [ ] **Step 3: Implement the resolver**

Create `hoga/live/quote_change_resolver.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import duckdb

from hoga.live.kis_client import KisQuote

ChangePctSource = Literal[
    "kis",
    "adjusted_daily",
    "hidden_pre_open",
    "unavailable",
]

_REJECT_DIFF_PCT_POINTS = 5.0
_EXTREME_KIS_ABS_PCT = 30.0


@dataclass(frozen=True)
class QuoteChangeResolution:
    code: str
    price: int
    change_pct: float | None
    change_won: int | None
    baseline_price: int | None = None
    baseline_date: str | None = None
    change_pct_source: ChangePctSource = "unavailable"
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _Baseline:
    date: str
    close: int


class QuoteChangeResolver:
    def __init__(self, *, adjusted_daily_path: Path | None) -> None:
        self._adjusted_daily_path = adjusted_daily_path
        self._baseline_cache: dict[str, _Baseline | None] = {}

    def resolve_quote(self, q: KisQuote, *, phase: str) -> QuoteChangeResolution:
        baseline = self._baseline_for(q.code)
        warnings: list[str] = []

        if phase == "pre_open":
            return QuoteChangeResolution(
                code=q.code,
                price=q.price,
                change_pct=None,
                change_won=None,
                baseline_price=baseline.close if baseline else None,
                baseline_date=baseline.date if baseline else None,
                change_pct_source="hidden_pre_open",
            )

        adjusted_pct = self._adjusted_change_pct(q, baseline)
        if baseline is not None and adjusted_pct is not None and q.change_pct is not None:
            if self._should_reject_kis(kis_pct=q.change_pct, adjusted_pct=adjusted_pct):
                warnings.append("kis_change_pct_rejected")
                return QuoteChangeResolution(
                    code=q.code,
                    price=q.price,
                    change_pct=adjusted_pct,
                    change_won=round(q.price - baseline.close),
                    baseline_price=baseline.close,
                    baseline_date=baseline.date,
                    change_pct_source="adjusted_daily",
                    warnings=warnings,
                )

        if q.change_pct is not None:
            return QuoteChangeResolution(
                code=q.code,
                price=q.price,
                change_pct=q.change_pct,
                change_won=q.change_won,
                baseline_price=baseline.close if baseline else None,
                baseline_date=baseline.date if baseline else None,
                change_pct_source="kis",
            )

        if adjusted_pct is not None and baseline is not None:
            return QuoteChangeResolution(
                code=q.code,
                price=q.price,
                change_pct=adjusted_pct,
                change_won=round(q.price - baseline.close),
                baseline_price=baseline.close,
                baseline_date=baseline.date,
                change_pct_source="adjusted_daily",
            )

        if self._adjusted_daily_path is not None and self._adjusted_daily_path.exists():
            warnings.append("adjusted_baseline_unavailable")
        return QuoteChangeResolution(
            code=q.code,
            price=q.price,
            change_pct=None,
            change_won=None,
            change_pct_source="unavailable",
            warnings=warnings,
        )

    def _baseline_for(self, code: str) -> _Baseline | None:
        if code in self._baseline_cache:
            return self._baseline_cache[code]
        baseline = self._load_baseline(code)
        self._baseline_cache[code] = baseline
        return baseline

    def _load_baseline(self, code: str) -> _Baseline | None:
        if self._adjusted_daily_path is None or not self._adjusted_daily_path.exists():
            return None
        try:
            con = duckdb.connect(":memory:")
            row = con.execute(
                f"""
                SELECT CAST(date AS VARCHAR) AS date_s, close
                FROM '{self._adjusted_daily_path}'
                WHERE code = ? AND close > 0
                ORDER BY date DESC
                LIMIT 1
                """,
                [code],
            ).fetchone()
        except Exception:
            return None
        if row is None:
            return None
        return _Baseline(date=str(row[0]), close=int(round(float(row[1]))))

    def _adjusted_change_pct(self, q: KisQuote, baseline: _Baseline | None) -> float | None:
        if baseline is None or baseline.close <= 0 or q.price <= 0:
            return None
        return round((q.price / baseline.close - 1.0) * 100.0, 2)

    def _should_reject_kis(self, *, kis_pct: float, adjusted_pct: float) -> bool:
        diff = abs(kis_pct - adjusted_pct)
        if diff < _REJECT_DIFF_PCT_POINTS:
            return False
        if abs(kis_pct) >= _EXTREME_KIS_ABS_PCT:
            return True
        return diff >= _REJECT_DIFF_PCT_POINTS
```

- [ ] **Step 4: Run resolver tests**

Run:

```bash
uv run pytest tests/unit/live/test_quote_change_resolver.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/quote_change_resolver.py tests/unit/live/test_quote_change_resolver.py
git commit -m "feat(live): validate quote change rates against adjusted baseline"
```

---

### Task 2: Wire Resolver Into Live Quotes API

**Files:**
- Modify: `hoga/live/api.py`
- Test: `tests/unit/live/test_live_quotes_route.py`

**Interfaces:**
- Consumes: `QuoteChangeResolver.resolve_quote(q, phase=phase)`
- Produces: `/api/live/quotes` response fields:
  - `baseline_price: int | None`
  - `baseline_date: str | None`
  - `change_pct_source: str | None`
  - `warnings: list[str]`

- [ ] **Step 1: Add route regression test**

Append to `tests/unit/live/test_live_quotes_route.py`:

```python
import datetime as dt
import duckdb


def _seed_quote_adjusted_daily(tmp_path, rows):
    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True, exist_ok=True)
    daily = sdir / "daily_adjusted.parquet"
    con = duckdb.connect(":memory:")
    con.execute(
        "CREATE TABLE d(code VARCHAR, date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)"
    )
    con.executemany(
        "INSERT INTO d VALUES (?,?,?,?,?,?,?)",
        [
            (code, dt.date.fromisoformat(date_s), open_, high, low, close, volume)
            for code, date_s, open_, high, low, close, volume in rows
        ],
    )
    con.execute(f"COPY d TO '{daily}' (FORMAT parquet)")
    return daily


def test_quotes_recomputes_change_pct_when_kis_uses_unadjusted_baseline(monkeypatch, tmp_path):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    _seed_quote_adjusted_daily(
        tmp_path,
        [("049080", "2026-06-26", 9930, 9930, 9930, 9930, 100)],
    )
    quotes = [KisQuote("049080", 7770, 682.48, None)]
    c = TestClient(_app(quotes, tmp_path))

    r = c.get("/api/live/quotes", params={"codes": "049080"})

    assert r.status_code == 200
    q0 = r.json()["quotes"][0]
    assert q0["price"] == 7770
    assert q0["change_pct"] == -21.75
    assert q0["change_won"] == -2160
    assert q0["baseline_price"] == 9930
    assert q0["baseline_date"] == "2026-06-26"
    assert q0["change_pct_source"] == "adjusted_daily"
    assert q0["warnings"] == ["kis_change_pct_rejected"]
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
uv run pytest tests/unit/live/test_live_quotes_route.py::test_quotes_recomputes_change_pct_when_kis_uses_unadjusted_baseline -v
```

Expected: FAIL because `change_pct` is still `682.48` or new provenance keys are absent.

- [ ] **Step 3: Extend `LiveQuote` model**

Modify `hoga/live/api.py` `LiveQuote` class:

```python
class LiveQuote(BaseModel):
    code: str
    price: int
    change_pct: float | None
    change_won: int | None
    open: int | None = None
    high: int | None = None
    low: int | None = None
    baseline_price: int | None = None
    baseline_date: str | None = None
    change_pct_source: str | None = None
    warnings: list[str] = []
```

- [ ] **Step 4: Import and instantiate resolver**

Modify imports near the other live imports in `hoga/live/api.py`:

```python
from hoga.live.quote_change_resolver import QuoteChangeResolver
```

Modify the quote fetcher initialization near `_quote_fetcher = LiveQuoteFetcher()`:

```python
    quote_change_resolver = QuoteChangeResolver(
        adjusted_daily_path=(
            data_dir / "screener" / "daily_adjusted.parquet"
            if data_dir is not None
            else None
        )
    )
    _quote_fetcher = LiveQuoteFetcher(change_resolver=quote_change_resolver)
```

- [ ] **Step 5: Update `LiveQuoteFetcher` constructor and mapper**

Modify `LiveQuoteFetcher` in `hoga/live/api.py`:

```python
class LiveQuoteFetcher:
    def __init__(self, *, change_resolver: QuoteChangeResolver | None = None) -> None:
        self._last_quotes: dict[str, KisQuote] = {}
        self._change_resolver = change_resolver or QuoteChangeResolver(adjusted_daily_path=None)

    def _to_live_quote(self, q: KisQuote, *, phase: str) -> LiveQuote:
        resolved = self._change_resolver.resolve_quote(q, phase=phase)
        pre = phase == "pre_open"
        return LiveQuote(
            code=q.code,
            price=q.price,
            change_pct=resolved.change_pct,
            change_won=resolved.change_won,
            open=(None if pre else q.open),
            high=(None if pre else q.high),
            low=(None if pre else q.low),
            baseline_price=resolved.baseline_price,
            baseline_date=resolved.baseline_date,
            change_pct_source=resolved.change_pct_source,
            warnings=resolved.warnings,
        )
```

Then replace both manual `LiveQuote(...)` list comprehensions in `fetch_and_gate`:

```python
            return [
                self._to_live_quote(q, phase=phase)
                for c in code_list
                if (q := self._last_quotes.get(c)) is not None
            ]
```

and:

```python
        return [self._to_live_quote(q, phase=phase) for q in quotes]
```

- [ ] **Step 6: Run targeted route tests**

Run:

```bash
uv run pytest tests/unit/live/test_live_quotes_route.py::test_quotes_recomputes_change_pct_when_kis_uses_unadjusted_baseline tests/unit/live/test_live_quotes_route.py::test_quotes_pre_open_nulls_change_pct tests/unit/live/test_live_quotes_route.py::test_quotes_closed_serves_last_seen_without_kis -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hoga/live/api.py tests/unit/live/test_live_quotes_route.py
git commit -m "feat(api): serve validated live quote change rates"
```

---

### Task 3: Update Frontend Quote Types

**Files:**
- Modify: `frontend/src/api/liveQuotes.ts`
- Test: `frontend/src/api/liveQuotes.test.tsx`

**Interfaces:**
- Consumes: `/api/live/quotes` optional provenance fields.
- Produces: `LiveQuote` TypeScript type with optional provenance fields.

- [ ] **Step 1: Add frontend type/query test**

Append to `frontend/src/api/liveQuotes.test.tsx`:

```typescript
import { getQuotes } from './liveQuotes';

it('accepts validated quote provenance fields', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      phase: 'open',
      quotes: [{
        code: '049080',
        price: 7770,
        change_pct: -21.75,
        change_won: -2160,
        open: 7770,
        high: 7770,
        low: 7770,
        baseline_price: 9930,
        baseline_date: '2026-06-26',
        change_pct_source: 'adjusted_daily',
        warnings: ['kis_change_pct_rejected'],
      }],
    }),
  } as Response);

  const res = await getQuotes(['049080']);

  expect(res.quotes[0].change_pct).toBe(-21.75);
  expect(res.quotes[0].baseline_price).toBe(9930);
  expect(res.quotes[0].baseline_date).toBe('2026-06-26');
  expect(res.quotes[0].change_pct_source).toBe('adjusted_daily');
  expect(res.quotes[0].warnings).toEqual(['kis_change_pct_rejected']);
});
```

If the file already imports `getQuotes` or has fetch helpers, reuse existing imports and only add the test body.

- [ ] **Step 2: Run test to verify it fails at type-check or assertion**

Run:

```bash
cd frontend && npx vitest run src/api/liveQuotes.test.tsx
```

Expected: FAIL if TypeScript does not recognize provenance fields, or PASS at runtime but `npm run build` fails before the type update.

- [ ] **Step 3: Extend `LiveQuote` interface**

Modify `frontend/src/api/liveQuotes.ts`:

```typescript
export interface LiveQuote {
  code: string;
  price: number;
  change_pct: number | null;
  /** 전일대비 등락액(원). 장전(pre_open)·무데이터 시 null. */
  change_won: number | null;
  /** 당일 OHLC(멀티시세 inter2_oprc/hgpr/lwpr). **optional** — 필수면 screener·
   *  live-price-line·SectorTempStrip.test 등 범위 밖 6파일이 tsc 에러. 와이어는 항상 키를
   *  보내지만(FastAPI 전필드 직렬화) 타입은 느슨히, 호출부에서 `?? null` 강제. */
  open?: number | null;
  high?: number | null;
  low?: number | null;
  /** 검증 기준가. corporate action 방어용 adjusted daily baseline. */
  baseline_price?: number | null;
  /** 검증 기준가 날짜(YYYY-MM-DD). */
  baseline_date?: string | null;
  /** change_pct 최종 소스: kis, adjusted_daily, hidden_pre_open, unavailable. */
  change_pct_source?: string | null;
  /** quote validation warnings such as kis_change_pct_rejected. */
  warnings?: string[];
}
```

- [ ] **Step 4: Run frontend targeted test**

Run:

```bash
cd frontend && npx vitest run src/api/liveQuotes.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run screener live merge tests**

Run:

```bash
cd frontend && npx vitest run src/screener/useScreenerRowsLive.test.tsx src/screener/ResultTable.test.tsx
```

Expected: PASS. `useScreenerRowsLive` should continue using `q.change_pct`, which is now backend-validated.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/liveQuotes.ts frontend/src/api/liveQuotes.test.tsx
git commit -m "feat(frontend): type validated live quote provenance"
```

---

### Task 4: Full Verification and Documentation Note

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: documented behavior and verified backend/frontend test pass.

- [ ] **Step 1: Add changelog entry**

Add under the current unreleased section in `CHANGELOG.md`:

```markdown
- Screener/live quote change rates now validate KIS `prdy_ctrt` against the adjusted daily baseline, preventing corporate-action days from showing unadjusted spikes such as `+682.48%` after stock consolidation.
```

- [ ] **Step 2: Run backend targeted suite**

Run:

```bash
uv run pytest tests/unit/live/test_quote_change_resolver.py tests/unit/live/test_live_quotes_route.py tests/api/test_screener_scan.py -v
```

Expected: PASS.

- [ ] **Step 3: Run frontend targeted suite**

Run:

```bash
cd frontend && npx vitest run src/api/liveQuotes.test.tsx src/screener/useScreenerRowsLive.test.tsx src/screener/ResultTable.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run build/type checks**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: note validated screener change rates"
```

---

## Self-Review

**Spec coverage:** The plan covers backend validation, KIS anomaly rejection, API provenance, frontend typing, screener compatibility, and regression tests for the GigaLane-shaped case.

**Placeholder scan:** No implementation step relies on unspecified behavior or a single-stock exception.

**Type consistency:** `QuoteChangeResolution.change_pct_source` values match the frontend comment and route response fields. `baseline_date` is consistently a `YYYY-MM-DD` string from DuckDB `CAST(date AS VARCHAR)`.
