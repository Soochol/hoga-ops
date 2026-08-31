// frontend/src/chart/drawing/chartCoordinates.ts
//
// Chart Coordinates — pixel ↔ (realMs, price) conversions for the Drawing
// Overlay. Every Y-conversion is pane-aware: the caller supplies a paneId
// that identifies which pane's price scale to use. lightweight-charts v5
// returns pane-LOCAL Y from `series.priceToCoordinate` / `coordinateToPrice`
// (origin at the pane's top, not the chart's top), so `priceToCanvasY` adds
// `paneTopY(paneId)` and `canvasYToPrice` subtracts it before round-trip.
//
// TWO COORDINATE SYSTEMS live side by side, and the distinction matters:
//   - RENDERING is done by pane primitives (DrawingsPrimitive.ts), which draw
//     on the pane's own canvas in PANE-LOCAL Y — they call
//     `series.priceToCoordinate` directly and never touch anything here.
//   - POINTER INPUT / HIT-TESTING still happens on the DOM overlay, which spans
//     the whole chart element, so everything in THIS file is CHART-GLOBAL:
//     `priceToCanvasY` adds `paneTopY`, `paneIdAtY` walks the stack, and
//     `canvasWidth` includes the price-axis column.
// Do not feed a value from one system into the other without converting.
//
// KNOWN 1px DRIFT below the first pane: `paneTopY` sums `getHeight()`, which
// excludes the 1px separator lwc draws between panes (measured on lwc 5.2 with
// a candle+volume layout: naive sum 419, actual canvas top 420). Rendering no
// longer has this error — a primitive draws on the pane's own canvas — so on
// the 2nd pane and below, hit-testing is 1px above where the drawing appears.
// That is far inside every HIT_THRESHOLD (6–8px), so it is a precision nit, not
// a "visible but ungrabbable" bug. Fixing it means either hardcoding the
// separator height (a fresh coupling to lwc's CSS) or measuring pane canvas
// offsets from the DOM; neither is worth it until the drift actually bites.
//
// Pane index is resolved at RUNTIME from `paneSeries` — each registered
// primary series reports its live pane via `getPane().paneIndex()` (LWC v5.2).
// This tracks conditionally-mounted panes (volume off, daily-only investor
// panes): a pane removed at runtime shifts every pane below it, and a static
// PANE_SPECS lookup would mislocate drawings on those shifted panes.

import type { IChartApi, ISeriesApi, Logical, UTCTimestamp } from 'lightweight-charts';
import { INTER_SEGMENT_GAP_MS } from '../../util/time';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { PaneId, Point } from './types';

export type PaneSeriesMap = ReadonlyMap<PaneId, ISeriesApi<any>>;

/**
 * Reference for extrapolating time into the empty band right of the last candle
 * (where `coordinateToTime` returns null). `lastRealMs` is the newest candle's
 * timestamp; `bucketMs` is the timeframe bar length. Drawings anchor there via
 * logical-index extrapolation so a trendline/vline/text can be placed in the
 * whitespace and still round-trips consistently. See the empty-band methods.
 */
export type FutureBand = { lastRealMs: number; bucketMs: number };

/**
 * Screen-uniform coordinate for horizontal DRAG translation: the BAR ORDINAL.
 * One unit is one on-screen column — 0 is the leftmost bar, +1 is always the
 * bar immediately to its right, including across a day boundary.
 *
 * THE COLUMNS ARE THE LOADED BARS, and the domain can only honour that claim
 * when it is HANDED them (`candles`). Without them it falls back to a ladder
 * derived from the session length — `floor(sessionLen / bucketMs) + 1` rungs
 * per session — which is the count of bar SLOTS, not of bars the chart drew.
 * Those differ by every slot that saw no trade: measured on /live 005930 1m,
 * **381 candles against 391 rungs in every completed session** — a 10-column
 * error per session, because the closing auction (15:21–15:29) prints nothing
 * and 15:20 → 15:30 is one column on screen but ten rungs on the ladder.
 *
 * That gap was silent until a vertex CROSSED a session boundary: every vertex
 * shifts by the same Δordinal, so one that crossed spent ladder rungs the
 * screen doesn't have and landed 10 columns off its siblings. A trendline
 * straddling Friday/Monday, dragged right into Monday, came out 38 columns
 * wide instead of 38 (measured: 38 → 48 on /live, magnet on and off alike).
 * Handing in `candles` removes the discrepancy at the source: one unit becomes
 * one lightweight-charts logical index, exactly.
 *
 * WHY NOT REAL MS: body-drag used to shift vertices by Δ-real-ms, but the
 * screen's X axis is the gap-compressed VirtualAxis. The moment the cursor
 * crossed a day boundary, Δms swallowed the whole inter-session gap (overnight
 * ~17.5h, weekends days) and the shifted vertices landed INSIDE a gap —
 * off-axis realMs that `axis.contains()` rejects. One gap-landed corner made a
 * rect/measure stretch to the canvas edge (the `?? 0 / ?? width` render
 * fallback); both corners gap-landed made it vanish from render AND hit-test.
 *
 * WHY NOT VIRTUAL MS EITHER: the fix for that was to translate in virtual ms,
 * which does keep every vertex on-axis — but virtual ms is NOT uniform on
 * screen. Two adjacent columns are `bucketMs` apart inside a session and only
 * `INTER_SEGMENT_GAP_MS` (1 000) apart across a day boundary: a factor of 60 on
 * the 1m timeframe, 1 800 on 30m. A drag applies ONE Δ to every vertex, so a
 * vertex straddling the boundary spent 1 000 units crossing it and the
 * remaining ~59 000 walking into the neighbouring session — it moved two
 * columns while the cursor moved one, and the shape stretched by exactly one
 * bar per straddled boundary (measured: trendline width 15 → 16, pencil span
 * 18 → 19). Symmetrically, when the CURSOR crossed the boundary the whole
 * drawing stalled for that frame (Δ = 1 000 → rounds to zero columns).
 *
 * Counting in BAR ORDINALS removes the non-uniformity at the source: the
 * boundary is worth exactly 1, like every other column.
 *
 * The domain extends linearly past the last candle so vertices anchored in the
 * empty right band (created there via FutureBand extrapolation) keep dragging
 * instead of getting clamped onto the last candle. The extension pitch matches
 * the render-side extrapolation: one bar per `bucketMs` of real time.
 */
export type DragBarDomain = {
  /** realMs → bar ordinal. A gap (or any time with no bar of its own) snaps
   *  FORWARD to the next column — so grabbing a drawing stranded there by the
   *  old real-ms drags heals it — and the empty band right of the last candle
   *  extends at one column per `bucketMs`. */
  toBar(realMs: number): number;
  /** Bar ordinal → realMs, rounded onto the bar grid. Inverse of `toBar` for
   *  every on-grid input; for an off-grid one it snaps to the nearest bar,
   *  which also heals residue persisted by the pre-ordinal drags. */
  toReal(bar: number): number;
  /** Ordinal of the axis origin (first session's first bar) — the left bound
   *  for the shape-preserving horizontal drag cap. */
  originBar: number;
  /** True when one unit is a column rather than a slice of virtual ms. False
   *  only on an intraday axis with neither loaded bars nor a known bar pitch,
   *  where the domain degrades to the old virtual-ms units. Consumers that read
   *  a delta as a BAR COUNT must gate on this; drag consumers need not, because
   *  they measure and apply the delta in the same domain either way.
   *
   *  ⚠ True does NOT by itself mean the count is exact — the session-length
   *  ladder is bar-sized and still over-counts by the empty slots (see above).
   *  Exactness comes from passing `candles`. */
  barSized: boolean;
};

/** First index of `times` whose value is >= `realMs`, or `times.length` when
 *  every value is smaller. Plain lower bound — the FORWARD snap the domain
 *  documents for a time that owns no column of its own. */
function lowerBoundIndex(times: readonly number[], realMs: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < realMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The bars lightweight-charts actually plotted, as a sorted realMs array —
 * i.e. its logical indices, one per on-screen column.
 *
 * `axis.contains` is exactly the projector's own drop predicate: `candle.ts`
 * skips a candle whose `classifyAndProject().contained` is false, and that is
 * `isRegularSession`, which `contains` delegates to. So filtering here
 * reproduces the series index-for-index rather than approximating it. Verified
 * on /live 005930 1m — lwc's `timeToIndex` for each session's first and last
 * candle was the cumulative loaded count exactly (0..380 / 381..761 / … over
 * six sessions), and `LiveChartRoot`'s viewport math already reads
 * `cb.candles.length` as the logical count.
 *
 * O(candles) per construction — ~2 000 iterations of a 6-segment binary search
 * on /live, negligible beside the render that asks for it, and the loop is the
 * price of not assuming the contained bars form one contiguous run.
 *
 * Null when nothing survives, so the caller falls back to the ladder.
 */
function loadedColumnTimes(
  axis: VirtualAxis,
  candles: readonly { ts_ms: number }[],
): number[] | null {
  const times: number[] = [];
  for (const c of candles) {
    if (axis.contains(c.ts_ms)) times.push(c.ts_ms);
  }
  return times.length > 0 ? times : null;
}

/** The exact domain: ordinals ARE indices into the plotted bars. */
function columnDomain(times: readonly number[], bucketMs: number): DragBarDomain {
  const lastBar = times.length - 1;
  const lastTs = times[lastBar];
  return {
    toBar(realMs: number): number {
      if (realMs > lastTs) {
        // Empty band right of the last candle — one column per `bucketMs`, the
        // same pitch `extrapolateFutureX` projects at. Unlike the ladder this
        // needs no `axis.contains` guard: past the last bar there is no column
        // whether or not the session is still open, so the extension is the
        // only answer and the two branches meet with no seam.
        return bucketMs > 0 ? lastBar + (realMs - lastTs) / bucketMs : lastBar;
      }
      // FORWARD, never nearest: a nearest-index snap would pull a vertex
      // stranded in an overnight gap BACK across the boundary onto the previous
      // close, which is the opposite of the documented heal. Live drags never
      // reach this off-grid — `coordinateToTime` only yields exact bar times —
      // so this branch exists for persisted residue.
      return lowerBoundIndex(times, realMs);
    },
    toReal(bar: number): number {
      if (bar > lastBar) {
        return bucketMs > 0 ? lastTs + Math.round(bar - lastBar) * bucketMs : lastTs;
      }
      return times[Math.min(Math.max(Math.round(bar), 0), lastBar)];
    },
    originBar: 0,
    barSized: true,
  };
}

export function dragBarDomain(
  axis: VirtualAxis,
  future?: FutureBand,
  candles?: readonly { ts_ms: number }[],
): DragBarDomain {
  // Exact path: count the bars the chart drew. The band pitch still comes from
  // the FutureBand; without one the domain simply cannot extend past the last
  // column (and `pixelToData` cannot resolve a time out there either, so no
  // drag reaches it).
  if (candles != null && candles.length > 0) {
    const times = loadedColumnTimes(axis, candles);
    if (times != null) return columnDomain(times, future?.bucketMs ?? 0);
  }
  // Approximate path — the session-length LADDER. Kept for the states that have
  // no bars to count (nothing loaded yet, a caller that cannot reach them). It
  // over-counts every session by its empty slots, so a boundary-crossing shift
  // is off by that much; see the DragBarDomain doc. Do not "simplify" the exact
  // path away into this one.
  const segments = axis.segments;
  const calendar = axis.mode === 'calendar';
  const bucketMs = future?.bucketMs ?? 0;
  // Calendar axes are one bar per segment by construction, so they can be
  // counted without knowing a bucket; intraday needs the pitch.
  if (segments.length === 0 || (!calendar && bucketMs <= 0)) {
    return virtualMsDomain(axis);
  }
  const hasFuture = future != null && bucketMs > 0;

  // First ordinal of each segment. A session owns the bar ladder
  // `open + k·bucketMs` capped at its close — the same ladder
  // `nearestBarGridRealMs` snaps to and `timeToCoordinate` can resolve.
  const barStarts: number[] = [];
  let total = 0;
  for (const seg of segments) {
    barStarts.push(total);
    total += calendar ? 1 : Math.floor((seg.sessionCloseMs - seg.sessionOpenMs) / bucketMs) + 1;
  }
  const lastBar = total - 1;

  /** On-axis realMs → ordinal, delegating gap/clamp policy to `axis.toVirtual`
   *  and converting its (non-uniform) virtual ms into (uniform) columns. */
  const onAxisBar = (realMs: number): number => {
    const v = axis.toVirtual(realMs);
    if (calendar) return (v - segments[0].virtualStart) / INTER_SEGMENT_GAP_MS;
    const idx = axis.findByVirtual(v);
    if (idx < 0) return 0;
    return barStarts[idx] + (v - segments[idx].virtualStart) / bucketMs;
  };
  const lastCandleBar = hasFuture ? onAxisBar(future.lastRealMs) : 0;

  /** Segment owning an integer ordinal (binary search over `barStarts`). */
  const segmentOfBar = (bar: number): number => {
    let lo = 0;
    let hi = barStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (barStarts[mid] <= bar) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  return {
    toBar(realMs: number): number {
      // Off-axis but past the last candle → the empty right band. Mirrors
      // realMsToCanvasX / extrapolateFutureX so drag and render agree.
      if (hasFuture && realMs > future.lastRealMs && !axis.contains(realMs)) {
        return lastCandleBar + (realMs - future.lastRealMs) / bucketMs;
      }
      return onAxisBar(realMs);
    },
    toReal(bar: number): number {
      // Past the last candle → invert the band extension. Inside the last
      // session this continues the same ladder, so the branch introduces no seam.
      if (hasFuture && bar > lastCandleBar) {
        return future.lastRealMs + Math.round(bar - lastCandleBar) * bucketMs;
      }
      const b = Math.min(Math.round(bar), lastBar);
      if (b <= 0) return segments[0].sessionOpenMs;
      const idx = segmentOfBar(b);
      const seg = segments[idx];
      if (calendar) return seg.sessionOpenMs;
      // No close cap needed: a segment owns exactly floor(len / bucketMs) + 1
      // ordinals, so the largest in-segment offset is floor(len / bucketMs) ×
      // bucketMs ≤ len — the result cannot overshoot its own session close.
      return seg.sessionOpenMs + (b - barStarts[idx]) * bucketMs;
    },
    originBar: 0,
    barSized: true,
  };
}

/** Degenerate domain for an intraday axis with no known bar pitch (no candles
 *  loaded). Units are virtual ms, so `barSized` is false. Drag still works —
 *  the delta is measured and applied in these same units — but the boundary is
 *  worth `INTER_SEGMENT_GAP_MS` instead of one column. In practice this path is
 *  unreachable from a drag: without candles `pixelToData` cannot resolve a
 *  cursor time, so the horizontal delta is zero anyway. */
function virtualMsDomain(axis: VirtualAxis): DragBarDomain {
  return {
    toBar: (realMs) => axis.toVirtual(realMs),
    toReal: (v) => axis.toReal(v),
    originBar: axis.segments.length > 0 ? axis.segments[0].virtualStart : 0,
    barSized: false,
  };
}

/**
 * Nearest bar-grid real-ms for an on-axis intraday `realMs`: the containing
 * segment's open plus a whole number of `bucketMs` buckets (capped at the
 * close). Candle times are anchored at each session's open, so this is exactly
 * the ladder `timeToCoordinate` can resolve. Passthrough for calendar axes
 * (their toReal only emits segment opens, which are bar times already) and for
 * off-axis times (the gap / future-band paths own those).
 */
function nearestBarGridRealMs(axis: VirtualAxis, realMs: number, bucketMs: number): number {
  if (axis.mode === 'calendar' || bucketMs <= 0) return realMs;
  const idx = axis.findByReal(realMs);
  if (idx < 0) return realMs;
  const seg = axis.segments[idx];
  if (realMs < seg.sessionOpenMs || realMs > seg.sessionCloseMs) return realMs;
  const sessionLen = seg.sessionCloseMs - seg.sessionOpenMs;
  const snapped = Math.round((realMs - seg.sessionOpenMs) / bucketMs) * bucketMs;
  return seg.sessionOpenMs + Math.min(snapped, sessionLen);
}

/**
 * Last-resort X for an on-axis time the series doesn't actually carry: ask lwc
 * for the NEAREST loaded bar index and take that bar's coordinate.
 *
 * Needed because the bar ladder is not the same set as the loaded bars. A
 * session owns `open + k·bucketMs` for every k, but a bucket with no trade
 * produces NO candle — measured on 005380 3m (20260211~20260608): 9039 ladder
 * rungs vs 8886 candles, **240 empty rungs (2.7%) spread over 69/69 trading
 * days**. `timeToCoordinate` is a lookup, not an interpolation, so an empty
 * rung yields null and the caller's `?? 0 / ?? width` render fallback pins the
 * vertex to a canvas edge — a trendline anchored there stretched across the
 * whole chart (reproduced 2026-08-17: moving the vertex one rung, from an empty
 * 09:03 to a loaded 09:12, made the artifact vanish).
 *
 * `timeToIndex(t, true)` returns a WHOLE index, which matters: fractional
 * arguments make `logicalToCoordinate` return 0 rather than null (see the
 * measurement on `extrapolateFutureX`).
 *
 * Same shape as `PeakWallSegmentsPrimitive.xCoordinateOrNearest`, which learned
 * this for wall segments in 2026-07. Kept local rather than shared: that one
 * takes an already-virtual `Time`, this one owns the realMs→virtual step.
 */
function nearestLoadedBarX(chart: IChartApi, axis: VirtualAxis, realMs: number): number | null {
  const ts = chart.timeScale();
  const idx = ts.timeToIndex((axis.toVirtual(realMs) / 1000) as UTCTimestamp, true);
  if (idx == null) return null;
  const x = ts.logicalToCoordinate(idx as unknown as Logical);
  return x == null ? null : Number(x);
}

/** Core real→canvas-X (in-axis only). Split out so the future-band path can
 *  resolve the last candle's coordinate without re-entering the wrapper. */
function coreRealMsToCanvasX(chart: IChartApi, axis: VirtualAxis, realMs: number): number | null {
  if (!axis.contains(realMs)) return null;
  const virtualMs = axis.toVirtual(realMs);
  const x = chart.timeScale().timeToCoordinate((virtualMs / 1000) as UTCTimestamp);
  return x == null ? null : (x as number);
}

/**
 * realMs (past the last candle) → canvas X via logical-index extrapolation:
 * bars-ahead = (realMs − lastRealMs) / bucketMs, projected off the last
 * candle's logical position. Returns null if the last candle can't be located.
 *
 * ⚠ `logicalToCoordinate` RESOLVES ONLY WHOLE LOGICAL INDICES — a fractional
 * argument returns **0**, not null and not an interpolated coordinate (measured
 * on lwc 5.2, 60m chart: 1155 → 312.7, 1156 → 319.9, but 1155.1 / 1155.25 /
 * 1155.5 / 1155.75 → 0). Since `x == null ? null : x` treats that 0 as a real
 * coordinate, a fractional `barsAhead` used to pin the vertex to the canvas's
 * left edge — a trendline drawn minutes ago stretched across the whole chart.
 *
 * `barsAhead` is fractional exactly when the drawing's realMs is off the
 * timeframe's bar grid, which is the NORMAL case for every aggregated minute
 * frame: `/live` fetches 1m and folds it client-side (`aggregateCandles`), so a
 * realMs on the 1m grid divides 3m/5m/…/240m unevenly. 1m alone was accidentally
 * safe (bucketMs = 60 000 divides its own grid), which is why this survived so
 * long — and why the symptom read as "each minute frame saves something
 * different" rather than as one broken projection.
 *
 * So the pitch is MEASURED in pixels between two whole logicals and multiplied,
 * instead of handing lwc a fraction. Do not "simplify" this back to
 * `logicalToCoordinate(lastLogical + barsAhead)`.
 */
function extrapolateFutureX(
  chart: IChartApi,
  axis: VirtualAxis,
  realMs: number,
  future: FutureBand,
): number | null {
  const ts = chart.timeScale();
  const lastX = coreRealMsToCanvasX(chart, axis, future.lastRealMs);
  if (lastX == null) return null;
  const lastLogical = ts.coordinateToLogical(lastX);
  if (lastLogical == null) return null;
  // Round before re-projecting: `coordinateToLogical` may hand back a fraction,
  // and only whole indices resolve (see above). `baseX` is re-derived from the
  // rounded logical rather than reusing `lastX` so the two ends of `barPx` come
  // from the same grid.
  const baseLogical = Math.round(lastLogical as number);
  const baseX = ts.logicalToCoordinate(baseLogical as Logical);
  const nextX = ts.logicalToCoordinate((baseLogical + 1) as Logical);
  if (baseX == null || nextX == null) return null;
  const barPx = (nextX as number) - (baseX as number);
  const barsAhead = (realMs - future.lastRealMs) / future.bucketMs;
  return (baseX as number) + barsAhead * barPx;
}

/**
 * Width of one bar in canvas pixels, or null when it can't be measured.
 *
 * Measured from two ADJACENT WHOLE logical indices rather than read off
 * `options().timeScale.barSpacing`: that option is the configured value, not
 * the live one — after a zoom it stayed at 6 while the bars were actually
 * 15.8px apart (measured on /live, lwc 5.2). lwc has no public getter for the
 * effective spacing, so two projections and a subtraction are the reading.
 *
 * The base index comes from the visible range so it is guaranteed to be a
 * logical the time scale can currently project (`logicalToCoordinate` resolves
 * only whole indices — a fraction returns 0, see `extrapolateFutureX`).
 *
 * Returns null rather than a default: callers treat "unknown pitch" as
 * "sub-bar offset = 0", which degrades to the bar-anchored behaviour instead
 * of scaling an offset by a made-up number.
 */
export function barPitchPx(chart: IChartApi): number | null {
  const ts = chart.timeScale();
  // Optional-called for the same reason `paneSeparatorHeight` calls
  // `getHTMLElement?.()`: headless stubs implement only the time-scale methods
  // the case under test needs, and a missing one must degrade to "unknown
  // pitch", not throw out of a pointer handler or a draw call.
  const range = ts.getVisibleLogicalRange?.();
  if (range == null) return null;
  // `from` can be negative (left whitespace) or fractional; ceil lands on a
  // whole index inside the range, and `+1` stays inside for any range wider
  // than one bar.
  const base = Math.ceil(range.from);
  const baseX = ts.logicalToCoordinate?.(base as Logical);
  const nextX = ts.logicalToCoordinate?.((base + 1) as Logical);
  if (baseX == null || nextX == null) return null;
  const pitch = (nextX as number) - (baseX as number);
  return Number.isFinite(pitch) && pitch > 0 ? pitch : null;
}

/** Canvas X (in the empty band) → realMs via logical-index extrapolation. Only
 *  extrapolates to the RIGHT of the last candle (the empty band); returns null
 *  for the left whitespace to avoid colliding with real historical time. */
function extrapolateFutureRealMs(
  chart: IChartApi,
  axis: VirtualAxis,
  px: number,
  future: FutureBand,
): number | null {
  const ts = chart.timeScale();
  const lastX = coreRealMsToCanvasX(chart, axis, future.lastRealMs);
  if (lastX == null) return null;
  const lastLogical = ts.coordinateToLogical(lastX);
  const logical = ts.coordinateToLogical(px);
  if (lastLogical == null || logical == null) return null;
  if ((logical as number) <= (lastLogical as number)) return null; // right band only
  return future.lastRealMs + ((logical as number) - (lastLogical as number)) * future.bucketMs;
}

/** A series' live pane index, or -1 if the chart/series is mid-teardown. */
function safePaneIndex(series: ISeriesApi<any>): number {
  try {
    return series.getPane().paneIndex();
  } catch {
    return -1;
  }
}

/**
 * Runtime paneId → pane index via the mounted series' `getPane().paneIndex()`.
 * Returns -1 when the pane isn't currently mounted (toggled off) — callers
 * skip rather than mislocating onto another pane.
 */
export function paneIdToIndex(paneSeries: PaneSeriesMap, paneId: PaneId): number {
  const series = paneSeries.get(paneId);
  return series ? safePaneIndex(series) : -1;
}

/** Reverse map: runtime pane index → paneId, from the mounted series. */
function indexToPaneId(paneSeries: PaneSeriesMap): Map<number, PaneId> {
  const m = new Map<number, PaneId>();
  for (const [paneId, series] of paneSeries) {
    const idx = safePaneIndex(series);
    if (idx >= 0) m.set(idx, paneId);
  }
  return m;
}

/**
 * Real Unix-ms → canvas X. Time axis is shared across panes.
 * Returns null when `realMs` falls outside every Virtual Axis segment.
 */
export function realMsToCanvasX(
  chart: IChartApi,
  axis: VirtualAxis,
  realMs: number,
  future?: FutureBand,
): number | null {
  const inAxis = coreRealMsToCanvasX(chart, axis, realMs);
  if (inAxis != null) return inAxis;
  // Empty band right of the last candle: extrapolate so future-anchored
  // drawings still render.
  if (future && future.bucketMs > 0 && realMs > future.lastRealMs) {
    return extrapolateFutureX(chart, axis, realMs, future);
  }
  // On-axis but off the bar grid (a persisted boundary-crossing drag residue,
  // ±INTER_SEGMENT_GAP_MS per crossed session boundary): timeToCoordinate only
  // resolves exact bar times, so retry on the nearest bar. Without this the
  // `?? 0 / ?? width` render fallback pins the vertex to the canvas edge and
  // the drawing appears stretched. The drag path snaps new values (see
  // dragTimeDomain.toReal); this covers drawings saved before that snap.
  if (future && future.bucketMs > 0 && axis.contains(realMs)) {
    const snapped = nearestBarGridRealMs(axis, realMs, future.bucketMs);
    if (snapped !== realMs) {
      const snappedX = coreRealMsToCanvasX(chart, axis, snapped);
      if (snappedX != null) return snappedX;
    }
    // Still nothing: the vertex sits ON the ladder but the series has no bar
    // there (an empty bucket — no trade in that window). The retry above cannot
    // help, because it snaps to the very rung the vertex already occupies, so
    // `snapped === realMs` and it doesn't even fire. See `nearestLoadedBarX`.
    return nearestLoadedBarX(chart, axis, realMs);
  }
  // No bucket pitch → no grid to reason about; callers own this case.
  return null;
}

/**
 * Nearest on-axis realMs for an `realMs` the axis doesn't `contains()`. Used to
 * keep a single-anchor drawing (text) visible instead of vanishing when its
 * anchor is dragged into an inter-session gap / weekend / before the first
 * session. Multi-point drawings survive via `?? 0 / ?? width` edge clamps; a
 * lone point has nothing to clamp to, so we snap the *realMs* to the closest
 * session boundary (which the compressed gap renders adjacent to on screen).
 *
 * - Before the first session → first session's open.
 * - After the last session's close → last session's close.
 * - In a gap between segment N and N+1 → whichever of `N.close` / `N+1.open`
 *   is nearer in real time.
 *
 * Returns null only for an empty axis.
 */
function nearestOnAxisRealMs(axis: VirtualAxis, realMs: number): number | null {
  const segs = axis.segments;
  if (segs.length === 0) return null;
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (realMs <= first.sessionOpenMs) return first.sessionOpenMs;
  if (realMs >= last.sessionCloseMs) return last.sessionCloseMs;
  // Somewhere in the interior but off-axis → an inter-session gap. findByReal
  // returns the segment on the LEFT of the gap (the "prior" segment).
  const idx = axis.findByReal(realMs);
  if (idx < 0) return first.sessionOpenMs;
  const prior = segs[idx];
  const next = segs[idx + 1];
  if (!next) return prior.sessionCloseMs;
  const distPrior = realMs - prior.sessionCloseMs;
  const distNext = next.sessionOpenMs - realMs;
  return distPrior <= distNext ? prior.sessionCloseMs : next.sessionOpenMs;
}

/**
 * Like `realMsToCanvasX` but never returns null for a mounted axis: an off-axis
 * `realMs` (gap / weekend / pre-axis) is snapped to the nearest session
 * boundary via `nearestOnAxisRealMs` and projected there. Render and hit-test
 * for a single-anchor text share this so an off-axis text stays both visible
 * AND grabbable (rather than vanishing, then being un-selectable). Still returns
 * null only when the axis is empty or the time scale can't resolve at all.
 */
export function realMsToCanvasXClamped(
  chart: IChartApi,
  axis: VirtualAxis,
  realMs: number,
  future?: FutureBand,
): number | null {
  const direct = realMsToCanvasX(chart, axis, realMs, future);
  if (direct != null) return direct;
  const clamped = nearestOnAxisRealMs(axis, realMs);
  if (clamped == null) return null;
  return coreRealMsToCanvasX(chart, axis, clamped);
}

/**
 * Canvas X → real Unix-ms — the time-only inverse of `realMsToCanvasX` and the
 * X-half of `pixelToData`. Used by the vertical-line tool (price-independent)
 * and by vline body-drag, which must resolve horizontally without touching any
 * pane's price scale. Returns null in the chart's empty band where
 * `coordinateToTime` can't resolve a coordinate.
 */
export function canvasXToRealMs(
  chart: IChartApi,
  axis: VirtualAxis,
  px: number,
  future?: FutureBand,
): number | null {
  const timeSec = chart.timeScale().coordinateToTime(px);
  if (timeSec != null) return axis.toReal((timeSec as number) * 1000);
  // Empty band: coordinateToTime is null past the last bar → extrapolate.
  if (future && future.bucketMs > 0) return extrapolateFutureRealMs(chart, axis, px, future);
  return null;
}

/**
 * Height of the separator lwc draws between panes, measured once per chart.
 *
 * `IPaneApi.getHeight()` reports the pane's own height and EXCLUDES the
 * separator, so summing heights loses one separator per pane boundary. Measured
 * on lwc 5.2: the drift is exactly `paneIndex × 1px` — 0/1/2/3/4 across a
 * five-pane chart. By the 7th pane that reaches 6px, which is hline's entire
 * HIT_THRESHOLD: a horizontal line on a low pane would stop being clickable
 * where it is drawn.
 *
 * Measured rather than hardcoded — it is lwc's CSS, not our constant, and a
 * `= 1` here would be a silent coupling that breaks on their next restyle.
 * Cached per chart instance: `getBoundingClientRect` forces layout, and this is
 * on the hit-test path which runs once per frame while hovering.
 */
const separatorHeightByChart = new WeakMap<IChartApi, number>();

function paneSeparatorHeight(chart: IChartApi): number {
  const cached = separatorHeightByChart.get(chart);
  if (cached != null) return cached;
  const panes = chart.panes();
  // Fewer than two panes → no boundary to measure, and no drift to correct.
  // Not cached: panes appear later and the measurement becomes possible.
  if (panes.length < 2) return 0;
  // Optional-called: `getHTMLElement` landed in lwc 5.2, and test stubs supply
  // only the pane methods they exercise. Missing → fall back to no separator,
  // which is exactly the pre-fix arithmetic.
  const first = panes[0].getHTMLElement?.();
  const second = panes[1].getHTMLElement?.();
  if (!first || !second) return 0; // pre-mount, or a headless test stub
  const gap =
    second.getBoundingClientRect().top -
    first.getBoundingClientRect().top -
    panes[0].getHeight();
  // Guard against a transient layout (mid-resize) reporting nonsense.
  const measured = Number.isFinite(gap) && gap >= 0 && gap <= 8 ? gap : 0;
  separatorHeightByChart.set(chart, measured);
  return measured;
}

/**
 * Sum of pane heights above `paneId`, plus the separators between them. For the
 * candle pane (index 0) this is 0. Returns 0 when the pane isn't mounted.
 *
 * Why this exists: lightweight-charts v5's `series.priceToCoordinate` and
 * `coordinateToPrice` operate in **pane-local Y** (origin at the pane's
 * top, not the chart's top). Pointer input arrives in chart-global Y, so it
 * must be converted before reaching a series — and back again for hit-testing.
 */
export function paneTopY(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
): number {
  const idx = paneIdToIndex(paneSeries, paneId);
  if (idx < 0) return 0;
  const panes = chart.panes();
  const separator = paneSeparatorHeight(chart);
  let top = 0;
  for (let i = 0; i < idx && i < panes.length; i++) top += panes[i].getHeight() + separator;
  return top;
}

/**
 * Price → chart-global canvas Y for the pane identified by `paneId`.
 * The series' pane-local Y is shifted by `paneTopY(paneId)` so the
 * caller can draw the result directly onto the overlay canvas without
 * knowing which pane it belongs to.
 *
 * Returns null when that pane's primary series isn't registered or the
 * price falls outside the series' visible price range.
 */
export function priceToCanvasY(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  price: number,
): number | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const yLocal = series.priceToCoordinate(price);
  if (yLocal == null) return null;
  return Number(yLocal) + paneTopY(chart, paneSeries, paneId);
}

/**
 * Chart-global pixel Y → price for the pane identified by `paneId` — the
 * time-independent inverse of `priceToCanvasY` and the Y-half of
 * `pixelToData`. Subtracts the pane offset before calling
 * `series.coordinateToPrice` because that API expects pane-local Y.
 *
 * Unlike `pixelToData` this never touches the time axis, so it resolves
 * everywhere the pane's price scale is mounted — including the chart's empty
 * band to the right of the last candle, where `coordinateToTime` (and thus
 * `pixelToData`) returns null. The body-drag path uses it so a price-only
 * drawing (hline) keeps dragging in that band. Returns null only when the
 * pane's series isn't registered or the Y is off the price scale.
 */
export function canvasYToPrice(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  py: number,
): number | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const yLocal = py - paneTopY(chart, paneSeries, paneId);
  const price = series.coordinateToPrice(yLocal);
  return price == null ? null : Number(price);
}

/**
 * Domain price at the top and bottom edges of `paneId`'s pane, read from the
 * registered series' `coordinateToPrice` at the pane-local top (0) and bottom
 * (pane height). Pane-local because `coordinateToPrice` expects pane-local Y.
 *
 * The shape-preserving translate cap (selectTool body-drag) needs the pane's
 * full price span to clamp a whole Drawing without collapsing it; this is the
 * price-axis sibling of `clampYToPane` (which clamps in pixels). Returns null
 * when the pane or its series isn't mounted, or the price scale can't resolve.
 */
export function priceBoundsForPane(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
): { top: number; bottom: number } | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const idx = paneIdToIndex(paneSeries, paneId);
  const panes = chart.panes();
  if (idx < 0 || idx >= panes.length) return null;
  const paneH = panes[idx].getHeight();
  const topPrice = series.coordinateToPrice(0);
  const bottomPrice = series.coordinateToPrice(paneH);
  if (topPrice == null || bottomPrice == null) return null;
  return { top: Number(topPrice), bottom: Number(bottomPrice) };
}

/**
 * Chart-global pixel (px, py) → domain Point (realMs, price) for the
 * pane identified by `paneId`. Subtracts the pane offset before calling
 * `series.coordinateToPrice` because that API expects pane-local Y.
 *
 * Returns null when the time or price axis cannot resolve.
 */
export function pixelToData(
  chart: IChartApi,
  axis: VirtualAxis,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  px: number,
  py: number,
  future?: FutureBand,
): Point | null {
  const series = paneSeries.get(paneId);
  if (!series) return null;
  const timeSec = chart.timeScale().coordinateToTime(px);
  let realMs: number | null;
  if (timeSec != null) {
    realMs = axis.toReal((timeSec as number) * 1000);
  } else {
    // Empty band right of the last candle: extrapolate the time so trendline /
    // rect / measure / text can be created there (price resolves below).
    realMs = future && future.bucketMs > 0 ? extrapolateFutureRealMs(chart, axis, px, future) : null;
  }
  if (realMs == null) return null;
  const yLocal = py - paneTopY(chart, paneSeries, paneId);
  const price = series.coordinateToPrice(yLocal);
  if (price == null) return null;
  return { realMs, price: Number(price) };
}

/**
 * Cursor pixel Y → PaneId of the pane the cursor is inside. Falls back to
 * the first pane when py < 0, the last pane when py is beyond the chart
 * bottom — resolved from the live mounted order (not static PANE_SPECS).
 */
export function paneIdAtY(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  py: number,
): PaneId {
  const byIndex = indexToPaneId(paneSeries);
  const fallback = byIndex.get(0) ?? 'candle';
  const panes = chart.panes();
  if (panes.length === 0 || py < 0) return fallback;
  const separator = paneSeparatorHeight(chart);
  let cursor = 0;
  for (let i = 0; i < panes.length; i++) {
    // Each separator counts as part of the pane ABOVE it. Leaving it out would
    // open a 1px gap between panes that matches no branch, and a cursor landing
    // exactly there would fall past the loop to the "below the chart" fallback
    // — the bottom pane, possibly several panes away.
    const span = panes[i].getHeight() + (i === panes.length - 1 ? 0 : separator);
    if (py >= cursor && py < cursor + span) {
      return byIndex.get(i) ?? fallback;
    }
    cursor += span;
  }
  return byIndex.get(panes.length - 1) ?? fallback;
}

/**
 * Clamp a pixel Y to the vertical span of `paneId`'s pane. Used by tools
 * during creation drag and by body-translate so a Drawing started in one
 * pane never escapes into another. A no-op (returns py) when the pane is
 * not mounted.
 */
export function clampYToPane(
  chart: IChartApi,
  paneSeries: PaneSeriesMap,
  paneId: PaneId,
  py: number,
): number {
  const idx = paneIdToIndex(paneSeries, paneId);
  if (idx < 0) return py;
  const panes = chart.panes();
  const top = paneTopY(chart, paneSeries, paneId);
  const h = panes[idx]?.getHeight() ?? 0;
  const bottom = top + h;
  return Math.max(top, Math.min(bottom - 1, py));
}
