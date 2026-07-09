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
      // 단일 draw 안에서 뷰포트는 고정 → time→x, price→y 는 순수 함수. 프레임 로컬
      // 캐시로 중복 좌표 변환을 제거한다: 한 시각(컬럼)의 최대 20셀이 timeToCoordinate
      // 를 20번 호출하던 것을 1번으로, 10개 안팎의 호가 가격 레벨이 모든 컬럼에서
      // 재등장하므로 priceToCoordinate 도 레벨 수만큼으로 줄인다. 색·기하는 불변.
      const xByTime = new Map<Time, number | null>();
      const yByPrice = new Map<number, number | null>();
      const coordX = (t: Time): number | null => {
        const cached = xByTime.get(t);
        if (cached !== undefined) return cached;
        const x = timeScale.timeToCoordinate(t);
        xByTime.set(t, x);
        return x;
      };
      const coordY = (price: number): number | null => {
        const cached = yByPrice.get(price);
        if (cached !== undefined) return cached;
        const y = series.priceToCoordinate(price);
        yByPrice.set(price, y);
        return y;
      };
      for (const cell of cells) {
        const x = coordX(cell.time);
        const yMid = coordY(cell.price);
        const yEdge = coordY(cell.price + cell.halfTick);
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
