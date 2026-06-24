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

export type TradeVolumePocSegment = {
  time0: Time;
  time1: Time;
  peakTime: Time;
  lowPrice: number;
  highPrice: number;
  centerPrice: number;
  qty: number;
  label: string;
  color: string;
  fillColor: string;
  lineWidth: number;
};

const LABEL_FONT_PX = 11;
const LABEL_PAD_X_PX = 4;
const LABEL_PAD_Y_PX = 1;
const DOT_RADIUS_PX = 3.5;

class TradeVolumePocRenderer implements IPrimitivePaneRenderer {
  private readonly source: TradeVolumePocPrimitive;

  constructor(source: TradeVolumePocPrimitive) {
    this.source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this.source.chartApi();
    const series = this.source.seriesApi();
    const segments = this.source.segmentsData();
    if (!chart || !series || segments.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const timeScale = chart.timeScale();
      for (const segment of segments) {
        const x0 = timeScale.timeToCoordinate(segment.time0);
        const x1 = timeScale.timeToCoordinate(segment.time1);
        const yLow = series.priceToCoordinate(segment.lowPrice);
        const yHigh = series.priceToCoordinate(segment.highPrice);
        const yCenter = series.priceToCoordinate(segment.centerPrice);
        if (x0 === null || x1 === null || yLow === null || yHigh === null || yCenter === null) continue;

      const left = Math.min(x0, x1) * hr;
      const right = Math.max(x0, x1) * hr;
      const top = Math.min(yLow, yHigh) * vr;
      const bottom = Math.max(yLow, yHigh) * vr;
      const centerY = yCenter * vr;

      ctx.fillStyle = segment.fillColor;
      ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));

      ctx.beginPath();
      ctx.strokeStyle = segment.color;
      ctx.lineWidth = Math.max(1, segment.lineWidth) * vr;
      ctx.moveTo(left, centerY);
      ctx.lineTo(right, centerY);
      ctx.stroke();

      const rawPeakX = timeScale.timeToCoordinate(segment.peakTime);
      let peakX: number;
      if (rawPeakX === null) {
        const t0 = segment.time0 as unknown as number;
        const t1 = segment.time1 as unknown as number;
        const tp = segment.peakTime as unknown as number;
        const frac = t1 > t0 ? Math.min(1, Math.max(0, (tp - t0) / (t1 - t0))) : 0;
        peakX = (x0 as number) + frac * ((x1 as number) - (x0 as number));
      } else {
        peakX = rawPeakX as number;
      }
      ctx.beginPath();
      ctx.arc(peakX * hr, centerY, DOT_RADIUS_PX * hr, 0, Math.PI * 2);
      ctx.fillStyle = segment.color;
      ctx.fill();

      if (!segment.label) continue;
      ctx.font = `${LABEL_FONT_PX * vr}px sans-serif`;
      const textWidth = ctx.measureText(segment.label).width;
      const padX = LABEL_PAD_X_PX * hr;
      const padY = LABEL_PAD_Y_PX * vr;
      const textRight = Math.max(left + textWidth + padX, right - padX);
      const baseline = Math.max((LABEL_FONT_PX + 4) * vr, top - 4 * vr);
      ctx.fillStyle = 'rgba(11, 15, 26, 0.72)';
      ctx.fillRect(
        textRight - textWidth - padX,
        baseline - LABEL_FONT_PX * vr - padY,
        textWidth + padX * 2,
        LABEL_FONT_PX * vr + padY * 2,
      );
      ctx.fillStyle = segment.color;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(segment.label, textRight, baseline);
      }
    });
  }
}

class TradeVolumePocPaneView implements IPrimitivePaneView {
  private readonly rendererRef: TradeVolumePocRenderer;

  constructor(source: TradeVolumePocPrimitive) {
    this.rendererRef = new TradeVolumePocRenderer(source);
  }

  renderer(): IPrimitivePaneRenderer {
    return this.rendererRef;
  }
}

export class TradeVolumePocPrimitive implements ISeriesPrimitive<Time> {
  private segments: readonly TradeVolumePocSegment[] = [];
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate?: () => void;
  private readonly paneView: TradeVolumePocPaneView;

  constructor() {
    this.paneView = new TradeVolumePocPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = undefined;
  }

  updateAllViews(): void {
    // Renderer reads source data directly.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.paneView];
  }

  setSegments(segments: readonly TradeVolumePocSegment[]): void {
    this.segments = segments;
    this.requestUpdate?.();
  }

  segmentsData(): readonly TradeVolumePocSegment[] {
    return this.segments;
  }

  chartApi(): IChartApi | null {
    return this.chart;
  }

  seriesApi(): ISeriesApi<SeriesType> | null {
    return this.series;
  }
}
