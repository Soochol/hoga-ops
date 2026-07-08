import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

export type DepthHeatmapCell = {
  time: Time;
  price: number;
  halfTick: number; // 셀 y 반높이(가격 단위)
  fillColor: string;
};

export type DepthHeatmapPrimitiveOptions = {
  zOrder?: PrimitivePaneViewZOrder;
};

class DepthHeatmapRenderer implements IPrimitivePaneRenderer {
  private readonly source: DepthHeatmapPrimitive;

  constructor(source: DepthHeatmapPrimitive) {
    this.source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this.source.chartApi();
    const series = this.source.seriesApi();
    const cells = this.source.cellsData();
    if (!chart || !series || cells.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const timeScale = chart.timeScale();
      const barSpacing = timeScale.options().barSpacing;
      const halfW = Math.max(1, (barSpacing * 0.9) / 2);
      for (const cell of cells) {
        const x = timeScale.timeToCoordinate(cell.time);
        const yMid = series.priceToCoordinate(cell.price);
        const yEdge = series.priceToCoordinate(cell.price + cell.halfTick);
        if (x === null || yMid === null || yEdge === null) continue;
        const cellHalfH = Math.abs(yMid - yEdge);
        const left = (x - halfW) * hr;
        const width = Math.max(1, halfW * 2 * hr);
        const top = (yMid - cellHalfH) * vr;
        const height = Math.max(1, cellHalfH * 2 * vr);
        ctx.fillStyle = cell.fillColor;
        ctx.fillRect(left, top, width, height);
      }
    });
  }
}

class DepthHeatmapPaneView implements IPrimitivePaneView {
  private readonly source: DepthHeatmapPrimitive;
  private readonly rendererRef: DepthHeatmapRenderer;

  constructor(source: DepthHeatmapPrimitive) {
    this.source = source;
    this.rendererRef = new DepthHeatmapRenderer(source);
  }

  renderer(): IPrimitivePaneRenderer {
    return this.rendererRef;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this.source.zOrder();
  }
}

export class DepthHeatmapPrimitive implements ISeriesPrimitive<Time> {
  private cells: readonly DepthHeatmapCell[] = [];
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate?: () => void;
  private readonly paneView: DepthHeatmapPaneView;
  private readonly paneZOrder: PrimitivePaneViewZOrder;

  constructor(options: DepthHeatmapPrimitiveOptions = {}) {
    this.paneZOrder = options.zOrder ?? 'bottom';
    this.paneView = new DepthHeatmapPaneView(this);
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

  setCells(cells: readonly DepthHeatmapCell[]): void {
    this.cells = cells;
    this.requestUpdate?.();
  }

  cellsData(): readonly DepthHeatmapCell[] {
    return this.cells;
  }

  chartApi(): IChartApi | null {
    return this.chart;
  }

  seriesApi(): ISeriesApi<SeriesType> | null {
    return this.series;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this.paneZOrder;
  }
}
