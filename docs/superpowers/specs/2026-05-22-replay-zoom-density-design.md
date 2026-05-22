# Replay Viewer Zoom, Density & Multi-Day Range — Design

**Date:** 2026-05-22
**Status:** Design (pending implementation plan)
**Scope:** Replay Viewer page (`/replay`) — chart zoom behavior, x-axis labeling, multi-day Stock-Date Range, multi-timeframe candle aggregation.

---

## 1. Context and Why

The Replay Viewer today suffers three observable problems:

1. **Initial zoom shows <50% of a single trading day.** Default `barSpacing=8` + `rightOffset=15` (from `util/chartScale.ts`, intentional 1.25× density per DESIGN.md) combined with no `fitContent()` call mean a 1920×1080 monitor with the 400px sidebar shows only ~162 of the 390 one-minute candles per day. On a 1366px laptop, ~93. Mouse-wheel zoom-out is cursor-centered and doesn't help users see the full day without repeated drag-left.
2. **The viewer is locked to a single Stock-Date.** `Workarea.tsx:21` discards `toDate` (`// MVP: single-day only`) even though `TabSelection` and `DateRangePicker` already carry `fromDate`/`toDate`. Users cannot view a multi-day period in one chart.
3. **The x-axis shows incorrect dates/times.** The chart uses a Virtual Axis (`util/time.ts`) that stitches Stock-Dates into a continuous ms timeline. lightweight-charts receives those virtual-ms and renders labels as if they were "1970-01-01 00:00 UTC + virtualMs" — i.e. fake epoch-based timestamps unrelated to KST trading times.

This spec defines a multi-day, multi-timeframe replay viewer with a TradingView-style zoom model, plus the x-axis fix.

## 2. Glossary Status (CONTEXT.md updates)

Three new compounds and one updated entry landed in CONTEXT.md as part of this design (committed alongside this spec). For canonical definitions, see CONTEXT.md directly; the brief versions:

- **Stock-Date Range** (new) — `(Code, fromDate, toDate)` bounding N consecutive **Stock-Date**s (N ≥ 1). The unit the Replay Viewer operates on.
- **RangeBundle** (new, replaces `SessionBundle`) — sole read-path Wire Model for a **Stock-Date Range**. Bundles five pre-aggregated series at the requested **Timeframe** plus a `segments` array. See ADR-0013.
- **Timeframe** (new) — Chart candle time resolution; six fixed values (1m/3m/5m/10m/15m/30m). All five RangeBundle series share the same Timeframe. See ADR-0014.
- **Auction Window** (updated) — definition generalised: each Stock-Date in a multi-day Range has its own opening/closing auction windows. Frontend consumers must compute thresholds per segment, not from a single global `session_open_ms`.
- **Day Boundary** (new) — the non-trading gap between two adjacent **Stock-Date**s in a Range. Compressed to zero width on the virtual axis but surfaced visually as a vertical line + `MM/DD` chip.

**Not in CONTEXT.md** (implementation detail, kept here + in code comments):

- **Virtual Axis Label formatting** — lightweight-charts receives virtual-ms (offset from epoch 1970) on the time axis, so raw labels are meaningless. The viewer installs a custom `timeScale.tickMarkFormatter` that converts virtual-ms → real Unix-ms via `virtualToReal(segments, …)` and formats in KST. The `tickMarkFormatter` implementation in `ChartStage.tsx` carries the rationale in a code comment; this is a library quirk fix, not a domain concept.

## 3. User-Facing Behavior

### Toolbar
- A new **TimeframeSelector** segmented control (`[1m] [3m] [5m] [10m] [15m] [30m]`) sits to the right of `DateRangePicker`.
- The selector edits the toolbar **draft** (not the committed selection) — same pattern as code and dates. The active **데이터 불러오기 / Reload** button commits the draft.
- Default Timeframe for a new tab: `1m`.

### Chart
- On data load, the chart auto-fits the full Stock-Date Range (every candle in `[fromDate, toDate]`).
- Mouse-wheel and pinch zoom are enabled. Drag-pan is enabled.
- **Zoom-out is clamped** to the Stock-Date Range: the user cannot scroll past the first or last candle. Visually, no grey empty area beyond data.
- **Zoom-in is clamped** at `barSpacing = 50 px` (one candle takes at most ~50px wide).
- **Timeframe switch preserves the time window**: if the user is looking at 10:00–11:00 KST on 5/19 at 5m, switching to 1m keeps the same 10:00–11:00 window (zooms in by 5×).
- A vertical "day boundary" line with a `MM/DD` chip is rendered at every `segments[i+1].virtualStart`. Single-day Stock-Date Ranges have no boundary line.
- X-axis labels adapt to zoom level: KST `HH:MM` when intraday is visible, `HH:MM:SS` when seconds are visible, `MM/DD` when zoomed out across days.

### Volume Profile
- A toggle (sidebar position) switches between two modes:
  - **range** (default): a single profile covering the entire Stock-Date Range — long-window POC for the period.
  - **day**: one profile per Stock-Date, drawn side-by-side along the left of each segment.

### Errors
- Empty Stock-Date Range (no captured Stock-Date in `[from, to]`): "이 범위에 캡처된 Stock-Date가 없습니다" with a button to focus the Toolbar.
- Range > 30 days: blocked by Toolbar pre-validation with message "최대 30일까지 조회 가능".
- Inventory partially missing dates (weekends, holidays, uncaptured days): silently dropped from `segments`; the chart skips those days naturally via Virtual Axis stitching.

## 4. Architecture Overview

```
[Toolbar]
  ├── StockCombobox        → draft.code
  ├── DateRangePicker      → draft.fromDate / draft.toDate
  ├── TimeframeSelector    → draft.timeframe     (NEW)
  └── [데이터 불러오기]    → setSelection({code, fromDate, toDate, timeframe})
                                ↓
[useTabsStore]
  selection: TabSelection { code, fromDate, toDate, timeframe }   (timeframe NEW)
  prefs:     ChartViewPrefs { volumeProfileMode: 'range' | 'day' } (NEW, tab-scoped, non-URL)
                                ↓
[Workarea]
  useRange(code, fromDate, toDate, timeframe)                      (NEW; replaces useSession)
                                ↓
[useRange hook] → GET /api/range?code=&from=&to=&bucket_ms=        (NEW endpoint)
                                ↓
[Backend hoga/api/routes.py::api_range]
  → build_range_bundle(engine, code, from, to, bucket_ms)          (NEW)
      ├── for date in inventory.dates(code, from, to):
      │     build_bundle(engine, code, date, bucket_ms=bucket_ms)  (existing; +bucket_ms param)
      ├── concatenate series across dates
      ├── build_volume_profile_range(engine, code, dates)          (NEW)
      └── return RangeBundle
                                ↓
[ChartStage] (no instance recreate on bundle change)
  ├── on initial bundle: timeScale.fitContent()
  ├── subscribeVisibleLogicalRangeChange:
  │     - clamp zoom-out to [0, totalBars]
  │     - clamp zoom-in to barSpacing <= 50
  ├── tickMarkFormatter: virtual-ms → realMs (KST) → adaptive format
  ├── DayBoundaryOverlay (NEW): absolute div per segments[i].virtualStart
  └── on timeframe change: preserve time window via realMs round-trip
```

## 5. Backend

### 5.1 New Endpoint

```
GET /api/range?code=<6-digit>&from=<YYYYMMDD>&to=<YYYYMMDD>&bucket_ms=<int>

Responses:
  200 RangeBundle           — normal case (segments may be partial if some dates missing)
  400 — from > to
  400 — bucket_ms not in {60000, 180000, 300000, 600000, 900000, 1800000}
  400 — (to - from) > 30 days
  404 — no captured Stock-Date in [from, to]
```

### 5.2 RangeBundle Schema

```python
class RangeSegment(BaseModel):
    date: str               # YYYYMMDD
    session_open_ms: int    # real Unix-ms, KST 09:00
    session_close_ms: int   # real Unix-ms, KST 15:30

class RangeBundle(BaseModel):
    code: str
    from_date: str
    to_date: str
    bucket_ms: int
    segments: list[RangeSegment]      # len >= 1, ascending by date
    candles: list[ApiCandle]
    quote_ratio: ApiQuoteRatio
    depth_intensity: ApiDepthIntensity
    fill_strength: ApiFillStrength
    volume_profile_range: ApiVolumeProfile     # range-wide, always present
    volume_profile_by_day: list[ApiVolumeProfile]  # day-wise, len == len(segments)
```

`SessionBundle`, `useSession`, and `GET /api/session` are **removed in the same PR** that introduces `RangeBundle` and `/api/range`. There is no transitional deprecation window. Rationale and consequences: see ADR-0013.

### 5.3 Per-Series Timeframe Aggregation

| Series | Aggregation | Source / Notes |
|---|---|---|
| **candles** | OHLC re-aggregation: `open = first(open)`, `close = last(close)`, `high = max(high)`, `low = min(low)`, `vol_a = sum(vol_a)`, `vol_b = sum(vol_b)` | New `downsample_candles(candles_1m, bucket_ms)` in `hoga/api/bundle.py`. Last partial bucket included. `bucket_ms == 60000` is identity. |
| **quote_ratio** | First snapshot per bucket (`ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY ts) = 1`) | Existing SQL in `bundle.py:64-80` — already parameterized by `bucket_ms`. |
| **depth_intensity** | `MAX(qty)` over bucket × bin | Existing SQL in `bundle.py:170-185` — already parameterized by `depth_bucket_ms`. Cell-cap logic (`max_cells`) preserved. |
| **fill_strength** | Existing bucket metric | Already parameterized by `bucket_ms`. Default changes from 60_000 to the request's `bucket_ms`. |
| **volume_profile_range** | All trades in `[from, to]` grouped by price bin | New `build_volume_profile_range(engine, code, dates)` — unions trades across all in-range Stock-Dates' parquet files into one profile. Bin width = same logic as existing single-day profile. |
| **volume_profile_by_day** | Existing single-day profile, computed N times | Loop over dates, reuse existing `build_volume_profile` per Stock-Date. |

### 5.4 Multi-Day Implementation

```python
# hoga/api/bundle.py (new)
def build_range_bundle(engine, code, from_date, to_date, bucket_ms):
    d_from = datetime.strptime(from_date, "%Y%m%d").date()
    d_to = datetime.strptime(to_date, "%Y%m%d").date()
    if d_to < d_from:
        raise HTTPException(400, "from > to")
    if (d_to - d_from).days > 90:
        raise HTTPException(400, "range exceeds 30 days")

    dates = engine.list_stock_dates(code, from_date, to_date)  # ascending
    if not dates:
        raise HTTPException(404, f"no captured Stock-Date in [{from_date}, {to_date}]")

    segments, candles, ratio_pts, intensity_cells, fill_pts = [], [], [], [], []
    profiles_by_day = []
    for d in dates:
        bundle = build_bundle(engine, code, d, bucket_ms=bucket_ms)  # +bucket_ms
        segments.append(RangeSegment(
            date=d,
            session_open_ms=bundle.session_open_ms,
            session_close_ms=bundle.session_close_ms,
        ))
        candles.extend(bundle.candles)
        ratio_pts.extend(bundle.quote_ratio.points)
        intensity_cells.extend(bundle.depth_intensity.cells)
        fill_pts.extend(bundle.fill_strength.points)
        profiles_by_day.append(bundle.volume_profile)

    profile_range = build_volume_profile_range(engine, code, dates)

    return RangeBundle(
        code=code, from_date=from_date, to_date=to_date, bucket_ms=bucket_ms,
        segments=segments,
        candles=candles,
        quote_ratio=ApiQuoteRatio(bucket_ms=bucket_ms, points=ratio_pts),
        depth_intensity=ApiDepthIntensity(bucket_ms=bucket_ms, cells=intensity_cells, ...),
        fill_strength=ApiFillStrength(bucket_ms=bucket_ms, points=fill_pts),
        volume_profile_range=profile_range,
        volume_profile_by_day=profiles_by_day,
    )
```

`build_bundle` signature is extended with `bucket_ms` (forwarded to existing internal builders).

## 6. Frontend

### 6.1 State Model (`state/tabs.ts`)

```ts
export type Timeframe = '1m' | '3m' | '5m' | '10m' | '15m' | '30m';

export const TIMEFRAME_TO_MS: Record<Timeframe, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000,
  '10m': 600_000, '15m': 900_000, '30m': 1_800_000,
};

export type TabSelection = {
  code: string;
  fromDate: string;
  toDate: string;
  timeframe: Timeframe;          // NEW; default '1m'
};

export type ChartViewPrefs = {                         // NEW; tab-scoped, non-URL
  volumeProfileMode: 'range' | 'day';                  // default 'range'
};
```

### 6.2 URL Encoding (`state/url.ts`)

Format: `?tabs=<code>:<from>:<to>:<timeframe>[,...]&active=<idx>`.
Example: `?tabs=005930:20260512:20260522:5m,000660:20260520:20260520:1m&active=0`.

Parsing rule: if a tab segment has only 3 colon-separated parts (legacy URL), default `timeframe='1m'`. Writes always emit 4 parts.

### 6.3 TimeframeSelector Component (`replay/TimeframeSelector.tsx`)

Stateless segmented control:
```tsx
<TimeframeSelector value={draft.timeframe} onChange={setTimeframe} />
```

- 6 buttons in a single row.
- Active button: `bg-accent text-accent-fg`. Inactive: `bg-bg-card text-fg-dim hover:text-fg`.
- Keyboard: Arrow Left/Right navigates, Enter commits. Tab order: after DateRangePicker, before 데이터 불러오기.

### 6.4 useRange Hook (`api/range.ts`)

```ts
export function useRange(
  code: string | null,
  from: string | null,
  to: string | null,
  timeframe: Timeframe | null,
) {
  const bucketMs = timeframe ? TIMEFRAME_TO_MS[timeframe] : null;
  return useQuery<RangeBundle, Error>({
    queryKey: ['range', code, from, to, bucketMs],
    queryFn: () => fetch(`/api/range?code=${code}&from=${from}&to=${to}&bucket_ms=${bucketMs}`)
                     .then(r => r.ok ? r.json() : Promise.reject(new Error(r.statusText))),
    enabled: !!(code && from && to && bucketMs),
    staleTime: 5 * 60_000,
  });
}
```

### 6.5 Workarea Changes (`replay/Workarea.tsx`)

```ts
const { data: bundle, isLoading, isError, error } =
  useRange(code, fromDate, toDate, timeframe);

const segments: Segment[] = useMemo(
  () => bundle ? buildSegments(bundle.segments.map(s => ({
    date: s.date,
    sessionOpenMs: s.session_open_ms,
    sessionCloseMs: s.session_close_ms,
  }))) : [],
  [bundle],
);
```

`useStockDates`/`useSession` dependencies removed from Workarea.

### 6.6 ChartStage Changes (`chart/ChartStage.tsx`)

**(a) Initial fit + zoom clamps** (new `useEffect` on `[chart, bundle, segments]`):

```ts
const ts = chart.timeScale();
ts.fitContent();
const totalBars = bundle.candles.length;
const handler = (range: LogicalRange | null) => {
  if (!range) return;
  const len = range.to - range.from;
  if (len > totalBars) {
    ts.setVisibleLogicalRange({ from: 0, to: totalBars });
    return;
  }
  if (ts.options().barSpacing > 50) {
    ts.applyOptions({ barSpacing: 50 });
  }
};
ts.subscribeVisibleLogicalRangeChange(handler);
return () => ts.unsubscribeVisibleLogicalRangeChange(handler);
```

**(b) X-axis `tickMarkFormatter`** (in `createChart` options):

```ts
timeScale: {
  ...CHART_TIMESCALE_OPTIONS,
  timeVisible: true,
  secondsVisible: false,
  borderColor: tokens.border,
  tickMarkFormatter: (time: UTCTimestamp, tickType: TickMarkType) => {
    const virtualMs = (time as number) * 1000;
    const segs = segmentsRef.current;
    if (segs.length === 0) return '';
    const realMs = virtualToReal(segs, virtualMs);
    const d = new Date(realMs + 9 * 3600_000);  // KST
    switch (tickType) {
      case TickMarkType.Year:
      case TickMarkType.Month:
      case TickMarkType.DayOfMonth:
        return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
      case TickMarkType.Time:
        return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      case TickMarkType.TimeWithSeconds:
        return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    }
  },
},
```

**(c) DayBoundaryOverlay component** (new file `chart/DayBoundaryOverlay.tsx`):

- Portaled into `chart.chartElement()` parent.
- Reads `segments` + `chart.timeScale().timeToCoordinate(virtualSec)` for each `segments[i].virtualStart` (skip `i=0`).
- Renders one absolute-positioned `<div>` per boundary: `1px` solid `--border` (strengthened: e.g. `rgba(255,255,255,0.18)`) vertical line full-height; `MM/DD` chip at top with `bg-bg-card text-fg-dim text-xs px-1.5 py-0.5 rounded`.
- Repositions on `subscribeVisibleLogicalRangeChange` + `ResizeObserver` on container.

**(d) Timeframe-change time-window preservation**:

The Toolbar's `onLoad` handler (not Workarea) owns this — it is the *only* synchronous moment at which both (i) the *current* in-DOM viewport is still valid and (ii) the *next* selection is known. Approach:

```ts
// Toolbar.tsx — onLoad
const onLoad = () => {
  if (!ready) return;
  const prevTf = active.selection?.timeframe;
  const nextTf = draft.timeframe!;
  if (prevTf && prevTf !== nextTf) {
    const { fromMs, toMs } = useViewportStore.getState();
    if (fromMs != null && toMs != null) {
      useTabsStore.getState().setPendingViewRestore(active.id, { fromMs, toMs });
    }
  }
  useTabsStore.getState().setSelection(active.id, { ...draft });
};
```

`useTabsStore` gains `pendingViewRestore: Map<tabId, {fromMs,toMs}>` and a `consumePendingViewRestore(tabId)` action that returns the value and clears it. `ChartStage` reads the value once, after the new bundle mounts, and either:
- Calls `ts.setVisibleRange({ from: realToVirtual(segments, fromMs)/1000, to: realToVirtual(segments, toMs)/1000 })`, or
- Falls back to `ts.fitContent()` if no pending restore exists.

This avoids a Workarea-local `useRef` whose lifetime is fragile across React Query refetches.

### 6.7 VolumeProfileOverlay Changes

- Existing `mode="composite"` is the new `mode="range"` (rename + extend `mode` union).
- New `mode="day"`: iterates `segments`, draws one profile bar group per Stock-Date, positioned by `timeToCoordinate(segment.virtualStart)`.
- Toggle UI: a small segmented control in the sidebar header `[전체 | 일별]` driving `ChartViewPrefs.volumeProfileMode`.

### 6.8 Unchanged

- `util/time.ts` — multi-day stitching already supported.
- `VolumePane` / `RatioPane` / `IntensityPane` / `FillStrengthPane` — already render via `realToVirtual(segments, …)` and read only their own series payloads. They retype `bundle: RangeBundle` (no behavioural change).
- **`CandlePane` — behavioural change required.** The current `bundle.session_open_ms + 6h20m` auction-threshold computation (line 63) assumes a single Stock-Date. Under a multi-day Range, each candle's auction status is governed by its own segment's `session_open_ms`. CandlePane is changed to look up the relevant segment per candle via a new `findSegmentByReal(segments, realMs)` helper added to `util/time.ts` (sibling to the existing `findSegmentByVirtual`) and compute the threshold from that segment. ADR-0013's Consequences section documents this consumer-side adjustment.
- `chartScale.ts` — `barSpacing=8`, `rightOffset=15` preserved per DESIGN.md Scale Factor decision.

## 7. State / URL / Cache

| Concern | Storage | Persistence |
|---|---|---|
| `timeframe` in `TabSelection` | `useTabsStore` | URL synced |
| `volumeProfileMode` in `ChartViewPrefs` | `useTabsStore` (tab-scoped map) | In-memory only (lost on reload) |
| Range data | React Query | `staleTime: 5min`, key `['range', code, from, to, bucketMs]` |
| Preserved time-window across timeframe switch | `useRef` in Workarea | Per-instance, lost on unmount |

## 8. Error Handling and Edge Cases

- **No Stock-Date in range** (404 from API): Workarea shows "이 범위에 캡처된 Stock-Date가 없습니다" with action button focusing Toolbar.
- **Range > 30 days**: Toolbar `onLoad` pre-validates and shows inline message; BE returns 400 as second defense.
- **Invalid bucket_ms**: cannot occur from frontend (enum), BE whitelists.
- **Inventory partially missing dates** (weekends, holidays): silently skipped; `segments` reflects only captured days; Virtual Axis naturally skips the gap.
- **Large response payload**: 30 days × 1m × 5 series ≈ tens of MB JSON in worst case. Mitigation: response gzip (FastAPI middleware) + a `total_points` field in `RangeBundle` for future client-side warning. Hard streaming/pagination is out of scope.
- **Single-day Range**: behavior identical to today's `useSession` flow except the chart now auto-fits the full day and x-axis labels are KST. No `DayBoundaryOverlay` lines rendered (only `segments[1..]` produce lines; with N=1 there are none).
- **Timeframe switch on empty viewport**: if no visible range exists (data not loaded yet), `preservedRangeRef` stays null and ChartStage falls back to `fitContent()`.
- **Pre-open auction candles** (08:30–09:00): already filtered by `isWithinSessions` in each pane — unchanged.
- **ChartErrorBoundary**: existing — wraps the whole stack, unchanged.

## 9. Testing Strategy

| Layer | Test Kind | Key Cases |
|---|---|---|
| `util/time.ts` | unit (vitest) | Multi-day `buildSegments`, virtual↔real round-trip, partial-inventory segments (skip weekends) |
| `hoga/api/bundle.py::downsample_candles` | unit (pytest) | OHLC correctness, last partial bucket, empty input, `bucket_ms == 60_000` identity, all 6 bucket sizes |
| `hoga/api/bundle.py::build_range_bundle` | unit | Inventory with gaps, segments ordering, both `volume_profile_*` populated |
| `hoga/api/bundle.py::build_volume_profile_range` | unit | Multi-date union, price-bin alignment |
| `hoga/api/routes.py::/api/range` | route (FastAPI TestClient) | 200 happy path, 400 (range > 90d / invalid bucket_ms / from > to), 404 (zero dates), partial-inventory |
| `frontend/src/api/range.ts` | hook (vitest + msw) | Cache key correctness, `enabled` gating, error propagation |
| `replay/TimeframeSelector.tsx` | RTL | Active state, keyboard navigation, `onChange` callback |
| `replay/Toolbar.tsx` | RTL | Draft → setSelection includes `timeframe`, 30-day pre-validation |
| `replay/Workarea.tsx` | RTL | useRange wiring, time-window preservation across timeframe change |
| `chart/ChartStage.tsx` | RTL + lightweight-charts mock | `fitContent` on initial bundle, zoom clamp at totalBars and barSpacing 50, `tickMarkFormatter` outputs KST |
| `chart/DayBoundaryOverlay.tsx` | RTL | One line per non-first segment, repositions on visible range change |
| E2E (playwright) | Browser | Open page → change Timeframe → candle count changes + time window preserved + day boundary visible (range covering 2+ days) |
| Visual | `design-review` skill | DESIGN.md token compliance, day boundary color strength, TimeframeSelector active/inactive consistency |

## 10. Out of Scope

- Custom Timeframes (e.g. 7m, 2h, 1d) — only the six listed.
- Auto-Timeframe (switching by zoom level) — explicitly excluded; user-selected only.
- Server-side caching of downsampled candles — recomputed each request.
- Streaming / pagination for very long ranges — 30-day hard cap is the v1 boundary.
<!-- removed: SessionBundle retirement is in scope per ADR-0013 -->
- Replacing `barSpacing=8` / `rightOffset=15` density — intentional per DESIGN.md.
- Sub-minute Timeframes (10s, 30s) — current parquet candles are 1m fixed.

## 11. ADRs

- **ADR-0013 (committed): RangeBundle is the single read-path Wire Model; SessionBundle retired.** RangeBundle replaces SessionBundle entirely — single-Stock-Date is the N=1 degenerate case. `/api/session`, `useSession`, the `SessionBundle` TypeScript type, and direct test fixtures are deleted in the same PR. See `docs/adr/0013-rangebundle-single-read-path.md`.
- **ADR-0014 (committed): All Replay series share a single Timeframe.** The user-selected Timeframe applies uniformly across all five series; no per-series overrides, no Auto-by-zoom mode in v1. See `docs/adr/0014-replay-single-timeframe.md`.

## 12. Open Implementation Details

These are decisions deferred to the implementation plan (writing-plans skill), not blockers for this design:

- Exact RTL/playwright test file structure (which existing test files extend vs new files).
- Whether `DayBoundaryOverlay` chip position adjusts when adjacent boundaries are <40px apart on zoom-out (collision handling).
- Whether `volume_profile_by_day` is gzipped separately for large ranges (30 days × per-day profile may be heavy).
- Exact sidebar position of the volume profile toggle — to be decided during frontend-design pass.
