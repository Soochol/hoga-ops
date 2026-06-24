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
  lowPrice: number;
  highPrice: number;
  fillColor: string;
};

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
        if (x0 === null || x1 === null || yLow === null || yHigh === null) continue;

        const left = Math.min(x0, x1) * hr;
        const right = Math.max(x0, x1) * hr;
        const top = Math.min(yLow, yHigh) * vr;
        const bottom = Math.max(yLow, yHigh) * vr;

        ctx.fillStyle = segment.fillColor;
        ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
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
