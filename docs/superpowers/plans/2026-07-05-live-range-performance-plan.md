# Live Range Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live study chart show candles first, keep heavy sidecar work from blocking first paint, avoid repeated whole-range fetches on historical pans where it is worth the complexity, and cache hogaplay-derived candles in memory only after measuring the lighter candle path.

**Architecture:** Keep `/api/range` as the canonical parquet read path, but split its work by intent. Add a backend `mode=candles` that returns only `segments` and `candles`, make the frontend request Hogaplay Candle Fallback separately from hoga and sidecar, then measure before adding client-side historical range stitching or a backend in-memory cache.

**Tech Stack:** FastAPI, Pydantic response models, DuckDB/parquet readers, React, TanStack Query, Vitest, pytest.

## Global Constraints

- KIS REST bypass ON must not call KIS REST.
- Do not write KIS candle cache to disk.
- `mode=candles` is Hogaplay Candle Fallback 경량화, not KIS candle integration.
- Existing `/api/range` response shape remains `RangeBundle`.
- `mode=full`, `mode=hoga`, and `mode=sidecar` must remain backward compatible.
- `mode=candles` returns a valid `RangeBundle` with non-candle fields empty.
- First visible chart paint should depend on candles, not sidecar.
- Historical left-pan should avoid re-requesting already fetched immutable past ranges only if the added stitching complexity is justified by post-`mode=candles` measurements.
- Today-inclusive ranges may still refetch on the existing 5-minute cadence.

---

## Baseline

Measured locally for `005930`, `bucket_ms=180000`, `source_pref=hogaplay_first`:

```text
2026-06-25 ~ 2026-07-05
mode=full     1.14s / 6.3MB
mode=hoga     0.03s / 0.18MB
mode=sidecar  0.75s / 6.0MB

2026-05-10 ~ 2026-07-05
mode=full     3.43s / 18.6MB
mode=hoga     0.11s / 0.7MB
mode=sidecar  2.50s / 17.5MB
```

Main bottlenecks:

- `mode=full`: reads hogaplay `candles.parquet`, downsamples into chart candles, and also computes extra full-mode payload.
- `mode=sidecar`: computes and returns heavy overlays such as volume distributions, POC, program trade.
- `mode=hoga`: not a bottleneck in the measured path.

Post-Task-4 warm measurement on a current-worktree server at `127.0.0.1:8001`:

```text
2026-05-10 ~ 2026-07-05
mode=candles  0.21s / 0.4MB
mode=full     3.53s / 18.6MB
mode=sidecar  2.55s / 17.5MB
```

Interpretation: Phase A removes `full` from the first candle path effectively. The remaining large request is `sidecar`, so Phase C should start from sidecar/incremental strategy rather than candle-only stitching.

## Grilling Decisions

- `mode=candles` stays inside `GET /api/range`; no new endpoint and no new wire. This preserves ADR-0013's RangeBundle read-path boundary.
- `mode=candles` is scoped to **Hogaplay Candle Fallback**. It does not move KIS candles into `/api/range`, does not read **KIS Candle Cache**, and does not supersede ADR-0040/0048.
- Sidecar lazy loading means render-lazy, not necessarily request-delayed: the sidecar request may start in parallel, but candles must render without waiting for sidecar data.
- Incremental historical fetch is a separate Phase C design, not a direct follow-up patch. It must cover the source that still dominates after Phase A measurement: candles, hoga, sidecar, or all three. Candle-only stitching is insufficient if sidecar remains the largest whole-range request.
- Hogaplay candle memory cache is a Phase D optimization for `mode=candles` first. Because `mode=full` reuses raw candle rows for other calculations, broadening the cache beyond candle fallback needs separate evidence and tests.

## File Map

- Modify `hoga/api/routes.py`: accept `mode=candles` in `/api/range`.
- Modify `hoga/api/bundle.py`: implement candle-only mode inside `build_range_bundle`.
- Modify `frontend/src/api/rangeRequest.ts`: add `'candles'` to `RangeMode`.
- Modify `frontend/src/api/range.test.tsx`: assert `mode=candles` URL and query key behavior.
- Modify `frontend/src/live/useLiveBundle.ts`: request candle fallback through `mode=candles`; keep sidecar independent and non-blocking.
- Modify `frontend/src/live/useLiveBundle.test.tsx`: verify KIS bypass + minute fallback requests candle mode and does not require sidecar for candle output.
- Create `frontend/src/api/rangeCoverage.ts`: pure helpers for incremental date-range gap planning and merge, only in Phase C.
- Create `frontend/src/api/rangeCoverage.test.ts`: unit tests for immutable historical range stitching, only in Phase C.
- Create `hoga/api/candle_cache.py`: bounded in-memory cache for downsampled hogaplay candles, only in Phase D after measurement.
- Modify `tests/hoga/api/test_bundle.py`: backend tests for `mode=candles` and candle cache behavior.

## Task 1: Add Backend `mode=candles`

**Files:**
- Modify: `hoga/api/routes.py`
- Modify: `hoga/api/bundle.py`
- Test: `tests/hoga/api/test_bundle.py`

**Interfaces:**
- Consumes: existing `build_range_bundle(engine, ..., mode: str) -> RangeBundle`.
- Produces: `mode="candles"` support. Response includes `segments`, `candles`, `excluded_dates`, `data_warnings`; all hoga/sidecar/full-only fields are empty.

- [ ] **Step 1: Write failing backend test for candle-only mode**

Add a test that patches heavy builders and asserts candle-only mode skips them:

```python
def test_build_range_bundle_candles_mode_skips_hoga_and_sidecar_builders():
    from hoga.api.bundle import build_range_bundle

    engine = _range_engine_with_one_valid_day(
        code="005930",
        date="20260625",
        source="hogaplay",
    )

    with (
        patch("hoga.api.bundle.build_candles_slice", return_value=[
            _c(1_772_000_000_000, 100, 110, 90, 105, 1, 2),
        ]) as candles,
        patch("hoga.api.bundle.build_quote_ratio_slice") as quote_ratio,
        patch("hoga.api.bundle.build_fill_strength_slice") as fill_strength,
        patch("hoga.api.bundle.build_volume_profile_slice") as volume_profile,
        patch("hoga.api.bundle.build_volume_distribution_slice") as distribution,
        patch("hoga.api.bundle.build_trade_volume_poc_slice") as poc,
        patch("hoga.api.bundle.build_program_trade_series") as program,
    ):
        bundle = build_range_bundle(
            engine,
            code="005930",
            from_date="20260625",
            to_date="20260625",
            bucket_ms=60_000,
            source_pref="hogaplay_first",
            mode="candles",
        )

    candles.assert_called_once()
    quote_ratio.assert_not_called()
    fill_strength.assert_not_called()
    volume_profile.assert_not_called()
    distribution.assert_not_called()
    poc.assert_not_called()
    program.assert_not_called()
    assert len(bundle.segments) == 1
    assert len(bundle.candles) == 1
    assert bundle.quote_ratio.points == []
    assert bundle.fill_strength.points == []
    assert bundle.volume_distributions == []
    assert bundle.trade_volume_pocs == []
    assert bundle.program_trade.points == []
```

If `_range_engine_with_one_valid_day` does not exist, add a small local fixture in `tests/hoga/api/test_bundle.py` using `MagicMock` with:

```python
engine.list_stock_dates_in_range.return_value = ["20260625"]
engine.list_stock_dates.return_value = []
engine.indicators_cache = None
engine.get_meta.return_value = {
    "regular_session_open_ms": 90_000_000,
    "regular_session_close_ms": 153_000_000,
    "today_open": 100,
}
```

- [ ] **Step 2: Run failing backend test**

Run:

```bash
pytest tests/hoga/api/test_bundle.py::test_build_range_bundle_candles_mode_skips_hoga_and_sidecar_builders -q
```

Expected: fail because `mode="candles"` is not recognized as a special mode and heavy builders are still called.

- [ ] **Step 3: Implement candle-only flags in `hoga/api/bundle.py`**

Add:

```python
candles_only = mode == "candles"
```

Then update conditions:

```python
raw_candles = [] if hoga_only else build_candles_slice(engine, code=code, date=d, source=source)
```

stays as-is, because candle-only still needs raw candles.

Change hoga/sidecar builders to skip on `candles_only`:

```python
qr_d = (
    QuoteRatio(bucket_ms=bucket_ms, points=[])
    if sidecar_only or candles_only
    else build_quote_ratio_slice(...)
)
fs_d = (
    FillStrength(bucket_ms=bucket_ms, points=[])
    if sidecar_only or candles_only
    else build_fill_strength_slice(...)
)
vp_d = build_volume_profile_slice(...) if full_mode else None
continuous_before_ms = (
    None
    if hoga_only or candles_only
    else _first_trailing_single_price_book_hhmmssms(...)
)
if hoga_only or cutoff_sidecar or candles_only:
    ap_d = None
    bp_d = None
```

Change other optional builders:

```python
tvp_d = None if hoga_only or cutoff_sidecar or candles_only else build_trade_volume_poc_slice(...)

if not hoga_only and not cutoff_sidecar and not candles_only and broker_late_entries_enabled:
    broker_late_entries.extend(...)

if not hoga_only and not candles_only and volume_distribution_bins is not None:
    profile = build_volume_distribution_slice(...)
```

Keep `segments.append(...)`, `included_dates.append(d)`, and `candles.extend(candles_d)`.

Return empty program trade for candle-only:

```python
program_trade=(
    build_program_trade_series(engine, code=code, dates=included_dates)
    if full_mode or sidecar_only
    else ProgramTradeSeries(points=[])
)
```

This line already returns empty for candle-only if `full_mode` and `sidecar_only` are both false.

- [ ] **Step 4: Accept mode in route**

In `hoga/api/routes.py`, change:

```python
mode: str = Query(..., pattern="^(full|hoga|sidecar)$"),
```

to:

```python
mode: str = Query(..., pattern="^(full|hoga|sidecar|candles)$"),
```

- [ ] **Step 5: Verify backend**

Run:

```bash
pytest tests/hoga/api/test_bundle.py::test_build_range_bundle_candles_mode_skips_hoga_and_sidecar_builders -q
pytest tests/test_api_range.py tests/unit/api/test_bundle_source.py tests/unit/api/test_bundle_source_aware.py -q
```

Expected: all pass.

## Task 2: Add Frontend `mode=candles` Request Type

**Files:**
- Modify: `frontend/src/api/rangeRequest.ts`
- Modify: `frontend/src/api/range.test.tsx`

**Interfaces:**
- Consumes: backend `mode=candles`.
- Produces: `RangeMode = 'full' | 'hoga' | 'sidecar' | 'candles'`.

- [ ] **Step 1: Write failing frontend request test**

Add to `frontend/src/api/range.test.tsx`:

```tsx
it('adds mode=candles for lightweight candle requests', () => {
  const request = buildRangeBundleRequest({
    code: '005930',
    from: '20260625',
    to: '20260705',
    timeframe: '3m',
    sourcePref: 'hogaplay_first',
    options: { mode: 'candles' },
  });

  expect(request.enabled).toBe(true);
  expect(request.url).toBe(
    '/api/range?code=005930&from=20260625&to=20260705'
      + '&bucket_ms=180000&source_pref=hogaplay_first&mode=candles',
  );
  expect(request.queryKey[14]).toBe('candles');
});
```

- [ ] **Step 2: Run failing frontend test**

Run:

```bash
cd frontend && npm test -- range.test.tsx
```

Expected: TypeScript/Vitest fails because `'candles'` is not assignable to `RangeMode`.

- [ ] **Step 3: Extend `RangeMode`**

In `frontend/src/api/rangeRequest.ts`, change:

```ts
export type RangeMode = 'full' | 'hoga' | 'sidecar';
```

to:

```ts
export type RangeMode = 'full' | 'hoga' | 'sidecar' | 'candles';
```

- [ ] **Step 4: Verify frontend request tests**

Run:

```bash
cd frontend && npm test -- range.test.tsx
```

Expected: pass.

## Task 3: Use `mode=candles` for Candle Fallback

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/live/useLiveBundle.test.tsx`

**Interfaces:**
- Consumes: `useRange(..., options: { mode: 'candles' })`.
- Produces: KIS-bypass or hogaplay candle fallback no longer uses `mode=full`.

- [ ] **Step 1: Write failing live bundle test**

Add to `frontend/src/live/useLiveBundle.test.tsx`:

```tsx
it('uses mode=candles for minute fallback when KIS REST bypass is enabled', () => {
  candlesMock.candles = [];
  useCandleDataPreferenceStore.setState({ candleDataPreference: 'auto' });
  useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay_first' });

  renderUseLiveBundle({
    timeframe: '1m',
    settings: { kis_rest_bypass_enabled: true },
    rangeCandles: [
      { ts_ms: 1_779_840_000_000, open: 71_000, high: 71_300, low: 70_900, close: 71_234, vol_a: 1000, vol_b: 0 },
    ],
  });

  const modes = useRangeSpy.mock.calls.map((call) => (call[6] as { mode?: string } | undefined)?.mode);
  expect(modes).toContain('candles');
  expect(modes).not.toContain('full');
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cd frontend && npm test -- useLiveBundle.test.tsx
```

Expected: fail because the fallback still uses `mode: 'full'`.

- [ ] **Step 3: Change candle fallback options**

In `frontend/src/live/useLiveBundle.ts`, change:

```ts
const candleFallbackOptions = useMemo(
  () => ({
    mode: 'full' as const,
    brokerLateEntriesEnabled: false,
    brokerLateEntryStartHHMM: null,
    volumeDistributionBins: null,
    tradeVolumePocBins: null,
    volumeDistributionPriceRange: null,
  }),
  [],
);
```

to:

```ts
const candleFallbackOptions = useMemo(
  () => ({
    mode: 'candles' as const,
    brokerLateEntriesEnabled: false,
    brokerLateEntryStartHHMM: null,
    volumeDistributionBins: null,
    tradeVolumePocBins: null,
    volumeDistributionPriceRange: null,
  }),
  [],
);
```

- [ ] **Step 4: Update test mock to handle candle mode**

In the `renderUseLiveBundle` helper, change:

```ts
if (options?.mode === 'full') {
```

to:

```ts
if (options?.mode === 'candles' || options?.mode === 'full') {
```

- [ ] **Step 5: Verify live bundle tests**

Run:

```bash
cd frontend && npm test -- useLiveBundle.test.tsx
```

Expected: pass.

## Task 4: Make Sidecar Lazy Relative to First Candle Paint

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/live/useLiveBundle.test.tsx`

**Interfaces:**
- Consumes: candle fallback data from `mode=candles`, hoga data from `mode=hoga`, sidecar data from `mode=sidecar`.
- Produces: `chartBundle` can be computed from candles and hoga segments before `pastSidecars.data` exists.

- [ ] **Step 1: Write test proving candles render without sidecar**

Add:

```tsx
it('returns a chart bundle with fallback candles before sidecar data arrives', () => {
  candlesMock.candles = [];
  useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay_first' });

  useRangeSpy.mockImplementation((...args: unknown[]) => {
    const options = args[6] as { mode?: string } | undefined;
    if (options?.mode === 'candles') {
      return rangeResult({
        ...fallbackRangeBundle(71_234),
        candles: [
          { ts_ms: 1_779_840_000_000, open: 71_000, high: 71_300, low: 70_900, close: 71_234, vol_a: 1000, vol_b: 0 },
        ],
      });
    }
    if (options?.mode === 'hoga') {
      return rangeResult(fallbackRangeBundle(71_234));
    }
    if (options?.mode === 'sidecar') {
      return { data: null, isLoading: true, error: null, isPlaceholderData: false, isFetching: true };
    }
    return rangeResult();
  });

  const result = renderHook(
    () => useLiveBundle('005930', '1m', '20260527', liveFixture),
    { wrapper: createWrapper({ kis_rest_bypass_enabled: true }) },
  ).result.current;

  expect(result.bundle?.candles.length).toBeGreaterThan(0);
  expect(result.bundle?.trade_volume_pocs ?? []).toEqual([]);
  expect(result.bundle?.volume_distributions ?? []).toEqual([]);
});
```

- [ ] **Step 2: Run test**

Run:

```bash
cd frontend && npm test -- useLiveBundle.test.tsx
```

Expected: pass if current composition is already non-blocking; fail if the extension gate or bundle construction still waits for sidecar.

- [ ] **Step 3: If the test fails, remove sidecar from extension gate**

Keep the `extending` gate scoped to candle and hoga sources only. Do not add `pastSidecars` into the gate. The expected shape is:

```ts
const extending = historicalFromDate != null && (isMinute
  ? (pastHoga.isPlaceholderData && pastHoga.isFetching) ||
    (pastCandlesQuery.isPlaceholderData && pastCandlesQuery.isFetching)
  : (pastDailyCandlesQuery.isPlaceholderData && pastDailyCandlesQuery.isFetching) ||
    (screenerDailyCandlesQuery.isPlaceholderData && screenerDailyCandlesQuery.isFetching));
```

- [ ] **Step 4: Ensure sidecar only enriches an existing bundle**

Keep this pattern:

```ts
const sidecarSource = pastSidecars.data ?? null;
if (sidecarSource) {
  built.ask_peaks = sidecarSource.ask_peaks ?? [];
  built.bid_peaks = sidecarSource.bid_peaks ?? [];
  built.broker_late_entries = sidecarSource.broker_late_entries ?? [];
  built.trade_volume_pocs = sidecarSource.trade_volume_pocs ?? [];
  built.volume_distributions = sidecarSource.volume_distributions ?? [];
  built.program_trade = filterProgramTradeForCandles(sidecarSource.program_trade, liveCandles);
}
```

If this already matches the code, the task is a test-only safety net after Task 3.

- [ ] **Step 5: Verify with local timing**

Run the app and measure first candle response separately from sidecar:

```bash
curl -sS -o /tmp/candles.json -w 'candles time=%{time_total}s size=%{size_download}B\n' \
  'http://127.0.0.1:8000/api/range?code=005930&from=20260510&to=20260705&bucket_ms=180000&source_pref=hogaplay_first&mode=candles'

curl -sS -o /tmp/sidecar.json -w 'sidecar time=%{time_total}s size=%{size_download}B\n' \
  'http://127.0.0.1:8000/api/range?code=005930&from=20260510&to=20260705&bucket_ms=180000&source_pref=hogaplay_first&mode=sidecar'
```

Expected: candles response is smaller and arrives before sidecar. Total sidecar completion time may remain similar.

## Task 5: Phase C Candidate — Design Incremental Historical Range Fetching

**Files:**
- Create: `frontend/src/api/rangeCoverage.ts`
- Create: `frontend/src/api/rangeCoverage.test.ts`

**Interfaces:**
- Produces, if Phase C measurement justifies client-side stitching:
  - `type DateRange = { from: string; to: string }`
  - `planMissingHistoricalRange(requested: DateRange, covered: DateRange | null): DateRange | null`
  - `mergeCoveredRange(existing: DateRange | null, added: DateRange): DateRange`

- [ ] **Step 1: Re-measure after Tasks 1-4 before writing helper tests**

Run:

```bash
curl -sS -o /tmp/candles.json -w 'candles time=%{time_total}s size=%{size_download}B\n' \
  'http://127.0.0.1:8000/api/range?code=005930&from=20260510&to=20260705&bucket_ms=180000&source_pref=hogaplay_first&mode=candles'
curl -sS -o /tmp/hoga.json -w 'hoga time=%{time_total}s size=%{size_download}B\n' \
  'http://127.0.0.1:8000/api/range?code=005930&from=20260510&to=20260705&bucket_ms=180000&source_pref=hogaplay_first&mode=hoga'
curl -sS -o /tmp/sidecar.json -w 'sidecar time=%{time_total}s size=%{size_download}B\n' \
  'http://127.0.0.1:8000/api/range?code=005930&from=20260510&to=20260705&bucket_ms=180000&source_pref=hogaplay_first&mode=sidecar'
```

Expected: choose the incremental target from evidence. If sidecar still dominates, do not implement candle-only stitching as the Phase C fix.

- [ ] **Step 2: Write helper tests**

Create `frontend/src/api/rangeCoverage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  mergeCoveredRange,
  planMissingHistoricalRange,
  type DateRange,
} from './rangeCoverage';

describe('rangeCoverage', () => {
  it('requests the full range when nothing is covered', () => {
    expect(planMissingHistoricalRange(
      { from: '20260610', to: '20260705' },
      null,
    )).toEqual({ from: '20260610', to: '20260705' });
  });

  it('requests only the newly prepended left range', () => {
    expect(planMissingHistoricalRange(
      { from: '20260610', to: '20260705' },
      { from: '20260625', to: '20260705' },
    )).toEqual({ from: '20260610', to: '20260624' });
  });

  it('returns null when requested range is already covered', () => {
    expect(planMissingHistoricalRange(
      { from: '20260625', to: '20260705' },
      { from: '20260610', to: '20260705' },
    )).toBeNull();
  });

  it('merges covered ranges by outer bounds', () => {
    const existing: DateRange = { from: '20260625', to: '20260705' };
    expect(mergeCoveredRange(existing, { from: '20260610', to: '20260624' }))
      .toEqual({ from: '20260610', to: '20260705' });
  });
});
```

- [ ] **Step 3: Run failing helper tests**

Run:

```bash
cd frontend && npm test -- rangeCoverage.test.ts
```

Expected: fail because file does not exist.

- [ ] **Step 4: Implement helper**

Create `frontend/src/api/rangeCoverage.ts`:

```ts
export type DateRange = { from: string; to: string };

function previousYyyymmdd(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  const utc = Date.UTC(y, m - 1, d);
  const prev = new Date(utc - 24 * 60 * 60 * 1000);
  const yy = String(prev.getUTCFullYear()).padStart(4, '0');
  const mm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(prev.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export function planMissingHistoricalRange(
  requested: DateRange,
  covered: DateRange | null,
): DateRange | null {
  if (covered == null) return requested;
  if (requested.from >= covered.from && requested.to <= covered.to) return null;
  if (requested.from < covered.from && requested.to <= covered.to) {
    return { from: requested.from, to: previousYyyymmdd(covered.from) };
  }
  return requested;
}

export function mergeCoveredRange(
  existing: DateRange | null,
  added: DateRange,
): DateRange {
  if (existing == null) return added;
  return {
    from: existing.from < added.from ? existing.from : added.from,
    to: existing.to > added.to ? existing.to : added.to,
  };
}
```

- [ ] **Step 5: Verify helper**

Run:

```bash
cd frontend && npm test -- rangeCoverage.test.ts
```

Expected: pass.

## Task 6: Phase C Candidate — Apply Incremental Fetch to the Measured Bottleneck

**Files:**
- Modify: `frontend/src/live/useLiveBundle.ts`
- Modify: `frontend/src/live/useLiveBundle.test.tsx`

**Interfaces:**
- Consumes: Phase C decision from Task 5 and, if selected, `planMissingHistoricalRange` and `mergeCoveredRange`.
- Produces: left-pan requests fetch only the newly needed historical date window for the measured bottleneck source. Do not implement candle-only stitching if sidecar remains the dominant whole-range request.

- [ ] **Step 1: Add test for left-pan range shrinking**

Add a test that renders once with default range, then sets `historicalFromDate` earlier and verifies the next candle-mode call uses only the missing left window:

```tsx
it('plans only the newly missing left range after historical extension', () => {
  useSourcePreferenceStore.setState({ sourcePreference: 'hogaplay_first' });
  candlesMock.candles = [];

  const { rerender } = renderHook(
    () => useLiveBundle('005930', '1m', '20260705', liveFixture),
    { wrapper: createWrapper({ kis_rest_bypass_enabled: true }) },
  );

  useRangeSpy.mockClear();
  useLivePageStore.setState({ historicalFromDate: '20260610' });
  rerender();

  const candleCalls = useRangeSpy.mock.calls.filter((call) => {
    const options = call[6] as { mode?: string } | undefined;
    return options?.mode === 'candles';
  });
  expect(candleCalls.length).toBeGreaterThan(0);
  expect(candleCalls.at(-1)?.[2]).toBeLessThan('20260705');
});
```

This test is intentionally behavioral: it catches accidental whole-range re-fetching without coupling to the exact initial default date.

- [ ] **Step 2: Run failing test**

Run:

```bash
cd frontend && npm test -- useLiveBundle.test.tsx
```

Expected: fail because current calls pass the whole requested range.

- [ ] **Step 3: Add covered-range refs**

In `useLiveBundle`, add refs per code/timeframe/source/mode:

```ts
const candleCoverageRef = useRef<{ key: string; from: string; to: string } | null>(null);
```

Build a stable key:

```ts
const candleCoverageKey = `${code ?? ''}|${timeframe}|${sourcePreference}|${venue}`;
```

Reset when key changes:

```ts
useEffect(() => {
  candleCoverageRef.current = null;
}, [candleCoverageKey]);
```

- [ ] **Step 4: Plan missing candle range**

Compute:

```ts
const requestedCandleRange = candleFallbackNeeded
  ? { from: isMinute ? minutePastFrom : dailyPastFrom, to: isMinute ? minutePastTo : dailyPastTo }
  : null;
const coveredCandleRange = candleCoverageRef.current?.key === candleCoverageKey
  ? { from: candleCoverageRef.current.from, to: candleCoverageRef.current.to }
  : null;
const missingCandleRange = requestedCandleRange
  ? planMissingHistoricalRange(requestedCandleRange, coveredCandleRange)
  : null;
```

Pass `missingCandleRange.from` and `missingCandleRange.to` into the candle fallback `useRange`.

- [ ] **Step 5: Merge coverage after successful data**

Add:

```ts
useEffect(() => {
  if (!missingCandleRange || !candleFallback.data) return;
  const merged = mergeCoveredRange(coveredCandleRange, missingCandleRange);
  candleCoverageRef.current = {
    key: candleCoverageKey,
    from: merged.from,
    to: merged.to,
  };
}, [candleCoverageKey, coveredCandleRange, missingCandleRange, candleFallback.data]);
```

If dependency stability becomes noisy, store `coveredCandleRange` as primitive strings before the effect.

- [ ] **Step 6: Preserve displayed candles while fetching gaps**

Use TanStack Query cache or a local ref to keep previously received candle fallback bundles and merge new prepended candles by timestamp. The merged data must feed `selectedRangeFallback`.

Expected merge logic:

```ts
function mergeRangeCandlesByTs(
  older: RangeBundle | null,
  newer: RangeBundle | null,
): RangeBundle | null {
  if (!older) return newer;
  if (!newer) return older;
  const byTs = new Map<number, RangeBundle['candles'][number]>();
  for (const candle of older.candles) byTs.set(candle.ts_ms, candle);
  for (const candle of newer.candles) byTs.set(candle.ts_ms, candle);
  return {
    ...newer,
    from_date: older.from_date < newer.from_date ? older.from_date : newer.from_date,
    to_date: older.to_date > newer.to_date ? older.to_date : newer.to_date,
    segments: [...older.segments, ...newer.segments]
      .filter((segment, index, arr) => arr.findIndex((s) => s.date === segment.date) === index)
      .sort((a, b) => a.date.localeCompare(b.date)),
    candles: Array.from(byTs.values()).sort((a, b) => a.ts_ms - b.ts_ms),
  };
}
```

- [ ] **Step 7: Verify frontend**

Run:

```bash
cd frontend && npm test -- useLiveBundle.test.tsx rangeCoverage.test.ts
```

Expected: pass.

## Task 7: Add Hogaplay Candle Memory Cache

**Files:**
- Create: `hoga/api/candle_cache.py`
- Modify: `hoga/api/queries.py`
- Modify: `hoga/api/bundle.py`
- Test: `tests/hoga/api/test_bundle.py`

**Interfaces:**
- Produces: `HogaplayCandleCache.get(key)`, `HogaplayCandleCache.set(key, value)`.
- Cache key: `(code, date, source, bucket_ms)`.
- Cached value: downsampled list of `ApiCandle`.
- Initial use site: `mode="candles"` and `source == "hogaplay"` only.

- [ ] **Step 1: Write failing cache test**

Add:

```python
def test_candles_mode_reuses_downsampled_hogaplay_candles_from_memory_cache():
    from hoga.api.bundle import build_range_bundle

    engine = _range_engine_with_one_valid_day(
        code="005930",
        date="20260625",
        source="hogaplay",
    )
    from hoga.api.candle_cache import HogaplayCandleCache

    engine.candle_cache = HogaplayCandleCache()

    with patch("hoga.api.bundle.build_candles_slice", return_value=[
        _c(1_772_000_000_000, 100, 110, 90, 105, 1, 2),
    ]) as candles:
        build_range_bundle(
            engine,
            code="005930",
            from_date="20260625",
            to_date="20260625",
            bucket_ms=60_000,
            source_pref="hogaplay_first",
            mode="candles",
        )
        build_range_bundle(
            engine,
            code="005930",
            from_date="20260625",
            to_date="20260625",
            bucket_ms=60_000,
            source_pref="hogaplay_first",
            mode="candles",
        )

    assert candles.call_count == 1
```

- [ ] **Step 2: Run failing cache test**

Run:

```bash
pytest tests/hoga/api/test_bundle.py::test_candles_mode_reuses_downsampled_hogaplay_candles_from_memory_cache -q
```

Expected: fail because cache does not exist.

- [ ] **Step 3: Implement cache class**

Create `hoga/api/candle_cache.py`:

```python
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass

from hoga.tables.candles import ApiCandle


@dataclass(frozen=True)
class CandleCacheKey:
    code: str
    date: str
    source: str
    bucket_ms: int


class HogaplayCandleCache:
    def __init__(self, max_entries: int = 2048) -> None:
        self.max_entries = max_entries
        self._items: OrderedDict[CandleCacheKey, list[ApiCandle]] = OrderedDict()

    def get(self, key: CandleCacheKey) -> list[ApiCandle] | None:
        value = self._items.get(key)
        if value is None:
            return None
        self._items.move_to_end(key)
        return list(value)

    def set(self, key: CandleCacheKey, value: list[ApiCandle]) -> None:
        self._items[key] = list(value)
        self._items.move_to_end(key)
        while len(self._items) > self.max_entries:
            self._items.popitem(last=False)
```

- [ ] **Step 4: Attach cache to query engine**

In `hoga/api/queries.py`, initialize:

```python
from hoga.api.candle_cache import HogaplayCandleCache
```

and on `QueryEngine.__init__`:

```python
self.candle_cache = HogaplayCandleCache()
```

- [ ] **Step 5: Use cache in `build_range_bundle` for candle-only mode**

In `hoga/api/bundle.py`, import:

```python
from hoga.api.candle_cache import CandleCacheKey
```

For `mode="candles"`, check the cache before reading `candles.parquet`:

```python
if hoga_only:
    candles_d = []
elif sidecar_only:
    candles_d = []
elif candles_only and source == "hogaplay":
    cache = getattr(engine, "candle_cache", None)
    cache_key = CandleCacheKey(code=code, date=d, source=source, bucket_ms=bucket_ms)
    cached = cache.get(cache_key) if cache is not None else None
    if cached is not None:
        candles_d = cached
    else:
        raw_candles = build_candles_slice(engine, code=code, date=d, source=source)
        candles_d = downsample_candles(raw_candles, bucket_ms=bucket_ms)
        if cache is not None:
            cache.set(cache_key, candles_d)
else:
    raw_candles = build_candles_slice(engine, code=code, date=d, source=source)
    candles_d = downsample_candles(raw_candles, bucket_ms=bucket_ms)
```

This requires moving the unconditional `raw_candles = ...` call below the cache branch so a cache hit can avoid the parquet read.

- [ ] **Step 6: Verify backend cache**

Run:

```bash
pytest tests/hoga/api/test_bundle.py::test_candles_mode_reuses_downsampled_hogaplay_candles_from_memory_cache -q
pytest tests/hoga/api/test_bundle.py -q
```

Expected: pass.

## Task 8: Final Performance Verification

**Files:**
- No source changes.

**Interfaces:**
- Verifies `mode=candles`, sidecar separation, and cache effects.

- [ ] **Step 1: Run backend and frontend unit tests**

Run:

```bash
pytest tests/hoga/api/test_bundle.py tests/test_api_range.py tests/unit/api/test_bundle_source.py tests/unit/api/test_bundle_source_aware.py -q
cd frontend && npm test -- range.test.tsx rangeCoverage.test.ts useLiveBundle.test.tsx
```

Expected: pass.

- [ ] **Step 2: Measure API timings before and after warm cache**

Run twice:

```bash
for i in 1 2; do
  echo "run=$i"
  curl -sS -o /tmp/candles.json -w 'candles time=%{time_total}s size=%{size_download}B\n' \
    'http://127.0.0.1:8000/api/range?code=005930&from=20260510&to=20260705&bucket_ms=180000&source_pref=hogaplay_first&mode=candles'
  curl -sS -o /tmp/sidecar.json -w 'sidecar time=%{time_total}s size=%{size_download}B\n' \
    'http://127.0.0.1:8000/api/range?code=005930&from=20260510&to=20260705&bucket_ms=180000&source_pref=hogaplay_first&mode=sidecar'
done
```

Expected:

- `mode=candles` payload is much smaller than old `mode=full`.
- Second `mode=candles` run is faster or no worse after memory cache warm-up.
- `mode=sidecar` may remain similar, but no longer blocks first candle display.

- [ ] **Step 3: Browser QA**

With KIS REST bypass ON, candle data 기준 `자동`, 호가·체결 기준 `hogaplay`:

```text
1. Open live study page.
2. Select 005930.
3. Use 3m timeframe.
4. Pan left twice.
5. Confirm candles appear before sidecar overlays.
6. Confirm no KIS REST transport logs appear.
7. Confirm no blank candle chart during sidecar loading.
```

## Execution Order

Recommended PR split:

1. PR A: Tasks 1-3. Adds `mode=candles` and switches candle fallback to it.
2. PR B: Task 4. Locks in sidecar lazy behavior with tests.
3. PR C: Tasks 5-6 only after re-measurement. Adds incremental historical range fetching for the measured bottleneck source, not automatically candle-only.
4. PR D: Task 7 only after re-measurement. Adds hogaplay candle memory cache if `mode=candles` remains slow after sidecar is decoupled.
5. PR E or final verification commit: Task 8 measurements and any small follow-up fixes.

If doing one PR, keep commits in the same order so regressions are easy to bisect.

## Self-Review

- Spec coverage: all four requested items are covered by Tasks 1-7.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: frontend mode name is consistently `candles`; backend mode name is consistently `"candles"`; cache key uses `(code, date, source, bucket_ms)`.
- Scope check: KIS candles are not moved into parquet and no disk cache is introduced.
