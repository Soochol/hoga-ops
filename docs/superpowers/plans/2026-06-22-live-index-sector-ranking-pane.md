# Live Index Sector Ranking Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an index-only lower `/live` pane that ranks current Heatmap sectors and the selected sector's stocks by daily change percentage for the hovered or pinned index candle date.

**Architecture:** The backend owns date-keyed ranking computation from the current Heatmap document plus the Screener EOD `daily_adjusted.parquet` corpus. The frontend fetches one server-side ranking payload per KST basis date, then locally owns date pinning, sector hover preview, sector pinning, and stock row navigation. The pane is a DOM sibling below the index chart inside `LiveWorkarea`, not a Lightweight Charts pane.

**Tech Stack:** FastAPI, Pydantic v2, Polars/DuckDB-backed parquet corpus, React 18, TypeScript, TanStack Query v5, Zustand, Vitest, React Testing Library, Pytest.

## Global Constraints

- Scope: `/live` index instruments only.
- The pane is hidden for stock instruments.
- The pane is part of the chart workarea, not the existing right sidebar.
- The pane must be implemented as a DOM sibling below the index chart region inside the `/live` workarea, not as a Lightweight Charts pane or `RangeSeriesPane` indicator.
- MVP universe is the current heatmap entries, not the full market.
- Historical ranking is interpreted as "how the currently configured heatmap sectors performed on this date."
- The feature does not reconstruct heatmap membership that existed on the historical date.
- Historical basis dates must not silently use latest live quotes.
- Historical rankings should be computed from the existing Screener EOD daily corpus (`daily_adjusted.parquet`) by comparing the selected date's adjusted close with each code's previous available adjusted close.
- If no honest date-aware daily source is available, the pane must be disabled for historical dates with an explicit "daily ranking unavailable" state.
- `/api/live/quotes` may be used only when the basis is the latest available trading date.
- The frontend must not issue one `/api/live/past-daily-candles` request per heatmap code on hover.
- Hover should refetch only when the resolved KST basis date changes, not on every pointer movement.
- Enable for index `D` and minute LiveTimeframes.
- For minute candles, multiple candles from the same trading date resolve to the same ranking data.
- For `W` and `M`, hide or disable the pane in MVP.
- Sector ranking is sorted by average change percentage descending.
- Stock ranking is sorted by `change_pct` descending.
- Stocks and sectors with missing values appear at the bottom.
- Sector and stock change values use KRX price colors.
- The active sector row uses UI accent selection state, not price color.
- Clicking a stock opens that stock in `/live` using existing live tab activation behavior.
- Do not couple heatmap edits to watchlist or live subscription side effects.
- Out of scope: secondary stock sort controls, editing heatmap folders from the pane, adding the pane to stock charts, changing heatmap storage, replacing the candle tooltip, weekly/monthly sector period-return rankings.

---

## File Structure

### Backend

- Create `hoga/live/index_sector_rankings.py`
  - Pure ranking service and Pydantic response models.
  - Reads `hoga.api.heatmap.load_document(data_dir)`.
  - Reads `data_dir / "screener" / "daily_adjusted.parquet"`.
  - Computes per-code daily `change_pct` from selected adjusted close vs previous available adjusted close.
  - Computes sector averages and sorted sector/stock rankings.
  - Contains no KIS calls, no Watchlist calls, and no live stream side effects.

- Modify `hoga/live/api.py`
  - Add `GET /api/live/index-sector-rankings?date=YYYYMMDD`.
  - Validate `date` with the existing `_parse_yyyymmdd` and future-date policy.
  - Delegate to `build_index_sector_rankings`.

- Create `tests/unit/live/test_index_sector_rankings.py`
  - Unit tests for pure ranking behavior.

- Create `tests/api/test_index_sector_rankings_route.py`
  - Route tests for validation and wire payload.

### Frontend Data And State

- Create `frontend/src/api/indexSectorRankings.ts`
  - Typed TanStack Query hook for `/api/live/index-sector-rankings`.
  - Query key includes only the basis date and not pointer coordinates.

- Create `frontend/src/api/indexSectorRankings.test.tsx`
  - Hook tests for endpoint path, disabled state, and placeholder behavior.

- Create `frontend/src/live/indexSectorRankingState.ts`
  - Pure reducer/helpers for hover date, pinned date, latest fallback, sector preview, and sector pin.

- Create `frontend/src/live/indexSectorRankingState.test.ts`
  - Unit tests for date pinning, sector hover preview, sector click toggle, fallback to rank 1.

### Frontend UI And Integration

- Create `frontend/src/live/IndexSectorRankingPane.tsx`
  - Lower split pane component.
  - Header basis text and unpin control.
  - Left sector ranking list.
  - Right stock ranking list for previewed/pinned/default sector.
  - Empty, unavailable, loading, and error states.

- Create `frontend/src/live/IndexSectorRankingPane.test.tsx`
  - Component tests for rendering, sorting, preview, pin/unpin, stock click.

- Modify `frontend/src/live/LiveChartRoot.tsx`
  - Add optional callbacks for candle basis hover and click.
  - Publish KST `YYYYMMDD` basis date from existing crosshair conversion.
  - Subscribe to chart click and emit date pin events.

- Modify `frontend/src/live/LiveWorkarea.tsx`
  - Accept `activeInstrument`.
  - For index `D` and minute timeframes, render chart and `IndexSectorRankingPane` in a vertical workarea column.
  - Keep stock layout unchanged.
  - Keep `W`/`M` index pane hidden or disabled.

- Modify `frontend/src/live/LivePage.tsx`
  - Pass `activeInstrument` into `LiveWorkarea`.
  - Use existing `useJumpToLive()` flow for stock row navigation from the pane.

- Update `frontend/src/live/LiveWorkarea.test.tsx` and `frontend/src/live/LiveChartRoot.test.tsx`
  - Cover index pane gating and candle basis callbacks.

---

### Task 1: Backend Pure Ranking Service

**Files:**
- Create: `hoga/live/index_sector_rankings.py`
- Create: `tests/unit/live/test_index_sector_rankings.py`

**Interfaces:**
- Consumes:
  - `hoga.api.heatmap.load_document(data_dir: Path) -> HeatmapDocument`
  - Screener corpus at `data_dir / "screener" / "daily_adjusted.parquet"`
- Produces:
  - `class IndexSectorStock(BaseModel)`
  - `class IndexSectorGroup(BaseModel)`
  - `class IndexSectorRankingResponse(BaseModel)`
  - `def build_index_sector_rankings(data_dir: Path, basis_date: str) -> IndexSectorRankingResponse`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/live/test_index_sector_rankings.py`:

```python
from __future__ import annotations

import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.heatmap import save_document
from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder
from hoga.live.index_sector_rankings import build_index_sector_rankings


def _seed_heatmap(tmp_path: Path) -> None:
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[
                WatchlistFolder(id="semi", name="반도체", order=0),
                WatchlistFolder(id="bio", name="바이오", order=1),
            ],
            entries=[
                HeatmapEntry(code="005930", name="삼성전자", folder_id="semi", order=0),
                HeatmapEntry(code="000660", name="SK하이닉스", folder_id="semi", order=1),
                HeatmapEntry(code="068270", name="셀트리온", folder_id="bio", order=0),
                HeatmapEntry(code="999999", name="없는종목", folder_id="bio", order=1),
            ],
        ),
    )


def _seed_daily(tmp_path: Path) -> None:
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame(
        {
            "code": ["005930", "005930", "000660", "000660", "068270", "068270"],
            "date": [
                dt.date(2026, 6, 18),
                dt.date(2026, 6, 19),
                dt.date(2026, 6, 18),
                dt.date(2026, 6, 19),
                dt.date(2026, 6, 18),
                dt.date(2026, 6, 19),
            ],
            "open": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "high": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "low": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "close": [100.0, 110.0, 200.0, 210.0, 100.0, 98.0],
            "volume": [1, 1, 1, 1, 1, 1],
        },
    ).write_parquet(sdir / "daily_adjusted.parquet")


def test_build_index_sector_rankings_sorts_sectors_and_stocks(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)
    _seed_daily(tmp_path)

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert result.date == "20260619"
    assert result.source == "daily_adjusted"
    assert result.unavailable_reason is None
    assert [s.folder_id for s in result.sectors] == ["semi", "bio"]
    assert result.sectors[0].change_pct == 7.5
    assert [s.code for s in result.sectors[0].stocks] == ["005930", "000660"]
    assert result.sectors[0].stocks[0].change_pct == 10.0
    assert result.sectors[0].stocks[1].change_pct == 5.0
    assert result.sectors[1].change_pct == -2.0
    assert result.sectors[1].stocks[-1].code == "999999"
    assert result.sectors[1].stocks[-1].change_pct is None
    assert result.sectors[1].stocks[-1].missing_reason == "no_basis_bar"


def test_build_index_sector_rankings_uses_current_heatmap_membership(tmp_path: Path) -> None:
    _seed_daily(tmp_path)
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder(id="moved", name="이동후", order=0)],
            entries=[HeatmapEntry(code="005930", name="삼성전자", folder_id="moved", order=0)],
        ),
    )

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert [s.folder_id for s in result.sectors] == ["moved"]
    assert result.sectors[0].folder_name == "이동후"
    assert [s.code for s in result.sectors[0].stocks] == ["005930"]


def test_build_index_sector_rankings_reports_unavailable_when_corpus_missing(tmp_path: Path) -> None:
    _seed_heatmap(tmp_path)

    result = build_index_sector_rankings(tmp_path, "20260619")

    assert result.source == "unavailable"
    assert result.unavailable_reason == "screener_daily_corpus_missing"
    assert result.sectors == []


def test_build_index_sector_rankings_marks_missing_previous_close(tmp_path: Path) -> None:
    save_document(
        tmp_path,
        HeatmapDocument(
            folders=[WatchlistFolder(id="solo", name="단일", order=0)],
            entries=[HeatmapEntry(code="005930", name="삼성전자", folder_id="solo", order=0)],
        ),
    )
    sdir = tmp_path / "screener"
    sdir.mkdir()
    pl.DataFrame(
        {
            "code": ["005930"],
            "date": [dt.date(2026, 6, 19)],
            "open": [0.0],
            "high": [0.0],
            "low": [0.0],
            "close": [110.0],
            "volume": [1],
        },
    ).write_parquet(sdir / "daily_adjusted.parquet")

    result = build_index_sector_rankings(tmp_path, "20260619")

    stock = result.sectors[0].stocks[0]
    assert stock.change_pct is None
    assert stock.missing_reason == "no_previous_close"
    assert result.sectors[0].change_pct is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
python -m pytest tests/unit/live/test_index_sector_rankings.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.live.index_sector_rankings'`.

- [ ] **Step 3: Implement the ranking service**

Create `hoga/live/index_sector_rankings.py`:

```python
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Literal

import polars as pl
from pydantic import BaseModel

from hoga.api.heatmap import load_document
from hoga.api.models import HeatmapEntry

RankingSource = Literal["daily_adjusted", "unavailable"]
MissingReason = Literal["no_basis_bar", "no_previous_close"]


class IndexSectorStock(BaseModel):
    code: str
    name: str
    folder_id: str | None
    folder_name: str
    order: int
    close: float | None
    previous_close: float | None
    change_pct: float | None
    missing_reason: MissingReason | None = None


class IndexSectorGroup(BaseModel):
    folder_id: str | None
    folder_name: str
    order: int
    change_pct: float | None
    finite_count: int
    total_count: int
    stocks: list[IndexSectorStock]


class IndexSectorRankingResponse(BaseModel):
    date: str
    source: RankingSource
    unavailable_reason: Literal["screener_daily_corpus_missing"] | None = None
    sectors: list[IndexSectorGroup]


def _parse_basis_date(value: str) -> dt.date:
    return dt.datetime.strptime(value, "%Y%m%d").date()


def _round_pct(value: float) -> float:
    return round(value, 4)


def _entry_groups(
    entries: list[HeatmapEntry],
    folder_names: dict[str, str],
    folder_orders: dict[str, int],
) -> list[tuple[str | None, str, int, list[HeatmapEntry]]]:
    grouped: dict[str | None, list[HeatmapEntry]] = {}
    for entry in entries:
        grouped.setdefault(entry.folder_id, []).append(entry)
    rows: list[tuple[str | None, str, int, list[HeatmapEntry]]] = []
    for folder_id, group_entries in grouped.items():
        name = folder_names.get(folder_id or "", "미분류") if folder_id is not None else "미분류"
        order = folder_orders.get(folder_id or "", 1_000_000)
        rows.append((folder_id, name, order, sorted(group_entries, key=lambda e: (e.order, e.code))))
    return sorted(rows, key=lambda row: (row[2], row[1]))


def _load_daily_rows(path: Path, codes: list[str], basis: dt.date) -> dict[str, list[dict]]:
    if not codes:
        return {}
    df = (
        pl.scan_parquet(path)
        .filter(pl.col("code").is_in(codes))
        .filter(pl.col("date") <= basis)
        .select(["code", "date", "close"])
        .collect()
        .sort(["code", "date"])
    )
    by_code: dict[str, list[dict]] = {}
    for row in df.iter_rows(named=True):
        by_code.setdefault(str(row["code"]), []).append(row)
    return by_code


def _stock_from_entry(
    entry: HeatmapEntry,
    *,
    folder_name: str,
    basis: dt.date,
    rows: list[dict],
) -> IndexSectorStock:
    basis_row = next((row for row in reversed(rows) if row["date"] == basis), None)
    if basis_row is None:
        return IndexSectorStock(
            code=entry.code,
            name=entry.name,
            folder_id=entry.folder_id,
            folder_name=folder_name,
            order=entry.order,
            close=None,
            previous_close=None,
            change_pct=None,
            missing_reason="no_basis_bar",
        )
    previous_row = next((row for row in reversed(rows) if row["date"] < basis), None)
    close = float(basis_row["close"])
    if previous_row is None or float(previous_row["close"]) == 0:
        return IndexSectorStock(
            code=entry.code,
            name=entry.name,
            folder_id=entry.folder_id,
            folder_name=folder_name,
            order=entry.order,
            close=close,
            previous_close=None,
            change_pct=None,
            missing_reason="no_previous_close",
        )
    previous_close = float(previous_row["close"])
    change_pct = _round_pct((close / previous_close - 1.0) * 100.0)
    return IndexSectorStock(
        code=entry.code,
        name=entry.name,
        folder_id=entry.folder_id,
        folder_name=folder_name,
        order=entry.order,
        close=close,
        previous_close=previous_close,
        change_pct=change_pct,
    )


def _sort_stocks(stocks: list[IndexSectorStock]) -> list[IndexSectorStock]:
    return sorted(
        stocks,
        key=lambda stock: (
            stock.change_pct is None,
            -(stock.change_pct or 0.0),
            stock.order,
            stock.code,
        ),
    )


def _sector_average(stocks: list[IndexSectorStock]) -> tuple[float | None, int]:
    values = [stock.change_pct for stock in stocks if stock.change_pct is not None]
    if not values:
        return None, 0
    return _round_pct(sum(values) / len(values)), len(values)


def _sort_sectors(sectors: list[IndexSectorGroup]) -> list[IndexSectorGroup]:
    return sorted(
        sectors,
        key=lambda sector: (
            sector.change_pct is None,
            -(sector.change_pct or 0.0),
            sector.order,
            sector.folder_name,
        ),
    )


def build_index_sector_rankings(data_dir: Path, basis_date: str) -> IndexSectorRankingResponse:
    basis = _parse_basis_date(basis_date)
    doc = load_document(data_dir)
    corpus_path = data_dir / "screener" / "daily_adjusted.parquet"
    if not corpus_path.exists():
        return IndexSectorRankingResponse(
            date=basis_date,
            source="unavailable",
            unavailable_reason="screener_daily_corpus_missing",
            sectors=[],
        )
    codes = [entry.code for entry in doc.entries]
    daily_rows = _load_daily_rows(corpus_path, codes, basis)
    folder_names = {folder.id: folder.name for folder in doc.folders}
    folder_orders = {folder.id: folder.order for folder in doc.folders}
    sectors: list[IndexSectorGroup] = []
    for folder_id, folder_name, folder_order, entries in _entry_groups(doc.entries, folder_names, folder_orders):
        stocks = _sort_stocks([
            _stock_from_entry(
                entry,
                folder_name=folder_name,
                basis=basis,
                rows=daily_rows.get(entry.code, []),
            )
            for entry in entries
        ])
        avg, finite_count = _sector_average(stocks)
        sectors.append(
            IndexSectorGroup(
                folder_id=folder_id,
                folder_name=folder_name,
                order=folder_order,
                change_pct=avg,
                finite_count=finite_count,
                total_count=len(stocks),
                stocks=stocks,
            ),
        )
    return IndexSectorRankingResponse(
        date=basis_date,
        source="daily_adjusted",
        sectors=_sort_sectors(sectors),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
python -m pytest tests/unit/live/test_index_sector_rankings.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/index_sector_rankings.py tests/unit/live/test_index_sector_rankings.py
git commit -m "feat: add index sector ranking service"
```

### Task 2: Backend Route

**Files:**
- Modify: `hoga/live/api.py`
- Create: `tests/api/test_index_sector_rankings_route.py`

**Interfaces:**
- Consumes:
  - `build_index_sector_rankings(data_dir: Path, basis_date: str) -> IndexSectorRankingResponse`
- Produces:
  - `GET /api/live/index-sector-rankings?date=YYYYMMDD`
  - Response model: `IndexSectorRankingResponse`
  - Error codes:
    - `invalid_date` for malformed date
    - `date_in_future` for future KST dates

- [ ] **Step 1: Write the failing route tests**

Create `tests/api/test_index_sector_rankings_route.py`:

```python
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import api as live_api
from hoga.live.api import build_router


def _client(tmp_path):
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return TestClient(app)


def test_index_sector_rankings_rejects_invalid_date(tmp_path) -> None:
    res = _client(tmp_path).get("/api/live/index-sector-rankings?date=2026-06-19")

    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "invalid_date"


def test_index_sector_rankings_rejects_future_date(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(live_api, "_today_kst_yyyymmdd", lambda: "20260619")

    res = _client(tmp_path).get("/api/live/index-sector-rankings?date=20260620")

    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "date_in_future"


def test_index_sector_rankings_returns_service_payload(tmp_path, monkeypatch) -> None:
    calls = []

    class FakeResponse:
        def model_dump(self, *args, **kwargs):
            return {
                "date": "20260619",
                "source": "daily_adjusted",
                "unavailable_reason": None,
                "sectors": [],
            }

    def fake_build(data_dir, basis_date):
        calls.append((data_dir, basis_date))
        return FakeResponse()

    monkeypatch.setattr(live_api, "build_index_sector_rankings", fake_build)

    res = _client(tmp_path).get("/api/live/index-sector-rankings?date=20260619")

    assert res.status_code == 200
    assert calls == [(tmp_path, "20260619")]
    assert res.json() == {
        "date": "20260619",
        "source": "daily_adjusted",
        "unavailable_reason": None,
        "sectors": [],
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
python -m pytest tests/api/test_index_sector_rankings_route.py -v
```

Expected: FAIL with `404 Not Found` for `/api/live/index-sector-rankings`.

- [ ] **Step 3: Add the route**

Modify `hoga/live/api.py`.

Add this import near the other local imports:

```python
from .index_sector_rankings import IndexSectorRankingResponse, build_index_sector_rankings
```

Inside `build_router`, add this route near the existing index routes:

```python
    @router.get("/index-sector-rankings", response_model=IndexSectorRankingResponse)
    async def get_index_sector_rankings(date: str = Query(..., pattern=r"^\d{8}$")) -> IndexSectorRankingResponse:
        basis = _parse_yyyymmdd(date)
        if basis is None:
            raise HTTPException(422, {"code": "invalid_date", "msg": "date must be YYYYMMDD"})
        if date > _today_kst_yyyymmdd():
            raise HTTPException(422, {"code": "date_in_future", "msg": "date must be <= today_kst"})
        return build_index_sector_rankings(data_dir, date)
```

If FastAPI's `Query(pattern=...)` returns a Pydantic validation body before the explicit `invalid_date` branch, remove the `pattern` argument and keep the explicit `_parse_yyyymmdd` check:

```python
    @router.get("/index-sector-rankings", response_model=IndexSectorRankingResponse)
    async def get_index_sector_rankings(date: str = Query(...)) -> IndexSectorRankingResponse:
        basis = _parse_yyyymmdd(date)
        if basis is None:
            raise HTTPException(422, {"code": "invalid_date", "msg": "date must be YYYYMMDD"})
        if date > _today_kst_yyyymmdd():
            raise HTTPException(422, {"code": "date_in_future", "msg": "date must be <= today_kst"})
        return build_index_sector_rankings(data_dir, date)
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
python -m pytest tests/api/test_index_sector_rankings_route.py tests/unit/live/test_index_sector_rankings.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/api.py tests/api/test_index_sector_rankings_route.py
git commit -m "feat: expose index sector ranking route"
```

### Task 3: Frontend Ranking API Hook

**Files:**
- Create: `frontend/src/api/indexSectorRankings.ts`
- Create: `frontend/src/api/indexSectorRankings.test.tsx`

**Interfaces:**
- Consumes:
  - Backend `GET /api/live/index-sector-rankings?date=YYYYMMDD`
- Produces:
  - `type IndexSectorRankingSource = 'daily_adjusted' | 'unavailable'`
  - `interface IndexSectorRankingStock`
  - `interface IndexSectorRankingSector`
  - `interface IndexSectorRankingResponse`
  - `function useIndexSectorRankings(date: string | null, enabledByCaller?: boolean)`

- [ ] **Step 1: Write the failing hook tests**

Create `frontend/src/api/indexSectorRankings.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useIndexSectorRankings } from './indexSectorRankings';
import { __resetConfigForTests } from './client';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useIndexSectorRankings', () => {
  beforeEach(() => {
    __resetConfigForTests();
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/config.json')) {
        return new Response(JSON.stringify({ apiBaseUrl: 'http://api.test', wsBaseUrl: 'ws://api.test' }));
      }
      return new Response(JSON.stringify({
        date: '20260619',
        source: 'daily_adjusted',
        unavailable_reason: null,
        sectors: [],
      }));
    }));
  });

  it('fetches one ranking payload for the basis date', async () => {
    const { result } = renderHook(() => useIndexSectorRankings('20260619'), { wrapper });

    await waitFor(() => expect(result.current.data?.date).toBe('20260619'));

    expect(fetch).toHaveBeenCalledWith(
      'http://api.test/api/live/index-sector-rankings?date=20260619',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not fetch when date is null', () => {
    renderHook(() => useIndexSectorRankings(null), { wrapper });

    expect(fetch).toHaveBeenCalledTimes(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd frontend && npx vitest run src/api/indexSectorRankings.test.tsx
```

Expected: FAIL with `Failed to resolve import "./indexSectorRankings"`.

- [ ] **Step 3: Implement the API hook**

Create `frontend/src/api/indexSectorRankings.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

export type IndexSectorRankingSource = 'daily_adjusted' | 'unavailable';
export type IndexSectorMissingReason = 'no_basis_bar' | 'no_previous_close';

export interface IndexSectorRankingStock {
  code: string;
  name: string;
  folder_id: string | null;
  folder_name: string;
  order: number;
  close: number | null;
  previous_close: number | null;
  change_pct: number | null;
  missing_reason: IndexSectorMissingReason | null;
}

export interface IndexSectorRankingSector {
  folder_id: string | null;
  folder_name: string;
  order: number;
  change_pct: number | null;
  finite_count: number;
  total_count: number;
  stocks: IndexSectorRankingStock[];
}

export interface IndexSectorRankingResponse {
  date: string;
  source: IndexSectorRankingSource;
  unavailable_reason: 'screener_daily_corpus_missing' | null;
  sectors: IndexSectorRankingSector[];
}

export function useIndexSectorRankings(date: string | null, enabledByCaller = true) {
  return useQuery({
    queryKey: ['live', 'index-sector-rankings', date] as const,
    queryFn: ({ signal }) =>
      apiCall<IndexSectorRankingResponse>(
        `/api/live/index-sector-rankings?date=${date}`,
        { signal },
      ),
    enabled: enabledByCaller && !!date,
    staleTime: 60_000,
    placeholderData: (prev) => (prev && prev.date === date ? prev : undefined),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd frontend && npx vitest run src/api/indexSectorRankings.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/indexSectorRankings.ts frontend/src/api/indexSectorRankings.test.tsx
git commit -m "feat: add index sector ranking query"
```

### Task 4: Frontend Date And Sector State

**Files:**
- Create: `frontend/src/live/indexSectorRankingState.ts`
- Create: `frontend/src/live/indexSectorRankingState.test.ts`

**Interfaces:**
- Consumes:
  - `IndexSectorRankingSector[]`
- Produces:
  - `type BasisMode = 'latest' | 'hover' | 'pinned'`
  - `interface IndexSectorRankingUiState`
  - `const initialIndexSectorRankingUiState`
  - `function resolveBasisDate(state, latestDate) -> { date, mode }`
  - `function reduceIndexSectorRankingState(state, action) -> IndexSectorRankingUiState`
  - `function resolveActiveSectorId(sectors, state) -> string | null`

- [ ] **Step 1: Write the failing reducer tests**

Create `frontend/src/live/indexSectorRankingState.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  initialIndexSectorRankingUiState,
  reduceIndexSectorRankingState,
  resolveActiveSectorId,
  resolveBasisDate,
} from './indexSectorRankingState';
import type { IndexSectorRankingSector } from '../api/indexSectorRankings';

const sectors: IndexSectorRankingSector[] = [
  { folder_id: 'semi', folder_name: '반도체', order: 0, change_pct: 5, finite_count: 1, total_count: 1, stocks: [] },
  { folder_id: 'bio', folder_name: '바이오', order: 1, change_pct: 3, finite_count: 1, total_count: 1, stocks: [] },
];

describe('index sector ranking state', () => {
  it('uses latest date until hover sets a basis', () => {
    const state = initialIndexSectorRankingUiState;
    expect(resolveBasisDate(state, '20260619')).toEqual({ date: '20260619', mode: 'latest' });

    const hovered = reduceIndexSectorRankingState(state, { type: 'hover_date', date: '20260618' });
    expect(resolveBasisDate(hovered, '20260619')).toEqual({ date: '20260618', mode: 'hover' });
  });

  it('clicking a date pins it and ignores later hover changes', () => {
    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_date_pin',
      date: '20260618',
    });
    const hovered = reduceIndexSectorRankingState(pinned, { type: 'hover_date', date: '20260619' });

    expect(resolveBasisDate(hovered, '20260620')).toEqual({ date: '20260618', mode: 'pinned' });
  });

  it('clicking the pinned date again clears the pin', () => {
    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_date_pin',
      date: '20260618',
    });
    const unpinned = reduceIndexSectorRankingState(pinned, {
      type: 'toggle_date_pin',
      date: '20260618',
    });

    expect(resolveBasisDate(unpinned, '20260619')).toEqual({ date: '20260619', mode: 'latest' });
  });

  it('sector hover previews without overwriting a pinned sector', () => {
    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_sector_pin',
      folderId: 'semi',
    });
    const preview = reduceIndexSectorRankingState(pinned, {
      type: 'preview_sector',
      folderId: 'bio',
    });

    expect(resolveActiveSectorId(sectors, preview)).toBe('bio');

    const ended = reduceIndexSectorRankingState(preview, { type: 'preview_sector', folderId: null });
    expect(resolveActiveSectorId(sectors, ended)).toBe('semi');
  });

  it('sector click toggles pin and falls back to rank 1', () => {
    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_sector_pin',
      folderId: 'bio',
    });
    expect(resolveActiveSectorId(sectors, pinned)).toBe('bio');

    const unpinned = reduceIndexSectorRankingState(pinned, {
      type: 'toggle_sector_pin',
      folderId: 'bio',
    });
    expect(resolveActiveSectorId(sectors, unpinned)).toBe('semi');
  });

  it('clears missing pinned sector and falls back to rank 1', () => {
    const pinned = reduceIndexSectorRankingState(initialIndexSectorRankingUiState, {
      type: 'toggle_sector_pin',
      folderId: 'removed',
    });

    expect(resolveActiveSectorId(sectors, pinned)).toBe('semi');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd frontend && npx vitest run src/live/indexSectorRankingState.test.ts
```

Expected: FAIL with `Failed to resolve import "./indexSectorRankingState"`.

- [ ] **Step 3: Implement pure state helpers**

Create `frontend/src/live/indexSectorRankingState.ts`:

```ts
import type { IndexSectorRankingSector } from '../api/indexSectorRankings';

export type BasisMode = 'latest' | 'hover' | 'pinned';

export interface IndexSectorRankingUiState {
  hoverDate: string | null;
  pinnedDate: string | null;
  previewSectorId: string | null;
  pinnedSectorId: string | null;
}

export const initialIndexSectorRankingUiState: IndexSectorRankingUiState = {
  hoverDate: null,
  pinnedDate: null,
  previewSectorId: null,
  pinnedSectorId: null,
};

export type IndexSectorRankingAction =
  | { type: 'hover_date'; date: string | null }
  | { type: 'toggle_date_pin'; date: string }
  | { type: 'clear_date_pin' }
  | { type: 'preview_sector'; folderId: string | null }
  | { type: 'toggle_sector_pin'; folderId: string | null }
  | { type: 'clear_sector_pin' };

export function reduceIndexSectorRankingState(
  state: IndexSectorRankingUiState,
  action: IndexSectorRankingAction,
): IndexSectorRankingUiState {
  switch (action.type) {
    case 'hover_date':
      return state.pinnedDate ? state : { ...state, hoverDate: action.date };
    case 'toggle_date_pin':
      return {
        ...state,
        pinnedDate: state.pinnedDate === action.date ? null : action.date,
        hoverDate: state.pinnedDate === action.date ? null : state.hoverDate,
      };
    case 'clear_date_pin':
      return { ...state, pinnedDate: null };
    case 'preview_sector':
      return { ...state, previewSectorId: action.folderId };
    case 'toggle_sector_pin':
      return {
        ...state,
        pinnedSectorId: state.pinnedSectorId === action.folderId ? null : action.folderId,
      };
    case 'clear_sector_pin':
      return { ...state, pinnedSectorId: null };
  }
}

export function resolveBasisDate(
  state: IndexSectorRankingUiState,
  latestDate: string | null,
): { date: string | null; mode: BasisMode } {
  if (state.pinnedDate) return { date: state.pinnedDate, mode: 'pinned' };
  if (state.hoverDate) return { date: state.hoverDate, mode: 'hover' };
  return { date: latestDate, mode: 'latest' };
}

function sectorExists(sectors: IndexSectorRankingSector[], folderId: string | null): boolean {
  return sectors.some((sector) => sector.folder_id === folderId);
}

export function resolveActiveSectorId(
  sectors: IndexSectorRankingSector[],
  state: IndexSectorRankingUiState,
): string | null {
  if (state.previewSectorId !== null && sectorExists(sectors, state.previewSectorId)) {
    return state.previewSectorId;
  }
  if (state.pinnedSectorId !== null && sectorExists(sectors, state.pinnedSectorId)) {
    return state.pinnedSectorId;
  }
  return sectors[0]?.folder_id ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd frontend && npx vitest run src/live/indexSectorRankingState.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/indexSectorRankingState.ts frontend/src/live/indexSectorRankingState.test.ts
git commit -m "feat: model index sector ranking selection state"
```

### Task 5: Index Sector Ranking Pane Component

**Files:**
- Create: `frontend/src/live/IndexSectorRankingPane.tsx`
- Create: `frontend/src/live/IndexSectorRankingPane.test.tsx`

**Interfaces:**
- Consumes:
  - `basisDate: string | null`
  - `basisMode: BasisMode`
  - `ranking: IndexSectorRankingResponse | undefined`
  - `isLoading: boolean`
  - `error: unknown`
  - `onClearDatePin: () => void`
  - `onOpenStock: (code: string, name: string) => void`
- Produces:
  - `IndexSectorRankingPane` component

- [ ] **Step 1: Write failing component tests**

Create `frontend/src/live/IndexSectorRankingPane.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { IndexSectorRankingPane } from './IndexSectorRankingPane';
import type { IndexSectorRankingResponse } from '../api/indexSectorRankings';

const ranking: IndexSectorRankingResponse = {
  date: '20260619',
  source: 'daily_adjusted',
  unavailable_reason: null,
  sectors: [
    {
      folder_id: 'semi',
      folder_name: '반도체',
      order: 0,
      change_pct: 7.5,
      finite_count: 2,
      total_count: 2,
      stocks: [
        { code: '005930', name: '삼성전자', folder_id: 'semi', folder_name: '반도체', order: 0, close: 110, previous_close: 100, change_pct: 10, missing_reason: null },
        { code: '000660', name: 'SK하이닉스', folder_id: 'semi', folder_name: '반도체', order: 1, close: 210, previous_close: 200, change_pct: 5, missing_reason: null },
      ],
    },
    {
      folder_id: 'bio',
      folder_name: '바이오',
      order: 1,
      change_pct: -2,
      finite_count: 1,
      total_count: 1,
      stocks: [
        { code: '068270', name: '셀트리온', folder_id: 'bio', folder_name: '바이오', order: 0, close: 98, previous_close: 100, change_pct: -2, missing_reason: null },
      ],
    },
  ],
};

describe('IndexSectorRankingPane', () => {
  it('renders basis date, sector ranking, and default rank 1 stocks', () => {
    render(
      <IndexSectorRankingPane
        basisDate="20260619"
        basisMode="hover"
        ranking={ranking}
        isLoading={false}
        error={null}
        onClearDatePin={() => {}}
        onOpenStock={() => {}}
      />,
    );

    expect(screen.getByText('2026/06/19 기준 · hover')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1위 반도체/ })).toBeInTheDocument();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    expect(screen.queryByText('셀트리온')).toBeNull();
  });

  it('previews sector stocks on hover and returns to rank 1 after leave', async () => {
    const user = userEvent.setup();
    render(
      <IndexSectorRankingPane
        basisDate="20260619"
        basisMode="hover"
        ranking={ranking}
        isLoading={false}
        error={null}
        onClearDatePin={() => {}}
        onOpenStock={() => {}}
      />,
    );

    await user.hover(screen.getByRole('button', { name: /2위 바이오/ }));
    expect(screen.getByText('셀트리온')).toBeInTheDocument();

    await user.unhover(screen.getByRole('button', { name: /2위 바이오/ }));
    expect(screen.queryByText('셀트리온')).toBeNull();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
  });

  it('pins a sector on click and unpins it on second click', async () => {
    const user = userEvent.setup();
    render(
      <IndexSectorRankingPane
        basisDate="20260619"
        basisMode="hover"
        ranking={ranking}
        isLoading={false}
        error={null}
        onClearDatePin={() => {}}
        onOpenStock={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: /2위 바이오/ }));
    expect(screen.getByText('셀트리온')).toBeInTheDocument();

    await user.unhover(screen.getByRole('button', { name: /2위 바이오/ }));
    expect(screen.getByText('셀트리온')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /2위 바이오/ }));
    expect(screen.queryByText('셀트리온')).toBeNull();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
  });

  it('opens a stock through the supplied navigation callback', async () => {
    const user = userEvent.setup();
    const onOpenStock = vi.fn();
    render(
      <IndexSectorRankingPane
        basisDate="20260619"
        basisMode="hover"
        ranking={ranking}
        isLoading={false}
        error={null}
        onClearDatePin={() => {}}
        onOpenStock={onOpenStock}
      />,
    );

    await user.click(screen.getByRole('button', { name: /삼성전자 005930/ }));

    expect(onOpenStock).toHaveBeenCalledWith('005930', '삼성전자');
  });

  it('shows unavailable state for missing daily corpus', () => {
    render(
      <IndexSectorRankingPane
        basisDate="20260619"
        basisMode="hover"
        ranking={{ date: '20260619', source: 'unavailable', unavailable_reason: 'screener_daily_corpus_missing', sectors: [] }}
        isLoading={false}
        error={null}
        onClearDatePin={() => {}}
        onOpenStock={() => {}}
      />,
    );

    expect(screen.getByText('일봉 랭킹 데이터를 사용할 수 없습니다.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd frontend && npx vitest run src/live/IndexSectorRankingPane.test.tsx
```

Expected: FAIL with `Failed to resolve import "./IndexSectorRankingPane"`.

- [ ] **Step 3: Implement the pane**

Create `frontend/src/live/IndexSectorRankingPane.tsx`:

```tsx
import { useMemo, useReducer } from 'react';
import type { BasisMode } from './indexSectorRankingState';
import {
  initialIndexSectorRankingUiState,
  reduceIndexSectorRankingState,
  resolveActiveSectorId,
} from './indexSectorRankingState';
import type {
  IndexSectorRankingResponse,
  IndexSectorRankingSector,
  IndexSectorRankingStock,
} from '../api/indexSectorRankings';

function formatDate(date: string | null): string {
  if (!date || date.length !== 8) return '날짜 없음';
  return `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`;
}

function formatPct(value: number | null): string {
  if (value === null) return '-';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function priceColor(value: number | null): string {
  if (value === null || value === 0) return 'var(--fg-dim)';
  return value > 0 ? 'var(--price-up)' : 'var(--price-down)';
}

interface Props {
  basisDate: string | null;
  basisMode: BasisMode;
  ranking: IndexSectorRankingResponse | undefined;
  isLoading: boolean;
  error: unknown;
  onClearDatePin: () => void;
  onOpenStock: (code: string, name: string) => void;
}

function SectorButton({
  sector,
  rank,
  active,
  onPreview,
  onPin,
}: {
  sector: IndexSectorRankingSector;
  rank: number;
  active: boolean;
  onPreview: (folderId: string | null) => void;
  onPin: (folderId: string | null) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${rank}위 ${sector.folder_name} ${formatPct(sector.change_pct)}`}
      onMouseEnter={() => onPreview(sector.folder_id)}
      onMouseLeave={() => onPreview(null)}
      onFocus={() => onPreview(sector.folder_id)}
      onBlur={() => onPreview(null)}
      onClick={() => onPin(sector.folder_id)}
      className="w-full grid items-center text-left"
      style={{
        gridTemplateColumns: '32px minmax(0, 1fr) 72px',
        gap: 'var(--space-sm)',
        minHeight: 32,
        padding: 'var(--space-xs) var(--space-sm)',
        border: active ? '1px solid var(--accent)' : '1px solid transparent',
        background: active ? 'var(--tint-selection)' : 'transparent',
        color: 'var(--fg)',
      }}
    >
      <span className="font-mono text-xs" style={{ color: 'var(--fg-dimmer)' }}>{rank}</span>
      <span className="truncate font-ui text-sm">{sector.folder_name}</span>
      <span className="font-mono text-xs text-right" style={{ color: priceColor(sector.change_pct) }}>
        {formatPct(sector.change_pct)}
      </span>
    </button>
  );
}

function StockButton({
  stock,
  rank,
  onOpenStock,
}: {
  stock: IndexSectorRankingStock;
  rank: number;
  onOpenStock: (code: string, name: string) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${stock.name} ${stock.code} ${formatPct(stock.change_pct)}`}
      onClick={() => onOpenStock(stock.code, stock.name)}
      className="grid w-full items-center text-left"
      style={{
        gridTemplateColumns: '32px minmax(0, 1fr) 72px',
        gap: 'var(--space-sm)',
        minHeight: 30,
        padding: 'var(--space-xs) var(--space-sm)',
        color: 'var(--fg)',
      }}
    >
      <span className="font-mono text-xs" style={{ color: 'var(--fg-dimmer)' }}>{rank}</span>
      <span className="truncate font-ui text-sm">{stock.name}</span>
      <span className="font-mono text-xs text-right" style={{ color: priceColor(stock.change_pct) }}>
        {formatPct(stock.change_pct)}
      </span>
    </button>
  );
}

export function IndexSectorRankingPane({
  basisDate,
  basisMode,
  ranking,
  isLoading,
  error,
  onClearDatePin,
  onOpenStock,
}: Props) {
  const [state, dispatch] = useReducer(
    reduceIndexSectorRankingState,
    initialIndexSectorRankingUiState,
  );
  const sectors = ranking?.sectors ?? [];
  const activeSectorId = resolveActiveSectorId(sectors, state);
  const activeSector = useMemo(
    () => sectors.find((sector) => sector.folder_id === activeSectorId) ?? sectors[0] ?? null,
    [activeSectorId, sectors],
  );

  let body = null;
  if (isLoading) {
    body = <div className="p-md text-sm text-fg-dimmer">섹터 랭킹을 불러오는 중입니다.</div>;
  } else if (error) {
    body = <div className="p-md text-sm" style={{ color: 'var(--danger)' }}>섹터 랭킹을 불러오지 못했습니다.</div>;
  } else if (ranking?.source === 'unavailable') {
    body = <div className="p-md text-sm text-fg-dimmer">일봉 랭킹 데이터를 사용할 수 없습니다.</div>;
  } else if (sectors.length === 0) {
    body = <div className="p-md text-sm text-fg-dimmer">히트맵 섹터가 없습니다.</div>;
  } else {
    body = (
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: 'minmax(180px, 1fr) minmax(0, 2fr)' }}>
        <div className="min-h-0 overflow-auto" style={{ borderRight: '1px solid var(--border)' }}>
          {sectors.map((sector, index) => (
            <SectorButton
              key={sector.folder_id ?? '__uncat__'}
              sector={sector}
              rank={index + 1}
              active={sector.folder_id === activeSector?.folder_id}
              onPreview={(folderId) => dispatch({ type: 'preview_sector', folderId })}
              onPin={(folderId) => dispatch({ type: 'toggle_sector_pin', folderId })}
            />
          ))}
        </div>
        <div className="min-h-0 overflow-auto">
          {(activeSector?.stocks ?? []).map((stock, index) => (
            <StockButton
              key={stock.code}
              stock={stock}
              rank={index + 1}
              onOpenStock={onOpenStock}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <section
      data-testid="index-sector-ranking-pane"
      className="flex min-h-0 flex-col"
      style={{
        height: 220,
        borderTop: '1px solid var(--border)',
        background: 'var(--bg)',
      }}
    >
      <div
        className="flex items-center gap-sm"
        style={{
          minHeight: 34,
          padding: '0 var(--space-sm)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span className="font-ui text-sm" style={{ color: 'var(--fg)' }}>
          {formatDate(basisDate)} 기준 · {basisMode === 'pinned' ? '날짜 고정' : basisMode}
        </span>
        {basisMode === 'pinned' && (
          <button type="button" className="ml-auto text-xs text-fg-dimmer" onClick={onClearDatePin}>
            고정 해제
          </button>
        )}
      </div>
      {body}
    </section>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd frontend && npx vitest run src/live/IndexSectorRankingPane.test.tsx src/live/indexSectorRankingState.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/live/IndexSectorRankingPane.tsx frontend/src/live/IndexSectorRankingPane.test.tsx
git commit -m "feat: add index sector ranking pane"
```

### Task 6: Live Chart And Workarea Integration

**Files:**
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LiveWorkarea.tsx`
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LiveChartRoot.test.tsx`
- Modify: `frontend/src/live/LiveWorkarea.test.tsx`

**Interfaces:**
- Consumes:
  - `useIndexSectorRankings(date, enabled)`
  - `IndexSectorRankingPane`
  - `resolveBasisDate` and `reduceIndexSectorRankingState`
  - `activeInstrument: LiveInstrument | null`
- Produces:
  - `LiveChartRoot` optional props:
    - `onCandleBasisHover?: (date: string | null) => void`
    - `onCandleBasisClick?: (date: string) => void`
  - `LiveWorkarea` renders the pane only for index `D` and minute timeframes.

- [ ] **Step 1: Add failing LiveChartRoot callback test**

Append to `frontend/src/live/LiveChartRoot.test.tsx`:

```tsx
it('publishes index sector basis hover dates from crosshair movement', async () => {
  let crosshairHandler: ((param: { time?: unknown; point?: { x: number } | null }) => void) | null = null;
  const chart = {
    addSeries: vi.fn(() => ({
      setData: vi.fn(), update: vi.fn(), removeSeries: vi.fn(), applyOptions: vi.fn(),
      priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
      createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
      removePriceLine: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn(), setMarkers: vi.fn(),
    })),
    removeSeries: vi.fn(),
    timeScale: vi.fn(() => ({
      subscribeVisibleTimeRangeChange: vi.fn(),
      unsubscribeVisibleTimeRangeChange: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
      applyOptions: vi.fn(),
      fitContent: vi.fn(),
      scrollToRealTime: vi.fn(),
      scrollToPosition: vi.fn(),
      setVisibleLogicalRange: vi.fn(),
      getVisibleLogicalRange: vi.fn(() => null),
      getVisibleRange: vi.fn(() => null),
      setVisibleRange: vi.fn(),
      timeToCoordinate: vi.fn(() => null),
      coordinateToLogical: vi.fn(() => null),
      width: vi.fn(() => 800),
      timeToIndex: vi.fn(() => null),
    })),
    panes: vi.fn(() => []),
    remove: vi.fn(),
    resize: vi.fn(),
    applyOptions: vi.fn(),
    options: vi.fn(() => ({ timeScale: { minBarSpacing: 0.5 } })),
    subscribeCrosshairMove: vi.fn((handler) => { crosshairHandler = handler; }),
    unsubscribeCrosshairMove: vi.fn(),
    subscribeClick: vi.fn(),
    unsubscribeClick: vi.fn(),
  };
  vi.mocked(createChartEx).mockReturnValueOnce(chart as never);
  const onCandleBasisHover = vi.fn();
  const bundle: RangeBundle = {
    ...DEFAULT_BUNDLE,
    candles: [{ ts_ms: 1781829000000, open: 1, high: 1, low: 1, close: 1, vol_a: 1, vol_b: 0 }],
  };

  render(
    <LiveChartRoot
      code="index:KOSPI"
      timeframe="1m"
      bundle={bundle}
      clampEngaged={false}
      isPastCandlesLoading={false}
      onCandleBasisHover={onCandleBasisHover}
    />,
    { wrapper },
  );

  expect(crosshairHandler).not.toBeNull();
  act(() => {
    crosshairHandler?.({ time: realMsToVirtualSeconds(1781829000000, createVirtualAxis(bundle.segments)), point: { x: 10 } });
  });
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

  expect(onCandleBasisHover).toHaveBeenCalledWith('20260619');
});
```

- [ ] **Step 2: Add failing Workarea gating tests**

Modify `frontend/src/live/LiveWorkarea.test.tsx`:

```tsx
import { indexInstrument, stockInstrument } from './liveInstrument';

vi.mock('./IndexSectorRankingPane', () => ({
  IndexSectorRankingPane: () => <div data-testid="index-sector-ranking-pane" />,
}));
vi.mock('../api/indexSectorRankings', () => ({
  useIndexSectorRankings: () => ({ data: { date: '20260619', source: 'daily_adjusted', unavailable_reason: null, sectors: [] }, isLoading: false, error: null }),
}));
```

Add tests:

```tsx
it('renders the index sector pane for index D timeframe', () => {
  useLivePageStore.setState({ candleTimeframe: 'D' });
  render(
    <LiveWorkarea
      activeCode="index:KOSPI"
      activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
      bundle={{ code: 'index:KOSPI', from_date: '20260601', to_date: '20260619', bucket_ms: 86_400_000, segments: [], candles: [], quote_ratio: { bucket_ms: 60_000, points: [] }, fill_strength: { bucket_ms: 60_000, points: [] }, volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] }, volume_profile_by_day: [], investorPoints: [], ask_peaks: [] }}
      clampEngaged={false}
      isPastCandlesLoading={false}
      isExtending={false}
      live={LIVE}
    />,
  );
  expect(screen.getByTestId('index-sector-ranking-pane')).toBeInTheDocument();
});

it('does not render the index sector pane for stock instruments', () => {
  useLivePageStore.setState({ candleTimeframe: 'D' });
  render(
    <LiveWorkarea
      activeCode="005930"
      activeInstrument={stockInstrument('005930', '삼성전자')}
      bundle={null}
      clampEngaged={false}
      isPastCandlesLoading={false}
      isExtending={false}
      live={LIVE}
    />,
  );
  expect(screen.queryByTestId('index-sector-ranking-pane')).toBeNull();
});

it('does not render the index sector pane for index W and M timeframes', () => {
  for (const timeframe of ['W', 'M'] as const) {
    useLivePageStore.setState({ candleTimeframe: timeframe });
    const { unmount } = render(
      <LiveWorkarea
        activeCode="index:KOSPI"
        activeInstrument={indexInstrument('KOSPI', 'KOSPI')}
        bundle={{ code: 'index:KOSPI', from_date: '20260601', to_date: '20260619', bucket_ms: 86_400_000, segments: [], candles: [], quote_ratio: { bucket_ms: 60_000, points: [] }, fill_strength: { bucket_ms: 60_000, points: [] }, volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] }, volume_profile_by_day: [], investorPoints: [], ask_peaks: [] }}
        clampEngaged={false}
        isPastCandlesLoading={false}
        isExtending={false}
        live={LIVE}
      />,
    );
    expect(screen.queryByTestId('index-sector-ranking-pane')).toBeNull();
    unmount();
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx src/live/LiveWorkarea.test.tsx
```

Expected: FAIL because `LiveChartRoot` does not accept basis callbacks and `LiveWorkarea` does not accept `activeInstrument` or render the pane.

- [ ] **Step 4: Implement chart callbacks**

Modify `frontend/src/live/LiveChartRoot.tsx`.

Add props:

```ts
  onCandleBasisHover?: (date: string | null) => void;
  onCandleBasisClick?: (date: string) => void;
```

Add this helper near `pad`:

```ts
function kstDateFromMs(realMs: number): string {
  const d = new Date(realMs + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
```

Include the new props in the function signature.

Inside the existing `subscribeCrosshairMove` handler, after `const realMs = axis.toReal(t * 1000);` and after the future-whitespace guard passes, call:

```ts
        onCandleBasisHover?.(kstDateFromMs(realMs));
```

In the `param.point == null` branch, call:

```ts
        onCandleBasisHover?.(null);
```

Add a click subscription effect after the crosshair effect:

```ts
  useEffect(() => {
    if (!chart || !onCandleBasisClick) return;
    const handler = (param: { time?: unknown; point?: { x: number } | null }) => {
      if (param.point == null || typeof param.time !== 'number' || axis.segments.length === 0) return;
      const realMs = axis.toReal(param.time * 1000);
      const lastMs = lastCandleMsRef.current;
      if (lastMs !== null && realMs > lastMs) return;
      onCandleBasisClick(kstDateFromMs(realMs));
    };
    chart.subscribeClick(handler);
    return () => {
      chart.unsubscribeClick(handler);
    };
  }, [chart, axis, onCandleBasisClick]);
```

Add `onCandleBasisHover` to the dependency array of the crosshair effect.

- [ ] **Step 5: Implement Workarea pane wiring**

Modify `frontend/src/live/LiveWorkarea.tsx`.

Add imports:

```ts
import { useMemo, useReducer } from 'react';
import type { LiveInstrument } from './liveInstrument';
import { isMinuteTimeframe } from '../state/livePage';
import { useJumpToLive } from './useJumpToLive';
import { useIndexSectorRankings } from '../api/indexSectorRankings';
import { IndexSectorRankingPane } from './IndexSectorRankingPane';
import {
  initialIndexSectorRankingUiState,
  reduceIndexSectorRankingState,
  resolveBasisDate,
} from './indexSectorRankingState';
```

If `useMemo` and `useReducer` are added, merge them into the existing React import instead of adding a duplicate import.

Add to `Props`:

```ts
  activeInstrument?: LiveInstrument | null;
```

Destructure `activeInstrument = null`.

Inside the component:

```ts
  const [rankingState, rankingDispatch] = useReducer(
    reduceIndexSectorRankingState,
    initialIndexSectorRankingUiState,
  );
  const openStock = useJumpToLive();
  const isIndexInstrument = activeInstrument?.kind === 'index';
  const rankingAllowed = isIndexInstrument && (isMinuteTimeframe(timeframe) || timeframe === 'D');
  const latestRankingDate = bundle?.to_date ?? todayKst || null;
  const rankingBasis = resolveBasisDate(rankingState, latestRankingDate);
  const rankingQuery = useIndexSectorRankings(rankingBasis.date, rankingAllowed);
  const handleOpenStock = useMemo(
    () => (code: string, name: string) => openStock(code, name),
    [openStock],
  );
```

Replace the chart column wrapper with vertical layout:

```tsx
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <LiveChartRoot
                code={activeCode}
                timeframe={timeframe}
                venue={venue}
                bundle={bundle}
                chartBundle={chartBundle}
                clampEngaged={clampEngaged}
                isPastCandlesLoading={isPastCandlesLoading}
                isExtending={isExtending}
                pastDataWarnings={pastDataWarnings}
                restoreViewport={restoreViewport}
                viewIdentity={viewIdentity ?? undefined}
                dayAskPeaks={dayAskPeaks}
                todayAllPriceAskPeak={todayAllPriceAskPeak}
                dayBidPeaks={dayBidPeaks}
                todayAllPriceBidPeak={todayAllPriceBidPeak}
                todayKst={todayKst}
                paneTogglesOverride={paneTogglesOverride}
                onViewportCaptureReady={onViewportCaptureReady}
                onCandleBasisHover={(date) => rankingDispatch({ type: 'hover_date', date })}
                onCandleBasisClick={(date) => rankingDispatch({ type: 'toggle_date_pin', date })}
              />
            </div>
            {rankingAllowed && (
              <IndexSectorRankingPane
                basisDate={rankingBasis.date}
                basisMode={rankingBasis.mode}
                ranking={rankingQuery.data}
                isLoading={rankingQuery.isLoading}
                error={rankingQuery.error}
                onClearDatePin={() => rankingDispatch({ type: 'clear_date_pin' })}
                onOpenStock={handleOpenStock}
              />
            )}
          </div>
```

The stock layout remains unchanged because `rankingAllowed` is false when `activeInstrument.kind !== 'index'`.

- [ ] **Step 6: Pass active instrument from LivePage**

Modify `frontend/src/live/LivePage.tsx`.

Add this prop to `LiveWorkarea`:

```tsx
        activeInstrument={activeInstrument}
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
cd frontend && npx vitest run src/live/LiveChartRoot.test.tsx src/live/LiveWorkarea.test.tsx src/live/IndexSectorRankingPane.test.tsx src/api/indexSectorRankings.test.tsx src/live/indexSectorRankingState.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run backend focused tests**

Run:

```bash
python -m pytest tests/unit/live/test_index_sector_rankings.py tests/api/test_index_sector_rankings_route.py -v
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveWorkarea.tsx frontend/src/live/LivePage.tsx frontend/src/live/LiveChartRoot.test.tsx frontend/src/live/LiveWorkarea.test.tsx
git commit -m "feat: wire index sector ranking pane into live"
```

### Task 7: Manual QA And Regression Sweep

**Files:**
- Modify only if a focused test reveals a real bug:
  - `frontend/src/live/IndexSectorRankingPane.tsx`
  - `frontend/src/live/LiveWorkarea.tsx`
  - `frontend/src/live/LiveChartRoot.tsx`

**Interfaces:**
- Consumes:
  - All tasks above.
- Produces:
  - Verified browser behavior for index and stock `/live` pages.

- [ ] **Step 1: Run complete backend tests touched by this feature**

Run:

```bash
python -m pytest tests/unit/live/test_index_sector_rankings.py tests/api/test_index_sector_rankings_route.py tests/api/test_live_indices_routes.py tests/test_api_heatmap.py -v
```

Expected: PASS.

- [ ] **Step 2: Run complete frontend tests touched by this feature**

Run:

```bash
cd frontend && npx vitest run src/api/indexSectorRankings.test.tsx src/live/indexSectorRankingState.test.ts src/live/IndexSectorRankingPane.test.tsx src/live/LiveChartRoot.test.tsx src/live/LiveWorkarea.test.tsx src/live/LivePage.test.tsx src/heatmap/heat.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck/build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS.

- [ ] **Step 4: Browser QA on `/live?index=KOSPI`**

Start the dev server if one is not already running:

```bash
cd frontend && npm run dev -- --host 0.0.0.0
```

Open `/live?index=KOSPI` and verify:

- Index chart renders.
- Sector pane appears under the chart on `D`.
- Sector pane appears under the chart on `1m`.
- Sector pane is absent or disabled on `W`.
- Sector pane is absent or disabled on `M`.
- Hovering a candle changes the basis date only when the date changes.
- Clicking a candle pins the basis date.
- Hovering another candle while pinned does not change the ranking date.
- Clicking the same pinned date again or pressing the unpin control clears the date pin.
- Hovering sector rank 2 previews rank 2 stocks.
- Clicking sector rank 2 pins rank 2 stocks.
- Clicking the pinned sector again returns the right column to rank 1.
- Clicking a stock row opens that stock in `/live`.

- [ ] **Step 5: Browser QA on a stock `/live` page**

Open `/live?code=005930` and verify:

- Stock chart renders.
- Index sector ranking pane is not present.
- Existing stock hoga panes and sidebar behavior are unchanged.
- Existing candle tooltip still appears on candle hover.

- [ ] **Step 6: Commit QA fixes if any**

If no code changed during QA, do not create an empty commit.

If code changed, run the focused test that covers the change, then commit:

```bash
git add frontend/src/live/IndexSectorRankingPane.tsx frontend/src/live/LiveWorkarea.tsx frontend/src/live/LiveChartRoot.tsx
git commit -m "fix: polish index sector ranking pane"
```

---

## Self-Review

**Spec coverage:** Covered backend daily corpus source, current Heatmap universe, missing data states, latest-vs-historical boundary, index-only gating, D/minute enablement, W/M exclusion, date pinning, sector hover preview, sector click pin/unpin, stock click navigation, accessibility button semantics, and regression tests for stock chart non-impact.

**Placeholder scan:** This plan contains no unresolved placeholder language and no steps that say only "write tests" without test code.

**Type consistency:** Backend model names are `IndexSectorStock`, `IndexSectorGroup`, and `IndexSectorRankingResponse`. Frontend wire types are `IndexSectorRankingStock`, `IndexSectorRankingSector`, and `IndexSectorRankingResponse`. Route path is consistently `/api/live/index-sector-rankings?date=YYYYMMDD`. Basis callback names are consistently `onCandleBasisHover` and `onCandleBasisClick`.
