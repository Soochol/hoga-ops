import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time } from 'lightweight-charts';
import { CANVAS_FONT_STACK } from '../styles/design-tokens';
import { resolveTokensThemed } from '../util/tokens';
import { layoutExecutionMarkers, type ExecutionMarker, type PlottedExecution } from './projectors/accountExecutions';

const TOKENS = { buy: ['--price-up', '#F04452'], sell: ['--price-down', '#3485FA'], bg: ['--bg-card', '#121216'] } as const;

/** Paints in the candle's own pass, so pan, zoom, log and inverted scales share its coordinates. */
export class AccountExecutionsPrimitive implements ISeriesPrimitive<Time> {
  private attachedTo: SeriesAttachedParameter<Time> | null = null;
  private points: readonly ExecutionMarker[] = [];
  private hits: PlottedExecution[] = [];
  private readonly renderer: IPrimitivePaneRenderer = { draw: target => this.draw(target) };
  private readonly view: IPrimitivePaneView = { renderer: () => this.renderer, zOrder: () => 'top' };

  attached(param: SeriesAttachedParameter<Time>) { this.attachedTo = param; }
  detached() { this.attachedTo = null; this.hits = []; }
  paneViews() { return [this.view]; }
  updateAllViews() { /* Resolve coordinates during paint, never in a React scroll handler. */ }
  setMarkers(points: readonly ExecutionMarker[]) { this.points = points; this.hits = []; this.attachedTo?.requestUpdate(); }
  detailAt(x: number, y: number): ExecutionMarker | null {
    let nearest: PlottedExecution | undefined, distance = Infinity;
    for (const point of this.hits) {
      const d = Math.hypot(x - point.x, y - point.y);
      if (Math.abs(x - point.x) <= 12 && Math.abs(y - point.y) <= 10 && d < distance) { nearest = point; distance = d; }
    }
    return nearest?.marker ?? null;
  }
  private draw(target: CanvasRenderingTarget2D) {
    const attachment = this.attachedTo;
    if (!attachment) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const positions: PlottedExecution[] = [];
      for (const marker of this.points) {
        const x = attachment.chart.timeScale().timeToCoordinate(marker.time);
        const y = attachment.series.priceToCoordinate(marker.price);
        if (x !== null && y !== null) positions.push({ marker, x, y });
      }
      this.hits = layoutExecutionMarkers(positions, mediaSize.width, mediaSize.height);
      const tokens = resolveTokensThemed(TOKENS);
      ctx.save();
      ctx.font = `500 13px ${CANVAS_FONT_STACK}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = tokens.bg;
      for (const point of this.hits) {
        const text = point.marker.side === 'BUY' ? 'B' : 'S';
        ctx.strokeText(text, point.x, point.y);
        ctx.fillStyle = point.marker.side === 'BUY' ? tokens.buy : tokens.sell;
        ctx.fillText(text, point.x, point.y);
      }
      ctx.restore();
    });
  }
}
