import type { IChartApi, IPriceScaleApi, ISeriesApi, ITimeScaleApi, Logical, LogicalRange, Time } from 'lightweight-charts';
import { syncSeriesData, type SeriesDataSink } from './seriesDataDiff';
import { viewportHasReprojectableAnchor } from '../live/minuteViewportPolicy';

type Point = Parameters<SeriesDataSink['setData']>[0][number];
type Series = ISeriesApi<any>;
type Range = { from: number; to: number };
/** Immutable coordinate generation used by the data currently on screen.
 * A Virtual Axis can rebase on prepend; reading a mutable axisRef here would
 * interpret the old grid with the new calendar. */
export type WindowedChartTimeMapping = {
  toReal(time: number): number;
  fromReal(realMs: number): number;
};
const identityMapping: WindowedChartTimeMapping = {
  toReal: time => time * 1000,
  fromReal: realMs => realMs / 1000,
};
type State = {
  native: Series;
  api: Series;
  data: Point[];
  rendered: readonly Point[] | null;
  listeners: Set<(scope: 'full' | 'update') => void>;
  change: 'full' | 'update' | null;
};

/** Public-API adapter: application coordinates and data remain full-history;
 * lightweight-charts receives a contiguous union-time window around the view.
 * Never change VirtualAxis origin or recalculate indicators on the window.
 * All series replacements in a React commit are batched before viewport repair.
 * Sparse line neighbours extend the SAME envelope for every pane, so local
 * logical + offset equals the full union index (including whitespace slots).
 * Unsupported options conservatively use full data. No lwc private API. */
const controllers = new WeakMap<IChartApi, WindowedChart>();

function lowerBound<T>(values: readonly T[], value: number, key: (row: T) => number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(values[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
const timeOf = (row: Point) => row.time as number;
const numberKey = (n: number) => n;
const hasValue = (row: Point) => 'value' in row || 'close' in row;

/** Keep the native receiver when delegating methods; proxies must not become
 * `this` inside lwc. Overrides are the deliberately different contracts. */
function facade<T extends object>(native: T, overrides: Record<string, unknown>): T {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(native, {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key];
      if (methods.has(key)) return methods.get(key);
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      const bound = value.bind(target);
      methods.set(key, bound);
      return bound;
    },
  });
}

export function createWindowedChart(native: IChartApi): IChartApi {
  // Partial adapters used by component tests retain their original contract.
  if (typeof native.subscribeDblClick !== 'function') return native;
  // Touch inertia is owned by lwc and uses a gesture-start local index. Keep
  // its full renderer on touch devices; this adapter owns mouse panning only.
  if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) return native;
  const controller = new WindowedChart(native);
  controllers.set(controller.chart, controller);
  return controller.chart;
}

export function flushWindowedChart(chart: IChartApi | null): void {
  if (chart) controllers.get(chart)?.flush();
}

/** Install the next committed axis before child series effects enqueue data.
 * The controller retains the previous mapping until that batch is applied. */
export function setWindowedChartTimeMapping(chart: IChartApi | null, mapping: WindowedChartTimeMapping): void {
  if (chart) controllers.get(chart)?.setTimeMapping(mapping);
}

export function ownsWindowedChartViewport(chart: IChartApi): boolean {
  return controllers.has(chart);
}

/** Also lets performance tests measure real native setData rather than the
 * inexpensive application-facing enqueue. No extra global chart ownership. */
export function windowedChartDiagnostics(chart: IChartApi) {
  return controllers.get(chart)?.diagnostics() ?? null;
}

class WindowedChart {
  readonly chart: IChartApi;
  private readonly native: IChartApi;
  private readonly scale: ITimeScaleApi<Time>;
  private readonly states = new Map<Series, State>();
  private times: number[] = [];
  private mapping = identityMapping;
  private nextMapping = identityMapping;
  private latestCandleTime: number | null = null;
  // lwc applies setVisibleLogicalRange on its next draw. A second batch before
  // that frame must inherit the requested position, not the stale native one.
  private requestedRange: Range | null = null;
  private offset = 0;
  private end = -1;
  private dirty = false;
  private queued = false;
  private busy = false;
  private removed = false;
  private fallback: string | null = null;
  private readonly logicalListeners = new Set<(range: LogicalRange | null) => void>();
  private readonly timeListeners = new Set<(range: { from: Time; to: Time } | null) => void>();
  private readonly mouseListeners = new Map<string, Map<any, any>>();
  private detachInteractions: (() => void) | null = null;
  private drag: { id: number; x: number; lastX: number; range: Range;
    vertical: { scale: IPriceScaleApi; range: Range; y: number; slope: number; logarithmic: boolean } | null;
  } | null = null;
  private gestureWrite = false;
  private animationFrame: number | null = null;
  private animation: { from: Range; target: Range; start: number } | null = null;
  private animationWrite = false;
  private rangeFrame: number | null = null;

  constructor(native: IChartApi) {
    this.native = native;
    this.scale = native.timeScale();
    const timeScale = facade(this.scale, {
      getVisibleLogicalRange: () => this.appliedRange(),
      getVisibleRange: () => this.visibleTimes(),
      setVisibleLogicalRange: (range: Range) => this.setRange(range),
      setVisibleRange: (range: { from: Time; to: Time }) => {
        this.flush();
        const from = this.index(range.from, true);
        const to = this.index(range.to, true);
        if (from !== null && to !== null) this.setRange({ from, to });
      },
      timeToIndex: (time: Time, nearest = false) => this.index(time, nearest),
      logicalToCoordinate: (logical: number) => this.scale.logicalToCoordinate((logical - this.offset) as Logical),
      coordinateToLogical: (x: number) => {
        const local = this.scale.coordinateToLogical(x);
        return local === null ? null : local + this.offset;
      },
      timeToCoordinate: (time: Time) => {
        const index = this.index(time);
        return index === null ? null : this.scale.logicalToCoordinate((index - this.offset) as Logical);
      },
      coordinateToTime: (x: number) => {
        const index = this.scale.coordinateToLogical(x);
        return index === null ? null : this.times[Math.round(index + this.offset)] ?? null;
      },
      scrollPosition: () => this.scale.scrollPosition() + this.end - (this.times.length - 1),
      scrollToPosition: (position: number, animated: boolean) => {
        this.flush();
        const range = this.range();
        if (!range) return;
        const to = this.times.length - 1 + position;
        const target = { from: to - (range.to - range.from), to };
        if (animated) this.animateRange(target);
        else {
          this.setRange(target);
          this.scale.scrollToPosition(position + this.times.length - 1 - this.end, false);
        }
      },
      scrollToRealTime: () => {
        this.flush();
        const range = this.range();
        if (!range) return;
        const to = this.times.length - 1 + this.scale.options().rightOffset;
        this.animateRange({ from: to - (range.to - range.from), to });
      },
      fitContent: () => {
        this.flush();
        if (this.times.length) this.setRange({ from: 0, to: this.times.length - 1 });
      },
      resetTimeScale: () => {
        this.flush();
        const spacing = this.native.options().timeScale.barSpacing;
        this.scale.applyOptions({ barSpacing: spacing });
        const to = this.times.length - 1 + this.scale.options().rightOffset;
        this.setRange({ from: to - (this.scale.width() / spacing - 1), to });
      },
      subscribeVisibleLogicalRangeChange: (cb: (r: LogicalRange | null) => void) => this.logicalListeners.add(cb),
      unsubscribeVisibleLogicalRangeChange: (cb: (r: LogicalRange | null) => void) => this.logicalListeners.delete(cb),
      subscribeVisibleTimeRangeChange: (cb: (r: { from: Time; to: Time } | null) => void) => this.timeListeners.add(cb),
      unsubscribeVisibleTimeRangeChange: (cb: (r: { from: Time; to: Time } | null) => void) => this.timeListeners.delete(cb),
    });
    const overrides: Record<string, unknown> = {
      timeScale: () => timeScale,
      addSeries: (...args: Parameters<IChartApi['addSeries']>) => this.add(native.addSeries(...args)),
      addCustomSeries: (...args: Parameters<IChartApi['addCustomSeries']>) => this.add(native.addCustomSeries(...args)),
      removeSeries: (api: Series) => {
        const state = this.states.get(api);
        if (!state) return native.removeSeries(api);
        this.busy = true;
        try { native.removeSeries(state.native); } finally { this.busy = false; }
        this.states.delete(api);
        this.enqueue();
      },
      setCrosshairPosition: (price: number, time: Time, api: Series) => native.setCrosshairPosition(price, time, this.states.get(api)?.native ?? api),
      panes: () => native.panes().map((pane) => facade(pane, {
        getSeries: () => pane.getSeries().map((series) => this.appSeries(series)),
      })),
      remove: () => {
        this.removed = true;
        this.stopAnimation();
        if (this.rangeFrame !== null) cancelAnimationFrame(this.rangeFrame);
        this.detachInteractions?.();
        this.states.clear();
        this.times = [];
        this.logicalListeners.clear();
        this.timeListeners.clear();
        this.mouseListeners.clear();
        native.remove();
      },
    };
    for (const event of ['Click', 'DblClick', 'CrosshairMove'] as const) {
      const wrapped = new Map<any, any>();
      this.mouseListeners.set(event, wrapped);
      overrides[`subscribe${event}`] = (cb: any) => {
        if (wrapped.has(cb)) return;
        const listener = (param: any) => {
          if (this.busy) return;
          cb({ ...param,
            logical: param.logical == null ? param.logical : param.logical + this.offset,
            hoveredSeries: param.hoveredSeries ? this.appSeries(param.hoveredSeries) : undefined,
            seriesData: new Map([...param.seriesData].map(([series, point]) => [this.appSeries(series), point])),
          });
        };
        wrapped.set(cb, listener);
        native[`subscribe${event}`](listener);
      };
      overrides[`unsubscribe${event}`] = (cb: any) => {
        const listener = wrapped.get(cb);
        if (listener) native[`unsubscribe${event}`](listener);
        wrapped.delete(cb);
      };
    }
    this.chart = facade(native, overrides);
    this.installMouseInteractions();
    this.scale.subscribeVisibleLogicalRangeChange(() => {
      if (this.busy || this.removed) return;
      this.requestedRange = null;
      const range = this.range();
      if (range) this.render(range);
      this.queueRangePublish();
    });
  }

  private installMouseInteractions(): void {
    if (typeof this.native.chartElement !== 'function') return;
    const element = this.native.chartElement();
    const options = this.native.options();
    const pan = typeof options.handleScroll === 'boolean' ? options.handleScroll : options.handleScroll.pressedMouseMove;
    const axisReset = typeof options.handleScale === 'boolean' ? options.handleScale : options.handleScale.axisDoubleClickReset;
    const reset = typeof axisReset === 'boolean' ? axisReset : axisReset.time;
    // Native drag snapshots its local rightOffset at pointer-down. Rewindowing
    // changes that offset and would make the next move jump. Own mouse pans in
    // full-history coordinates, just like the existing wheel interaction.
    this.native.applyOptions({ handleScroll: { pressedMouseMove: false }, handleScale: { axisDoubleClickReset: { time: false } } });
    const down = (event: PointerEvent) => {
      if (!pan || event.button !== 0 || event.pointerType !== 'mouse') return;
      if (event.target instanceof HTMLElement && event.target.style.cursor === 'row-resize') return;
      this.stopAnimation();
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      if (x < 0 || x > this.scale.width()) return; // price-axis gestures remain native
      const y = event.clientY;
      const pane = this.native.panes().find(p => {
        const r = p.getHTMLElement()?.getBoundingClientRect();
        return r && y >= r.top && y <= r.bottom;
      });
      if (!pane) return; // separator/time-axis gestures remain native
      const range = this.range();
      const series = pane.getSeries().find(s => s.options().priceScaleId === 'right') ?? pane.getSeries()[0];
      const scale = series?.priceScale();
      const prices = scale?.getVisibleRange();
      const top = prices ? series.priceToCoordinate(prices.to) : null;
      const bottom = prices ? series.priceToCoordinate(prices.from) : null;
      const logarithmic = scale?.options().mode === 1;
      const vertical = scale && !scale.options().autoScale && prices && top !== null && bottom !== null && top !== bottom
        ? { scale, range: prices, y, logarithmic,
            slope: (logarithmic ? Math.log(prices.to / prices.from) : prices.to - prices.from) / (bottom - top) }
        : null;
      if (range) this.drag = { id: event.pointerId, x: event.clientX, lastX: event.clientX, range, vertical };
    };
    const move = (event: PointerEvent) => {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.id) return;
      drag.lastX = event.clientX;
      const delta = (event.clientX - drag.x) / this.scale.options().barSpacing;
      this.gestureWrite = true;
      try { this.setRange({ from: drag.range.from - delta, to: drag.range.to - delta }); }
      finally { this.gestureWrite = false; }
      const vertical = drag.vertical;
      if (vertical) {
        const shift = (event.clientY - vertical.y) * vertical.slope;
        vertical.scale.setVisibleRange(vertical.logarithmic
          ? { from: vertical.range.from * Math.exp(shift), to: vertical.range.to * Math.exp(shift) }
          : { from: vertical.range.from + shift, to: vertical.range.to + shift });
      }
    };
    const up = (event: PointerEvent) => { if (this.drag?.id === event.pointerId) this.drag = null; };
    const doubleClick = (event: MouseEvent) => {
      if (!reset) return;
      const rect = element.getBoundingClientRect();
      if (event.clientX - rect.left <= this.scale.width() && event.clientY >= rect.bottom - this.scale.height()) {
        this.chart.timeScale().resetTimeScale();
      }
    };
    element.addEventListener('pointerdown', down, true);
    element.addEventListener('dblclick', doubleClick);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    this.detachInteractions = () => {
      this.drag = null;
      element.removeEventListener('pointerdown', down, true);
      element.removeEventListener('dblclick', doubleClick);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }

  private appSeries(native: Series): Series {
    for (const state of this.states.values()) if (state.native === native) return state.api;
    return native;
  }

  private add(native: Series): Series {
    const primitives = new Map<any, any>();
    const state: State = { native, api: native, data: [], rendered: null, listeners: new Set(), change: null };
    const api = facade(native, {
      setData: (data: Point[]) => { state.data = data; state.change = 'full'; this.enqueue(); },
      update: (point: Point, historical = false) => {
        const i = lowerBound(state.data, timeOf(point), timeOf);
        if (!historical && i < state.data.length - 1) throw new Error('Cannot update an older candle without historicalUpdate');
        // Own array; upstream projection arrays must stay immutable.
        const data = state.data.slice();
        if (i < data.length && data[i].time === point.time) data[i] = point;
        else data.splice(i, 0, point);
        state.data = data;
        if (state.change !== 'full') state.change = 'update';
        this.enqueue();
      },
      data: () => state.data,
      dataByIndex: (index: number, direction = 0) => {
        const time = this.times[Math.round(index)];
        const i = time === undefined ? (index < 0 ? 0 : state.data.length) : lowerBound(state.data, time, timeOf);
        if (i < state.data.length && state.data[i].time === time && hasValue(state.data[i])) return state.data[i];
        if (direction === 0) return null;
        let j = direction < 0 ? i - 1 : i;
        while (j >= 0 && j < state.data.length) {
          if (hasValue(state.data[j])) return state.data[j];
          j += direction < 0 ? -1 : 1;
        }
        return null;
      },
      barsInLogicalRange: (range: Range | null) => {
        const points = state.data.filter(hasValue);
        if (!range || !points.length) return null;
        const first = this.index(points[0].time)!;
        const last = this.index(points[points.length - 1].time)!;
        const from = api.dataByIndex(Math.ceil(range.from), 1);
        const to = api.dataByIndex(Math.floor(range.to), -1);
        return { barsBefore: range.from - first, barsAfter: last - range.to,
          ...(from && to && from.time <= to.time ? { from: from.time, to: to.time } : {}),
        };
      },
      subscribeDataChanged: (cb: (scope: 'full' | 'update') => void) => state.listeners.add(cb),
      unsubscribeDataChanged: (cb: (scope: 'full' | 'update') => void) => state.listeners.delete(cb),
      attachPrimitive: (primitive: any) => {
        const wrapped = facade(primitive, {
          attached: (param: any) => primitive.attached?.({ ...param, chart: this.chart, series: api }),
        });
        primitives.set(primitive, wrapped);
        native.attachPrimitive(wrapped);
      },
      detachPrimitive: (primitive: any) => {
        native.detachPrimitive(primitives.get(primitive) ?? primitive);
        primitives.delete(primitive);
      },
    });
    state.api = api;
    this.states.set(api, state);
    return api;
  }

  private enqueue(): void {
    this.dirty = true;
    if (this.queued) return;
    this.queued = true;
    // Child-only updates and complete root commits use the same anchor policy.
    queueMicrotask(() => { this.queued = false; if (!this.removed) this.flush(); });
  }

  flush(): void {
    if (!this.dirty || this.busy || this.removed) return;
    const previousRange = this.range();
    const previousTimes = this.times;
    const previousMapping = this.mapping;
    const previousLatest = this.latestCandleTime;
    this.dirty = false;
    // Most overlays share the candle grid. Merge sorted grids instead of
    // hashing the same 35k timestamps once for every MA/volume series.
    let times: number[] = [];
    this.fallback = null;
    for (const state of this.states.values()) {
      const options = state.native.options();
      if (options.priceLineVisible || options.lastValueVisible || state.native.seriesType() === 'Custom') this.fallback = 'series-options';
      if (!state.data.length) continue;
      const grid = state.data;
      if (grid.some((row) => typeof row.time !== 'number')) this.fallback = 'non-numeric-time';
      if (!times.length) { times = grid.map(timeOf); continue; }
      const extras: number[] = [];
      let i = 0;
      for (const row of grid) {
        const time = timeOf(row);
        while (i < times.length && times[i] < time) i++;
        if (times[i] !== time) extras.push(time);
      }
      if (!extras.length) continue;
      const merged: number[] = [];
      let a = 0, b = 0;
      while (a < times.length && b < extras.length) merged.push(times[a] < extras[b] ? times[a++] : extras[b++]);
      while (a < times.length) merged.push(times[a++]);
      while (b < extras.length) merged.push(extras[b++]);
      times = merged;
    }
    this.times = times;
    this.mapping = this.nextMapping;
    const candles = [...this.states.values()].find(state => state.native.seriesType() === 'Candlestick');
    this.latestCandleTime = candles ? null : times.at(-1) ?? null;
    if (candles) {
      for (let i = candles.data.length - 1; i >= 0; i--) {
        if (hasValue(candles.data[i])) { this.latestCandleTime = timeOf(candles.data[i]); break; }
      }
    }
    const range = previousRange ? this.preserveViewport(previousRange, previousTimes, previousMapping, previousLatest) : {
      from: this.times.length - 1 - this.scale.width() / this.scale.options().barSpacing,
      to: this.times.length - 1 + this.scale.options().rightOffset,
    };
    if (this.animation) {
      this.animation.from = this.preserveViewport(this.animation.from, previousTimes, previousMapping, previousLatest);
      this.animation.target = this.preserveViewport(this.animation.target, previousTimes, previousMapping, previousLatest);
    }
    this.rebaseDrag(range);
    this.render(range, true);
    for (const state of this.states.values()) {
      const change = state.change;
      state.change = null;
      if (change) for (const cb of state.listeners) cb(change);
    }
    this.queueRangePublish();
  }

  private range(): LogicalRange | null {
    if (this.requestedRange) return this.requestedRange as LogicalRange;
    return this.appliedRange();
  }

  /** Match lwc's frame-delayed getter: callers that aim with coordinates must
   * observe the range those coordinates currently use, not a pending request.
   * Internal batching still retains that request so a prepend before the next
   * frame preserves the user's intended position. */
  private appliedRange(): LogicalRange | null {
    const local = this.scale.getVisibleLogicalRange();
    return local ? { from: (local.from + this.offset) as Logical, to: (local.to + this.offset) as Logical } : null;
  }

  setTimeMapping(mapping: WindowedChartTimeMapping): void {
    this.nextMapping = mapping;
  }

  private preserveViewport(range: Range, oldTimes: number[], oldMapping: WindowedChartTimeMapping, oldLatest: number | null): Range {
    if (!oldTimes.length || !this.times.length) return range;
    const oldLastIndex = oldLatest === null ? -1 : lowerBound(oldTimes, oldLatest, numberKey);
    const atLatest = oldLastIndex >= 0 && oldLastIndex >= range.from && oldLastIndex <= range.to;
    // Preserve the existing whitespace policy: with no candle to hold, let
    // newly loaded history fill the requested region instead of chasing it.
    if (!atLatest && !viewportHasReprojectableAnchor(range.from, range.to)) return range;
    const anchorIndex = atLatest ? oldLastIndex : Math.max(0, Math.min(oldTimes.length - 1, Math.ceil(range.to)));
    const realMs = oldMapping.toReal(oldTimes[anchorIndex]);
    const newLatest = this.latestCandleTime;
    const follow = atLatest && newLatest !== null && this.scale.options().shiftVisibleRangeOnNewBar !== false
      && this.mapping.toReal(newLatest) >= realMs;
    const anchorTime = follow ? newLatest : this.mapping.fromReal(realMs);
    const candidate = lowerBound(this.times, anchorTime!, numberKey);
    // Floating virtual/real round trips may straddle a grid point by less than
    // a microsecond. Never nearest-clamp a genuinely missing source anchor.
    const newIndex = [candidate, candidate - 1].find(i => i >= 0 && i < this.times.length
      && Math.abs(this.times[i] - anchorTime!) < .000001);
    if (newIndex === undefined) return range; // explicit source-swap/clamp owns missing anchors
    const shift = newIndex - anchorIndex;
    return { from: range.from + shift, to: range.to + shift };
  }

  private rebaseDrag(range: Range): void {
    if (!this.drag || this.gestureWrite) return;
    const delta = (this.drag.lastX - this.drag.x) / this.scale.options().barSpacing;
    this.drag.range = { from: range.from + delta, to: range.to + delta };
  }

  private index(time: Time, nearest = false): number | null {
    const i = lowerBound(this.times, time as number, numberKey);
    if (this.times[i] === time) return i;
    return nearest && this.times.length ? Math.min(i, this.times.length - 1) : null;
  }

  private visibleTimes(): { from: Time; to: Time } | null {
    const range = this.appliedRange();
    if (!range || !this.times.length) return null;
    const clamp = (i: number) => Math.max(0, Math.min(i, this.times.length - 1));
    return { from: this.times[clamp(Math.floor(range.from))] as Time, to: this.times[clamp(Math.ceil(range.to))] as Time };
  }

  private setRange(range: Range): void {
    if (!this.animationWrite) this.stopAnimation();
    this.flush();
    this.rebaseDrag(range);
    this.render(range);
    this.requestedRange = range;
    this.scale.setVisibleLogicalRange({ from: range.from - this.offset, to: range.to - this.offset });
  }

  private stopAnimation(): void {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.animation = null;
  }

  private animateRange(target: Range): void {
    this.stopAnimation();
    const from = this.range();
    if (!from) return;
    this.animation = { from, target, start: performance.now() };
    const tick = (now: number) => {
      if (this.removed) return;
      this.flush();
      const animation = this.animation;
      if (!animation) return;
      const progress = Math.min(1, (now - animation.start) / 400);
      const range = {
        from: animation.from.from + (animation.target.from - animation.from.from) * progress,
        to: animation.from.to + (animation.target.to - animation.from.to) * progress,
      };
      this.animationWrite = true;
      try {
        this.setRange(range);
        this.scale.scrollToPosition(range.to - this.end, false);
      } finally { this.animationWrite = false; }
      this.animationFrame = progress < 1 ? requestAnimationFrame(tick) : null;
      if (progress === 1) this.animation = null;
    };
    this.animationFrame = requestAnimationFrame(tick);
  }

  private render(range: Range, force = false): void {
    if (this.busy) return;
    const count = this.times.length;
    const span = Math.max(1, range.to - range.from);
    // Keep the window until the viewport enters the outer quarter of overscan.
    if (!force && range.from >= this.offset + span * .25 && range.to <= this.end - span * .25) return;
    let start = Math.max(0, Math.floor(range.from - Math.max(200, span)));
    let end = Math.min(count - 1, Math.ceil(range.to + Math.max(200, span)));
    start = Math.min(start, Math.max(0, end));
    end = Math.max(end, start - 1);
    if (count <= 4000 || this.fallback || span >= count / 2) { start = 0; end = count - 1; }
    else {
      // Preserve line interpolation/steps with original neighbours. Expanding
      // the common union window avoids fabricated boundary values and holes.
      const from = this.times[start];
      const to = this.times[end];
      for (const state of this.states.values()) {
        const type = state.native.seriesType();
        if (!['Line', 'Area', 'Baseline'].includes(type) || !state.data.length) continue;
        const lo = lowerBound(state.data, from, timeOf);
        const hi = lowerBound(state.data, to + .000001, timeOf);
        // No points inside and no line spanning the envelope: nothing to clip.
        if (lo === hi && (lo === 0 || lo === state.data.length)) continue;
        if (lo > 0) start = Math.min(start, this.index(state.data[Math.max(0, lo - 2)].time)!);
        if (hi < state.data.length) end = Math.max(end, this.index(state.data[Math.min(state.data.length - 1, hi + 1)].time)!);
      }
    }
    if (!force && start === this.offset && end === this.end) return;
    this.busy = true;
    try {
      this.native.clearCrosshairPosition();
      this.offset = start;
      this.end = end;
      for (const state of this.states.values()) {
        const data = start === 0 && end === count - 1 ? state.data : state.data.slice(
          lowerBound(state.data, this.times[start], timeOf),
          lowerBound(state.data, (this.times[end] ?? Infinity) + .000001, timeOf),
        );
        state.rendered = syncSeriesData(state.native, state.rendered, data);
      }
      if (count) {
        this.requestedRange = range;
        this.scale.setVisibleLogicalRange({ from: range.from - start, to: range.to - start });
      }
    } finally { this.busy = false; }
    this.queueRangePublish();
  }

  private queueRangePublish(): void {
    if (this.rangeFrame !== null || this.removed) return;
    // Root viewport repair runs after the batch. Let lwc apply that final
    // logical-range request before publishing, so sync never sees the
    // intermediate old index on the newly prepended time grid. Also publish
    // offset-only changes whose native local range did not change at all.
    this.rangeFrame = requestAnimationFrame(() => {
      this.rangeFrame = null;
      if (!this.removed) this.publishRange();
    });
  }

  private publishRange(): void {
    const range = this.range();
    for (const cb of this.logicalListeners) cb(range);
    const times = this.visibleTimes();
    for (const cb of this.timeListeners) cb(times);
  }

  diagnostics() {
    return { nativeChart: this.native, fullPoints: this.times.length, renderedPoints: this.end - this.offset + 1,
      offset: this.offset, fallback: this.fallback };
  }
}
