# Live Viewport Ask Peak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` 차트의 오른쪽 끝에서 보이는 시점까지만 반영한 "당일 매도 최대벽"을 한 개의 수평선으로 표시하고, 사용자가 차트를 좌우로 이동하면 그 시점 기준으로 다시 계산한다.

**Architecture:** 현재 구현은 날짜별 `ask_peaks`를 여러 개의 세그먼트로 그린다. 이 요구는 "마지막으로 보이는 캔들"을 기준으로 하는 viewport-dependent metric 이므로, 백엔드에는 일자/버킷 단위의 prefix series를 추가해 partial-day cutoff를 가능하게 하고, 프론트에는 `visibleRange.to`를 기준으로 마지막 유효 포인트만 고르는 단일 오버레이를 둔다. 오늘 구간은 기존 `live.ob` 버퍼를 prefix series와 공통 helper로 합쳐서 live edge를 따라가고, 과거 구간은 bundle이 들고 있는 prefix series에서 해결한다. 새 렌더 경로가 안정화되면 `ask_peaks`는 제거한다.

**Tech Stack:** Python(FastAPI, DuckDB, pydantic, pytest), TypeScript(React, Zustand, lightweight-charts, Vitest).

**Baseline design:** `docs/superpowers/specs/2026-06-13-live-ask-peak-line-design.md`

---

## File Structure

- `hoga/tables/snapshots.py`
  - Query helpers for ask-peak data on the cold path.
  - New responsibility: return prefix-aware ask-peak points, not only a full-day summary.
- `hoga/api/models.py`
  - Wire models for the new prefix series payload.
- `hoga/api/bundle.py`
  - Bundle assembly and cache wiring.
  - Keep the old `ask_peaks` field only until the new viewport path is stable, then remove it.
- `frontend/src/api/types.ts`
  - Frontend mirror of the new bundle field.
- `frontend/src/live/LivePage.tsx`
  - Owns `live.ob` and computes the live-edge tail for today.
- `frontend/src/live/LiveWorkarea.tsx`
  - Thread the viewport-ask-peak prop to the chart root.
- `frontend/src/live/LiveChartRoot.tsx`
  - Subscribe to visible time-range changes and pass the right-edge anchor to the overlay.
- `frontend/src/live/LiveAskPeakSegments.tsx`
  - Reuse the existing overlay component as the single viewport-anchored renderer.
- `frontend/src/live/viewportAskPeak.ts`
  - Pure helper that merges today/prefix series and picks the final visible ask-peak point.
- `frontend/src/state/livePage.ts`
  - Indicator settings state for ask-peak enablement and style.
- `frontend/src/state/liveIndicatorsPersistence.ts`
  - Persist ask-peak indicator settings.
- `frontend/src/live/indicators/IndicatorPanel.tsx`
  - Mount the ask-peak controls in the live indicator panel.
- `frontend/src/live/indicators/AskPeakConfig.tsx`
  - Ask-peak on/off and style controls.
- `frontend/src/live/indicators/MAStylePicker.tsx`
  - Reuse the existing style picker for line color and width.
- Tests:
  - `tests/test_tables_snapshots.py`
  - `tests/hoga/api/test_bundle.py`
  - `frontend/src/live/viewportAskPeak.test.ts`
  - `frontend/src/live/LiveChartRoot.test.tsx`
  - `frontend/src/live/LivePage.test.tsx`

## Task 1: Add Prefix-Aware Ask Peak Data On The Backend

**Files:**
- Modify: `hoga/tables/snapshots.py`
- Modify: `hoga/api/models.py`
- Modify: `hoga/api/bundle.py`
- Test: `tests/test_tables_snapshots.py`
- Test: `tests/hoga/api/test_bundle.py`

- [ ] **Step 1: Write the failing backend tests**

Add a new test block to `tests/test_tables_snapshots.py` that proves the old one-row-per-day shape is not enough and that the new prefix series must stop at the visible cutoff.

```python
def test_query_day_ask_peak_points_prefix_max_and_tie_break(tmp_path) -> None:
    from hoga.tables.snapshots import query_day_ask_peak_points

    obs = [
        _ob(90000000, [10, 20, 30, 40, 5, 6, 7, 8, 9, 1]),
        _ob(90100000, [100, 200, 5000, 40, 5, 6, 7, 8, 9, 1]),
        _ob(90200000, [100, 200, 5000, 40, 5, 6, 7, 7, 8, 9, 1]),  # tie keeps first hit
        _ob(90300000, [10, 20, 30, 40, 5, 6, 7, 8, 9, 1]),
    ]
    out = tmp_path / "snapshots.parquet"
    write_parquet(obs, out)
    con = duckdb.connect()

    rows = query_day_ask_peak_points(con, path=out, bucket_ms=60000)

    assert [r.qty for r in rows] == [40, 5000, 5000, 5000]
    assert [r.price for r in rows] == [25150, 25100, 25100, 25100]
```

Add a compatibility test to `tests/hoga/api/test_bundle.py` that verifies the bundle still carries the legacy field while the new series is present.

```python
def test_range_bundle_carries_ask_peak_points_and_legacy_summary() -> None:
    from hoga.api.models import AskPeakPoint, RangeBundle

    bundle = RangeBundle(
        code="005930",
        from_date="20260613",
        to_date="20260613",
        bucket_ms=60000,
        segments=[],
        candles=[],
        quote_ratio=QuoteRatio(bucket_ms=60000, points=[]),
        fill_strength=FillStrength(bucket_ms=60000, points=[]),
        volume_profile_range=VolumeProfile(bin_count=0, price_min=0, price_max=0, bin_width=0, bins=[]),
        volume_profile_by_day=[],
        ask_peaks=[],
        ask_peak_points=[AskPeakPoint(t=1, price=25100, qty=5000)],
    )

    assert bundle.ask_peak_points[0].price == 25100
    assert bundle.ask_peaks == []
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
uv run --extra dev pytest tests/test_tables_snapshots.py -k ask_peak -q
uv run --extra dev pytest tests/hoga/api/test_bundle.py -k ask_peak_points -q
```

Expected:

```text
ImportError: cannot import name 'query_day_ask_peak_points'
```

and

```text
AttributeError: 'RangeBundle' object has no attribute 'ask_peak_points'
```

- [ ] **Step 3: Implement the backend series**

Add a new row/model pair and a new query helper.

```python
@dataclass(frozen=True)
class AskPeakPointRow:
    t_ms: int
    price: int
    qty: int


class AskPeakPoint(BaseModel):
    t: int
    price: int
    qty: int


def query_day_ask_peak_points(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    bucket_ms: int,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> list[AskPeakPointRow]:
    ...
```

The helper should:

1. Read `snapshots.parquet` once.
2. Filter to continuous-book snapshots with the same deep-book predicate already used by `query_day_ask_peak`.
3. Order snapshots by intra-day time and compute a running maximum of the best ask-wall candidate.
4. Emit one point per bucket boundary so the frontend can binary-search it.
5. Preserve earliest-tie behavior when `qty` matches.

Wire the new series through `build_range_bundle` as `ask_peak_points`, while keeping `ask_peaks` unchanged for compatibility.

- [ ] **Step 4: Run the backend tests and confirm they pass**

Run:

```bash
uv run --extra dev pytest tests/test_tables_snapshots.py -k ask_peak -q
uv run --extra dev pytest tests/hoga/api/test_bundle.py -k ask_peak_points -q
```

Expected:

```text
passed
```

## Task 2: Replace Per-Day Segments With A Single Viewport-Anchored Line

**Files:**
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LiveWorkarea.tsx`
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Create: `frontend/src/live/viewportAskPeak.ts`
- Modify: `frontend/src/live/LiveAskPeakSegments.tsx`
- Test: `frontend/src/live/viewportAskPeak.test.ts`
- Test: `frontend/src/live/LiveChartRoot.test.tsx`

- [ ] **Step 1: Write the failing frontend tests**

Add a pure-helper test that locks the viewport rule to the right edge, not the cursor.

```ts
import { describe, expect, it } from 'vitest';
import { computeViewportAskPeak } from './viewportAskPeak';

describe('computeViewportAskPeak', () => {
  it('returns the last point at or left of the visible right edge', () => {
    const points = [
      { t: 1000, price: 25000, qty: 100 },
      { t: 2000, price: 25100, qty: 5000 },
      { t: 3000, price: 25200, qty: 200 },
    ];

    expect(computeViewportAskPeak(points, { from: 0, to: 2.1 })).toEqual({
      t_ms: 2000,
      price: 25100,
      qty: 5000,
    });
  });
});
```

Add a `LiveChartRoot` regression that proves the overlay responds to visible-range changes instead of cursor movement and stays minute-only.

```tsx
it('recomputes the ask peak when the visible right edge changes', () => {
  const { chartApi, rerenderAtRange } = renderLiveChartRoot();

  rerenderAtRange({ from: 0, to: 10 });
  expect(askPeakLineUpdates.at(-1)).toMatchObject({ price: 25200 });

  chartApi.timeScale().subscribeVisibleTimeRangeChange.mock.calls[0][0]();
  rerenderAtRange({ from: 0, to: 5 });
  expect(askPeakLineUpdates.at(-1)).toMatchObject({ price: 25100 });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
cd frontend
npx vitest run src/live/viewportAskPeak.test.ts src/live/LiveChartRoot.test.tsx
```

Expected:

```text
FAIL src/live/viewportAskPeak.test.ts
FAIL src/live/LiveChartRoot.test.tsx
```

- [ ] **Step 3: Implement the viewport helper and renderer**

Add a pure helper that mirrors `visibleExtremes.ts`:

```ts
export type ViewportAskPeak = { t_ms: number; price: number; qty: number };

export function computeViewportAskPeak(
  points: readonly { t: number; price: number; qty: number }[],
  visibleRange: { from: number; to: number } | null,
): ViewportAskPeak | null {
  ...
}
```

The helper should:

1. Binary-search the last point whose timestamp is at or left of `visibleRange.to`.
2. Ignore later points even if they belong to the same day.
3. Return `null` when nothing is visible.

Add a pure helper that merges the today live tail with the prefix series, then selects the last point at or left of `visibleRange.to`.

Refactor `LiveAskPeakSegments.tsx` so it owns exactly one `createPriceLine`, similar to `LiveCurrentPriceLine.tsx`, but driven by the viewport helper instead of per-day segments. Keep the chart-series options unchanged.

Move the viewport subscription into `LiveChartRoot` with the same `subscribeVisibleTimeRangeChange` pattern already used for viewport persistence. Pass the visible right edge and the merged ask-peak series down through `LiveWorkarea`.

- [ ] **Step 4: Run the frontend tests and confirm they pass**

Run:

```bash
cd frontend
npx vitest run src/live/viewportAskPeak.test.ts src/live/LiveChartRoot.test.tsx
```

Expected:

```text
PASS
```

## Task 3: Verify The Full Live Path And Clean Up The Old Renderer

**Files:**
- Modify: `frontend/src/live/LivePage.tsx`
- Modify: `frontend/src/live/LiveWorkarea.tsx`
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LiveAskPeakSegments.tsx`
- Modify: `frontend/src/state/livePage.ts`
- Modify: `frontend/src/state/liveIndicatorsPersistence.ts`
- Modify: `frontend/src/live/indicators/IndicatorPanel.tsx`
- Modify: `frontend/src/live/indicators/AskPeakConfig.tsx`
- Modify: `frontend/src/live/indicators/MAStylePicker.tsx`
- Test: `frontend/src/live/LivePage.test.tsx`
- Test: `frontend/src/live/LiveChartRoot.test.tsx`

- [ ] **Step 1: Update the live-page wiring**

Thread the new viewport-anchored ask-peak payload from `LivePage` through `LiveWorkarea` into `LiveChartRoot`. Keep `useLiveSeries` singleton semantics intact; do not add a second SSE subscription.

Use the same `live.ob` tail for today, but only as the live continuation of the prefix series. The visible-right-edge selection remains a pure read from the chart viewport.

- [ ] **Step 2: Remove the old per-day segment assumptions**

Replace the current per-day `LiveAskPeakSegments` behavior with the new single-line viewport path. If the old per-day segment assumptions are still needed during the transition, keep them only as a temporary adapter inside the same component and remove them once the viewport path is stable.

- [ ] **Step 3: Wire the indicator controls and persistence**

Update the live indicator panel and persistence layer so `askPeakEnabled`, color, and width still behave like the other live indicators. Reuse the existing style picker where possible.

- [ ] **Step 4: Remove the legacy `ask_peaks` render dependency**

Once the viewport path is stable, stop feeding `ask_peaks` into the live render path and remove it from the bundle/types used by the chart. Leave only the prefix-aware series that drives the viewport-anchored line.

- [ ] **Step 5: Run the full verification set**

Run:

```bash
cd frontend
npx vitest run src/live/LivePage.test.tsx src/live/LiveChartRoot.test.tsx src/live/viewportAskPeak.test.ts
npx tsc -p tsconfig.app.json --noEmit
```

Expected:

```text
PASS
```

and

```text
0 errors
```

## Self-Review

Before implementation, check these three points against the plan:

1. The backend now provides a prefix-aware ask-peak series, not only a day summary.
2. The frontend chooses the last visible point from `visibleRange.to`, not the cursor or the live day-max cache.
3. The old multi-day segment renderer is removed from the render path, so only one line can appear for the viewport anchor.
4. The ask-peak indicator remains controllable from the live indicator panel and persists like the other live indicators.
5. `ask_peaks` no longer participates in the live render path once the viewport series is live.
