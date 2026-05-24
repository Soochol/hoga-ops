# Broker Day-Trajectory Sparklines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cursor-snapshot 거래원 sidebar card with a day-anchored, stable list of brokers — each row carrying a per-broker signed-net sparkline across the trading day, with honest dashed segments where the broker was outside top-5.

**Architecture:** A new day-scope endpoint `GET /api/brokers/series?code=&date=` returns per-broker signed-net trajectories for one Stock-Date. The frontend fetches via `@tanstack/react-query` (`staleTime: Infinity`, matching the `useRange` pattern — captured Stock-Dates are immutable). The renamed `BrokerTrajectoryTable` consumes the series + `cursorMs`, draws inline SVG sparklines, and projects the per-row net at cursor by binary-searching points. The 10호가 and 체결 cards stay cursor-keyed (ADR-0023's accepted asymmetry).

**Tech Stack:** Python 3.11 / FastAPI / DuckDB / pyarrow / pydantic v2 (backend). React 18 / TypeScript 5 / Vite / @tanstack/react-query v5 / vitest / @testing-library/react / Tailwind (frontend).

**Reference docs:**
- Spec: `docs/superpowers/specs/2026-05-24-broker-day-trajectory-design.md`
- ADR: `docs/adr/0023-broker-card-day-anchored.md`
- CONTEXT: `CONTEXT.md` ("Cursor Sidebar" + "Broker Day-Trajectory" entries)
- DESIGN tokens: `DESIGN.md` (color: `--price-up` #DC2626, `--price-down` #2563EB, `--accent` #14B8A6, `--fg-dim` #94A3B8, `--fg-dimmer` #64748B)

**File Structure (changes):**

| File | Action | Responsibility |
|---|---|---|
| `hoga/api/models.py` | Modify | Add `BrokerSeriesPoint`, `BrokerSeriesEntry`, `BrokerSeriesResponse` |
| `hoga/tables/brokers.py` | Modify | Add `query_day_series(con, *, path)` — DuckDB aggregation + Python grouping |
| `tests/test_tables_brokers.py` | Modify | Add `query_day_series` tests (continuous broker / dropout broker / dual-side broker / empty parquet) |
| `hoga/api/routes.py` | Modify | Add `GET /api/brokers/series` handler |
| `tests/test_api_brokers_series.py` | Create | Route happy-path + 404 tests via `app_client` |
| `frontend/src/api/types.ts` | Modify | Mirror new wire types per ADR-0004 |
| `frontend/src/api/brokerSeries.ts` | Create | `useBrokerSeriesForDay(code, date)` react-query hook |
| `frontend/src/api/brokerSeries.test.tsx` | Create | Hook tests (disabled when null, correct querystring, caches by `(code, date)`) |
| `frontend/src/sidebar/BrokerTrajectoryTable.tsx` | Create | Replaces `BrokerNetTable.tsx`. Pure SVG sparklines + `netAtCursor` |
| `frontend/src/sidebar/BrokerTrajectoryTable.test.tsx` | Create | Component + `netAtCursor` + gap detection + cursor marker visibility |
| `frontend/src/sidebar/BrokerNetTable.tsx` | Delete | Replaced |
| `frontend/src/sidebar/CursorSidebar.tsx` | Modify | Swap hook in `CursorSidebarConnected`, change `grid-rows-[2fr_1fr_1fr]` → `grid-rows-[2fr_1.4fr_1fr]` |

---

## Task 1: Backend wire models for broker series

**Files:**
- Modify: `hoga/api/models.py`

- [ ] **Step 1: Add the three new pydantic models**

Open `hoga/api/models.py` and append at the end of the file (after the existing `RangeBundle` and related types):

```python
# === Broker Day-Trajectory (ADR-0023) ===
# Day-scope series shipped by GET /api/brokers/series. The point's `net` is
# already signed by side at the producer (buy = +, sell = −) so the frontend
# does not re-aggregate; matches the legacy BrokerNetTable.computeNet sign
# convention. dominant_side mirrors sign(final_net) as a Literal so the
# frontend can color the row without recomputing.

class BrokerSeriesPoint(BaseModel):
    ts_ms: int
    net: int


class BrokerSeriesEntry(BaseModel):
    broker: str
    final_net: int
    dominant_side: Literal["buy", "sell"]
    points: list[BrokerSeriesPoint]


class BrokerSeriesResponse(BaseModel):
    date: str
    brokers: list[BrokerSeriesEntry]
```

Add `Literal` to the existing `from typing import ...` line at the top if not already imported. (If the file has no `typing` import, add `from typing import Literal`.)

- [ ] **Step 2: Verify the file still imports cleanly**

Run: `uv run python -c "from hoga.api.models import BrokerSeriesPoint, BrokerSeriesEntry, BrokerSeriesResponse; print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add hoga/api/models.py
git commit -m "feat(api): add BrokerSeries wire models for day-trajectory endpoint"
```

---

## Task 2: `query_day_series` table function

**Files:**
- Modify: `hoga/tables/brokers.py`
- Modify: `tests/test_tables_brokers.py`

- [ ] **Step 1: Write failing tests for `query_day_series`**

Append to `tests/test_tables_brokers.py`:

```python
from hoga.api.models import BrokerSeriesEntry
from hoga.tables.brokers import query_day_series


def _broker_parts_named(
    ts_ms: int,
    seq: int,
    *,
    sell_names: list[str],
    sell_today: list[int],
    buy_names: list[str],
    buy_today: list[int],
) -> list[str]:
    """Variant of _broker_parts that lets a test seed specific broker names
    and qty_today values for each of the 5 sell / 5 buy slots."""
    assert len(sell_names) == 5 and len(sell_today) == 5
    assert len(buy_names) == 5 and len(buy_today) == 5
    deltas = ["0"] * 5
    trailing = ["0", "0", "1838", "1838", "1838", "1838"]
    return (
        ["2", "4", "0", str(seq), str(ts_ms), "32419919"]
        + sell_names
        + [str(q) for q in sell_today]
        + deltas
        + buy_names
        + [str(q) for q in buy_today]
        + deltas
        + trailing
    )


def test_query_day_series_orders_by_abs_final_net_desc(tmp_path: Path) -> None:
    """Top entry is the broker with the largest |final_net| at the last snapshot."""
    # Snapshot 1 (early in the day) and snapshot 2 (later — wins for final_net).
    early = PARSERS[4](
        _broker_parts_named(
            ts_ms=90019919,
            seq=912,
            sell_names=["미래에셋", "키움증권", "한국투자", "신한투자", "NH투자"],
            sell_today=[100, 100, 100, 100, 100],
            buy_names=["JP모간", "모건스탠", "신한투자", "한국투자", "KB증권"],
            buy_today=[100, 100, 100, 100, 100],
        )
    )
    late = PARSERS[4](
        _broker_parts_named(
            ts_ms=130000000,
            seq=913,
            sell_names=["KB증권", "미래에셋", "키움증권", "한국투자", "NH투자"],
            sell_today=[86579, 85356, 74253, 7452, 100],
            buy_names=["JP모간", "모건스탠", "신한투자", "한국투자", "KB증권"],
            buy_today=[79523, 77616, 59427, 0, 0],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(early + late, out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    # Top entry is KB증권 (|−86579 + 0| = 86579 dominates).
    assert isinstance(entries[0], BrokerSeriesEntry)
    assert entries[0].broker == "KB증권"
    assert entries[0].final_net == -86579
    assert entries[0].dominant_side == "sell"
    # JP모간 is the heaviest pure-buyer (+79523).
    jp = next(e for e in entries if e.broker == "JP모간")
    assert jp.final_net == 79523
    assert jp.dominant_side == "buy"


def test_query_day_series_preserves_observed_points_only_no_forward_fill(
    tmp_path: Path,
) -> None:
    """A broker present at t1 but absent at t2 has one point, not two."""
    early = PARSERS[4](
        _broker_parts_named(
            ts_ms=90000000,
            seq=1,
            sell_names=["A", "B", "C", "D", "E"],
            sell_today=[10, 10, 10, 10, 10],
            buy_names=["JP모간", "X", "Y", "Z", "W"],
            buy_today=[50, 10, 10, 10, 10],
        )
    )
    # JP모간 drops out of top-5 at the later snapshot — no row for it.
    late = PARSERS[4](
        _broker_parts_named(
            ts_ms=130000000,
            seq=2,
            sell_names=["A", "B", "C", "D", "E"],
            sell_today=[10, 10, 10, 10, 10],
            buy_names=["P", "Q", "R", "S", "T"],
            buy_today=[100, 100, 100, 100, 100],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(early + late, out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    jp = next(e for e in entries if e.broker == "JP모간")
    assert len(jp.points) == 1
    assert jp.points[0].ts_ms == 90000000
    assert jp.points[0].net == 50


def test_query_day_series_signs_dual_side_broker(tmp_path: Path) -> None:
    """A broker appearing on both sides at the same snapshot has net = buy − sell."""
    row = PARSERS[4](
        _broker_parts_named(
            ts_ms=90000000,
            seq=1,
            sell_names=["KB증권", "B", "C", "D", "E"],
            sell_today=[300, 10, 10, 10, 10],
            buy_names=["KB증권", "Q", "R", "S", "T"],
            buy_today=[100, 10, 10, 10, 10],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(row, out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    kb = next(e for e in entries if e.broker == "KB증권")
    assert len(kb.points) == 1
    assert kb.points[0].net == 100 - 300  # buy − sell = −200
    assert kb.final_net == -200
    assert kb.dominant_side == "sell"


def test_query_day_series_truncates_to_top_10(tmp_path: Path) -> None:
    """If more than 10 distinct brokers exist, only the top 10 by |final_net| ship."""
    # 5 sell brokers + 5 buy brokers per snapshot = 10 distinct. Use two snapshots
    # with fully disjoint buy lists to push the distinct count to 15.
    s1 = PARSERS[4](
        _broker_parts_named(
            ts_ms=90000000,
            seq=1,
            sell_names=["S1", "S2", "S3", "S4", "S5"],
            sell_today=[1, 2, 3, 4, 5],
            buy_names=["B1", "B2", "B3", "B4", "B5"],
            buy_today=[1000, 900, 800, 700, 600],
        )
    )
    s2 = PARSERS[4](
        _broker_parts_named(
            ts_ms=100000000,
            seq=2,
            sell_names=["S1", "S2", "S3", "S4", "S5"],
            sell_today=[1, 2, 3, 4, 5],
            buy_names=["B6", "B7", "B8", "B9", "B10"],  # 5 new brokers
            buy_today=[10, 9, 8, 7, 6],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(s1 + s2, out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    assert len(entries) == 10  # B6..B10 (small) cut off
    # First five are the big buyers.
    assert entries[0].broker == "B1"
    assert entries[0].final_net == 1000


def test_query_day_series_returns_empty_list_on_empty_parquet(tmp_path: Path) -> None:
    """No broker rows — empty list, not crash."""
    out = tmp_path / "brokers.parquet"
    # Write a zero-row parquet with the right schema.
    write_parquet([], out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    assert entries == []
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `uv run pytest tests/test_tables_brokers.py::test_query_day_series_orders_by_abs_final_net_desc -v`
Expected: `ImportError` or `AttributeError: module 'hoga.tables.brokers' has no attribute 'query_day_series'`

- [ ] **Step 3: Implement `query_day_series`**

Append to `hoga/tables/brokers.py` (after `query_at`):

```python
def query_day_series(
    con: duckdb.DuckDBPyConnection, *, path: Path
) -> list["BrokerSeriesEntry"]:
    """Per-broker signed-net trajectories for the whole parquet file.

    Aggregates qty_today * sign(side) per (broker, ts_ms) so a broker on
    both sides at the same snapshot collapses to one signed value, then
    groups in Python into one BrokerSeriesEntry per broker. Returns at most
    10 entries sorted by abs(final_net) desc, final_net desc.

    `points` contains only observed snapshots — no synthetic forward-fill
    for gaps when the broker fell out of both top-5 lists (the frontend
    renders such gaps with a dashed line; see ADR-0023).
    """
    from hoga.api.models import BrokerSeriesEntry, BrokerSeriesPoint  # local: avoid cycle

    rows = con.execute(
        """
        WITH per_snapshot AS (
            SELECT
                broker,
                ts_ms,
                SUM(CASE WHEN side = 'buy' THEN qty_today ELSE -qty_today END) AS net
            FROM read_parquet(?)
            GROUP BY broker, ts_ms
        )
        SELECT
            broker,
            ts_ms,
            net,
            LAST_VALUE(net) OVER (
                PARTITION BY broker
                ORDER BY ts_ms
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) AS final_net
        FROM per_snapshot
        ORDER BY broker, ts_ms
        """,
        [str(path)],
    ).fetchall()

    if not rows:
        return []

    # Group rows by broker (rows are already broker-major then ts-ascending).
    by_broker: dict[str, tuple[int, list[BrokerSeriesPoint]]] = {}
    for broker, ts_ms, net, final_net in rows:
        if broker not in by_broker:
            by_broker[broker] = (int(final_net), [])
        by_broker[broker][1].append(BrokerSeriesPoint(ts_ms=int(ts_ms), net=int(net)))

    entries = [
        BrokerSeriesEntry(
            broker=broker,
            final_net=final_net,
            dominant_side="buy" if final_net >= 0 else "sell",
            points=points,
        )
        for broker, (final_net, points) in by_broker.items()
    ]
    entries.sort(key=lambda e: (-abs(e.final_net), -e.final_net))
    return entries[:10]
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `uv run pytest tests/test_tables_brokers.py -v`
Expected: all tests pass (including the 5 new ones)

- [ ] **Step 5: Commit**

```bash
git add hoga/tables/brokers.py tests/test_tables_brokers.py
git commit -m "feat(brokers): query_day_series — per-broker signed-net trajectories"
```

---

## Task 3: `GET /api/brokers/series` route

**Files:**
- Modify: `hoga/api/routes.py`
- Create: `tests/test_api_brokers_series.py`

- [ ] **Step 1: Write failing route tests**

Create `tests/test_api_brokers_series.py`:

```python
"""Route tests for GET /api/brokers/series (ADR-0023, day-anchored 거래원 card)."""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_brokers_series_happy_path_returns_per_broker_trajectories(
    app_client: TestClient,
) -> None:
    """Tiny fixture (003490/20260519) has at least one broker snapshot —
    the response shape is well-formed and ordering invariant holds."""
    r = app_client.get("/api/brokers/series?code=003490&date=20260519")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["date"] == "20260519"
    assert isinstance(body["brokers"], list)
    # At most 10 entries.
    assert len(body["brokers"]) <= 10
    if body["brokers"]:
        first = body["brokers"][0]
        for key in ("broker", "final_net", "dominant_side", "points"):
            assert key in first
        assert first["dominant_side"] in ("buy", "sell")
        # Sorted by abs(final_net) desc.
        nets = [abs(e["final_net"]) for e in body["brokers"]]
        assert nets == sorted(nets, reverse=True)
        # Points are ts ascending and carry Unix-ms (per ADR-0003: ts >= 2020).
        for p in first["points"]:
            assert p["ts_ms"] >= 1_577_836_800_000  # 2020-01-01 UTC
        ts_list = [p["ts_ms"] for p in first["points"]]
        assert ts_list == sorted(ts_list)


def test_brokers_series_404_on_unknown_stock_date(app_client: TestClient) -> None:
    r = app_client.get("/api/brokers/series?code=999999&date=20990101")
    assert r.status_code == 404
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `uv run pytest tests/test_api_brokers_series.py -v`
Expected: 404 on route not registered (returns the FastAPI 404 with `{"detail":"Not Found"}`).

- [ ] **Step 3: Add the route handler**

In `hoga/api/routes.py`, update the imports near the top:

```python
from hoga.api.models import (
    BrokerSeriesResponse,  # NEW
    CandlesResponse,
    Meta,
    OrderbookResponse,
    RangeBundle,
    StockDate as StockDateModel,
    TradesResponse,
    validate_bucket_ms,
)
```

Then add the handler immediately after the existing `brokers(...)` handler:

```python
    @router.get("/brokers/series", response_model=BrokerSeriesResponse)
    def brokers_series(code: Code, date: StockDate) -> BrokerSeriesResponse:
        try:
            path = engine.parquet_dir(date, code) / "brokers.parquet"
        except StockDateNotFound as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        raw_entries = brokers_tbl.query_day_series(engine.conn, path=path)
        # Convert each point's ts_ms from HH:MM:SS.ms-encoded to Unix ms,
        # mirroring the /api/brokers and /api/candles handlers.
        entries = [
            e.model_copy(
                update={
                    "points": [
                        p.model_copy(
                            update={"ts_ms": hhmmssms_to_unix_ms(date, p.ts_ms)}
                        )
                        for p in e.points
                    ],
                }
            )
            for e in raw_entries
        ]
        return BrokerSeriesResponse(date=date, brokers=entries)
```

- [ ] **Step 4: Run the route tests**

Run: `uv run pytest tests/test_api_brokers_series.py -v`
Expected: both tests pass.

- [ ] **Step 5: Confirm no regression on existing route tests**

Run: `uv run pytest tests/test_api.py tests/test_api_range.py -v`
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add hoga/api/routes.py tests/test_api_brokers_series.py
git commit -m "feat(api): GET /api/brokers/series — day-anchored broker trajectories"
```

---

## Task 4: Mirror wire types on the frontend

**Files:**
- Modify: `frontend/src/api/types.ts`

- [ ] **Step 1: Append the new types per ADR-0004**

Open `frontend/src/api/types.ts` and append after the existing `BrokerEntry` block (around line 60, after the `qty_today` / `qty_delta` doc):

```ts
// === Broker Day-Trajectory (ADR-0023) ===
// Mirrors hoga/api/models.py::BrokerSeriesPoint / BrokerSeriesEntry / BrokerSeriesResponse
// verbatim per ADR-0004 (wire model no-adapter). `net` is already signed at the
// producer (buy = +, sell = −) — no client-side re-aggregation.

export type BrokerSeriesPoint = {
  ts_ms: number;   // Unix epoch ms per ADR-0003
  net: number;     // signed: SUM(qty_today * sign(side)) at this snapshot
};

export type BrokerSeriesEntry = {
  broker: string;
  final_net: number;
  dominant_side: 'buy' | 'sell';
  points: BrokerSeriesPoint[];   // ts_ms ascending; observed snapshots only
};

export type BrokerSeriesResponse = {
  date: string;                   // YYYYMMDD KST, echoed
  brokers: BrokerSeriesEntry[];   // sorted by abs(final_net) desc, ≤ 10 entries
};
```

- [ ] **Step 2: Verify the file compiles**

Run from `frontend/`: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/types.ts
git commit -m "feat(types): mirror BrokerSeries wire models on the frontend"
```

---

## Task 5: `useBrokerSeriesForDay` react-query hook

**Files:**
- Create: `frontend/src/api/brokerSeries.ts`
- Create: `frontend/src/api/brokerSeries.test.tsx`

- [ ] **Step 1: Write failing hook tests**

Create `frontend/src/api/brokerSeries.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import { useBrokerSeriesForDay } from './brokerSeries';
import * as client from './client';
import type { BrokerSeriesResponse } from './types';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const fakeResponse: BrokerSeriesResponse = {
  date: '20260519',
  brokers: [
    {
      broker: 'JP모간',
      final_net: 79523,
      dominant_side: 'buy',
      points: [{ ts_ms: 1747958400000, net: 79523 }],
    },
  ],
};

describe('useBrokerSeriesForDay', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('disabled when code is null', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useBrokerSeriesForDay(null, '20260519'),
      { wrapper: makeWrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('disabled when date is null', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useBrokerSeriesForDay('005930', null),
      { wrapper: makeWrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls /api/brokers/series with correct query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeResponse);
    const { result } = renderHook(
      () => useBrokerSeriesForDay('005930', '20260519'),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      '/api/brokers/series?code=005930&date=20260519',
    );
    expect(result.current.data).toEqual(fakeResponse);
  });

  it('does not refetch when re-rendered with the same (code, date)', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeResponse);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { rerender } = renderHook(
      () => useBrokerSeriesForDay('005930', '20260519'),
      { wrapper },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    rerender();
    expect(spy).toHaveBeenCalledTimes(1);   // staleTime: Infinity holds
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run from `frontend/`: `npx vitest run src/api/brokerSeries.test.tsx`
Expected: import error — `Cannot find module './brokerSeries'`.

- [ ] **Step 3: Create the hook**

Create `frontend/src/api/brokerSeries.ts`:

```ts
import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import type { BrokerSeriesResponse } from './types';

/**
 * Fetch the day-anchored broker trajectories for one Stock-Date (ADR-0023).
 *
 * Mirrors useRange's pattern: react-query, staleTime: Infinity (captured
 * Stock-Dates are immutable). Deliberately NOT useSpot — that hook is the
 * cursor-keyed, rapid-scrub debouncer used by 10호가 / 체결 cards. Day-scope
 * data lives next to useRange for visual clustering of the two day-scope
 * read paths in this directory.
 */
export function useBrokerSeriesForDay(
  code: string | null,
  date: string | null,
) {
  return useQuery({
    queryKey: ['brokers/series', code, date] as const,
    queryFn: () =>
      apiCall<BrokerSeriesResponse>(
        `/api/brokers/series?code=${code}&date=${date}`,
      ),
    enabled: code !== null && date !== null,
    staleTime: Infinity,
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run from `frontend/`: `npx vitest run src/api/brokerSeries.test.tsx`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/brokerSeries.ts frontend/src/api/brokerSeries.test.tsx
git commit -m "feat(api): useBrokerSeriesForDay — react-query hook for day-scope broker series"
```

---

## Task 6: `BrokerTrajectoryTable` component (sparkline + netAtCursor)

**Files:**
- Create: `frontend/src/sidebar/BrokerTrajectoryTable.tsx`
- Create: `frontend/src/sidebar/BrokerTrajectoryTable.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/sidebar/BrokerTrajectoryTable.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import BrokerTrajectoryTable, {
  netAtCursor,
  GAP_THRESHOLD_MS,
} from './BrokerTrajectoryTable';
import type { BrokerSeriesEntry } from '../api/types';

function entry(
  broker: string,
  points: { ts_ms: number; net: number }[],
  side: 'buy' | 'sell' = 'buy',
): BrokerSeriesEntry {
  const final_net = points.length ? points[points.length - 1].net : 0;
  return { broker, final_net, dominant_side: side, points };
}

describe('netAtCursor', () => {
  it('returns 0 when cursorMs is null', () => {
    const e = entry('A', [{ ts_ms: 100, net: 5 }]);
    expect(netAtCursor(e, null)).toBe(0);
  });

  it('returns 0 when cursor precedes broker first observation', () => {
    const e = entry('A', [{ ts_ms: 200, net: 5 }]);
    expect(netAtCursor(e, 100)).toBe(0);
  });

  it('returns the net of the last point at-or-before cursor', () => {
    const e = entry('A', [
      { ts_ms: 100, net: 5 },
      { ts_ms: 200, net: 10 },
      { ts_ms: 300, net: 15 },
    ]);
    expect(netAtCursor(e, 250)).toBe(10);
    expect(netAtCursor(e, 300)).toBe(15);
    expect(netAtCursor(e, 999)).toBe(15);
  });

  it('returns the exact point net when cursor lands on a ts', () => {
    const e = entry('A', [
      { ts_ms: 100, net: 5 },
      { ts_ms: 200, net: 10 },
    ]);
    expect(netAtCursor(e, 100)).toBe(5);
    expect(netAtCursor(e, 200)).toBe(10);
  });

  it('handles single-point series', () => {
    const e = entry('A', [{ ts_ms: 100, net: 5 }]);
    expect(netAtCursor(e, 50)).toBe(0);
    expect(netAtCursor(e, 100)).toBe(5);
    expect(netAtCursor(e, 200)).toBe(5);
  });
});

describe('BrokerTrajectoryTable — render states', () => {
  it('shows loading text when series is undefined', () => {
    render(<BrokerTrajectoryTable series={undefined} cursorMs={null} />);
    expect(screen.getByText(/커서 위치 로딩 중/)).toBeInTheDocument();
  });

  it('shows empty text when series is null', () => {
    render(<BrokerTrajectoryTable series={null} cursorMs={null} />);
    expect(screen.getByText(/거래원 정보 없음/)).toBeInTheDocument();
  });

  it('shows empty text when series is []', () => {
    render(<BrokerTrajectoryTable series={[]} cursorMs={null} />);
    expect(screen.getByText(/거래원 정보 없음/)).toBeInTheDocument();
  });

  it('renders one row per broker (capped at 10)', () => {
    const series: BrokerSeriesEntry[] = Array.from({ length: 12 }, (_, i) =>
      entry(`B${i}`, [{ ts_ms: 100 + i, net: 100 - i }]),
    );
    render(<BrokerTrajectoryTable series={series} cursorMs={null} />);
    expect(screen.getAllByTestId('broker-row')).toHaveLength(10);
  });
});

describe('BrokerTrajectoryTable — sparkline', () => {
  it('renders a dashed polyline when a gap exceeds GAP_THRESHOLD_MS', () => {
    const big_gap = GAP_THRESHOLD_MS + 1;
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 0, net: 10 },
        { ts_ms: big_gap, net: 50 },     // gap → dashed
        { ts_ms: big_gap + 1_000, net: 60 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={null} />,
    );
    const dashed = container.querySelectorAll('polyline[stroke-dasharray]');
    expect(dashed.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT render the cursor marker when cursorMs lies outside the day range', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={500} />,    // before tsFirst
    );
    const cursorLines = container.querySelectorAll('[data-testid="cursor-marker"]');
    expect(cursorLines.length).toBe(0);
  });

  it('renders the cursor marker when cursorMs is inside the day range', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} />,
    );
    const cursorLines = container.querySelectorAll('[data-testid="cursor-marker"]');
    expect(cursorLines.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run from `frontend/`: `npx vitest run src/sidebar/BrokerTrajectoryTable.test.tsx`
Expected: import error — `Cannot find module './BrokerTrajectoryTable'`.

- [ ] **Step 3: Create the component**

Create `frontend/src/sidebar/BrokerTrajectoryTable.tsx`:

```tsx
import { useMemo } from 'react';
import type { BrokerSeriesEntry, BrokerSeriesPoint } from '../api/types';

/** Gap detection threshold (ms). Consecutive points farther apart are
 *  rendered with a dashed segment indicating the broker was outside top-5
 *  between observations. Honest about the brokers parquet's top-5 truncation
 *  rather than forward-fill (see ADR-0023 and the spec's § 4 Data Gaps). */
export const GAP_THRESHOLD_MS = 30_000;

type Props = {
  series: BrokerSeriesEntry[] | null | undefined;
  cursorMs: number | null;
};

export default function BrokerTrajectoryTable({ series, cursorMs }: Props) {
  // Common time domain across all displayed brokers — keeps cursor marker
  // X positions aligned across rows.
  const dayRange = useMemo(() => {
    if (!series || series.length === 0) return null;
    let first = Infinity;
    let last = -Infinity;
    for (const e of series) {
      for (const p of e.points) {
        if (p.ts_ms < first) first = p.ts_ms;
        if (p.ts_ms > last) last = p.ts_ms;
      }
    }
    return Number.isFinite(first) && Number.isFinite(last) && last > first
      ? { first, last }
      : null;
  }, [series]);

  if (series === undefined) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        커서 위치 로딩 중…
      </div>
    );
  }
  if (series === null || series.length === 0) {
    return (
      <div className="grid place-items-center h-full text-fg-dimmer text-xs">
        거래원 정보 없음
      </div>
    );
  }

  const rows = series.slice(0, 10);
  return (
    <div className="font-mono text-sm tabular-nums">
      {rows.map((entry) => {
        const net = netAtCursor(entry, cursorMs);
        return (
          <div
            key={entry.broker}
            data-testid="broker-row"
            className="grid grid-cols-[60px_1fr_80px] gap-2 px-2.5 py-0.5 items-center"
          >
            <span className="truncate">{trunc(entry.broker)}</span>
            <Sparkline entry={entry} cursorMs={cursorMs} dayRange={dayRange} />
            <span
              className={
                net > 0
                  ? 'text-price-up text-right'
                  : net < 0
                    ? 'text-price-down text-right'
                    : 'text-fg-dimmer text-right'
              }
            >
              {net > 0 ? '+' : ''}
              {net.toLocaleString('ko-KR')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function trunc(name: string): string {
  // Korean broker names are typically already short. Cap at 4 characters
  // (carry-over from the prior BrokerNetTable convention).
  return name.length > 4 ? name.slice(0, 4) : name;
}

/** Pure function. Binary-searches entry.points for the last ts <= cursorMs.
 *  Returns 0 when cursorMs is null or precedes the broker's first observation. */
export function netAtCursor(
  entry: BrokerSeriesEntry,
  cursorMs: number | null,
): number {
  if (cursorMs == null) return 0;
  const pts = entry.points;
  if (pts.length === 0 || cursorMs < pts[0].ts_ms) return 0;
  // Binary search for the rightmost point with ts_ms <= cursorMs.
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].ts_ms <= cursorMs) lo = mid;
    else hi = mid - 1;
  }
  return pts[lo].net;
}

function Sparkline({
  entry,
  cursorMs,
  dayRange,
}: {
  entry: BrokerSeriesEntry;
  cursorMs: number | null;
  dayRange: { first: number; last: number } | null;
}) {
  // Width/height in viewBox units — preserveAspectRatio="none" lets CSS scale.
  const W = 60;
  const H = 16;

  const pts = entry.points;
  if (pts.length === 0 || !dayRange) {
    return <span className="block w-full h-4" />;
  }

  const { first: tsFirst, last: tsLast } = dayRange;
  const tSpan = tsLast - tsFirst || 1;

  // Per-row Y domain: include 0 so the line stays visible whether the
  // trajectory is purely positive (buyer), purely negative (seller), or
  // straddles zero (rare mixed-side broker).
  let netMin = 0;
  let netMax = 0;
  for (const p of pts) {
    if (p.net < netMin) netMin = p.net;
    if (p.net > netMax) netMax = p.net;
  }
  const nSpan = netMax - netMin || 1;

  const toX = (t: number) => ((t - tsFirst) / tSpan) * W;
  const toY = (n: number) => H - ((n - netMin) / nSpan) * H;

  const stroke =
    entry.dominant_side === 'buy' ? 'var(--price-up)' : 'var(--price-down)';

  // Split the polyline into solid vs dashed segments based on
  // GAP_THRESHOLD_MS. We emit one <polyline> per contiguous run, with
  // dashed runs styled differently. A "run" is a sequence of consecutive
  // points joined by gaps <= threshold.
  const segments = buildSegments(pts, GAP_THRESHOLD_MS);

  // Cursor marker: only visible when cursorMs is inside the day's range.
  const showCursor =
    cursorMs != null && cursorMs >= tsFirst && cursorMs <= tsLast;
  const cursorX = showCursor ? ((cursorMs! - tsFirst) / tSpan) * W : 0;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-4 block"
    >
      {segments.map((seg, i) => {
        const points = seg.pts.map((p) => `${toX(p.ts_ms)},${toY(p.net)}`).join(' ');
        if (seg.kind === 'solid') {
          return (
            <polyline
              key={`s${i}`}
              fill="none"
              stroke={stroke}
              strokeWidth={1.2}
              points={points}
            />
          );
        }
        return (
          <polyline
            key={`d${i}`}
            fill="none"
            stroke={stroke}
            strokeWidth={1.2}
            strokeDasharray="1.5,1.5"
            opacity={0.4}
            points={points}
          />
        );
      })}
      {showCursor && (
        <line
          data-testid="cursor-marker"
          x1={cursorX}
          x2={cursorX}
          y1={0}
          y2={H}
          stroke="var(--accent)"
          strokeWidth={0.6}
          strokeDasharray="1,1"
        />
      )}
    </svg>
  );
}

type Segment =
  | { kind: 'solid'; pts: BrokerSeriesPoint[] }
  | { kind: 'dashed'; pts: BrokerSeriesPoint[] };   // always exactly 2 points

/** Split consecutive points into solid runs and 2-point dashed bridges.
 *  A gap > threshold between p[i] and p[i+1] flushes the current solid run
 *  (if non-empty) and emits a 2-point dashed segment from p[i] to p[i+1];
 *  the next solid run starts at p[i+1]. */
function buildSegments(
  pts: BrokerSeriesPoint[],
  thresholdMs: number,
): Segment[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) return [{ kind: 'solid', pts: [pts[0]] }];

  const out: Segment[] = [];
  let run: BrokerSeriesPoint[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].ts_ms - pts[i - 1].ts_ms;
    if (gap <= thresholdMs) {
      run.push(pts[i]);
    } else {
      // Flush current solid run.
      if (run.length >= 1) out.push({ kind: 'solid', pts: run });
      // Dashed bridge from last-of-run to pts[i].
      out.push({ kind: 'dashed', pts: [pts[i - 1], pts[i]] });
      // New solid run begins at pts[i].
      run = [pts[i]];
    }
  }
  if (run.length >= 1) out.push({ kind: 'solid', pts: run });
  return out;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run from `frontend/`: `npx vitest run src/sidebar/BrokerTrajectoryTable.test.tsx`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/sidebar/BrokerTrajectoryTable.tsx frontend/src/sidebar/BrokerTrajectoryTable.test.tsx
git commit -m "feat(sidebar): BrokerTrajectoryTable with sparklines + netAtCursor"
```

---

## Task 7: Wire the new component into `CursorSidebar`, change grid, delete old file

**Files:**
- Modify: `frontend/src/sidebar/CursorSidebar.tsx`
- Delete: `frontend/src/sidebar/BrokerNetTable.tsx`

- [ ] **Step 1: Replace imports + connected component + grid in `CursorSidebar.tsx`**

Open `frontend/src/sidebar/CursorSidebar.tsx`. Replace its current contents with:

```tsx
import { type ReactNode } from 'react';
import OrderbookTable from './OrderbookTable';
import BrokerTrajectoryTable from './BrokerTrajectoryTable';
import FillTape from './FillTape';
import TotalQtyBar from './TotalQtyBar';
import {
  useOrderbookAtCursor,
  useCursor,
  useTradesAroundCursor,
} from '../api/useCursor';
import { useBrokerSeriesForDay } from '../api/brokerSeries';
import { useAuctionMaskActive } from '../state/useAuctionMaskActive';
import type { VirtualAxis } from '../util/virtualAxis';

type Props = {
  orderbook?: ReactNode;
  brokers?: ReactNode;
  fills?: ReactNode;
};

/**
 * Connected variant that pulls live cursor-keyed data for 10호가 / 체결 and
 * day-anchored data for 거래원 (ADR-0023). The 거래원 card's identity is
 * stable across the Stock-Date; cursorMs drives only the per-row net value
 * and the sparkline cursor marker.
 */
export function CursorSidebarConnected({ axis }: { axis: VirtualAxis }) {
  const orderbook = useOrderbookAtCursor();
  const { code, date, cursorMs } = useCursor();
  const { data, isLoading } = useBrokerSeriesForDay(code, date);
  // undefined = loading, null = fetched-empty, value = data. Matches the
  // useSpot contract that OrderbookTable and FillTape consume so the three
  // cards present consistent loading/empty states.
  const series = isLoading ? undefined : (data?.brokers ?? null);
  const trades = useTradesAroundCursor();
  const maskRatio = useAuctionMaskActive(axis);

  return (
    <CursorSidebar
      orderbook={
        <>
          <OrderbookTable snapshot={orderbook} />
          <TotalQtyBar snapshot={orderbook} maskRatio={maskRatio} />
        </>
      }
      brokers={<BrokerTrajectoryTable series={series} cursorMs={cursorMs} />}
      fills={<FillTape trades={trades} />}
    />
  );
}

export default function CursorSidebar({ orderbook, brokers, fills }: Props) {
  return (
    <aside className="grid grid-rows-[2fr_1.4fr_1fr] gap-2 p-2 bg-bg w-sidebar h-full min-h-0">
      <SidebarCard label="10호가" testId="card-orderbook">
        {orderbook ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="거래원" testId="card-brokers">
        {brokers ?? <Placeholder />}
      </SidebarCard>
      <SidebarCard label="체결" testId="card-fills">
        {fills ?? <Placeholder />}
      </SidebarCard>
    </aside>
  );
}

function SidebarCard({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      data-card={testId.replace(/^card-/, '')}
      className="flex flex-col min-h-0 bg-bg-card border rounded overflow-hidden"
    >
      <header className="px-3 py-2 border-b text-xs font-semibold uppercase tracking-wider text-fg-dimmer">
        {label}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

function Placeholder() {
  return <div className="grid place-items-center h-full text-fg-dimmer text-xs">—</div>;
}
```

- [ ] **Step 2: Delete the obsolete BrokerNetTable file**

Run: `git rm frontend/src/sidebar/BrokerNetTable.tsx`
Expected: file is removed.

Confirm no other source file imports it:
Run: `grep -rn "BrokerNetTable" frontend/src 2>/dev/null`
Expected: no matches (the only remaining reference is the stale comment in `frontend/src/api/types.ts:52` describing the legacy aggregation — leave that comment for now; it documents historical context. If your `grep` flags it, that's expected.)

- [ ] **Step 3: TypeScript check**

Run from `frontend/`: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run all frontend tests**

Run from `frontend/`: `npx vitest run`
Expected: all tests pass. (No `BrokerNetTable.test.tsx` exists in the current tree — verified before plan creation — so no test deletion is needed.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/sidebar/CursorSidebar.tsx frontend/src/sidebar/BrokerNetTable.tsx
git commit -m "feat(sidebar): wire day-anchored 거래원 card; drop BrokerNetTable; grid 2fr/1.4fr/1fr"
```

---

## Task 8: Visual verification via the `browse` skill

**Files:** none (verification only — no commit).

- [ ] **Step 1: Start dev servers**

If not already running, start the backend and frontend dev servers per `CLAUDE.md`:

Backend (background):
```bash
uv run uvicorn hoga.api.app:default_app \
  --factory --host 127.0.0.1 --port 8000 \
  --reload --reload-dir hoga
```

Frontend (background, from `frontend/`):
```bash
npm run dev
```

Verify backend is up: `curl -s http://127.0.0.1:8000/api/events`
Expected: SSE stream opens (Ctrl-C to exit). If you get a connection refused, check the backend terminal for KRX cred or other init errors.

- [ ] **Step 2: Open the replay viewer and load a populated symbol**

Use the `browse` skill (or open manually):

```
browse navigate http://localhost:5173/replay
```

Select a captured symbol with a multi-day range that includes a heavy-broker day (e.g., 005930 / 삼성전자 for any captured weekday with healthy volume). If no captured data exists locally, capture one day first via the Capture page or skip this verification and accept the test coverage.

- [ ] **Step 3: Verify list stability across cursor sweep**

Sweep the cursor across the chart with arrow keys or mouse drag. The 거래원 card's row identities (broker names) must stay constant — only the right-column net values and the sparkline cursor marker positions should change.

Take a screenshot before and after a cursor sweep:
```
browse screenshot --name brokers-cursor-left
# ... move cursor ...
browse screenshot --name brokers-cursor-right
```

Expected: the broker name column is identical between the two screenshots.

- [ ] **Step 4: Verify dashed segments appear for brokers with mid-day dropouts**

Some sparklines should visibly contain dashed segments (lighter, dotted) where the broker fell out of top-5. Take a screenshot showing this:

```
browse screenshot --name brokers-dashed-segments
```

Expected: at least one row's sparkline shows a dashed portion. If every row is fully solid, the symbol/day has unusually stable top-5 dominance — pick another day or accept the empirical result.

- [ ] **Step 5: Verify cursor crosses day boundary swaps the series**

If a multi-day Stock-Date Range is loaded, move the cursor across a day boundary. The broker list should swap entirely (different brokers may appear; the sparklines reset to the new day's domain). The 10호가 and 체결 cards should also update normally.

- [ ] **Step 6: Verify no regression on 10호가 and 체결**

The orderbook (10호가) and fills (체결) cards should behave exactly as before — cursor-keyed, updating immediately with each cursor move. Take a final screenshot:

```
browse screenshot --name sidebar-three-cards
```

- [ ] **Step 7: Record verification notes (no commit)**

Leave a one-line note in the dispatching agent's reply summarizing the visual check outcome. No commit needed for this task — it is an empirical confidence step.

---

## Self-Review (final)

Run through the spec sections against the plan:

| Spec section | Covered by |
|---|---|
| § 1 Data shape — wire models | Task 1 |
| § 1 Backend implementation — `query_day_series` | Task 2 |
| § 1 Route handler | Task 3 |
| § 2 Frontend hook (react-query, not useSpot) | Task 5 |
| § 3 Broker list synthesis (`netAtCursor`, top 10) | Task 6 (exported `netAtCursor`, top-10 truncation in component) |
| § 4 Sparkline rendering (60×16, per-row Y, common time, dashed gaps, cursor marker) | Task 6 |
| § 5 Component changes (rename, hook swap) | Tasks 6 + 7 |
| § 6 Sidebar grid (2fr/1.4fr/1fr) | Task 7 |
| Testing — backend table unit | Task 2 |
| Testing — backend route | Task 3 |
| Testing — frontend hook | Task 5 |
| Testing — frontend component | Task 6 |
| Testing — visual via browse | Task 8 |
| Risk: `useBrokersAtCursor` removal not enforced | Acknowledged in spec; cleanup left for follow-up (consistent with plan's Task 7 grep note) |
| Risk: dashed false signal on illiquid days | Visual check in Task 8 surfaces if pathological |

Type consistency: `BrokerSeriesEntry`, `BrokerSeriesPoint`, `BrokerSeriesResponse` are used identically across Tasks 1, 4, 5, 6, 7. `netAtCursor` and `GAP_THRESHOLD_MS` are defined and exported once in Task 6 and referenced in Task 6's tests only. No floating placeholders.

---

## Execution Handoff

User has pre-authorized **subagent-driven-development** (per the original chained-skills directive). After plan approval (auto via user delegation), proceed to `/superpowers:subagent-driven-development`.
