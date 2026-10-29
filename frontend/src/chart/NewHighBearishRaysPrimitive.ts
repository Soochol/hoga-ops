import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { realMsToCanvasX } from './drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';

export type BearishOpenRay = { time: number; endTime: number; price: number; futureEndMs?: number };

/** A single primitive holds all rays; it never creates future bars or changes the viewport. */
export class NewHighBearishRaysPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate?: () => void;
  private rays: readonly BearishOpenRay[] = [];
  private future?: { axis: VirtualAxis; lastRealMs: number };
  private color = '#F04452';
  private width = 1;
  private readonly view: IPrimitivePaneView = {
    zOrder: () => 'normal',
    renderer: (): IPrimitivePaneRenderer => ({ draw: target => this.draw(target) }),
  };
  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>): void {
    this.chart = chart; this.series = series; this.requestUpdate = requestUpdate;
  }
  detached(): void { this.chart = null; this.series = null; this.requestUpdate = undefined; }
  paneViews(): readonly IPrimitivePaneView[] { return [this.view]; }
  setData(rays: readonly BearishOpenRay[], color: string, width: number, future?: { axis: VirtualAxis; lastRealMs: number }): void {
    this.future = future;
    this.rays = rays; this.color = color; this.width = width; this.requestUpdate?.();
  }
  private draw(target: CanvasRenderingTarget2D): void {
    const chart = this.chart, series = this.series;
    if (!chart || !series) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hx, verticalPixelRatio: vy }) => {
      ctx.save();
      ctx.strokeStyle = this.color;
      ctx.lineWidth = Math.max(1, Math.round(this.width * vy));
      for (const ray of this.rays) {
        const x = chart.timeScale().timeToCoordinate(ray.time as Time);
        const y = series.priceToCoordinate(ray.price);
        const endX = ray.futureEndMs !== undefined && this.future
          ? realMsToCanvasX(chart, this.future.axis, ray.futureEndMs, { lastRealMs: this.future.lastRealMs, bucketMs: 86400_000 })
          : chart.timeScale().timeToCoordinate(ray.endTime as Time);
        if (x === null || endX === null || y === null || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(endX)
          || x * hx >= bitmapSize.width || y < 0 || y * vy > bitmapSize.height) continue;
        const left = Math.max(0, x * hx);
        const right = Math.min(bitmapSize.width, (endX + chart.timeScale().options().barSpacing / 2) * hx);
        if (right <= left) continue;
        const crispY = Math.round(y * vy) + (ctx.lineWidth % 2 ? 0.5 : 0);
        ctx.beginPath();
        ctx.moveTo(left, crispY);
        ctx.lineTo(right, crispY);
        ctx.stroke();
      }
      ctx.restore();
    });
  }
}
