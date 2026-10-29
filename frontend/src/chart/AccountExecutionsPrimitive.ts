import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, SeriesAttachedParameter, Time } from 'lightweight-charts';
import { CANVAS_FONT_STACK } from '../styles/design-tokens';
import { resolveTokensThemed } from '../util/tokens';
import { barPitchPx } from './drawing/chartCoordinates';
import { layoutExecutionMarkers, type ExecutionMarker, type ExecutionLabel, type ExecutionTick } from './projectors/accountExecutions';

const TOKENS = { buy: ['--price-up', '#F04452'], sell: ['--price-down', '#3485FA'], bg: ['--bg-card', '#121216'] } as const;

/** Paints in the candle's own pass, so pan, zoom, log and inverted scales share its coordinates. */
export class AccountExecutionsPrimitive implements ISeriesPrimitive<Time> {
  private attachedTo: SeriesAttachedParameter<Time> | null = null;
  private points: readonly ExecutionMarker[] = [];
  private hits: (ExecutionLabel | ExecutionTick)[] = [];
  private readonly renderer: IPrimitivePaneRenderer = { draw: target => this.draw(target) };
  private readonly view: IPrimitivePaneView = { renderer: () => this.renderer, zOrder: () => 'top' };

  attached(param: SeriesAttachedParameter<Time>) { this.attachedTo = param; }
  detached() { this.attachedTo = null; this.hits = []; }
  paneViews() { return [this.view]; }
  updateAllViews() { /* Resolve coordinates during paint, never in a React scroll handler. */ }
  setMarkers(points: readonly ExecutionMarker[]) {
    const samePositions = points.length === this.points.length && points.every((point, index) => {
      const previous = this.points[index];
      return point.time === previous.time && point.price === previous.price && point.side === previous.side;
    });
    if (samePositions) {
      // An empty page can refresh details without moving any painted glyph.
      const replacements = new Map(this.points.map((point, index) => [point, points[index]]));
      this.hits = this.hits.map(hit => ({ ...hit, marker: replacements.get(hit.marker)! }));
    } else {
      this.hits = [];
    }
    this.points = points;
    this.attachedTo?.requestUpdate();
  }
  detailAt(x: number, y: number): ExecutionMarker | null {
    let nearest: ExecutionLabel | ExecutionTick | undefined, distance = Infinity;
    for (const point of this.hits) {
      const d = Math.hypot(x - point.x, y - point.y);
      if (Math.abs(x - point.candleX) <= point.halfBarWidth && Math.abs(x - point.x) <= 12
        && Math.abs(y - point.y) <= 10 && d < distance) { nearest = point; distance = d; }
    }
    return nearest?.marker ?? null;
  }
  private draw(target: CanvasRenderingTarget2D) {
    const attachment = this.attachedTo;
    if (!attachment) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const positions = [];
      for (const marker of this.points) {
        const x = attachment.chart.timeScale().timeToCoordinate(marker.time);
        const y = attachment.series.priceToCoordinate(marker.price);
        if (x !== null && y !== null) positions.push({ marker, x, y });
      }
      const pitch = barPitchPx(attachment.chart) ?? attachment.chart.timeScale().options().barSpacing;
      const layout = layoutExecutionMarkers(positions, mediaSize.width, mediaSize.height, pitch);
      this.hits = [...layout.labels, ...layout.ticks];
      const tokens = resolveTokensThemed(TOKENS);
      ctx.save();
      ctx.font = `500 13px ${CANVAS_FONT_STACK}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = tokens.bg;
      ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
      for (const point of layout.labels) {
        // Keep even the text outline inside this candle's body column at every zoom.
        ctx.save(); ctx.beginPath();
        const halfBody = pitch * .35;
        ctx.rect(point.candleX - halfBody, 0, halfBody * 2, mediaSize.height); ctx.clip();
        const text = point.marker.side === 'BUY' ? 'B' : 'S';
        ctx.strokeText(text, point.x, point.y, point.maxWidth);
        ctx.fillStyle = point.marker.side === 'BUY' ? tokens.buy : tokens.sell;
        ctx.fillText(text, point.x, point.y, point.maxWidth);
        ctx.restore();
      }
      // Paint ticks last so a grouped label can never erase an exact price position.
      ctx.lineCap = 'butt';
      for (const point of layout.ticks) {
        ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo(point.endX, point.y);
        ctx.lineWidth = 3; ctx.strokeStyle = tokens.bg; ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = point.marker.side === 'BUY' ? tokens.buy : tokens.sell; ctx.stroke();
      }
      ctx.restore();
    });
  }
}
