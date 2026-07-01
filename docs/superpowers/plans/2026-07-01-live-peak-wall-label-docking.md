# Live Peak Wall Label Docking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dock only today's live ask/bid peak-wall labels into a shared right-side label lane while leaving historical labels, wall lines, and wall dots unchanged.

**Architecture:** Keep `AskPeakSegmentsPrimitive` responsible for wall lines, dots, and historical inline labels. Add pure helpers that split live labels away from segments, then add one shared docked-label primitive mounted from `LiveChartRoot` so live ask and bid labels are laid out together. Existing ask and bid segment builders remain the source of line/dot geometry.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, lightweight-charts custom series primitives, fancy-canvas.

## Global Constraints

- Only `segment.live === true` labels are docked; historical labels remain inline at the segment right edge.
- Docked labels render inside the candle pane near the right edge, not inside the actual lightweight-charts price axis.
- Wall lines and peak dots keep their existing price/time coordinates.
- Ask and bid live labels must share one layout pass so close price bands stack rather than overlap.
- Backend peak-wall data, ratchet logic, moving-average labels, current-price labels, and trade-volume POC labels are out of scope.
- Do not change chart right padding unless implementation QA proves the docked lane cannot meet the visibility goal.

---

## File Structure

- Modify `frontend/src/chart/AskPeakSegmentsPrimitive.ts`
  - Export label drawing constants used by the existing inline labels and the new docked-label primitive.
  - Add pure helpers to extract live labels and remove only live inline labels from segment lists.
- Modify `frontend/src/chart/AskPeakSegmentsPrimitive.test.ts`
  - Cover live-label extraction and historical inline-label preservation.
- Create `frontend/src/chart/PeakWallDockedLabelsPrimitive.ts`
  - Draw a right-side label lane for derived `{ price, label, color }` items.
  - Reuse `layoutAskPeakLabels` so live ask and bid labels share the same stacking behavior as inline labels.
- Create `frontend/src/chart/PeakWallDockedLabelsPrimitive.test.ts`
  - Cover pure layout candidate behavior for the right-side lane.
- Modify `frontend/src/live/LiveAskPeakSegments.tsx`
  - Strip live labels before passing ask segments to the existing line/dot primitive.
  - Export a small `prepareAskPeakSegmentsForRender(...)` helper for the renderer and tests.
- Modify `frontend/src/live/LiveBidPeakSegments.tsx`
  - Strip live labels before passing bid segments to the existing line/dot primitive.
  - Export a small `prepareBidPeakSegmentsForRender(...)` helper for the renderer and tests.
- Create `frontend/src/live/LivePeakWallDockedLabels.tsx`
  - Build ask and bid segments using the existing builder functions and current store prefs.
  - Apply ask visible-max styling before extracting labels, matching the rendered ask line colors.
  - Attach one `PeakWallDockedLabelsPrimitive` to the candle series.
- Modify `frontend/src/live/LiveChartRoot.tsx`
  - Mount `LivePeakWallDockedLabels` once for minute timeframes after ask/bid wall segment primitives.
- Modify `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`
  - Mock `LivePeakWallDockedLabels` and assert it mounts once for minute charts.

---

### Task 1: Pure Segment Label Split Helpers

**Files:**
- Modify: `frontend/src/chart/AskPeakSegmentsPrimitive.ts`
- Test: `frontend/src/chart/AskPeakSegmentsPrimitive.test.ts`

**Interfaces:**
- Consumes: `AskPeakSegment`
- Produces:
  - `PeakWallDockedLabel`
  - `livePeakWallDockedLabelsFromSegments(segments: readonly AskPeakSegment[]): PeakWallDockedLabel[]`
  - `inlinePeakWallSegmentsForDocking(segments: readonly AskPeakSegment[]): AskPeakSegment[]`
  - exported constants `LABEL_GAP_PX`, `LABEL_FONT_PX`, `LABEL_ROW_GAP_PX`, `LABEL_EDGE_PAD_PX`, `LABEL_BOX_X_PAD_PX`, `LABEL_BOX_Y_PAD_PX`

- [ ] **Step 1: Write failing helper tests**

Append these tests to `frontend/src/chart/AskPeakSegmentsPrimitive.test.ts`:

```ts
import {
  inlinePeakWallSegmentsForDocking,
  livePeakWallDockedLabelsFromSegments,
  type AskPeakSegment,
} from './AskPeakSegmentsPrimitive';

const segment = (overrides: Partial<AskPeakSegment> = {}): AskPeakSegment => ({
  time0: 1 as never,
  time1: 2 as never,
  peakTime: 1.5 as never,
  price: 23500,
  qty: 17200,
  label: '23,500, 17.2k',
  color: '#f97316',
  lineWidth: 2,
  live: false,
  ...overrides,
});

describe('live peak-wall docked label helpers', () => {
  it('extracts labels only from live segments with visible label text', () => {
    const out = livePeakWallDockedLabelsFromSegments([
      segment({ live: false, label: '24,500, 16.6k', price: 24500, color: '#f97316' }),
      segment({ live: true, label: '23,500, 17.2k', price: 23500, color: '#ec4899' }),
      segment({ live: true, label: '', price: 23000, color: '#60a5fa' }),
    ]);

    expect(out).toEqual([
      { price: 23500, label: '23,500, 17.2k', color: '#ec4899' },
    ]);
  });

  it('removes only live inline label text while preserving historical labels and geometry', () => {
    const past = segment({ live: false, label: '24,500, 16.6k', price: 24500 });
    const live = segment({ live: true, label: '23,500, 17.2k', price: 23500 });
    const out = inlinePeakWallSegmentsForDocking([past, live]);

    expect(out[0]).toEqual(past);
    expect(out[1]).toEqual({ ...live, label: '' });
    expect(out[1]).toMatchObject({
      time0: live.time0,
      time1: live.time1,
      peakTime: live.peakTime,
      price: live.price,
      qty: live.qty,
      color: live.color,
      lineWidth: live.lineWidth,
      live: true,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd frontend
npm test -- AskPeakSegmentsPrimitive.test.ts
```

Expected: FAIL because `inlinePeakWallSegmentsForDocking` and `livePeakWallDockedLabelsFromSegments` are not exported.

- [ ] **Step 3: Export constants and add helpers**

In `frontend/src/chart/AskPeakSegmentsPrimitive.ts`, replace the private label constants with exported constants:

```ts
export const PEAK_DOT_RADIUS_PX = 3.5;
export const LABEL_GAP_PX = 3;
export const LABEL_FONT_PX = 11;
export const LABEL_ROW_GAP_PX = 5;
export const LABEL_EDGE_PAD_PX = 4;
export const LABEL_SEGMENT_PAD_PX = 8;
export const LABEL_BOX_X_PAD_PX = 4;
export const LABEL_BOX_Y_PAD_PX = 1;
```

Then add these helpers after `AskPeakSegment`:

```ts
export interface PeakWallDockedLabel {
  price: number;
  label: string;
  color: string;
}

export function livePeakWallDockedLabelsFromSegments(
  segments: readonly AskPeakSegment[],
): PeakWallDockedLabel[] {
  return segments
    .filter((segment) => segment.live === true && segment.label !== '')
    .map((segment) => ({
      price: segment.price,
      label: segment.label,
      color: segment.color,
    }));
}

export function inlinePeakWallSegmentsForDocking(
  segments: readonly AskPeakSegment[],
): AskPeakSegment[] {
  return segments.map((segment) => (
    segment.live === true && segment.label !== ''
      ? { ...segment, label: '' }
      : segment
  ));
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
cd frontend
npm test -- AskPeakSegmentsPrimitive.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/chart/AskPeakSegmentsPrimitive.ts frontend/src/chart/AskPeakSegmentsPrimitive.test.ts
git commit -m "feat: split live peak wall labels"
```

---

### Task 2: Docked Label Primitive

**Files:**
- Create: `frontend/src/chart/PeakWallDockedLabelsPrimitive.ts`
- Test: `frontend/src/chart/PeakWallDockedLabelsPrimitive.test.ts`

**Interfaces:**
- Consumes:
  - `PeakWallDockedLabel`
  - `layoutAskPeakLabels`
  - exported label constants from `AskPeakSegmentsPrimitive.ts`
- Produces:
  - `PeakWallDockedLabelsPrimitive`
  - `peakWallDockedLabelCandidates(labels, priceToY, xRight, measureText): AskPeakLabelCandidate[]`

- [ ] **Step 1: Write failing primitive helper tests**

Create `frontend/src/chart/PeakWallDockedLabelsPrimitive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  peakWallDockedLabelCandidates,
  type PeakWallDockedLabelInput,
} from './PeakWallDockedLabelsPrimitive';

describe('peakWallDockedLabelCandidates', () => {
  const labels: PeakWallDockedLabelInput[] = [
    { price: 24500, label: '24,500, 16.6k', color: '#f97316' },
    { price: 23500, label: '23,500, 17.2k', color: '#ec4899' },
    { price: 23000, label: '', color: '#60a5fa' },
  ];

  it('pins all visible labels to the shared right-side lane', () => {
    const out = peakWallDockedLabelCandidates(
      labels,
      (price) => (price === 24500 ? 100 : price === 23500 ? 104 : 108),
      780,
      (text) => text.length * 5,
    );

    expect(out).toEqual([
      { index: 0, xRight: 780, yLine: 97, width: '24,500, 16.6k'.length * 5, segmentWidth: Number.POSITIVE_INFINITY },
      { index: 1, xRight: 780, yLine: 101, width: '23,500, 17.2k'.length * 5, segmentWidth: Number.POSITIVE_INFINITY },
    ]);
  });

  it('skips labels whose price is not mappable to a y coordinate', () => {
    const out = peakWallDockedLabelCandidates(
      labels,
      (price) => (price === 24500 ? 100 : null),
      780,
      (text) => text.length,
    );

    expect(out.map((candidate) => candidate.index)).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd frontend
npm test -- PeakWallDockedLabelsPrimitive.test.ts
```

Expected: FAIL because `PeakWallDockedLabelsPrimitive.ts` does not exist.

- [ ] **Step 3: Create the docked-label primitive**

Create `frontend/src/chart/PeakWallDockedLabelsPrimitive.ts`:

```ts
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import {
  LABEL_BOX_X_PAD_PX,
  LABEL_BOX_Y_PAD_PX,
  LABEL_EDGE_PAD_PX,
  LABEL_FONT_PX,
  LABEL_GAP_PX,
  LABEL_ROW_GAP_PX,
  layoutAskPeakLabels,
  type AskPeakLabelCandidate,
  type PeakWallDockedLabel,
} from './AskPeakSegmentsPrimitive';

export type PeakWallDockedLabelInput = PeakWallDockedLabel;

export function peakWallDockedLabelCandidates(
  labels: readonly PeakWallDockedLabelInput[],
  priceToY: (price: number) => number | null,
  xRight: number,
  measureText: (text: string) => number,
): AskPeakLabelCandidate[] {
  const candidates: AskPeakLabelCandidate[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (label.label === '') continue;
    const y = priceToY(label.price);
    if (y === null) continue;
    candidates.push({
      index: i,
      xRight,
      yLine: y - LABEL_GAP_PX,
      width: measureText(label.label),
      segmentWidth: Number.POSITIVE_INFINITY,
    });
  }
  return candidates;
}

class PeakWallDockedLabelsRenderer implements IPrimitivePaneRenderer {
  private readonly _source: PeakWallDockedLabelsPrimitive;

  constructor(source: PeakWallDockedLabelsPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const series = this._source.seriesApi();
    if (!series) return;
    const labels = this._source.labelsData();
    if (labels.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const xRight = scope.bitmapSize.width - LABEL_EDGE_PAD_PX * hr;
      ctx.font = `${LABEL_FONT_PX * vr}px sans-serif`;

      const candidates = peakWallDockedLabelCandidates(
        labels,
        (price) => {
          const y = series.priceToCoordinate(price);
          return y === null ? null : y * vr;
        },
        xRight,
        (text) => ctx.measureText(text).width,
      );
      if (candidates.length === 0) return;

      const rowHeight = (LABEL_FONT_PX + LABEL_ROW_GAP_PX) * vr;
      const minBaselineY = (LABEL_FONT_PX + LABEL_EDGE_PAD_PX) * vr;
      const maxBaselineY = scope.bitmapSize.height - LABEL_EDGE_PAD_PX * vr;
      const layouts = layoutAskPeakLabels(candidates, minBaselineY, maxBaselineY, rowHeight);

      for (const layout of layouts) {
        const label = labels[layout.index];
        const xPad = LABEL_BOX_X_PAD_PX * hr;
        const yPad = LABEL_BOX_Y_PAD_PX * vr;
        const fontHeight = LABEL_FONT_PX * vr;
        ctx.fillStyle = 'rgba(11, 15, 26, 0.82)';
        ctx.fillRect(
          layout.xRight - layout.width - xPad,
          layout.baselineY - fontHeight - yPad,
          layout.width + xPad * 2,
          fontHeight + yPad * 2,
        );
        ctx.fillStyle = label.color;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'right';
        ctx.fillText(label.label, layout.xRight, layout.baselineY);
      }
    });
  }
}

class PeakWallDockedLabelsPaneView implements IPrimitivePaneView {
  private readonly _renderer: PeakWallDockedLabelsRenderer;

  constructor(source: PeakWallDockedLabelsPrimitive) {
    this._renderer = new PeakWallDockedLabelsRenderer(source);
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

export class PeakWallDockedLabelsPrimitive implements ISeriesPrimitive<Time> {
  private _labels: readonly PeakWallDockedLabelInput[] = [];
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private readonly _paneView: PeakWallDockedLabelsPaneView;

  constructor() {
    this._paneView = new PeakWallDockedLabelsPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = undefined;
  }

  updateAllViews(): void {
    // Pane view reads labels directly from the source during draw.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }

  setLabels(labels: readonly PeakWallDockedLabelInput[]): void {
    this._labels = labels;
    this._requestUpdate?.();
  }

  labelsData(): readonly PeakWallDockedLabelInput[] {
    return this._labels;
  }

  chartApi(): IChartApi | null {
    return this._chart;
  }

  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
}
```

- [ ] **Step 4: Run primitive tests**

Run:

```bash
cd frontend
npm test -- PeakWallDockedLabelsPrimitive.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run existing inline layout tests**

Run:

```bash
cd frontend
npm test -- AskPeakSegmentsPrimitive.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/chart/PeakWallDockedLabelsPrimitive.ts frontend/src/chart/PeakWallDockedLabelsPrimitive.test.ts
git commit -m "feat: add peak wall docked labels primitive"
```

---

### Task 3: Suppress Live Inline Labels in Ask/Bid Wall Renderers

**Files:**
- Modify: `frontend/src/live/LiveAskPeakSegments.tsx`
- Modify: `frontend/src/live/LiveBidPeakSegments.tsx`
- Test: `frontend/src/live/LiveAskPeakSegments.test.tsx`

**Interfaces:**
- Consumes:
  - `inlinePeakWallSegmentsForDocking(segments)`
  - `styleVisibleMaxAskPeakSegments(segments, visibleRange, style, rankLimit)`
- Produces:
  - `prepareAskPeakSegmentsForRender(segments, visibleRange, visibleMaxStyle, visibleMaxRankLimit): AskPeakSegment[]`
  - `prepareBidPeakSegmentsForRender(segments): AskPeakSegment[]`
  - ask and bid line/dot primitives whose live segments keep geometry but have blank inline labels

- [ ] **Step 1: Add failing ask/bid render-preparation tests**

Update the import block in `frontend/src/live/LiveAskPeakSegments.test.tsx`:

```ts
import {
  buildAskPeakSegments,
  buildAskPeakOverlaySegments,
  prepareAskPeakSegmentsForRender,
  styleVisibleMaxAskPeakSegments,
} from './LiveAskPeakSegments';
import {
  buildBidPeakOverlaySegments,
  prepareBidPeakSegmentsForRender,
} from './LiveBidPeakSegments';
```

Then append these tests to the same file:

```ts
describe('live peak-wall inline label suppression', () => {
  it('suppresses only today ask inline labels after ask styling is applied', () => {
    const raw = buildAskPeakOverlaySegments({
      dayAskPeaks: [
        peak({ date: '20260612', price: 100, qty: 50, t_ms: 120000 }),
        peak({ date: '20260613', price: 110, qty: 80, t_ms: 180000 }),
      ],
      todayAllPriceAskPeak: null,
      segments: [seg('20260612', 60000, 240000), seg('20260613', 300000, 480000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#1D4ED8', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: false,
    });

    const inline = prepareAskPeakSegmentsForRender(
      raw,
      { from: t(1), to: t(999) },
      { color: '#EAB308', lineWidth: 3 },
      1,
    );
    expect(inline[0].live).toBe(false);
    expect(inline[0].label).toBe('100, 0.1k');
    expect(inline[1].live).toBe(true);
    expect(inline[1]).toMatchObject({
      price: 110,
      label: '',
      color: '#EAB308',
      lineWidth: 3,
    });
  });

  it('suppresses only today bid inline labels', () => {
    const pastBid: BidPeak = {
      date: '20260612',
      price: 100,
      qty: 50,
      t_ms: 120000,
      max_price: 100,
      max_qty: 50,
      max_t_ms: 120000,
    };
    const todayBid: BidPeak = {
      date: '20260613',
      price: 90,
      qty: 80,
      t_ms: 180000,
      max_price: 90,
      max_qty: 80,
      max_t_ms: 180000,
    };
    const raw = buildBidPeakOverlaySegments({
      dayBidPeaks: [pastBid, todayBid],
      todayAllPriceBidPeak: null,
      segments: [seg('20260612', 60000, 240000), seg('20260613', 300000, 480000)],
      candles: [candle(60000), candle(120000), candle(180000)],
      axis,
      todayKst: '20260613',
      baselineStyle: { color: '#2563EB', lineWidth: 2 },
      allPriceStyle: { color: '#F97316', lineWidth: 1 },
      intraMax: false,
      showAllPrices: false,
    });

    const inline = prepareBidPeakSegmentsForRender(raw);

    expect(inline[0].live).toBe(false);
    expect(inline[0].label).toBe('100, 0.1k');
    expect(inline[1].live).toBe(true);
    expect(inline[1]).toMatchObject({ price: 90, label: '', color: '#2563EB', lineWidth: 2 });
  });
});
```

- [ ] **Step 2: Run tests**

Run:

```bash
cd frontend
npm test -- LiveAskPeakSegments.test.tsx
```

Expected: FAIL because `prepareAskPeakSegmentsForRender` and `prepareBidPeakSegmentsForRender` are not exported yet.

- [ ] **Step 3: Add ask render-preparation helper and use it**

In `frontend/src/live/LiveAskPeakSegments.tsx`, update imports:

```ts
import {
  AskPeakSegmentsPrimitive,
  inlinePeakWallSegmentsForDocking,
  type AskPeakSegment,
} from '../chart/AskPeakSegmentsPrimitive';
```

Add this exported helper after `styleVisibleMaxAskPeakSegments`:

```ts
export function prepareAskPeakSegmentsForRender(
  segments: readonly AskPeakSegment[],
  visibleRange: IRange<Time> | null,
  visibleMaxStyle: { color: string; lineWidth: number },
  visibleMaxRankLimit: 1 | 2 | 3,
): AskPeakSegment[] {
  return inlinePeakWallSegmentsForDocking(styleVisibleMaxAskPeakSegments(
    segments,
    visibleRange,
    visibleMaxStyle,
    visibleMaxRankLimit,
  ));
}
```

Then replace the `prim.setSegments(...)` call inside `updateSegments` with:

```ts
    prim.setSegments(prepareAskPeakSegmentsForRender(
      rawSegments,
      visibleRange,
      { color: visibleMaxColor, lineWidth: visibleMaxLineWidth },
      visibleMaxRankLimit as 1 | 2 | 3,
    ));
```

- [ ] **Step 4: Add bid render-preparation helper and use it**

In `frontend/src/live/LiveBidPeakSegments.tsx`, update imports:

```ts
import {
  AskPeakSegmentsPrimitive,
  inlinePeakWallSegmentsForDocking,
  type AskPeakSegment,
} from '../chart/AskPeakSegmentsPrimitive';
```

Add this exported helper after `buildBidPeakOverlaySegments`:

```ts
export function prepareBidPeakSegmentsForRender(
  segments: readonly AskPeakSegment[],
): AskPeakSegment[] {
  return inlinePeakWallSegmentsForDocking(segments);
}
```

Then replace the `prim.setSegments(...)` call in the effect with:

```ts
    const nextSegments = enabled
      ? buildBidPeakOverlaySegments({
        dayBidPeaks,
        todayAllPriceBidPeak,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color, lineWidth },
        allPriceStyle: { color: allPriceColor, lineWidth: allPriceLineWidth },
        intraMax,
        showAllPrices,
      })
      : [];
    prim.setSegments(prepareBidPeakSegmentsForRender(nextSegments));
```

- [ ] **Step 5: Run ask/bid segment tests**

Run:

```bash
cd frontend
npm test -- LiveAskPeakSegments.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/live/LiveAskPeakSegments.tsx frontend/src/live/LiveBidPeakSegments.tsx frontend/src/live/LiveAskPeakSegments.test.tsx
git commit -m "feat: hide live inline peak wall labels"
```

---

### Task 4: Shared Live Ask/Bid Docked Labels Overlay

**Files:**
- Create: `frontend/src/live/LivePeakWallDockedLabels.tsx`
- Modify: `frontend/src/live/LiveChartRoot.tsx`
- Modify: `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`

**Interfaces:**
- Consumes:
  - `buildAskPeakOverlaySegments(...)`
  - `styleVisibleMaxAskPeakSegments(...)`
  - `buildBidPeakOverlaySegments(...)`
  - `livePeakWallDockedLabelsFromSegments(...)`
  - `PeakWallDockedLabelsPrimitive`
- Produces:
  - `LivePeakWallDockedLabels` React component mounted once for minute charts

- [ ] **Step 1: Add LiveChartRoot mount test expectation**

In `frontend/src/live/LiveChartRoot.paneToggles.test.tsx`, extend the hoisted capture object:

```ts
const { mounted, paneBundles, candleTooltipProps, askPeakMounts, bidPeakMounts, dockedLabelMounts, chartInstances } = vi.hoisted(() => ({
  mounted: [] as string[],
  paneBundles: [] as Array<{ name: string; bundle: unknown }>,
  candleTooltipProps: [] as Array<{ bundle: unknown; quoteBundle?: unknown }>,
  askPeakMounts: [] as string[],
  bidPeakMounts: [] as string[],
  dockedLabelMounts: [] as string[],
  chartInstances: [] as Array<{
    remove: ReturnType<typeof vi.fn>;
    timeScaleApi: {
      subscribeVisibleLogicalRangeChange: ReturnType<typeof vi.fn>;
      unsubscribeVisibleLogicalRangeChange: ReturnType<typeof vi.fn>;
      fitContent: ReturnType<typeof vi.fn>;
      setVisibleLogicalRange: ReturnType<typeof vi.fn>;
    };
  }>,
}));
```

Add a mock near the ask/bid mocks:

```ts
vi.mock('./LivePeakWallDockedLabels', () => ({
  default: () => {
    dockedLabelMounts.push('mounted');
    return null;
  },
}));
```

In the existing `beforeEach`, clear it with the other arrays:

```ts
    dockedLabelMounts.length = 0;
```

Add this test near the ask/bid mount assertions:

```ts
it('mounts one shared peak-wall docked label overlay for minute charts', async () => {
  useLivePageStore.setState({ askPeakEnabled: true, bidPeakEnabled: true });
  renderAt('1m');

  await waitFor(() => {
    expect(askPeakMounts).toHaveLength(1);
    expect(bidPeakMounts).toHaveLength(1);
    expect(dockedLabelMounts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend
npm test -- LiveChartRoot.paneToggles.test.tsx
```

Expected: FAIL because `LivePeakWallDockedLabels` is not imported or mounted.

- [ ] **Step 3: Create LivePeakWallDockedLabels**

Create `frontend/src/live/LivePeakWallDockedLabels.tsx`:

```tsx
import { memo, useCallback, useEffect, useRef } from 'react';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { AskPeak, BidPeak, Candle, RangeSegment } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { livePeakWallDockedLabelsFromSegments } from '../chart/AskPeakSegmentsPrimitive';
import { PeakWallDockedLabelsPrimitive } from '../chart/PeakWallDockedLabelsPrimitive';
import { useLivePageStore } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import { buildAskPeakOverlaySegments, styleVisibleMaxAskPeakSegments } from './LiveAskPeakSegments';
import { buildBidPeakOverlaySegments } from './LiveBidPeakSegments';

type Props = {
  paneSeries: PaneSeriesMap;
  axis: VirtualAxis;
  dayAskPeaks: readonly AskPeak[];
  todayAllPriceAskPeak?: AskPeak | null;
  dayBidPeaks: readonly BidPeak[];
  todayAllPriceBidPeak?: BidPeak | null;
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  todayKst: string;
};

function LivePeakWallDockedLabels({
  paneSeries,
  axis,
  dayAskPeaks,
  todayAllPriceAskPeak = null,
  dayBidPeaks,
  todayAllPriceBidPeak = null,
  segments,
  candles,
  todayKst,
}: Props) {
  const series = paneSeries.get('candle' as PaneId) as ISeriesApi<SeriesType> | undefined;
  const askPeakEnabled = useLivePageStore((s) => s.askPeakEnabled);
  const bidPeakEnabled = useLivePageStore((s) => s.bidPeakEnabled);
  const askColor = useLivePageStore((s) => s.askPeakColor);
  const askLineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  const askAllPriceColor = useLivePageStore((s) => s.askPeakAllPriceColor);
  const askAllPriceLineWidth = useLivePageStore((s) => s.askPeakAllPriceLineWidth);
  const askVisibleMaxColor = useLivePageStore((s) => s.askPeakVisibleMaxColor);
  const askVisibleMaxLineWidth = useLivePageStore((s) => s.askPeakVisibleMaxLineWidth);
  const bidColor = useLivePageStore((s) => s.bidPeakColor);
  const bidLineWidth = useLivePageStore((s) => s.bidPeakLineWidth);
  const bidAllPriceColor = useLivePageStore((s) => s.bidPeakAllPriceColor);
  const bidAllPriceLineWidth = useLivePageStore((s) => s.bidPeakAllPriceLineWidth);
  const askIntraMax = useActivePrefs((s) => s.askPeakIntraMax);
  const askShowAllPrices = useActivePrefs((s) => s.askPeakShowAllPrices);
  const askAllPriceRankLimit = useActivePrefs((s) => s.askPeakAllPriceRankLimit);
  const askVisibleMaxRankLimit = useActivePrefs((s) => s.askPeakVisibleMaxRankLimit);
  const bidIntraMax = useActivePrefs((s) => s.bidPeakIntraMax);
  const bidShowAllPrices = useActivePrefs((s) => s.bidPeakShowAllPrices);
  const primRef = useRef<PeakWallDockedLabelsPrimitive | null>(null);

  useEffect(() => {
    if (!series) return;
    const prim = new PeakWallDockedLabelsPrimitive();
    series.attachPrimitive(prim);
    primRef.current = prim;
    return () => {
      try {
        series.detachPrimitive(prim);
      } catch {
        /* chart already torn down */
      }
      primRef.current = null;
    };
  }, [series]);

  const updateLabels = useCallback(() => {
    const prim = primRef.current;
    if (!prim) return;
    const askRaw = askPeakEnabled
      ? buildAskPeakOverlaySegments({
        dayAskPeaks,
        todayAllPriceAskPeak,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color: askColor, lineWidth: askLineWidth },
        allPriceStyle: { color: askAllPriceColor, lineWidth: askAllPriceLineWidth },
        intraMax: askIntraMax,
        showAllPrices: askShowAllPrices,
        allPriceRankLimit: askAllPriceRankLimit as 1 | 2 | 3,
      })
      : [];
    const visibleRange = prim.chartApi()?.timeScale().getVisibleRange() ?? null;
    const askStyled = styleVisibleMaxAskPeakSegments(
      askRaw,
      visibleRange,
      { color: askVisibleMaxColor, lineWidth: askVisibleMaxLineWidth },
      askVisibleMaxRankLimit as 1 | 2 | 3,
    );
    const bidSegments = bidPeakEnabled
      ? buildBidPeakOverlaySegments({
        dayBidPeaks,
        todayAllPriceBidPeak,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color: bidColor, lineWidth: bidLineWidth },
        allPriceStyle: { color: bidAllPriceColor, lineWidth: bidAllPriceLineWidth },
        intraMax: bidIntraMax,
        showAllPrices: bidShowAllPrices,
      })
      : [];
    prim.setLabels([
      ...livePeakWallDockedLabelsFromSegments(askStyled),
      ...livePeakWallDockedLabelsFromSegments(bidSegments),
    ]);
  }, [
    askAllPriceColor,
    askAllPriceLineWidth,
    askAllPriceRankLimit,
    askColor,
    askIntraMax,
    askLineWidth,
    askPeakEnabled,
    askShowAllPrices,
    askVisibleMaxColor,
    askVisibleMaxLineWidth,
    askVisibleMaxRankLimit,
    axis,
    bidAllPriceColor,
    bidAllPriceLineWidth,
    bidColor,
    bidIntraMax,
    bidLineWidth,
    bidPeakEnabled,
    bidShowAllPrices,
    candles,
    dayAskPeaks,
    dayBidPeaks,
    segments,
    todayAllPriceAskPeak,
    todayAllPriceBidPeak,
    todayKst,
  ]);

  useEffect(() => {
    updateLabels();
  }, [updateLabels, series]);

  useEffect(() => {
    const prim = primRef.current;
    const chart = prim?.chartApi();
    if (!chart) return;
    const timeScale = chart.timeScale();
    const handler = () => updateLabels();
    timeScale.subscribeVisibleLogicalRangeChange(handler);
    updateLabels();
    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(handler);
    };
  }, [series, updateLabels]);

  return null;
}

export default memo(LivePeakWallDockedLabels);
```

- [ ] **Step 4: Import and mount overlay in LiveChartRoot**

In `frontend/src/live/LiveChartRoot.tsx`, add:

```ts
import LivePeakWallDockedLabels from './LivePeakWallDockedLabels';
```

Mount it after `LiveBidPeakSegments`:

```tsx
          {isMinuteTimeframe(timeframe) && (
            <LivePeakWallDockedLabels
              paneSeries={paneSeries}
              axis={axis}
              dayAskPeaks={dayAskPeaks}
              todayAllPriceAskPeak={todayAllPriceAskPeak}
              dayBidPeaks={dayBidPeaks}
              todayAllPriceBidPeak={todayAllPriceBidPeak}
              segments={cb.segments}
              candles={cb.candles}
              todayKst={todayKst}
            />
          )}
```

- [ ] **Step 5: Run LiveChartRoot test**

Run:

```bash
cd frontend
npm test -- LiveChartRoot.paneToggles.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run peak wall test group**

Run:

```bash
cd frontend
npm test -- AskPeakSegmentsPrimitive.test.ts PeakWallDockedLabelsPrimitive.test.ts LiveAskPeakSegments.test.tsx LiveChartRoot.paneToggles.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/live/LivePeakWallDockedLabels.tsx frontend/src/live/LiveChartRoot.tsx frontend/src/live/LiveChartRoot.paneToggles.test.tsx
git commit -m "feat: dock live peak wall labels"
```

---

### Task 5: Final Verification and Visual QA

**Files:**
- Modify only if Task 4 QA reveals a small right-lane padding issue:
  - `frontend/src/live/LiveChartRoot.tsx`
  - or the new `frontend/src/chart/PeakWallDockedLabelsPrimitive.ts`

**Interfaces:**
- Consumes: completed Tasks 1-4
- Produces: verified implementation with no broad chart behavior changes

- [ ] **Step 1: Run full frontend build**

Run:

```bash
cd frontend
npm run build
```

Expected: PASS with `tsc -b && vite build` completing.

- [ ] **Step 2: Run targeted frontend tests**

Run:

```bash
cd frontend
npm test -- AskPeakSegmentsPrimitive.test.ts PeakWallDockedLabelsPrimitive.test.ts LiveAskPeakSegments.test.tsx LiveChartRoot.paneToggles.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Start local dev server**

Run:

```bash
cd frontend
npm run dev -- --host 127.0.0.1
```

Expected: Vite prints a local URL such as `http://127.0.0.1:5173/`.

- [ ] **Step 4: Manual chart verification**

Open `/live` on a minute timeframe and verify:

```text
1. Enable 당일 매도 최대벽.
   Expected: today's ask labels are right-docked; past ask labels remain inline.
2. Enable 당일 매수 최대벽.
   Expected: today's bid labels join the same right-side lane.
3. Enable both ask and bid peak walls.
   Expected: close-price live labels stack vertically instead of overlapping.
4. Toggle 미체결 포함 최대벽 and rank limits.
   Expected: docked label colors match the corresponding rendered line colors.
5. Pan to past days.
   Expected: historical peak-wall labels keep their existing segment-end placement.
```

- [ ] **Step 5: Use Playwright screenshot if the dev server is available**

Run a browser check against the Vite URL. If the app needs live credentials or data that are not available in this worktree, record that limitation in the final implementation summary and rely on unit/build verification.

Expected visual state when data is available: live labels sit near the right pane edge, not on top of the latest candles.

- [ ] **Step 6: Commit any QA-only adjustment**

If no code changes were needed after Task 4, skip this commit. If a small adjustment was needed:

```bash
git add frontend/src/chart/PeakWallDockedLabelsPrimitive.ts frontend/src/live/LiveChartRoot.tsx
git commit -m "fix: tune peak wall docked label lane"
```
