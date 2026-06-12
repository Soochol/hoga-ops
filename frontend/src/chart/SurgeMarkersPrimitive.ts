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

/**
 * 총잔량 급증 마커를 그리는 커스텀 series primitive.
 *
 * 왜 lwc 기본 `createSeriesMarkers`를 쓰지 않는가: 기본 마커 primitive는 마커 위치를
 * `series.dataByIndex(timeScale.timeToIndex(marker.time))` 로 잡는다 — 즉 **공유 timeScale의
 * logical index**를 마커가 붙은 series의 index로 되먹인다. 그런데 총잔량(quote_ratio) series는
 * 과거 quote_ratio가 캔들보다 적은 종목·구간에서 timeScale(가장 긴 series=캔들 기준)보다 *짧다*.
 * 그러면 timeToIndex가 series 길이를 넘는 index(실측: marker idx 8206 vs seriesLen 6225,
 * 사용자 케이스 4285 vs 388)를 내고, 마커가 series 끝 너머로 통째로 밀린다(좌측-팬 백필 후).
 *
 * 라인은 이 문제가 없다 — lwc가 각 라인 점을 자기 `time→coordinate`로 직접 배치하기 때문.
 * 그래서 마커도 같은 방식으로 그린다: `timeScale.timeToCoordinate(time)`(x) + series의
 * `priceToCoordinate(price)`(y). series 길이와 무관해 길이 불일치에 면역이다.
 */
export interface SurgeMarkerPoint {
  /** axis 가상시(초) — 라인 점과 동일 좌표계(`axis.toVirtual(t)/1000`). */
  time: Time;
  /** 마커가 앉을 라인 값(그 시점 총잔량). priceToCoordinate의 입력. */
  price: number;
  /** 채움색(매도/매수 토큰). */
  color: string;
}

const RADIUS_PX = 3.5;
const ABOVE_BAR_GAP_PX = 8;

class SurgeMarkersRenderer implements IPrimitivePaneRenderer {
  private readonly _source: SurgeMarkersPrimitive;
  constructor(source: SurgeMarkersPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const series = this._source.seriesApi();
    if (!chart || !series) return;
    const timeScale = chart.timeScale();
    const markers = this._source.markersData();
    if (markers.length === 0) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const r = RADIUS_PX * hr;
      const gap = ABOVE_BAR_GAP_PX * vr;
      for (const m of markers) {
        const x = timeScale.timeToCoordinate(m.time);
        const y = series.priceToCoordinate(m.price);
        if (x === null || y === null) continue;
        const cx = x * hr;
        const cy = y * vr - gap - r; // aboveBar: 라인 값 위로 살짝
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = m.color;
        ctx.fill();
      }
    });
  }
}

class SurgeMarkersPaneView implements IPrimitivePaneView {
  private readonly _renderer: SurgeMarkersRenderer;
  constructor(source: SurgeMarkersPrimitive) {
    this._renderer = new SurgeMarkersRenderer(source);
  }
  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

export class SurgeMarkersPrimitive implements ISeriesPrimitive<Time> {
  private _markers: readonly SurgeMarkerPoint[] = [];
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private readonly _paneView: SurgeMarkersPaneView;

  constructor() {
    this._paneView = new SurgeMarkersPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }
  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = undefined;
  }
  updateAllViews(): void {
    // pane view는 매 draw에서 source를 직접 읽으므로 별도 캐시 갱신이 없다.
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }

  setMarkers(markers: readonly SurgeMarkerPoint[]): void {
    this._markers = markers;
    this._requestUpdate?.();
  }
  markersData(): readonly SurgeMarkerPoint[] {
    return this._markers;
  }
  chartApi(): IChartApi | null {
    return this._chart;
  }
  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
}
