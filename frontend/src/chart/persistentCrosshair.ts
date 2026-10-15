import type { IChartApi, MouseEventParams, Time } from 'lightweight-charts';

type Series = Parameters<IChartApi['setCrosshairPosition']>[2];
type Hover = { kind: 'pointer'; clientX: number; clientY: number }
  | { kind: 'synthetic'; price: number; time: Time; series: Series };
type ClearableChart = Partial<Pick<IChartApi, 'clearCrosshairPosition'>>;
const controllers = new WeakMap<ClearableChart, PersistentCrosshair>();

/** Keep the native stale-index guard, but restore hover once the new grid and
 * viewport have drawn. Shared by full-history and windowed chart renderers.
 * No React state or time-based snapping: pointer hover also works in whitespace.
 */
export function createPersistentCrosshairChart(native: IChartApi): IChartApi {
  const existing = controllers.get(native);
  if (existing) return existing.chart;
  // Component test doubles can expose only the part of the chart they use.
  if (typeof native.subscribeCrosshairMove !== 'function'
    || typeof native.clearCrosshairPosition !== 'function'
    || typeof native.setCrosshairPosition !== 'function') return native;
  const controller = new PersistentCrosshair(native);
  controllers.set(native, controller);
  controllers.set(controller.chart, controller);
  return controller.chart;
}

export function preserveCrosshairDuringDataChange(chart: ClearableChart, change: () => void): void {
  const controller = controllers.get(chart);
  if (controller) controller.replaceData(change);
  else {
    chart.clearCrosshairPosition?.();
    change();
  }
}

class PersistentCrosshair {
  readonly chart: IChartApi;
  private readonly native: IChartApi;
  private hover: Hover | null = null;
  private updating = false;
  private restoreFrame: number | null = null;
  private paintedHover: HTMLDivElement | null = null;
  private paintedHoverFrame: number | null = null;
  private element: HTMLElement | null = null;
  private removed = false;

  private readonly trackHover = (param: MouseEventParams): void => {
    if (this.updating) return;
    if (param.point && param.sourceEvent) {
      if (this.hover?.kind !== 'pointer'
        || this.hover.clientX !== param.sourceEvent.clientX || this.hover.clientY !== param.sourceEvent.clientY) {
        this.releasePaintedHover();
      }
      this.hover = { kind: 'pointer', clientX: param.sourceEvent.clientX, clientY: param.sourceEvent.clientY };
    } else if (!param.point && this.restoreFrame === null) {
      this.clear();
    }
    // A native draw can publish an empty hover between the reset and restore.
    // It is not a physical leave; the DOM listener below handles that even
    // while a restore is pending.
  };

  private readonly leave = (event: MouseEvent): void => {
    if (event.relatedTarget instanceof Node && this.element?.contains(event.relatedTarget)) return;
    if (this.hover?.kind === 'pointer') this.clear();
  };

  constructor(native: IChartApi) {
    this.native = native;
    const overrides: Partial<IChartApi> = {
      clearCrosshairPosition: () => { this.clear(); native.clearCrosshairPosition(); },
      setCrosshairPosition: (price, time, series) => {
        this.releasePaintedHover();
        native.setCrosshairPosition(price, time, series);
        this.hover = { kind: 'synthetic', price, time, series };
      },
      removeSeries: series => {
        if (this.hover?.kind === 'synthetic' && this.hover.series === series) this.clear();
        native.removeSeries(series);
      },
      remove: () => {
        this.removed = true;
        this.clear();
        this.element?.removeEventListener('mouseleave', this.leave);
        native.unsubscribeCrosshairMove(this.trackHover);
        controllers.delete(this.chart);
        controllers.delete(native);
        native.remove();
      },
    };
    const methods = new Map<PropertyKey, unknown>();
    this.chart = new Proxy(native, {
      get(target, key) {
        if (key in overrides) return Reflect.get(overrides, key);
        if (methods.has(key)) return methods.get(key);
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        const bound = value.bind(target);
        methods.set(key, bound);
        return bound;
      },
    });
    native.subscribeCrosshairMove(this.trackHover);
    this.attachLeaveListener();
  }

  private clear(): void {
    this.hover = null;
    if (this.restoreFrame !== null) cancelAnimationFrame(this.restoreFrame);
    this.restoreFrame = null;
    this.releasePaintedHover();
  }

  /** The native guard clears the hover canvas for one draw before replay can
   * safely hit-test the new series. Keep only its transparent top layers until
   * replay has painted; never copy the candle/history canvases. This also
   * preserves axis labels without duplicating lwc's formatting or geometry.
   */
  private retainPaintedHover(): void {
    if (this.paintedHoverFrame !== null) cancelAnimationFrame(this.paintedHoverFrame);
    this.paintedHoverFrame = null;
    const element = this.element;
    if (!this.hover || !element || this.paintedHover) return;
    const canvases = [...element.querySelectorAll('canvas')].filter(canvas => canvas.style.zIndex === '2');
    if (!canvases.length) return;
    const rect = element.getBoundingClientRect();
    const overlay = element.ownerDocument.createElement('div');
    overlay.dataset.persistentCrosshair = '';
    overlay.setAttribute('aria-hidden', 'true');
    // Fractional DPR pane rounding can put the copied time-axis canvas just
    // below the chart. The native widget clips its own canvases, but this
    // absolute layer can have the outer chart surface as its containing block.
    // Clip the snapshot itself so it cannot create a temporary scrollbar.
    Object.assign(overlay.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none', zIndex: '3' });
    for (const canvas of canvases) {
      const box = canvas.getBoundingClientRect();
      if (!canvas.width || !canvas.height || !box.width || !box.height) continue;
      const copy = element.ownerDocument.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d');
      if (!context) continue;
      context.drawImage(canvas, 0, 0);
      Object.assign(copy.style, { position: 'absolute', left: `${box.left - rect.left}px`,
        top: `${box.top - rect.top}px`, width: `${box.width}px`, height: `${box.height}px`, zIndex: '2' });
      overlay.append(copy);
    }
    if (overlay.childElementCount) {
      element.append(overlay);
      this.paintedHover = overlay;
    }
  }

  private releasePaintedHover(): void {
    if (this.paintedHoverFrame !== null) cancelAnimationFrame(this.paintedHoverFrame);
    this.paintedHoverFrame = null;
    this.paintedHover?.remove();
    this.paintedHover = null;
  }

  private attachLeaveListener(): void {
    if (this.element || typeof this.native.chartElement !== 'function') return;
    this.element = this.native.chartElement();
    this.element?.addEventListener('mouseleave', this.leave);
  }

  replaceData(change: () => void): void {
    if (this.updating) { change(); return; }
    this.attachLeaveListener();
    // A later batch may have requested another native draw. Its restoration
    // must follow that draw, rather than the earlier batch's frame callback.
    if (this.restoreFrame !== null) cancelAnimationFrame(this.restoreFrame);
    this.restoreFrame = null;
    this.updating = true;
    try {
      this.retainPaintedHover();
      this.native.clearCrosshairPosition();
      change();
    } finally {
      if (this.restoreFrame === null && this.hover && !this.removed) {
        this.restoreFrame = requestAnimationFrame(() => {
          this.restoreFrame = null;
          if (this.restore() && this.paintedHover) {
            // Replay has requested its native paint first. Drop the saved
            // layers after that paint, never in the intermediate blank frame.
            this.paintedHoverFrame = requestAnimationFrame(() => this.releasePaintedHover());
          } else this.releasePaintedHover();
        });
      }
      this.updating = false;
    }
  }

  private restore(): boolean {
    const hover = this.hover;
    if (this.removed || !hover) return false;
    if (hover.kind === 'synthetic') {
      if (hover.series.priceToCoordinate(hover.price) !== null
        && this.native.timeScale().timeToIndex(hover.time) !== null) {
        this.native.setCrosshairPosition(hover.price, hover.time, hover.series);
        return true;
      }
      return false;
    }
    const element = this.element;
    if (!element || typeof element.ownerDocument.elementsFromPoint !== 'function') return false;
    const target = element.ownerDocument.elementsFromPoint(hover.clientX, hover.clientY)
      .find(node => element.contains(node));
    if (!target) return false;
    // Enter reinstalls lwc's mousemove listener after a drawing overlay took
    // the pointer. Forward movement only; never synthesize a drag or wheel.
    for (const type of ['mouseenter', 'mousemove']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true,
        clientX: hover.clientX, clientY: hover.clientY }));
    }
    return true;
  }
}
