import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { AutoscaleInfo, IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';
import { ICHIMOKU_LINES, ichimokuConnected, type IchimokuLine, type IchimokuProjection } from './projectors/ichimoku';

export type IchimokuStyle = Readonly<{
  lines: Readonly<Record<IchimokuLine, Readonly<{ visible: boolean; color: string }>>>;
  lineWidth: number;
  cloud: Readonly<{ visible: boolean; positiveColor: string; negativeColor: string; opacity: number }>;
}>;
export type IchimokuSnapshot = Readonly<{ model: IchimokuProjection; style: IchimokuStyle; candleOnlyScale: boolean; candleAlwaysOnTop: boolean }>;
type Point = Readonly<{ x: number; y: number }>;
type CloudPolygon = Readonly<{ positive: boolean; points: readonly Point[] }>;

export function ichimokuCloudPolygons(a0: Point, a1: Point, b0: Point, b1: Point, positive: readonly [boolean, boolean] = [b0.y > a0.y, b1.y > a1.y]): readonly CloudPolygon[] {
  const d0 = b0.y - a0.y, d1 = b1.y - a1.y;
  if (d0 === 0 && d1 === 0) return [];
  if (d0 * d1 < 0) {
    const fraction = d0 / (d0 - d1);
    const cross = { x: a0.x + (a1.x - a0.x) * fraction, y: a0.y + (a1.y - a0.y) * fraction };
    return [{ positive: positive[0], points: [a0, cross, b0] }, { positive: positive[1], points: [cross, a1, b1] }];
  }
  return [{ positive: d0 === 0 ? positive[1] : positive[0], points: [a0, a1, b1, b0] }];
}

export class IchimokuPrimitive implements ISeriesPrimitive<Time> {
  private snapshot: IchimokuSnapshot | null = null;
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate?: () => void;
  private readonly views: readonly IPrimitivePaneView[] = [this.view(true), this.view(false)];

  setSnapshot(snapshot: IchimokuSnapshot | null): void { this.snapshot = snapshot; this.requestUpdate?.(); }
  attached(param: SeriesAttachedParameter<Time>): void { this.chart = param.chart; this.series = param.series; this.requestUpdate = param.requestUpdate; }
  detached(): void { this.chart = null; this.series = null; this.requestUpdate = undefined; this.snapshot = null; }
  updateAllViews(): void {}
  paneViews(): readonly IPrimitivePaneView[] { return this.views; }

  private view(cloud: boolean): IPrimitivePaneView {
    const renderer: IPrimitivePaneRenderer = { draw: target => this.draw(target, cloud) };
    return { renderer: () => renderer, zOrder: () => cloud || this.snapshot?.candleAlwaysOnTop ? 'bottom' : 'normal' };
  }

  private displayLogical(display: number): number | null {
    const model = this.snapshot?.model, scale = this.chart?.timeScale();
    if (!model?.bars.length || !scale || display < 0) return null;
    const last = model.bars.length - 1;
    const anchor = scale.timeToIndex(model.bars[Math.min(display, last)].virtualSecond as Time, false);
    return anchor === null ? null : Number(anchor) + Math.max(0, display - last);
  }

  private sourceRange(offset: number, from: number, to: number): [number, number] {
    const length = this.snapshot!.model.bars.length;
    let lo = Math.max(0, -offset), hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1, logical = this.displayLogical(mid + offset);
      if (logical !== null && logical < from) lo = mid + 1; else hi = mid;
    }
    const start = Math.max(0, -offset, lo - 1);
    lo = start; hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1, logical = this.displayLogical(mid + offset);
      if (logical === null || logical <= to) lo = mid + 1; else hi = mid;
    }
    return [start, Math.min(length, lo + 1)];
  }

  private point(source: number, line: IchimokuLine): Point | null {
    const value = this.snapshot!.model.lines[line].values[source];
    if (value === null || value === undefined) return null;
    const logical = this.displayLogical(source + this.snapshot!.model.lines[line].offset);
    if (logical === null) return null;
    const x = this.chart!.timeScale().logicalToCoordinate(logical as Logical), y = this.series!.priceToCoordinate(value);
    return x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y) ? null : { x, y };
  }

  private draw(target: CanvasRenderingTarget2D, cloud: boolean): void {
    const snapshot = this.snapshot, range = this.chart?.timeScale().getVisibleLogicalRange();
    if (!snapshot || !range || !this.series || (cloud && (!snapshot.style.cloud.visible || snapshot.style.cloud.opacity === 0))) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      if (mediaSize.width <= 0 || mediaSize.height <= 0) return;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
      if (cloud) {
        const [start, end] = this.sourceRange(snapshot.model.lines.leadingA.offset, range.from, range.to);
        ctx.globalAlpha *= snapshot.style.cloud.opacity;
        for (let i = start + 1; i < end; i++) {
          if (!ichimokuConnected(snapshot.model, i, snapshot.model.lines.leadingA.offset)) continue;
          const a0 = this.point(i - 1, 'leadingA'), a1 = this.point(i, 'leadingA'), b0 = this.point(i - 1, 'leadingB'), b1 = this.point(i, 'leadingB');
          if (!a0 || !a1 || !b0 || !b1) continue;
          for (const polygon of ichimokuCloudPolygons(a0, a1, b0, b1, [snapshot.model.lines.leadingA.values[i - 1]! >= snapshot.model.lines.leadingB.values[i - 1]!, snapshot.model.lines.leadingA.values[i]! >= snapshot.model.lines.leadingB.values[i]!])) {
            ctx.fillStyle = polygon.positive ? snapshot.style.cloud.positiveColor : snapshot.style.cloud.negativeColor;
            ctx.beginPath(); polygon.points.forEach((p, index) => index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.fill();
          }
        }
      } else {
        ctx.lineWidth = snapshot.style.lineWidth; ctx.lineJoin = 'round';
        for (const line of ICHIMOKU_LINES) {
          if (!snapshot.style.lines[line].visible) continue;
          const offset = snapshot.model.lines[line].offset, [start, end] = this.sourceRange(offset, range.from, range.to);
          ctx.strokeStyle = snapshot.style.lines[line].color; ctx.beginPath();
          let previous: Point | null = null;
          for (let i = start; i < end; i++) {
            const point = this.point(i, line);
            if (point) {
              if (previous && ichimokuConnected(snapshot.model, i, offset)) { ctx.moveTo(previous.x, previous.y); ctx.lineTo(point.x, point.y); }
            }
            previous = point;
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    });
  }

  autoscaleInfo(from: Logical, to: Logical): AutoscaleInfo | null {
    const snapshot = this.snapshot;
    if (!snapshot || !this.chart || !this.series || snapshot.candleOnlyScale) return null;
    let min = Infinity, max = -Infinity;
    const include = (price: number) => { min = Math.min(min, price); max = Math.max(max, price); };
    const logarithmic = this.series.priceScale().options().mode === 1;
    for (const line of ICHIMOKU_LINES) {
      const outline = snapshot.style.lines[line].visible;
      const cloud = (line === 'leadingA' || line === 'leadingB') && snapshot.style.cloud.visible && snapshot.style.cloud.opacity > 0;
      if (!outline && !cloud) continue;
      const { offset, values } = snapshot.model.lines[line], [start, end] = this.sourceRange(offset, from, to);
      for (let i = Math.max(1, start); i < end; i++) {
        const value = values[i], before = values[i - 1];
        if (value == null || before == null || !ichimokuConnected(snapshot.model, i, offset)) continue;
        if (!outline && cloud && (snapshot.model.lines.leadingA.values[i - 1] == null || snapshot.model.lines.leadingA.values[i] == null
          || snapshot.model.lines.leadingB.values[i - 1] == null || snapshot.model.lines.leadingB.values[i] == null)) continue;
        const logical = this.displayLogical(i + offset), prior = this.displayLogical(i - 1 + offset);
        if (logical === null || prior === null || prior > to || logical < from || prior === logical) continue;
        if (logical === from) { include(value); continue; }
        if (prior === to) { include(before); continue; }
        if (logarithmic) { include(before); include(value); continue; }
        for (const edge of [Math.max(prior, from), Math.min(logical, to)]) {
          const fraction = (edge - prior) / (logical - prior);
          include(before + (value - before) * fraction);
        }
      }
    }
    return min === Infinity ? null : { priceRange: { minValue: min, maxValue: max } };
  }
}
